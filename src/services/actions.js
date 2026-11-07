/**
 * Domain actions that are not plain CRUD (spec "POST /…/{id}/<action>"). Each runs in one transaction, bumps `version`
 * of what it changes, and returns the API record(s) it touched.
 */
const { randomUUID } = require('crypto');
const registry = require('../core/registry');
const { createRecord, createInternal, patchInternal } = require('../core/record');
const { clean, makeCtx } = require('../core/validate');
const { present } = require('../core/present');
const { getEnv } = require('../core/env');
const { withTx } = require('../core/tx');
const { notFound, invalid, badState, pii } = require('../utils/AppError');
const { E } = require('../models/enums');
const { nextDue } = require('../resources/operations');
const { DEFAULT_CHECKLIST } = require('../resources/development');
const { M } = require('./calc');
const f = require('../core/fields');

const cfgOf = (p) => registry.get(p);
const one = async (cfg, doc, env) => (await present(cfg, [doc], env))[0];

async function load(path, id, session) {
  const doc = await cfgOf(path).Model.findById(id).session(session).lean();
  if (!doc) throw notFound();
  return doc;
}

/** Validates ad-hoc action input with the same rules as record fields: returns the cleaned object or throws 400 / 422. */
function input(fields, body) {
  const ctx = makeCtx();
  const out = {};
  for (const [name, d] of Object.entries(fields)) {
    ctx.root(name, () => {
      const raw = body?.[name];
      if (raw === undefined || raw === null || raw === '') {
        if (d.required) ctx.error('required');
        out[name] = null;
        return;
      }
      try {
        out[name] = clean(d, raw, ctx);
      } catch (e) {
        if (!e.vcode) throw e;
        ctx.error(e.vcode);
      }
    });
  }
  if (ctx.errors.length) throw invalid(ctx.errors);
  if (ctx.piis.length) throw pii(ctx.piis);
  return out;
}

/** Runs the action in one transaction; the function it returns renders the response AFTER the commit (so computed fields see the new data). */
const tx = (fn) => async (...args) => {
  const env = await getEnv();
  const render = await withTx((session) => fn(...args, { session, env }));
  return render();
};

// ---- Intercompany -------------------------------------------------------------------------------
/** The other side enters its own amount: both entries of the pair become confirmed. */
const confirmIntercompany = tx(async (id, body, { session, env }) => {
  const cfg = cfgOf('intercompany-entries');
  const doc = await load('intercompany-entries', id, session);
  const { amount } = input({ amount: f.money({ required: true }) }, body);
  const mirror = doc.isCounterpart ? doc : await cfg.Model.findOne({ pairKey: doc.pairKey, isCounterpart: true }).session(session).lean();
  if (!mirror) throw notFound();
  if (mirror.counterpartConfirmed) throw badState('Giao dịch đối ứng đã được xác nhận');
  const saved = await patchInternal(cfg, mirror, { amount, counterpartConfirmed: true }, { session, env });
  const origin = await cfg.Model.findOne({ pairKey: doc.pairKey, isCounterpart: { $ne: true } }).session(session).lean();
  if (origin) await patchInternal(cfg, origin, { counterpartConfirmed: true }, { session, env });
  return async () => one(cfg, doc.isCounterpart ? saved : await cfg.Model.findById(id).lean(), env);
});

// ---- Exit plans / deals / development -----------------------------------------------------------
const createSaleDeal = tx(async (id, body, { session, env }) => {
  const plan = await load('exit-plans', id, session);
  if (plan.lifecycleStage !== 'prep_sale') throw badState('Chỉ tạo cơ hội bán khi kế hoạch ở giai đoạn Chuẩn bị bán');
  const prop = await M('properties').findOne({ code: plan.propertyCode }).session(session).lean();
  const dealCfg = cfgOf('deals');
  const deal = await createInternal(dealCfg, { name: `Bán ${prop.name}`, kind: 'disposition', area: prop.city, assetType: prop.type, stage: 'screening', unitCount: prop.unitCount, source: 'exit_plan' }, { session, env });
  return () => one(dealCfg, deal, env);
});

const closeDeal = tx(async (id, body, { session, env }) => {
  const cfg = cfgOf('deals');
  const deal = await load('deals', id, session);
  if (deal.stage === 'closed') throw badState('Giao dịch đã đóng');
  let property = null;
  if (deal.kind === 'acquisition') {
    const v = input({ entityCode: f.ref('entities', { required: true }), city: f.str(60), zip: f.str(10, { pattern: /^\d{5}(-\d{4})?$/, pii: false }) }, body);
    if (!(await M('entities').exists({ code: v.entityCode }).session(session))) throw invalid([{ field: 'entityCode', code: 'not_found' }]);
    const propCfg = cfgOf('properties');
    property = await createInternal(propCfg, {
      name: deal.name, type: deal.assetType, entityCode: v.entityCode, city: v.city || deal.area || '', zip: v.zip || null, unitCount: deal.unitCount ?? 0,
      purchasePrice: deal.offerPrice || deal.listPrice || null, estimatedValue: deal.offerPrice || deal.listPrice || null, purchaseDate: env.today, status: 'owned',
    }, { session, env });
    const unitCfg = cfgOf('units');
    for (let n = 1; n <= Math.min(deal.unitCount ?? 0, 500); n++) {
      await createInternal(unitCfg, { propertyCode: property.code, unitCode: `U-${String(n).padStart(3, '0')}`, type: 'standard', status: 'vacant' }, { session, env });
    }
  } else if (body?.propertyCode) {
    const p = await M('properties').findOne({ code: body.propertyCode }).session(session).lean();
    if (!p) throw invalid([{ field: 'propertyCode', code: 'not_found' }]);
    await patchInternal(cfgOf('properties'), p, { status: 'sold' }, { session, env });
  }
  const saved = await patchInternal(cfg, deal, { stage: 'closed', propertyCode: property?.code ?? deal.propertyCode }, { session, env });
  return async () => ({ deal: await one(cfg, saved, env), property: property ? await one(cfgOf('properties'), property, env) : null });
});

const convertToDevelopment = tx(async (id, body, { session, env }) => {
  const deal = await load('deals', id, session);
  if (deal.assetType !== 'land') throw badState('Chỉ chuyển giao dịch đất sang dự án phát triển');
  const v = input({ entityCode: f.ref('entities', { required: true }), productType: f.en(E.DEV_PRODUCT), plannedUnits: f.int() }, body);
  if (!(await M('entities').exists({ code: v.entityCode }).session(session))) throw invalid([{ field: 'entityCode', code: 'not_found' }]);
  const cfg = cfgOf('development-projects');
  const project = await createInternal(cfg, { name: deal.name, entityCode: v.entityCode, area: deal.area || '', productType: v.productType || 'multifamily', plannedUnits: v.plannedUnits ?? deal.unitCount ?? 0, budget: deal.offerPrice, stage: 'land_purchase' }, { session, env });
  return () => one(cfg, project, env);
});

const setChecklist = tx(async (id, key, body, { session, env }) => {
  const cfg = cfgOf('deals');
  const deal = await load('deals', id, session);
  if (!E.DEAL_CHECK_KEY.includes(key)) throw notFound('Mục checklist');
  if (!Number.isInteger(body?.version)) throw invalid([{ field: 'version', code: 'required' }]);
  if (deal.version !== body.version) {
    const { conflict } = require('../utils/AppError');
    throw conflict('version_conflict', 'Bản ghi đã được người khác thay đổi, hãy tải lại', { current: await one(cfg, deal, env) });
  }
  const v = input({ status: f.en(E.CHECK_STATUS), note: f.str(120) }, body);
  const list = (deal.checklist?.length ? deal.checklist : DEFAULT_CHECKLIST).map((c) => ({ ...c }));
  let item = list.find((c) => c.key === key);
  if (!item) list.push((item = { key, status: 'todo', note: null }));
  if (body.status !== undefined) item.status = v.status || 'todo';
  if (body.note !== undefined) item.note = v.note;
  const saved = await patchInternal(cfg, deal, { checklist: list }, { session, env });
  return () => one(cfg, saved, env);
});

const completeDevelopment = tx(async (id, body, { session, env }) => {
  const cfg = cfgOf('development-projects');
  const p = await load('development-projects', id, session);
  if (p.stage !== 'lease_or_sale') throw badState('Chỉ hoàn tất dự án ở giai đoạn Cho thuê hoặc bán');
  if (p.propertyCode) throw badState('Dự án đã được hoàn tất');
  const v = input({ city: f.str(60), zip: f.str(10, { pattern: /^\d{5}(-\d{4})?$/, pii: false }) }, body);
  const property = await createInternal(cfgOf('properties'), { name: p.name, type: p.productType, entityCode: p.entityCode, city: v.city || p.area, zip: v.zip, unitCount: p.plannedUnits, status: 'owned', purchaseDate: env.today }, { session, env });
  for (let n = 1; n <= Math.min(p.plannedUnits, 500); n++) {
    await createInternal(cfgOf('units'), { propertyCode: property.code, unitCode: `U-${String(n).padStart(3, '0')}`, type: 'standard', status: 'vacant' }, { session, env });
  }
  const saved = await patchInternal(cfg, p, { propertyCode: property.code }, { session, env });
  return async () => ({ project: await one(cfg, saved, env), property: await one(cfgOf('properties'), property, env) });
});

// ---- Properties ---------------------------------------------------------------------------------
const duplicateProperty = tx(async (id, body, { session, env }) => {
  const cfg = cfgOf('properties');
  const src = await load('properties', id, session);
  const values = {};
  for (const n of cfg.names) values[n] = src[n];
  values.name = `${src.name} (bản sao)`.slice(0, 120);
  values.status = 'owned';
  const created = await createInternal(cfg, values, { session, env });
  return () => one(cfg, created, env);
});

// ---- Leases -------------------------------------------------------------------------------------
const renewLease = tx(async (id, body, { session, env }) => {
  const cfg = cfgOf('leases');
  const old = await load('leases', id, session);
  if (['renewed', 'terminated'].includes(old.status)) throw badState('Hợp đồng đã được gia hạn hoặc chấm dứt');
  const created = await createRecord(cfg, {
    propertyCode: old.propertyCode, unitCode: old.unitCode, startDate: body?.startDate, endDate: body?.endDate, monthlyRent: body?.monthlyRent,
    deposit: body?.deposit ?? old.deposit ?? undefined, renewedFromCode: old.code,
  }, { session, env });
  await patchInternal(cfg, old, { status: 'renewed' }, { session, env });
  return () => one(cfg, created, env);
});

const terminateLease = tx(async (id, body, { session, env }) => {
  const cfg = cfgOf('leases');
  const old = await load('leases', id, session);
  if (['renewed', 'terminated'].includes(old.status)) throw badState('Hợp đồng đã được gia hạn hoặc chấm dứt');
  const saved = await patchInternal(cfg, old, { status: 'terminated', terminatedAt: env.today }, { session, env });
  return () => one(cfg, saved, env);
});

// ---- Preventive maintenance ---------------------------------------------------------------------
const TEMPLATES = {
  hurricane_prep: [{ task: 'roof_check', frequency: 'seasonal' }, { task: 'drain_clear', frequency: 'seasonal' }, { task: 'tree_trim', frequency: 'seasonal' }, { task: 'pump_check', frequency: 'seasonal' }],
  hvac_service: [{ task: 'hvac_clean', frequency: 'semiannual' }],
  fire_safety: [{ task: 'fire_system_check', frequency: 'annual' }],
  monthly_basics: [{ task: 'drain_clear', frequency: 'monthly' }, { task: 'pump_check', frequency: 'quarterly' }],
};

const completePm = tx(async (id, body, { session, env }) => {
  const cfg = cfgOf('pm-schedules');
  const s = await load('pm-schedules', id, session);
  const saved = await patchInternal(cfg, s, { lastDoneAt: env.today, nextDueAt: nextDue(s.frequency, env.today) }, { session, env });
  // finish the open work order generated for this schedule
  await M('work-orders').updateMany({ sourceType: 'pm', sourceCode: s.code, status: { $nin: ['done', 'cancelled'] } }, { $set: { status: 'done', completedAt: env.today }, $inc: { version: 1 } }, { session });
  return () => one(cfg, saved, env);
});

const pmFromTemplate = tx(async (body, { session, env }) => {
  const v = input({ templateKey: f.str(40, { required: true, pii: false }), propertyCode: f.ref('properties', { required: true }) }, body);
  const tpl = TEMPLATES[v.templateKey];
  if (!tpl) throw invalid([{ field: 'templateKey', code: 'invalid_enum', allowed: Object.keys(TEMPLATES) }]);
  if (!(await M('properties').exists({ code: v.propertyCode }).session(session))) throw invalid([{ field: 'propertyCode', code: 'not_found' }]);
  const cfg = cfgOf('pm-schedules');
  const created = [];
  for (const t of tpl) created.push(await createInternal(cfg, { propertyCode: v.propertyCode, ...t }, { session, env }));
  return async () => Promise.all(created.map((d) => one(cfg, d, env)));
});

// ---- Storm plans / inspections / queue ----------------------------------------------------------
const addDamage = tx(async (id, body, { session, env }) => {
  const cfg = cfgOf('storm-plans');
  const plan = await load('storm-plans', id, session);
  const v = input({ category: f.str(40, { required: true }), severity: f.en(E.SEVERITY, { required: true }), count: f.int({ required: true, min: 1, max: 100000 }) }, body);
  const damages = [...(plan.damages || []), { ...v, id: randomUUID() }];
  const wo = await createInternal(cfgOf('work-orders'), {
    propertyCode: plan.propertyCode, category: 'other', priority: v.severity === 'severe' ? 'urgent' : v.severity === 'moderate' ? 'high' : 'normal',
    title: `Khắc phục thiệt hại bão: ${v.category}`, status: 'new', sourceType: 'storm', sourceCode: plan.code,
  }, { session, env });
  const saved = await patchInternal(cfg, plan, { damages, responseLevel: 'damaged' }, { session, env });
  return async () => ({ stormPlan: await one(cfg, saved, env), workOrder: await one(cfgOf('work-orders'), wo, env) });
});

const WO_CATEGORY = { roof: 'roof', electrical: 'electrical', plumbing: 'plumbing', hvac: 'hvac', fire_safety: 'fire_safety', landscape: 'landscape' };
const inspectionWorkOrder = tx(async (id, body, { session, env }) => {
  const cfg = cfgOf('inspections');
  const ins = await load('inspections', id, session);
  if (ins.result !== 'urgent_fix') throw badState('Chỉ tạo lệnh bảo trì khi kết quả là Cần sửa gấp');
  if (ins.linkedWorkOrderCode) throw badState('Đã có lệnh bảo trì liên kết');
  const wo = await createInternal(cfgOf('work-orders'), {
    propertyCode: ins.propertyCode, category: WO_CATEGORY[ins.category] || 'other', priority: 'urgent', title: `Sửa gấp theo kiểm tra ${ins.code}`.slice(0, 120),
    status: 'new', sourceType: 'inspection', sourceCode: ins.code,
  }, { session, env });
  const saved = await patchInternal(cfg, ins, { linkedWorkOrderCode: wo.code }, { session, env });
  return async () => ({ inspection: await one(cfg, saved, env), workOrder: await one(cfgOf('work-orders'), wo, env) });
});

const claimQueue = tx(async (id, body, { session, env }) => {
  const cfg = cfgOf('queue-items');
  const { assigneeName } = input({ assigneeName: f.str(40, { required: true }) }, body);
  const q = await cfg.Model.findOneAndUpdate({ _id: id, status: 'waiting' }, { $set: { status: 'claimed', assigneeName }, $inc: { version: 1 } }, { new: true, session }).lean();
  if (!q) {
    await load('queue-items', id, session);
    throw badState('Mục này đã được nhận hoặc đã xong');
  }
  return () => one(cfg, q, env);
});

module.exports = {
  confirmIntercompany, createSaleDeal, closeDeal, convertToDevelopment, setChecklist, completeDevelopment, duplicateProperty,
  renewLease, terminateLease, completePm, pmFromTemplate, addDamage, inspectionWorkOrder, claimQueue, TEMPLATES, input,
};
