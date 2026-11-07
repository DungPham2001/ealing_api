/** 3.3 Operations: work orders, preventive maintenance, vendors, equipment, utilities, storm plans, renovations, inspections. */
const { define } = require('../core/registry');
const f = require('../core/fields');
const { E } = require('../models/enums');
const { M } = require('../services/calc');
const { addDays, addMonths, diffDays, diffMonths, monthOf, shiftMonth, today } = require('../lib/dates');
const { clamp, round, pct, minor, sum, groupBy } = require('../lib/util');

const { R } = f;
const S = (o) => f.str(120, o);
const D200 = (o) => f.str(200, o);

// ---- Work orders --------------------------------------------------------------------------------
define({
  path: 'work-orders', prefix: 'BT', noun: 'lệnh bảo trì', statusField: 'status', searchFields: ['title', 'description', 'propertyCode', 'unitCode', 'category'],
  fields: {
    propertyCode: f.ref('properties', { required: true, onDelete: 'cascade' }),
    unitCode: f.ref('units', { via: 'propertyCode', onDelete: 'none' }),
    category: f.en(E.WO_CATEGORY, R),
    priority: f.en(E.PRIORITY, { required: true, default: 'normal' }),
    title: S(R),
    description: D200(),
    vendorCode: f.ref('vendors'),
    equipmentCode: f.ref('equipment'),
    estimatedCost: f.money(),
    actualCost: f.money(),
    dueDate: f.date(),
    completedAt: f.date(),
    status: f.en(E.WO_STATUS, { required: true, default: 'new' }),
    sourceType: f.str(20, { readOnly: true, pii: false }),
    sourceCode: f.str(40, { readOnly: true, pii: false }),
  },
  prepare(m, existing, env) {
    if (m.status === 'done') m.completedAt ||= env.today;
    else m.completedAt = null;
  },
  computed: {
    ageDays: (i, c, d, env) => Math.max(0, diffDays((d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : env.today), d.completedAt || env.today)),
    processDays: (i, c, d) => (d.status === 'done' && d.completedAt ? Math.max(0, diffDays(new Date(d.createdAt).toISOString().slice(0, 10), d.completedAt)) : null),
  },
});

// ---- Preventive maintenance ---------------------------------------------------------------------
const nextSeason = (from) => {
  const y = Number(from.slice(0, 4));
  for (const md of ['03-01', '06-01', '09-01', '12-01']) if (`${y}-${md}` > from) return `${y}-${md}`;
  return `${y + 1}-03-01`;
};
const STEP = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
const nextDue = (freq, base) => (freq === 'seasonal' ? nextSeason(base) : addMonths(base, STEP[freq]));

define({
  path: 'pm-schedules', prefix: 'PM', noun: 'lịch bảo trì phòng ngừa', statusField: 'status', searchFields: ['task', 'propertyCode', 'frequency'],
  fields: {
    propertyCode: f.ref('properties', { onDelete: 'cascade' }),
    area: f.en(E.PM_AREA),
    task: f.str(60, { required: true }),
    frequency: f.en(E.PM_FREQ, R),
    lastDoneAt: f.date(),
    firstDueAt: f.date(),
    nextDueAt: f.date({ readOnly: true }),
    vendorCode: f.ref('vendors'),
    status: f.en(E.PM_STATUS, { readOnly: true, default: 'scheduled' }),
  },
  validate: (m) => (!m.propertyCode && !m.area ? [{ field: 'propertyCode', code: 'required' }] : []),
  prepare(m, existing, env) {
    m.nextDueAt = m.lastDoneAt ? nextDue(m.frequency, m.lastDoneAt) : m.firstDueAt || nextDue(m.frequency, env.today);
  },
  async load(docs) {
    const open = await M('work-orders').find({ sourceType: 'pm', sourceCode: { $in: docs.map((d) => d.code) }, status: { $nin: ['done', 'cancelled'] } }, 'sourceCode').lean();
    return { open: new Set(open.map((w) => w.sourceCode)) };
  },
  autoStatus(d, c, env) {
    const lead = env.settings.pmDueLeadDays;
    if (c.open.has(d.code)) return 'in_progress';
    if (d.nextDueAt < env.today) return 'overdue';
    if (d.nextDueAt <= addDays(env.today, lead)) return 'due';
    return d.lastDoneAt && d.lastDoneAt >= addDays(env.today, -7) ? 'done' : 'scheduled';
  },
});

// ---- Vendors ------------------------------------------------------------------------------------
const expiryStatus = (dates, days, env) => {
  const ds = dates.filter(Boolean).sort();
  if (!ds.length) return null;
  if (ds[0] < env.today) return 'expired';
  return diffDays(env.today, ds[0]) <= days ? 'expiring' : 'valid';
};

define({
  path: 'vendors', prefix: 'NT', noun: 'nhà thầu', statusField: 'status', searchFields: ['companyName', 'serviceType', 'city'],
  fields: {
    companyName: S(R),
    serviceType: f.str(40, { required: true }),
    city: f.str(60),
    licenseNo: f.str(40),
    licenseExpiry: f.date(),
    insuranceExpiry: f.date(),
    companyEmail: f.str(120, { contact: true }),
    companyPhone: f.str(30, { contact: true }),
    rating: f.dec({ max: 5, decimals: 1 }),
    status: f.en(E.VENDOR_STATUS, { readOnly: true, default: 'valid' }),
  },
  autoStatus: (d, c, env) => expiryStatus([d.licenseExpiry, d.insuranceExpiry], env.settings.vendorExpiringDays, env) ?? 'valid',
});

// ---- Equipment ----------------------------------------------------------------------------------
define({
  path: 'equipment', prefix: 'TB', noun: 'thiết bị', statusField: 'condition', searchFields: ['kind', 'brand', 'model', 'location', 'propertyCode'],
  fields: {
    propertyCode: f.ref('properties', { required: true, onDelete: 'cascade' }),
    location: f.str(60),
    kind: f.en(E.EQUIP_KIND, R),
    installedAt: f.date(R),
    brand: f.str(40),
    model: f.str(40),
    warrantyEnd: f.date(),
    expectedLifeYears: f.dec({ required: true, min: 0.5, max: 100, decimals: 1 }),
    condition: f.en(E.EQUIP_CONDITION, { required: true, default: 'good' }),
  },
  async load(docs) {
    const rows = await M('work-orders').aggregate([{ $match: { equipmentCode: { $in: docs.map((d) => d.code) } } }, { $group: { _id: '$equipmentCode', n: { $sum: 1 } } }]);
    return { repairs: new Map(rows.map((r) => [r._id, r.n])) };
  },
  computed: {
    ageYears: (i, c, d, env) => round(Math.max(0, diffDays(d.installedAt, env.today)) / 365.25, 1),
    warrantyRemainingMonths: (i, c, d, env) => (d.warrantyEnd ? Math.round(diffMonths(env.today, d.warrantyEnd)) : null),
    replaceYear: (i, c, d) => Math.round(Number(d.installedAt.slice(0, 4)) + d.expectedLifeYears),
    remainingLifePct: (i, c, d, env) => clamp(round((1 - diffDays(d.installedAt, env.today) / 365.25 / d.expectedLifeYears) * 100, 1), 0, 100),
    repairCount: (i, c) => c.repairs.get(i.code) || 0,
  },
});

// ---- Utilities ----------------------------------------------------------------------------------
define({
  path: 'utilities', prefix: 'TI', noun: 'chỉ số tiện ích', statusField: 'status', searchFields: ['kind', 'providerName', 'propertyCode', 'period'],
  fields: {
    propertyCode: f.ref('properties', { required: true, onDelete: 'cascade' }),
    kind: f.en(E.UTILITY_KIND, R),
    providerName: f.str(80),
    period: f.month(R),
    usageValue: f.dec({ required: true, max: 1e9 }),
    usageUnit: f.str(10, { required: true, pii: false }),
    cost: f.money(),
    status: f.en(E.UTILITY_STATUS, { readOnly: true, default: 'normal' }),
  },
  indexes: [[{ propertyCode: 1, kind: 1, period: 1 }, { unique: true }]],
  async load(docs) {
    const props = await M('properties').find({ code: { $in: [...new Set(docs.map((d) => d.propertyCode))] } }, 'code unitCount areaSqm entityCode').lean();
    const keys = docs.flatMap((d) => [shiftMonth(d.period, -1), shiftMonth(d.period, -12)].map((p) => ({ propertyCode: d.propertyCode, kind: d.kind, period: p })));
    const others = keys.length ? await M('utilities').find({ $or: keys }, 'propertyCode kind period usageValue').lean() : [];
    const budgets = await M('budgets').find({ category: 'utilities', entityCode: { $in: props.map((p) => p.entityCode) } }, 'entityCode year amount').lean();
    const entityCosts = await M('utilities').aggregate([
      { $match: { propertyCode: { $in: props.map((p) => p.code) } } },
      { $group: { _id: { p: '$propertyCode', period: '$period' }, minor: { $sum: '$cost.amountMinor' } } },
    ]);
    return {
      props: new Map(props.map((p) => [p.code, p])),
      other: new Map(others.map((o) => [`${o.propertyCode}|${o.kind}|${o.period}`, o])),
      budgets,
      cost: new Map(entityCosts.map((r) => [`${r._id.p}|${r._id.period}`, r.minor])),
    };
  },
  computed: {
    usagePerUnit: (i, c, d) => { const p = c.props.get(d.propertyCode); return p?.unitCount > 0 ? round(d.usageValue / p.unitCount, 2) : null; },
    usagePerAreaSqm: (i, c, d) => { const p = c.props.get(d.propertyCode); return p?.areaSqm > 0 ? round(d.usageValue / p.areaSqm, 3) : null; },
    momPct: (i, c, d) => rise(d, c, shiftMonth(d.period, -1)),
    yoyPct: (i, c, d) => rise(d, c, shiftMonth(d.period, -12)),
    costVsBudgetPct: (i, c, d) => {
      const p = c.props.get(d.propertyCode);
      const b = c.budgets.find((x) => x.entityCode === p?.entityCode && x.year === Number(d.period.slice(0, 4)));
      return b && minor(b.amount) > 0 ? pct(minor(d.cost), minor(b.amount) / 12, 1) : null;
    },
  },
  autoStatus(d, c, env) {
    const m = rise(d, c, shiftMonth(d.period, -1));
    return m !== null && m > env.settings.utilityRisePct ? 'abnormal_rise' : 'normal';
  },
});
function rise(d, c, period) {
  const prev = c.other.get(`${d.propertyCode}|${d.kind}|${period}`);
  return prev && prev.usageValue > 0 ? round(((d.usageValue - prev.usageValue) / prev.usageValue) * 100, 1) : null;
}

// ---- Storm plans --------------------------------------------------------------------------------
const STORM_CHECKLIST = [
  ['before', 'Kiểm tra mái, máng xối và thoát nước'], ['before', 'Cắt tỉa cây gần công trình'], ['before', 'Cố định đồ vật ngoài trời'], ['before', 'Kiểm tra máy phát điện và vật tư khẩn cấp'],
  ['during', 'Tắt các thiết bị điện không cần thiết'], ['during', 'Theo dõi bản tin và cập nhật mức ứng phó'],
  ['after', 'Kiểm tra kết cấu, mái và hệ thống điện nước'], ['after', 'Ghi nhận thiệt hại theo hạng mục'], ['after', 'Tạo lệnh bảo trì cho từng hạng mục hư hỏng'],
].map(([phase, text]) => ({ phase, text, done: false }));

define({
  path: 'storm-plans', prefix: 'BA', noun: 'kế hoạch ứng phó bão', statusField: 'responseLevel', searchFields: ['propertyCode', 'responseLevel'],
  fields: {
    propertyCode: f.ref('properties', { required: true, onDelete: 'cascade' }),
    responseLevel: f.en(E.STORM_LEVEL, { required: true, default: 'normal' }),
    levelSince: f.str(30, { readOnly: true, pii: false }),
    checklist: f.list({ phase: f.en(E.STORM_PHASE, R), text: f.str(120, { required: true }), done: f.bool({ default: false }) }),
    damages: f.list({ category: f.str(40, { required: true }), severity: f.en(E.SEVERITY, R), count: f.int({ required: true, min: 1, max: 100000 }) }),
  },
  indexes: [[{ propertyCode: 1 }, { unique: true }]],
  prepare(m, existing) {
    if (!existing && (!m.checklist || !m.checklist.length)) {
      const { randomUUID } = require('crypto');
      m.checklist = STORM_CHECKLIST.map((c) => ({ ...c, id: randomUUID() }));
    }
    if (!m.damages) m.damages = [];
    if (!existing || m.responseLevel !== existing.responseLevel || !m.levelSince) m.levelSince = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  },
  async load(docs) {
    const wos = await M('work-orders').aggregate([{ $match: { sourceType: 'storm', sourceCode: { $in: docs.map((d) => d.code) } } }, { $group: { _id: '$sourceCode', n: { $sum: 1 } } }]);
    return { wos: new Map(wos.map((r) => [r._id, r.n])) };
  },
  computed: {
    checklistDonePct: (i, c, d) => (d.checklist?.length ? round((d.checklist.filter((x) => x.done).length / d.checklist.length) * 100, 1) : null),
    linkedWorkOrderCount: (i, c) => c.wos.get(i.code) || 0,
  },
});

// ---- Renovation projects ------------------------------------------------------------------------
define({
  path: 'renovation-projects', prefix: 'CT', noun: 'dự án cải tạo', statusField: 'status', searchFields: ['name', 'scope', 'propertyCode', 'unitCode'],
  fields: {
    name: S(R),
    propertyCode: f.ref('properties', { required: true, onDelete: 'cascade' }),
    unitCode: f.ref('units', { via: 'propertyCode', onDelete: 'none' }),
    scope: D200(),
    budget: f.money(),
    actualCost: f.money(),
    vendorCode: f.ref('vendors'),
    startDate: f.date(R),
    expectedEnd: f.date(R),
    progressPct: f.pct({ default: 0 }),
    milestones: f.list({ title: S(R), dueDate: f.date(), done: f.bool({ default: false }) }),
    status: f.en(E.RENO_STATUS, { required: true, default: 'planned' }),
  },
  validate: (m) => (m.startDate && m.expectedEnd && m.expectedEnd < m.startDate ? [{ field: 'expectedEnd', code: 'must_be_after_start' }] : []),
  prepare(m) { m.milestones ||= []; },
  computed: {
    costVsBudgetPct: (i, c, d) => pct(minor(d.actualCost), minor(d.budget), 1),
    milestoneDone: (i, c, d) => (d.milestones || []).filter((x) => x.done).length,
    milestoneTotal: (i, c, d) => (d.milestones || []).length,
  },
});

// ---- Inspections --------------------------------------------------------------------------------
define({
  path: 'inspections', prefix: 'KT', noun: 'lần kiểm tra', statusField: 'result', searchFields: ['propertyCode', 'category', 'result', 'inspectorName'],
  fields: {
    propertyCode: f.ref('properties', { required: true, onDelete: 'cascade' }),
    date: f.date(R),
    inspectorName: f.str(40),
    category: f.en(E.INSPECT_CATEGORY, R),
    result: f.en(E.INSPECT_RESULT, R),
    linkedWorkOrderCode: f.ref('work-orders'),
  },
});

module.exports = { nextDue, expiryStatus, STORM_CHECKLIST };
