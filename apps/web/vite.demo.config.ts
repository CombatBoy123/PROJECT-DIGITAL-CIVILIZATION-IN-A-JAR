import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

/*
 * Vite configuration of the standalone browser demo (demo.html → src/demo/main.tsx).
 *
 *   pnpm --filter @civ/web exec vite --config vite.demo.config.ts        # dev server
 *   pnpm demo:build                                                     # artifact
 *
 * The build is shaped for a single self-contained HTML file: one JS chunk (dynamic
 * imports inlined), one CSS file, every asset inlined, no source maps. The script
 * scripts/build-demo-artifact.mjs then inlines both into the published fragment.
 * Like vite.config.ts, the `source` condition resolves the workspace packages to
 * their TypeScript sources. No API proxy: the demo never talks to a server.
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    conditions: [...defaultClientConditions, 'source'],
  },
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    modulePreload: false,
    // The demo is deliberately one chunk (about 1 MB); no code splitting.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: 'demo.html',
      output: { inlineDynamicImports: true },
    },
  },
});
