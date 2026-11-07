/**
 * Error body of the API (spec 2.3): { error: { code, message, fields?: [{ field, code }], requestId } }.
 * Codes: validation_failed 400, not_found 404, version_conflict 409, period_locked 409, has_dependents 409,
 * duplicate 409, invalid_state 409, payload_too_large 413, pii_detected 422, rate_limited 429, internal_error 5xx.
 */
class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const notFound = (noun = 'Bản ghi') => new AppError(404, 'not_found', `${noun} không tồn tại`);
/** `fields` = [{ field, code, message? }] */
const invalid = (fields, message = 'Dữ liệu không hợp lệ') => new AppError(400, 'validation_failed', message, { fields });
const pii = (fields) => new AppError(422, 'pii_detected', 'Nội dung có vẻ chứa dữ liệu cá nhân (email, số điện thoại, thẻ, SSN, tài khoản, mã số thuế)', { fields });
const conflict = (code, message, extra) => new AppError(409, code, message, extra);
const locked = () => new AppError(409, 'period_locked', 'Kỳ này đã được chốt, không thể tạo, sửa hoặc xóa bản ghi thuộc kỳ đó');
const badState = (message) => new AppError(409, 'invalid_state', message);

module.exports = { AppError, asyncHandler, notFound, invalid, pii, conflict, locked, badState };
