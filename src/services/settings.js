/**
 * Thresholds and the closed period are configured by EALING outside the app (spec section 6, 2.7) and read from here,
 * never hard-coded in the rules. Edit with `npm run setting -- key=value`.
 */
const { Setting } = require('../models/system');
const config = require('../config');

const ID = 'main';
const DEFAULTS = {
  closedThrough: null,          // 'YYYY-MM': months up to and including this one are locked
  leaseExpiringDays: 60,
  warrantyExpiringDays: 60,
  loanMaturityMonths: 12,
  vendorExpiringDays: 60,
  providerExpiringDays: 45,
  utilityRisePct: 20,           // month-over-month rise that flags abnormal_rise
  vacancyWatchPct: 15,          // vacancy rate that puts a property on the watch list
  topN: 5,
  rentDueDay: 5,
  pmDueLeadDays: 7,
  closeWarnDays: 5,             // days before month end: open closing steps enter the Queue
  closeDueDays: 7,              // default due date of a closing = month end + N days
  closeTemplate: ['rent_entered', 'expenses_entered', 'intercompany_reconciled', 'loan_balance_updated', 'portfolio_value_updated', 'utilities_checked', 'budget_reviewed'],
};

let cache = null;
let at = 0;

async function getSettings() {
  if (config.env !== 'test' && cache && Date.now() - at < 30000) return cache;
  const s = await Setting.findById(ID).lean();
  cache = { ...DEFAULTS, ...(s?.data || {}) };
  at = Date.now();
  return cache;
}

async function setSettings(patch) {
  const cur = (await Setting.findById(ID).lean())?.data || {};
  const data = { ...cur, ...patch };
  await Setting.updateOne({ _id: ID }, { $set: { data, updatedAt: new Date() } }, { upsert: true });
  cache = null;
  return { ...DEFAULTS, ...data };
}

const isLockedMonth = (s, ym) => !!(s.closedThrough && ym && ym <= s.closedThrough);

module.exports = { DEFAULTS, getSettings, setSettings, isLockedMonth };
