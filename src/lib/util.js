const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Rounds to `d` decimals; non-finite -> null. */
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
/** a / b * 100, null when b is not positive. */
const pct = (a, b, d = 1) => (b > 0 && Number.isFinite(a) ? round((a / b) * 100, d) : null);
const sum = (arr, fn = (x) => x) => arr.reduce((a, x) => a + (Number(fn(x)) || 0), 0);
const avg = (arr) => (arr.length ? sum(arr) / arr.length : null);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const iso = (d) => (d ? new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);
const uniq = (arr) => [...new Set(arr.filter((x) => x !== null && x !== undefined))];
const countBy = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const groupBy = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); (m[k] ||= []).push(x); return m; }, {});
/** Lower-case, no diacritics (Vietnamese đ included): for case/accent-insensitive search. */
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const minor = (m) => (m && Number.isFinite(m.amountMinor) ? m.amountMinor : 0);

module.exports = { escapeRegex, round, pct, sum, avg, clamp, iso, uniq, countBy, groupBy, fold, minor };
