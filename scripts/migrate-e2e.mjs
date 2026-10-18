/**
 * Apply migrations to the browser-test database (cross-platform replacement for an
 * inline `DATABASE_URL=… pnpm db:migrate`, which Windows shells do not understand).
 *
 *   pnpm db:migrate:e2e          # E2E_DATABASE_URL, or the local civ_e2e database
 *
 * The variable set here takes precedence over DATABASE_URL in .env, because Node's
 * --env-file never overrides variables that already exist in the environment.
 */
import { spawnSync } from 'node:child_process';

const url = process.env.E2E_DATABASE_URL ?? 'postgresql://civ:civ@localhost:5432/civ_e2e';
const result = spawnSync('pnpm', ['db:migrate'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
