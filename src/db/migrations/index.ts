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
 * Minimal connection interface used by the migration runner AND the repos.
 *
 * Deliberately NOT the full expo-sqlite SQLiteDatabase: node:sqlite's
 * DatabaseSync satisfies it too, which lets M1 unit tests run the exact same
 * code against an in-memory SQLite without a device/emulator.
 * (expo-sqlite's SQLiteDatabase is structurally compatible; the test adapter
 * provides the tiny sync/async glue.)
 *
 * Signature notes (kept compatible with expo-sqlite):
 *  - runAsync mirrors expo-sqlite's SQLiteRunResult ({ lastInsertRowId,
 *    changes }) so call sites can rely on `changes` for existence checks.
 *  - withExclusiveTransactionAsync is generic: the task may return a value
 *    (repos return the updated row from inside the transaction).
 */
import { migration0001 } from './0001_init';

/** Mirrors expo-sqlite's SQLiteRunResult. */
export interface DbRunResult {
  lastInsertRowId: number;
  changes: number;
}

/** Values bindable as SQL parameters (mirrors expo-sqlite's SQLiteBindValue). */
export type DbBindValue = string | number | null | boolean | Uint8Array;

export interface MigrationConnection {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: DbBindValue[]): Promise<DbRunResult>;
  getAllAsync<T>(source: string, ...params: DbBindValue[]): Promise<T[]>;
  /**
   * Generic like expo-sqlite's own signature: the task may return a value
   * (e.g. repos return the updated row from inside the transaction).
   */
  withExclusiveTransactionAsync<T>(
    task: (txn: MigrationConnection) => Promise<T>,
  ): Promise<T>;
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
