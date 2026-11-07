/**
 * Automatic revenue entries (IncomeEntry.source = auto, spec 3.5): one per entity / property / month / group,
 * kept in step with rent collections (rent) and cash flows (other income, interest). Manual entries are never touched.
 *   rent     = collected rent of the property that month (rent-collections); falls back to cash flows of category rent
 *   other    = other_income + sale cash flows
 *   interest = interest_income cash flows
 */
const registry = require('../core/registry');
const { monthEnd } = require('../lib/dates');
const { minor, sum } = require('../lib/util');

const GROUP_OF = { rent: 'rent', other_income: 'other', sale: 'other', interest_income: 'interest' };
const CATEGORIES = { rent: ['rent'], other: ['other_income', 'sale'], interest: ['interest_income'] };

async function recompute(entityCode, propertyCode, period, group, { session = null, env } = {}) {
  const Entries = registry.get('income-entries');
  const where = { entityCode, propertyCode: propertyCode || null, period, group, source: 'auto' };
  let cents = null;
  if (group === 'rent' && propertyCode) {
    const rc = await registry.get('rent-collections').Model.find({ propertyCode, month: period }, 'amountCollected').session(session).lean();
    if (rc.length) cents = sum(rc, (r) => minor(r.amountCollected));
  }
  if (cents === null) {
    const rows = await registry.get('cash-flows').Model.find({
      entityCode, propertyCode: propertyCode || null, direction: 'income', category: { $in: CATEGORIES[group] }, date: { $gte: `${period}-01`, $lte: monthEnd(`${period}-01`) },
    }, 'amount').session(session).lean();
    cents = sum(rows, (r) => minor(r.amount));
  }
  const { createInternal, patchInternal } = require('../core/record');
  const existing = await Entries.Model.findOne(where).session(session).lean();
  if (!cents) {
    if (existing) await Entries.Model.deleteOne({ _id: existing._id }, { session });
    return;
  }
  const amount = { amountMinor: cents, currency: 'USD' };
  if (existing) await patchInternal(Entries, existing, { amount }, { session, env });
  else await createInternal(Entries, { ...where, amount }, { session, env });
}

async function syncRent(propertyCode, month, o = {}) {
  const prop = await registry.get('properties').Model.findOne({ code: propertyCode }, 'entityCode').session(o.session || null).lean();
  if (prop) await recompute(prop.entityCode, propertyCode, month, 'rent', o);
}

/** After a cash flow changed: refresh the bucket it belongs to (and the one it left, if it moved). */
async function syncCash(doc, o = {}) {
  const seen = new Set();
  for (const d of [doc, o.existing].filter(Boolean)) {
    if (d.direction !== 'income' || !GROUP_OF[d.category]) continue;
    const key = `${d.entityCode}|${d.propertyCode}|${d.date.slice(0, 7)}|${GROUP_OF[d.category]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await recompute(d.entityCode, d.propertyCode, d.date.slice(0, 7), GROUP_OF[d.category], o);
  }
}

const eachSeq = async (docs, fn) => { for (const d of docs) await fn(d); };
const syncRentAll = (docs, o) => eachSeq(docs, (d) => syncRent(d.propertyCode, d.month, o));
const syncCashAll = (docs, o) => eachSeq(docs, (d) => syncCash(d, { ...o, existing: null }));

module.exports = { syncRent, syncCash, syncRentAll, syncCashAll, recompute };
