/**
 * Migration 0001 — Initial schema (Kvasir M1).
 *
 * Source of truth: docs/schema.md (§3 SQL-DDL), authored by the data-model task.
 * Deviations from schema.md §3 (documented there via comment on the task):
 *  - cards: + fsrs_stability_fast, fsrs_schedule_status, fsrs_card_id
 *    (ts-fsrs v6 card fields; review() validates the full card shape, so all of
 *    them must be persisted — see src/db/fsrs.ts).
 *  - review_log: + fsrs_stability_fast (snapshot column, same reason).
 *
 * PRAGMAs (foreign_keys, journal_mode) are NOT set here: they are no-ops
 * inside the runner's transaction. The connection layer sets them per
 * connection (see openDatabase in ../index.ts and the test adapter).
 */
import type { Migration } from './index';

export const migration0001: Migration = {
  version: 1,
  name: 'init',
  up: `
    -- Migrations-Buchhaltung (schema.md §3, Referenzblock; der Runner befüllt sie)
    CREATE TABLE migrations (
        version    INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
    );

    CREATE TABLE decks (
        id           TEXT PRIMARY KEY,
        titel        TEXT NOT NULL,
        beschreibung TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
    );

    CREATE TABLE cards (
        id                  TEXT PRIMARY KEY,
        deck_id             TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        frage               TEXT NOT NULL,
        antwort             TEXT NOT NULL,
        typ                 TEXT NOT NULL CHECK (typ IN ('selbstbewertung', 'mc')),
        mc_optionen         TEXT,
        mc_richtige_indizes TEXT,
        entwurfsstatus      TEXT NOT NULL DEFAULT 'draft'
                            CHECK (entwurfsstatus IN ('draft', 'reviewed', 'active')),
        quelle              TEXT NOT NULL DEFAULT 'manuell' CHECK (quelle IN ('manuell', 'ki')),
        -- aktueller ts-fsrs-Zustand (Spiegel der ts-fsrs-Card, serialisiert via src/db/fsrs.ts)
        fsrs_due            TEXT,
        fsrs_stability      REAL,
        fsrs_stability_fast REAL,
        fsrs_difficulty     REAL,
        fsrs_state          INTEGER,
        fsrs_schedule_status TEXT,
        fsrs_card_id        TEXT,
        fsrs_last_review    TEXT,
        fsrs_reps           INTEGER NOT NULL DEFAULT 0,
        fsrs_lapses         INTEGER NOT NULL DEFAULT 0,
        fsrs_learning_steps INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        CHECK (
            (typ = 'mc' AND mc_optionen IS NOT NULL AND mc_richtige_indizes IS NOT NULL)
            OR
            (typ = 'selbstbewertung' AND mc_optionen IS NULL AND mc_richtige_indizes IS NULL)
        )
    );

    CREATE TABLE review_log (
        id                  TEXT PRIMARY KEY,
        karte_id            TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        reviewed_at         TEXT NOT NULL,
        rating              INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
        ergebnis            INTEGER NOT NULL CHECK (ergebnis IN (0, 1)),
        -- ts-fsrs-ReviewLog-Snapshot: Zustand VOR dem Review
        fsrs_state          INTEGER NOT NULL,
        fsrs_due            TEXT NOT NULL,
        fsrs_stability      REAL NOT NULL,
        fsrs_stability_fast REAL NOT NULL DEFAULT 0,
        fsrs_difficulty     REAL NOT NULL,
        fsrs_elapsed_days   REAL NOT NULL DEFAULT 0,
        fsrs_scheduled_days REAL NOT NULL DEFAULT 0,
        fsrs_learning_steps INTEGER NOT NULL DEFAULT 0
    );

    -- Indizes (Task-Anforderung: deck_id und due)
    CREATE INDEX idx_cards_deck_id ON cards (deck_id);

    -- Partieller Index: getDueCards liest genau diese Teilmenge
    -- (nur aktive Karten mit Fälligkeit)
    CREATE INDEX idx_cards_due_active ON cards (fsrs_due)
        WHERE entwurfsstatus = 'active' AND fsrs_due IS NOT NULL;

    -- Historie je Karte in Zeitreihenfolge (Stats, Verlauf, Replay)
    CREATE INDEX idx_review_log_karte ON review_log (karte_id, reviewed_at);
  `,
};
