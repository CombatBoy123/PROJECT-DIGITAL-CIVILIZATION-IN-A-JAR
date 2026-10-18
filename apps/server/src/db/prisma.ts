import { PrismaClient } from '@prisma/client';

/**
 * Create a Prisma client for an explicit database URL (instead of reading
 * DATABASE_URL implicitly), so the server, tests and scripts can each point at
 * their own database. The caller owns the client and must `$disconnect()` it.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

/** Cheap reachability check used by the health endpoint. */
export async function pingDatabase(prisma: PrismaClient, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([
      prisma.$queryRaw`SELECT 1`.then(
        () => true,
        () => false,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
