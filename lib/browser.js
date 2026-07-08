// Anti-detect browser + persistent-session helpers.
// Uses patchright (Playwright fork with runtime-detection patches) to bypass
// Akamai / Cloudflare bot fingerprinting.
//
// Design note (2026-07-07): initially tried caching one persistent context per vendor
// for efficiency, but Akamai flagged repeat-use pages as bot. Switched to FRESH
// persistent context per newPage() call, sharing only the userDataDir so cookies
// persist. ~3s overhead per call but reliable stealth.

const { chromium } = require('patchright');
const { relay }   = require('./proxyRelay');
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Single long-lived local relay to IPRoyal. Bring it up on first getContext()
// call and reuse. IPRoyal accepts many concurrent tunnels through a single auth.
// One long-lived relay + one long-lived session id per vendor. This means all
// scrape calls for a given vendor route through the SAME residential IP for
// the full session-lifetime window (30 min), so Akamai/Imperva see a coherent
// browsing session instead of a rotating fleet of bots.
const relayByVendor = new Map();
const sessionByVendor = new Map();
function vendorSessionId(vendor) {
  if (!sessionByVendor.has(vendor)) {
    sessionByVendor.set(vendor, `${vendor}${Math.random().toString(36).slice(2, 10)}`);
  }
  return sessionByVendor.get(vendor);
}
async function ensureAnonProxy(vendor = 'default') {
  const { PROXY_HOST, PROXY_USERNAME, PROXY_PASSWORD } = process.env;
  if (!(PROXY_HOST && PROXY_USERNAME && PROXY_PASSWORD)) return null;
  if (relayByVendor.has(vendor)) return relayByVendor.get(vendor);
  const [host, portStr] = PROXY_HOST.split(':');
  const sid = vendorSessionId(vendor);
  // IPRoyal residential sticky-session syntax on the username
  const stickyUser = `${PROXY_USERNAME}_country-us_session-${sid}_lifetime-30m`;
  const p = relay({
    upstreamHost: host,
    upstreamPort: Number(portStr) || 80,
    upstreamUser: stickyUser,
    upstreamPass: PROXY_PASSWORD,
  }).then(({ url }) => { relayByVendor.set(vendor, url); return url; });
  relayByVendor.set(vendor, p);
  return p;
}

// Fresh context per call — no cache. Cookies persist via userDataDir on disk.
// Sticky-session helper for IPRoyal residential proxies.
// IPRoyal username format: <base>_country-us_session-<id>_lifetime-30m (UNDERSCORES not dashes).
// Same session id = same IP for 30 min.
function stickyUsername(base, vendor) {
  const sessionId = `${vendor}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `${base}_country-us_session-${sessionId}_lifetime-30m`;
}

async function getContext(vendor) {
  const userDataDir = path.join(SESSIONS_DIR, `${vendor}-userdata`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const { PROXY_HOST, PROXY_USERNAME, PROXY_PASSWORD } = process.env;
  const launchOpts = {
    channel: 'chromium',
    headless: true,
    viewport: null,
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  };
  const anon = await ensureAnonProxy(vendor);
  if (anon) {
    launchOpts.proxy = { server: anon };
  }

  const ctx = await chromium.launchPersistentContext(userDataDir, launchOpts);
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
