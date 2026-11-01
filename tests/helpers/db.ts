/**
 * Shared test helper: run the EXACT production migrations against an
 * in-memory node:sqlite database (same adapter pattern as
 * tests/migrations.test.ts) and expose it through the async
 * `DbConnection` interface the repos use.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../src/db/migrations/runner';
import type { MigrationConnection } from '../../src/db/migrations';

export type DbConnection = MigrationConnection;

/** Wrap node:sqlite's synchronous DatabaseSync as an async DbConnection. */
export function makeConnection(db: DatabaseSync): DbConnection {
  return {
    async execAsync(source: string) {
      db.exec(source);
    },
    async runAsync(source: string, ...params: unknown[]) {
      // node:sqlite names it `lastInsertRowid`, expo-sqlite `lastInsertRowId`
      // — same value (sqlite3_last_insert_rowid), only the casing differs.
      const result = db.prepare(source).run(...(params as never[]));
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
    async getAllAsync<T>(source: string, ...params: unknown[]) {
      return db.prepare(source).all(...(params as never[])) as T[];
    },
    async withExclusiveTransactionAsync<T>(
      task: (txn: DbConnection) => Promise<T>,
    ): Promise<T> {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await task(this);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

/**
 * Fresh migrated in-memory database with foreign_keys = ON.
 *
 * PRAGMAs must be set OUTSIDE the migration transactions (they are no-ops
 * inside transactions) — same ordering as the app path
 * (applyConnectionPragmas → runMigrations in src/db/index.ts).
 */
export async function makeTestDb(
  options: { migrate?: boolean } = {},
): Promise<{
  sqlite: DatabaseSync;
  db: DbConnection;
}> {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const db = makeConnection(sqlite);
  // Default: deliver the db fully migrated (the state the app path
  // guarantees). Tests that exercise runMigrations() itself pass
  // { migrate: false } and call it explicitly.
  if (options.migrate !== false) {
    await runMigrations(db);
  }
  return { sqlite, db };
}
