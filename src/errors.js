/**
 * Typed application errors and one central HTTP mapper.
 *
 * Services throw these instead of guessing a status code. The Express terminal
 * handler is the only place that turns an error into an HTTP response, so new
 * modules never need to duplicate message-substring checks.
 *
 * Responses keep the existing `{ error }` field for compatibility and add a
 * stable `{ code }` that clients can translate or branch on.
 */
export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request.', code = 'VALIDATION_ERROR') {
    super(400, code, message);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required.', code = 'AUTHENTICATION_REQUIRED') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden.', code = 'FORBIDDEN') {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.', code = 'NOT_FOUND') {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict.', code = 'CONFLICT') {
    super(409, code, message);
  }
}

// Historical transport-level response for body-parser/client failures. Kept
// byte-identical because existing clients and tests assert on this shape.
const LEGACY_CLIENT_ERROR = Object.freeze({ error: 'Invalid request.' });

const firstMongooseMessage = (error) => {
  const errors = error?.errors;
  if (!errors || typeof errors !== 'object') return undefined;
  const first = Object.values(errors)[0];
  return typeof first?.message === 'string' && first.message.trim() ? first.message : undefined;
};

export const toHttpError = (error) => {
  if (error instanceof AppError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }

  // Mongoose schema validation (bad email, over-long field, enum mismatch) is
  // a client error, not a 500.
  if (error?.name === 'ValidationError' && error?.errors) {
    return {
      status: 400,
      body: { error: firstMongooseMessage(error) ?? 'Invalid request.', code: 'VALIDATION_ERROR' },
    };
  }

  if (error?.name === 'CastError') {
    return { status: 400, body: { error: 'Invalid request.', code: 'VALIDATION_ERROR' } };
  }

  if (error?.code === 11000) {
    const field = Object.keys(error.keyPattern ?? {})[0];
    return {
      status: 409,
      body: {
        error: field === 'slug'
          ? 'A business with this slug already exists.'
          : 'A record with these values already exists.',
        code: 'CONFLICT',
      },
    };
  }

  // Body-parser and similar middleware errors already carry a 4xx status.
  // Preserve the legacy `{ error }`-only shape for these transport failures.
  const status = error?.status ?? error?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return { status, body: LEGACY_CLIENT_ERROR };
  }

  return { status: 500, body: { error: 'Internal server error.', code: 'INTERNAL_ERROR' } };
};
