export class ApiError extends Error {
  constructor(statusCode, message, code = undefined, details = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }

  static badRequest(msg = 'Bad request', code, details) {
    return new ApiError(400, msg, code, details);
  }
  static unauthorized(msg = 'Unauthorized', code) {
    return new ApiError(401, msg, code);
  }
  static forbidden(msg = 'Forbidden', code) {
    return new ApiError(403, msg, code);
  }
  static notFound(msg = 'Not found', code) {
    return new ApiError(404, msg, code);
  }
  static conflict(msg = 'Conflict', code) {
    return new ApiError(409, msg, code);
  }
  static payment(msg = 'Payment required', code = 'PAYMENT_REQUIRED') {
    return new ApiError(402, msg, code);
  }
}
