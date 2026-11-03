/**
 * The raw D1 handle. Deliberately not reachable from outside this package: the exports map exposes
 * only src/index.ts, and lint forbids the ORM elsewhere. See ADR-0004.
 */
declare const databaseBrand: unique symbol;

/** An opaque database reference. Holding one grants nothing without a WorkspaceContext. */
export interface Database {
  readonly [databaseBrand]: true;
}

const handles = new WeakMap<Database, D1Database>();

export function openDatabase(d1: D1Database): Database {
  const database = {} as Database;
  handles.set(database, d1);
  return database;
}

export function rawHandle(database: Database): D1Database {
  const d1 = handles.get(database);
  if (!d1) throw new Error('Unknown database reference');
  return d1;
}

/**
 * The commit-order clock. Worker clocks at different edge locations can disagree, so columns used as
 * sync cursors take their time from the database. Verified on real D1 by spike S4.
 */
export const DB_NOW_MS = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
