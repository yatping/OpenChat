// Gathers the dashboard and widget builds into the one directory the Worker serves.
// Dashboard at the root, widget under /widget/, so that one deploy ships all of it.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const out = '.assets';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const dashboard = '../../apps/dashboard/dist';
const widget = '../../apps/widget/dist';
if (existsSync(dashboard)) cpSync(dashboard, out, { recursive: true });
else writeFileSync(`${out}/index.html`, '<!doctype html><title>OpenChat</title><p>Run pnpm build to build the dashboard.</p>');
if (existsSync(widget)) cpSync(widget, `${out}/widget`, { recursive: true });
