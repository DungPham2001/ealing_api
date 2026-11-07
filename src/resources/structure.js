/** 3.1 Structure & catalog: entities, asset classes, intercompany ledger, exit plans. */
const { randomUUID } = require('crypto');
const { define, get } = require('../core/registry');
const f = require('../core/fields');
const { E } = require('../models/enums');
const { M, propertyKpis, cashRows } = require('../services/calc');
const { pct, round, sum, minor } = require('../lib/util');
const { shiftMonth, monthOf } = require('../lib/dates');
const { nextCode } = require('../core/ids');
const { buildSearch } = require('../core/record');

const { R } = f;
const S = (o) => f.str(120, o);

// ---- Entities -----------------------------------------------------------------------------------
define({
  path: 'entities', prefix: 'PN', codeStyle: 'letter', noun: 'pháp nhân', statusField: 'status', searchFields: ['type', 'state', 'purpose'],
  fields: {
    type: f.en(E.ENTITY_TYPE, R),
    state: f.str(2, { required: true, pattern: /^[A-Z]{2}$/, pii: false }),
    purpose: f.en(E.ENTITY_PURPOSE, R),
    formedAt: f.date(R),
    status: f.en(E.ENTITY_STATUS, { required: true, default: 'active' }),
    parentCode: f.ref('entities', { onDelete: 'restrict' }),
    parentOwnershipPct: f.pct(),
  },
  async load(docs) {
    const codes = docs.map((d) => d.code);
    const [props, projects] = await Promise.all([
      M('properties').aggregate([{ $match: { entityCode: { $in: codes } } }, { $group: { _id: '$entityCode', n: { $sum: 1 } } }]),
      M('development-projects').aggregate([{ $match: { entityCode: { $in: codes } } }, { $group: { _id: '$entityCode', n: { $sum: 1 } } }]),
    ]);
    return { props: new Map(props.map((r) => [r._id, r.n])), projects: new Map(projects.map((r) => [r._id, r.n])) };
  },
  computed: {
    propertyCount: (i, c) => c.props.get(i.code) || 0,
    projectCount: (i, c) => c.projects.get(i.code) || 0,
  },
  prepare(m) {
    if (!m.parentCode) m.parentOwnershipPct = null;
  },
  /** No parent-child cycles. */
  async check(m, { session, existing }) {
    if (!m.parentCode || !existing) return [];
    let cur = m.parentCode;
    for (let i = 0; i < 50 && cur; i++) {
      if (cur === existing.code) return [{ field: 'parentCode', code: 'cycle' }];
      cur = (await M('entities').findOne({ code: cur }, 'parentCode').session(session).lean())?.parentCode;
    }
    return [];
  },
});

// ---- Asset classes ------------------------------------------------------------------------------
const assetClasses = define({
  path: 'asset-classes', prefix: 'DM', noun: 'nhóm tài sản', statusField: 'status', searchFields: ['classKey', 'entityCode'],
  fields: {
    classKey: f.en(E.CLASS_KEY, R),
    entityCode: f.ref('entities'),
    estimatedValue: f.money(R),
    valueUpdatedAt: f.date({ default: () => require('../lib/dates').today() }),
    targetWeightPct: f.pct(R),
    toleranceBandPct: f.pct({ default: 0 }),
    status: f.en(E.CLASS_STATUS, { readOnly: true, default: 'within' }),
  },
  // actual weight = value / sum of ALL asset-class values; liquidity = cash equivalents / average monthly outflow
  async load(docs, env) {
    const all = await assetClasses.Model.find({}, 'estimatedValue').lean();
    const from = shiftMonth(monthOf(env.today), -2);
    const rows = await cashRows({ from, to: monthOf(env.today) });
    const out = rows.filter((r) => r.direction === 'expense');
    const byEntity = new Map();
    for (const r of out) byEntity.set(r.entityCode, (byEntity.get(r.entityCode) || 0) + r.minor);
    return { total: sum(all, (a) => minor(a.estimatedValue)), monthlyOutflow: (entity) => (entity ? byEntity.get(entity) || 0 : sum(out, (r) => r.minor)) / 3 };
  },
  autoStatus(d, c) {
    const dev = Math.abs((pct(minor(d.estimatedValue), c.total, 2) ?? 0) - (d.targetWeightPct ?? 0));
    const band = d.toleranceBandPct ?? 0;
    return dev <= band ? 'within' : dev <= band * 2 || dev <= 1 ? 'slight' : 'high';
  },
  computed: {
    actualWeightPct: (i, c, d) => pct(minor(d.estimatedValue), c.total, 1),
    deviationPts: (i, c, d) => (c.total > 0 ? round((minor(d.estimatedValue) / c.total) * 100 - (d.targetWeightPct ?? 0), 1) : null),
    liquidityMonths: (i, c, d) => {
      if (d.classKey !== 'cash_equivalent') return undefined;
      const out = c.monthlyOutflow(d.entityCode);
      return out > 0 ? round(minor(d.estimatedValue) / out, 1) : null;
    },
  },
});

// ---- Intercompany ledger ------------------------------------------------------------------------
const intercompany = define({
  path: 'intercompany-entries', prefix: 'NB', noun: 'giao dịch nội bộ', searchFields: ['creditEntityCode', 'debitEntityCode', 'txnType', 'description'],
  fields: {
    creditEntityCode: f.ref('entities', { required: true, onDelete: 'restrict' }),
    debitEntityCode: f.ref('entities', { required: true, onDelete: 'restrict' }),
    txnType: f.en(E.IC_TXN, R),
    date: f.date(R),
    amount: f.money(R),
    description: f.str(80),
    counterpartConfirmed: f.bool({ readOnly: true }),
    isCounterpart: f.bool({ readOnly: true }),
    pairKey: f.str(64, { readOnly: true, hidden: true }),
  },
  indexes: [[{ pairKey: 1 }]],
  validate: (m) => (m.creditEntityCode && m.creditEntityCode === m.debitEntityCode ? [{ field: 'debitEntityCode', code: 'must_differ' }] : []),
  prepare(m, existing) {
    if (!existing) m.pairKey = randomUUID();
  },
  /** Both sides of a pair go together. */
  async siblings(docs, session) {
    const keys = docs.map((d) => d.pairKey).filter(Boolean);
    return keys.length ? M('intercompany-entries').find({ pairKey: { $in: keys } }).session(session).lean() : docs;
  },
  /** Writing one side creates the counterpart entry, which the other side confirms by entering its own amount. */
  async afterSave(doc, { session, existing }) {
    const Model = M('intercompany-entries');
    if (doc.isCounterpart) return;
    if (!existing) {
      const mirror = { _id: randomUUID(), creditEntityCode: doc.creditEntityCode, debitEntityCode: doc.debitEntityCode, txnType: doc.txnType, date: doc.date, description: doc.description, amount: null, counterpartConfirmed: false, isCounterpart: true, pairKey: doc.pairKey };
      mirror.code = await nextCode(intercompany);
      mirror.search = buildSearch(intercompany, mirror);
      await Model.create([mirror], { session });
    } else {
      const $set = { creditEntityCode: doc.creditEntityCode, debitEntityCode: doc.debitEntityCode, txnType: doc.txnType, date: doc.date, description: doc.description };
      await Model.updateOne({ pairKey: doc.pairKey, isCounterpart: true }, { $set, $inc: { version: 1 } }, { session });
    }
  },
});

/** Reconciliation figures per directed entity pair, optionally limited to a month / entity. */
async function intercompanyPairs({ month, entityCode } = {}) {
  const q = {};
  if (month) q.date = { $gte: `${month}-01`, $lte: `${month}-31` };
  if (entityCode) q.$or = [{ creditEntityCode: entityCode }, { debitEntityCode: entityCode }];
  const docs = await M('intercompany-entries').find(q).lean();
  const mirrors = new Map(docs.filter((d) => d.isCounterpart).map((d) => [d.pairKey, d]));
  const groups = new Map();
  for (const d of docs.filter((x) => !x.isCounterpart)) {
    const key = `${d.creditEntityCode}|${d.debitEntityCode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const short = (c) => c.replace(/^PN-/, '');
  return [...groups.entries()].map(([key, list]) => {
    const [credit, debit] = key.split('|');
    const confirmed = list.filter((d) => mirrors.get(d.pairKey)?.counterpartConfirmed);
    const total = sum(confirmed, (d) => minor(d.amount));
    const diff = sum(confirmed, (d) => Math.abs(minor(d.amount) - minor(mirrors.get(d.pairKey).amount)));
    const pending = list.length - confirmed.length;
    const deviationPct = total > 0 ? round((diff / total) * 100, 1) : 0;
    return {
      code: `SC-${short(credit)}${short(debit)}`,
      creditEntityCode: credit, debitEntityCode: debit,
      txnTypes: [...new Set(list.map((d) => d.txnType))],
      reconcileStatus: pending > 0 || deviationPct > 0 ? 'mismatch' : 'match',
      deviationPct, pendingConfirmCount: pending, txnCount: list.length,
      lastDate: list.map((d) => d.date).sort().pop(),
    };
  });
}

// ---- Exit plans ---------------------------------------------------------------------------------
define({
  path: 'exit-plans', prefix: 'TV', noun: 'kế hoạch thoái vốn', statusField: 'lifecycleStage', searchFields: ['propertyCode', 'strategy', 'lifecycleStage'],
  fields: {
    propertyCode: f.ref('properties', { required: true, onDelete: 'cascade' }),
    strategy: f.en(E.EXIT_STRATEGY, R),
    holdYears: f.dec({ required: true, max: 100 }),
    targetExitYear: f.year(R),
    trigger: f.obj({ metric: f.en(E.TRIGGER_METRIC, R), op: f.en(E.TRIGGER_OP, R), valuePct: f.pct(R) }),
    priority: f.int({ required: true, min: 1, max: 1000 }),
    lifecycleStage: f.en(E.EXIT_STAGE, { required: true, default: 'new' }),
  },
  indexes: [[{ propertyCode: 1 }, { unique: true }]],
  async load(docs, env) {
    return { kpis: await propertyKpis(docs.map((d) => d.propertyCode), env) };
  },
  computed: {
    triggerMet: (i, c, d) => {
      const t = d.trigger;
      const k = c.kpis.get(d.propertyCode);
      const v = t && k ? (t.metric === 'cap_rate' ? k.capRatePct : k.ltvPct) : null;
      return v === null || v === undefined ? false : t.op === 'gte' ? v >= t.valuePct : v <= t.valuePct;
    },
  },
});

module.exports = { intercompanyPairs };
