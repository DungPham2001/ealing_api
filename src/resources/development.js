/** 3.4 Development & investment: development projects, deals. */
const { define } = require('../core/registry');
const f = require('../core/fields');
const { E } = require('../models/enums');
const { diffDays } = require('../lib/dates');
const { round, pct, minor, avg } = require('../lib/util');

const { R } = f;
const S = (o) => f.str(120, o);

define({
  path: 'development-projects', prefix: 'DA', noun: 'dự án phát triển', statusField: 'stage', searchFields: ['name', 'area', 'productType', 'stage', 'entityCode'],
  fields: {
    name: S(R),
    entityCode: f.ref('entities', { required: true, onDelete: 'restrict' }),
    area: f.str(80, { required: true }),
    productType: f.en(E.DEV_PRODUCT, R),
    plannedUnits: f.int({ required: true }),
    budget: f.money(),
    actualCost: f.money(),
    stage: f.en(E.DEV_STAGE, { required: true, default: 'land_search' }),
    stages: f.list({
      stage: f.en(E.DEV_STAGE, R), plannedDate: f.date(), actualDate: f.date(), progressPct: f.pct({ default: 0 }),
      tasks: f.list({ title: S(R), done: f.bool({ default: false }) }, { max: 100 }),
    }, { max: 8, itemId: false }),
    propertyCode: f.ref('properties', { readOnly: true, onDelete: 'none' }),
  },
  validate: (m) => {
    const keys = (m.stages || []).map((s) => s.stage);
    return new Set(keys).size !== keys.length ? [{ field: 'stages', code: 'duplicate_stage' }] : [];
  },
  prepare(m) { m.stages ||= []; },
  computed: {
    progressPct: (i, c, d) => (d.stages?.length ? round(avg(d.stages.map((s) => s.progressPct ?? 0)), 1) : null),
    delayDays: (i, c, d, env) => {
      const s = (d.stages || []).find((x) => x.stage === d.stage);
      if (!s?.plannedDate) return null;
      if (s.actualDate) return diffDays(s.plannedDate, s.actualDate);
      return Math.max(0, diffDays(s.plannedDate, env.today));
    },
    costVsBudgetPct: (i, c, d) => pct(minor(d.actualCost), minor(d.budget), 1),
  },
});

const DEFAULT_CHECKLIST = E.DEAL_CHECK_KEY.map((key) => ({ key, status: 'todo', note: null }));

define({
  path: 'deals', prefix: 'GD', noun: 'giao dịch đầu tư', statusField: 'stage', searchFields: ['name', 'area', 'assetType', 'source', 'stage'],
  fields: {
    name: S(R),
    kind: f.en(E.DEAL_KIND, R),
    area: f.str(80),
    assetType: f.en(E.PROPERTY_TYPE, R),
    listPrice: f.money(),
    offerPrice: f.money(),
    projectedNoi: f.money(),
    projectedCapRatePct: f.pct(),
    source: f.str(40),
    stage: f.en(E.DEAL_STAGE, { required: true, default: 'screening' }),
    checklist: f.list({ key: f.en(E.DEAL_CHECK_KEY, R), status: f.en(E.CHECK_STATUS, { required: true, default: 'todo' }), note: f.str(120) }, { max: 12, itemId: false }),
    unitCount: f.int({ max: 100000 }),
    propertyCode: f.ref('properties', { readOnly: true, onDelete: 'none' }),
  },
  validate: (m) => {
    const keys = (m.checklist || []).map((c) => c.key);
    return new Set(keys).size !== keys.length ? [{ field: 'checklist', code: 'duplicate_key' }] : [];
  },
  prepare(m, existing) {
    if (!existing && (!m.checklist || !m.checklist.length)) m.checklist = DEFAULT_CHECKLIST.map((c) => ({ ...c }));
    m.checklist ||= [];
  },
  computed: {
    checklistDone: (i, c, d) => (d.checklist || []).filter((x) => x.status === 'done').length,
    checklistTotal: (i, c, d) => (d.checklist || []).length,
    projectedCapRatePct: (i, c, d) => i.projectedCapRatePct ?? pct(minor(d.projectedNoi), minor(d.offerPrice) || minor(d.listPrice), 2),
  },
});

module.exports = { DEFAULT_CHECKLIST };
