/**
 * Database layer bootstrap (expo-sqlite).
 *
 * `openDatabase()` is THE single entry point for the app: it opens (or creates)
 * the SQLite database and runs all pending migrations idempotently. It is
 * wired at app start via `SQLiteProvider`'s `onInit` (see src/app/_layout.tsx).
 *
 * Migration mechanism (per task spec):
 *  - numbered migrations live in src/db/migrations/ (registered in ./migrations/index.ts)
 *  - a `migrations` table records applied versions
 *  - the runner (./migrations/runner.ts) is idempotent: applied versions are
 *    skipped, so calling openDatabase() on every app start is safe.
 */
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { runMigrations } from './migrations/runner';

export const DATABASE_NAME = 'kvasir.db';

// Public surface of the db layer (app code imports from '../db' or '@/db').
export { runMigrations, resetDatabaseForTests } from './migrations/runner';
export type { AppliedMigration, MigrationRunResult } from './migrations/runner';
export { MIGRATIONS, type Migration, type MigrationConnection } from './migrations';

/**
 * Open the app database and bring its schema up to date (idempotent).
 *
 * @param name database file name (overridable for tests)
 */
export async function openDatabase(
  name: string = DATABASE_NAME,
): Promise<SQLiteDatabase> {
  const db = await openDatabaseAsync(name);
  // Connection-level PRAGMAs (must NOT live inside migrations — they are
  // no-ops within transactions; see src/db/migrations/index.ts).
  await db.execAsync('PRAGMA foreign_keys = ON;');
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await runMigrations(db);
  return db;
}
