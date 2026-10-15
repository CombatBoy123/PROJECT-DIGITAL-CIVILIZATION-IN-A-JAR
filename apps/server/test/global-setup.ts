import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DEFAULT_TEST_DATABASE_URL } from './database-url.js';

/** Apply all migrations to the test database once before the suite. */
export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
