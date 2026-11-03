// Architecture boundaries, enforced by lint. See docs/architecture/monorepo.md.
// test/boundaries.test.mjs proves that each rule actually fires.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const RELAY_MESSAGE = 'The relay must stay independent. It may import only notification-protocol and shared.';
const SERVER_ONLY = ['core', 'database', 'realtime', 'email', 'auth'].map((p) => `@openchat/${p}`);

const installationPackages = ['core', 'database', 'realtime', 'email', 'auth', 'api-contracts', 'api-client', 'ui'];

const importError = (names, message) => names.map((name) => ({ name, message }));

// ESLint flat config replaces a rule's options when a later block matches the same file, rather than
// merging them. So every block below states its complete restriction list, built from these parts.
const RAW_DB_MESSAGE = 'Query workspace data through scoped repositories from @openchat/database.';
const RAW_DB_PATHS = importError(['drizzle-orm'], RAW_DB_MESSAGE);
const RAW_DB_PATTERNS = [{ group: ['drizzle-orm/*', '@openchat/database/*'], message: RAW_DB_MESSAGE }];
const restrict = (paths = [], patterns = []) => ['error', { paths: [...RAW_DB_PATHS, ...paths], patterns: [...RAW_DB_PATTERNS, ...patterns] }];

const relayPaths = importError(
  installationPackages.map((p) => `@openchat/${p}`),
  RELAY_MESSAGE,
);
const relayPatterns = [{ group: ['@openchat/*/*', '**/api/src/**', '**/services/api/**', '**/packages/core/**'], message: RELAY_MESSAGE }];
const clientPaths = importError(SERVER_ONLY, 'Server code must not reach clients.');
const routePaths = importError(['@openchat/database'], 'Route handlers call modules, not repositories.');
const portablePatterns = [{ group: ['node:*', 'cloudflare:*'], message: 'This package must run in Workers, browsers, and React Native.' }];

export const boundaries = [
  {
    // Raw database access exists only inside packages/database. The package's exports map also
    // hides internal files, so this adds the rule for the ORM and driver themselves.
    files: ['packages/**/*.ts', 'services/**/*.ts', 'apps/**/*.{ts,tsx}'],
    ignores: ['packages/database/**'],
    rules: { 'no-restricted-imports': restrict() },
  },
  {
    files: ['services/*/src/routes/**/*.ts'],
    rules: { 'no-restricted-imports': restrict(routePaths) },
  },
  {
    // After the routes block, so that relay routes get the stricter list.
    files: ['services/notification-relay/**/*.ts'],
    rules: { 'no-restricted-imports': restrict(relayPaths, relayPatterns) },
  },
  {
    files: ['apps/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': restrict(clientPaths) },
  },
  {
    // Zod must not enter the widget bundle, so contracts may be imported as types only.
    files: ['apps/widget/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrict([
        ...clientPaths,
        {
          name: '@openchat/api-contracts',
          allowTypeImports: true,
          message: 'The widget may import contracts as types only, to keep Zod out of its bundle.',
        },
        { name: 'zod', message: 'Zod is too large for the widget.' },
      ]),
    },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict(
        importError(['hono', '@hono/zod-openapi', 'cloudflare:workers'], 'Domain code talks to ports, not to the platform.'),
      ),
    },
  },
  {
    files: ['packages/shared/**/*.ts', 'packages/notification-protocol/**/*.ts'],
    ignores: ['**/*.test.ts', '**/test/**'],
    rules: { 'no-restricted-imports': restrict([], portablePatterns) },
  },
  {
    // Anything that keeps these objects awake or does not survive hibernation is forbidden.
    files: ['packages/realtime/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: 'Blocks hibernation. Use an alarm, or let receivers expire state.' },
        { name: 'setInterval', message: 'Blocks hibernation. Use an alarm.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='WebSocket']",
          message: 'Outbound WebSockets block hibernation.',
        },
        {
          selector: "CallExpression[callee.property.name='accept'][callee.object.name=/[sS]erver|[wW]s|[sS]ocket/]",
          message: 'Use ctx.acceptWebSocket. ws.accept() prevents hibernation.',
        },
      ],
    },
  },
];

export default [
  { ignores: ['**/dist/**', '**/.assets/**', '**/.wrangler/**', '**/.turbo/**', '**/generated/**', 'docs/**', 'spikes/**', '**/node_modules/**', '.openchat/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly', fetch: 'readonly', setTimeout: 'readonly' } },
  },
  ...boundaries,
];
