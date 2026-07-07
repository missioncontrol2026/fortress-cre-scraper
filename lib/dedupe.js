// Fuzzy match helpers used by Reonomy R1 (dedupe vs. CK call list) and
// CoStar C1 (dedupe vs. Interested_Buyers). Kept dependency-free.

function normPhone(p) {
  return String(p || '').replace(/\D+/g, '').slice(-10); // last 10 digits
}
function normAddress(a) {
  return String(a || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\bapt\b|\bapartment\b|\bunit\b|\bste\b|\bsuite\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function normEntity(e) {
  return String(e || '')
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(llc|l\.l\.c|inc|corp|corporation|company|co|partners|lp|llp|trust|the)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein distance-based similarity (0..1). Small, correct, no deps.
function similarity(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
  return 1 - dp[m][n] / Math.max(m, n);
}

// dedupe rows against a haystack. Rows are objects with phone/address/entity fields.
// Returns rows tagged with { _dupe: boolean, _dupeReason: string }.
function tagDupes(rows, haystack, keys = {}) {
  const phoneKey    = keys.phone    || 'phone';
  const addressKey  = keys.address  || 'address';
  const entityKey   = keys.entity   || 'entity';
  const hayPhones   = new Set(haystack.map((h) => normPhone(h[phoneKey])).filter(Boolean));
  const hayAddrs    = haystack.map((h) => normAddress(h[addressKey])).filter(Boolean);
  const hayEntities = haystack.map((h) => normEntity(h[entityKey])).filter(Boolean);

  return rows.map((r) => {
    const p = normPhone(r[phoneKey]);
    if (p && hayPhones.has(p)) return { ...r, _dupe: true, _dupeReason: 'phone_match' };

    const a = normAddress(r[addressKey]);
    if (a && hayAddrs.some((h) => similarity(a, h) >= 0.9))
      return { ...r, _dupe: true, _dupeReason: 'address_match' };

    const e = normEntity(r[entityKey]);
    if (e && hayEntities.some((h) => similarity(e, h) >= 0.8))
      return { ...r, _dupe: true, _dupeReason: 'entity_match_80' };

    return { ...r, _dupe: false };
  });
}

module.exports = { normPhone, normAddress, normEntity, similarity, tagDupes };
