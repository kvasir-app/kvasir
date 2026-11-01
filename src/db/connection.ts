/**
 * Connection type shared by all repos.
 *
 * The repos are deliberately written against the same minimal async
 * interface the migration runner uses (re-exported here as DbConnection):
 * node:sqlite's DatabaseSync satisfies it, which lets the M1 unit tests run
 * the exact repo code against an in-memory SQLite without a device/emulator.
 * expo-sqlite's SQLiteDatabase is structurally compatible.
 */
export type {
  DbBindValue,
  DbRunResult,
  MigrationConnection as DbConnection,
} from './migrations';
