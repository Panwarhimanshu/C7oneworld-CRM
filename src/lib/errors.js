'use strict';

class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const badRequest = (message, code = 'BAD_REQUEST', extra) => new AppError(400, code, message, extra);
const unauthorized = (message = 'Please sign in to continue.') => new AppError(401, 'UNAUTHENTICATED', message);
const forbidden = (message = 'You do not have permission to perform this action.') => new AppError(403, 'FORBIDDEN', message);
const notFound = (message = 'The requested record was not found.') => new AppError(404, 'NOT_FOUND', message);
const conflict = (message, code = 'CONFLICT') => new AppError(409, code, message);
const tooMany = (message, extra) => new AppError(429, 'RATE_LIMITED', message, extra);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany };
