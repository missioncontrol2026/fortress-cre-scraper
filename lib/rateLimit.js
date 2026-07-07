// Per-vendor rate limits so we don't torch a paid seat.
// Defaults come from the SPEC.md caps (CoStar 500 exports/mo; Reonomy uncapped).

const fs = require('fs');
const path = require('path');

const STATE_PATH = process.env.RATE_STATE_PATH || '/app/sessions/rate.json';

const LIMITS = {
  costar: {
    perMinute: 4,      // never more than one search every ~15s (human pace)
    perHour: 30,
    perDay: 60,
    perMonth: 400,     // stay under 500 export cap w/ 100 headroom
  },
  reonomy: {
    perMinute: 6,
    perHour: 60,
    perDay: 200,
    perMonth: 3000,
  },
};

function load() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function save(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s)); }

function windowStart(period) {
  const d = new Date();
  if (period === 'perMinute') return `${d.toISOString().slice(0, 16)}`; // minute
  if (period === 'perHour')   return `${d.toISOString().slice(0, 13)}`; // hour
  if (period === 'perDay')    return `${d.toISOString().slice(0, 10)}`; // day
  if (period === 'perMonth')  return `${d.toISOString().slice(0, 7)}`;  // month
  return 'x';
}

function currentUsage(vendor) {
  const s = load();
  const v = s[vendor] || {};
  const out = {};
  for (const period of Object.keys(LIMITS[vendor] || {})) {
    const key = windowStart(period);
    out[period] = (v[period] && v[period][key]) || 0;
  }
  return out;
}

function tryConsume(vendor) {
  const limits = LIMITS[vendor];
  if (!limits) return { ok: true };
  const s = load();
  const v = s[vendor] || {};

  const wantedKeys = {};
  for (const period of Object.keys(limits)) {
    const key = windowStart(period);
    wantedKeys[period] = key;
    const used = (v[period] && v[period][key]) || 0;
    if (used >= limits[period]) {
      return { ok: false, blockedBy: period, used, limit: limits[period] };
    }
  }
  for (const period of Object.keys(limits)) {
    const key = wantedKeys[period];
    v[period] = { [key]: ((v[period] && v[period][key]) || 0) + 1 };
  }
  s[vendor] = v;
  save(s);
  return { ok: true, usage: currentUsage(vendor), limits };
}

module.exports = { tryConsume, currentUsage, LIMITS };
