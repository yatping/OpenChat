// The licence policy that check-licenses.mjs applies. See ADR-0011 and docs/operations/licensing.md.

export const AGPL = 'AGPL-3.0-or-later';
export const APACHE = 'Apache-2.0';

/** Packages under Apache-2.0. Every other workspace package is AGPL-3.0-or-later. */
export const PERMISSIVE_PACKAGES = new Set(['@openchat/widget', '@openchat/api-client', '@openchat/api-contracts', '@openchat/notification-protocol', '@openchat/shared']);

/** Shared build configuration, which ships in nothing. */
export const CONFIG_PACKAGES = new Set(['@openchat/tsconfig', '@openchat/eslint-config']);

/** Licences any component may ship: they ask only for notices, which the build publishes. */
const PERMISSIVE = ['MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'Zlib', 'Python-2.0', 'CC-BY-4.0', 'BSL-1.0'];

/** Copyleft licences that AGPL-3.0-or-later code can include. GPL-2.0-only cannot be, so it is absent. */
const AGPL_COMPATIBLE = ['MPL-2.0', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later'];

export const POLICIES = {
  [APACHE]: new Set(PERMISSIVE),
  [AGPL]: new Set([...PERMISSIVE, ...AGPL_COMPATIBLE]),
};

/**
 * Third-party packages allowed outside their policy, each with the reason. Each one is a human decision: add
 * one only with a reason a reviewer can check.
 */
export const EXCEPTIONS = {};

/** The exception that covers a package, if any. Platform builds such as lightningcss-linux-x64-gnu share their package's. */
export const exceptionFor = (name, exceptions = EXCEPTIONS) => Object.keys(exceptions).find((base) => name === base || name.startsWith(`${base}-`));

/**
 * Whether an SPDX expression is allowed by a policy. `A OR B` needs one side allowed, since the licensee
 * chooses; `A AND B` needs both. Parentheses are not nested in practice and are dropped.
 */
export function allowedBy(expression, policy) {
  if (typeof expression !== 'string' || expression.trim() === '') return false;
  const alternatives = expression.replace(/[()]/g, ' ').split(/\s+OR\s+/i);
  return alternatives.some((alternative) => alternative.split(/\s+AND\s+/i).every((id) => policy.has(id.trim())));
}

/** A package.json's licence as an SPDX expression, including the old `license: { type }` and `licenses: []` forms. */
export function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  return 'Unknown';
}

/** The package directory of a bundled file, from a path through node_modules. Null for the project's own code. */
export function packageOfPath(path) {
  const at = path.lastIndexOf('node_modules/');
  if (at === -1) return null;
  const rest = path.slice(at + 'node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return { name, dir: path.slice(0, at + 'node_modules/'.length + name.length) };
}

/** Workspace packages that `name` depends on, directly or through other workspace packages. */
export function workspaceClosure(name, packages) {
  const seen = new Set();
  const visit = (current) => {
    const json = packages.get(current);
    if (!json) return;
    for (const dep of Object.keys({ ...json.dependencies, ...json.peerDependencies, ...json.devDependencies })) {
      if (!packages.has(dep) || CONFIG_PACKAGES.has(dep) || seen.has(dep)) continue;
      seen.add(dep);
      visit(dep);
    }
  };
  visit(name);
  return seen;
}

/**
 * Problems with third-party packages shipped by a component under `license`. `entries` are { name, version,
 * license }. Returns readable lines.
 */
export function thirdPartyProblems(component, license, entries, exceptions = EXCEPTIONS) {
  const policy = POLICIES[license];
  const problems = [];
  for (const entry of entries) {
    if (entry.name.startsWith('@openchat/')) continue;
    if (allowedBy(entry.license, policy) || exceptionFor(entry.name, exceptions)) continue;
    problems.push(`${component} (${license}) ships ${entry.name}@${entry.version}, licensed ${entry.license}`);
  }
  return problems;
}
