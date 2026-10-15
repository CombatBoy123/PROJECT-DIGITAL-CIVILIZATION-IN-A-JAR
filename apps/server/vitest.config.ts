import { defineConfig } from 'vitest/config';

/*
 * Server tests run against a real PostgreSQL database (TEST_DATABASE_URL, default
 * civ_test). Files run one at a time because they share and truncate that database.
 */
/** Vite's default server conditions (vite is not a direct dependency here) plus `source`. */
const serverConditions = ['module', 'node', 'development|production', 'source'];

export default defineConfig({
  // `source` resolves @civ/sim-core and @civ/shared to their TypeScript sources.
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: serverConditions } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
