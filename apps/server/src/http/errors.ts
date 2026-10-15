import type { ApiErrorBody, ErrorCode } from '@civ/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError, type z } from 'zod';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  CONFIRMATION_REQUIRED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  HALTED: 409,
  INTERNAL: 500,
};

/** An error with a stable code that is safe to show to API clients. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get statusCode(): number {
    return STATUS[this.code];
  }
}

export const notFound = (what: string): AppError => new AppError('NOT_FOUND', `${what} not found`);
export const conflict = (message: string, details?: unknown): AppError =>
  new AppError('CONFLICT', message, details);

/** Validate untrusted input; throws a VALIDATION_ERROR AppError with the Zod issues. */
export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
  where: string,
): z.output<S> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Invalid ${where}`,
      result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    );
  }
  return result.data;
}

function body(code: ErrorCode, message: string, details?: unknown): ApiErrorBody {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } };
}

/** Consistent error responses: { error: { code, message, details? } }. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError | ZodError | Error, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(body(err.code, err.message, err.details));
    }
    if (err instanceof ZodError) {
      return reply.status(400).send(body('VALIDATION_ERROR', 'Invalid input', err.issues));
    }
    const fastifyError = err as FastifyError;
    if (
      fastifyError.statusCode &&
      fastifyError.statusCode >= 400 &&
      fastifyError.statusCode < 500
    ) {
      // Malformed JSON, payload too large, unsupported media type, …
      return reply
        .status(fastifyError.statusCode)
        .send(
          body(
            fastifyError.statusCode === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR',
            fastifyError.message,
          ),
        );
    }
    request.log.error({ err }, 'Unhandled error');
    return reply.status(500).send(body('INTERNAL', 'Internal server error'));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .send(body('NOT_FOUND', `Route ${request.method} ${request.url.split('?')[0]} not found`));
  });
}
