// Anti-detect browser + persistent-session helpers.
// Uses patchright (Playwright fork with runtime-detection patches) to bypass
// Akamai / Cloudflare bot fingerprinting.
//
// Design note (2026-07-07): initially tried caching one persistent context per vendor
// for efficiency, but Akamai flagged repeat-use pages as bot. Switched to FRESH
// persistent context per newPage() call, sharing only the userDataDir so cookies
// persist. ~3s overhead per call but reliable stealth.

const { chromium } = require('patchright');
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Fresh context per call — no cache. Cookies persist via userDataDir on disk.
async function getContext(vendor) {
  const userDataDir = path.join(SESSIONS_DIR, `${vendor}-userdata`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: null,
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });
  return ctx;
}

async function getBrowser() {
  const ctx = await getContext('_default');
  return ctx.browser();
}

// saveState is a no-op now that we use launchPersistentContext with a userDataDir
// on the Render Disk — cookies + localStorage persist across process restarts
// automatically. Kept as a callable so callers don't have to change.
async function saveState(_vendor) {
  return;
}

// newPage() returns a page AND its owning context, wrapped so callers can close
// the context after they're done (fresh context per call = anti-bot stealth).
// Route handlers can call `await page.close()` OR `await page.context().close()`.
async function newPage(vendor) {
  const ctx = await getContext(vendor);
  const page = await ctx.newPage();
  // Auto-close context when page closes so we don't leak Chromium processes.
  page.once('close', () => { ctx.close().catch(() => {}); });
  return page;
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
