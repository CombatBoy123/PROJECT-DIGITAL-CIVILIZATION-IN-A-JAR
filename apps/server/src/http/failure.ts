import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

/*
 * Client-safe descriptions of infrastructure failures. Driver and Prisma messages
 * contain server source paths, code excerpts and raw PostgreSQL errors; they belong
 * in the server log, not in `lastError`, stream status messages or response bodies,
 * which every reader of the server sees.
 */

/** A short classification of a failure that never includes its raw message. */
export function failureKind(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `database error ${err.code}`;
  if (err instanceof Prisma.PrismaClientInitializationError) return 'database unreachable';
  if (
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientRustPanicError ||
    err instanceof Prisma.PrismaClientValidationError
  ) {
    return 'database error';
  }
  return 'unexpected error';
}

/**
 * Log `err` in full with a random reference and return a message that is safe to show
 * to clients: `<what> (<kind>; ref <id>)`. The reference finds the log entry.
 */
export function reportFailure(log: FastifyBaseLogger, err: unknown, what: string): string {
  const errorRef = randomBytes(4).toString('hex');
  log.error({ err, errorRef }, what);
  return `${what} (${failureKind(err)}; ref ${errorRef})`;
}
