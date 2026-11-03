// Writes generated/openapi.json. With --check, fails if the committed file is out of date.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../src/document';

const file = join(dirname(fileURLToPath(import.meta.url)), '../generated/openapi.json');
const next = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (!existsSync(file) || readFileSync(file, 'utf8') !== next) {
    console.error('generated/openapi.json is out of date. Run pnpm contracts:generate.');
    process.exit(1);
  }
  console.log('OpenAPI document is up to date.');
} else {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  console.log(`Wrote ${file}`);
}
