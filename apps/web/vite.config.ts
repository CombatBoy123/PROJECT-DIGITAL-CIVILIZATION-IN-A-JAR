/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { createLogger, defaultClientConditions, defaultServerConditions, defineConfig } from 'vite';

/*
 * Vite (dev server + build) and Vitest configuration for the observatory.
 *
 * The `source` export condition makes the workspace packages (@civ/sim-core,
 * @civ/shared) resolve to their TypeScript sources, so no package build is needed
 * during development. The dev server proxies the REST API and the WebSocket stream
 * to the Fastify server.
 */
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001';

/** Socket errors that only mean "the browser closed its end of the proxied WebSocket". */
const CLOSED_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE']);

/*
 * Vite logs a stack trace for every proxied WebSocket that the browser closes while
 * navigating away. Those are expected; every other message is logged unchanged.
 */
const logger = createLogger();
const logError = logger.error.bind(logger);
logger.error = (message, options) => {
  const code = (options?.error as NodeJS.ErrnoException | null | undefined)?.code;
  if (message.includes('ws proxy') && code !== undefined && CLOSED_SOCKET_CODES.has(code)) return;
  logError(message, options);
};

export default defineConfig({
  customLogger: logger,
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
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
