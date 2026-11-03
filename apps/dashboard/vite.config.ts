import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The proxy keeps the production behaviour of one origin during development.
const worker = 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: worker, ws: true },
      '/health': worker,
      '/.well-known': worker,
    },
  },
});
