/**
 * Review-Log-Repository — persistenter Review-Verlauf als Datenbasis für
 * FSRS-Auswahl und Metriken (Regelkreis: Feedback → Metriken → Auswahl/Generator).
 *
 * Kernregel (schema.md §5 Pfeil 5, Konsistenzregel dieser Karte):
 *   INSERT in review_log und UPDATE von cards werden in EINER Transaktion
 *   ausgeführt — beides zusammen, nie einzeln.
 *
 * review_log-Semantik (schema.md D4, exakte ts-fsrs-ReviewLog-Bedeutung):
 *   Jede Zeile speichert den Zustand VOR dem Review; `reviewed_at` = `review`
 *   (der Zeitpunkt des Reviews). Append-only — nur INSERTs, keine UPDATEs.
 *
 * `logReview` ist bewusst synchron zur aufrufenden App-Schicht (awaited) und
 * wirft bei Kartenfehlern (unbekannte ID, inaktiver Status, nicht
 * initialisierter FSRS-Zustand) — dann wird nichts geschrieben (Transaktion).
 *
 * Läuft gegen der minimalen `MigrationConnection`-Schnittstelle (expo-sqlite
 * und node:sqlite genügen ihr), damit die Unit-Tests dieselbe Produktionslogik
 * gegen In-Memory-SQLite fahren können (Muster aus tests/migrations.test.ts).
 */
import {
  applyReview,
  columnsToState,
  createNewCard,
  stateToColumns,
  type FsrsCard,
  type FsrsStateColumns,
} from './fsrs';
import type { MigrationConnection } from './migrations';

/** A graded review as the app layer submits it (schema.md §5 Pfeil 4). */
export interface ReviewInput {
  /** ts-fsrs grade: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy. */
  rating: 1 | 2 | 3 | 4;
  /**
   * Binäre Wahrheit getrennt vom Scheduling-Urteil (D7): 0 = falsch, 1 = richtig.
   * App-Mapping: Selbstbewertung wieder zeigen → 0, schwer/gut/leicht → 1;
   * MC falsch → 0, richtig → 1.
   */
  ergebnis: 0 | 1;
}

/** One persisted review-log row (zustand VOR dem Review). */
export interface ReviewLogRow {
  id: string;
  karte_id: string;
  reviewed_at: string;
  rating: number;
  ergebnis: number;
  fsrs_state: number;
  fsrs_due: string;
  fsrs_stability: number;
  fsrs_stability_fast: number;
  fsrs_difficulty: number;
  fsrs_elapsed_days: number;
  fsrs_scheduled_days: number;
  fsrs_learning_steps: number;
}

/** One due card as returned by getDueCards. */
export interface DueCard {
  id: string;
  deck_id: string;
  frage: string;
  antwort: string;
  typ: 'selbstbewertung' | 'mc';
  mc_optionen: string | null;
  mc_richtige_indizes: string | null;
  fsrs_due: string;
  fsrs_state: number;
  fsrs_reps: number;
  fsrs_lapses: number;
}

/** Aggregated review statistics (schema.md §5 Pfeil 6). */
export interface ReviewStats {
  /** Anzahl Reviews. */
  total: number;
  /** Korrekt-Anteil (AVG über `ergebnis` 0/1, D7) — null bei 0 Reviews. */
  korrekt_anteil: number | null;
}

/** Columns of a card row needed for scheduling decisions. */
interface CardStateRow extends FsrsStateColumns {
  id: string;
  entwurfsstatus: string;
}

/**
 * Log one review and advance the card's ts-fsrs state — atomically.
 *
 * 1. Load the card (must exist, must be `active`, FSRS state must be
 *    initialized — activation via reviewCard does that).
 * 2. Compute the new ts-fsrs state via the scheduler (`applyReview`).
 * 3. In ONE transaction: INSERT the log row (snapshot of the state BEFORE the
 *    review) + UPDATE the card row with the new state.
 *
 * Throws (and writes nothing) when the card does not exist, is not active, or
 * its FSRS state is uninitialized.
 */
export async function logReview(
  db: MigrationConnection,
  cardId: string,
  rating: ReviewInput['rating'],
  ergebnis: ReviewInput['ergebnis'],
  reviewedAt: Date,
): Promise<ReviewLogRow> {
  const card = await getCardStateRow(db, cardId);
  if (card === null) {
    throw new Error(`Card ${cardId} does not exist`);
  }

  // Precondition: only active cards participate in the review loop. Drafts and
  // reviewed cards have no initialized FSRS state to review against.
  if (card.entwurfsstatus !== 'active') {
    throw new Error(
      `Card ${cardId} is not active (entwurfsstatus='${card.entwurfsstatus}') — activate via reviewCard before logging reviews`,
    );
  }

  const before = columnsToState(card);
  const { card: after } = await applyReview(before, rating, reviewedAt);
  const afterCols = stateToColumns(after);

  // Derive the deprecated log-only fields (D6: replay fidelity of the history;
  // they never live on cards).
  const elapsedDays =
    before.lastReviewAt === null
      ? 0
      : (reviewedAt.getTime() - before.lastReviewAt.getTime()) / 86_400_000;
  const scheduledDays =
    before.lastReviewAt === null
      ? 0
      : (before.dueAt.getTime() - before.lastReviewAt.getTime()) / 86_400_000;

  const logId = generateId();
  const reviewedAtIso = reviewedAt.toISOString();
  const nowIso = new Date().toISOString();

  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `INSERT INTO review_log (
        id, karte_id, reviewed_at, rating, ergebnis,
        fsrs_state, fsrs_due, fsrs_stability, fsrs_stability_fast, fsrs_difficulty,
        fsrs_elapsed_days, fsrs_scheduled_days, fsrs_learning_steps
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      logId,
      cardId,
      reviewedAtIso,
      rating,
      ergebnis,
      // Snapshot BEFORE the review (D4 — exact ts-fsrs ReviewLog semantics):
      before.state,
      before.dueAt.toISOString(),
      before.stability,
      before.stabilityFast,
      before.difficulty,
      elapsedDays,
      scheduledDays,
      before.learningStep,
    );

    await txn.runAsync(
      `UPDATE cards SET
        fsrs_due = ?,
        fsrs_stability = ?,
        fsrs_stability_fast = ?,
        fsrs_difficulty = ?,
        fsrs_state = ?,
        fsrs_schedule_status = ?,
        fsrs_card_id = ?,
        fsrs_last_review = ?,
        fsrs_reps = ?,
        fsrs_lapses = ?,
        fsrs_learning_steps = ?,
        updated_at = ?
      WHERE id = ?`,
      afterCols.fsrs_due,
      afterCols.fsrs_stability,
      afterCols.fsrs_stability_fast,
      afterCols.fsrs_difficulty,
      afterCols.fsrs_state,
      afterCols.fsrs_schedule_status,
      afterCols.fsrs_card_id,
      afterCols.fsrs_last_review,
      afterCols.fsrs_reps,
      afterCols.fsrs_lapses,
      afterCols.fsrs_learning_steps,
      nowIso,
      cardId,
    );
  });

  return {
    id: logId,
    karte_id: cardId,
    reviewed_at: reviewedAtIso,
    rating,
    ergebnis,
    fsrs_state: before.state,
    fsrs_due: before.dueAt.toISOString(),
    fsrs_stability: before.stability,
    fsrs_stability_fast: before.stabilityFast,
    fsrs_difficulty: before.difficulty,
    fsrs_elapsed_days: elapsedDays,
    fsrs_scheduled_days: scheduledDays,
    fsrs_learning_steps: before.learningStep,
  };
}

/**
 * Cards due for review: `entwurfsstatus='active'` AND `fsrs_due <= now`,
 * ordered by due ascending (most overdue first). Uses the partial index
 * `idx_cards_due_active` (verified via query plan in the schema task).
 *
 * Drafts/reviewed cards have `fsrs_due = NULL` and never appear. `limit`
 * defaults to 20; pass 0 for no limit.
 */
export async function getDueCards(
  db: MigrationConnection,
  now: Date,
  limit = 20,
): Promise<DueCard[]> {
  const sql = `
    SELECT id, deck_id, frage, antwort, typ, mc_optionen, mc_richtige_indizes,
           fsrs_due, fsrs_state, fsrs_reps, fsrs_lapses
    FROM cards
    WHERE entwurfsstatus = 'active' AND fsrs_due <= ?
    ORDER BY fsrs_due ASC
  `;
  const rows =
    limit > 0
      ? await db.getAllAsync<DueCard>(`${sql} LIMIT ?`, now.toISOString(), limit)
      : await db.getAllAsync<DueCard>(sql, now.toISOString());
  return rows;
}

/**
 * Aggregated review statistics over `review_log` (schema.md §5 Pfeil 6):
 * review count and korrekt-Anteil over the BINARY `ergebnis` column (D7),
 * never over the FSRS rating. With `deckId` the aggregation is restricted to
 * that deck's cards; without, it covers the whole log.
 */
export async function getReviewStats(
  db: MigrationConnection,
  deckId?: string,
): Promise<ReviewStats> {
  const sql = deckId === undefined
    ? `SELECT COUNT(*) AS total, AVG(ergebnis) AS korrekt_anteil FROM review_log`
    : `SELECT COUNT(*) AS total, AVG(ergebnis) AS korrekt_anteil
       FROM review_log
       JOIN cards ON cards.id = review_log.karte_id
       WHERE cards.deck_id = ?`;
  const row = await db.getAllAsync<{ total: number; korrekt_anteil: number | null }>(
    sql,
    ...(deckId === undefined ? [] : [deckId]),
  );
  return { total: row[0]?.total ?? 0, korrekt_anteil: row[0]?.korrekt_anteil ?? null };
}

/**
 * Initialize the FSRS state of a card on activation (draft→active or
 * reviewed→active) — the `createEmptyCard` equivalent from the CRUD contract.
 *
 * Exported for the CRUD task's `reviewCard`; keeping the initialization in
 * this module keeps the "how a card enters the scheduling loop" logic next to
 * the loop itself. Idempotent on already-active cards (no-op, state kept).
 */
export async function initializeFsrsState(
  db: MigrationConnection,
  cardId: string,
  now: Date,
): Promise<void> {
  const card = await getCardStateRow(db, cardId);
  if (card === null) {
    return; // deleting a vanished card is a no-op, not an error
  }
  if (card.entwurfsstatus === 'active') {
    return; // already in the loop — keep the running state
  }
  const fresh: FsrsCard = await createNewCard(now);
  const cols = stateToColumns(fresh);
  await db.runAsync(
    `UPDATE cards SET
      fsrs_due = ?, fsrs_stability = ?, fsrs_stability_fast = ?, fsrs_difficulty = ?,
      fsrs_state = ?, fsrs_schedule_status = ?, fsrs_card_id = ?, fsrs_last_review = ?,
      fsrs_reps = ?, fsrs_lapses = ?, fsrs_learning_steps = ?, updated_at = ?
    WHERE id = ?`,
    cols.fsrs_due,
    cols.fsrs_stability,
    cols.fsrs_stability_fast,
    cols.fsrs_difficulty,
    cols.fsrs_state,
    cols.fsrs_schedule_status,
    cols.fsrs_card_id,
    cols.fsrs_last_review,
    cols.fsrs_reps,
    cols.fsrs_lapses,
    cols.fsrs_learning_steps,
    now.toISOString(),
    cardId,
  );
}

/** Load one card row with its FSRS state columns; null when it does not exist. */
async function getCardStateRow(
  db: MigrationConnection,
  cardId: string,
): Promise<CardStateRow | null> {
  const rows = await db.getAllAsync<CardStateRow>(
    `SELECT id, entwurfsstatus,
            fsrs_due, fsrs_stability, fsrs_stability_fast, fsrs_difficulty,
            fsrs_state, fsrs_schedule_status, fsrs_card_id, fsrs_last_review,
            fsrs_reps, fsrs_lapses, fsrs_learning_steps
     FROM cards WHERE id = ?`,
    cardId,
  );
  return rows[0] ?? null;
}

/** Client-generated UUIDv4 (TEXT PK, D1 — no autoincrement). */
function generateId(): string {
  return crypto.randomUUID();
}
