/**
 * Field descriptors of a resource. One description drives validation, the Mongoose schema, list filters and cascade rules.
 * kinds: str enum int dec pct money date month ref bool obj list
 * options: required, readOnly (server-set, never accepted on write), immutable (cannot change after create),
 *          hidden (stored, never returned), default (value | fn), contact (email / phone allowed), pii:false (skip PII filter)
 * money is WRITE-ONLY: accepted as { amountMinor, currency }, stored, never returned (spec 0.2).
 */
const R = { required: true };

const str = (max = 120, o = {}) => ({ kind: 'str', max, ...o });
const en = (values, o = {}) => ({ kind: 'enum', values, ...o });
const int = (o = {}) => ({ kind: 'int', min: 0, max: 100000000, ...o });
const year = (o = {}) => int({ min: 1800, max: 2200, ...o });
/** Decimal (any sign unless min given). */
const dec = (o = {}) => ({ kind: 'dec', min: 0, max: 1e9, ...o });
/** Percent 0–100, stored with at most 2 decimals. */
const pct = (o = {}) => ({ kind: 'pct', min: 0, max: 100, ...o });
const money = (o = {}) => ({ kind: 'money', ...o });
const date = (o = {}) => ({ kind: 'date', ...o });
const month = (o = {}) => ({ kind: 'month', ...o });
const bool = (o = {}) => ({ kind: 'bool', ...o });
/**
 * Reference to another resource by its `code`.  onDelete: cascade | unlink | restrict | none (default: restrict when required, else unlink).
 * via: the sibling field that scopes the code (unit codes are unique per property only).
 * purge: extra filter; matching children are deleted instead of unlinked.
 */
const ref = (to, o = {}) => ({ kind: 'ref', to, ...o });
/** Nested object / array of objects whose members are described by `fields`. */
const obj = (fields, o = {}) => ({ kind: 'obj', fields, ...o });
const list = (fields, o = {}) => ({ kind: 'list', fields, max: 200, itemId: true, ...o });

module.exports = { R, str, en, int, year, dec, pct, money, date, month, bool, ref, obj, list };
