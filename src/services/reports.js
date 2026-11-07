/**
 * Read-only reports computed on the server (spec 3.9). Every figure is a count, a percentage or an index:
 * money is read here as integer minor units and never leaves this module as an amount. Missing data -> null.
 */
const registry = require('../core/registry');
const { present } = require('../core/present');
const { E } = require('../models/enums');
const { M, cashRows, noiOf, marginPct, isNoiIncome, isOpex, propertyKpis, leaseStatus, leaseCovers } = require('./calc');
const { intercompanyPairs } = require('../resources/structure');
const { loanStatus } = require('../resources/finance');
const { getEnv } = require('../core/env');
const { invalid } = require('../utils/AppError');
const D = require('../lib/dates');
const { round, pct, sum, avg, minor, groupBy, countBy, uniq } = require('../lib/util');

const asOf = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const periodOf = (q) => {
  const p = q.period || 'month';
  if (!D.PERIODS.includes(p)) throw invalid([{ field: 'period', code: 'invalid_enum' }]);
  return p;
};
const anchorOf = (q, env) => {
  if (!q.month) return env.today;
  if (!D.isMonth(q.month)) throw invalid([{ field: 'month', code: 'invalid_month' }]);
  return `${q.month}-01`;
};
const inMonths = (r, range) => r.date >= range.from && r.date <= range.to;
const delta = (a, b) => (a === null || b === null || a === undefined || b === undefined ? null : round(a - b, 1));
const change = (a, b) => (b ? round(((a - b) / Math.abs(b)) * 100, 1) : null);

/** Lazily loaded data of the requested scope (entityCode / propertyCode filters). */
function makeScope(q = {}) {
  const cache = {};
  const lazy = (k, fn) => () => (cache[k] ||= Promise.resolve().then(fn));
  const S = {};
  S.props = lazy('props', () => M('properties').find({ ...(q.entityCode && { entityCode: q.entityCode }), ...(q.propertyCode && { code: q.propertyCode }) }).lean());
  S.codes = lazy('codes', async () => (await S.props()).map((p) => p.code));
  const byProp = (path, extra = {}) => lazy(path, async () => M(path).find({ propertyCode: { $in: await S.codes() }, ...extra }).lean());
  S.units = byProp('units');
  S.leases = byProp('leases');
  S.funnel = byProp('leasing-funnel');
  S.workOrders = byProp('work-orders');
  S.equipment = byProp('equipment');
  S.utilities = byProp('utilities');
  S.records = byProp('property-records');
  S.storm = byProp('storm-plans');
  S.exits = byProp('exit-plans');
  S.pm = lazy('pm', async () => M('pm-schedules').find(q.propertyCode || q.entityCode ? { propertyCode: { $in: await S.codes() } } : {}).lean());
  S.loans = lazy('loans', async () => {
    const f = q.propertyCode ? { propertyCode: q.propertyCode } : q.entityCode ? { $or: [{ entityCode: q.entityCode }, { propertyCode: { $in: await S.codes() } }] } : {};
    return M('loans').find(f).lean();
  });
  S.entities = lazy('entities', () => M('entities').find(q.entityCode ? { code: q.entityCode } : {}).lean());
  S.projects = lazy('projects', () => M('development-projects').find(q.entityCode ? { entityCode: q.entityCode } : {}).lean());
  S.closes = lazy('closes', () => M('month-end-closes').find(q.entityCode ? { entityCode: q.entityCode } : {}).lean());
  S.rows = lazy('rows', async () => cashRows({ from: D.shiftMonth(D.monthOf(D.today()), -25), ...(q.propertyCode ? { propertyCode: q.propertyCode } : q.entityCode ? { entityCode: q.entityCode } : {}) }));
  S.incomes = lazy('incomes', async () => M('income-entries').find({ ...(q.entityCode && { entityCode: q.entityCode }), ...(q.propertyCode && { propertyCode: q.propertyCode }) }).lean());
  S.budgets = lazy('budgets', () => M('budgets').find(q.entityCode ? { entityCode: q.entityCode } : {}).lean());
  return S;
}

/** Occupancy at a given day from lease history: units covered by a lease / units that are not offline. */
function occupancyAt(units, leases, day) {
  const base = units.filter((u) => u.status !== 'offline');
  if (!base.length) return null;
  const started = leases.filter((l) => l.startDate <= day);
  if (!started.length) return null;
  const covered = new Set(leases.filter((l) => leaseCovers(l, day)).map((l) => `${l.propertyCode}|${l.unitCode}`));
  return pct(base.filter((u) => covered.has(`${u.propertyCode}|${u.code}`)).length, base.length, 1);
}
const currentOccupancy = (units) => {
  const base = units.filter((u) => u.status !== 'offline');
  return pct(base.filter((u) => u.status === 'leased').length, base.length, 1);
};

const rowsIn = (rows, range) => rows.filter((r) => inMonths(r, range));
const monthMargin = (rows, ym) => marginPct(noiOf(rows.filter((r) => r.month === ym)));

// ---- Dashboard ----------------------------------------------------------------------------------
async function dashboard(q = {}) {
  const env = await getEnv();
  const period = periodOf(q);
  const S = makeScope(q);
  const range = D.periodRange(period, env.today);
  const prev = D.previousRange(period, env.today);
  const ym = D.monthOf(env.today);
  const [entities, props, units, leases, rows, loans, wos, pm, storm, equipment, utils, closes, projects, exits, records, funnel, budgets, incomes] = await Promise.all([
    S.entities(), S.props(), S.units(), S.leases(), S.rows(), S.loans(), S.workOrders(), S.pm(), S.storm(), S.equipment(), S.utilities(), S.closes(), S.projects(), S.exits(), S.records(), S.funnel(), S.budgets(), S.incomes(),
  ]);
  const [queueItems, deals, tasks] = await Promise.all([M('queue-items').find({}).lean(), M('deals').find({}).lean(), M('tasks').find({}).lean()]);

  const cur = noiOf(rowsIn(rows, range));
  const old = noiOf(rowsIn(rows, prev));
  const hasCash = rows.length > 0;
  const occNow = currentOccupancy(units);
  const occPrev = occupancyAt(units, leases, prev.to);

  // budget variance: expenses in the period vs the yearly expense budget, prorated by months
  const monthsInRange = D.monthsIn(range.from, range.to).length;
  const budgetYear = sum(budgets.filter((b) => b.year === Number(env.today.slice(0, 4)) && !E.CF_INCOME_CATEGORIES.includes(b.category)), (b) => minor(b.amount));
  const spent = sum(rowsIn(rows, range).filter((r) => r.direction === 'expense'), (r) => r.minor);
  const budgetPeriod = (budgetYear / 12) * monthsInRange;

  const mix = (() => {
    const inc = incomes.filter((i) => D.monthsIn(range.from, range.to).includes(i.period));
    const total = sum(inc, (i) => minor(i.amount));
    return total > 0 ? { rentPct: pct(sum(inc.filter((i) => i.group === 'rent'), (i) => minor(i.amount)), total, 0), otherPct: pct(sum(inc.filter((i) => i.group === 'other'), (i) => minor(i.amount)), total, 0), interestPct: pct(sum(inc.filter((i) => i.group === 'interest'), (i) => minor(i.amount)), total, 0) } : null;
  })();
  const incSum = (r) => sum(incomes.filter((i) => D.monthsIn(r.from, r.to).includes(i.period)), (i) => minor(i.amount));
  const cashNet = (r) => sum(rowsIn(rows, r).filter((x) => x.direction === 'income'), (x) => x.minor) - sum(rowsIn(rows, r).filter((x) => x.direction === 'expense'), (x) => x.minor);

  const live = loans.filter((l) => loanStatus(l, env) !== 'paid_off');
  const balance = sum(live, (l) => minor(l.currentBalance));
  const value = sum(props, (p) => minor(p.estimatedValue));
  const noi12 = noiOf(rows.filter((r) => r.month > D.shiftMonth(ym, -12) && r.month <= ym));
  const service = sum(live, (l) => minor(l.monthlyPayment)) * 12;
  const maturing = live.filter((l) => D.diffDays(env.today, l.maturityDate) >= 0 && D.diffDays(env.today, l.maturityDate) <= 365);

  const stages = E.FUNNEL_STEP.map((step) => ({ step, count: funnel.filter((x) => x.step === step).length }));
  const vacDays = funnel.filter((x) => x.step !== 'signed').map((x) => D.diffDays(units.find((u) => u.propertyCode === x.propertyCode && u.code === x.unitCode)?.vacantSince || x.stepEnteredAt, env.today));

  const done = wos.filter((w) => w.status === 'done' && w.completedAt && w.completedAt >= range.from && w.completedAt <= range.to);
  const procDays = done.map((w) => D.diffDays(D.dateInTz(w.createdAt), w.completedAt));
  const nonCancelledPm = pm.filter((p) => true);

  const warranty = equipment.filter((e) => e.warrantyEnd);
  const monthClose = closes.filter((c) => c.month === ym);
  const pairs = await intercompanyPairs({ month: ym, ...(q.entityCode && { entityCode: q.entityCode }) });
  const activeEntities = entities.filter((e) => e.status === 'active');
  const unrec = new Set(pairs.filter((p) => p.reconcileStatus === 'mismatch').flatMap((p) => [p.creditEntityCode, p.debitEntityCode]));

  const lastUtil = [...utils].sort((a, b) => (a.period < b.period ? 1 : -1))[0]?.period;
  const utilNow = utils.filter((u) => u.period === lastUtil);
  const utilPrev = utils.filter((u) => u.period === D.shiftMonth(lastUtil || ym, -1));
  const unitCountOf = (list) => sum(uniq(list.map((u) => u.propertyCode)), (c) => props.find((p) => p.code === c)?.unitCount ?? 0);
  const perUnit = (list) => (unitCountOf(list) > 0 ? sum(list, (u) => u.usageValue) / unitCountOf(list) : null);

  const waiting = queueItems.filter((x) => x.status === 'waiting');
  const waitDays = waiting.map((x) => D.diffDays(x.enqueuedAt.slice(0, 10), env.today));
  const queueTypes = ['maintenance', 'lease_renewal', 'vacant_unit', 'closing', 'loan_maturity'];
  const waitingByType = { ...Object.fromEntries(queueTypes.map((t) => [t, waiting.filter((x) => x.type === t).length])), other: waiting.filter((x) => !queueTypes.includes(x.type)).length };

  const year = Number(env.today.slice(0, 4));
  const activeExits = exits.filter((x) => x.lifecycleStage !== 'sold');
  const months12 = D.last12(ym);

  const data = {
    period, asOf: asOf(), compareTo: 'previous_period',
    structure: { activeEntities: activeEntities.length },
    realEstate: { properties: props.length, units: units.length, vacantUnits: units.filter((u) => u.status === 'vacant').length, occupancyPct: occNow, occupancyDeltaPts: delta(occNow, occPrev) },
    operations: hasCash ? {
      noiMarginPct: marginPct(cur), noiDeltaPts: delta(marginPct(cur), marginPct(old)),
      opexRatioPct: pct(cur.opex, cur.income, 1), budgetVariancePct: budgetPeriod > 0 ? round(((spent - budgetPeriod) / budgetPeriod) * 100, 1) : null,
    } : null,
    income: incomes.length ? { changePct: change(incSum(range), incSum(prev)), mix } : null,
    cashFlow: hasCash ? { direction: cashNet(range) >= 0 ? 'positive' : 'negative', changePct: change(cashNet(range), cashNet(prev)) } : null,
    debt: loans.length ? {
      ltvPct: pct(balance, value, 1), dscr: service > 0 ? round(noi12.noi / service, 2) : null,
      maturitiesNext12m: maturing.length, maturityMonths: uniq(maturing.map((l) => Number(l.maturityDate.slice(5, 7)))).sort((a, b) => a - b),
    } : null,
    leasingFunnel: funnel.length ? { stages, conversionPct: pct(stages.find((s) => s.step === 'signed').count, funnel.length, 1), avgVacancyDays: vacDays.length ? Math.round(avg(vacDays)) : null } : null,
    maintenance: { openOrders: wos.filter((w) => !['done', 'cancelled'].includes(w.status)).length, avgProcessDays: procDays.length ? round(avg(procDays), 1) : null, preventiveOnTimePct: nonCancelledPm.length ? pct(nonCancelledPm.filter((p) => p.status !== 'overdue').length, nonCancelledPm.length, 0) : null },
    storm: Object.fromEntries(E.STORM_LEVEL.map((l) => [l, storm.filter((s) => s.responseLevel === l).length])),
    equipment: { underWarranty: warranty.filter((e) => e.warrantyEnd >= env.today).length, warrantyExpiringSoon: warranty.filter((e) => e.warrantyEnd >= env.today && D.diffDays(env.today, e.warrantyEnd) <= env.settings.warrantyExpiringDays).length, pastExpectedLife: equipment.filter((e) => D.diffDays(e.installedAt, env.today) / 365.25 > e.expectedLifeYears).length },
    utilities: utilNow.length ? { usagePerUnitChangePct: perUnit(utilPrev) ? change(perUnit(utilNow), perUnit(utilPrev)) : null, abnormalRiseProperties: uniq(utilNow.filter((u) => u.status === 'abnormal_rise').map((u) => u.propertyCode)).length } : null,
    closing: monthClose.length ? { progressPct: round(avg(monthClose.map((c) => (c.steps?.length ? (c.steps.filter((s) => s.status === 'done').length / c.steps.length) * 100 : 0))), 0), entitiesReconciled: activeEntities.filter((e) => !unrec.has(e.code)).length, entitiesTotal: activeEntities.length } : null,
    development: { byStage: countBy(projects, (p) => p.stage), avgProgressPct: projects.length ? round(avg(projects.map((p) => (p.stages?.length ? avg(p.stages.map((s) => s.progressPct ?? 0)) : 0))), 0) : null },
    exit: { byStrategy: countBy(activeExits, (x) => x.strategy), within1y: activeExits.filter((x) => x.targetExitYear <= year + 1).length, within3y: activeExits.filter((x) => x.targetExitYear <= year + 3).length, within5y: activeExits.filter((x) => x.targetExitYear <= year + 5).length },
    propertyRecords: records.length ? { completenessPct: pct(records.filter((r) => r.status === 'present').length, records.length, 0) } : null,
    queue: { waitingTotal: waiting.length, waitingByType, avgWaitDays: waitDays.length ? round(avg(waitDays), 1) : null, overdueCount: queueItems.filter((x) => x.status !== 'done' && x.targetDueAt && x.targetDueAt < env.today).length },
    deals: { byStage: countBy(deals.filter((d) => !['closed', 'rejected'].includes(d.stage)), (d) => d.stage) },
    tasks: { dueCount: tasks.filter((t) => t.status !== 'done' && t.dueDate && t.dueDate <= D.addDays(env.today, 7)).length, overdueCount: tasks.filter((t) => t.status !== 'done' && t.dueDate && t.dueDate < env.today).length },
    series: {
      occupancyPct: months12.map((m) => occupancyAt(units, leases, D.monthEnd(`${m}-01`) > env.today ? env.today : D.monthEnd(`${m}-01`))),
      noiMarginPct: months12.map((m) => monthMargin(rows, m)),
      maturitiesByYear: Object.entries(countBy(live, (l) => l.maturityDate.slice(0, 4))).map(([y, count]) => ({ year: Number(y), count })).sort((a, b) => a.year - b.year),
      closingProgressByMonth: Object.entries(groupBy(closes, (c) => c.month)).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-6).map(([month, list]) => ({ month, pct: round(avg(list.map((c) => (c.steps?.length ? (c.steps.filter((s) => s.status === 'done').length / c.steps.length) * 100 : 0))), 0) })),
    },
  };
  return { data };
}

// ---- Timeline -----------------------------------------------------------------------------------
async function timelineEvents({ from, to, kinds, entityCode, propertyCode } = {}) {
  const env = await getEnv();
  from ||= D.monthStart(env.today);
  to ||= D.monthEnd(env.today);
  if (!D.isDate(from) || !D.isDate(to)) throw invalid([{ field: 'from', code: 'invalid_date' }]);
  if (to < from) throw invalid([{ field: 'to', code: 'must_be_after_start' }]);
  if (D.diffDays(from, to) > 92) throw invalid([{ field: 'to', code: 'range_too_long' }]);
  const want = kinds ? new Set(String(kinds).split(',')) : null;
  const S = makeScope({ entityCode, propertyCode });
  const codes = entityCode || propertyCode ? await S.codes() : null;
  const inR = (d) => d && d >= from && d <= to;
  const withProp = (extra = {}) => ({ ...(codes && { propertyCode: { $in: codes } }), ...extra });
  const out = [];
  const add = (kind, date, title, resource, doc) => { if (inR(date) && (!want || want.has(kind))) out.push({ date, kind, title, code: doc.code, resource, id: String(doc._id) }); };
  const jobs = [];
  const load = (kind, fn) => { if (!want || want.has(kind)) jobs.push(fn()); };

  load('lease', async () => (await M('leases').find(withProp({ status: { $nin: ['renewed', 'terminated'] }, endDate: { $gte: from, $lte: to } })).lean()).forEach((d) => add('lease', d.endDate, `Hết hạn hợp đồng ${d.propertyCode}/${d.unitCode}`, 'leases', d)));
  load('loan', async () => (await M('loans').find({ maturityDate: { $gte: from, $lte: to }, ...(propertyCode && { propertyCode }), ...(entityCode && !propertyCode && { $or: [{ entityCode }, { propertyCode: { $in: codes } }] }) }).lean()).forEach((d) => add('loan', d.maturityDate, `Đáo hạn khoản vay — ${d.lenderName}`, 'loans', d)));
  load('maintenance', async () => {
    (await M('work-orders').find(withProp({ status: { $nin: ['done', 'cancelled'] }, dueDate: { $gte: from, $lte: to } })).lean()).forEach((d) => add('maintenance', d.dueDate, d.title, 'work-orders', d));
    (await M('pm-schedules').find({ ...(codes && { propertyCode: { $in: codes } }), nextDueAt: { $gte: from, $lte: to } }).lean()).forEach((d) => add('maintenance', d.nextDueAt, `Bảo trì định kỳ: ${d.task}`, 'pm-schedules', d));
  });
  load('warranty', async () => (await M('equipment').find(withProp({ warrantyEnd: { $gte: from, $lte: to } })).lean()).forEach((d) => add('warranty', d.warrantyEnd, 'Hết bảo hành', 'equipment', d)));
  load('project', async () => {
    (await M('renovation-projects').find(withProp()).lean()).forEach((d) => { add('project', d.expectedEnd, `Dự kiến xong: ${d.name}`, 'renovation-projects', d); (d.milestones || []).filter((m) => !m.done).forEach((m) => add('project', m.dueDate, `Mốc: ${m.title}`, 'renovation-projects', d)); });
    (await M('development-projects').find(entityCode ? { entityCode } : {}).lean()).forEach((d) => (d.stages || []).filter((s) => !s.actualDate).forEach((s) => add('project', s.plannedDate, `${d.name}: ${s.stage}`, 'development-projects', d)));
  });
  load('closing', async () => (await M('month-end-closes').find(entityCode ? { entityCode } : {}).lean()).forEach((d) => !['done', 'locked'].includes(d.status) && add('closing', d.dueDate, `Đóng sổ ${d.entityCode} ${d.month}`, 'month-end-closes', d)));
  load('queue', async () => (await M('queue-items').find({ status: { $ne: 'done' }, targetDueAt: { $gte: from, $lte: to } }).lean()).forEach((d) => add('queue', d.targetDueAt, d.title, 'queue-items', d)));
  load('storm', async () => (await M('storm-plans').find(withProp({ responseLevel: { $in: ['preparing', 'in_storm', 'inspecting', 'damaged'] } })).lean()).forEach((d) => add('storm', D.dateInTz(d.levelSince), `Ứng phó bão: ${d.responseLevel}`, 'storm-plans', d)));
  load('task', async () => (await M('tasks').find({ status: { $ne: 'done' }, dueDate: { $gte: from, $lte: to } }).lean()).forEach((d) => add('task', d.dueDate, d.title, 'tasks', d)));
  await Promise.all(jobs);
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.code < b.code ? -1 : 1));
}

// ---- Highlights ---------------------------------------------------------------------------------
async function highlights(q = {}) {
  const env = await getEnv();
  const period = periodOf(q);
  const range = D.periodRange(period, env.today);
  const S = makeScope(q);
  const [props, units, leases, rows, wos, pm, equipment, closes, projects, funnel, utils] = await Promise.all([S.props(), S.units(), S.leases(), S.rows(), S.workOrders(), S.pm(), S.equipment(), S.closes(), S.projects(), S.funnel(), S.utilities()]);
  const deals = await M('deals').find({}).lean();
  const inR = (d) => d && d >= range.from && d <= range.to;
  const ym = D.monthOf(env.today);
  const perProp = props.map((p) => {
    const u = units.filter((x) => x.propertyCode === p.code);
    return { propertyCode: p.code, occupancyPct: currentOccupancy(u), noiMarginPct: marginPct(noiOf(rowsIn(rows, range).filter((r) => r.propertyCode === p.code))) };
  });
  const top = perProp.filter((p) => p.occupancyPct !== null).sort((a, b) => b.occupancyPct - a.occupancyPct || (b.noiMarginPct ?? -1) - (a.noiMarginPct ?? -1)).slice(0, env.settings.topN);
  const watch = [];
  for (const p of perProp) if (p.occupancyPct !== null && 100 - p.occupancyPct >= env.settings.vacancyWatchPct) watch.push({ propertyCode: p.propertyCode, reason: 'vacancy_high', valuePct: round(100 - p.occupancyPct, 1) });
  for (const u of utils.filter((x) => x.status === 'abnormal_rise' && x.period === ym)) watch.push({ propertyCode: u.propertyCode, reason: 'utility_rise', valuePct: null });
  const vacDays = funnel.filter((x) => x.step !== 'signed').map((x) => D.diffDays(units.find((u) => u.propertyCode === x.propertyCode && u.code === x.unitCode)?.vacantSince || x.stepEnteredAt, env.today));
  const upcoming = (await timelineEvents({ from: env.today, to: D.addDays(env.today, 60), entityCode: q.entityCode, propertyCode: q.propertyCode })).slice(0, 5);
  const projectsWithDelay = projects.filter((p) => { const s = (p.stages || []).find((x) => x.stage === p.stage); return s?.plannedDate && !s.actualDate && s.plannedDate < env.today; });
  return { data: {
    topProperties: top,
    watchProperties: watch,
    leasing: { newLeases: leases.filter((l) => inR(l.startDate) && !l.renewedFromCode).length, renewals: leases.filter((l) => inR(l.startDate) && l.renewedFromCode).length, expirations: leases.filter((l) => inR(l.endDate)).length, avgVacancyDays: vacDays.length ? Math.round(avg(vacDays)) : null, funnelConversionPct: funnel.length ? pct(funnel.filter((x) => x.step === 'signed').length, funnel.length, 1) : null },
    operations: { closedWorkOrders: wos.filter((w) => w.status === 'done' && inR(w.completedAt)).length, preventiveOnTimePct: pm.length ? pct(pm.filter((p) => p.status !== 'overdue').length, pm.length, 0) : null, equipmentReplaced: equipment.filter((e) => inR(e.installedAt)).length },
    closing: { onTimeMonths: closes.filter((c) => ['done', 'locked'].includes(c.status) && D.inRange(c.month + '-01', range)).length, entitiesReconciled: uniq(closes.filter((c) => c.month === ym && ['done', 'locked'].includes(c.status)).map((c) => c.entityCode)).length },
    development: { stageChanges: projects.reduce((n, p) => n + (p.stages || []).filter((s) => inR(s.actualDate)).length, 0), avgProgressPct: projects.length ? round(avg(projects.map((p) => (p.stages?.length ? avg(p.stages.map((s) => s.progressPct ?? 0)) : 0))), 0) : null, delayedProjects: projectsWithDelay.length },
    deals: { new: deals.filter((d) => inR(D.dateInTz(d.createdAt))).length, inDiligence: deals.filter((d) => d.stage === 'due_diligence').length, closed: deals.filter((d) => d.stage === 'closed' && inR(D.dateInTz(d.updatedAt))).length, rejected: deals.filter((d) => d.stage === 'rejected' && inR(D.dateInTz(d.updatedAt))).length },
    upcomingMilestones: upcoming,
  } };
}

// ---- Individual reports -------------------------------------------------------------------------
async function noiReport(q = {}) {
  const env = await getEnv();
  const period = periodOf(q);
  const at = anchorOf(q, env);
  const range = D.periodRange(period, at);
  const prev = D.previousRange(period, at);
  const S = makeScope(q);
  const [props, units, rows, budgets, incomes] = await Promise.all([S.props(), S.units(), S.rows(), S.budgets(), S.incomes()]);
  const months = D.monthsIn(range.from, range.to);
  const budgetFor = (entityCode) => sum(budgets.filter((b) => b.entityCode === entityCode && b.year === Number(range.from.slice(0, 4)) && !E.CF_INCOME_CATEGORIES.includes(b.category)), (b) => minor(b.amount)) / 12 * months.length;
  const items = props.map((p) => {
    const mine = rows.filter((r) => r.propertyCode === p.code);
    const cur = noiOf(rowsIn(mine, range));
    const old = noiOf(rowsIn(mine, prev));
    const u = units.filter((x) => x.propertyCode === p.code);
    const occ = currentOccupancy(u);
    const entityRows = rowsIn(rows.filter((r) => r.entityCode === p.entityCode), range);
    const budget = budgetFor(p.entityCode);
    const spent = sum(entityRows.filter((r) => r.direction === 'expense'), (r) => r.minor);
    return { propertyCode: p.code, period, noiMarginPct: marginPct(cur), opexRatioPct: pct(cur.opex, cur.income, 1), incomeChangePct: change(cur.income, old.income), vacancyLossPct: occ === null ? null : round(100 - occ, 1), vsBudget: budget > 0 ? (spent <= budget ? 'on_target' : 'below') : null };
  });
  const inc = incomes.filter((i) => months.includes(i.period));
  const total = sum(inc, (i) => minor(i.amount));
  const share = (g) => pct(sum(inc.filter((i) => i.group === g), (i) => minor(i.amount)), total, 1);
  return { data: { items, mix: total > 0 ? { rentPct: share('rent'), otherPct: share('other'), interestPct: share('interest') } : null } };
}

async function occupancyReport(q = {}) {
  const env = await getEnv();
  const S = makeScope(q);
  const [props, units, leases] = await Promise.all([S.props(), S.units(), S.leases()]);
  const items = props.map((p) => {
    const u = units.filter((x) => x.propertyCode === p.code);
    return { propertyCode: p.code, occupancyPct: currentOccupancy(u), units: u.length, byStatus: countBy(u, (x) => x.status) };
  });
  const series = D.last12(D.monthOf(env.today)).map((m) => ({ month: m, occupancyPct: occupancyAt(units, leases, D.monthEnd(`${m}-01`) > env.today ? env.today : D.monthEnd(`${m}-01`)) }));
  return { data: { overallPct: currentOccupancy(units), items, series } };
}

async function funnelReport(q = {}) {
  const env = await getEnv();
  periodOf(q);
  const S = makeScope(q);
  const [funnel, units] = await Promise.all([S.funnel(), S.units()]);
  const steps = E.FUNNEL_STEP.map((step) => {
    const list = funnel.filter((x) => x.step === step);
    return { step, count: list.length, avgDaysInStep: list.length ? round(avg(list.map((x) => D.diffDays(x.stepEnteredAt, env.today))), 1) : null };
  });
  // conversion: share of items that reached the next step or beyond
  const reached = (i) => funnel.filter((x) => E.FUNNEL_STEP.indexOf(x.step) >= i).length;
  const conversion = steps.slice(1).map((s, i) => ({ from: steps[i].step, to: s.step, pct: pct(reached(i + 1), reached(i), 1) }));
  const vac = funnel.filter((x) => x.step !== 'signed').map((x) => D.diffDays(units.find((u) => u.propertyCode === x.propertyCode && u.code === x.unitCode)?.vacantSince || x.stepEnteredAt, env.today));
  return { data: { steps, conversion, avgVacancyDays: vac.length ? round(avg(vac), 1) : null } };
}

async function utilitiesReport(q = {}) {
  const env = await getEnv();
  const S = makeScope(q);
  const utils = await S.utilities();
  const period = q.period && D.isMonth(q.period) ? q.period : utils.map((u) => u.period).sort().pop();
  if (!period) return { data: { period: null, items: [] } };
  const items = (await present(registry.get('utilities'), utils.filter((u) => u.period === period), env)).map((u) => ({ propertyCode: u.propertyCode, kind: u.kind, usagePerUnit: u.usagePerUnit, usagePerAreaSqm: u.usagePerAreaSqm, momPct: u.momPct, yoyPct: u.yoyPct, costVsBudgetPct: u.costVsBudgetPct, status: u.status }));
  return { data: { period, items } };
}

async function equipmentReport(q = {}) {
  const env = await getEnv();
  const eq = await makeScope(q).equipment();
  const warranty = eq.filter((e) => e.warrantyEnd);
  return { data: {
    total: eq.length, byKind: countBy(eq, (e) => e.kind), byCondition: countBy(eq, (e) => e.condition),
    underWarranty: warranty.filter((e) => e.warrantyEnd >= env.today).length,
    warrantyExpiringSoon: warranty.filter((e) => e.warrantyEnd >= env.today && D.diffDays(env.today, e.warrantyEnd) <= env.settings.warrantyExpiringDays).length,
    pastExpectedLife: eq.filter((e) => D.diffDays(e.installedAt, env.today) / 365.25 > e.expectedLifeYears).length,
  } };
}

async function closingReport(q = {}) {
  const env = await getEnv();
  const month = q.month && D.isMonth(q.month) ? q.month : D.monthOf(env.today);
  const closes = (await makeScope(q).closes()).filter((c) => c.month === month);
  const items = await present(registry.get('month-end-closes'), closes, env);
  return { data: { month, items: items.map((c) => ({ entityCode: c.entityCode, status: c.status, completedCount: c.completedCount, totalCount: c.totalCount, progressPct: c.progressPct, reconciliation: c.reconciliation, dueDate: c.dueDate })) } };
}

async function debtLadder(q = {}) {
  const env = await getEnv();
  const loans = (await makeScope(q).loans()).filter((l) => loanStatus(l, env) !== 'paid_off');
  const byYear = Object.entries(countBy(loans, (l) => l.maturityDate.slice(0, 4))).map(([year, count]) => ({ year: Number(year), count })).sort((a, b) => a.year - b.year);
  const byEntity = Object.entries(groupBy(loans, (l) => l.entityCode || 'property')).map(([entityCode, list]) => ({
    entityCode, loanCount: list.length, floatingPct: pct(list.filter((l) => l.rateType === 'floating').length, list.length, 0),
    avgRatePct: list.some((l) => l.ratePct !== null) ? round(avg(list.filter((l) => l.ratePct !== null).map((l) => l.ratePct)), 2) : null,
    maturingWithinYear: list.filter((l) => D.diffDays(env.today, l.maturityDate) <= 365).length,
  }));
  return { data: { total: loans.length, byYear, byEntity } };
}

async function portfolioAllocation() {
  const env = await getEnv();
  const items = await present(registry.get('asset-classes'), await M('asset-classes').find({}).lean(), env);
  return { data: items.map((a) => ({ classKey: a.classKey, entityCode: a.entityCode, targetWeightPct: a.targetWeightPct, toleranceBandPct: a.toleranceBandPct, actualWeightPct: a.actualWeightPct, deviationPts: a.deviationPts, status: a.status })) };
}

/** 12-month outlook of the net margin, baseline and under a stress scenario (ratios only). */
async function cashForecast(q = {}) {
  const env = await getEnv();
  let sc = { incomeDropPct: 0, rateRisePts: 0, vacancyRisePct: 0 };
  if (q.scenarioId) {
    const found = await M('stress-scenarios').findOne({ $or: [{ _id: q.scenarioId }, { code: q.scenarioId }] }).lean();
    if (!found) throw invalid([{ field: 'scenarioId', code: 'not_found' }]);
    sc = found;
  }
  const S = makeScope(q);
  const [rows, loans] = await Promise.all([S.rows(), S.loans()]);
  const ym = D.monthOf(env.today);
  const recent = rows.filter((r) => r.month > D.shiftMonth(ym, -3) && r.month <= ym);
  const inc = sum(recent.filter((r) => r.direction === 'income'), (r) => r.minor) / 3;
  const exp = sum(recent.filter((r) => r.direction === 'expense'), (r) => r.minor) / 3;
  const floating = sum(loans.filter((l) => l.rateType === 'floating' && loanStatus(l, env) !== 'paid_off'), (l) => minor(l.currentBalance));
  const extraInterest = (floating * (sc.rateRisePts / 100)) / 12;
  const stressedIncome = inc * (1 - sc.incomeDropPct / 100) * (1 - sc.vacancyRisePct / 100);
  const stressedExpense = exp + extraInterest;
  const items = Array.from({ length: 12 }, (_, i) => ({
    month: D.shiftMonth(ym, i + 1),
    netMarginPct: inc > 0 ? round(((inc - exp) / inc) * 100, 1) : null,
    stressedNetMarginPct: stressedIncome > 0 ? round(((stressedIncome - stressedExpense) / stressedIncome) * 100, 1) : null,
    coverageRatio: stressedExpense > 0 ? round(stressedIncome / stressedExpense, 2) : null,
  }));
  return { data: { scenario: q.scenarioId ? { incomeDropPct: sc.incomeDropPct, rateRisePts: sc.rateRisePts, vacancyRisePct: sc.vacancyRisePct } : null, items } };
}

async function catalog() {
  const [classes, props, loans, storm, units, cash] = await Promise.all([
    M('asset-classes').find({}, 'estimatedValue').lean(), M('properties').find({}, 'code').lean(), M('loans').find({}, 'currentBalance monthlyPayment').lean(),
    M('storm-plans').find({}, 'propertyCode').lean(), M('units').find({}, 'propertyCode').lean(), M('cash-flows').find({}, 'propertyCode').lean(),
  ]);
  const ratio = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
  const withUnits = new Set(units.map((u) => u.propertyCode));
  const withCash = new Set(cash.map((c) => c.propertyCode));
  const withStorm = new Set(storm.map((s) => s.propertyCode));
  const mk = (code, title, description, readinessPct) => ({ code, title, description, readinessPct, status: readinessPct >= 80 ? 'ready' : 'updating', formats: ['pdf', 'csv'], type: { 'BC-01': 'portfolio-allocation', 'BC-02': 'occupancy', 'BC-03': 'debt-ladder', 'BC-04': 'equipment' }[code] });
  return { data: [
    mk('BC-01', 'Phân bổ danh mục', 'Tỷ trọng thực tế so với mục tiêu theo nhóm tài sản', ratio(classes.filter((c) => c.estimatedValue).length, classes.length)),
    mk('BC-02', 'Bất động sản', 'Lấp đầy, biên NOI và các chỉ số theo tài sản', ratio(props.filter((p) => withUnits.has(p.code) && withCash.has(p.code)).length, props.length)),
    mk('BC-03', 'Nợ đáo hạn', 'Thang đáo hạn và cấu trúc nợ theo pháp nhân', ratio(loans.filter((l) => l.currentBalance && l.monthlyPayment).length, loans.length)),
    mk('BC-04', 'Vận hành & bão', 'Bảo trì, thiết bị và mức ứng phó bão', ratio(props.filter((p) => withStorm.has(p.code)).length, props.length)),
  ] };
}

const REPORTS = {
  dashboard, highlights, noi: noiReport, occupancy: occupancyReport, funnel: funnelReport, utilities: utilitiesReport, equipment: equipmentReport,
  closing: closingReport, 'debt-ladder': debtLadder, 'portfolio-allocation': portfolioAllocation, 'cash-forecast': cashForecast, catalog,
};

module.exports = { REPORTS, dashboard, highlights, noiReport, occupancyReport, funnelReport, utilitiesReport, equipmentReport, closingReport, debtLadder, portfolioAllocation, cashForecast, catalog, timelineEvents, makeScope, asOf };
