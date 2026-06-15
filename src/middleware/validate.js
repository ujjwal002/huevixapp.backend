import { ApiError } from '../utils/ApiError.js';

// Usage: validate({ body: schema, query: schema, params: schema })
export const validate = (schemas) => (req, _res, next) => {
  try {
    for (const key of ['body', 'query', 'params']) {
      if (schemas[key]) {
        const result = schemas[key].safeParse(req[key]);
        if (!result.success) {
          throw ApiError.badRequest(
            'Validation failed',
            'VALIDATION_ERROR',
            result.error.flatten()
          );
        }
        req[key] = result.data;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
};
