/**
 * Release versions, for `oc upgrade`. The version is the root package.json's. A deployment made before
 * versions were recorded is taken to be 0.1.0, the first tagged release.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The oldest deployed version this release can upgrade from in one step. Raise it when a release contracts
 * something that an older release still used, and say so in the release notes.
 */
export const UPGRADE_FROM_AT_LEAST = '0.1.0';
export const UNRECORDED_VERSION = '0.1.0';

export const releaseVersion = (root: string): string => (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;

/**
 * Whether `root` is the tagged release `v<version>` with no changes to tracked files. If it is not, the
 * project's source at that tag is not the source being deployed. Untracked files, such as .openchat/, are ignored.
 */
export function releaseCheckout(root: string, version: string): boolean {
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return git('tag', '--points-at', 'HEAD').split('\n').includes(`v${version}`) && git('status', '--porcelain', '--untracked-files=no') === '';
  } catch {
    return false;
  }
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Semantic version order, where a prerelease such as 0.2.0-dev comes before 0.2.0. */
export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [VERSION.exec(a), VERSION.exec(b)];
  if (!pa || !pb) throw new Error(`Not a version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  if (pa[4] === pb[4]) return 0;
  if (pa[4] === undefined) return 1;
  if (pb[4] === undefined) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}
