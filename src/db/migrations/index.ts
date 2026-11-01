/**
 * Migration registry — add every new migration here, in ascending version order.
 *
 * Conventions:
 *  - One file per migration: src/db/migrations/NNNN_name.ts, exporting a `Migration`.
 *  - `up` runs once, inside a transaction (see runMigrations).
 *  - Never edit an already-shipped migration; add a new one instead.
 *  - The first migration must create the `migrations` bookkeeping table itself
 *    (chicken-and-egg: the runner cannot log versions before it exists).
 *  - Connection-level PRAGMAs (foreign_keys, journal_mode) do NOT belong in
 *    migrations — they are no-ops inside transactions; set them per connection.
 */

/**
 * Minimal connection interface used by the migration runner.
 *
 * Deliberately NOT the full expo-sqlite SQLiteDatabase: node:sqlite's
 * DatabaseSync satisfies it too, which lets M1 unit tests run the exact same
 * migrations against an in-memory SQLite without a device/emulator.
 * (expo-sqlite's SQLiteDatabase is structurally compatible; the test adapter
 * provides the tiny sync/async glue.)
 */
import { migration0001 } from './0001_init';

export interface MigrationConnection {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: unknown[]): Promise<unknown>;
  getAllAsync<T>(source: string, ...params: unknown[]): Promise<T[]>;
  withExclusiveTransactionAsync(task: (txn: MigrationConnection) => Promise<void>): Promise<void>;
}

export interface Migration {
  /** Monotonically increasing version number (matches the NNNN prefix). */
  version: number;
  /** Short human-readable name for logs. */
  name: string;
  /** SQL executed once, wrapped in a transaction by the runner. */
  up: string;
}

/** All migrations in ascending version order. */
export const MIGRATIONS: readonly Migration[] = [migration0001];
