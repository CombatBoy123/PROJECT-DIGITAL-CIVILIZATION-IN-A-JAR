import { buildApp } from './app.js';
import { EnvError, loadEnv } from './config/env.js';
import { createPrismaClient } from './db/prisma.js';

/** Second signal while shutting down forces exit after this long anyway. */
const FORCED_EXIT_MS = 30_000;

/**
 * Process entry point: load configuration, build and start the server, and shut
 * down gracefully on SIGINT/SIGTERM (stop accepting connections, final
 * checkpoints for every loaded civilization, close, disconnect from PostgreSQL).
 */
async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const prisma = createPrismaClient(env.DATABASE_URL);
  const app = await buildApp({ env, prisma });

  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) {
      app.log.warn({ signal }, 'Forced exit');
      process.exit(1);
    }
    stopping = true;
    app.log.info({ signal }, 'Shutting down');
    setTimeout(() => {
      app.log.error('Shutdown timed out');
      process.exit(1);
    }, FORCED_EXIT_MS).unref();
    try {
      // close(): stop accepting, finish in-flight requests, close streams, then
      // onClose hooks write the final checkpoints of every loaded civilization.
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGINT', (s) => void stop(s));
  process.on('SIGTERM', (s) => void stop(s));

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (err) {
    app.log.error({ err }, 'Failed to start');
    await app.close().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
