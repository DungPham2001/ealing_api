/** 3.7 – 3.8 Master data and Toolkit: partners, service providers, saved scenarios. */
const { define } = require('../core/registry');
const f = require('../core/fields');
const { E } = require('../models/enums');
const { M } = require('../services/calc');
const { diffDays } = require('../lib/dates');
const { fold } = require('../lib/util');

const { R } = f;
const S = (o) => f.str(120, o);

define({
  path: 'partners', prefix: 'DOI', noun: 'đối tác', statusField: 'status', searchFields: ['companyName', 'kind', 'city'],
  fields: {
    companyName: S(R),
    kind: f.en(E.PARTNER_KIND, R),
    city: f.str(60),
    website: f.str(120, { contact: true }),
    companyEmail: f.str(120, { contact: true }),
    companyPhone: f.str(30, { contact: true }),
    status: f.en(E.PARTNER_STATUS, { required: true, default: 'active' }),
  },
  // loans of the lender / deals that came from the partner
  async load() {
    const [loans, deals] = await Promise.all([M('loans').find({}, 'lenderName').lean(), M('deals').find({}, 'source').lean()]);
    return { names: [...loans.map((l) => fold(l.lenderName)), ...deals.map((d) => fold(d.source)).filter(Boolean)] };
  },
  computed: { linkedCount: (i, c, d) => c.names.filter((n) => n === fold(d.companyName)).length },
});

define({
  path: 'service-providers', prefix: 'NC', noun: 'nhà cung cấp dịch vụ', statusField: 'status', searchFields: ['companyName', 'kind', 'scope'],
  fields: {
    companyName: S(R),
    kind: f.en(E.PROVIDER_KIND, R),
    scope: f.str(200),
    contractStart: f.date(),
    contractEnd: f.date(),
    fee: f.money(),
    rating: f.dec({ max: 5, decimals: 1 }),
    status: f.en(E.PROVIDER_STATUS, { readOnly: true, default: 'active' }),
  },
  validate: (m) => (m.contractStart && m.contractEnd && m.contractEnd < m.contractStart ? [{ field: 'contractEnd', code: 'must_be_after_start' }] : []),
  autoStatus(d, c, env) {
    if (!d.contractEnd) return 'active';
    if (d.contractEnd < env.today) return 'ended';
    return diffDays(env.today, d.contractEnd) <= env.settings.providerExpiringDays ? 'expiring' : 'active';
  },
});

// ---- Scenarios ----------------------------------------------------------------------------------
const TARGET_RESOURCE = { deal: 'deals', development_project: 'development-projects', exit_plan: 'exit-plans' };
/** A headline is a ratio / index, never an amount of money. */
const looksLikeMoney = (v) => /[$€£₫¥]|\b(usd|vnd|eur|đồng|dong)\b|\d[.,]\d{3}\b/i.test(v) || /\d{5,}/.test(v);

define({
  path: 'scenarios', prefix: 'KB', noun: 'kịch bản', searchFields: ['name', 'toolId'],
  filterMap: { targetKind: 'target.kind', targetCode: 'target.code' },
  fields: {
    toolId: f.en(E.SCENARIO_TOOL, R),
    name: S(R),
    target: f.obj({ kind: f.en(E.SCENARIO_TARGET, R), code: f.str(40, { required: true, pii: false }) }),
    ratios: f.obj({}, { free: true, required: true }),
    headline: f.obj({ label: f.str(60, { required: true }), value: f.str(40, { required: true, pii: false }) }),
  },
  validate(m) {
    const errors = [];
    const allowed = E.SCENARIO_RATIOS[m.toolId];
    if (allowed && m.ratios) {
      for (const [k, v] of Object.entries(m.ratios)) {
        if (!allowed[k]) errors.push({ field: `ratios.${k}`, code: 'unknown_key' });
        else if (v < allowed[k][0] || v > allowed[k][1]) errors.push({ field: `ratios.${k}`, code: 'out_of_range' });
      }
    }
    if (m.headline && looksLikeMoney(m.headline.value)) errors.push({ field: 'headline.value', code: 'money_not_allowed' });
    return errors;
  },
  async check(m, { session }) {
    if (!m.target) return [];
    const exists = await M(TARGET_RESOURCE[m.target.kind]).exists({ code: m.target.code }).session(session);
    return exists ? [] : [{ field: 'target.code', code: 'not_found' }];
  },
});
