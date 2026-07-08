// ScrapingBee wrapper - renders any URL through their premium proxy with JS execution.
// Handles Akamai/Imperva bot detection. Accepts cookies from our imported sessions.

const fs = require('fs');
const path = require('path');
const https = require('https');

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
const SB_API = 'https://app.scrapingbee.com/api/v1/';

function loadCookies(vendor) {
  const file = path.join(SESSIONS_DIR, `${vendor}.storage.json`);
  if (!fs.existsSync(file)) return '';
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (s.cookies || [])
    .filter((c) => c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join(';');  // ScrapingBee uses ; separated cookies
}

// Fetch a URL through ScrapingBee. Returns { status, body }.
async function scrape({ url, vendor, waitFor, waitBrowser = 'networkidle2', renderJs = true }) {
  const key = process.env.SCRAPINGBEE_API_KEY;
  if (!key) throw new Error('SCRAPINGBEE_API_KEY not set');

  const cookies = vendor ? loadCookies(vendor) : '';
  const params = new URLSearchParams({
    api_key: key,
    url,
    render_js: String(renderJs),
    premium_proxy: 'true',
    country_code: 'us',
    wait_browser: waitBrowser,
    return_page_source: 'true',
  });
  if (cookies) params.set('cookies', cookies);
  if (waitFor) params.set('wait_for', waitFor);

  const fullUrl = SB_API + '?' + params.toString();
  return new Promise((resolve, reject) => {
    const req = https.get(fullUrl, { timeout: 120000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('scrapingbee timeout')); });
  });
}

module.exports = { scrape, loadCookies };
