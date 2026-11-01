/**
 * Migration runner — pure logic, no expo imports.
 *
 * Deliberately free of any expo-sqlite/react-native import: it operates on the
 * minimal `MigrationConnection` interface, so unit tests can run the exact
 * production migrations against node:sqlite (see tests/migrations.test.ts).
 * src/db/index.ts re-exports these for the app.
 */
import { MIGRATIONS, type MigrationConnection } from './index';

/** Applied migration versions (bookkeeping table created by migration 0001). */
export interface AppliedMigration {
  version: number;
  applied_at: string;
}

/** Result of a migration run. */
export interface MigrationRunResult {
  /** Versions that were applied by this run (empty when already up to date). */
  applied: number[];
  /** All versions now recorded in the migrations table. */
  current: number[];
}

/**
 * Run all pending migrations. Idempotent: versions already present in the
 * `migrations` table are skipped. Each migration runs in its own transaction.
 */
export async function runMigrations(
  db: MigrationConnection,
): Promise<MigrationRunResult> {
  // The bookkeeping table is created by migration 0001 (chicken-and-egg);
  // if it is missing, the DB is fresh and every migration will run anyway.
  let applied = new Set<number>();
  try {
    applied = new Set(
      (
        await db.getAllAsync<AppliedMigration>(
          'SELECT version, applied_at FROM migrations',
        )
      ).map((row) => row.version),
    );
  } catch {
    // fresh database — no migrations table yet
  }

  const nowApplied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.execAsync(migration.up);
      await txn.runAsync(
        'INSERT INTO migrations (version, applied_at) VALUES (?, ?)',
        migration.version,
        new Date().toISOString(),
      );
    });
    nowApplied.push(migration.version);
  }

  const current = (
    await db.getAllAsync<AppliedMigration>(
      'SELECT version, applied_at FROM migrations ORDER BY version',
    )
  ).map((row) => row.version);
  return { applied: nowApplied, current };
}

/**
 * Development helper: drop all M1 tables and the bookkeeping table, so the
 * next runMigrations() re-runs every migration. NOT part of the app flow.
 */
export async function resetDatabaseForTests(db: MigrationConnection): Promise<void> {
  await db.execAsync(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS review_log;
    DROP TABLE IF EXISTS cards;
    DROP TABLE IF EXISTS decks;
    DROP TABLE IF EXISTS migrations;
    PRAGMA foreign_keys = ON;
  `);
}
