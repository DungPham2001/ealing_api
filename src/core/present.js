/**
 * Stored record -> API record (spec 2.6): id, code, version, business fields, 🧮 computed fields, timestamps.
 * Money fields are WRITE-ONLY: they are never part of the output. `status` mirrors the resource's status field
 * (stage / step / responseLevel ...), so every record has one.
 */
const { iso } = require('../lib/util');
const { getEnv } = require('./env');

function fromStore(cfg, doc) {
  const out = {};
  for (const n of cfg.names) {
    const f = cfg.fields[n];
    if (f.kind === 'money' || f.hidden) continue;
    const v = doc[n] ?? null;
    out[n] = f.kind === 'bool' ? !!v : v;
  }
  return out;
}

async function present(cfg, docs, env) {
  env ||= await getEnv();
  const ctx = cfg.load ? await cfg.load(docs, env) : {};
  return docs.map((d) => {
    const item = { id: String(d._id), code: d.code, version: d.version ?? 1, ...fromStore(cfg, d) };
    if (cfg.autoStatus && cfg.statusField) item[cfg.statusField] = cfg.autoStatus(d, ctx, env) ?? item[cfg.statusField];
    if (cfg.statusField && cfg.statusField !== 'status') item.status = item[cfg.statusField];
    item.note = d.note ?? null;
    item.ownerName = d.ownerName ?? null;
    item.createdByName = d.createdByName ?? null;
    for (const [k, fn] of Object.entries(cfg.computed)) item[k] = fn(item, ctx, d, env) ?? null;
    item.createdAt = iso(d.createdAt);
    item.updatedAt = iso(d.updatedAt);
    return item;
  });
}

module.exports = { present, fromStore };
