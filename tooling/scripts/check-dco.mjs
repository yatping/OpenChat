// Every commit in a pull request needs a Signed-off-by line matching its author. See CONTRIBUTING.md.
import { execFileSync } from 'node:child_process';

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('Usage: check-dco.mjs <base> <head>');
  process.exit(2);
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const commits = git('rev-list', '--no-merges', `${base}..${head}`).split('\n').filter(Boolean);
const missing = commits.filter((sha) => {
  const email = git('show', '-s', '--format=%ae', sha).trim().toLowerCase();
  const body = git('show', '-s', '--format=%B', sha);
  return !body.split('\n').some((line) => line.toLowerCase().startsWith('signed-off-by:') && line.toLowerCase().includes(`<${email}>`));
});
if (missing.length > 0) {
  console.error(`These commits have no matching Signed-off-by line:\n${missing.join('\n')}\nFix with: git rebase --signoff ${base}`);
  process.exit(1);
}
console.log(`All ${commits.length} commits are signed off.`);
