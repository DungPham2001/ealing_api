/** 3.5 Finance: cash flows, budgets, stress scenarios, loans, income entries, revenue targets, month-end closes. */
const { define } = require('../core/registry');
const f = require('../core/fields');
const { E } = require('../models/enums');
const { M, cashRows, noiOf, trailing12, propertyKpis } = require('../services/calc');
const { intercompanyPairs } = require('./structure');
const income = require('../services/income');
const { addDays, diffDays, monthEnd, monthOf, today } = require('../lib/dates');
const { clamp, round, pct, minor, sum } = require('../lib/util');

const { R } = f;
const S = (o) => f.str(120, o);
const lockedOf = (ym, env) => !!(env.settings.closedThrough && ym && ym <= env.settings.closedThrough);

// ---- Cash flows ---------------------------------------------------------------------------------
define({
  path: 'cash-flows', prefix: 'DT', noun: 'dòng tiền', searchFields: ['category', 'direction', 'entityCode', 'propertyCode'],
  fields: {
    entityCode: f.ref('entities', { required: true, onDelete: 'restrict' }),
    propertyCode: f.ref('properties'),
    direction: f.en(E.CF_DIRECTION, R),
    category: f.en(E.CF_CATEGORY, R),
    expenseType: f.en(E.EXPENSE_TYPE),
    amount: f.money(R),
    date: f.date(R),
  },
  indexes: [[{ entityCode: 1, date: 1 }], [{ propertyCode: 1, date: 1 }]],
  periodOf: (d) => d.date?.slice(0, 7),
  validate(m) {
    const inc = E.CF_INCOME_CATEGORIES.includes(m.category);
    if (m.direction && m.category && (m.direction === 'income') !== inc) return [{ field: 'category', code: 'wrong_direction' }];
    if (m.direction === 'income' && m.expenseType) return [{ field: 'expenseType', code: 'not_allowed' }];
    return [];
  },
  prepare(m) {
    if (m.direction === 'expense') m.expenseType ||= 'operating';
    else m.expenseType = null;
  },
  computed: { locked: (i, c, d, env) => lockedOf(d.date?.slice(0, 7), env) },
  afterSave: (doc, o) => income.syncCash(doc, o),
  afterDelete: (docs, o) => income.syncCashAll(docs, o),
});

/** GET /cash-flows/summary?month= : per entity, trend vs the previous month and use of the monthly budget. */
async function cashSummary({ month }, env) {
  const ym = month || monthOf(env.today);
  const prev = addDays(`${ym}-01`, -1).slice(0, 7);
  const year = Number(ym.slice(0, 4));
  const [rows, budgets, entities] = await Promise.all([
    cashRows({ from: prev, to: ym }),
    M('budgets').find({ year }, 'entityCode category amount').lean(),
    M('entities').find({}, 'code').lean(),
  ]);
  const net = (r) => sum(r.filter((x) => x.direction === 'income'), (x) => x.minor) - sum(r.filter((x) => x.direction === 'expense'), (x) => x.minor);
  const opex = (r) => sum(r.filter((x) => x.direction === 'expense' && x.expenseType !== 'capex'), (x) => x.minor);
  const change = (a, b) => (b !== 0 ? round(((a - b) / Math.abs(b)) * 100, 1) : null);
  return entities.map(({ code }) => {
    const mine = rows.filter((r) => r.entityCode === code);
    const cur = mine.filter((r) => r.month === ym);
    const old = mine.filter((r) => r.month === prev);
    const budget = sum(budgets.filter((b) => b.entityCode === code && !E.CF_INCOME_CATEGORIES.includes(b.category)), (b) => minor(b.amount)) / 12;
    const spent = sum(cur.filter((r) => r.direction === 'expense'), (r) => r.minor);
    return { entityCode: code, month: ym, direction: net(cur) >= 0 ? 'positive' : 'negative', changePct: change(net(cur), net(old)), budgetUsedPct: budget > 0 ? round((spent / budget) * 100, 1) : null, opexChangePct: change(opex(cur), opex(old)) };
  }).filter((r) => rows.some((x) => x.entityCode === r.entityCode));
}

// ---- Budgets & stress scenarios -----------------------------------------------------------------
define({
  path: 'budgets', prefix: 'NS', noun: 'ngân sách', searchFields: ['entityCode', 'category', 'year'],
  fields: {
    entityCode: f.ref('entities', { required: true, onDelete: 'cascade' }),
    year: f.year(R),
    category: f.en(E.CF_CATEGORY, R),
    amount: f.money(R),
  },
  indexes: [[{ entityCode: 1, year: 1, category: 1 }, { unique: true }]],
});

define({
  path: 'stress-scenarios', prefix: 'ST', noun: 'kịch bản căng thẳng', searchFields: ['name'],
  fields: {
    name: S(R),
    incomeDropPct: f.pct({ default: 0 }),
    rateRisePts: f.dec({ min: 0, max: 100, default: 0 }),
    vacancyRisePct: f.pct({ default: 0 }),
  },
});

// ---- Loans --------------------------------------------------------------------------------------
const loanStatus = (d, env) => {
  if (minor(d.currentBalance) === 0 && d.currentBalance) return 'paid_off';
  return diffDays(env.today, d.maturityDate) <= env.settings.loanMaturityMonths * 30.4375 ? 'maturing' : 'current';
};

define({
  path: 'loans', prefix: 'KV', noun: 'khoản vay', statusField: 'status', searchFields: ['lenderName', 'propertyCode', 'entityCode', 'rateSpread'],
  fields: {
    propertyCode: f.ref('properties', { onDelete: 'cascade' }),
    entityCode: f.ref('entities', { onDelete: 'restrict' }),
    lenderName: f.str(80, { required: true }),
    originalPrincipal: f.money(R),
    currentBalance: f.money(R),
    ratePct: f.pct(),
    rateType: f.en(E.RATE_TYPE, R),
    rateSpread: f.str(40),
    termYears: f.dec({ required: true, min: 0.1, max: 100 }),
    startDate: f.date(R),
    maturityDate: f.date(R),
    monthlyPayment: f.money(),
    refinanceNote: f.str(200),
    status: f.en(E.LOAN_STATUS, { readOnly: true, default: 'current' }),
  },
  validate(m) {
    const e = [];
    if (!m.propertyCode && !m.entityCode) e.push({ field: 'propertyCode', code: 'required' });
    if (m.startDate && m.maturityDate && m.maturityDate <= m.startDate) e.push({ field: 'maturityDate', code: 'must_be_after_start' });
    return e;
  },
  autoStatus: (d, c, env) => loanStatus(d, env),
  async load(docs, env) {
    const propCodes = [...new Set(docs.map((d) => d.propertyCode).filter(Boolean))];
    const entCodes = [...new Set(docs.map((d) => d.entityCode).filter(Boolean))];
    const byEntity = entCodes.length ? await M('properties').find({ entityCode: { $in: entCodes } }, 'code entityCode estimatedValue').lean() : [];
    const kpis = await propertyKpis([...new Set([...propCodes, ...byEntity.map((p) => p.code)])], env);
    return { kpis, byEntity };
  },
  computed: {
    dscr: (i, c, d) => {
      const codes = d.propertyCode ? [d.propertyCode] : c.byEntity.filter((p) => p.entityCode === d.entityCode).map((p) => p.code);
      const noi = sum(codes, (k) => c.kpis.get(k)?.noi12 ?? 0);
      const service = minor(d.monthlyPayment) * 12;
      return service > 0 && codes.some((k) => c.kpis.get(k)) ? round(noi / service, 2) : null;
    },
    ltvPct: (i, c, d) => {
      const props = d.propertyCode ? [d.propertyCode] : c.byEntity.filter((p) => p.entityCode === d.entityCode).map((p) => p.code);
      const value = sum(props, (k) => c.kpis.get(k)?.estimated ?? 0);
      return pct(minor(d.currentBalance), value, 1);
    },
    elapsedPct: (i, c, d, env) => clamp(round((diffDays(d.startDate, env.today) / Math.max(1, diffDays(d.startDate, d.maturityDate))) * 100, 1), 0, 100),
    remainingDays: (i, c, d, env) => diffDays(env.today, d.maturityDate),
  },
});

// ---- Revenue ------------------------------------------------------------------------------------
define({
  path: 'income-entries', prefix: 'RV', noun: 'khoản thu', searchFields: ['entityCode', 'propertyCode', 'period', 'group', 'reason'],
  fields: {
    entityCode: f.ref('entities', { required: true, onDelete: 'restrict' }),
    propertyCode: f.ref('properties', { purge: { source: 'auto' } }),
    period: f.month(R),
    group: f.en(E.INCOME_GROUP, R),
    amount: f.money(R),
    source: f.en(E.INCOME_SOURCE, { readOnly: true, default: 'manual' }),
    reason: f.str(120),
  },
  indexes: [[{ entityCode: 1, propertyCode: 1, period: 1, group: 1, source: 1 }]],
  periodOf: (d) => d.period,
  validate(m, existing) {
    if (existing?.source === 'auto') return [{ field: 'source', code: 'auto_entry_readonly' }];
    return m.source !== 'auto' && !m.reason ? [{ field: 'reason', code: 'required' }] : [];
  },
  computed: { locked: (i, c, d, env) => lockedOf(d.period, env) },
});

const PERIOD_RX = { month: /^\d{4}-(0[1-9]|1[0-2])$/, quarter: /^\d{4}-Q[1-4]$/, year: /^\d{4}$/ };
/** Months covered by a revenue-target period. */
function targetMonths(scope, period) {
  if (scope === 'month') return [period];
  const y = Number(period.slice(0, 4));
  if (scope === 'year') return Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
  const q = Number(period.slice(-1));
  return [0, 1, 2].map((i) => `${y}-${String((q - 1) * 3 + i + 1).padStart(2, '0')}`);
}

define({
  path: 'revenue-targets', prefix: 'MT', noun: 'mục tiêu doanh thu', searchFields: ['scope', 'period'],
  fields: {
    scope: f.en(E.TARGET_SCOPE, R),
    period: f.str(10, { required: true, pii: false }),
    target: f.money(R),
  },
  indexes: [[{ scope: 1, period: 1 }, { unique: true }]],
  validate: (m) => (m.scope && m.period && !PERIOD_RX[m.scope].test(m.period) ? [{ field: 'period', code: 'invalid_format' }] : []),
  async load(docs) {
    const months = [...new Set(docs.flatMap((d) => targetMonths(d.scope, d.period)))];
    const rows = months.length ? await M('income-entries').find({ period: { $in: months } }, 'period amount').lean() : [];
    return { byMonth: rows.reduce((m, r) => m.set(r.period, (m.get(r.period) || 0) + minor(r.amount)), new Map()) };
  },
  computed: {
    completionPct: (i, c, d) => pct(sum(targetMonths(d.scope, d.period), (m) => c.byMonth.get(m) || 0), minor(d.target), 1),
  },
});

// ---- Month-end close ----------------------------------------------------------------------------
const closeStatus = (d, env) => {
  if (lockedOf(d.month, env)) return 'locked';
  const st = (d.steps || []).map((s) => s.status);
  if (st.length && st.every((s) => s === 'done')) return 'done';
  return st.some((s) => s !== 'todo') ? 'doing' : 'todo';
};

define({
  path: 'month-end-closes', prefix: 'DS', noun: 'đóng sổ tháng', statusField: 'status', searchFields: ['entityCode', 'month'],
  fields: {
    entityCode: f.ref('entities', { required: true, immutable: true, onDelete: 'cascade' }),
    month: f.month({ required: true, immutable: true }),
    steps: f.list({
      key: f.str(40, { required: true, pii: false, pattern: /^[A-Za-z0-9_ -]+$/ }),
      status: f.en(E.STEP_STATUS, { required: true, default: 'todo' }),
      doneByName: f.str(40), doneAt: f.date(), note: f.str(120),
    }, { max: 30, itemId: false }),
    status: f.en(E.CLOSE_STATUS, { readOnly: true, default: 'todo' }),
    dueDate: f.date(),
  },
  indexes: [[{ entityCode: 1, month: 1 }, { unique: true }]],
  periodOf: (d) => d.month,
  validate(m) {
    const keys = (m.steps || []).map((s) => s.key);
    return new Set(keys).size !== keys.length ? [{ field: 'steps', code: 'duplicate_key' }] : [];
  },
  prepare(m, existing, env) {
    if (!m.steps?.length && !existing) m.steps = env.settings.closeTemplate.map((key) => ({ key, status: 'todo', doneByName: null, doneAt: null, note: null }));
    m.steps = (m.steps || []).map((s) => ({ ...s, doneAt: s.status === 'done' ? s.doneAt || env.today : null }));
    m.dueDate ||= addDays(monthEnd(`${m.month}-01`), env.settings.closeDueDays);
  },
  autoStatus: (d, c, env) => closeStatus(d, env),
  async load(docs) {
    const pairs = await Promise.all(docs.map((d) => intercompanyPairs({ month: d.month, entityCode: d.entityCode })));
    return { recon: new Map(docs.map((d, i) => [d._id, pairs[i].some((p) => p.reconcileStatus === 'mismatch') ? 'mismatch' : 'match'])) };
  },
  computed: {
    completedCount: (i, c, d) => (d.steps || []).filter((s) => s.status === 'done').length,
    totalCount: (i, c, d) => (d.steps || []).length,
    progressPct: (i, c, d) => (d.steps?.length ? round((d.steps.filter((s) => s.status === 'done').length / d.steps.length) * 100, 1) : 0),
    reconciliation: (i, c, d) => c.recon.get(d._id) ?? 'match',
  },
});

module.exports = { cashSummary, closeStatus, loanStatus, targetMonths };
