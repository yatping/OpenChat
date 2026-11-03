import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5174 },
  build: {
    lib: { entry: 'src/loader.ts', formats: ['iife'], name: 'OpenChatWidget', fileName: () => 'widget.js' },
    target: 'es2019',
  },
});
