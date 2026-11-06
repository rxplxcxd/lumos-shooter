import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
    // realtime relay (npm run server) is reachable through the same origin: ws(s)://<host>/ws
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true, rewriteWsOrigin: true } },
  },
  preview: { port: 4173, proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        viewer: resolve(__dirname, 'viewer.html'),
      },
    },
  },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
