// Playwright browser + persistent-session helpers.
// One long-lived browser per process; each vendor gets its own persistent context
// (separate storage state) so CoStar cookies don't clobber Reonomy and vice versa.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

let browser = null;
const contexts = new Map(); // vendor → BrowserContext

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  return browser;
}

// Get a persistent context for a vendor. State is saved to disk after every
// authenticated action so 2FA only happens once.
async function getContext(vendor) {
  if (contexts.has(vendor)) return contexts.get(vendor);
  const b = await getBrowser();
  const storageStatePath = path.join(SESSIONS_DIR, `${vendor}.storage.json`);
  const storageState = fs.existsSync(storageStatePath) ? storageStatePath : undefined;

  const ctx = await b.newContext({
    storageState,
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Chicago',
  });
  contexts.set(vendor, ctx);
  return ctx;
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
