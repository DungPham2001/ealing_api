/**
 * Things that change because time passed (spec section 6). Safe to run any number of times a day
 * (Vercel Cron: GET /v1/jobs/daily):
 *   1. refresh derived statuses (lease expiring/expired, rent overdue, loan maturing, vendor/provider expiry, PM due ...)
 *   2. preventive maintenance that came due -> work order (idempotent per schedule)
 *   3. Queue items for every source record whose condition holds / stopped holding
 * Refreshing a status does not bump `version`: it is not an edit by a person.
 */
const registry = require('../core/registry');
const queue = require('./queue');
const { buildSearch, createInternal } = require('../core/record');
const { getEnv } = require('../core/env');

async function refreshStatuses(cfg, env) {
  let changed = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const ctx = cfg.load ? await cfg.load(batch, env) : {};
    const ops = [];
    for (const d of batch) {
      const next = cfg.autoStatus(d, ctx, env);
      if (next && next !== d[cfg.statusField]) ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { [cfg.statusField]: next, search: buildSearch(cfg, { ...d, [cfg.statusField]: next }) } } } });
    }
    if (ops.length) await cfg.Model.bulkWrite(ops);
    changed += ops.length;
    batch = [];
  };
  for await (const d of cfg.Model.find({}).lean().cursor()) {
    batch.push(d);
    if (batch.length >= 200) await flush();
  }
  await flush();
  return changed;
}

const PM_CATEGORY = { roof_check: 'roof', hvac_clean: 'hvac', drain_clear: 'plumbing', fire_system_check: 'fire_safety', tree_trim: 'landscape', pump_check: 'plumbing' };

async function generatePmWorkOrders(env) {
  const WO = registry.get('work-orders');
  let made = 0;
  const due = await registry.get('pm-schedules').Model.find({ status: { $in: ['due', 'overdue'] }, propertyCode: { $ne: null } }).lean();
  for (const s of due) {
    if (await WO.Model.exists({ sourceType: 'pm', sourceCode: s.code, status: { $nin: ['done', 'cancelled'] } })) continue;
    await createInternal(WO, { propertyCode: s.propertyCode, category: PM_CATEGORY[s.task] || 'other', priority: s.status === 'overdue' ? 'high' : 'normal', title: `Bảo trì định kỳ: ${s.task}`.slice(0, 120), vendorCode: s.vendorCode, status: 'new', dueDate: s.nextDueAt, sourceType: 'pm', sourceCode: s.code }, { env });
    made++;
  }
  return made;
}

async function runDailyJobs() {
  const env = await getEnv();
  const refreshed = {};
  const withStatus = () => registry.all().filter((c) => c.autoStatus && c.statusField);
  for (const cfg of withStatus()) refreshed[cfg.path] = await refreshStatuses(cfg, env);
  const workOrders = await generatePmWorkOrders(env);
  if (workOrders) await refreshStatuses(registry.get('pm-schedules'), env);
  const queueSources = await queue.syncAll(env);
  return { date: env.today, refreshed, pmWorkOrdersCreated: workOrders, queueSourcesChecked: queueSources };
}

module.exports = { runDailyJobs, refreshStatuses };
