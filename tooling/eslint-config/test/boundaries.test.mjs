// A lint rule that silently stops firing is worse than no rule, so each one is exercised here.
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import config from '../index.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config });

const rulesFired = async (code, filePath) => {
  const [result] = await eslint.lintText(code, { filePath: `${root}${filePath}` });
  return result.messages.map((m) => m.ruleId ?? m.message);
};

const cases = [
  ['relay importing core', "import { x } from '@openchat/core';\nexport { x };", 'services/notification-relay/src/a.ts', 'no-restricted-imports'],
  ['relay importing the API', "import { x } from '../../api/src/app';\nexport { x };", 'services/notification-relay/src/a.ts', 'no-restricted-imports'],
  ['raw ORM outside database', "import { sql } from 'drizzle-orm';\nexport { sql };", 'packages/core/src/a.ts', 'no-restricted-imports'],
  ['database internals', "import { x } from '@openchat/database/internal';\nexport { x };", 'services/api/src/a.ts', 'no-restricted-imports'],
  ['client importing server code', "import { x } from '@openchat/database';\nexport { x };", 'apps/dashboard/src/a.ts', 'no-restricted-imports'],
  ['widget importing a contract value', "import { x } from '@openchat/api-contracts';\nexport { x };", 'apps/widget/src/a.ts', 'no-restricted-imports'],
  ['widget importing zod', "import { z } from 'zod';\nexport { z };", 'apps/widget/src/a.ts', 'no-restricted-imports'],
  ['an address limit that ignores IPv6 networks', "limitKey('login-ip', ip);", 'packages/core/src/a.ts', 'no-restricted-syntax'],
  ['core importing hono', "import { Hono } from 'hono';\nexport { Hono };", 'packages/core/src/a.ts', 'no-restricted-imports'],
  ['route importing repositories', "import { x } from '@openchat/database';\nexport { x };", 'services/api/src/routes/a.ts', 'no-restricted-imports'],
  ['shared importing node', "import { x } from 'node:crypto';\nexport { x };", 'packages/shared/src/a.ts', 'no-restricted-imports'],
  ['protocol importing node', "import { x } from 'node:crypto';\nexport { x };", 'packages/notification-protocol/src/a.ts', 'no-restricted-imports'],
  ['setTimeout in a Durable Object', 'setTimeout(() => {}, 1);', 'packages/realtime/src/hub.ts', 'no-restricted-globals'],
  ['setInterval in a Durable Object', 'setInterval(() => {}, 1);', 'packages/realtime/src/hub.ts', 'no-restricted-globals'],
  ['outbound WebSocket in a Durable Object', "new WebSocket('wss://x');", 'packages/realtime/src/hub.ts', 'no-restricted-syntax'],
  ['server.accept() in a Durable Object', 'declare const server: { accept(): void };\nserver.accept();', 'packages/realtime/src/hub.ts', 'no-restricted-syntax'],
];

describe('architecture boundaries', () => {
  it.each(cases)('rejects %s', async (_name, code, filePath, rule) => {
    expect(await rulesFired(code, filePath)).toContain(rule);
  });

  it.each([
    ['relay importing the protocol', "import { x } from '@openchat/notification-protocol';\nexport { x };", 'services/notification-relay/src/a.ts'],
    ['widget importing contract types', "import type { X } from '@openchat/api-contracts';\nexport type { X };", 'apps/widget/src/a.ts'],
    ['API importing repositories outside routes', "import { x } from '@openchat/database';\nexport { x };", 'services/api/src/a.ts'],
  ])('allows %s', async (_name, code, filePath) => {
    expect(await rulesFired(code, filePath)).not.toContain('no-restricted-imports');
  });
});
