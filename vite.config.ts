import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  preview: { port: 4173 },
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
