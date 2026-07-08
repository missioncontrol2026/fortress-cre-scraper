// CoStar workflows C1-C7. All 7 documented in scraper/SPEC.md.
// Real DOM captured 2026-07-07 from Alex's live session — see COSTAR-DOM-NOTES.md.
// URLs are lowercase kebab-case with ?new_search=true (legacy /Search/... paths don't work).

const { newPage, saveState, humanDelay } = require('../lib/browser');
const { tryConsume, currentUsage, LIMITS } = require('../lib/rateLimit');

const COSTAR_BASE = 'https://product.costar.com';

// Real URLs — captured from live nav 2026-07-07
const URLS = {
  ownersCompanies:   `${COSTAR_BASE}/suiteapps/owners/companies?new_search=true`,
  ownersFunds:       `${COSTAR_BASE}/owners/funds?new_search`,
  saleComps:         `${COSTAR_BASE}/search/sale-comps/?new_search=true`,
  leaseActivity:     `${COSTAR_BASE}/suiteapps/lease-activity?new_search=true`,
  rentBenchmark:     `${COSTAR_BASE}/suiteapps/rent-benchmark?new_search=true`,
  allProperties:     `${COSTAR_BASE}/search/all-properties/?new_search=true`,
  multiFamily:       `${COSTAR_BASE}/search/multi-family/?new_search=true`,
  forSale:           `${COSTAR_BASE}/listings/for-sale?new_search=true`,
  forLease:          `${COSTAR_BASE}/listings/for-lease?new_search=true`,
  publicRecord:      `${COSTAR_BASE}/search/public-record?new_search=true`,
};

// --- login helper ---
// Alex's account has NO 2FA. Cached session persists via Render Disk.
// Interactive login is `POST /admin/login/costar` — this ensureLogin verifies
// by navigating to the target app URL and checking we didn't get bounced to login.
// Caller passes the actual app URL it wants to end up on (e.g. URLS.ownersCompanies).
async function ensureLogin(page, targetUrl = URLS.ownersCompanies) {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await humanDelay();
  const url = page.url();
  if (url.includes('/login') || url.includes('secure.costargroup.com')) {
    throw new Error(
      `CoStar session expired (landed on ${url}). Run POST /admin/login/costar to refresh.`,
    );
  }
  // If we landed on the marketing home /, the session isn't good enough for app routes.
  // (product.costar.com/ has no app chrome, product.costar.com/suiteapps/... does.)
  if (url === `${COSTAR_BASE}/` || url === COSTAR_BASE) {
    throw new Error(
      `CoStar redirected to marketing homepage (session insufficient). Run POST /admin/login/costar.`,
    );
  }
  return true;
}

// Helper: consume one export credit from the monthly cap and enforce delays.
function consumeOrThrow() {
  const gate = tryConsume('costar');
  if (!gate.ok) {
    const err = new Error(`CoStar cap hit (${gate.blockedBy}: ${gate.used}/${gate.limit})`);
    err.status = 429;
    err.gate = gate;
    throw err;
  }
  return gate;
}

// ---------- Workflow C1 — Comparable-buyers search (full) ----------
// POST /costar/buyer-search
// body: {
//   property_type: "Industrial Warehouse",
//   subject_size_sf: 30000,
//   subject_address: "123 Main, Birmingham AL",
//   size_multiplier_low: 0.7,
//   size_multiplier_high: 1.5,
//   radius_miles: 50,
//   months_back: 24,
//   exclude: ["REIT","government","non-profit","institutional"],
//   result_limit: 20,
//   mode: "full"                 // "full" (C1) | "top5" (C2) | "national" (C3)
// }
async function buyerSearch(req, res) {
  let gate;
  try { gate = consumeOrThrow(); } catch (e) { return res.status(e.status).json({ error: 'rate_limited', ...e.gate }); }

  const b = req.body || {};
  const mode = b.mode || 'full';
  // Enforce mode-specific defaults per spec.
  const cfg = {
    full:     { sizeLow: 0.7, sizeHigh: 1.5, radius: 50, months: 24, limit: 50 },
    top5:     { sizeLow: 0.8, sizeHigh: 1.3, radius: 25, months: 18, limit: 5  },
    national: { sizeLow: 0.7, sizeHigh: 1.5, radius: null, months: 24, limit: 10, minPortfolio: 3 },
  }[mode];
  if (!cfg) return res.status(400).json({ error: `unknown mode: ${mode}` });

  const sizeMin = Math.round((b.subject_size_sf || 0) * (b.size_multiplier_low  || cfg.sizeLow));
  const sizeMax = Math.round((b.subject_size_sf || 0) * (b.size_multiplier_high || cfg.sizeHigh));
  const radius  = b.radius_miles || cfg.radius;
  const months  = b.months_back  || cfg.months;
  const limit   = b.result_limit || cfg.limit;

  const page = await newPage('costar');
  try {
    await ensureLogin(page);

    // Navigate to the Sales / Comps module — CoStar calls it Sale Comps.
    await page.goto(URLS.saleComps, { waitUntil: 'domcontentloaded' }); // real URL
    await humanDelay(1500, 2500);

    // Property type filter
    if (b.property_type) {
      await page.click('[data-filter="property-type"]'); // TUNE
      await humanDelay();
      await page.click(`[role="option"]:has-text("${b.property_type}")`); // TUNE
      await humanDelay();
    }
    // Size range
    if (sizeMin && sizeMax) {
      await page.click('[data-filter="size"]'); // TUNE
      await page.fill('input[name="size_min"]', String(sizeMin)); // TUNE
      await page.fill('input[name="size_max"]', String(sizeMax)); // TUNE
      await page.keyboard.press('Enter');
    }
    // Date range
    await page.click('[data-filter="sale-date"]'); // TUNE
    await humanDelay();
    await page.fill('input[name="months_back"]', String(months)); // TUNE
    await page.keyboard.press('Enter');

    // Geography — full/top5 use radius, national skips this
    if (radius && b.subject_address) {
      await page.click('[data-filter="location"]'); // TUNE
      await page.fill('input[name="location"]', b.subject_address); // TUNE
      await humanDelay(700, 1200);
      await page.click(`[role="option"]:first-of-type`); // TUNE
      await page.fill('input[name="radius_miles"]', String(radius)); // TUNE
      await page.keyboard.press('Enter');
    }
    // Exclusions
    for (const excl of b.exclude || ['REIT', 'government', 'non-profit', 'institutional']) {
      await page.click('[data-filter="buyer-type-exclude"]'); // TUNE
      await humanDelay();
      await page.click(`[role="option"]:has-text("${excl}")`); // TUNE
    }
    // National (C3) needs a "purchased 3+ properties" filter
    if (mode === 'national') {
      await page.click('[data-filter="portfolio-size"]'); // TUNE
      await page.fill('input[name="min_portfolio"]', '3'); // TUNE
      await page.keyboard.press('Enter');
    }

    // Run + wait for results
    await page.click('[data-action="run-search"]'); // TUNE
    await page.waitForSelector('[data-testid="results-table"]', { timeout: 60000 }); // TUNE
    await humanDelay(1500, 3000);

    // Sort by recency + take top N
    if (mode === 'top5' || mode === 'national') {
      await page.click('[data-sort="sale-date-desc"]'); // TUNE
      await humanDelay();
    }

    const rows = await page.$$eval('[data-testid="results-row"]', (nodes, n) => // TUNE
      nodes.slice(0, n).map((r) => ({
        entity_name:      r.querySelector('[data-col="entity_name"]')?.textContent?.trim() || '',
        entity_type:      r.querySelector('[data-col="entity_type"]')?.textContent?.trim() || '',
        principal_name:   r.querySelector('[data-col="principal_name"]')?.textContent?.trim() || '',
        purchase_address: r.querySelector('[data-col="purchase_address"]')?.textContent?.trim() || '',
        purchase_date:    r.querySelector('[data-col="purchase_date"]')?.textContent?.trim() || '',
        purchase_size_sf: Number((r.querySelector('[data-col="purchase_size_sf"]')?.textContent || '').replace(/[^\d]/g, '')) || null,
        purchase_price:   r.querySelector('[data-col="purchase_price"]')?.textContent?.trim() || '',
      })), limit);

    await saveState('costar');
    res.json({ workflow: mode === 'top5' ? 'C2' : mode === 'national' ? 'C3' : 'C1', mode, count: rows.length, rows, quota_usage: currentUsage('costar') });
  } catch (err) {
    console.error('C1 error:', err);
    res.status(err.status || 500).json({ error: 'costar_c1_failed', message: err.message });
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- Workflow C1-real — Buyer research via Owners → Companies ----------
// POST /costar/owner-search
// body: {
//   owner_types_include: ["Investment Manager", "Insurance Company", "Pension Fund"],
//   owner_types_exclude: ["Public REIT", "Non-Profit", "Government"],
//   main_property_type: "Industrial",     // or "Multi-Family", "Office", "Retail", "Diversified"
//   min_portfolio_sf: 100000,             // default is CoStar's "100K+ SF" chip
//   hq_country: "United States",
//   result_limit: 25,
// }
// Returns: [{ company, hierarchy, owner_type, hq_city, hq_state, hq_country,
//             property_count, total_sf_owned, avg_sf, main_property_type,
//             recent_deal_count, avg_deal_value, twelve_month_value, total_value }]
async function ownerSearch(req, res) {
  let gate; try { gate = consumeOrThrow(); }
  catch (e) { return res.status(e.status).json({ error: 'rate_limited', ...e.gate }); }
  const b = req.body || {};
  const limit = Math.min(b.result_limit || 20, 100);

  const query = `query CompaniesSearch($searchRequest: CompaniesSearchRequestInput!) {
  companies {
    companiesSearchWithList(searchRequest: $searchRequest) {
      data { id companyKey locationName hierarchy ownerType cityId stateId countryCode countryId numberOfProperties buildingSqFtTotal averageSqFtTotal primaryPropertyType acquistitions dispositions forSalePriceTotal numberOfForSales continentalFocus territory }
    }
  }
}`;
  const variables = {
    searchRequest: {
      pageNumber: 1,
      pageSize: Math.min(Math.max(limit * 2, 20), 100),
      searchCriteria: {
        portfolio: {
          buildingAreaSqFtTotal: { minimum: b.min_portfolio_sf || 100000 },
          numberOfPropertiesTotal: { minimum: 25 },
        },
        sortType: 0,
      },
    },
  };

  // POST to CoStar's GraphQL via ScrapingBee - they handle Akamai
  try {
    const key = process.env.SCRAPINGBEE_API_KEY;
    if (!key) return res.status(500).json({ error: 'SCRAPINGBEE_API_KEY not set' });
    const path = require('path');
    const fs = require('fs');
    const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
    let cookies = '';
    try {
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, 'costar.storage.json'), 'utf8');
      const parsed = JSON.parse(raw);
      cookies = (parsed.cookies || [])
        .filter((c) => c.name && c.value)
        .map((c) => `${c.name}=${c.value}`)
        .join(';');
    } catch {}
    let extraHeaders = {};
    try {
      const hf = path.join(SESSIONS_DIR, 'costar.headers.json');
      if (fs.existsSync(hf)) extraHeaders = JSON.parse(fs.readFileSync(hf, 'utf8'));
    } catch {}

    // ScrapingBee POST proxy: use request body forwarding
    const params = new URLSearchParams({
      api_key: key,
      url: 'https://product.costar.com/suiteapps/owners/graphql',
      premium_proxy: 'true',
      country_code: 'us',
      render_js: 'false',
      forward_headers: 'true',
      forward_headers_pure: 'true',
    });
    if (cookies) params.set('cookies', cookies);

    const headers = {
      'Content-Type': 'application/json',
      'Spb-Content-Type': 'application/json',
      'Spb-Accept': '*/*',
      'Spb-Referer': 'https://product.costar.com/suiteapps/owners/companies?new_search=true',
      'Spb-Origin': 'https://product.costar.com',
    };
    for (const [k, v] of Object.entries(extraHeaders)) headers['Spb-' + k] = v;

    const body = JSON.stringify({ query, variables, operationName: 'CompaniesSearch' });
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
      req.write(body);
      req.end();
    });

    if (r.status !== 200) {
      return res.status(502).json({ error: 'costar_scrapingbee_error', status: r.status, body: (r.text || '').slice(0, 800) });
    }
    let parsed;
    try { parsed = JSON.parse(r.text); } catch { return res.status(502).json({ error: 'costar_parse_error', body: r.text.slice(0, 400) }); }
    if (parsed.errors) return res.status(502).json({ error: 'costar_graphql_errors', errors: parsed.errors });
    const raw = parsed.data?.companies?.companiesSearchWithList?.data || [];
    let rows = raw.map((r) => ({
      company: r.locationName,
      hierarchy: r.hierarchy,
      owner_type: r.ownerType,
      hq_city: r.cityId,
      hq_state: r.stateId,
      hq_country: r.countryCode || r.countryId,
      property_count: Number((r.numberOfProperties || '').toString().replace(/[^\d]/g, '')) || null,
      total_sf_owned: Number((r.buildingSqFtTotal || '').toString().replace(/[^\d]/g, '')) || null,
      avg_sf: Number((r.averageSqFtTotal || '').toString().replace(/[^\d]/g, '')) || null,
      main_property_type: r.primaryPropertyType,
      recent_deal_count: Number((r.numberOfForSales || '').toString().replace(/[^\d]/g, '')) || null,
      avg_deal_value: r.forSalePriceTotal,
      twelve_month_value: r.acquistitions,
      total_value: r.dispositions,
      company_key: r.companyKey,
    }));
    if (b.main_property_type) {
      const mp = b.main_property_type.toLowerCase();
      rows = rows.filter((r) => (r.main_property_type || '').toLowerCase() === mp);
    }
    if (Array.isArray(b.owner_types_include) && b.owner_types_include.length) {
      const inc = new Set(b.owner_types_include.map((s) => s.toLowerCase()));
      rows = rows.filter((r) => inc.has((r.owner_type || '').toLowerCase()));
    }
    if (Array.isArray(b.owner_types_exclude) && b.owner_types_exclude.length) {
      const excl = new Set(b.owner_types_exclude.map((s) => s.toLowerCase()));
      rows = rows.filter((r) => !excl.has((r.owner_type || '').toLowerCase()));
    }
    rows = rows.slice(0, limit);
    return res.json({
      workflow: 'C1',
      module: 'owners/companies (scrapingbee)',
      count: rows.length,
      rows,
      quota_usage: currentUsage('costar'),
    });
  } catch (err) {
    console.error('C1 (owner-search) error:', err);
    return res.status(500).json({ error: 'costar_owner_search_failed', message: err.message });
  }
}
// ---------- Workflow C4 — Sales & lease comps for underwriting brief ----------
// POST /costar/comps
// body: {
//   subject_address: "123 Main, Birmingham AL",
//   property_type: "Industrial Warehouse",
//   radius_miles: 5,
//   months_back: 18,
//   sales_limit: 5,
//   leases_limit: 5,
// }
async function comps(req, res) {
  let gate; try { gate = consumeOrThrow(); }
  catch (e) { return res.status(e.status).json({ error: 'rate_limited', ...e.gate }); }
  const b = req.body || {};
  const page = await newPage('costar');
  try {
    await ensureLogin(page);

    // -- Sales comps --
    await page.goto(URLS.saleComps, { waitUntil: 'domcontentloaded' }); // real URL
    await humanDelay();
    await applyCompFilters(page, b);
    await page.click('[data-action="run-search"]'); // TUNE
    await page.waitForSelector('[data-testid="results-table"]', { timeout: 60000 }); // TUNE
    const sales = await extractComps(page, b.sales_limit || 5);

    // -- Lease comps --
    // CoStar doesn't have a "Lease Comps" module — use Lease Activity + For Lease
    await page.goto(URLS.leaseActivity, { waitUntil: 'domcontentloaded' });
    await humanDelay();
    await applyCompFilters(page, b);
    await page.click('[data-action="run-search"]'); // TUNE
    await page.waitForSelector('[data-testid="results-table"]', { timeout: 60000 }); // TUNE
    const leases = await extractComps(page, b.leases_limit || 5);

    await saveState('costar');
    res.json({ workflow: 'C4', sales, leases, quota_usage: currentUsage('costar') });
  } catch (err) {
    console.error('C4 error:', err);
    res.status(err.status || 500).json({ error: 'costar_c4_failed', message: err.message });
  } finally {
    await page.close().catch(() => {});
  }
}

async function applyCompFilters(page, b) {
  if (b.property_type) {
    await page.click('[data-filter="property-type"]'); // TUNE
    await page.click(`[role="option"]:has-text("${b.property_type}")`); // TUNE
  }
  if (b.subject_address) {
    await page.click('[data-filter="location"]'); // TUNE
    await page.fill('input[name="location"]', b.subject_address); // TUNE
    await humanDelay(500, 900);
    await page.click(`[role="option"]:first-of-type`); // TUNE
    await page.fill('input[name="radius_miles"]', String(b.radius_miles || 5)); // TUNE
    await page.keyboard.press('Enter');
  }
  await page.click('[data-filter="sale-date"]'); // TUNE
  await page.fill('input[name="months_back"]', String(b.months_back || 18)); // TUNE
  await page.keyboard.press('Enter');
}
async function extractComps(page, limit) {
  return page.$$eval('[data-testid="results-row"]', (nodes, n) => // TUNE
    nodes.slice(0, n).map((r) => ({
      comp_address:    r.querySelector('[data-col="address"]')?.textContent?.trim() || '',
      price:           r.querySelector('[data-col="price"]')?.textContent?.trim() || '',
      price_per_sf:    r.querySelector('[data-col="price_per_sf"]')?.textContent?.trim() || '',
      date:            r.querySelector('[data-col="date"]')?.textContent?.trim() || '',
      size_sf:         Number((r.querySelector('[data-col="size_sf"]')?.textContent || '').replace(/[^\d]/g, '')) || null,
      rent_per_sf:     r.querySelector('[data-col="rent_per_sf"]')?.textContent?.trim() || '',
      lease_type:      r.querySelector('[data-col="lease_type"]')?.textContent?.trim() || '',
    })), limit);
}

// ---------- Workflow C5 — Property URL/photo lookup ----------
// GET /costar/property?address=...
// Also serves C6 (listing status) and C7 (property-type confirm).
async function propertyLookup(req, res) {
  const address = req.query.address || (req.body && req.body.address);
  if (!address) return res.status(400).json({ error: 'address required' });
  // No export consumed for lookups per spec C5/C6/C7.
  const page = await newPage('costar');
  try {
    await ensureLogin(page);
    // Real property lookup: use All Properties search with Location filter
    await page.goto(URLS.allProperties, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    // Type into location filter (placeholder "Location") and pick first result
    const locInput = await page.locator('input[placeholder="Location"]').first();
    await locInput.fill(address);
    await humanDelay(700, 1200);
    await page.keyboard.press('Enter');
    await humanDelay();
    await page.click(`[data-testid="results-row"]:first-of-type`); // TUNE
    await page.waitForLoadState('domcontentloaded');
    await humanDelay();

    const data = await page.evaluate(() => { // TUNE selectors below
      const t = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
      return {
        property_url:    location.href,
        property_type:   t('[data-testid="property-type"]'),
        size_sf:         Number((t('[data-testid="size-sf"]') || '').replace(/[^\d]/g, '')) || null,
        occupancy:       t('[data-testid="occupancy"]'),
        cap_rate:        t('[data-testid="cap-rate"]'),
        listing_status:  t('[data-testid="listing-status"]'),   // "Active" | "Expired" | "Delisted" | ""
        broker_name:     t('[data-testid="listing-broker-name"]'),
        broker_contact:  t('[data-testid="listing-broker-contact"]'),
        photo_url:       document.querySelector('[data-testid="property-photo"] img')?.src || '',
      };
    });
    await saveState('costar');
    res.json({ workflows: ['C5', 'C6', 'C7'], address, ...data });
  } catch (err) {
    console.error('C5/C6/C7 error:', err);
    res.status(err.status || 500).json({ error: 'costar_lookup_failed', message: err.message });
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- Admin: interactive login (2FA) ----------
// POST /admin/login/costar   body: { code: "123456" }
// If cached session is stale, browser walks through login using
// COSTAR_EMAIL + COSTAR_PASSWORD + this posted 2FA code.
async function loginCostar(req, res) {
  const email    = process.env.COSTAR_EMAIL;
  const password = process.env.COSTAR_PASSWORD;
  const code     = (req.body || {}).code;
  if (!email || !password) return res.status(500).json({ error: 'COSTAR_EMAIL/PASSWORD not set' });

  const page = await newPage('costar');
  try {
    // CoStar's marketing homepage doesn't force a login. Hit an app URL directly
    // to trigger the SSO redirect through secure.costargroup.com with a valid signin token.
    // If the session cache is already good, this lands us straight in the app (no login).
    await page.goto(URLS.ownersCompanies, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    await humanDelay(2000, 3500);

    // Fast path: if we didn't redirect to a login page, we're already signed in.
    const curUrl = page.url();
    if (!curUrl.includes('secure.costargroup.com') && !curUrl.includes('/login')) {
      await saveState('costar');
      return res.json({ ok: true, message: 'CoStar session already active', url: curUrl });
    }

    // Email/username field appears first; then password (Auth0-style step). Both variants supported.
    await page.waitForSelector('input[name="username"], input[name="email"], input[type="email"], input[id*="user"], input[id*="email"]', { timeout: 30000 });
    await page.fill('input[name="username"], input[name="email"], input[type="email"], input[id*="user"], input[id*="email"]', email);
    await humanDelay(400, 900);

    // Some CoStar tenants require clicking "Continue" before password appears.
    const cont = page.locator('button:has-text("Continue"), button:has-text("Next")').first();
    if (await cont.isVisible().catch(() => false)) {
      await cont.click();
      await humanDelay(600, 1200);
    }

    await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 15000 });
    await page.fill('input[name="password"], input[type="password"]', password);
    await humanDelay(400, 900);

    await page.click('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');
    await humanDelay(2000, 3500);

    // If a 2FA prompt appears AND we have a code, fill it. Otherwise proceed (no-2FA seats).
    const mfaField = page.locator('input[autocomplete="one-time-code"], input[name="mfaCode"], input[name="code"]').first();
    if (await mfaField.isVisible({ timeout: 5000 }).catch(() => false)) {
      if (!code) {
        throw new Error('CoStar asked for a 2FA code but none was provided. POST with body {"code":"XXXXXX"}');
      }
      await mfaField.fill(code);
      await page.click('button[type="submit"], button:has-text("Verify")');
    }

    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    await humanDelay(1500, 2500);
    await saveState('costar');
    res.json({ ok: true, message: 'CoStar session established', url: page.url() });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'login_failed', message: err.message, url: page.url() });
  } finally {
    await page.close().catch(() => {});
  }
}

// Import a real-browser session captured from a live tab (bypasses bot detection).
// POST /admin/import-session
// body: { vendor: "costar"|"reonomy", cookies: [...], origins?: [...] }
// Writes to /app/sessions/<vendor>.storage.json AND seeds userDataDir.
async function importSession(req, res) {
  const path = require('path');
  const fs   = require('fs');
  const b = req.body || {};
  const vendor = (b.vendor || '').toLowerCase();
  const cookies = Array.isArray(b.cookies) ? b.cookies : null;
  if (!['costar', 'reonomy'].includes(vendor)) return res.status(400).json({ error: 'vendor must be costar or reonomy' });
  if (!cookies || !cookies.length) return res.status(400).json({ error: 'cookies array required' });

  const defaultDomain = vendor === 'costar' ? '.costar.com' : '.reonomy.com';
  const normalized = cookies.map((c) => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain    || defaultDomain,
    path:     c.path      || '/',
    expires:  typeof c.expires === 'number' ? c.expires : -1,
    httpOnly: c.httpOnly === true,
    secure:   c.secure !== false,
    sameSite: c.sameSite || 'Lax',
  }));

  const storageState = { cookies: normalized, origins: Array.isArray(b.origins) ? b.origins : [] };
  const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const outFile = path.join(SESSIONS_DIR, `${vendor}.storage.json`);
  fs.writeFileSync(outFile, JSON.stringify(storageState, null, 0));

  // Save extra headers (e.g. cs-owners-formatting-prefs JWT) that impers-based
  // fetches must include to satisfy CoStar's app-layer auth
  if (b.extraHeaders && typeof b.extraHeaders === 'object') {
    const hdrFile = path.join(SESSIONS_DIR, `${vendor}.headers.json`);
    fs.writeFileSync(hdrFile, JSON.stringify(b.extraHeaders));
  }

  try {
    const { chromium } = require('patchright');
    const userDataDir = path.join(SESSIONS_DIR, `${vendor}-userdata`);
    fs.mkdirSync(userDataDir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium', headless: true, viewport: null,
      locale: 'en-US', timezoneId: 'America/Chicago',
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
    await ctx.addCookies(normalized);
    await ctx.close();
  } catch (seedErr) {
    console.error(`cookie seed to ${vendor} userDataDir failed:`, seedErr.message);
  }

  res.json({ ok: true, vendor, cookieCount: normalized.length, storageStatePath: outFile });
}

// Alias for backward compat with the earlier CoStar-specific route
async function importCostarSession(req, res) {
  req.body = { ...(req.body || {}), vendor: 'costar' };
  return importSession(req, res);
}

// Same for Reonomy (Auth0 usually just needs email+password, no 2FA)
async function loginReonomy(req, res) {
  const { ensureLogin } = require('./reonomy');
  const page = await newPage('reonomy');
  try {
    await ensureLogin(page);
    await saveState('reonomy');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'login_failed', message: err.message });
  } finally {
    await page.close().catch(() => {});
  }
}

// Quota inspection
function quota(req, res) {
  res.json({
    costar:  { limits: LIMITS.costar,  usage: currentUsage('costar')  },
    reonomy: { limits: LIMITS.reonomy, usage: currentUsage('reonomy') },
  });
}

module.exports = {
  buyerSearch,
  ownerSearch,
  comps,
  propertyLookup,
  loginCostar,
  loginReonomy,
  importCostarSession,
  importSession,
  quota,
};
