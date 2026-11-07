/**
 * Per-IP limits (spec 2.8), counted in MongoDB so they hold across serverless instances:
 *   reads per minute, writes per minute, creates per day, exports per day.
 * Too many violations -> the IP is blocked for a few minutes. All numbers come from config/env.
 * If the counter store is unavailable the request goes through (fail-open): availability over strictness.
 */
const config = require('../config');
const { RateHit } = require('../models/system');
const { AppError } = require('../utils/AppError');

const MIN = 60;
const DAY = 86400;

async function hit(ip, bucket, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const win = Math.floor(now / windowSec);
  const doc = await RateHit.findOneAndUpdate(
    { _id: `${ip}|${bucket}|${win}` },
    { $inc: { count: 1 }, $setOnInsert: { expireAt: new Date((win + 2) * windowSec * 1000) } },
    { upsert: true, new: true },
  ).lean();
  return { count: doc.count, retryAfter: (win + 1) * windowSec - now };
}

function limiter(req, res, next) {
  const r = config.rate;
  if (!r.enabled) return next();
  const ip = req.ip || 'unknown';
  const write = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  const exporting = req.path === '/reports/export';
  (async () => {
    const ban = await RateHit.findById(`${ip}|ban`).lean();
    if (ban && ban.expireAt > new Date()) return { retryAfter: Math.ceil((ban.expireAt - Date.now()) / 1000) };
    const checks = [[write ? 'w' : 'r', MIN, write ? r.writePerMin : r.readPerMin]];
    if (req.method === 'POST') checks.push(['c', DAY, r.createPerDay]);
    if (exporting) checks.push(['x', DAY, r.exportPerDay]);
    for (const [bucket, win, max] of checks) {
      const h = await hit(ip, bucket, win);
      if (h.count > max) {
        const v = await hit(ip, 'v', DAY);
        if (v.count >= r.banAfterViolations) await RateHit.updateOne({ _id: `${ip}|ban` }, { $set: { count: v.count, expireAt: new Date(Date.now() + r.banMinutes * 60000) } }, { upsert: true });
        return { retryAfter: h.retryAfter };
      }
    }
    return null;
  })().then((over) => {
    if (!over) return next();
    res.set('Retry-After', String(Math.max(1, over.retryAfter)));
    next(new AppError(429, 'rate_limited', 'Bạn thao tác quá nhanh, vui lòng thử lại sau'));
  }, () => next());
}

module.exports = { limiter };
