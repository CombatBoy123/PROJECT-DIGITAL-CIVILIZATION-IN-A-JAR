import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3001),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    AUTH_MODE: z.enum(['disabled', 'token']).default('disabled'),
    OPERATOR_TOKEN: z.string().min(24, 'OPERATOR_TOKEN must be at least 24 characters').optional(),
    VIEWER_TOKEN: z.string().min(24, 'VIEWER_TOKEN must be at least 24 characters').optional(),
    CHECKPOINT_INTERVAL_MS: z.coerce.number().int().min(100).max(600_000).default(2000),
    MAX_BUFFERED_EVENTS: z.coerce.number().int().min(100).max(1_000_000).default(20_000),
    FRAME_RATE: z.coerce.number().int().min(1).max(30).default(5),
    /** Live stream (WebSocket) connections the server accepts in total … */
    STREAM_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100_000).default(256),
    /** … and per client address (behind a reverse proxy: per proxy address). */
    STREAM_MAX_CONNECTIONS_PER_ADDRESS: z.coerce.number().int().min(1).max(100_000).default(32),
    INVARIANT_CHECKS: z.enum(['every-tick', 'off']).default('every-tick'),
    RESUME_RUNNING_ON_START: booleanString.default(false),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Directory of the built web app to serve (production single-container mode). */
    WEB_DIST_DIR: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === 'disabled' && !LOOPBACK_HOSTS.has(env.HOST)) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: `AUTH_MODE=disabled is only allowed when HOST is a loopback address (got ${env.HOST}). Set AUTH_MODE=token and OPERATOR_TOKEN.`,
      });
    }
    if (env.AUTH_MODE === 'token' && !env.OPERATOR_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPERATOR_TOKEN'],
        message: 'AUTH_MODE=token requires OPERATOR_TOKEN',
      });
    }
    if (env.OPERATOR_TOKEN && env.VIEWER_TOKEN && env.OPERATOR_TOKEN === env.VIEWER_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['VIEWER_TOKEN'],
        message: 'VIEWER_TOKEN must differ from OPERATOR_TOKEN',
      });
    }
  });

export type Env = z.output<typeof EnvSchema>;

export class EnvError extends Error {}

/** Parse the process environment, failing fast with a readable message. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new EnvError(`Invalid server configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
