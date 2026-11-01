/**
 * Migration runner tests against a real SQLite engine.
 *
 * The runner accepts the minimal `MigrationConnection` interface, so these
 * tests run the EXACT production migrations on node:sqlite (DatabaseSync,
 * bundled with Node >= 22) wrapped in a tiny async adapter. No emulator needed.
 *
 * The adapter lives in ./helpers/db so the repo tests reuse the exact same
 * connection glue.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resetDatabaseForTests,
  runMigrations,
  type AppliedMigration,
} from '../src/db/migrations/runner';
import { MIGRATIONS } from '../src/db/migrations';
import { makeTestDb } from './helpers/db';

let sqlite: DatabaseSync;
let conn: import('../src/db/migrations').MigrationConnection;

beforeEach(async () => {
  // migrate: false — these tests exercise runMigrations() itself and call it
  // explicitly; the helper would otherwise apply everything up front.
  ({ sqlite, db: conn } = await makeTestDb({ migrate: false }));
});

afterEach(() => {
  sqlite.close();
});

describe('migration runner (src/db/index.ts)', () => {
  it('applies all migrations on a fresh database and records versions', async () => {
    const result = await runMigrations(conn);

    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.version));
    expect(result.current).toEqual(result.applied);

    const recorded = await conn.getAllAsync<AppliedMigration>(
      'SELECT version, applied_at FROM migrations ORDER BY version',
    );
    expect(recorded.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    // applied_at is ISO-8601
    for (const row of recorded) {
      expect(row.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it('is idempotent: a second run applies nothing and changes nothing', async () => {
    await runMigrations(conn);
    const before = await conn.getAllAsync<AppliedMigration>(
      'SELECT version, applied_at FROM migrations ORDER BY version',
    );

    const second = await runMigrations(conn);
    expect(second.applied).toEqual([]);
    expect(second.current).toEqual(MIGRATIONS.map((m) => m.version));

    const after = await conn.getAllAsync<AppliedMigration>(
      'SELECT version, applied_at FROM migrations ORDER BY version',
    );
    expect(after).toEqual(before); // same rows, same applied_at timestamps
  });

  it('creates all M1 tables and indexes with the expected columns', async () => {
    await runMigrations(conn);
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['migrations', 'decks', 'cards', 'review_log']));

    const cardsCols = (
      sqlite.prepare('PRAGMA table_info(cards)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(cardsCols).toEqual(
      expect.arrayContaining([
        'id',
        'deck_id',
        'frage',
        'antwort',
        'typ',
        'mc_optionen',
        'mc_richtige_indizes',
        'entwurfsstatus',
        'quelle',
        'fsrs_due',
        'fsrs_stability',
        'fsrs_stability_fast',
        'fsrs_difficulty',
        'fsrs_state',
        'fsrs_schedule_status',
        'fsrs_card_id',
        'fsrs_last_review',
        'fsrs_reps',
        'fsrs_lapses',
        'fsrs_learning_steps',
        'created_at',
        'updated_at',
      ]),
    );

    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining(['idx_cards_deck_id', 'idx_cards_due_active', 'idx_review_log_karte']),
    );
  });

  it('enforces the schema constraints (FK, CHECK, defaults)', async () => {
    await runMigrations(conn);
    // FK: card without deck fails
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO cards (id, deck_id, frage, antwort, typ, created_at, updated_at) VALUES ('c1','missing','f','a','selbstbewertung','2026-01-01','2026-01-01')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);

    // Seed a deck, then CHECK: MC card without options fails
    sqlite
      .prepare("INSERT INTO decks (id, titel, created_at, updated_at) VALUES ('d1','Deck','2026-01-01','2026-01-01')")
      .run();
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO cards (id, deck_id, frage, antwort, typ, created_at, updated_at) VALUES ('c1','d1','f','a','mc','2026-01-01','2026-01-01')",
        )
        .run(),
    ).toThrow(/CHECK/);

    // CHECK: invalid entwurfsstatus fails
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO cards (id, deck_id, frage, antwort, typ, entwurfsstatus, created_at, updated_at) VALUES ('c2','d1','f','a','selbstbewertung','veröffentlicht','2026-01-01','2026-01-01')",
        )
        .run(),
    ).toThrow(/CHECK/);

    // Valid self-assessment card works; default status is draft
    sqlite
      .prepare(
        "INSERT INTO cards (id, deck_id, frage, antwort, typ, created_at, updated_at) VALUES ('c3','d1','f','a','selbstbewertung','2026-01-01','2026-01-01')",
      )
      .run();
    const card = sqlite.prepare("SELECT entwurfsstatus, quelle FROM cards WHERE id='c3'").get() as {
      entwurfsstatus: string;
      quelle: string;
    };
    expect(card.entwurfsstatus).toBe('draft');
    expect(card.quelle).toBe('manuell');
  });

  it('resetDatabaseForTests allows re-running all migrations (fresh-DB equivalence)', async () => {
    const first = await runMigrations(conn);
    await resetDatabaseForTests(conn);
    const second = await runMigrations(conn);

    expect(second.applied).toEqual(first.applied);
    expect(second.current).toEqual(first.current);

    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['migrations', 'decks', 'cards', 'review_log']),
    );
  });
});
