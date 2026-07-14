import { ApiError } from '../utils/ApiError.js';

export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

export function errorHandler(err, req, res, _next) {
  // Prisma unique-constraint -> 409
  if (err?.code === 'P2002') {
    return res.status(409).json({
      error: { message: 'Resource already exists', code: 'DUPLICATE', fields: err.meta?.target },
    });
  }

  // Fix #11: Prisma "record to update/delete not found" -> 404 (was a 500).
  if (err?.code === 'P2025') {
    return res.status(404).json({
      error: { message: 'Resource not found', code: 'NOT_FOUND' },
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
    // Log full error server-side (with the request id for correlation), never
    // leak internals to the client.
    console.error(`[ERROR] [req:${req?.id || '-'}]`, err);
  }

  res.status(statusCode).json(body);
}
