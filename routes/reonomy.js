// Reonomy workflows R1 (property list) and R2 (owner skip-trace).
// Selectors locked against real DOM inspection 2026-07-07:
//   - Login: Auth0 forms with name="email"/"password"
//   - Search: MUI checkboxes, targeted by <label> text (class names are jss-hashed and unstable)
//   - Property Type tab → sub-tab (Industrial/Multifamily/etc) → sub-checkboxes
//   - Building & Lot tab → Building Area min input
//   - Owner tab → "Person" / "Company" toggle buttons + "Includes Phone Number" button

const { newPage, saveState, humanDelay } = require('../lib/browser');
const { tagDupes } = require('../lib/dedupe');
const { tryConsume } = require('../lib/rateLimit');

const REONOMY_BASE = 'https://app.reonomy.com';

// Which Reonomy sub-tab a given family maps to.
const SUBTAB_FOR = {
  'Warehouse': 'Industrial',
  'Industrial Park': 'Industrial',
  'Industrial Plant': 'Industrial',
  'General Industrial': 'Industrial',
  'Light Industrial': 'Industrial',
  'Heavy Industrial': 'Industrial',
  'Industrial Condominium': 'Industrial',
  // Apex multifamily subtypes will be added when we validate the Multifamily sub-tab
};

// ---------- Login (Auth0) ----------
async function ensureLogin(page) {
  await page.goto(`${REONOMY_BASE}/!/home`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await humanDelay(2500, 4000);

  // Broad signed-in detection: search input, nav sidebar, or any auth-only element.
  const signedInMarkers = [
    'input[placeholder*="Search by address"]',
    'input[placeholder*="Address"]',
    '[data-testid="AdvancedSearch"]',
    'button:has-text("Advanced Search")',
    '[data-testid="sidebar"]',
    'nav a:has-text("Search")',
  ];
  for (const sel of signedInMarkers) {
    if (await page.$(sel).catch(() => null)) return true;
  }
  // If URL never left app.reonomy.com, the SPA is up; treat as signed-in.
  if (page.url().includes('app.reonomy.com')) {
    // Wait a beat for SPA to settle, then confirm we aren't on a login CTA
    await humanDelay(1500, 2500);
    const loginCta = await page.$('a:has-text("Sign in"), a:has-text("Log in"), button:has-text("Sign in")').catch(() => null);
    if (!loginCta) return true;
  }

  const email = process.env.REONOMY_EMAIL;
  const password = process.env.REONOMY_PASSWORD;
  if (!email || !password) throw new Error('REONOMY_EMAIL/PASSWORD not set - cannot log in');

  // Wait for Auth0 form. Try more selectors + longer timeout.
  await page.waitForSelector('input[name="email"], input[name="username"], input[type="email"], input[id*="email" i]', { timeout: 30000 });
  await page.fill('input[name="email"], input[name="username"], input[type="email"], input[id*="email" i]', email);
  await humanDelay(400, 900);
  // Auth0 sometimes needs a Continue click before password shows.
  const cont = page.locator('button:has-text("Continue"), button:has-text("Next")').first();
  if (await cont.isVisible().catch(() => false)) {
    await cont.click();
    await humanDelay(600, 1200);
  }
  await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 15000 });
  await page.fill('input[name="password"], input[type="password"]', password);
  await humanDelay(400, 900);
  await page.click('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');
  await page.waitForURL(/app\.reonomy\.com/, { timeout: 60000 });
  await humanDelay(1500, 2500);
  await saveState('reonomy');
  return true;
}

// Helper: click a MUI checkbox by its label text (exact match)
async function checkboxByLabel(page, text) {
  const label = page.locator(`label.MuiFormControlLabel-root:has-text("${text}")`).first();
  await label.waitFor({ state: 'visible', timeout: 10000 });
  await label.click();
  await humanDelay(200, 500);
}

// Click a MUI tab. Top-level ("Property Type", "Building & Lot", "Owner", ...) and
// sub-tabs ("Commercial", "Industrial", ...) all have role="tab" in Reonomy's DOM.
async function clickTab(page, text) {
  const tab = page.getByRole('tab', { name: text, exact: true }).first();
  await tab.waitFor({ state: 'visible', timeout: 10000 });
  await tab.click();
  await humanDelay(600, 1200);
}

// ---------- Workflow R1 ----------
// POST /reonomy/property-list
// body: {
//   property_types: ["Warehouse"],          // Reonomy checkbox labels
//   min_size_sf: 15000,                     // fills "Building Area" min
//   owner_type: "Person"|"Company"|null,    // Owner tab toggle
//   require_phone: true,                    // "Includes Phone Number" filter
//   dedupe_against: [{ phone, address, entity }],
// }
async function propertyList(req, res) {
  const gate = tryConsume('reonomy');
  if (!gate.ok) return res.status(429).json({ error: 'rate_limited', ...gate });
  const b = req.body || {};

  const queue = require('./queue');
  const jobId = queue._enqueueDirect({
    vendor: 'reonomy',
    params: {
      limit: b.result_limit || 20,
      property_types: b.property_types || ['warehouse'],
      min_size_sf: b.min_size_sf,
    },
  });

  const timeoutMs = 90000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entry = queue._getJob(jobId);
    if (entry && entry.status === 'done') {
      const raw = entry.result;
      if (!raw) return res.status(502).json({ error: 'reonomy_no_data' });
      if (raw.status && raw.status !== 200) return res.status(502).json({ error: 'reonomy_extension_error', status: raw.status, body: (raw.body || '').slice(0, 800) });
      let parsed;
      try { parsed = typeof raw.body === 'string' ? JSON.parse(raw.body) : raw.body; }
      catch { return res.status(502).json({ error: 'reonomy_parse_error', body: (raw.body || '').slice(0, 400) }); }
      return res.json({
        workflow: 'R1',
        module: 'reonomy (extension bridge)',
        count: (parsed.items || []).length,
        raw: parsed,
      });
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return res.status(504).json({ error: 'reonomy_extension_timeout' });
}


// ---------- Workflow R2 ----------
// POST /reonomy/owner-detail
// Uses the top search bar's "Owner" autocomplete.
async function ownerDetail(req, res) {
  const gate = tryConsume('reonomy');
  if (!gate.ok) return res.status(429).json({ error: 'rate_limited', ...gate });

  const { owner_name, property_address } = req.body || {};
  if (!owner_name) return res.status(400).json({ error: 'owner_name required' });

  const page = await newPage('reonomy');
  try {
    await ensureLogin(page);
    await page.goto(`${REONOMY_BASE}/!/search`, { waitUntil: 'domcontentloaded' });
    await humanDelay(1500, 2500);

    await page.locator('input[placeholder*="Address"]').first().fill(owner_name);
    await humanDelay(800, 1400);

    // Autocomplete row
    const ownerHit = page.locator(`[role="option"]:has-text("${owner_name}")`).first();
    const hit = await ownerHit.count();
    if (!hit) {
      return res.json({ workflow: 'R2', status: 'NOT_FOUND', owner_name });
    }
    await ownerHit.click();
    await page.waitForLoadState('domcontentloaded');
    await humanDelay(1500, 2500);

    const detail = await page.evaluate(() => {
      const t = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
      return {
        phone:           t('a[href^="tel:"]'),
        email:           t('a[href^="mailto:"]'),
        mailing_address: t('[data-testid*="mailing"], [class*="MailingAddress"]'),
        entity_type:     t('[data-testid*="entity"], [class*="EntityType"]'),
      };
    });

    let status = 'NOT_FOUND';
    if (detail.phone || detail.email) status = 'FOUND';
    else if (detail.mailing_address)  status = 'MAIL_ONLY';
    else                              status = 'SOS_NEEDED';

    await saveState('reonomy');
    res.json({ workflow: 'R2', status, owner_name, property_address, ...detail });
  } catch (err) {
    console.error('R2 error:', err);
    res.status(500).json({ error: 'reonomy_r2_failed', message: err.message });
  } finally {
    await page.close().catch(() => {});
  }
}


// ---------- Workflow R1-fast — Load saved-search URL, intercept API responses ----------
// POST /reonomy/saved-search
// body: { search_uuid: "99a5345f-...", limit: 25 }
// Bypasses all filter UI clicking. Requires user to have set up filters in a
// saved search once. All subsequent runs use that URL.
async function savedSearch(req, res) {
  const gate = tryConsume('reonomy');
  if (!gate.ok) return res.status(429).json({ error: 'rate_limited', ...gate });
  const b = req.body || {};
  const limit = Number(b.limit) || 25;

  try {
    const key = process.env.SCRAPINGBEE_API_KEY;
    if (!key) return res.status(500).json({ error: 'SCRAPINGBEE_API_KEY not set' });
    const path = require('path');
    const fs = require('fs');
    const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
    let extra = {};
    try {
      const hf = path.join(SESSIONS_DIR, 'reonomy.headers.json');
      if (fs.existsSync(hf)) extra = JSON.parse(fs.readFileSync(hf, 'utf8'));
    } catch {}
    const jwt = extra['Authorization'] || '';

    // Reonomy REST API - no Akamai, straightforward with JWT
    const searchBody = b.body || {
      filters: {
        property_types: b.property_types || ['warehouse'],
        building_area: b.min_size_sf ? { gte: Number(b.min_size_sf) } : { gte: 15000 },
      },
      pagination: { page: 1, size: limit },
    };
    const params = new URLSearchParams({
      api_key: key,
      url: 'https://api.reonomy.com/v2/properties/search',
      premium_proxy: 'true',
      country_code: 'us',
      render_js: 'false',
      forward_headers: 'true',
      forward_headers_pure: 'true',
    });
    const headers = {
      'Content-Type': 'application/json',
      'Spb-Content-Type': 'application/json',
      'Spb-Accept': 'application/json',
      'Spb-Origin': 'https://app.reonomy.com',
      'Spb-Referer': 'https://app.reonomy.com/',
    };
    if (jwt) headers['Spb-Authorization'] = jwt;

    const https = require('https');
    const r = await new Promise((resolve, reject) => {
      const req = https.request('https://app.scrapingbee.com/api/v1/?' + params.toString(),
        { method: 'POST', headers, timeout: 90000 },
        (resp) => {
          let text = '';
          resp.on('data', (c) => text += c);
          resp.on('end', () => resolve({ status: resp.statusCode, text }));
        });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.write(JSON.stringify(searchBody));
      req.end();
    });

    if (r.status !== 200) {
      return res.status(502).json({ error: 'reonomy_scrapingbee_error', status: r.status, body: (r.text || '').slice(0, 800) });
    }
    let parsed;
    try { parsed = JSON.parse(r.text); } catch { return res.status(502).json({ error: 'reonomy_parse_error', body: r.text.slice(0, 400) }); }
    return res.json({
      workflow: 'R1-fast',
      module: 'reonomy REST API via ScrapingBee',
      raw_top_keys: Object.keys(parsed || {}),
      count: (parsed.properties || parsed.results || parsed.data || []).length,
      preview: JSON.stringify(parsed).slice(0, 4000),
    });
  } catch (err) {
    console.error('R1-fast error:', err);
    return res.status(500).json({ error: 'reonomy_saved_search_failed', message: err.message });
  }
}


module.exports = { propertyList, ownerDetail, savedSearch, ensureLogin };
