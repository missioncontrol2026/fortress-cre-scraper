// CoStar GraphQL client using impers (curl-impersonate Node binding).
// Combines Chrome-124 TLS fingerprint + IPRoyal residential proxy + imported
// cookies + CoStar's cs-owners-formatting-prefs JWT to defeat Akamai and
// hit CoStar's application GraphQL directly. Same wire format the real SPA uses.

const fs   = require('fs');
const path = require('path');

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';

let impersModule = null;
async function getImpers() {
  if (impersModule) return impersModule;
  impersModule = await import('impers');
  return impersModule;
}

function loadCookies(vendor) {
  const file = path.join(SESSIONS_DIR, `${vendor}.storage.json`);
  if (!fs.existsSync(file)) return '';
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (s.cookies || [])
    .filter((c) => c.domain && (c.domain.includes('costar.com') || c.domain.startsWith('.')))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function loadExtraHeaders(vendor) {
  const file = path.join(SESSIONS_DIR, `${vendor}.headers.json`);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function proxyUrl() {
  const { PROXY_HOST, PROXY_USERNAME, PROXY_PASSWORD } = process.env;
  if (!(PROXY_HOST && PROXY_USERNAME && PROXY_PASSWORD)) return null;
  // Optional: append a sticky session tag so all requests come from the same IP
  const sid = process.env.PROXY_STICKY_ID || 'default';
  const stickyUser = `${PROXY_USERNAME}_country-us_session-${sid}_lifetime-30m`;
  return `http://${stickyUser}:${PROXY_PASSWORD}@${PROXY_HOST}`;
}

// Post to any CoStar GraphQL endpoint with the right disguise
async function graphql({ endpoint, query, variables, operationName }) {
  const { request } = await getImpers();
  const cookie = loadCookies('costar');
  const extras = loadExtraHeaders('costar');
  const proxy  = proxyUrl();
  const headers = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Cookie': cookie,
    'Referer': 'https://product.costar.com/suiteapps/owners/companies?new_search=true',
    'Origin': 'https://product.costar.com',
    ...extras,
  };
  const body = JSON.stringify({ query, variables, operationName });
  const r = await request('POST', endpoint, {
    impersonate: 'chrome124',
    proxy,
    headers,
    body,
  });
  return { status: r.status, text: r.text || '', headers: r.headers };
}

module.exports = { graphql };
