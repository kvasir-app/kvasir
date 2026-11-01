/**
 * Database layer bootstrap (expo-sqlite).
 *
 * The app entry point is `SQLiteProvider` (src/app/_layout.tsx) with
 * `onInit={prepareDatabase}`: the provider opens the database and runs
 * `prepareDatabase` BEFORE rendering any route, so migrations are guaranteed
 * applied at app start. `prepareDatabase` is also what sets the
 * connection-level PRAGMAs — expo-sqlite does not persist them across
 * connections, so they belong wherever a connection is opened.
 *
 * `openDatabase()` is the equivalent imperative entry point for non-provider
 * call sites (e.g. background jobs); both share the same behavior.
 *
 * Migration mechanism (per task spec):
 *  - numbered migrations live in src/db/migrations/ (registered in ./migrations/index.ts)
 *  - a `migrations` table records applied versions
 *  - the runner (./migrations/runner.ts) is idempotent: applied versions are
 *    skipped, so running it on every app start is safe.
 */
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { runMigrations } from './migrations/runner';
import type { MigrationConnection } from './migrations';

export const DATABASE_NAME = 'kvasir.db';

// Public surface of the db layer (app code imports from '../db' or '@/db').
export { runMigrations, resetDatabaseForTests } from './migrations/runner';
export type { AppliedMigration, MigrationRunResult } from './migrations/runner';
export {
  MIGRATIONS,
  type Migration,
  type MigrationConnection,
} from './migrations';

/**
 * Connection-level PRAGMAs. Must NOT live inside migrations — they are no-ops
 * within transactions (see src/db/migrations/index.ts).
 *
 *  - foreign_keys: REQUIRED. expo-sqlite does not persist this across
 *    connections; without it, ON DELETE CASCADE (deck→cards→review_log)
 *    silently does nothing.
 *  - journal_mode = WAL: better concurrent read behavior while writing.
 */
export async function applyConnectionPragmas(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON;');
  await db.execAsync('PRAGMA journal_mode = WAL;');
}

/**
 * `SQLiteProvider` onInit callback: bring a freshly opened connection into the
 * state the app expects (PRAGMAs + applied migrations).
 */
export async function prepareDatabase(db: SQLiteDatabase): Promise<void> {
  await applyConnectionPragmas(db);
  await runMigrations(db as unknown as MigrationConnection);
}

/**
 * Imperative entry point: open the app database and bring its schema up to
 * date (idempotent).
 *
 * @param name database file name (overridable for tests)
 */
export async function openDatabase(
  name: string = DATABASE_NAME,
): Promise<SQLiteDatabase> {
  const db = await openDatabaseAsync(name);
  await applyConnectionPragmas(db);
  await runMigrations(db as unknown as MigrationConnection);
  return db;
}
