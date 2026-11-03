// Widget size budgets from docs/plan/milestones.md. Runs against a built widget.
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const budgets = [['apps/widget/dist/widget.js', 5 * 1024]];
let failed = false;
for (const [file, limit] of budgets) {
  if (!existsSync(file)) {
    console.error(`${file} not found. Run pnpm build first.`);
    failed = true;
    continue;
  }
  const source = readFileSync(file);
  const size = gzipSync(source).length;
  console.log(`${file}: ${size} bytes gzipped (limit ${limit})`);
  if (size > limit) failed = true;
  if (source.includes('ZodError')) {
    console.error(`${file}: contains Zod, which must stay out of the widget.`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
