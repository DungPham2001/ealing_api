const express = require('express');
const registry = require('../resources');
const { createRouter, bodyOf, send, asOf } = require('../core/router');
const { META } = require('../models/enums');
const { DEFAULTS } = require('../services/settings');
const reports = require('../services/reports');
const actions = require('../services/actions');
const { exportReport } = require('../services/export');
const { getCompany, getTemplates } = require('../services/content');
const { runDailyJobs } = require('../services/jobs');
const { intercompanyPairs } = require('../resources/structure');
const { recordSummary, rentSummary } = require('../resources/realestate');
const { cashSummary } = require('../resources/finance');
const { present } = require('../core/present');
const { getEnv } = require('../core/env');
const { leaseStatus } = require('../services/calc');
const { addDays, diffDays } = require('../lib/dates');
const { asyncHandler, AppError, notFound } = require('../utils/AppError');
const config = require('../config');
const { createHash } = require('crypto');

const M = (p) => registry.get(p).Model;
const api = express.Router();
const wrap = (fn) => asyncHandler(async (req, res) => send(res, await fn(req)));
const wrapReport = (fn) => asyncHandler(async (req, res) => res.json({ ...(await fn(req.query)), asOf: asOf() }));

// ---- meta, jobs ---------------------------------------------------------------------------------
api.get('/meta', wrap(async () => ({
  enums: META,
  limits: {
    title: 120, shortDescription: 200, note: 500, freeName: 40, listMaxLimit: 100, listDefaultLimit: 20, maxRangeDaysTimeline: 92,
    rate: { readPerMin: config.rate.readPerMin, writePerMin: config.rate.writePerMin, createPerDay: config.rate.createPerDay, exportPerDay: config.rate.exportPerDay },
    thresholds: Object.fromEntries(Object.entries(DEFAULTS).filter(([k]) => k !== 'closedThrough' && k !== 'closeTemplate')),
  },
})));

// Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set; this is a server job, not an app endpoint.
api.all('/jobs/daily', asyncHandler(async (req, res) => {
  if (config.cronSecret && req.headers.authorization !== `Bearer ${config.cronSecret}`) throw new AppError(403, 'forbidden', 'Không được phép');
  res.json({ data: await runDailyJobs(), asOf: asOf() });
}));

// ---- reports ------------------------------------------------------------------------------------
api.get('/reports/export', asyncHandler(async (req, res) => {
  const out = await exportReport(req.query);
  res.set({ 'Content-Type': out.contentType, 'Content-Disposition': `attachment; filename="${out.name}"` }).send(out.body);
}));
for (const [name, fn] of Object.entries(reports.REPORTS)) api.get(`/reports/${name}`, wrapReport(fn));
api.get('/timeline', wrap((req) => reports.timelineEvents(req.query)));

// ---- public content -----------------------------------------------------------------------------
const cached = (fn) => asyncHandler(async (req, res) => {
  const body = { data: await fn() };
  const etag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 20)}"`;
  res.set({ ETag: etag, 'Cache-Control': 'public, max-age=3600' });
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  return res.json({ ...body, asOf: asOf() });
});
api.get('/public/company', cached(getCompany));
api.get('/public/templates', cached(getTemplates));

// ---- derived views and actions (before the generic CRUD routers) --------------------------------
api.get('/entities/tree', wrap(async () => {
  const all = await M('entities').find({}).sort({ code: 1 }).lean();
  const nodes = new Map(all.map((e) => [e.code, { code: e.code, type: e.type, ownershipPct: e.parentOwnershipPct ?? null, children: [] }]));
  const roots = [];
  for (const e of all) (e.parentCode && nodes.has(e.parentCode) ? nodes.get(e.parentCode).children : roots).push(nodes.get(e.code));
  return roots;
}));
api.get('/intercompany-pairs', wrap((req) => intercompanyPairs(req.query)));
api.get('/property-records/summary', wrap((req) => recordSummary(req.query)));
api.get('/rent-collections/summary', wrap(async (req) => rentSummary(req.query, await getEnv())));
api.get('/cash-flows/summary', wrap(async (req) => cashSummary(req.query, await getEnv())));

api.get('/queue-items/stats', asyncHandler(async (req, res) => {
  const env = await getEnv();
  const items = await M('queue-items').find({}).lean();
  const open = items.filter((q) => q.status !== 'done');
  const waiting = items.filter((q) => q.status === 'waiting');
  const done = items.filter((q) => q.status === 'done' && q.targetDueAt);
  const wait = waiting.map((q) => diffDays(q.enqueuedAt.slice(0, 10), env.today));
  const byType = {};
  for (const q of waiting) byType[q.type] = (byType[q.type] || 0) + 1;
  res.json({
    waitingByType: byType,
    avgWaitDays: wait.length ? Math.round((wait.reduce((a, b) => a + b, 0) / wait.length) * 10) / 10 : null,
    onTimePct: done.length ? Math.round((done.filter((q) => q.updatedAt.toISOString().slice(0, 10) <= q.targetDueAt).length / done.length) * 1000) / 10 : null,
    overdueCount: open.filter((q) => q.targetDueAt && q.targetDueAt < env.today).length,
    total: items.length,
    asOf: asOf(),
  });
}));

api.get('/tasks/suggestions', wrap(async (req) => {
  const env = await getEnv();
  const types = new Set(String(req.query.types || 'lease,loan,maintenance,queue').split(','));
  const have = new Set((await M('tasks').find({ status: { $ne: 'done' }, 'relatedRef.code': { $ne: null } }, 'relatedRef').lean()).map((t) => t.relatedRef.code));
  const out = [];
  const add = (type, resource, d, title, dueDate, priority) => { if (!have.has(d.code)) out.push({ type, title, relatedRef: { resource, id: String(d._id), code: d.code }, dueDate: dueDate || null, priority }); };
  if (types.has('lease')) for (const l of await M('leases').find({ status: { $nin: ['renewed', 'terminated'] } }).lean()) if (leaseStatus(l, env) === 'expiring') add('lease', 'leases', l, `Gia hạn hợp đồng ${l.code}`, addDays(l.endDate, -14), 'high');
  if (types.has('loan')) for (const l of await M('loans').find({ refinanceNote: null, status: 'maturing' }).lean()) add('loan', 'loans', l, `Tái tài trợ ${l.lenderName}`, addDays(l.maturityDate, -90), 'high');
  if (types.has('maintenance')) for (const w of await M('work-orders').find({ status: { $nin: ['done', 'cancelled'] }, dueDate: { $lt: env.today } }).lean()) add('maintenance', 'work-orders', w, `Quá hạn: ${w.title}`, w.dueDate, w.priority);
  if (types.has('queue')) for (const q of await M('queue-items').find({ status: { $ne: 'done' }, targetDueAt: { $lt: env.today } }).lean()) add('queue', 'queue-items', q, `Quá hạn: ${q.title}`, q.targetDueAt, q.priority);
  return out;
}));

const post = (path, fn) => api.post(path, asyncHandler(async (req, res) => send(res, await fn(req, bodyOf(req)))));
post('/intercompany-entries/:id/confirm', (req, b) => actions.confirmIntercompany(req.params.id, b));
post('/exit-plans/:id/create-sale-deal', (req, b) => actions.createSaleDeal(req.params.id, b));
post('/properties/:id/duplicate', (req, b) => actions.duplicateProperty(req.params.id, b));
post('/leases/:id/renew', (req, b) => actions.renewLease(req.params.id, b));
post('/leases/:id/terminate', (req, b) => actions.terminateLease(req.params.id, b));
post('/pm-schedules/:id/complete', (req, b) => actions.completePm(req.params.id, b));
post('/pm-schedules/from-template', (req, b) => actions.pmFromTemplate(b));
post('/storm-plans/:id/damages', (req, b) => actions.addDamage(req.params.id, b));
post('/inspections/:id/create-work-order', (req, b) => actions.inspectionWorkOrder(req.params.id, b));
post('/development-projects/:id/complete', (req, b) => actions.completeDevelopment(req.params.id, b));
post('/deals/:id/close', (req, b) => actions.closeDeal(req.params.id, b));
post('/deals/:id/convert-to-development', (req, b) => actions.convertToDevelopment(req.params.id, b));
post('/queue-items/:id/claim', (req, b) => actions.claimQueue(req.params.id, b));
api.patch('/deals/:id/checklist/:key', asyncHandler(async (req, res) => send(res, await actions.setChecklist(req.params.id, req.params.key, bodyOf(req)))));

api.get('/', wrap(() => ({
  name: 'Ealing Holdings API', version: 'v1',
  resources: registry.all().map((c) => `/v1/${c.path}`),
  other: ['/v1/meta', '/v1/timeline', '/v1/reports/*', '/v1/public/company', '/v1/public/templates', '/v1/entities/tree', '/v1/intercompany-pairs'],
})));

for (const cfg of registry.all()) api.use(`/${cfg.path}`, createRouter(cfg));

module.exports = api;
