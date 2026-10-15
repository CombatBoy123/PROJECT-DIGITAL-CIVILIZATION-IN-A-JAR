/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defaultServerConditions, defineConfig } from 'vite';

/*
 * Vite (dev server + build) and Vitest configuration for the observatory.
 *
 * The `source` export condition makes the workspace packages (@civ/sim-core,
 * @civ/shared) resolve to their TypeScript sources, so no package build is needed
 * during development. The dev server proxies the REST API and the WebSocket stream
 * to the Fastify server.
 */
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: [...defaultClientConditions, 'source'],
  },
  ssr: {
    resolve: {
      conditions: [...defaultServerConditions, 'source'],
    },
  },
  server: {
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, ws: true },
    },
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
