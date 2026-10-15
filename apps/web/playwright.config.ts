import { defineConfig, devices } from '@playwright/test';

/*
 * Browser tests against the real stack: the Fastify server (on the dedicated civ_e2e
 * database, auth disabled on loopback, fast checkpoints) and the Vite dev server
 * proxying /api to it. Run with `pnpm --filter @civ/web test:e2e`.
 */

export const E2E_API_PORT = 3101;
export const E2E_WEB_PORT = 5273;
const API_URL = `http://127.0.0.1:${E2E_API_PORT}`;
const WEB_URL = `http://127.0.0.1:${E2E_WEB_PORT}`;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.artifacts/test-results',
  // Tests share one server; each uses its own uniquely named civilization.
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: CI,
  reporter: CI
    ? [['list'], ['html', { outputFolder: 'e2e/.artifacts/report', open: 'never' }]]
    : [['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @civ/server exec tsx --conditions=source src/index.ts',
      url: `${API_URL}/api/health`,
      reuseExistingServer: !CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://civ:civ@localhost:5432/civ_e2e',
        HOST: '127.0.0.1',
        PORT: String(E2E_API_PORT),
        AUTH_MODE: 'disabled',
        CHECKPOINT_INTERVAL_MS: '500',
        CORS_ORIGINS: WEB_URL,
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${E2E_WEB_PORT} --strictPort`,
      url: WEB_URL,
      reuseExistingServer: !CI,
      timeout: 60_000,
      env: { API_PROXY_TARGET: API_URL },
    },
  ],
});
