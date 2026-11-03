// Fails if the Drizzle schema has changes with no migration. Generating is the only reliable diff,
// so this generates, reports, and removes anything it created.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const snapshot = () => new Set(readdirSync('migrations', { recursive: true }).map(String));
const before = snapshot();
const journalPath = 'migrations/meta/_journal.json';
const journal = readFileSync(journalPath);
const output = execFileSync('pnpm', ['exec', 'drizzle-kit', 'generate'], { encoding: 'utf8' });
const added = [...snapshot()].filter((f) => !before.has(f));
if (added.length > 0) {
  for (const f of added) rmSync(`migrations/${f}`, { force: true });
  writeFileSync(journalPath, journal);
  console.error(`Schema and migrations disagree. Run pnpm db:generate.\nA new migration would add: ${added.join(', ')}`);
  process.exit(1);
}
if (!output.includes('No schema changes')) console.warn(output);
console.log('Schema and migrations agree.');
