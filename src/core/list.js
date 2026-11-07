/**
 * GET /v1/{resource}?limit=&cursor=&q=&status=&sort=&{field}=a,b  (spec 2.4)
 *   q       case- and accent-insensitive search over code, title/name, short description and status
 *   status  one or more values separated by commas
 *   sort    -updatedAt (default), code, or any stored field; "-" prefix = descending
 *   {field} equality / $in on any stored non-money field (entityCode, propertyCode, unitCode, month ...)
 */
const { present } = require('./present');
const { invalid } = require('../utils/AppError');
const { escapeRegex, fold } = require('../lib/util');
const { getEnv } = require('./env');

const RESERVED = new Set(['q', 'status', 'sort', 'limit', 'cursor', 'from', 'to']);
const SYSTEM_SORT = new Set(['code', 'createdAt', 'updatedAt', 'version']);

const encodeCursor = (offset) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
function decodeCursor(raw) {
  if (!raw) return 0;
  try {
    const { o } = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (Number.isInteger(o) && o >= 0) return o;
  } catch { /* invalid */ }
  throw invalid([{ field: 'cursor', code: 'invalid' }]);
}

const one = (query, key) => {
  const v = query[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw invalid([{ field: key, code: 'invalid_type' }]);
  return v;
};

function cast(f, raw) {
  if (raw === 'null' || raw === '') return null;
  if (['int', 'dec', 'pct'].includes(f.kind)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw invalid([{ field: '', code: 'invalid_type' }]);
    return n;
  }
  if (f.kind === 'bool') return raw === 'true';
  return raw.normalize('NFC');
}

/** Mongo filter for the query (without status when skipStatus). */
function buildFilter(cfg, query, { skipStatus = false } = {}) {
  const and = [];
  const q = one(query, 'q')?.trim();
  if (q) and.push({ search: new RegExp(escapeRegex(fold(q).slice(0, 80))) });
  const status = one(query, 'status');
  if (status !== undefined && !skipStatus) {
    if (!cfg.statusField) throw invalid([{ field: 'status', code: 'unsupported' }]);
    and.push({ [cfg.statusField]: { $in: status.split(',').map((s) => s.trim()).filter(Boolean) } });
  }
  for (const key of Object.keys(query)) {
    if (RESERVED.has(key)) continue;
    const dbKey = cfg.filterMap?.[key];
    const f = cfg.fields[key];
    if (!dbKey && (!f || ['obj', 'list', 'money'].includes(f.kind) || f.hidden)) continue; // unknown keys are ignored
    const values = one(query, key).split(',').map((s) => cast(f || { kind: 'str' }, s.trim()));
    and.push({ [dbKey || key]: values.length > 1 ? { $in: values } : values[0] });
  }
  if (cfg.baseFilter) and.push(cfg.baseFilter);
  return and.length ? { $and: and } : {};
}

function sortSpec(cfg, query) {
  const raw = one(query, 'sort') || '-updatedAt';
  const dir = raw.startsWith('-') ? -1 : 1;
  const key = raw.replace(/^[-+]/, '');
  const f = cfg.fields[key];
  if (!SYSTEM_SORT.has(key) && (!f || ['obj', 'list', 'money'].includes(f.kind) || f.hidden)) throw invalid([{ field: 'sort', code: 'invalid' }]);
  return { key, dir };
}

async function list(cfg, query) {
  const limit = Math.min(100, Math.max(1, parseInt(one(query, 'limit'), 10) || 20));
  const offset = decodeCursor(one(query, 'cursor'));
  const { key, dir } = sortSpec(cfg, query);
  const filter = buildFilter(cfg, query);
  const [docs, total] = await Promise.all([
    cfg.Model.find(filter).sort({ [key]: dir, _id: 1 }).skip(offset).limit(limit).lean(),
    cfg.Model.countDocuments(filter),
  ]);
  const data = await present(cfg, docs, await getEnv());
  const next = offset + docs.length;
  return { data, page: { limit, nextCursor: next < total && docs.length === limit ? encodeCursor(next) : null, total } };
}

/** { total, byStatus } with the same filters as the list (except status). */
async function stats(cfg, query) {
  if (!cfg.statusField) throw invalid([{ field: 'status', code: 'unsupported' }]);
  const filter = buildFilter(cfg, query, { skipStatus: true });
  const rows = await cfg.Model.aggregate([{ $match: filter }, { $group: { _id: `$${cfg.statusField}`, n: { $sum: 1 } } }]);
  const byStatus = {};
  let total = 0;
  for (const r of rows) {
    byStatus[r._id ?? 'none'] = r.n;
    total += r.n;
  }
  return { total, byStatus };
}

module.exports = { list, stats, buildFilter };
