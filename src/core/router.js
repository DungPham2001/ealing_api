const express = require('express');
const { createRecord, updateRecord, deleteRecord, deleteImpact } = require('./record');
const { present } = require('./present');
const { list, stats } = require('./list');
const { withTx } = require('./tx');
const { getEnv } = require('./env');
const { AppError, asyncHandler, notFound, invalid } = require('../utils/AppError');
const { iso } = require('../lib/util');

/** JSON object body. */
function bodyOf(req) {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid([{ field: 'body', code: 'required' }]);
  return b;
}

const asOf = () => iso(new Date());
const one = async (cfg, doc) => (await present(cfg, [doc]))[0];
const send = (res, data, status = 200) => res.status(status).json({ data, asOf: asOf() });

/** Standard REST router of a resource (spec 2.4, 2.5). */
function createRouter(cfg) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => res.json({ ...(await list(cfg, req.query)), asOf: asOf() })));
  router.get('/stats', asyncHandler(async (req, res) => res.json({ ...(await stats(cfg, req.query)), asOf: asOf() })));

  router.post('/', asyncHandler(async (req, res) => {
    const env = await getEnv();
    const doc = await withTx((session) => createRecord(cfg, bodyOf(req), { session, env }));
    send(res, await one(cfg, doc), 201);
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const doc = await cfg.Model.findById(req.params.id).lean();
    if (!doc) throw notFound();
    send(res, await one(cfg, doc));
  }));

  router.get('/:id/delete-impact', asyncHandler(async (req, res) => res.json({ ...(await deleteImpact(cfg, req.params.id)), asOf: asOf() })));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const body = bodyOf(req);
    const env = await getEnv();
    const { doc } = await withTx((session) => updateRecord(cfg, req.params.id, body, { session, env }));
    send(res, await one(cfg, doc));
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const env = await getEnv();
    await withTx((session) => deleteRecord(cfg, req.params.id, { session, env }));
    res.status(204).end();
  }));

  return router;
}

module.exports = { createRouter, bodyOf, send, one, asOf, AppError };
