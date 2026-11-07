/**
 * create / update / delete of any registered resource. Pipeline:
 * validate body -> prepare (defaults, derived values) -> cross-field rules -> foreign keys -> period lock -> save -> queue sync.
 * Every function takes an optional Mongo `session` so a cascade delete runs in ONE transaction.
 */
const { randomUUID } = require('crypto');
const registry = require('./registry');
const cascade = require('./cascade');
const { normalize } = require('./validate');
const { present } = require('./present');
const { nextCode } = require('./ids');
const { getEnv } = require('./env');
const { notFound, invalid, pii, conflict, locked, AppError } = require('../utils/AppError');
const { isLockedMonth } = require('../services/settings');
const { fold } = require('../lib/util');
const { labelOf } = require('../models/enums');
const queue = require('../services/queue');

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const BASE_NAMES = ['note', 'ownerName', 'createdByName'];

/** Folded text behind `?q=`: code, searchable fields, status value + label. */
function buildSearch(cfg, doc) {
  const parts = [doc.code];
  for (const n of cfg.searchFields) parts.push(doc[n]);
  if (cfg.statusField) {
    const v = doc[cfg.statusField];
    parts.push(v, labelOf(cfg.fields[cfg.statusField].values || [], v));
  }
  return fold(parts.filter((x) => x !== null && x !== undefined).join(' '));
}

async function checkRefs(cfg, merged, names, session) {
  const errors = [];
  for (const r of cfg.refs) {
    const v = merged[r.name];
    if (!names.includes(r.name) || v == null) continue;
    if (r.to === cfg.path && v === merged.code) {
      errors.push({ field: r.name, code: 'self_reference' });
      continue;
    }
    const q = { code: v };
    if (r.via) q[r.via] = merged[r.via];
    if (!(await registry.get(r.to).Model.exists(q).session(session))) errors.push({ field: r.name, code: 'not_found' });
  }
  return errors;
}

function lockCheck(cfg, doc, env) {
  const ym = cfg.periodOf?.(doc);
  if (ym && isLockedMonth(env.settings, ym)) throw locked();
}

/** Applies the auto status (computed from the record + its neighbours) to the document about to be stored. */
async function withAutoStatus(cfg, doc, env) {
  if (!cfg.autoStatus || !cfg.statusField) return;
  const ctx = cfg.load ? await cfg.load([doc], env) : {};
  doc[cfg.statusField] = cfg.autoStatus(doc, ctx, env) ?? doc[cfg.statusField];
}

function throwErrors(errors, piis) {
  if (errors.length) throw invalid(errors);
  if (piis.length) throw pii(piis);
}

async function createRecord(cfg, body, { session = null, env } = {}) {
  env ||= await getEnv();
  const { patch, errors, piis } = normalize(cfg, body, null);
  const merged = { ...patch };
  for (const n of cfg.names) {
    if (merged[n] === undefined) {
      const f = cfg.fields[n];
      merged[n] = f.default !== undefined ? (typeof f.default === 'function' ? f.default() : f.default) : f.kind === 'bool' ? false : null;
    }
  }
  if (!errors.length) {
    await cfg.prepare?.(merged, null, env);
    errors.push(...(cfg.validate?.(merged, null, env) || []));
  }
  if (!errors.length) {
    errors.push(...(await checkRefs(cfg, merged, cfg.writable, session)));
    errors.push(...((await cfg.check?.(merged, { session, env, existing: null })) || []));
  }
  throwErrors(errors, piis);
  lockCheck(cfg, merged, env);

  merged.code = cfg.codeFrom ? cfg.codeFrom(merged) : await nextCode(cfg);
  await withAutoStatus(cfg, merged, env);
  merged.search = buildSearch(cfg, merged);
  const [doc] = await cfg.Model.create([{ _id: randomUUID(), ...merged }], { session });
  const saved = doc.toObject();
  await cfg.afterSave?.(saved, { session, env, existing: null });
  await queue.syncRecord(cfg.path, saved, { session, env });
  return saved;
}

const versionError = async (cfg, doc, env) =>
  conflict('version_conflict', 'Bản ghi đã được người khác thay đổi, hãy tải lại', { current: (await present(cfg, [doc], env))[0] });

/** PATCH: only fields present in `body` change; `version` must be the one the client read. */
async function updateRecord(cfg, id, body, { session = null, env } = {}) {
  env ||= await getEnv();
  const doc = await cfg.Model.findById(id).session(session).lean();
  if (!doc) throw notFound();
  if (!Number.isInteger(body.version)) throw invalid([{ field: 'version', code: 'required' }]);
  if (doc.version !== body.version) throw await versionError(cfg, doc, env);
  lockCheck(cfg, doc, env);

  const { patch, errors, piis } = normalize(cfg, body, doc);
  const merged = { ...doc, ...patch };
  if (!errors.length) {
    await cfg.prepare?.(merged, doc, env);
    errors.push(...(cfg.validate?.(merged, doc, env) || []));
  }
  if (!errors.length) {
    const touched = Object.keys(patch);
    errors.push(...(await checkRefs(cfg, merged, touched, session)));
    errors.push(...((await cfg.check?.(merged, { session, env, existing: doc, touched })) || []));
  }
  throwErrors(errors, piis);
  lockCheck(cfg, merged, env); // cannot move a record into a closed period either

  await withAutoStatus(cfg, merged, env);
  merged.search = buildSearch(cfg, merged);
  const $set = {};
  for (const n of [...cfg.names, ...BASE_NAMES, 'search']) if (!same(merged[n], doc[n])) $set[n] = merged[n];
  if (!Object.keys($set).length) return { doc, changed: false };

  const saved = await cfg.Model.findOneAndUpdate({ _id: id, version: doc.version }, { $set, $inc: { version: 1 } }, { new: true, session }).lean();
  if (!saved) throw await versionError(cfg, await cfg.Model.findById(id).session(session).lean(), env);
  await cfg.afterSave?.(saved, { session, env, existing: doc });
  await queue.syncRecord(cfg.path, saved, { session, env });
  return { doc: saved, changed: true };
}

/** Server-side creation (auto records, copies, conversions): no body validation, same code / status / search / hooks. */
async function createInternal(cfg, values, { session = null, env } = {}) {
  env ||= await getEnv();
  const merged = {};
  for (const n of cfg.names) {
    const f = cfg.fields[n];
    merged[n] = values[n] !== undefined ? values[n] : f.default !== undefined ? (typeof f.default === 'function' ? f.default() : f.default) : f.kind === 'bool' ? false : null;
  }
  for (const n of BASE_NAMES) merged[n] = values[n] ?? null;
  await cfg.prepare?.(merged, null, env);
  merged.code = cfg.codeFrom ? cfg.codeFrom(merged) : await nextCode(cfg);
  await withAutoStatus(cfg, merged, env);
  merged.search = buildSearch(cfg, merged);
  const [doc] = await cfg.Model.create([{ _id: randomUUID(), ...merged }], { session });
  const saved = doc.toObject();
  await cfg.afterSave?.(saved, { session, env, existing: null });
  await queue.syncRecord(cfg.path, saved, { session, env });
  return saved;
}

/** Server-side update of stored fields (state changes by actions / jobs): bumps version, re-runs status, search and hooks. */
async function patchInternal(cfg, doc, changes, { session = null, env } = {}) {
  env ||= await getEnv();
  const merged = { ...doc, ...changes };
  await withAutoStatus(cfg, merged, env);
  merged.search = buildSearch(cfg, merged);
  const $set = {};
  for (const n of [...cfg.names, ...BASE_NAMES, 'search']) if (!same(merged[n], doc[n])) $set[n] = merged[n];
  if (!Object.keys($set).length) return doc;
  const saved = await cfg.Model.findOneAndUpdate({ _id: doc._id }, { $set, $inc: { version: 1 } }, { new: true, session }).lean();
  await cfg.afterSave?.(saved, { session, env, existing: doc });
  await queue.syncRecord(cfg.path, saved, { session, env });
  return saved;
}

/** Plan only: what a delete would remove / unlink / be blocked by. */
async function deleteImpact(cfg, id, { session = null } = {}) {
  const doc = await cfg.Model.findById(id).session(session).lean();
  if (!doc) throw notFound();
  return cascade.impact(await cascade.plan(cfg.path, [doc], session), cfg.path);
}

/** Permanent delete + cascade (spec section 5). */
async function deleteRecord(cfg, id, { session = null, env } = {}) {
  env ||= await getEnv();
  const doc = await cfg.Model.findById(id).session(session).lean();
  if (!doc) throw notFound();
  const p = await cascade.plan(cfg.path, [doc], session);
  cascade.assertNotBlocked(p);
  for (const [path, docs] of p.removed) {
    const c = registry.get(path);
    if (c.periodOf) for (const d of docs.values()) lockCheck(c, d, env);
  }
  await cascade.execute(p, session);
  for (const [path, docs] of p.removed) {
    const c = registry.get(path);
    if (c.afterDelete) await c.afterDelete([...docs.values()], { session, env });
  }
  return cascade.impact(p, cfg.path);
}

module.exports = { createInternal, patchInternal, createRecord, updateRecord, deleteRecord, deleteImpact, buildSearch, withAutoStatus, AppError };
