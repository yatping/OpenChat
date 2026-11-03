// A fast local check for secrets. CI also runs gitleaks, which covers far more patterns.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const patterns = [
  ['private key block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['Cloudflare API token assignment', /CLOUDFLARE_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{30,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
];
const forbiddenFiles = [/\.p8$/, /\.pem$/, /(^|\/)\.dev\.vars$/, /(^|\/)\.env$/];

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const problems = [];
for (const file of files) {
  if (forbiddenFiles.some((p) => p.test(file))) problems.push(`${file}: this file type must not be committed`);
  if (!existsSync(file) || file.endsWith('pnpm-lock.yaml') || file === 'tooling/scripts/check-secrets.mjs') continue;
  const text = readFileSync(file, 'utf8');
  for (const [name, pattern] of patterns) if (pattern.test(text)) problems.push(`${file}: ${name}`);
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`No secrets found in ${files.length} files.`);
