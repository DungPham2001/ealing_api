/**
 * Shared figures behind the 🧮 fields and the reports. Money is read as integer minor units here and only ever leaves
 * this module as a ratio / count (spec 0.2).
 */
const registry = require('../core/registry');
const { E } = require('../models/enums');
const { monthEnd, shiftMonth, monthOf, diffDays } = require('../lib/dates');
const { pct, sum, minor, round } = require('../lib/util');

const M = (path) => registry.get(path).Model;

/** Income that counts toward NOI, expenses that do (interest, corporate overhead and capex do not). */
const NOI_INCOME = new Set(['rent', 'other_income']);
const NOI_EXCLUDED_EXPENSE = new Set(['loan_interest', 'other_corporate']);

const isNoiIncome = (r) => r.direction === 'income' && NOI_INCOME.has(r.category);
const isOpex = (r) => r.direction === 'expense' && r.expenseType !== 'capex' && !NOI_EXCLUDED_EXPENSE.has(r.category);

/** Cash-flow rows (lean, amount as minor) between two YYYY-MM months inclusive, optionally scoped. */
async function cashRows({ from, to, propertyCodes, entityCode, propertyCode } = {}) {
  const q = {};
  if (from || to) q.date = { ...(from && { $gte: `${from}-01` }), ...(to && { $lte: monthEnd(`${to}-01`) }) };
  if (propertyCodes) q.propertyCode = { $in: propertyCodes };
  if (propertyCode) q.propertyCode = propertyCode;
  if (entityCode) q.entityCode = entityCode;
  const docs = await M('cash-flows').find(q, 'entityCode propertyCode direction category expenseType amount date').lean();
  return docs.map((d) => ({ entityCode: d.entityCode, propertyCode: d.propertyCode, direction: d.direction, category: d.category, expenseType: d.expenseType, date: d.date, month: d.date.slice(0, 7), minor: minor(d.amount) }));
}

/** { income, opex, noi } in minor units for a set of cash rows. */
function noiOf(rows) {
  const income = sum(rows.filter(isNoiIncome), (r) => r.minor);
  const opex = sum(rows.filter(isOpex), (r) => r.minor);
  return { income, opex, noi: income - opex };
}

const marginPct = ({ income, noi }) => (income > 0 ? round((noi / income) * 100, 1) : null);

/** The 12 months ending at `ym` as { from, to }. */
const trailing12 = (ym) => ({ from: shiftMonth(ym, -11), to: ym });

/** code -> { estimated, balance, noi12, income12, capRatePct, ltvPct, noiMarginPct } (money as minor, KPIs as ratios). */
async function propertyKpis(codes, env) {
  const out = new Map();
  if (!codes.length) return out;
  const [props, loans, rows] = await Promise.all([
    M('properties').find({ code: { $in: codes } }, 'code estimatedValue').lean(),
    M('loans').find({ propertyCode: { $in: codes }, status: { $ne: 'paid_off' } }, 'propertyCode currentBalance').lean(),
    cashRows({ ...trailing12(monthOf(env.today)), propertyCodes: codes }),
  ]);
  for (const p of props) {
    const mine = rows.filter((r) => r.propertyCode === p.code);
    const n = noiOf(mine);
    const estimated = minor(p.estimatedValue);
    const balance = sum(loans.filter((l) => l.propertyCode === p.code), (l) => minor(l.currentBalance));
    out.set(p.code, {
      estimated, balance, noi12: n.noi, income12: n.income,
      capRatePct: pct(n.noi, estimated, 2),
      ltvPct: pct(balance, estimated, 1),
      noiMarginPct: marginPct(n),
    });
  }
  return out;
}

/** Unit counts per property: Map code -> { total, leased, vacant, vacating, repair, offline, map } */
async function unitStats(codes) {
  const out = new Map();
  if (!codes.length) return out;
  const units = await M('units').find({ propertyCode: { $in: codes } }, 'propertyCode code status').sort({ code: 1 }).lean();
  const CH = { leased: 'L', vacant: 'V', vacating: 'S', repair: 'R', offline: 'O' };
  for (const c of codes) out.set(c, { total: 0, leased: 0, vacant: 0, vacating: 0, repair: 0, offline: 0, map: '' });
  for (const u of units) {
    const s = out.get(u.propertyCode);
    s.total++;
    s[u.status]++;
    s.map += CH[u.status] || '?';
  }
  return out;
}

/** Leased / (units that are not offline) as a percentage. */
const occupancyOf = (s) => (s && s.total - s.offline > 0 ? pct(s.leased, s.total - s.offline, 1) : null);

/** Lease status from its dates (renewed / terminated are stored states). */
function leaseStatus(l, env) {
  if (l.status === 'renewed' || l.status === 'terminated') return l.status;
  if (env.today < l.startDate) return 'upcoming';
  if (env.today > l.endDate) return 'expired';
  return diffDays(env.today, l.endDate) <= env.settings.leaseExpiringDays ? 'expiring' : 'active';
}

/** A lease occupies its unit at `day` (YYYY-MM-DD)? */
const leaseCovers = (l, day) => {
  if (l.status === 'terminated' && l.terminatedAt && l.terminatedAt < l.endDate) return l.startDate <= day && day <= l.terminatedAt;
  return l.startDate <= day && day <= l.endDate;
};

module.exports = { M, isNoiIncome, isOpex, cashRows, noiOf, marginPct, trailing12, propertyKpis, unitStats, occupancyOf, leaseStatus, leaseCovers, E };
