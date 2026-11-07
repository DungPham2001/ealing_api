const config = require('../config');

const DAY = 86400000;
const RX = /^(\d{4})-(\d{2})-(\d{2})$/;

const ms = (s) => {
  const [, y, m, d] = RX.exec(s);
  return Date.UTC(+y, +m - 1, +d);
};
const fmt = (t) => new Date(t).toISOString().slice(0, 10);

/** True for a real calendar date written YYYY-MM-DD. */
const isDate = (s) => typeof s === 'string' && RX.test(s) && fmt(ms(s)) === s;
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

const addDays = (s, n) => fmt(ms(s) + n * DAY);

/** Adds months, clamping the day (31 Jan + 1 month = 28/29 Feb). */
function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return fmt(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last)));
}

/** b - a in whole days. */
const diffDays = (a, b) => Math.round((ms(b) - ms(a)) / DAY);
/** Whole + fractional months between two dates (30.4375-day months). */
const diffMonths = (a, b) => (ms(b) - ms(a)) / DAY / 30.4375;

const monthStart = (s) => `${s.slice(0, 7)}-01`;
const monthEnd = (s) => addDays(addMonths(monthStart(s), 1), -1);
const monthOf = (s) => (s ? s.slice(0, 7) : null);
/** 'YYYY-MM' shifted by n months. */
const shiftMonth = (ym, n) => addMonths(`${ym}-01`, n).slice(0, 7);

/** A Date (or ISO string) as YYYY-MM-DD in the business timezone. */
const dateInTz = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const today = () => dateInTz(new Date());

const PERIODS = ['month', 'quarter', 'year'];

/** { from, to } of the calendar month/quarter/year containing `at` (YYYY-MM-DD). */
function periodRange(period, at) {
  const y = at.slice(0, 4);
  if (period === 'year') return { from: `${y}-01-01`, to: `${y}-12-31` };
  if (period === 'quarter') {
    const q = Math.floor((Number(at.slice(5, 7)) - 1) / 3);
    const from = `${y}-${String(q * 3 + 1).padStart(2, '0')}-01`;
    return { from, to: monthEnd(addMonths(from, 2)) };
  }
  return { from: monthStart(at), to: monthEnd(at) };
}
const previousRange = (period, at) => periodRange(period, addDays(periodRange(period, at).from, -1));
const inRange = (d, r) => !!d && d >= r.from && d <= r.to;
/** Month keys (YYYY-MM) covered by a range. */
function monthsIn(from, to) {
  const out = [];
  for (let m = monthStart(from); m <= to; m = addMonths(m, 1)) out.push(m.slice(0, 7));
  return out;
}
/** The 12 month keys ending at `ym`, oldest first. */
const last12 = (ym) => Array.from({ length: 12 }, (_, i) => shiftMonth(ym, i - 11));

module.exports = { PERIODS, isDate, isMonth, addDays, addMonths, diffDays, diffMonths, monthStart, monthEnd, monthOf, shiftMonth, dateInTz, today, periodRange, previousRange, inRange, monthsIn, last12 };
