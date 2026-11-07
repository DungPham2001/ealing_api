const { Counter } = require('../models/system');

const OFFSET = 100; // first code is PREFIX-101

const letters = (n) => {
  let s = '';
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

/** Next code of a resource: TS-101, HD-102 ... (entities: PN-A, PN-B ... PN-AA). Gaps are harmless; codes are never reused. */
async function nextCode(cfg) {
  const c = await Counter.findOneAndUpdate({ _id: cfg.prefix }, { $inc: { seq: 1 } }, { upsert: true, new: true }).lean();
  return cfg.codeStyle === 'letter' ? `${cfg.prefix}-${letters(c.seq)}` : `${cfg.prefix}-${c.seq + OFFSET}`;
}

module.exports = { nextCode };
