/**
 * `oc backup` and `oc restore`. See docs/operations/backup-and-restore.md.
 *
 * A backup is an SQL export, made with Wrangler, of the deployment's D1 database, kept on this computer, with a manifest
 * of row counts and a hash. Every backup is loaded into a throwaway local database before it is called good,
 * because a backup that has never been loaded is not known to be one.
 *
 * Restoring has three forms, each needing `--confirm <name>`:
 * - Time Travel, in place, to a bookmark or a time in the last 30 days. Records a bookmark first, so it can be undone.
 * - From a backup file, into a new database. The Worker then switches to it, and the old database is kept.
 * - Back to an existing database, by name, to undo the form above.
 *
 * A backup holds personal data and message content. Its files are readable only by this user, and nothing
 * from inside one is ever printed.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, join } from 'node:path';
import type { RunWrangler } from './wrangler';
import { describeFailure, UUID } from './wrangler';

export interface BackupManifest {
  format: 1;
  deployment: string;
  database: { name: string; id: string };
  /** The OpenChat release deployed when the backup was made. */
  release: string | undefined;
  /** A Time Travel bookmark from just before the export, for a restore in place within 30 days. */
  bookmark: string;
  createdAt: string;
  /** The newest migration in the backup. */
  migration: string | null;
  sha256: string;
  bytes: number;
  /** Rows in each table, counted after loading the file into a throwaway local database. */
  tables: Record<string, number>;
}

export interface RestoreRecord {
  at: string;
  kind: 'time-travel' | 'file' | 'database';
  /** For Time Travel: the bookmark from just before the restore, which undoes it. */
  undoBookmark?: string;
  /** For a switch of database: the one the Worker used before, which is kept. */
  previousDatabase?: { name: string; id: string };
  source: string;
}

/** What `oc backup` and `oc restore` need from the deployer. */
export interface BackupContext<S extends BackupState> {
  wrangler: RunWrangler;
  log: (line: string) => void;
  load: (name: string) => S;
  save: (state: S) => void;
  render: (state: S) => void;
  migrate: (state: S) => void;
  deployWorker: (state: S) => void;
  verify: (state: S) => Promise<void>;
  configPath: (name: string) => string;
  dirOf: (name: string) => string;
  release: string;
  now?: () => Date;
}

export interface BackupState {
  name: string;
  d1DatabaseId?: string;
  d1DatabaseName?: string | undefined;
  initialized?: boolean;
  publicBaseUrl?: string;
  version?: string;
  lastRestore?: RestoreRecord;
}

export type RestoreOptions = { confirm: string | undefined } & ({ bookmark: string } | { timestamp: string } | { from: string } | { database: string });

/** The database a deployment uses now. It changes only when a backup is restored into a new one. */
export const databaseName = (state: { name: string; d1DatabaseName?: string | undefined }) => state.d1DatabaseName ?? `oc-${state.name}`;

/** Tables of the application. SQLite's and Cloudflare's own are left out, as the export leaves them out. */
export const TABLES_SQL = `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`;

const quote = (table: string) => `"${table.replaceAll('"', '""')}"`;

/**
 * Queries that count every table, one row of one column per table. D1 refuses a UNION ALL of 31 SELECTs as
 * too many terms, so each table is a subquery instead, and at most 50 go in one query.
 */
export const countSql = (tables: string[]): string[] => {
  const queries: string[] = [];
  for (let i = 0; i < tables.length; i += 50) {
    queries.push(`SELECT ${tables.slice(i, i + 50).map((t) => `(SELECT COUNT(*) FROM ${quote(t)}) AS ${quote(t)}`).join(', ')}`);
  }
  return queries;
};

type D1Result = { results?: Record<string, unknown>[] }[];
const rows = (output: string) => (JSON.parse(output) as D1Result)[0]?.results ?? [];

/** A minute-precise stamp, safe in file and database names: 20261113-0243. */
export const stamp = (date: Date) => date.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

/** Rows that differ between what a backup says it holds and what a database holds. Empty when they agree. */
export function compareCounts(expected: Record<string, number>, actual: Record<string, number>): string[] {
  const names = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return names.filter((t) => expected[t] !== actual[t]).map((t) => `${t}: expected ${expected[t] ?? 'no table'}, found ${actual[t] ?? 'no table'}`);
}

/** The tables each table refers to by foreign key, read from the CREATE TABLE statements of an export. */
export function foreignKeys(schema: string): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const statement of schema.split(/^(?=CREATE TABLE )/m)) {
    const name = /^CREATE TABLE (?:IF NOT EXISTS )?[`"]?([^`"\s(]+)/.exec(statement)?.[1];
    if (!name) continue;
    const parents = new Set([...statement.matchAll(/REFERENCES\s+[`"]?([^`"\s(]+)/g)].map((m) => m[1]!).filter((t) => t !== name));
    graph.set(name, parents);
  }
  return graph;
}

/**
 * Tables in an order where each comes after every table it refers to, so that rows can be loaded parent
 * first. Ties go alphabetically, so that the order is stable. A cycle is broken where it closes; the restore
 * then relies on `defer_foreign_keys`, and refuses cleanly if D1 does not honour it.
 */
export function parentFirst(tables: string[], graph: Map<string, Set<string>>): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (table: string) => {
    if (seen.has(table)) return;
    seen.add(table);
    for (const parent of [...(graph.get(table) ?? [])].sort()) visit(parent);
    order.push(table);
  };
  for (const table of [...tables].sort()) visit(table);
  const wanted = new Set(tables);
  return order.filter((t) => wanted.has(t));
}

const INSERT = /^INSERT INTO "((?:[^"]|"")+)"/;

/**
 * Rewrites a data-only export so that each table's rows come after those of the tables it refers to. Rows
 * are streamed through one temporary file per table, so a large database is never held in memory. Wrangler
 * writes one statement per line, with line breaks inside values written as char(10); anything else stops it.
 */
export async function orderRows(dataFile: string, schema: string, out: string, scratch: string): Promise<void> {
  const groups = new Map<string, string>();
  const head: string[] = [];
  const lines = createInterface({ input: createReadStream(dataFile), crlfDelay: Infinity });
  const writers = new Map<string, ReturnType<typeof createWriteStream>>();
  try {
    for await (const line of lines) {
      if (line === '') continue;
      const table = INSERT.exec(line)?.[1]?.replaceAll('""', '"');
      if (!table) {
        if (/^PRAGMA defer_foreign_keys\s*=\s*TRUE;$/i.test(line) && writers.size === 0) {
          head.push(line);
          continue;
        }
        throw new Error('The export is not in the form this release understands: one INSERT on each line. No backup was kept.');
      }
      let writer = writers.get(table);
      if (!writer) {
        const path = join(scratch, `${writers.size}.sql`);
        groups.set(table, path);
        writer = createWriteStream(path, { mode: 0o600 });
        writers.set(table, writer);
      }
      if (!writer.write(`${line}\n`)) await once(writer, 'drain');
    }
  } finally {
    await Promise.all([...writers.values()].map((w) => new Promise((resolve) => w.end(resolve))));
  }
  writeFileSync(out, head.map((l) => `${l}\n`).join(''), { flag: 'a', mode: 0o600 });
  for (const table of parentFirst([...groups.keys()], foreignKeys(schema))) {
    await pipeline(createReadStream(groups.get(table)!), createWriteStream(out, { flags: 'a' }));
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const size = (bytes: number) => (bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

/** A backup's manifest sits beside it, with the same name. */
export const manifestPath = (file: string) => join(dirname(file), basename(file).replace(/\.sql$/, '.json'));

const privateDir = (dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
};

export function createBackups<S extends BackupState>(ctx: BackupContext<S>) {
  const { wrangler, log } = ctx;
  const now = ctx.now ?? (() => new Date());
  const config = (state: S) => ctx.configPath(state.name);

  const loadDeployment = (name: string) => {
    const state = ctx.load(name);
    if (!state.initialized || !state.d1DatabaseId || !state.publicBaseUrl) throw new Error(`No deployment named ${name} in .openchat. To make one, use oc deploy.`);
    ctx.render(state);
    return state;
  };

  const bookmarkOf = (state: S): string => {
    const bookmark = (JSON.parse(wrangler(['d1', 'time-travel', 'info', databaseName(state), '--json', '-c', config(state)], { ci: true })) as { bookmark?: string }).bookmark;
    if (!bookmark) throw new Error('Could not read a Time Travel bookmark, so nothing was changed');
    return bookmark;
  };

  /** Counts every table of a database, local (in `persistTo`) or remote. */
  const countTables = (state: S, database: string, where: { persistTo: string } | 'remote'): Record<string, number> => {
    const target = where === 'remote' ? ['--remote'] : ['--local', '--persist-to', where.persistTo];
    const query = (sql: string) => rows(wrangler(['d1', 'execute', database, ...target, '--json', '--yes', '-c', config(state), '--command', sql], { ci: true }));
    const tables = query(TABLES_SQL).map((r) => String(r.name));
    if (tables.length === 0) return {};
    return Object.fromEntries(countSql(tables).flatMap((sql) => Object.entries(query(sql)[0] ?? {}).map(([table, n]) => [table, Number(n)])));
  };

  const newestMigration = (state: S, database: string, where: { persistTo: string } | 'remote'): string | null => {
    const target = where === 'remote' ? ['--remote'] : ['--local', '--persist-to', where.persistTo];
    try {
      const result = rows(wrangler(['d1', 'execute', database, ...target, '--json', '--yes', '-c', config(state), '--command', 'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1'], { ci: true }));
      return result[0] ? String(result[0].name) : null;
    } catch {
      return null;
    }
  };

  /** Loads a file into a throwaway local database and counts what arrived. The local copy is deleted after. */
  const loadLocally = (state: S, file: string) => {
    const persistTo = mkdtempSync(join(tmpdir(), 'oc-backup-check-'));
    chmodSync(persistTo, 0o700);
    try {
      const database = databaseName(state);
      wrangler(['d1', 'execute', database, '--local', '--persist-to', persistTo, '--yes', '-c', config(state), '--file', file], { ci: true });
      const dangling = rows(wrangler(['d1', 'execute', database, '--local', '--persist-to', persistTo, '--json', '--yes', '-c', config(state), '--command', 'PRAGMA foreign_key_check'], { ci: true }));
      if (dangling.length > 0) {
        const tables = [...new Set(dangling.map((r) => String(r.table)))].sort().join(', ');
        throw new Error(`${dangling.length} rows refer to rows that are not there, in ${tables}. D1 would refuse to load it.`);
      }
      return { tables: countTables(state, database, { persistTo }), migration: newestMigration(state, database, { persistTo }) };
    } finally {
      rmSync(persistTo, { recursive: true, force: true });
    }
  };

  const readManifest = (file: string): BackupManifest => {
    const path = manifestPath(file);
    if (!file.endsWith('.sql') || !existsSync(path)) throw new Error(`${basename(file)} has no manifest beside it. Restore from a backup made by oc backup.`);
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as BackupManifest;
    if (manifest.format !== 1) throw new Error(`${basename(path)} is not a backup manifest this release understands`);
    return manifest;
  };

  const requireConfirm = (name: string, confirm: string | undefined) => {
    if (confirm !== name) throw new Error(`Restoring replaces what ${name} serves now. To go ahead, add --confirm ${name}. Nothing was changed.`);
  };

  /**
   * Wrangler's own export puts each table's rows straight after its CREATE TABLE, in alphabetical order, so
   * `attachments` rows arrive before `workspaces` exists, and loading the file fails on its foreign key. So
   * the schema and the data are exported apart, and joined schema first. Even then, D1's remote import
   * refuses a file with a child row before its parent, despite `defer_foreign_keys`, so rows go parent
   * first too. The schema is exported again after the data: if a migration ran in between, the two would
   * not match, and the backup is refused.
   */
  async function exportInOrder(state: S, file: string) {
    const part = (suffix: string, only: '--no-data' | '--no-schema') => {
      const path = `${file}.${suffix}`;
      try {
        wrangler(['d1', 'export', databaseName(state), '--remote', only, '--output', path, '--skip-confirmation', '-c', config(state)], { ci: true });
      } catch (error) {
        throw new Error(describeFailure(error), { cause: error });
      }
      if (!existsSync(path) || statSync(path).size === 0) throw new Error('Wrangler finished the export but wrote nothing');
      chmodSync(path, 0o600);
      return path;
    };
    const parts: string[] = [];
    const scratch = mkdtempSync(join(dirname(file), '.rows-'));
    chmodSync(scratch, 0o700);
    try {
      parts.push(part('schema', '--no-data'), part('data', '--no-schema'), part('schema-after', '--no-data'));
      if (readFileSync(parts[0]!, 'utf8') !== readFileSync(parts[2]!, 'utf8')) throw new Error('The schema changed while the backup ran. Is an upgrade running? Try again when it has finished.');
      writeFileSync(file, '', { mode: 0o600 });
      chmodSync(file, 0o600);
      // Streamed, since a database can be gigabytes.
      await pipeline(createReadStream(parts[0]!), createWriteStream(file, { flags: 'a' }));
      await orderRows(parts[1]!, readFileSync(parts[0]!, 'utf8'), file, scratch);
    } finally {
      for (const path of parts) rmSync(path, { force: true });
      for (const suffix of ['schema', 'data', 'schema-after']) rmSync(`${file}.${suffix}`, { force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** Points the Worker at another database. On a failed check, points it back and says so. */
  async function switchDatabase(state: S, to: { name: string; id: string }, source: string, kind: 'file' | 'database') {
    const previous = { name: databaseName(state), id: state.d1DatabaseId! };
    if (previous.id === to.id) throw new Error(`${state.name} already uses ${to.name}. Nothing was changed.`);
    const switchTo = (db: { name: string; id: string }) => {
      state.d1DatabaseId = db.id;
      if (db.name === `oc-${state.name}`) delete state.d1DatabaseName;
      else state.d1DatabaseName = db.name;
      ctx.save(state);
      ctx.render(state);
    };
    log(`Switching ${state.name} from ${previous.name} to ${to.name}`);
    switchTo(to);
    try {
      ctx.migrate(state);
      ctx.deployWorker(state);
      await ctx.verify(state);
    } catch (error) {
      log(`${(error as Error).message}\nSwitching back to ${previous.name}`);
      switchTo(previous);
      ctx.deployWorker(state);
      await ctx.verify(state);
      throw new Error(`${to.name} did not work, so ${state.name} uses ${previous.name} again, unchanged. ${to.name} is kept for you to inspect.`, { cause: error });
    }
    state.lastRestore = { at: now().toISOString(), kind, previousDatabase: previous, source };
    ctx.save(state);
    log(`\n${state.name} now uses ${to.name}: ${state.publicBaseUrl}`);
    log(`${previous.name} is kept, unchanged, with every write made before the switch. To go back to it:\n  pnpm oc restore --env ${state.name} --database ${previous.name} --confirm ${state.name}`);
    log(`When you no longer need it:\n  pnpm --filter @openchat/api exec wrangler d1 delete ${previous.name}`);
  }

  return {
    /**
     * Exports the database to a file, loads it into a throwaway local database to prove it, and writes a
     * manifest beside it. Returns the path of the export.
     */
    async backup(deployment: string, options: { out?: string | undefined } = {}): Promise<string> {
      const state = loadDeployment(deployment);
      const dir = options.out ?? join(ctx.dirOf(deployment), 'backups');
      privateDir(dir);
      const createdAt = now();
      const file = join(dir, `${deployment}-${stamp(createdAt)}.sql`);
      if (existsSync(file)) throw new Error(`${file} already exists. Wait a minute, or choose another --out.`);

      const bookmark = bookmarkOf(state);
      log(`Exporting ${databaseName(state)}. Other requests wait while it runs.`);
      try {
        await exportInOrder(state, file);
      } catch (error) {
        rmSync(file, { force: true });
        throw new Error(`The export failed, and no backup was kept.\n${(error as Error).message}`, { cause: error });
      }
      log('Checking the backup by loading it into a throwaway local database');
      let loaded: ReturnType<typeof loadLocally>;
      try {
        loaded = loadLocally(state, file);
      } catch (error) {
        throw new Error(`${basename(file)} did not load into a local database, so it is not a usable backup. It is kept for inspection.\n${describeFailure(error)}`, { cause: error });
      }
      if (!loaded.tables.installation) throw new Error(`${basename(file)} loaded, but holds no installation. It is kept for inspection, but is not a usable backup.`);

      const manifest: BackupManifest = {
        format: 1,
        deployment,
        database: { name: databaseName(state), id: state.d1DatabaseId! },
        release: state.version,
        bookmark,
        createdAt: createdAt.toISOString(),
        migration: loaded.migration,
        sha256: await sha256(file),
        bytes: statSync(file).size,
        tables: loaded.tables,
      };
      writeFileSync(manifestPath(file), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

      const total = Object.values(loaded.tables).reduce((sum, n) => sum + n, 0);
      log(`\nBacked up ${deployment}: ${size(manifest.bytes)}, ${Object.keys(loaded.tables).length} tables, ${total} rows, migration ${manifest.migration ?? 'unknown'}`);
      log(`  ${file}`);
      log('It holds personal data and message content. Keep a copy away from this computer and from Cloudflare, encrypted.');
      log(`\nTo restore it, into a new database:\n  pnpm oc restore --env ${deployment} --from ${file} --confirm ${deployment}`);
      log(`Within 30 days, Time Travel can also go back to just before it, in place:\n  pnpm oc restore --env ${deployment} --bookmark ${bookmark} --confirm ${deployment}`);
      return file;
    },

    async restore(deployment: string, options: RestoreOptions) {
      const state = loadDeployment(deployment);
      requireConfirm(deployment, options.confirm);

      if ('bookmark' in options || 'timestamp' in options) {
        const target = 'bookmark' in options ? ['--bookmark', options.bookmark] : ['--timestamp', options.timestamp];
        const undo = bookmarkOf(state);
        state.lastRestore = { at: now().toISOString(), kind: 'time-travel', undoBookmark: undo, source: target.join(' ') };
        ctx.save(state);
        log(`Recorded the bookmark ${undo}, which undoes this restore`);
        log(`Restoring ${databaseName(state)} in place, to ${target[1]}. Every write since then is set aside.`);
        wrangler(['d1', 'time-travel', 'restore', databaseName(state), ...target, '--json', '-c', config(state)], { ci: true });
        await ctx.verify(state);
        log(`\nRestored ${deployment} to ${target[1]}: ${state.publicBaseUrl}`);
        log(`To undo it, within 30 days:\n  pnpm oc restore --env ${deployment} --bookmark ${undo} --confirm ${deployment}`);
        return;
      }

      if ('database' in options) {
        const info = wrangler(['d1', 'info', options.database, '--json', '-c', config(state)], { ci: true });
        const id = UUID.exec(info)?.[0];
        if (!id) throw new Error(`Could not find the database ${options.database}`);
        await switchDatabase(state, { name: options.database, id }, options.database, 'database');
        return;
      }

      const file = options.from;
      if (!existsSync(file)) throw new Error(`${file} does not exist`);
      const manifest = readManifest(file);
      if (manifest.deployment !== deployment) throw new Error(`${basename(file)} is a backup of ${manifest.deployment}, not ${deployment}. Nothing was changed.`);
      if ((await sha256(file)) !== manifest.sha256) throw new Error(`${basename(file)} has changed since it was made, so it was not restored. Nothing was changed.`);

      const target = `oc-${deployment}-${stamp(now())}`;
      log(`Creating the database ${target}, for the backup made ${manifest.createdAt}`);
      const created = wrangler(['d1', 'create', target], { ci: true });
      const id = UUID.exec(created)?.[0];
      if (!id) throw new Error(`Could not find the ID of ${target}`);

      log(`Loading ${basename(file)} into ${target}`);
      try {
        wrangler(['d1', 'execute', target, '--remote', '--yes', '-c', config(state), '--file', file], { ci: true });
      } catch (error) {
        throw new Error(`Loading the backup failed. ${deployment} still uses ${databaseName(state)}, unchanged. Delete ${target} when done with it.\n${describeFailure(error)}`, { cause: error });
      }
      const mismatches = compareCounts(manifest.tables, countTables(state, target, 'remote'));
      if (mismatches.length > 0) {
        throw new Error(`${target} does not hold what the backup holds, so ${deployment} still uses ${databaseName(state)}, unchanged:\n  ${mismatches.join('\n  ')}`);
      }
      log(`${target} holds every row of the backup`);
      await switchDatabase(state, { name: target, id }, basename(file), 'file');
    },
  };
}
