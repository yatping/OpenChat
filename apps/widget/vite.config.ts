import { defineConfig, type Plugin } from 'vite';

/**
 * A classic script is decoded with the encoding of the page around it, and a customer's page may not be UTF-8.
 * Plain ASCII reads the same under all of them. Runs after minifying, which would undo escapes in the source.
 * Non-ASCII can only be in strings and templates here, where a \u escape means the same. check-budget enforces it.
 */
const asciiOnly = (): Plugin => ({
  name: 'openchat-ascii-only',
  enforce: 'post',
  generateBundle(_options, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type === 'chunk') file.code = file.code.replace(/[\u0080-\uffff]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
    }
  },
});

/** Two classic scripts: a host page may not allow modules from another origin, and neither needs CORS this way. */
export default defineConfig(({ mode }) => {
  const chat = mode === 'chat';
  return {
    server: { port: 5174 },
    plugins: [asciiOnly()],
    define: { 'process.env.NODE_ENV': '"production"' },
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
    build: {
      lib: chat
        ? { entry: 'src/chat.tsx', formats: ['iife'], name: 'OpenChatChat', fileName: () => 'chat.js' }
        : { entry: 'src/loader.ts', formats: ['iife'], name: 'OpenChatWidget', fileName: () => 'widget.js' },
      target: 'es2019',
      // The second build adds to the first.
      emptyOutDir: !chat,
    },
  };
});
