// Widget size budgets from docs/plan/milestones.md. Runs against a built widget.
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const budgets = [
  ['apps/widget/dist/widget.js', 5 * 1024],
  ['apps/widget/dist/chat.js', 40 * 1024],
];
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
  // A classic script can be decoded with the encoding of the page around it.
  const foreign = source.findIndex((byte) => byte > 127);
  if (foreign !== -1) {
    console.error(`${file}: has a non-ASCII byte at ${foreign}: ${source.subarray(Math.max(0, foreign - 30), foreign + 10).toString()}`);
    failed = true;
  }
  if (source.includes('ZodError')) {
    console.error(`${file}: contains Zod, which must stay out of the widget.`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
