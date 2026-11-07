/**
 * Body -> validated, stored-shape values (spec 2.1, 2.8). Strings are trimmed ('' = null), numbers must be numbers,
 * enums must match exactly, dates are real YYYY-MM-DD within 1990 … today + 50 years, free text goes through the PII filter.
 * Unknown, computed and read-only fields in the body are ignored.
 * Errors: validation -> [{ field, code }] ; PII -> [{ field, code: 'pii_detected', kind }]
 */
const { randomUUID } = require('crypto');
const { isDate, isMonth, today, addMonths } = require('../lib/dates');
const { check } = require('../lib/guard');

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const bad = (code, extra) => Object.assign(new Error(code), { vcode: code, extra });
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

const bounds = () => ({ min: '1990-01-01', max: addMonths(today(), 600) });

/** Returns the cleaned value or throws bad(code). */
function clean(f, raw, ctx) {
  switch (f.kind) {
    case 'str': {
      if (typeof raw !== 'string') throw bad('invalid_type');
      const s = raw.normalize('NFC').trim();
      if (s.length > f.max) throw bad('too_long');
      if (f.pattern && !f.pattern.test(s)) throw bad('invalid_format');
      if (f.pii !== false) {
        const kind = check(s, { contact: !!f.contact });
        if (kind) ctx.pii(kind);
      }
      return s;
    }
    case 'enum':
      if (typeof raw !== 'string' || !f.values.includes(raw.trim())) throw bad('invalid_enum');
      return raw.trim();
    case 'int':
      if (typeof raw !== 'number' || !Number.isInteger(raw)) throw bad('invalid_type');
      if (raw < f.min || raw > f.max) throw bad('out_of_range');
      return raw;
    case 'dec':
    case 'pct': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw bad('invalid_type');
      if (raw < f.min || raw > f.max) throw bad('out_of_range');
      return round(raw, f.kind === 'pct' ? 2 : f.decimals ?? 2);
    }
    case 'bool':
      if (typeof raw !== 'boolean') throw bad('invalid_type');
      return raw;
    case 'date': {
      if (!isDate(raw)) throw bad('invalid_date');
      const b = bounds();
      if (raw < b.min || raw > b.max) throw bad('out_of_range');
      return raw;
    }
    case 'month': {
      if (!isMonth(raw)) throw bad('invalid_month');
      const b = bounds();
      if (raw < b.min.slice(0, 7) || raw > b.max.slice(0, 7)) throw bad('out_of_range');
      return raw;
    }
    case 'ref': {
      if (typeof raw !== 'string' || raw.trim().length > 64) throw bad('invalid_type');
      return raw.trim();
    }
    case 'money': {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('invalid_type');
      const { amountMinor, currency } = raw;
      if (!Number.isInteger(amountMinor)) throw bad('invalid_type');
      if (amountMinor < 0 || amountMinor > 1e14) throw bad('out_of_range');
      if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) throw bad('invalid_currency');
      return { amountMinor, currency: currency || 'USD' };
    }
    case 'obj': {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('invalid_type');
      if (f.free) {
        // free map of numbers (Scenario.ratios): keys are checked against the tool by the resource
        const keys = Object.keys(raw);
        if (keys.length > 20) throw bad('too_many');
        const out = {};
        for (const k of keys) {
          if (k.length > 20 || typeof raw[k] !== 'number' || !Number.isFinite(raw[k])) throw bad('invalid_type');
          out[k] = raw[k];
        }
        return out;
      }
      return cleanObject(f.fields, raw, ctx, true);
    }
    case 'list': {
      if (!Array.isArray(raw)) throw bad('invalid_type');
      if (raw.length > f.max) throw bad('too_many');
      return raw.map((item, i) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad('invalid_type');
        return ctx.at(`[${i}]`, () => {
          const out = cleanObject(f.fields, item, ctx, true);
          if (f.itemId) out.id = typeof item.id === 'string' && item.id.length <= 64 ? item.id : randomUUID();
          return out;
        });
      });
    }
    default:
      throw bad('unsupported');
  }
}

/** Members of a nested object: errors are reported as `parent.child`. */
function cleanObject(fields, raw, ctx, full) {
  const out = {};
  for (const [name, f] of Object.entries(fields)) {
    ctx.at(`.${name}`, () => {
      if (isBlank(raw[name])) {
        if (f.default !== undefined) out[name] = typeof f.default === 'function' ? f.default() : f.default;
        else {
          out[name] = null;
          if (f.required && full) ctx.error('required');
        }
        return;
      }
      try {
        out[name] = clean(f, raw[name], ctx);
      } catch (e) {
        if (!e.vcode) throw e;
        ctx.error(e.vcode);
      }
    });
  }
  return out;
}

function makeCtx() {
  let path = '';
  const errors = [];
  const piis = [];
  return {
    errors,
    piis,
    error: (code) => errors.push({ field: path, code }),
    pii: (kind) => piis.push({ field: path, code: 'pii_detected', kind }),
    at(seg, fn) {
      const prev = path;
      path += seg;
      try {
        return fn();
      } finally {
        path = prev;
      }
    },
    root(name, fn) {
      path = name;
      try {
        return fn();
      } finally {
        path = '';
      }
    },
  };
}

const BASE = {
  note: { kind: 'str', max: 500 },
  ownerName: { kind: 'str', max: 40 },
  createdByName: { kind: 'str', max: 40 },
};

/**
 * `existing` = stored doc (PATCH) or null (POST). Returns { patch, errors, piis }:
 * patch holds the validated stored values of the fields that were sent (POST: every writable field, defaults filled).
 */
function normalize(cfg, body, existing) {
  const ctx = makeCtx();
  const patch = {};
  const all = { ...cfg.fields, ...BASE };
  const names = [...cfg.writable, ...Object.keys(BASE)];
  for (const name of names) {
    const f = all[name];
    const provided = body[name] !== undefined;
    if (existing && !provided) continue;
    ctx.root(name, () => {
      if (isBlank(body[name]) || (f.kind === 'obj' && body[name] === null)) {
        const dflt = f.default !== undefined ? (typeof f.default === 'function' ? f.default() : f.default) : null;
        // POST: a missing value takes the default; PATCH: sending null/'' clears an optional field and is refused for a required one
        if (f.required && (existing || dflt === null)) {
          ctx.error('required');
          return;
        }
        patch[name] = existing ? null : dflt;
        return;
      }
      if (existing && f.immutable && body[name] !== existing[name]) {
        ctx.error('immutable');
        return;
      }
      try {
        patch[name] = clean(f, body[name], ctx);
      } catch (e) {
        if (!e.vcode) throw e;
        ctx.error(e.vcode);
      }
    });
  }
  return { patch, errors: ctx.errors, piis: ctx.piis };
}

module.exports = { normalize, clean, cleanObject, makeCtx, isBlank };
