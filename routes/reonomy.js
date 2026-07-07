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
  await humanDelay(1200, 2200);
  // Signed-in indicator: the Reonomy search input is present on /!/home
  if (await page.$('input[placeholder*="Search by address"], input[placeholder*="Address"]')) {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    return true;
  }

  const email = process.env.REONOMY_EMAIL;
  const password = process.env.REONOMY_PASSWORD;
  if (!email || !password) {
    throw new Error('REONOMY_EMAIL/PASSWORD not set — cannot log in');
  }

  // Auth0's tenant is auth.reonomy.com — we get redirected there automatically.
  await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 20000 });
  await page.fill('input[name="email"], input[type="email"]', email);
  await humanDelay(300, 700);
  await page.fill('input[name="password"], input[type="password"]', password);
  await humanDelay(300, 700);
  await page.click('button[type="submit"]');
  await page.waitForURL(/app\.reonomy\.com/, { timeout: 45000 });
  await humanDelay(1000, 1600);
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

    // 1. Go to search — Reonomy's SPA hash routing lives under /!/search
    await page.goto(`${REONOMY_BASE}/!/search`, { waitUntil: 'domcontentloaded' });
    // Wait for the app shell to mount and the results counter or map to appear.
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await humanDelay(2000, 3500);

    // 2. Open the More Filters modal — wait patiently, the button renders after the SPA hydrates.
    const moreFilters = page.locator('button:has-text("More Filters")').first();
    await moreFilters.waitFor({ state: 'visible', timeout: 30000 });
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

    // 8. Open the list panel — clicking on the properties counter opens a right-side list.
    // Fallback: some layouts require clicking the "list" tab. We'll wait for a results
    // panel/list to appear; if not, we return just the count so the caller still gets signal.
    let rows = [];
    try {
      // A tabular list panel is common; try to find rows
      await page.locator('div[role="list"], [class*="ResultList"], [data-testid*="result"]').first()
        .waitFor({ state: 'visible', timeout: 5000 });
      rows = await page.$$eval(
        'div[role="list"] div[role="listitem"], [class*="ResultList"] > div, [data-testid*="result-row"]',
        (nodes) => nodes.slice(0, 25).map((n) => ({
          address: n.querySelector('[data-col="address"], [class*="address"]')?.textContent?.trim() || '',
          city:    n.querySelector('[data-col="city"], [class*="city"]')?.textContent?.trim() || '',
          state:   n.querySelector('[data-col="state"], [class*="state"]')?.textContent?.trim() || '',
          size_sf: Number((n.querySelector('[data-col="size"], [class*="size"]')?.textContent || '').replace(/[^\d]/g, '')) || null,
          owner:   n.querySelector('[data-col="owner"], [class*="owner"]')?.textContent?.trim() || '',
          raw:     n.innerText?.slice(0, 400) || '',
        }))
      );
    } catch (_) { /* list panel didn't open — we still have the count */ }

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

module.exports = { propertyList, ownerDetail, ensureLogin };
