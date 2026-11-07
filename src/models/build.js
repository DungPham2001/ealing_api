const mongoose = require('mongoose');
const { Schema } = mongoose;

const TYPES = { str: String, enum: String, ref: String, date: String, month: String, int: Number, dec: Number, pct: Number, bool: Boolean, money: Schema.Types.Mixed, obj: Schema.Types.Mixed, list: Schema.Types.Mixed };

/**
 * One collection per resource. _id is a UUID; `code` is the human-readable code. Money fields hold { amountMinor, currency }.
 * Optional values are stored as null. `search` is the folded text behind `?q=`.
 */
function buildModel(cfg) {
  const def = {
    _id: { type: String },
    code: { type: String, required: true },
    version: { type: Number, default: 1 },
    note: { type: String, default: null },
    ownerName: { type: String, default: null },
    createdByName: { type: String, default: null },
    search: { type: String, default: '' },
    ...Object.fromEntries(cfg.names.map((n) => {
      const f = cfg.fields[n];
      return [n, { type: TYPES[f.kind], default: f.kind === 'bool' ? false : null }];
    })),
  };
  const schema = new Schema(def, { collection: cfg.collection, timestamps: true, versionKey: false, minimize: false, id: false });
  if (cfg.codeScope) schema.index({ [cfg.codeScope]: 1, code: 1 }, { unique: true });
  else schema.index({ code: 1 }, { unique: true });
  schema.index({ updatedAt: -1 });
  if (cfg.statusField) schema.index({ [cfg.statusField]: 1 });
  const own = new Set((cfg.indexes || []).filter(([spec]) => Object.keys(spec).length === 1).map(([spec]) => Object.keys(spec)[0]));
  for (const r of cfg.refs) if (!own.has(r.name)) schema.index({ [r.name]: 1 });
  for (const [spec, opts] of cfg.indexes || []) schema.index(spec, opts);
  return mongoose.model(cfg.model, schema);
}

module.exports = { buildModel };
