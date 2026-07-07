// Reonomy workflows R1 (property list) and R2 (owner skip-trace).
// All selectors marked TUNE will be validated on the first successful login
// (Britt drives the browser, we snapshot the DOM, lock the selectors here).

const { newPage, saveState, humanDelay } = require('../lib/browser');
const { tagDupes } = require('../lib/dedupe');
const { tryConsume } = require('../lib/rateLimit');

const REONOMY_BASE = 'https://app.reonomy.com';

// --- login helper (runs on demand, keeps a persistent context) ---
async function ensureLogin(page) {
  await page.goto(`${REONOMY_BASE}/`, { waitUntil: 'domcontentloaded' });
  await humanDelay();
  // Detect whether we're already signed in by looking for the search UI.
  const signedIn = await page.$('[data-testid="global-nav"], nav [href*="/search"]'); // TUNE
  if (signedIn) return true;

  const email = process.env.REONOMY_EMAIL;
  const password = process.env.REONOMY_PASSWORD;
  if (!email || !password) {
    throw new Error('REONOMY_EMAIL/PASSWORD not set — call /admin/login/reonomy interactively first');
  }
  // Reonomy uses Auth0 — same origin flow we saw in Britt's browser earlier.
  await page.goto(`${REONOMY_BASE}/login`, { waitUntil: 'domcontentloaded' });
  await humanDelay();
  await page.fill('input[name="username"], input[type="email"]', email); // TUNE
  await humanDelay(400, 900);
  await page.fill('input[name="password"], input[type="password"]', password); // TUNE
  await humanDelay(400, 900);
  await page.click('button[type="submit"]'); // TUNE
  await page.waitForLoadState('networkidle', { timeout: 45000 });
  await saveState('reonomy');
  return true;
}

// ---------- Workflow R1 ----------
// POST /reonomy/property-list
// body: {
//   property_types: ["Industrial - Warehouse"],
//   min_size_sf: 15000,
//   geography: [{ county: "Davidson", state: "TN" }],
//   owner_type: "private",
//   min_years_owned: 10,
//   exclude_keywords: ["self-storage","strip","hotel"],
//   dedupe_against: [ { phone, address, entity } ]   // optional CK list rows
// }
async function propertyList(req, res) {
  const gate = tryConsume('reonomy');
  if (!gate.ok) return res.status(429).json({ error: 'rate_limited', ...gate });

  const body = req.body || {};
  const page = await newPage('reonomy');
  try {
    await ensureLogin(page);

    // Reonomy URL-driven search where possible; UI fallback for filters that
    // aren't URL-addressable. Base search endpoint.
    await page.goto(`${REONOMY_BASE}/search`, { waitUntil: 'domcontentloaded' }); // TUNE
    await humanDelay();

    // Apply property type filter — Reonomy uses a filter panel on the left.
    // We open the panel, pick each type, close.
    await page.click('[data-testid="property-type-filter"]'); // TUNE
    await humanDelay();
    for (const t of body.property_types || []) {
      await page.click(`[role="option"]:has-text("${t}")`); // TUNE
      await humanDelay(200, 500);
    }
    await page.keyboard.press('Escape');

    // Size floor
    if (body.min_size_sf) {
      await page.click('[data-testid="size-filter"]'); // TUNE
      await humanDelay();
      await page.fill('input[name="min_size"]', String(body.min_size_sf)); // TUNE
      await page.keyboard.press('Enter');
    }

    // Geography — one filter per county/city
    for (const g of body.geography || []) {
      const label = g.city ? `${g.city}, ${g.state}` : `${g.county} County, ${g.state}`;
      await page.click('[data-testid="location-filter"]'); // TUNE
      await humanDelay();
      await page.fill('[data-testid="location-search"]', label); // TUNE
      await humanDelay(500, 1200);
      await page.click(`[role="option"]:has-text("${label}")`); // TUNE
      await humanDelay(200, 500);
    }

    // Owner type
    if (body.owner_type) {
      await page.click('[data-testid="owner-type-filter"]'); // TUNE
      await humanDelay();
      await page.click(`[role="option"]:has-text("${body.owner_type}")`); // TUNE
    }

    // Years owned
    if (body.min_years_owned) {
      await page.click('[data-testid="years-owned-filter"]'); // TUNE
      await humanDelay();
      await page.fill('input[name="min_years_owned"]', String(body.min_years_owned)); // TUNE
      await page.keyboard.press('Enter');
    }

    // Wait for results and extract table rows.
    await page.waitForSelector('[data-testid="results-table"]', { timeout: 30000 }); // TUNE
    await humanDelay(1000, 2000);

    let rows = await page.$$eval('[data-testid="results-row"]', (nodes) => // TUNE
      nodes.map((n) => ({
        property_name:  n.querySelector('[data-col="name"]')?.textContent?.trim() || '',
        address:        n.querySelector('[data-col="address"]')?.textContent?.trim() || '',
        city:           n.querySelector('[data-col="city"]')?.textContent?.trim() || '',
        state:          n.querySelector('[data-col="state"]')?.textContent?.trim() || '',
        size_sf:        Number((n.querySelector('[data-col="size"]')?.textContent || '').replace(/[^\d]/g, '')) || null,
        property_type:  n.querySelector('[data-col="type"]')?.textContent?.trim() || '',
        owner:          n.querySelector('[data-col="owner"]')?.textContent?.trim() || '',
        years_owned:    Number((n.querySelector('[data-col="years"]')?.textContent || '').replace(/[^\d]/g, '')) || null,
        owner_phone:    n.querySelector('[data-col="phone"]')?.textContent?.trim() || '',
        owner_email:    n.querySelector('[data-col="email"]')?.textContent?.trim() || '',
      }))
    );

    // Apply exclude_keywords (Mason's immutable filter)
    const excl = (body.exclude_keywords || []).map((s) => s.toLowerCase());
    rows = rows.filter((r) => {
      const blob = `${r.property_name} ${r.property_type}`.toLowerCase();
      return !excl.some((k) => blob.includes(k));
    });

    // Dedupe against CK list if provided
    if (Array.isArray(body.dedupe_against) && body.dedupe_against.length) {
      rows = tagDupes(rows, body.dedupe_against, {
        phone: 'phone', address: 'address', entity: 'entity',
      });
    }

    await saveState('reonomy');
    res.json({
      workflow: 'R1',
      count: rows.length,
      new_count: rows.filter((r) => !r._dupe).length,
      dupe_count: rows.filter((r) => r._dupe).length,
      rows,
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
// body: { owner_name: "ABC Ventures LLC", property_address?: "123 Main St" }
async function ownerDetail(req, res) {
  const gate = tryConsume('reonomy');
  if (!gate.ok) return res.status(429).json({ error: 'rate_limited', ...gate });

  const { owner_name, property_address } = req.body || {};
  if (!owner_name) return res.status(400).json({ error: 'owner_name required' });

  const page = await newPage('reonomy');
  try {
    await ensureLogin(page);
    await page.goto(`${REONOMY_BASE}/search?q=${encodeURIComponent(owner_name)}`, { // TUNE
      waitUntil: 'domcontentloaded',
    });
    await humanDelay(1500, 2500);

    // Click into the first matching owner card.
    const ownerLink = await page.$(`a:has-text("${owner_name}")`);
    if (!ownerLink) {
      return res.json({ workflow: 'R2', status: 'NOT_FOUND', owner_name });
    }
    await ownerLink.click();
    await page.waitForLoadState('domcontentloaded');
    await humanDelay(1500, 2500);

    const detail = await page.evaluate(() => { // TUNE selectors below
      const t = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
      return {
        phone:            t('[data-testid="owner-phone"]'),
        email:            t('[data-testid="owner-email"]'),
        mailing_address:  t('[data-testid="owner-mailing-address"]'),
        entity_type:      t('[data-testid="owner-entity-type"]'),
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

module.exports = { propertyList, ownerDetail, ensureLogin };
