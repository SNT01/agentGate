import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard is served by the broker at /ui, so the build must know its
// own base path (asset URLs) and must emit into the location the broker's
// static-file resolver expects by default (config.uiAssetRoot,
// src/broker/staticFiles.js) — src/ui/dist, one level up from this project.
export default defineConfig({
  base: '/ui/',
  plugins: [react()],
  build: {
    outDir: '../src/ui/dist',
    emptyOutDir: true,
  },
  server: {
    // During `npm run dev`, proxy API calls to a broker running locally so
    // the dashboard can be developed without a production build loop.
    proxy: {
      '/health': 'http://127.0.0.1:4790',
      '/token': 'http://127.0.0.1:4790',
      '/audit': 'http://127.0.0.1:4790',
      '/admin': 'http://127.0.0.1:4790',
    },
  },
});
