/** Every resource by path. `define` derives writable fields, refs and the Mongoose model from the descriptors. */
const { buildModel } = require('../models/build');

const registry = new Map();

const pascal = (p) => p.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());

function define(cfg) {
  const names = Object.keys(cfg.fields);
  const full = {
    computed: {},
    searchFields: [],
    ...cfg,
    model: pascal(cfg.path),
    collection: cfg.path.replace(/-/g, '_'),
    names,
    writable: names.filter((n) => !cfg.fields[n].readOnly),
    refs: names.filter((n) => cfg.fields[n].kind === 'ref').map((name) => {
      const f = cfg.fields[name];
      return { name, to: f.to, via: f.via || null, purge: f.purge || null, required: !!f.required, onDelete: f.onDelete || (f.required ? 'restrict' : 'unlink') };
    }),
  };
  full.Model = buildModel(full);
  registry.set(full.path, full);
  return full;
}

const get = (path) => registry.get(path);
const all = () => [...registry.values()];

module.exports = { define, get, all };
