const mongoose = require('mongoose');
const { Schema } = mongoose;

const make = (name, collection, def, indexes = []) => {
  const s = new Schema(def, { collection, versionKey: false, minimize: false });
  for (const [spec, opts] of indexes) s.index(spec, opts);
  return mongoose.model(name, s);
};

/** Per-resource counters behind TS-101, HD-102 ... */
const Counter = make('Counter', 'counters', { _id: String, seq: { type: Number, default: 0 } });

/** Singleton settings edited by EALING (thresholds, closed period) — never by the app. _id = main. */
const Setting = make('Setting', 'settings', { _id: String, data: Schema.Types.Mixed, updatedAt: Date });

/** Public content (company profile, templates), edited outside the app. _id = company | templates. */
const Content = make('Content', 'contents', { _id: String, data: Schema.Types.Mixed, updatedAt: { type: Date, default: Date.now } });

/** Per-IP request counters; documents expire on their own (TTL on expireAt). */
const RateHit = make('RateHit', 'rate_hits', {
  _id: String,
  count: { type: Number, default: 0 },
  expireAt: Date,
}, [[{ expireAt: 1 }, { expireAfterSeconds: 0 }]]);

module.exports = { Counter, Setting, Content, RateHit };
