// Licence checks, after pnpm build. See ADR-0011 and docs/operations/licensing.md.
//   1. Each workspace package has the licence ADR-0011 gives it, and the licence texts are present.
//   2. A permissive package depends on no AGPL package, directly or through another workspace package.
//   3. What each component ships from third parties is allowed by its licence: the widget and dashboard
//      bundles as Vite lists them, the Workers as esbuild bundled them, and the app as its licences screen lists it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGPL, APACHE, CONFIG_PACKAGES, EXCEPTIONS, licenseOf, packageOfPath, PERMISSIVE_PACKAGES, thirdPartyProblems, workspaceClosure } from './licenses.mjs';

const problems = [];
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

for (const text of ['LICENSES/AGPL-3.0-or-later.txt', 'LICENSES/Apache-2.0.txt', 'LICENSE']) {
  if (!existsSync(text)) problems.push(`${text} is missing`);
}

const packages = new Map();
for (const group of ['apps', 'services', 'packages', 'tooling']) {
  for (const name of readdirSync(group)) {
    const file = join(group, name, 'package.json');
    if (existsSync(file)) packages.set(readJson(file).name, readJson(file));
  }
}

for (const [name, json] of packages) {
  const want = PERMISSIVE_PACKAGES.has(name) ? APACHE : AGPL;
  if (json.license !== want) problems.push(`${name}: license is ${json.license}, expected ${want}`);
  // devDependencies count: a permissive package's bundle can include them.
  if (want === APACHE) {
    for (const dep of workspaceClosure(name, packages)) {
      if (packages.get(dep).license === AGPL) problems.push(`${name} (${APACHE}) depends on ${dep} (${AGPL}), directly or through another package`);
    }
  }
}
for (const name of PERMISSIVE_PACKAGES) if (!packages.has(name)) problems.push(`${name} is listed as permissive but does not exist`);
for (const name of CONFIG_PACKAGES) if (!packages.has(name)) problems.push(`${name} is listed as shared config but does not exist`);

/** From Vite's build.license output. */
function viteBundle(file) {
  if (!existsSync(file)) {
    problems.push(`${file} not found. Run pnpm build first.`);
    return [];
  }
  return readJson(file).map((e) => ({ name: e.name, version: e.version, license: e.identifier ?? 'Unknown' }));
}

/** From esbuild's metafile, written by wrangler deploy --dry-run --metafile. Paths are relative to the Worker. */
function workerBundle(serviceDir) {
  const file = join(serviceDir, 'dist/bundle-meta.json');
  if (!existsSync(file)) {
    problems.push(`${file} not found. Run pnpm build first.`);
    return [];
  }
  const found = new Map();
  for (const input of Object.keys(readJson(file).inputs)) {
    const pkg = packageOfPath(input);
    if (!pkg || found.has(pkg.dir)) continue;
    const json = readJson(join(serviceDir, pkg.dir, 'package.json'));
    found.set(pkg.dir, { name: json.name ?? pkg.name, version: json.version, license: licenseOf(json) });
  }
  return [...found.values()];
}

/**
 * What is built into the app, from the list its licences screen shows. apps/mobile/scripts/licenses.mjs writes
 * it on a Mac, from the bundle and the pods, and the release build refuses to run if it is out of date.
 */
function appPackages() {
  return readJson('apps/mobile/src/about/third-party-licenses.json').map((e) => ({ name: e.name, version: e.version, license: e.license }));
}

const components = [
  ['@openchat/widget', APACHE, [...viteBundle('apps/widget/dist/.vite/license-widget.json'), ...viteBundle('apps/widget/dist/.vite/license-chat.json')]],
  ['@openchat/dashboard', AGPL, viteBundle('apps/dashboard/dist/.vite/license.json')],
  ['@openchat/api', AGPL, workerBundle('services/api')],
  ['@openchat/notification-relay', AGPL, workerBundle('services/notification-relay')],
  ['@openchat/mobile', APACHE, appPackages()],
];
let shipped = 0;
for (const [component, license, entries] of components) {
  shipped += entries.length;
  problems.push(...thirdPartyProblems(component, license, entries));
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error('\nSee docs/operations/licensing.md. A third-party exception needs a reason, in tooling/scripts/licenses.mjs.');
  process.exit(1);
}
console.log(`Licences OK: ${packages.size} workspace packages, ${shipped} third-party packages across ${components.length} components, ${Object.keys(EXCEPTIONS).length} exception(s).`);
