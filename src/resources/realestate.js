/** 3.2 Real estate: properties, property records, units, leases, rent collections, leasing funnel. */
const { define } = require('../core/registry');
const f = require('../core/fields');
const { E } = require('../models/enums');
const { M, propertyKpis, unitStats, occupancyOf, leaseStatus } = require('../services/calc');
const { createInternal } = require('../core/record');
const income = require('../services/income');
const { diffDays, diffMonths, monthOf, today } = require('../lib/dates');
const { clamp, round, minor, groupBy } = require('../lib/util');

const { R } = f;
const S = (o) => f.str(120, o);
const ZIP = /^\d{5}(-\d{4})?$/;

// ---- Properties ---------------------------------------------------------------------------------
/** Default document checklist per property type (spec 3.2): created with the property, status missing. */
const DOC_TEMPLATE = {
  multifamily: ['title', 'survey', 'inspection_report', 'environmental', 'insurance', 'building_permit', 'contractor_contract', 'drawings'],
  mixed: ['title', 'survey', 'inspection_report', 'environmental', 'insurance', 'building_permit', 'contractor_contract', 'drawings'],
  commercial: ['title', 'survey', 'inspection_report', 'environmental', 'insurance', 'building_permit', 'contractor_contract', 'drawings'],
  single_family: ['title', 'survey', 'inspection_report', 'insurance', 'building_permit'],
  land: ['title', 'survey', 'environmental', 'insurance', 'building_permit', 'drawings'],
};

define({
  path: 'properties', prefix: 'TS', noun: 'tài sản', statusField: 'status', searchFields: ['name', 'type', 'city', 'zip', 'entityCode'],
  fields: {
    name: S(R),
    type: f.en(E.PROPERTY_TYPE, R),
    entityCode: f.ref('entities', { required: true, onDelete: 'restrict' }),
    city: f.str(60, { required: true }),
    zip: f.str(10, { required: true, pattern: ZIP, pii: false }),
    fullAddress: f.str(160),
    yearBuilt: f.year(),
    areaSqm: f.dec({ max: 1e8 }),
    unitCount: f.int({ required: true }),
    purchasePrice: f.money(),
    purchaseDate: f.date(),
    estimatedValue: f.money(),
    status: f.en(E.PROPERTY_STATUS, { required: true, default: 'owned' }),
  },
  // residential properties with residents: city + ZIP only; a full address only for commercial / land
  validate: (m) => (m.fullAddress && !['commercial', 'land'].includes(m.type) ? [{ field: 'fullAddress', code: 'not_allowed' }] : []),
  async load(docs, env) {
    const codes = docs.map((d) => d.code);
    const [units, kpis] = await Promise.all([unitStats(codes), propertyKpis(codes, env)]);
    return { units, kpis };
  },
  computed: {
    occupancyPct: (i, c) => occupancyOf(c.units.get(i.code)),
    noiMarginPct: (i, c) => c.kpis.get(i.code)?.noiMarginPct ?? null,
    vacantCount: (i, c) => c.units.get(i.code)?.vacant ?? 0,
    unitMap: (i, c) => c.units.get(i.code)?.map ?? '',
  },
  async afterSave(doc, { session, env, existing }) {
    if (existing) return;
    const Rec = require('../core/registry').get('property-records');
    for (const docType of DOC_TEMPLATE[doc.type] || []) await createInternal(Rec, { propertyCode: doc.code, docType, status: 'missing' }, { session, env });
  },
});

// ---- Property records ---------------------------------------------------------------------------
define({
  path: 'property-records', prefix: 'HS', noun: 'hồ sơ tài sản', statusField: 'status', searchFields: ['propertyCode', 'docType', 'storageNote'],
  fields: {
    propertyCode: f.ref('properties', { required: true, onDelete: 'cascade' }),
    docType: f.en(E.DOC_TYPE, R),
    status: f.en(E.DOC_STATUS, { required: true, default: 'missing' }),
    docDate: f.date(),
    storageNote: f.str(120),
  },
  indexes: [[{ propertyCode: 1, docType: 1 }, { unique: true }]],
  // general description of where it is kept: never a path, link or password
  validate: (m) => (m.storageNote && /[\\/]|https?:|www\.|password|mật khẩu|mat khau/i.test(m.storageNote) ? [{ field: 'storageNote', code: 'not_allowed' }] : []),
});

/** GET /property-records/summary: completeness per property. */
async function recordSummary({ propertyCode } = {}) {
  const docs = await M('property-records').find(propertyCode ? { propertyCode } : {}, 'propertyCode status docDate').lean();
  return Object.entries(groupBy(docs, (d) => d.propertyCode)).map(([code, list]) => {
    const present = list.filter((d) => d.status === 'present').length;
    const missing = list.filter((d) => d.status === 'missing').length;
    const needsUpdate = list.filter((d) => d.status === 'needs_update').length;
    return {
      propertyCode: code, total: list.length, present, missing, needsUpdate,
      completenessPct: list.length ? round((present / list.length) * 100, 1) : null,
      status: missing > 0 ? 'missing' : needsUpdate > 0 ? 'needs_update' : 'complete',
      lastDocDate: list.map((d) => d.docDate).filter(Boolean).sort().pop() ?? null,
    };
  });
}

// ---- Units --------------------------------------------------------------------------------------
define({
  path: 'units', prefix: 'DV', noun: 'đơn vị cho thuê', statusField: 'status', codeScope: 'propertyCode', searchFields: ['unitCode', 'propertyCode', 'type'],
  codeFrom: (m) => m.unitCode,
  fields: {
    propertyCode: f.ref('properties', { required: true, immutable: true, onDelete: 'cascade' }),
    unitCode: f.str(20, { required: true, immutable: true, pii: false, pattern: /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/ }),
    type: f.str(30, { required: true }),
    areaSqm: f.dec({ required: true, max: 1e6 }),
    bedrooms: f.int({ max: 50 }),
    bathrooms: f.dec({ max: 50 }),
    listedRent: f.money(),
    vacantSince: f.date(),
    status: f.en(E.UNIT_STATUS, { required: true, default: 'vacant' }),
  },
  prepare(m, existing, env) {
    if (m.status === 'vacant') m.vacantSince ||= env.today;
    else if (m.status === 'leased') m.vacantSince = null;
  },
  async load(docs, env) {
    const leases = await M('leases').find({ $or: docs.map((d) => ({ propertyCode: d.propertyCode, unitCode: d.unitCode })) }, 'propertyCode unitCode code status startDate endDate').lean();
    return { leases: groupBy(leases, (l) => `${l.propertyCode}|${l.unitCode}`) };
  },
  computed: {
    vacantDays: (i, c, d, env) => (d.status === 'vacant' && d.vacantSince ? Math.max(0, diffDays(d.vacantSince, env.today)) : null),
    activeLeaseCode: (i, c, d, env) => (c.leases[`${d.propertyCode}|${d.unitCode}`] || []).find((l) => ['active', 'expiring'].includes(leaseStatus(l, env)))?.code ?? null,
  },
});

// ---- Leases -------------------------------------------------------------------------------------
define({
  path: 'leases', prefix: 'HD', noun: 'hợp đồng thuê', statusField: 'status', searchFields: ['unitCode', 'propertyCode', 'renewalNote'],
  fields: {
    propertyCode: f.ref('properties', { required: true, onDelete: 'cascade' }),
    unitCode: f.ref('units', { required: true, via: 'propertyCode', onDelete: 'cascade' }),
    startDate: f.date(R),
    endDate: f.date(R),
    monthlyRent: f.money(R),
    deposit: f.money(),
    renewalNote: f.str(200),
    renewedFromCode: f.ref('leases', { onDelete: 'unlink' }),
    status: f.en(E.LEASE_STATUS, { readOnly: true, default: 'upcoming' }),
    terminatedAt: f.date({ readOnly: true, hidden: true }),
  },
  validate: (m) => (m.startDate && m.endDate && m.endDate <= m.startDate ? [{ field: 'endDate', code: 'must_be_after_start' }] : []),
  autoStatus: (d, c, env) => leaseStatus(d, env),
  computed: {
    termMonths: (i, c, d) => Math.max(0, Math.round(diffMonths(d.startDate, d.endDate))),
    daysRemaining: (i, c, d, env) => (['renewed', 'terminated'].includes(i.status) ? null : diffDays(env.today, d.endDate)),
    elapsedPct: (i, c, d, env) => clamp(round((diffDays(d.startDate, env.today) / Math.max(1, diffDays(d.startDate, d.endDate))) * 100, 1), 0, 100),
  },
});

// ---- Rent collections ---------------------------------------------------------------------------
const rentStatus = (d, env) => {
  const due = minor(d.amountDue);
  const got = minor(d.amountCollected);
  if (got >= due && due > 0) return 'paid';
  if (got >= due && due === 0) return 'paid';
  const dueDate = `${d.month}-${String(env.settings.rentDueDay).padStart(2, '0')}`;
  if (got > 0) return 'partial';
  return env.today > dueDate ? 'overdue' : 'unpaid';
};

define({
  path: 'rent-collections', prefix: 'TT', noun: 'khoản thu tiền thuê', statusField: 'status', searchFields: ['month', 'propertyCode', 'unitCode'],
  fields: {
    month: f.month(R),
    propertyCode: f.ref('properties', { required: true, onDelete: 'cascade' }),
    unitCode: f.ref('units', { required: true, via: 'propertyCode', onDelete: 'cascade' }),
    amountDue: f.money(R),
    amountCollected: f.money({ default: { amountMinor: 0, currency: 'USD' } }),
    lastCollectedAt: f.date(),
    status: f.en(E.RENT_STATUS, { readOnly: true, default: 'unpaid' }),
  },
  indexes: [[{ propertyCode: 1, unitCode: 1, month: 1 }, { unique: true }]],
  periodOf: (d) => d.month,
  prepare(m, existing, env) {
    const got = minor(m.amountCollected);
    if (got > 0 && (!m.lastCollectedAt || (existing && minor(existing.amountCollected) !== got && m.lastCollectedAt === existing.lastCollectedAt))) m.lastCollectedAt = env.today;
    if (got === 0) m.lastCollectedAt = null;
  },
  autoStatus: (d, c, env) => rentStatus(d, env),
  computed: { locked: (i, c, d, env) => !!(env.settings.closedThrough && d.month <= env.settings.closedThrough) },
  afterSave: (doc, o) => income.syncRent(doc.propertyCode, doc.month, o),
  afterDelete: (docs, o) => income.syncRentAll(docs, o),
});

/** GET /rent-collections/summary?month= */
async function rentSummary({ month }, env) {
  const ym = month || monthOf(env.today);
  const docs = await M('rent-collections').find({ month: ym }).lean();
  return Object.entries(groupBy(docs, (d) => d.propertyCode)).map(([propertyCode, list]) => {
    const st = list.map((d) => rentStatus(d, env));
    const due = list.reduce((a, d) => a + minor(d.amountDue), 0);
    const got = list.reduce((a, d) => a + minor(d.amountCollected), 0);
    const paid = st.filter((s) => s === 'paid').length;
    const overdueCount = st.filter((s) => s === 'overdue').length;
    return {
      propertyCode, month: ym, collectedPct: due > 0 ? round((got / due) * 100, 1) : null, unitsPaid: paid, unitsTotal: list.length, overdueCount,
      lastCollectedAt: list.map((d) => d.lastCollectedAt).filter(Boolean).sort().pop() ?? null,
      status: overdueCount > 0 ? 'overdue' : paid === list.length ? 'paid' : got > 0 ? 'partial' : 'unpaid',
    };
  });
}

// ---- Leasing funnel -----------------------------------------------------------------------------
define({
  path: 'leasing-funnel', prefix: 'PH', noun: 'mục phễu cho thuê', statusField: 'step', searchFields: ['unitCode', 'propertyCode', 'step'],
  fields: {
    propertyCode: f.ref('properties', { required: true, onDelete: 'cascade' }),
    unitCode: f.ref('units', { required: true, via: 'propertyCode', onDelete: 'cascade' }),
    step: f.en(E.FUNNEL_STEP, { required: true, default: 'vacant' }),
    stepEnteredAt: f.date({ default: () => today() }),
    inquiryCount: f.int({ default: 0 }),
    tourCount: f.int({ default: 0 }),
    applicationCount: f.int({ default: 0 }),
    listedRent: f.money(),
  },
  indexes: [[{ propertyCode: 1, unitCode: 1 }, { unique: true }]],
  prepare(m, existing, env) {
    if (existing && m.step !== existing.step && m.stepEnteredAt === existing.stepEnteredAt) m.stepEnteredAt = env.today;
  },
  async load(docs) {
    const units = await M('units').find({ $or: docs.map((d) => ({ propertyCode: d.propertyCode, code: d.unitCode })) }, 'propertyCode code vacantSince').lean();
    return { units: new Map(units.map((u) => [`${u.propertyCode}|${u.code}`, u])) };
  },
  computed: {
    vacantDays: (i, c, d, env) => {
      const since = c.units.get(`${d.propertyCode}|${d.unitCode}`)?.vacantSince || d.stepEnteredAt;
      return since ? Math.max(0, diffDays(since, env.today)) : null;
    },
  },
});

module.exports = { recordSummary, rentSummary, rentStatus, DOC_TEMPLATE };
