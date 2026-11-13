import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type BackupManifest, compareCounts, countSql, foreignKeys, orderRows, parentFirst, stamp } from '../src/backup';
import { createDeployer, type State } from '../src/deploy';

const template = readFileSync(new URL('../../../services/api/wrangler.template.jsonc', import.meta.url), 'utf8');
const BASE = 'https://oc-acme.acme.workers.dev';
const OLD_ID = '11111111-2222-3333-4444-555555555555';
const NEW_ID = '99999999-8888-7777-6666-555555555555';
const BOOKMARK = '00000003-00000000-0000511b-15233f10c52b5ad69bdbbcdb0d1708a4';
const NOW = new Date('2026-11-13T02:43:09Z');
/** Stands in for content that must never reach the terminal. */
const PRIVATE = 'a visitor wrote something private';
const SCHEMA = 'CREATE TABLE attachments(workspace_id TEXT REFERENCES workspaces(id));\nCREATE TABLE workspaces(id TEXT);\n';
/** As Wrangler writes it: alphabetical, so a row of `attachments` comes before the workspace it belongs to. */
const DATA = `PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "attachments" VALUES('w1');\nINSERT INTO "installation" VALUES('inst_1');\nINSERT INTO "messages" VALUES('${PRIVATE}');\nINSERT INTO "workspaces" VALUES('w1');\n`;
/** Every table before any row, and every row after the rows it refers to. */
const EXPORT = `${SCHEMA}PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "workspaces" VALUES('w1');\nINSERT INTO "attachments" VALUES('w1');\nINSERT INTO "installation" VALUES('inst_1');\nINSERT INTO "messages" VALUES('${PRIVATE}');\n`;
const COUNTS = { d1_migrations: 13, installation: 1, messages: 2 };

interface Options {
  state?: Partial<State>;
  /** Rows the restored database reports, if not the same as the backup's. */
  remoteCounts?: Record<string, number>;
  failLocalLoad?: boolean;
  localCounts?: Record<string, number>;
  /** The Worker answers 500 while it uses the new database. */
  unhealthyOnNewDatabase?: boolean;
  /** A migration runs between the exports. */
  schemaChanges?: boolean;
  /** Rows that refer to rows the export does not hold. */
  dangling?: { table: string }[];
  /** What Wrangler writes as the data export, if not DATA. */
  data?: string;
}

function setup(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oc-backup-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  mkdirSync(join(root, 'services/api'), { recursive: true });
  writeFileSync(join(root, 'services/api/wrangler.template.jsonc'), template);
  mkdirSync(join(root, '.openchat/acme'), { recursive: true });
  const initial: State = { name: 'acme', d1DatabaseId: OLD_ID, deployed: true, initialized: true, secretsSet: true, publicBaseUrl: BASE, version: '0.2.0', ...options.state };
  writeFileSync(join(root, '.openchat/acme/state.json'), JSON.stringify(initial));

  const calls: string[] = [];
  const rendered = () => JSON.parse(readFileSync(join(root, '.openchat/acme/api.wrangler.jsonc'), 'utf8')) as { d1_databases: { database_name: string; database_id: string }[] };
  const counts = (where: Record<string, number>, sql: string) =>
    JSON.stringify([{ results: sql.startsWith('SELECT name FROM sqlite_master') ? Object.keys(where).map((name) => ({ name })) : sql.includes('d1_migrations ORDER BY') ? [{ name: '0013_audit_log_recent.sql' }] : [Object.fromEntries(Object.keys(where).filter((t) => sql.includes(`AS "${t}"`)).map((t) => [t, where[t]]))] }]);
  const wrangler = (args: string[]) => {
    const key = args
      .filter((a) => !a.startsWith('../'))
      .join(' ')
      .replace(/ -c( |$)/, '$1')
      .replace(/\S*oc-backup-check-\w+/, 'TMP');
    calls.push(key.replace(/ --command .*/, ' --command …'));
    if (key.startsWith('d1 time-travel info')) return JSON.stringify({ bookmark: BOOKMARK });
    if (key.startsWith('d1 export')) {
      const output = args[args.indexOf('--output') + 1]!;
      const changed = options.schemaChanges && output.endsWith('.schema-after');
      writeFileSync(output, args.includes('--no-data') ? (changed ? `${SCHEMA}CREATE TABLE added(id TEXT);\n` : SCHEMA) : (options.data ?? DATA));
      return '';
    }
    if (key.includes('--local') && key.includes('--file')) {
      if (options.failLocalLoad) throw Object.assign(new Error('failed'), { stderr: 'near "INSERT": syntax error' });
      return '';
    }
    const command = args[args.indexOf('--command') + 1] ?? '';
    if (command === 'PRAGMA foreign_key_check') return JSON.stringify([{ results: options.dangling ?? [] }]);
    if (key.includes('--local') && key.includes('--command')) return counts(options.localCounts ?? COUNTS, command);
    if (key.includes('--remote') && key.includes('--command')) return counts(options.remoteCounts ?? COUNTS, command);
    if (key.startsWith('d1 create')) return `✅ Successfully created DB '${args[2]}'\n"database_id": "${NEW_ID}"`;
    if (key.startsWith('d1 info')) return JSON.stringify({ uuid: args[2] === 'oc-acme' ? OLD_ID : NEW_ID, name: args[2] });
    return '';
  };
  const fakeFetch = (async (url: string) => {
    if (options.unhealthyOnNewDatabase && rendered().d1_databases[0]!.database_id === NEW_ID) return new Response('', { status: 500 });
    if (url.endsWith('/auth/login')) return new Response('', { status: 401 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const lines: string[] = [];
  const deployer = createDeployer(root, { wrangler, fetch: fakeFetch, wait: async () => undefined, build: () => undefined, log: (line: string) => void lines.push(line), now: () => NOW });
  const state = () => JSON.parse(readFileSync(join(root, '.openchat/acme/state.json'), 'utf8')) as State;
  return { root, deployer, calls, lines, state, rendered };
}

const mode = (path: string) => statSync(path).mode & 0o777;

async function backedUp() {
  const t = setup();
  const file = await t.deployer.backup('acme');
  t.calls.length = 0;
  t.lines.length = 0;
  return { ...t, file };
}

describe('oc backup', () => {
  it('exports the database, proves the export loads, and writes a manifest, all readable only by this user', async () => {
    const { root, deployer, calls, lines } = setup();
    const file = await deployer.backup('acme');
    expect(file).toBe(join(root, '.openchat/acme/backups/acme-20261113-0243.sql'));
    expect(calls).toEqual([
      'd1 time-travel info oc-acme --json',
      `d1 export oc-acme --remote --no-data --output ${file}.schema --skip-confirmation`,
      `d1 export oc-acme --remote --no-schema --output ${file}.data --skip-confirmation`,
      `d1 export oc-acme --remote --no-data --output ${file}.schema-after --skip-confirmation`,
      'd1 execute oc-acme --local --persist-to TMP --yes --file ' + file,
      'd1 execute oc-acme --local --persist-to TMP --json --yes --command …',
      'd1 execute oc-acme --local --persist-to TMP --json --yes --command …',
      'd1 execute oc-acme --local --persist-to TMP --json --yes --command …',
      'd1 execute oc-acme --local --persist-to TMP --json --yes --command …',
    ]);
    const manifest = JSON.parse(readFileSync(file.replace(/\.sql$/, '.json'), 'utf8')) as BackupManifest;
    expect(manifest).toMatchObject({ format: 1, deployment: 'acme', database: { name: 'oc-acme', id: OLD_ID }, release: '0.2.0', bookmark: BOOKMARK, migration: '0013_audit_log_recent.sql', bytes: EXPORT.length, tables: COUNTS });
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect([mode(join(root, '.openchat/acme/backups')), mode(file), mode(file.replace(/\.sql$/, '.json'))]).toEqual([0o700, 0o600, 0o600]);
    expect(readFileSync(file, 'utf8')).toBe(EXPORT);
    expect(readdirSync(join(root, '.openchat/acme/backups'), { withFileTypes: false }).sort()).toEqual(['acme-20261113-0243.json', 'acme-20261113-0243.sql']);
    expect(lines.join('\n')).toContain('Backed up acme: 1 KB, 3 tables, 16 rows');
    expect(lines.join('\n')).not.toContain(PRIVATE);
    expect(JSON.stringify(manifest)).not.toContain(PRIVATE);
  });

  it('refuses an export with rows that refer to rows it does not hold', async () => {
    await expect(setup({ dangling: [{ table: 'messages' }, { table: 'messages' }] }).deployer.backup('acme')).rejects.toThrow(/2 rows refer to rows that are not there, in messages/);
  });

  it('refuses an export not written one statement to a line, and keeps nothing', async () => {
    const { root, deployer } = setup({ data: `PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "messages" VALUES('line one\nline two');\n` });
    await expect(deployer.backup('acme')).rejects.toThrow(/one INSERT on each line/);
    expect(readdirSync(join(root, '.openchat/acme/backups'))).toEqual([]);
  });

  it('refuses when a migration ran during the export, and keeps nothing', async () => {
    const { root, deployer } = setup({ schemaChanges: true });
    await expect(deployer.backup('acme')).rejects.toThrow(/The schema changed while the backup ran/);
    expect(readdirSync(join(root, '.openchat/acme/backups'))).toEqual([]);
  });

  it('writes where --out says', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'oc-out-')), 'nested');
    const file = await setup().deployer.backup('acme', { out });
    expect(file).toBe(join(out, 'acme-20261113-0243.sql'));
    expect(mode(out)).toBe(0o700);
  });

  it('is not called good when the export does not load, or holds no installation', async () => {
    await expect(setup({ failLocalLoad: true }).deployer.backup('acme')).rejects.toThrow(/did not load into a local database, so it is not a usable backup/);
    const empty = setup({ localCounts: { d1_migrations: 13 } });
    await expect(empty.deployer.backup('acme')).rejects.toThrow(/holds no installation/);
    expect(existsSync(join(empty.root, '.openchat/acme/backups/acme-20261113-0243.json'))).toBe(false);
  });

  it('needs a deployment', async () => {
    await expect(setup({ state: { initialized: false } }).deployer.backup('acme')).rejects.toThrow(/No deployment named acme/);
  });
});

describe('oc restore', () => {
  it('changes nothing without --confirm and the deployment name', async () => {
    const { deployer, calls, state } = setup();
    for (const confirm of [undefined, 'other']) {
      await expect(deployer.restore('acme', { confirm, bookmark: BOOKMARK })).rejects.toThrow(/add --confirm acme. Nothing was changed/);
    }
    expect(calls).toEqual([]);
    expect(state().lastRestore).toBeUndefined();
  });

  it('with Time Travel, records the bookmark that undoes it before restoring', async () => {
    const { deployer, calls, lines, state } = setup();
    await deployer.restore('acme', { confirm: 'acme', timestamp: '2026-11-12T10:00:00Z' });
    expect(calls).toEqual(['d1 time-travel info oc-acme --json', 'd1 time-travel restore oc-acme --timestamp 2026-11-12T10:00:00Z --json']);
    expect(state().lastRestore).toEqual({ at: NOW.toISOString(), kind: 'time-travel', undoBookmark: BOOKMARK, source: '--timestamp 2026-11-12T10:00:00Z' });
    expect(lines.join('\n')).toContain(`pnpm oc restore --env acme --bookmark ${BOOKMARK} --confirm acme`);
  });

  it('from a backup, loads it into a new database, checks every table, and only then switches the Worker', async () => {
    const { deployer, calls, lines, state, rendered, file } = await backedUp();
    await deployer.restore('acme', { confirm: 'acme', from: file });
    expect(calls).toEqual([
      'd1 create oc-acme-20261113-0243',
      `d1 execute oc-acme-20261113-0243 --remote --yes --file ${file}`,
      'd1 execute oc-acme-20261113-0243 --remote --json --yes --command …',
      'd1 execute oc-acme-20261113-0243 --remote --json --yes --command …',
      'd1 migrations apply oc-acme-20261113-0243 --remote',
      'deploy',
    ]);
    expect(state()).toMatchObject({ d1DatabaseId: NEW_ID, d1DatabaseName: 'oc-acme-20261113-0243', lastRestore: { kind: 'file', previousDatabase: { name: 'oc-acme', id: OLD_ID }, source: 'acme-20261113-0243.sql' } });
    expect(rendered().d1_databases[0]).toMatchObject({ database_name: 'oc-acme-20261113-0243', database_id: NEW_ID });
    expect(lines.join('\n')).toContain('pnpm oc restore --env acme --database oc-acme --confirm acme');
    expect(lines.join('\n')).not.toContain(PRIVATE);
  });

  it('then uses the new database for everything else, and can go back to the old one', async () => {
    const { deployer, calls, state, rendered, file } = await backedUp();
    await deployer.restore('acme', { confirm: 'acme', from: file });
    calls.length = 0;
    await deployer.backup('acme', { out: join(mkdtempSync(join(tmpdir(), 'oc-out-'))) });
    expect(calls[1]).toMatch(/^d1 export oc-acme-20261113-0243 --remote --no-data /);

    calls.length = 0;
    await deployer.restore('acme', { confirm: 'acme', database: 'oc-acme' });
    expect(calls).toEqual(['d1 info oc-acme --json', 'd1 migrations apply oc-acme --remote', 'deploy']);
    expect(state().d1DatabaseId).toBe(OLD_ID);
    expect(state().d1DatabaseName).toBeUndefined();
    expect(state().lastRestore).toMatchObject({ kind: 'database', previousDatabase: { name: 'oc-acme-20261113-0243', id: NEW_ID } });
    expect(rendered().d1_databases[0]).toMatchObject({ database_name: 'oc-acme', database_id: OLD_ID });
    await expect(deployer.restore('acme', { confirm: 'acme', database: 'oc-acme' })).rejects.toThrow(/already uses oc-acme/);
  });

  it('refuses a backup that changed, belongs elsewhere, or has no manifest, before creating anything', async () => {
    const { deployer, calls, root, file } = await backedUp();
    writeFileSync(file, `${EXPORT}DROP TABLE messages;\n`);
    await expect(deployer.restore('acme', { confirm: 'acme', from: file })).rejects.toThrow(/has changed since it was made/);

    const other = join(root, 'other.sql');
    writeFileSync(other, EXPORT);
    writeFileSync(join(root, 'other.json'), JSON.stringify({ format: 1, deployment: 'globex', tables: {} }));
    await expect(deployer.restore('acme', { confirm: 'acme', from: other })).rejects.toThrow(/a backup of globex, not acme/);

    const bare = join(root, 'bare.sql');
    writeFileSync(bare, EXPORT);
    await expect(deployer.restore('acme', { confirm: 'acme', from: bare })).rejects.toThrow(/has no manifest/);
    expect(calls).toEqual([]);
  });

  it('leaves the Worker alone when the new database does not hold every row', async () => {
    const t = await backedUp();
    const short = setup({ remoteCounts: { d1_migrations: 13, installation: 1, messages: 1 } });
    mkdirSync(join(short.root, '.openchat/acme/backups'), { recursive: true });
    for (const ext of ['sql', 'json']) writeFileSync(join(short.root, `.openchat/acme/backups/acme-20261113-0243.${ext}`), readFileSync(t.file.replace(/sql$/, ext)));
    await expect(short.deployer.restore('acme', { confirm: 'acme', from: join(short.root, '.openchat/acme/backups/acme-20261113-0243.sql') })).rejects.toThrow(/messages: expected 2, found 1/);
    expect(short.calls).not.toContain('deploy');
    expect(short.state()).toMatchObject({ d1DatabaseId: OLD_ID });
    expect(short.state().d1DatabaseName).toBeUndefined();
  });

  it('switches back when the Worker is unhealthy on the new database', async () => {
    const t = setup({ unhealthyOnNewDatabase: true });
    const file = await t.deployer.backup('acme');
    t.calls.length = 0;
    await expect(t.deployer.restore('acme', { confirm: 'acme', from: file })).rejects.toThrow(/so acme uses oc-acme again, unchanged/);
    expect(t.calls.filter((c) => c === 'deploy')).toHaveLength(2);
    expect(t.state()).toMatchObject({ d1DatabaseId: OLD_ID });
    expect(t.state().lastRestore).toBeUndefined();
    expect(t.rendered().d1_databases[0]).toMatchObject({ database_name: 'oc-acme', database_id: OLD_ID });
  });
});

describe('helpers', () => {
  it('stamp names by the minute, in UTC', () => {
    expect(stamp(new Date('2026-01-02T03:04:59.999Z'))).toBe('20260102-0304');
  });

  it('count tables in subqueries, quoting names, at most 50 to a query', () => {
    expect(countSql(['a', 'we"ird'])).toEqual(['SELECT (SELECT COUNT(*) FROM "a") AS "a", (SELECT COUNT(*) FROM "we""ird") AS "we""ird"']);
    const many = countSql(Array.from({ length: 120 }, (_, i) => `t${i}`));
    expect(many.map((q) => q.match(/COUNT/g)!.length)).toEqual([50, 50, 20]);
  });

  it('read foreign keys from the schema, leaving out a table that refers to itself', () => {
    const schema = 'CREATE TABLE IF NOT EXISTS "d1_migrations"(\n id INTEGER);\nCREATE TABLE `contacts` (\n\t`merged_into` text REFERENCES contacts(id),\n\tFOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)\n);\nCREATE TABLE `workspaces` (\n\t`id` text\n);\n';
    expect(foreignKeys(schema)).toEqual(new Map([['d1_migrations', new Set()], ['contacts', new Set(['workspaces'])], ['workspaces', new Set()]]));
  });

  it('put every table after the tables it refers to, and survive a cycle', () => {
    const graph = new Map([['messages', new Set(['conversations', 'workspaces'])], ['conversations', new Set(['workspaces', 'contacts'])], ['contacts', new Set(['workspaces'])], ['a', new Set(['b'])], ['b', new Set(['a'])]]);
    expect(parentFirst(['messages', 'conversations', 'contacts', 'workspaces', 'outbox'], graph)).toEqual(['workspaces', 'contacts', 'conversations', 'messages', 'outbox']);
    expect(parentFirst(['a', 'b'], graph)).toEqual(['b', 'a']);
  });

  it('order rows without losing or changing any, keeping each table in the order it was written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-rows-'));
    const data = join(dir, 'data.sql');
    writeFileSync(data, `PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "b" VALUES(1);\nINSERT INTO "a" VALUES(replace('x\\ny','\\n',char(10)));\nINSERT INTO "b" VALUES(2);\nINSERT INTO "we""ird" VALUES(3);\n`);
    const out = join(dir, 'out.sql');
    writeFileSync(out, 'SCHEMA\n');
    await orderRows(data, 'CREATE TABLE b (x REFERENCES a(id));\nCREATE TABLE a (id);\n', out, mkdtempSync(join(dir, 's-')));
    expect(readFileSync(out, 'utf8')).toBe(`SCHEMA\nPRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "a" VALUES(replace('x\\ny','\\n',char(10)));\nINSERT INTO "b" VALUES(1);\nINSERT INTO "b" VALUES(2);\nINSERT INTO "we""ird" VALUES(3);\n`);
  });

  it('report tables that differ, or are missing on either side', () => {
    expect(compareCounts({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual([]);
    expect(compareCounts({ a: 1, b: 2 }, { a: 1, c: 0 })).toEqual(['b: expected 2, found no table', 'c: expected no table, found 0']);
  });
});
