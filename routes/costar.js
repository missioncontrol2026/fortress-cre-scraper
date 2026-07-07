// CoStar workflows C1-C7. All 7 documented in scraper/SPEC.md.
// Same selector caveat as Reonomy: all selectors below marked TUNE — validated
// on first login and locked in.

const { newPage, saveState, humanDelay } = require('../lib/browser');
const { tryConsume, currentUsage, LIMITS } = require('../lib/rateLimit');

const COSTAR_BASE = 'https://product.costar.com';

// --- login helper ---
// CoStar has 2FA held by Brent. Interactive login flow lives at
// /admin/login/costar — this ensureLogin just verifies the cached session.
async function ensureLogin(page) {
  await page.goto(`${COSTAR_BASE}/`, { waitUntil: 'domcontentloaded' });
  await humanDelay();
  const signedIn = await page.$('[data-testid="user-menu"], nav [href*="/search"]'); // TUNE
  if (signedIn) return true;
  throw new Error(
    'CoStar session expired. Run POST /admin/login/costar with { code: "<2FA code>" } to refresh.',
  );
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
    await page.goto(`${COSTAR_BASE}/Search/SaleComps`, { waitUntil: 'domcontentloaded' }); // TUNE
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
    await page.goto(`${COSTAR_BASE}/Search/SaleComps`, { waitUntil: 'domcontentloaded' }); // TUNE
    await humanDelay();
    await applyCompFilters(page, b);
    await page.click('[data-action="run-search"]'); // TUNE
    await page.waitForSelector('[data-testid="results-table"]', { timeout: 60000 }); // TUNE
    const sales = await extractComps(page, b.sales_limit || 5);

    // -- Lease comps --
    await page.goto(`${COSTAR_BASE}/Search/LeaseComps`, { waitUntil: 'domcontentloaded' }); // TUNE
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
    await page.goto(`${COSTAR_BASE}/Search/Property?q=${encodeURIComponent(address)}`, { // TUNE
      waitUntil: 'domcontentloaded',
    });
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
    // CoStar SSO requires a session token in the URL; visiting secure.costargroup.com/login
    // directly returns "invalid or expired". Start at product.costar.com so we get redirected
    // with the correct signin token.
    await page.goto('https://product.costar.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await humanDelay(2000, 3500);

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
  comps,
  propertyLookup,
  loginCostar,
  loginReonomy,
  quota,
};
