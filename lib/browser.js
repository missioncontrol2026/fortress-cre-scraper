// Anti-detect browser + persistent-session helpers.
// Uses patchright (Playwright fork with runtime-detection patches) to bypass
// Akamai / Cloudflare bot fingerprinting. Same API as playwright.
// One persistent-context per vendor (isolates CoStar cookies from Reonomy).

const { chromium } = require('patchright');
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// patchright works best with launchPersistentContext (no separate Browser + Context —
// a single persistent context is what real browsers look like at the CDP level).
const contexts = new Map(); // vendor → BrowserContext

// Get a persistent context for a vendor. State is saved to disk after every
// authenticated action so login only happens once until CoStar rotates the session.
async function getContext(vendor) {
  if (contexts.has(vendor)) return contexts.get(vendor);
  const userDataDir = path.join(SESSIONS_DIR, `${vendor}-userdata`);
  fs.mkdirSync(userDataDir, { recursive: true });

  // patchright-recommended launch: no automation flags, real channel, no viewport override.
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',           // patchright's stealth channel
    headless: true,
    viewport: null,                // let the page size itself — no automation-signal viewport
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
    // Legacy storage_state.json still supported as a fallback for imported cookies
    storageState: (() => {
      const p = path.join(SESSIONS_DIR, `${vendor}.storage.json`);
      return fs.existsSync(p) ? p : undefined;
    })(),
  });
  contexts.set(vendor, ctx);
  return ctx;
}

// Kept for compat with any code that called getBrowser().
// With persistent context, there is no separate browser handle — return the
// context's browser reference for anything that still needs one.
async function getBrowser() {
  const ctx = await getContext('_default');
  return ctx.browser();
}

async function saveState(vendor) {
  if (!contexts.has(vendor)) return;
  const storageStatePath = path.join(SESSIONS_DIR, `${vendor}.storage.json`);
  await contexts.get(vendor).storageState({ path: storageStatePath });
}

async function newPage(vendor) {
  const ctx = await getContext(vendor);
  return ctx.newPage();
}

// Human-like delay. Every scrape step calls this at least once.
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function humanDelay(min = 800, max = 2200) {
  const ms = Math.floor(min + Math.random() * (max - min));
  return sleep(ms);
}

module.exports = {
  getBrowser,
  getContext,
  newPage,
  saveState,
  humanDelay,
  sleep,
  SESSIONS_DIR,
};
