// Permissive packages must not depend on AGPL ones. See ADR-0011.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const AGPL = 'AGPL-3.0-or-later';
const APACHE = 'Apache-2.0';
const expected = {
  '@openchat/widget': APACHE,
  '@openchat/mobile': APACHE,
  '@openchat/api-client': APACHE,
  '@openchat/api-contracts': APACHE,
  '@openchat/notification-protocol': APACHE,
  '@openchat/shared': APACHE,
};

const packages = new Map();
for (const group of ['apps', 'services', 'packages', 'tooling']) {
  for (const name of readdirSync(group)) {
    const file = join(group, name, 'package.json');
    if (existsSync(file)) {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      packages.set(json.name, json);
    }
  }
}

const problems = [];
for (const [name, json] of packages) {
  const want = expected[name] ?? AGPL;
  if (json.license !== want) problems.push(`${name}: license is ${json.license}, expected ${want}`);
  if (json.license === APACHE) {
    // devDependencies are included: a build-time AGPL dependency in a permissive package is still
    // a boundary violation worth a human decision. Only shared tooling config is exempt.
    const deps = { ...json.dependencies, ...json.peerDependencies, ...json.devDependencies };
    for (const dep of Object.keys(deps)) {
      if (dep === '@openchat/tsconfig' || dep === '@openchat/eslint-config') continue;
      if (packages.get(dep)?.license === AGPL) problems.push(`${name} (${APACHE}) depends on ${dep} (${AGPL})`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Licences OK across ${packages.size} packages.`);
