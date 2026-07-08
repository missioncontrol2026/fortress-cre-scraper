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

  const page = await newPage('costar');
  try {
    // ensureLogin navigates to the target URL and verifies we're authenticated
    await ensureLogin(page, URLS.ownersCompanies);
    await humanDelay(1500, 2500);

    // Wait for results table to render (CSG table). If it doesn't render, dump diagnostics.
    try {
      await page.waitForSelector('table.csg-tw-table tr.csg-tw-table-row', { timeout: 30000 });
    } catch (waitErr) {
      const diag = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        headText: (document.querySelector('h1, h2')?.textContent || '').slice(0, 120),
        bodyChars: document.body.innerText.length,
        bodyPreview: document.body.innerText.slice(0, 500),
        hasTable: !!document.querySelector('table'),
        hasCsgTable: !!document.querySelector('table.csg-tw-table'),
        rowCount: document.querySelectorAll('tr').length,
      }));
      throw new Error(`table did not render — diag: ${JSON.stringify(diag)}`);
    }

    // Owner Type filter (multi-select autocomplete by placeholder)
    if (Array.isArray(b.owner_types_include) && b.owner_types_include.length) {
      const ownerTypeInput = page.locator('input[placeholder="Owner Type"]').first();
      for (const t of b.owner_types_include) {
        await ownerTypeInput.click();
        await humanDelay(300, 600);
        await ownerTypeInput.fill(t);
        await humanDelay(500, 900);
        await page.keyboard.press('Enter');
        await humanDelay(300, 600);
      }
      await page.keyboard.press('Escape');
    }

    // Main Property Type filter
    if (b.main_property_type) {
      const propInput = page.locator('input[placeholder="Main Property Type"]').first();
      await propInput.click();
      await humanDelay(300, 600);
      await propInput.fill(b.main_property_type);
      await humanDelay(500, 900);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      await humanDelay(400, 800);
    }

    // Wait for table refresh after filters
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await humanDelay(1200, 2000);

    // Extract rows — positional column indexes per COSTAR-DOM-NOTES.md
    const rows = await page.$$eval(
      'table.csg-tw-table tr.csg-tw-table-row',
      (nodes, n) => {
        const t = (el) => (el?.textContent || '').trim();
        return nodes.slice(0, n).map((r) => {
          const cells = Array.from(r.querySelectorAll('td.csg-tw-table-cell'));
          if (cells.length < 15) return null;
          return {
            company:              t(cells[1]),
            hierarchy:            t(cells[2]),
            owner_type:           t(cells[3]),
            hq_city:              t(cells[4]),
            hq_state:             t(cells[5]),
            hq_country:           t(cells[6]),
            property_count:       Number((t(cells[7]) || '').replace(/[^\d]/g, '')) || null,
            total_sf_owned:       Number((t(cells[8]) || '').replace(/[^\d]/g, '')) || null,
            avg_sf:               Number((t(cells[9]) || '').replace(/[^\d]/g, '')) || null,
            main_property_type:   t(cells[13]),
            recent_deal_count:    Number((t(cells[19]) || '').replace(/[^\d]/g, '')) || null,
            avg_deal_value:       t(cells[20]),
            twelve_month_value:   t(cells[21]),
            total_value:          t(cells[22]),
          };
        }).filter(Boolean);
      },
      limit,
    );

    // Optional post-filter for excluded owner types (CoStar UI doesn't have simple exclude)
    let filtered = rows;
    if (Array.isArray(b.owner_types_exclude) && b.owner_types_exclude.length) {
      const excl = new Set(b.owner_types_exclude.map((s) => s.toLowerCase()));
      filtered = rows.filter((r) => !excl.has((r.owner_type || '').toLowerCase()));
    }
    if (b.hq_country) {
      filtered = filtered.filter((r) => (r.hq_country || '').toLowerCase() === b.hq_country.toLowerCase());
    }

    await saveState('costar');
    res.json({
      workflow: 'C1',
      module: 'owners/companies',
      count: filtered.length,
      total_before_client_filter: rows.length,
      rows: filtered,
      quota_usage: currentUsage('costar'),
    });
  } catch (err) {
    console.error('C1 (owner-search) error:', err);
    res.status(err.status || 500).json({ error: 'costar_owner_search_failed', message: err.message });
  } finally {
    await page.close().catch(() => {});
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

// Import a CoStar session captured from a real browser (bypasses Akamai bot detection).
// POST /admin/import-costar-session
// body: { cookies: [{ name, value, domain, path, expires, httpOnly, secure, sameSite }], origins?: [{ origin, localStorage: [{name, value}] }] }
// Writes to /app/sessions/costar.storage.json so next `newPage('costar')` uses it.
async function importCostarSession(req, res) {
  const path = require('path');
  const fs   = require('fs');
  const b = req.body || {};
  const cookies = Array.isArray(b.cookies) ? b.cookies : null;
  if (!cookies || !cookies.length) return res.status(400).json({ error: 'cookies array required' });

  // Normalize each cookie into Playwright storage_state format
  const normalized = cookies.map((c) => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain    || '.costar.com',
    path:     c.path      || '/',
    expires:  typeof c.expires === 'number' ? c.expires : -1,
    httpOnly: c.httpOnly === true,
    secure:   c.secure !== false,
    sameSite: c.sameSite || 'Lax',
  }));

  const storageState = {
    cookies:  normalized,
    origins:  Array.isArray(b.origins) ? b.origins : [],
  };

  const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const outFile = path.join(SESSIONS_DIR, 'costar.storage.json');
  fs.writeFileSync(outFile, JSON.stringify(storageState, null, 0));

  // Also seed the persistent context userDataDir with these cookies so the FIRST
  // page.goto after this import already has them. Playwright's launchPersistentContext
  // reads cookies from Cookies file — simplest way: launch context, addCookies, close.
  try {
    const { chromium } = require('patchright');
    const userDataDir = path.join(SESSIONS_DIR, 'costar-userdata');
    fs.mkdirSync(userDataDir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium', headless: true, viewport: null,
      locale: 'en-US', timezoneId: 'America/Chicago',
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
    await ctx.addCookies(normalized);
    await ctx.close();
  } catch (seedErr) {
    console.error('cookie seed to userDataDir failed:', seedErr.message);
  }

  res.json({ ok: true, cookieCount: normalized.length, storageStatePath: outFile });
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
  quota,
};
