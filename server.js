// Fortress CRE Scraper Service — reproduces all 14 MC scrape workflows.
// Same auth model as the SF proxy: LibreChat sends `Authorization: Bearer <PROXY_API_KEY>`.

const http = require('http');
const url = require('url');

const reonomy = require('./routes/reonomy');
const costar  = require('./routes/costar');

const { PROXY_API_KEY, PORT = 10000 } = process.env;
if (!PROXY_API_KEY) { console.error('PROXY_API_KEY not set'); process.exit(1); }

// tiny helpers
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function requireAuth(req, res) {
  const got = req.headers['authorization'] || '';
  const want = `Bearer ${PROXY_API_KEY}`;
  if (got !== want) { json(res, 401, { error: 'unauthorized' }); return false; }
  return true;
}

// Route → handler mapping. Every route (except /health) requires the Bearer key.
const routes = [
  { method: 'GET',  path: '/health',                 handler: (_req, res) => json(res, 200, { ok: true }) },
  { method: 'GET',  path: '/quota',                  handler: costar.quota },

  // Reonomy
  { method: 'POST', path: '/reonomy/property-list',  handler: reonomy.propertyList },
  { method: 'POST', path: '/reonomy/owner-detail',   handler: reonomy.ownerDetail },

  // CoStar
  { method: 'POST', path: '/costar/buyer-search',    handler: costar.buyerSearch },   // C1/C2/C3 via body.mode (legacy Sale Comps path)
  { method: 'POST', path: '/costar/owner-search',    handler: costar.ownerSearch },   // C1 real — Owners → Companies
  { method: 'POST', path: '/costar/comps',           handler: costar.comps },         // C4
  { method: 'GET',  path: '/costar/property',        handler: costar.propertyLookup },// C5/C6/C7
  { method: 'POST', path: '/costar/property',        handler: costar.propertyLookup },// alt POST form

  // Admin (login refresh + real-browser session import)
  { method: 'POST', path: '/admin/login/costar',              handler: costar.loginCostar },
  { method: 'POST', path: '/admin/login/reonomy',             handler: costar.loginReonomy },
  { method: 'POST', path: '/admin/import-costar-session',     handler: costar.importCostarSession },
];

// Attach Express-style helpers so route handlers can use res.status().json() and res.json().
function decorate(res) {
  res._status = 200;
  res.status = function(n) { res._status = n; return res; };
  res.json = function(body) { json(res, res._status || 200, body); return res; };
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  // CORS: allow the browser-side cookie-import flow from any CoStar tab.
  // Only /admin/import-costar-session ever needs cross-origin — auth is still
  // enforced via the Bearer header regardless of origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const route = routes.find((r) => r.method === req.method && r.path === path);
  decorate(res);

  if (!route)                   return json(res, 404, { error: 'not_found', path });
  if (path !== '/health' && !requireAuth(req, res)) return;

  req.query = parsed.query;
  try {
    req.body = req.method === 'GET' ? {} : await readBody(req);
  } catch (e) {
    return json(res, 400, { error: 'bad_json', message: e.message });
  }

  // Long-running scrapes: give the route up to 90s.
  const timeout = setTimeout(() => {
    if (!res.writableEnded) json(res, 504, { error: 'timeout' });
  }, 90_000);
  try {
    await route.handler(req, res);
  } catch (e) {
    console.error('route error:', e);
    if (!res.writableEnded) json(res, 500, { error: 'internal', message: e.message });
  } finally {
    clearTimeout(timeout);
  }
});

server.listen(PORT, () => console.log(`Fortress scraper listening on ${PORT}`));
