import { ApiError } from '../utils/ApiError.js';

export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  // Prisma unique-constraint -> 409
  if (err?.code === 'P2002') {
    return res.status(409).json({
      error: { message: 'Resource already exists', code: 'DUPLICATE', fields: err.meta?.target },
    });
  }

  const statusCode = err.statusCode || 500;
  const body = {
    error: {
      message: statusCode === 500 ? 'Internal server error' : err.message,
      code: err.code || undefined,
      details: err.details || undefined,
    },
  };

  if (statusCode === 500) {
    // Log full error server-side, never leak to client.
    console.error('[ERROR]', err);
  }

  res.status(statusCode).json(body);
}
