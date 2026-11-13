// Run by pnpm check:licenses, with node --test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGPL, allowedBy, APACHE, exceptionFor, licenseOf, packageOfPath, POLICIES, thirdPartyProblems, workspaceClosure } from './licenses.mjs';

test('a permissive component ships only permissive code', () => {
  assert.ok(allowedBy('MIT', POLICIES[APACHE]));
  assert.ok(allowedBy('(MIT OR Apache-2.0)', POLICIES[APACHE]));
  assert.ok(allowedBy('(BSD-3-Clause OR GPL-2.0)', POLICIES[APACHE]), 'the licensee may choose BSD');
  assert.ok(!allowedBy('MPL-2.0', POLICIES[APACHE]));
  assert.ok(!allowedBy('GPL-3.0-or-later', POLICIES[APACHE]));
  assert.ok(!allowedBy('MIT AND GPL-3.0-only', POLICIES[APACHE]), 'AND needs both');
  assert.ok(!allowedBy('Unknown', POLICIES[APACHE]));
  assert.ok(!allowedBy(undefined, POLICIES[APACHE]));
});

test('an AGPL component may also ship compatible copyleft, but not GPL-2.0-only', () => {
  assert.ok(allowedBy('MPL-2.0', POLICIES[AGPL]));
  assert.ok(allowedBy('LGPL-3.0-or-later', POLICIES[AGPL]));
  assert.ok(!allowedBy('GPL-2.0-only', POLICIES[AGPL]));
  assert.ok(!allowedBy('SSPL-1.0', POLICIES[AGPL]));
});

test('reads old licence forms, and finds the package of a bundled file', () => {
  assert.equal(licenseOf({ license: { type: 'MIT' } }), 'MIT');
  assert.equal(licenseOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }), 'MIT OR Apache-2.0');
  assert.equal(licenseOf({}), 'Unknown');
  assert.deepEqual(packageOfPath('../../node_modules/.pnpm/hono@4/node_modules/hono/dist/index.js'), { name: 'hono', dir: '../../node_modules/.pnpm/hono@4/node_modules/hono' });
  assert.deepEqual(packageOfPath('../../node_modules/.pnpm/@x+y@1/node_modules/@x/y/a.js'), { name: '@x/y', dir: '../../node_modules/.pnpm/@x+y@1/node_modules/@x/y' });
  assert.equal(packageOfPath('src/index.ts'), null);
});

test('follows workspace dependencies through other packages, but not shared config', () => {
  const packages = new Map([
    ['@openchat/widget', { devDependencies: { '@openchat/api-client': '*', '@openchat/tsconfig': '*' } }],
    ['@openchat/api-client', { dependencies: { '@openchat/core': '*' } }],
    ['@openchat/core', {}],
    ['@openchat/tsconfig', {}],
  ]);
  assert.deepEqual([...workspaceClosure('@openchat/widget', packages)].sort(), ['@openchat/api-client', '@openchat/core']);
});

test('names what a component may not ship, and honours an exception', () => {
  const entries = [
    { name: 'preact', version: '11.1.0', license: 'MIT' },
    { name: 'copyleft-lib', version: '1.0.0', license: 'GPL-3.0-only' },
    { name: 'lightningcss-linux-x64-gnu', version: '1.0.0', license: 'MPL-2.0' },
  ];
  const exceptions = { lightningcss: 'A build tool' };
  assert.deepEqual(thirdPartyProblems('@openchat/mobile', APACHE, entries, exceptions), ['@openchat/mobile (Apache-2.0) ships copyleft-lib@1.0.0, licensed GPL-3.0-only']);
  assert.equal(thirdPartyProblems('@openchat/mobile', APACHE, entries).length, 2, 'without the exception, both are named');
  assert.equal(exceptionFor('lightningcss-linux-x64-gnu', exceptions), 'lightningcss');
  assert.equal(exceptionFor('lightningcssish', exceptions), undefined);
});
