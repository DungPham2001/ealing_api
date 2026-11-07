process.env.NODE_ENV = 'test';
const fs = require('fs');
// Offline machines: reuse a locally installed mongod instead of downloading one.
if (!process.env.MONGOMS_SYSTEM_BINARY && fs.existsSync('/opt/homebrew/bin/mongod')) {
  process.env.MONGOMS_SYSTEM_BINARY = '/opt/homebrew/bin/mongod';
  process.env.MONGOMS_VERSION = process.env.MONGOMS_VERSION || '9.0.4';
}

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const app = require('../src/app');
require('../src/models/system');

let rs;

async function start() {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, configSettings: { electionTimeoutMillis: 10000 } } });
  await mongoose.connect(rs.getUri());
  for (const name of mongoose.modelNames()) await mongoose.model(name).syncIndexes();
}
async function stop() {
  await mongoose.disconnect();
  await rs.stop();
}
async function reset() {
  for (const c of await mongoose.connection.db.collections()) await c.deleteMany({});
}

// No custom header anywhere: the API needs none (spec 2.2).
const api = {
  get: (p) => request(app).get(`/v1/${p}`),
  post: (p, body) => request(app).post(`/v1/${p}`).send(body || {}),
  patch: (p, body) => request(app).patch(`/v1/${p}`).send(body),
  del: (p) => request(app).delete(`/v1/${p}`),
};

const money = (amountMinor) => ({ amountMinor, currency: 'USD' });

/** POST that must succeed; returns the record (data). */
async function create(path, body) {
  const res = await api.post(path, body);
  if (res.status !== 201) throw new Error(`POST ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

module.exports = { start, stop, reset, api, create, money, app };
