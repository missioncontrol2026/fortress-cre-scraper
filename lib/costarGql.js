// CoStar GraphQL client using impers (curl-impersonate Node binding).
// Combines Chrome-124 TLS fingerprint + IPRoyal residential proxy + imported
// cookies + CoStar's cs-owners-formatting-prefs JWT to defeat Akamai and
// hit CoStar's application GraphQL directly. Same wire format the real SPA uses.

const fs           = require('fs');
const path         = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
const CURL_BIN = process.env.CURL_IMPERSONATE_BIN || '/usr/local/bin/curl_chrome116';

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

// Post to any CoStar GraphQL endpoint via curl-impersonate (Chrome-124 TLS
// fingerprint) through the residential proxy with the imported cookies + JWT.
async function graphql({ endpoint, query, variables, operationName }) {
  const cookie = loadCookies('costar');
  const extras = loadExtraHeaders('costar');
  const proxy  = proxyUrl();
  const body   = JSON.stringify({ query, variables, operationName });

  const args = [
    '-s',                                // silent
    '-w', '%{http_code}',                // append status code at end of output
    '--max-time', '30',
    '-H', 'Content-Type: application/json',
    '-H', 'Accept: */*',
    '-H', `Cookie: ${cookie}`,
    '-H', 'Referer: https://product.costar.com/suiteapps/owners/companies?new_search=true',
    '-H', 'Origin: https://product.costar.com',
  ];
  for (const [k, v] of Object.entries(extras)) {
    args.push('-H', `${k}: ${v}`);
  }
  if (proxy) args.push('-x', proxy);
  args.push('--data-raw', body, endpoint);

  const { stdout } = await execFileP(CURL_BIN, args, { maxBuffer: 50 * 1024 * 1024 });
  // curl -w '%{http_code}' appends the status code at the end
  const status = Number(stdout.slice(-3));
  const text   = stdout.slice(0, -3);
  return { status, text };
}

module.exports = { graphql };
