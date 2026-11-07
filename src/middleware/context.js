const { randomBytes } = require('crypto');

/** Request context. No header is required from the client: the only identity is the IP (rate limiting) and a request id for support. */
function context(req, res, next) {
  req.requestId = `req_${randomBytes(6).toString('hex')}`;
  res.set('X-Request-Id', req.requestId);
  next();
}

module.exports = { context };
