// Writes src/about/third-party-licenses.json: every third-party package built into the app, with its licence
// text, for the app's licences screen. Apache-2.0, MIT and BSD ask that their notices go with the binary.
//
//   node scripts/licenses.mjs           write it
//   node scripts/licenses.mjs --check   fail if the committed file is out of date
//
// Needs ios/ from `expo prebuild`, because the native side comes from ios/Podfile.lock. Three sources:
//   1. JavaScript: the packages in the Metro bundle, from its source map, so build-only tools are left out.
//   2. Native modules: the pods in Podfile.lock, each traced to the npm package it came from.
//   3. Libraries React Native compiles in (folly, boost, ...), which are in no npm package. Their licence texts
//      are in licenses/vendored/, taken from upstream at the versions React Native pins.
// See docs/operations/licensing.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(MOBILE, '../..');
const OUT = join(MOBILE, 'src/about/third-party-licenses.json');

/** In React Native 0.88.1's third-party podspecs and scripts/cocoapods/helpers.rb. Check them when React Native changes. */
const VENDORED = [
  { pod: 'boost', name: 'boost', version: '1.84.0', license: 'BSL-1.0' },
  { pod: 'DoubleConversion', name: 'double-conversion', version: '1.1.6', license: 'BSD-3-Clause' },
  { pod: 'fast_float', name: 'fast_float', version: '8.0.0', license: 'MIT' },
  { pod: 'fmt', name: 'fmt', version: '12.1.0', license: 'MIT' },
  { pod: 'glog', name: 'glog', version: '0.3.5', license: 'BSD-3-Clause' },
  { pod: 'RCT-Folly', name: 'folly', version: '2024.11.18.00', license: 'Apache-2.0' },
  { pod: 'SocketRocket', name: 'SocketRocket', version: '0.7.1', license: 'BSD-3-Clause' },
];

/** The package directory of a path through node_modules, or null. */
function packageDir(path) {
  const at = path.lastIndexOf('node_modules/');
  if (at === -1) return null;
  const rest = path.slice(at + 'node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return path.slice(0, at + 'node_modules/'.length + name.length);
}

function licenseText(dir) {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  return file ? readFileSync(join(dir, file), 'utf8').trim() : null;
}

/**
 * Meta publishes these without a licence file, under the MIT licence and copyright of react-native, which is in
 * the same repository. Their notice is that one.
 */
const SAME_AS_REACT_NATIVE = (name) => name.startsWith('@react-native/') || name.startsWith('metro-');

function fromPackage(dir) {
  const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const license = typeof json.license === 'string' ? json.license : (json.license?.type ?? 'Unknown');
  let text = licenseText(dir);
  if (!text && SAME_AS_REACT_NATIVE(json.name) && license === 'MIT') text = licenseText(dirname(createRequire(join(MOBILE, 'package.json')).resolve('react-native/package.json')));
  if (!text) throw new Error(`${json.name} has no licence file. Find its notice, and add a rule for it here`);
  return { name: json.name, version: json.version, license, text };
}

/** Packages in the Metro bundle, from an export with source maps. */
function bundledPackages() {
  const out = mkdtempSync(join(tmpdir(), 'oc-licenses-'));
  try {
    execFileSync('pnpm', ['exec', 'expo', 'export', '--platform', 'ios', '--source-maps', '--output-dir', out], {
      cwd: MOBILE,
      env: { ...process.env, CI: '1', APP_PROFILE: process.env.APP_PROFILE ?? 'production' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const maps = [];
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.map') && maps.push(join(dir, e.name))));
    walk(out);
    const dirs = new Set();
    for (const map of maps) {
      for (const source of JSON.parse(readFileSync(map, 'utf8')).sources) {
        // Paths are from the repository root, starting with a slash.
        const dir = packageDir(source);
        if (dir) dirs.add(join(ROOT, dir));
      }
    }
    return [...dirs];
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Native pods, each traced to its npm package, and the vendored libraries. */
function nativePackages() {
  const lock = join(MOBILE, 'ios/Podfile.lock');
  if (!existsSync(lock)) throw new Error('ios/Podfile.lock not found. Run: pnpm --filter @openchat/mobile exec expo prebuild --platform ios');
  const text = readFileSync(lock, 'utf8');
  const external = text.slice(text.indexOf('EXTERNAL SOURCES:'), text.indexOf('SPEC CHECKSUMS:'));
  const dirs = new Set();
  const vendored = [];
  let hermes = null;
  for (const [, pod, path] of external.matchAll(/^ {2}(\S+):\n {4}:(?:path|podspec): "?([^"\n]+)"?$/gm)) {
    // Hermes, the JavaScript engine, comes prebuilt with its own licence, from its own repository.
    if (pod === 'hermes-engine') {
      const tag = new RegExp(`^ {2}hermes-engine:\\n(?: {4}.*\\n)*? {4}:tag: (\\S+)`, 'm').exec(external)?.[1];
      hermes = { name: 'hermes', version: tag?.replace(/^hermes-v/, '') ?? 'unknown', license: 'MIT', text: readFileSync(join(MOBILE, 'ios/Pods/hermes-engine/LICENSE'), 'utf8').trim() };
      continue;
    }
    const known = VENDORED.find((v) => v.pod === pod);
    if (known) {
      vendored.push(known);
      continue;
    }
    const dir = packageDir(path);
    if (dir) dirs.add(resolve(MOBILE, 'ios', dir));
    // Facades and codegen output that React Native generates are part of react-native. Local modules are this app's own.
    else if (!/^build\/(rncore-facades|generated)\//.test(path) && !path.startsWith('../modules/')) throw new Error(`Pod ${pod} comes from ${path}, which this script cannot trace to a licence`);
  }
  if (/^ {2}SocketRocket\b/m.test(text) && !vendored.some((v) => v.pod === 'SocketRocket')) vendored.push(VENDORED.find((v) => v.pod === 'SocketRocket'));
  if (!hermes) throw new Error('Podfile.lock has no hermes-engine. Check how this React Native ships its engine');
  return { dirs: [...dirs], vendored, hermes };
}

const { dirs: native, vendored, hermes } = nativePackages();
const entries = new Map();
for (const dir of [...bundledPackages(), ...native]) {
  const entry = fromPackage(dir);
  if (entry.name.startsWith('@openchat/')) continue;
  entries.set(`${entry.name}@${entry.version}`, entry);
}
for (const v of vendored) {
  entries.set(`${v.name}@${v.version}`, { name: v.name, version: v.version, license: v.license, text: readFileSync(join(MOBILE, 'licenses/vendored', `${v.name}.txt`), 'utf8').trim() });
}
entries.set(`hermes@${hermes.version}`, hermes);
const list = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const json = `${JSON.stringify(list, null, 1)}\n`;

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== json) {
    console.error(`${OUT} is out of date. Run: pnpm --filter @openchat/mobile licenses, and commit it.`);
    process.exit(1);
  }
  console.log(`Licences up to date: ${list.length} packages.`);
} else {
  writeFileSync(OUT, json);
  console.log(`Wrote ${list.length} packages to src/about/third-party-licenses.json.`);
}
