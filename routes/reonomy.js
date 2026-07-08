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

  const body = req.body || {};
  const propertyTypes = Array.isArray(body.property_types) && body.property_types.length
    ? body.property_types
    : ['Warehouse'];
  const minSize = Number(body.min_size_sf) || 15000;
  const ownerType = body.owner_type === 'Company' ? 'Company'
                 : body.owner_type === 'Person'  ? 'Person'
                 : null;
  const requirePhone = body.require_phone === true; // default OFF while UI tuning

  const page = await newPage('reonomy');
  try {
    await ensureLogin(page);

    // 1. Go to search — Reonomy SPA lives under hash routing. Try the direct search URL,
    // then fall back to clicking "Advanced Search" from the home page if the SPA landed there.
    await page.goto(`${REONOMY_BASE}/!/search`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await humanDelay(2500, 4000);

    // If we landed on /!/home instead of /!/search (SPA sometimes redirects), click Advanced Search.
    const advSearch = page.locator('text=/Advanced Search/i').first();
    if (await advSearch.isVisible().catch(() => false)) {
      await advSearch.click();
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await humanDelay(1500, 2500);
    }

    // 2. Open the More Filters modal — wait patiently, the button renders after the SPA hydrates.
    const moreFilters = page.locator('[data-testid="more-filters-button"], button:has-text("More Filters")').first();
    await moreFilters.waitFor({ state: 'visible', timeout: 45000 });
    await moreFilters.click();
    await humanDelay(700, 1200);

    // 3. Property Type tab is already active. Navigate to the correct sub-tab
    // (Industrial for warehouse/plants, Multifamily for units, etc.)
    const subtabs = new Set(propertyTypes.map((t) => SUBTAB_FOR[t] || 'Industrial'));
    for (const subtab of subtabs) {
      await clickTab(page, subtab);
      for (const t of propertyTypes.filter((x) => (SUBTAB_FOR[x] || 'Industrial') === subtab)) {
        await checkboxByLabel(page, t);
      }
    }

    // 4. Building & Lot tab → Building Area min
    if (minSize) {
      await clickTab(page, 'Building & Lot');
      // The "Building Area" section has min/max inputs; find the min under that heading.
      // Reonomy renders labels above the input pair, so pick the input that lives inside
      // the section following a heading with text "Building Area".
      const buildingAreaMin = page.locator(
        'text="Building Area" >> xpath=following::input[@placeholder="min"][1]'
      );
      await buildingAreaMin.waitFor({ state: 'visible', timeout: 10000 });
      await buildingAreaMin.fill(String(minSize));
      await humanDelay(300, 700);
    }

    // 5. Owner tab → Owner Type + Contact Info. Owner-type toggle buttons live inside
    // the Owner tab panel; scope the button lookup so it doesn't clash with other tabs.
    if (ownerType || requirePhone) {
      await clickTab(page, 'Owner');
      await humanDelay(600, 1000);
      const ownerPanel = page.locator('[role="tabpanel"]').filter({ hasText: 'Owner Type' }).first();
      if (ownerType) {
        await ownerPanel.locator('button', { hasText: new RegExp(`^${ownerType}$`) })
          .first().click({ timeout: 8000 }).catch(() => {});
        await humanDelay(200, 500);
      }
      if (requirePhone) {
        await ownerPanel.locator('button', { hasText: /phone/i })
          .first().click({ timeout: 8000 }).catch(() => {});
        await humanDelay(200, 500);
      }
    }

    // 6. Apply filters
    await page.locator('button:has-text("Apply")').first().click();
    await humanDelay(1500, 2500);

    // 7. Read the result count from the top-right ("N properties")
    const countText = await page.locator('text=/^[\\d,]+\\s+properties$/').first().textContent().catch(() => '');
    const totalCount = Number((countText || '').replace(/[^\d]/g, '')) || null;

    // 8. Extract results. Reonomy renders each property as an MUI Card. innerText is
    // stable and structured: line 1 = full address, line 2 = "X.Xk SF <PropType>",
    // line 3 = sale info, line 4 = "Built in YYYY", then "Owner", then owner name,
    // then "N Contacts Available".
    let rows = [];
    try {
      await page.locator('.MuiPaper-root.MuiCard-root').first()
        .waitFor({ state: 'visible', timeout: 15000 });
      rows = await page.$$eval('.MuiPaper-root.MuiCard-root', (cards) => {
        // Filesystem-size helper: parse "1.02k", "12.5m", "600" etc into SF
        function parseSize(s) {
          if (!s) return null;
          const m = s.match(/([\d,.]+)\s*([kmKM]?)/);
          if (!m) return null;
          let n = parseFloat(m[1].replace(/,/g, ''));
          const suf = (m[2] || '').toLowerCase();
          if (suf === 'k') n *= 1000;
          if (suf === 'm') n *= 1000000;
          return Math.round(n);
        }
        function parseAddress(a) {
          // "2011 W State Road 84, Fort Lauderdale, FL 33315"
          const parts = (a || '').split(',').map((p) => p.trim());
          if (parts.length >= 3) {
            const stateZip = parts[parts.length - 1].split(/\s+/);
            return {
              address: parts.slice(0, -2).join(', '),
              city: parts[parts.length - 2],
              state: stateZip[0] || '',
              zip: stateZip[1] || '',
            };
          }
          return { address: a || '', city: '', state: '', zip: '' };
        }
        return cards.slice(0, 50).map((card) => {
          const lines = (card.innerText || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
          const addr = parseAddress(lines[0] || '');
          const sizeLine = lines[1] || ''; // "1.02k SF Warehouse"
          const sizeMatch = sizeLine.match(/^([\d,.]+\s*[kmKM]?)\s*SF\s+(.*)$/i);
          const saleLine = lines[2] || '';
          const builtLine = lines.find((l) => /^Built in/i.test(l)) || '';
          const ownerIdx = lines.indexOf('Owner');
          const owner = ownerIdx >= 0 ? (lines[ownerIdx + 1] || '') : '';
          const contactsLine = lines.find((l) => /Contact/i.test(l)) || '';
          const contactsMatch = contactsLine.match(/^(\d+)/);
          return {
            ...addr,
            size_sf: sizeMatch ? parseSize(sizeMatch[1]) : null,
            property_type: sizeMatch ? sizeMatch[2] : '',
            last_sale: /^Sold on/i.test(saleLine) ? saleLine.replace(/^Sold on\s+/, '') : '',
            year_built: (builtLine.match(/(\d{4})/) || [])[1] || '',
            owner,
            contacts_available: contactsMatch ? Number(contactsMatch[1]) : null,
          };
        });
      });
    } catch (_) { /* list panel didn't render — we still have the count */ }

    // 9. Optional dedupe
    if (Array.isArray(body.dedupe_against) && body.dedupe_against.length) {
      rows = tagDupes(rows, body.dedupe_against, {
        phone: 'phone', address: 'address', entity: 'entity',
      });
    }

    await saveState('reonomy');
    res.json({
      workflow: 'R1',
      total_count: totalCount,
      returned_count: rows.length,
      rows,
      note: rows.length === 0
        ? 'Filters applied but the result list panel selectors need one more inspection round. Total count is trustworthy.'
        : undefined,
    });
  } catch (err) {
    console.error('R1 error:', err);
    res.status(500).json({ error: 'reonomy_r1_failed', message: err.message });
  } finally {
    await page.close().catch(() => {});
  }
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
  const uuid = b.search_uuid;
  const limit = Number(b.limit) || 25;
  if (!uuid) return res.status(400).json({ error: 'search_uuid required' });

  const page = await newPage('reonomy');
  try {
    const apiResponses = [];
    page.on('response', async (resp) => {
      const u = resp.url();
      if (u.includes('api.reonomy.com/v2') && (u.includes('search') || u.includes('summary'))) {
        try {
          const status = resp.status();
          const text = await resp.text();
          apiResponses.push({ url: u, status, text });
        } catch {}
      }
    });

    await page.goto(`${REONOMY_BASE}/!/search/${uuid}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    await humanDelay(3000, 5000);

    // Find the properties/summary response
    const summary = apiResponses.reverse().find(r => r.status === 200 && (r.text.includes('property') || r.text.includes('address')));
    if (!summary) {
      return res.status(502).json({
        error: 'reonomy_no_data',
        message: 'Loaded saved search but no property data intercepted',
        capturedCount: apiResponses.length,
        urls: apiResponses.map(r => r.url).slice(0, 10),
      });
    }
    let parsed;
    try { parsed = JSON.parse(summary.text); } catch { return res.status(502).json({ error: 'reonomy_parse_error', body: summary.text.slice(0, 400) }); }
    return res.json({
      workflow: 'R1-fast',
      module: 'reonomy saved-search intercept',
      search_uuid: uuid,
      raw_top_keys: Object.keys(parsed || {}),
      preview: JSON.stringify(parsed).slice(0, 4000),
    });
  } catch (err) {
    console.error('R1-fast error:', err);
    res.status(500).json({ error: 'reonomy_saved_search_failed', message: err.message });
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { propertyList, ownerDetail, savedSearch, ensureLogin };
