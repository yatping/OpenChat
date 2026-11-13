// Gathers the dashboard and widget builds into the one directory the Worker serves.
// Dashboard at the root, widget under /widget/, so that one deploy ships all of it.
// Each also gets third-party-licenses.txt, the notices its bundled packages ask for, from Vite's build.license
// output, which itself is not served. See docs/operations/licensing.md.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const out = '.assets';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const dashboard = '../../apps/dashboard/dist';
const widget = '../../apps/widget/dist';

/** One plain-text file of notices from Vite's license JSON files, without duplicates. */
function notices(component, files) {
  const seen = new Map();
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const entry of JSON.parse(readFileSync(file, 'utf8'))) seen.set(`${entry.name}@${entry.version}`, entry);
  }
  const rule = '-'.repeat(72);
  const sections = [...seen.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `${rule}\n${e.name} ${e.version}\nLicence: ${e.identifier ?? 'not stated'}\n\n${(e.text ?? 'No licence text was found in the package.').trim()}\n`);
  return `${component} is part of OpenChat. Source: https://github.com/yatping/OpenChat\n\nIt includes the following third-party packages, under these licences.\n\n${sections.join('\n')}`;
}

const copy = (from, to) => cpSync(from, to, { recursive: true, filter: (src) => !src.includes('/.vite') });

if (existsSync(dashboard)) {
  copy(dashboard, out);
  writeFileSync(`${out}/third-party-licenses.txt`, notices('The OpenChat dashboard', [`${dashboard}/.vite/license.json`]));
} else {
  writeFileSync(`${out}/index.html`, '<!doctype html><title>OpenChat</title><p>Run pnpm build to build the dashboard.</p>');
}
if (existsSync(widget)) {
  copy(widget, `${out}/widget`);
  writeFileSync(`${out}/widget/third-party-licenses.txt`, notices('The OpenChat website widget', [`${widget}/.vite/license-widget.json`, `${widget}/.vite/license-chat.json`]));
}
