const config = require('../config');
const { AppError } = require('../utils/AppError');

const notFound = (req, _res, next) => next(new AppError(404, 'not_found', `Không có endpoint ${req.method} ${req.path}`));

/** Body: { error: { code, message, fields?, requestId, ...extra } } — never leaks internals. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let status = err.status || err.statusCode || 500;
  let code = typeof err.code === 'string' ? err.code : null;
  let message = err.message;
  let extra = err.extra || {};

  if (err.code === 11000) {
    status = 409;
    code = 'duplicate';
    message = 'Bản ghi đã tồn tại';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'validation_failed';
    message = 'Nội dung gửi lên không phải JSON hợp lệ';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    code = 'payload_too_large';
    message = 'Dữ liệu gửi lên quá lớn';
  }

  const known = err instanceof AppError || err.type || err.code === 11000;
  if (!known) status = 500;
  if (status >= 500) {
    console.error(req.requestId, err);
    code = 'internal_error';
    message = config.env === 'production' ? 'Hệ thống đang gặp sự cố, vui lòng thử lại sau' : err.message;
    extra = {};
  }
  res.status(status).json({ error: { code: code || 'error', message, ...extra, requestId: req.requestId } });
}

module.exports = { notFound, errorHandler };
