/**
 * cardsRepo — CRUD for the `cards` table (Kvasir M1).
 *
 * Conventions (docs/schema.md + verbindliche Entscheidungen):
 *  - IDs are client-generated UUIDv4 TEXT PKs; timestamps are ISO-8601 UTC
 *    strings; the APP sets `updated_at` on every update.
 *  - Entwurfs-Workflow: createCard always stores `entwurfsstatus='draft'`.
 *    reviewCard moves draft→active (or reviewed→active) and initializes the
 *    FSRS state (createEmptyCard equivalent). draft→reviewed does NOT touch
 *    the FSRS state.
 *  - MC fields are stored as JSON strings (mc_optionen: string[],
 *    mc_richtige_indizes: number[], 0-based). The DB CHECK enforces
 *    presence/absence per typ; this repo validates structure and index range
 *    app-side (better errors, no DB roundtrip needed to fail).
 *  - FSRS columns (fsrs_*) are owned by reviewLogRepo (logReview) and the
 *    activation path in reviewCard; plain updateCard never touches them.
 */
import type { DbConnection } from './connection';
import { generateId, nowIso } from './util';
import { createNewCard, serializeCard } from './fsrs';

/** Card types. */
export type CardTyp = 'selbstbewertung' | 'mc';

/** Entwurfs-Workflow status. */
export type Entwurfsstatus = 'draft' | 'reviewed' | 'active';

/** Where a card came from (quality feedback loop). */
export type CardQuelle = 'manuell' | 'ki';

/** Card row as stored in SQLite. MC columns are raw JSON strings here. */
export interface CardRow {
  id: string;
  deck_id: string;
  frage: string;
  antwort: string;
  typ: CardTyp;
  mc_optionen: string | null;
  mc_richtige_indizes: string | null;
  entwurfsstatus: Entwurfsstatus;
  quelle: CardQuelle;
  fsrs_due: string | null;
  fsrs_stability: number | null;
  fsrs_stability_fast: number | null;
  fsrs_difficulty: number | null;
  fsrs_state: number | null;
  fsrs_schedule_status: string | null;
  fsrs_card_id: string | null;
  fsrs_last_review: string | null;
  fsrs_reps: number;
  fsrs_lapses: number;
  fsrs_learning_steps: number;
  created_at: string;
  updated_at: string;
}

/** Application-level card: MC fields are parsed arrays, not JSON strings. */
export interface Card {
  id: string;
  deck_id: string;
  frage: string;
  antwort: string;
  typ: CardTyp;
  mcOptionen: string[] | null;
  mcRichtigeIndizes: number[] | null;
  entwurfsstatus: Entwurfsstatus;
  quelle: CardQuelle;
  fsrs_due: string | null;
  fsrs_stability: number | null;
  fsrs_stability_fast: number | null;
  fsrs_difficulty: number | null;
  fsrs_state: number | null;
  fsrs_schedule_status: string | null;
  fsrs_card_id: string | null;
  fsrs_last_review: string | null;
  fsrs_reps: number;
  fsrs_lapses: number;
  fsrs_learning_steps: number;
  created_at: string;
  updated_at: string;
}

/** Payload for creating a card. */
export interface CreateCardInput {
  deck_id: string;
  frage: string;
  antwort: string;
  typ: CardTyp;
  /** Required for typ='mc': answer options (JSON array of strings). */
  mcOptionen?: string[];
  /**
   * Required for typ='mc': 0-based indices into mcOptionen marking the
   * correct answers.
   */
  mcRichtigeIndizes?: number[];
  /** Defaults to 'manuell'. */
  quelle?: CardQuelle;
}

/** Payload for updating a card. Only provided fields are written. */
export interface UpdateCardInput {
  frage?: string;
  antwort?: string;
  mcOptionen?: string[];
  mcRichtigeIndizes?: number[];
}

const CARD_COLUMNS = `id, deck_id, frage, antwort, typ, mc_optionen,
  mc_richtige_indizes, entwurfsstatus, quelle,
  fsrs_due, fsrs_stability, fsrs_stability_fast, fsrs_difficulty, fsrs_state,
  fsrs_schedule_status, fsrs_card_id, fsrs_last_review,
  fsrs_reps, fsrs_lapses, fsrs_learning_steps, created_at, updated_at`;

/** Parse a JSON string column; throws with context on corrupt data. */
function parseJsonArray(value: string | null, column: string, cardId: string): unknown {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Corrupt JSON in cards.${column} (card ${cardId}): ${String(error)}`,
    );
  }
}

/** Row → app-level card: MC JSON strings parsed into arrays. */
function rowToCard(row: CardRow): Card {
  const optionen = parseJsonArray(row.mc_optionen, 'mc_optionen', row.id);
  const indizes = parseJsonArray(
    row.mc_richtige_indizes,
    'mc_richtige_indizes',
    row.id,
  );
  const appRow: Record<string, unknown> = { ...row };
  // The app-level Card carries the PARSED MC fields only — drop the raw
  // JSON-string columns so the object matches the declared Card shape.
  delete appRow.mc_optionen;
  delete appRow.mc_richtige_indizes;
  return {
    ...(appRow as unknown as CardRow),
    mcOptionen: (optionen as string[] | null) ?? null,
    mcRichtigeIndizes: (indizes as number[] | null) ?? null,
  };
}

/**
 * Validate MC payload structure app-side (the DB CHECK only enforces
 * presence/absence per typ):
 *  - mc: mcOptionen must be a non-empty array of strings,
 *    mcRichtigeIndizes a non-empty array of integers, each within
 *    [0, mcOptionen.length), no duplicates.
 *  - selbstbewertung: both must be absent/undefined.
 */
function validateMcFields(
  typ: CardTyp,
  mcOptionen: string[] | null | undefined,
  mcRichtigeIndizes: number[] | null | undefined,
): void {
  if (typ === 'mc') {
    if (
      !Array.isArray(mcOptionen) ||
      mcOptionen.length === 0 ||
      mcOptionen.some((o) => typeof o !== 'string')
    ) {
      throw new Error(
        "createCard: typ 'mc' requires mcOptionen as a non-empty array of strings",
      );
    }
    if (
      !Array.isArray(mcRichtigeIndizes) ||
      mcRichtigeIndizes.length === 0 ||
      mcRichtigeIndizes.some(
        (i) => !Number.isInteger(i) || i < 0 || i >= mcOptionen.length,
      )
    ) {
      throw new Error(
        "createCard: typ 'mc' requires mcRichtigeIndizes as a non-empty array of 0-based indices into mcOptionen",
      );
    }
    if (new Set(mcRichtigeIndizes).size !== mcRichtigeIndizes.length) {
      throw new Error('createCard: mcRichtigeIndizes contains duplicates');
    }
  } else if (mcOptionen !== undefined || mcRichtigeIndizes !== undefined) {
    throw new Error(
      "createCard: typ 'selbstbewertung' must not have MC fields",
    );
  }
}

/**
 * Create a card. New cards ALWAYS start as `entwurfsstatus='draft'` with an
 * untouched FSRS state (all fsrs_* columns NULL/0 — the state is initialized
 * when the card is activated via reviewCard).
 *
 * For typ='mc', mcOptionen/mcRichtigeIndizes are required and validated
 * (strings / 0-based unique integer indices); for typ='selbstbewertung'
 * they must be omitted (DB CHECK would reject them otherwise).
 */
export async function createCard(
  db: DbConnection,
  input: CreateCardInput,
): Promise<Card> {
  const frage = input.frage?.trim();
  const antwort = input.antwort?.trim();
  if (!frage) {
    throw new Error('createCard: frage must be a non-empty string');
  }
  if (!antwort) {
    throw new Error('createCard: antwort must be a non-empty string');
  }
  if (input.typ !== 'selbstbewertung' && input.typ !== 'mc') {
    throw new Error(`createCard: unknown typ: ${String(input.typ)}`);
  }
  validateMcFields(input.typ, input.mcOptionen, input.mcRichtigeIndizes);
  const quelle: CardQuelle = input.quelle ?? 'manuell';

  const now = nowIso();
  const row: CardRow = {
    id: generateId(),
    deck_id: input.deck_id,
    frage,
    antwort,
    typ: input.typ,
    mc_optionen:
      input.typ === 'mc' ? JSON.stringify(input.mcOptionen ?? []) : null,
    mc_richtige_indizes:
      input.typ === 'mc'
        ? JSON.stringify(input.mcRichtigeIndizes ?? [])
        : null,
    entwurfsstatus: 'draft',
    quelle,
    fsrs_due: null,
    fsrs_stability: null,
    fsrs_stability_fast: null,
    fsrs_difficulty: null,
    fsrs_state: null,
    fsrs_schedule_status: null,
    fsrs_card_id: null,
    fsrs_last_review: null,
    fsrs_reps: 0,
    fsrs_lapses: 0,
    fsrs_learning_steps: 0,
    created_at: now,
    updated_at: now,
  };

  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `INSERT INTO cards (${CARD_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.deck_id,
      row.frage,
      row.antwort,
      row.typ,
      row.mc_optionen,
      row.mc_richtige_indizes,
      row.entwurfsstatus,
      row.quelle,
      row.fsrs_due,
      row.fsrs_stability,
      row.fsrs_stability_fast,
      row.fsrs_difficulty,
      row.fsrs_state,
      row.fsrs_schedule_status,
      row.fsrs_card_id,
      row.fsrs_last_review,
      row.fsrs_reps,
      row.fsrs_lapses,
      row.fsrs_learning_steps,
      row.created_at,
      row.updated_at,
    );
  });
  return rowToCard(row);
}

/** Fetch a single card by id, or `null` when it does not exist. */
export async function getCard(
  db: DbConnection,
  id: string,
): Promise<Card | null> {
  const rows = await db.getAllAsync<CardRow>(
    `SELECT ${CARD_COLUMNS} FROM cards WHERE id = ?`,
    id,
  );
  const row = rows[0];
  return row ? rowToCard(row) : null;
}

/** Same as getCard, but throws when the card does not exist. */
export async function getCardOrThrow(
  db: DbConnection,
  id: string,
): Promise<Card> {
  const card = await getCard(db, id);
  if (!card) {
    throw new Error(`Card not found: ${id}`);
  }
  return card;
}

/**
 * List all cards of a deck, oldest first (created_at ASC, id as deterministic
 * tiebreaker for identical timestamps).
 */
export async function listCardsByDeck(
  db: DbConnection,
  deckId: string,
): Promise<Card[]> {
  const rows = await db.getAllAsync<CardRow>(
    `SELECT ${CARD_COLUMNS} FROM cards WHERE deck_id = ?
     ORDER BY created_at ASC, id ASC`,
    deckId,
  );
  return rows.map(rowToCard);
}

/**
 * Update a card's content (frage/antwort/MC fields). Sets `updated_at`
 * app-side. Never touches the FSRS state or the entwurfsstatus.
 *
 * MC rules when typ='mc': the patch may set either field alone — the other
 * one is kept from the row as it is right now, and the COMBINED state must
 * be valid (structure + index range), otherwise the update is rejected.
 * For typ='selbstbewertung' MC fields cannot be set. Throws when the card
 * does not exist.
 */
export async function updateCard(
  db: DbConnection,
  id: string,
  patch: UpdateCardInput,
): Promise<Card> {
  const existing = await getCardOrThrow(db, id);

  const frage = patch.frage !== undefined ? patch.frage?.trim() : undefined;
  if (frage === '') {
    throw new Error('updateCard: frage must be a non-empty string');
  }
  const antwort =
    patch.antwort !== undefined ? patch.antwort?.trim() : undefined;
  if (antwort === '') {
    throw new Error('updateCard: antwort must be a non-empty string');
  }

  if (existing.typ !== 'mc' && existing.typ !== 'selbstbewertung') {
    throw new Error(`updateCard: unknown card typ: ${String(existing.typ)}`);
  }
  if (
    existing.typ === 'selbstbewertung' &&
    (patch.mcOptionen !== undefined || patch.mcRichtigeIndizes !== undefined)
  ) {
    throw new Error(
      "updateCard: card typ 'selbstbewertung' must not have MC fields",
    );
  }
  let mcOptionen: string[] | null = null;
  let mcRichtigeIndizes: number[] | null = null;
  if (existing.typ === 'mc') {
    mcOptionen = existing.mcOptionen;
    mcRichtigeIndizes = existing.mcRichtigeIndizes;
  }
  const now = nowIso();
  await db.withExclusiveTransactionAsync(async (txn) => {
    // The UPDATE rewrites BOTH MC columns from the validated values, so they
    // must be based on the row as it is RIGHT NOW: re-read inside the
    // transaction (a stale in-memory snapshot racing a concurrent write
    // would otherwise resurrect an outdated field — the DB CHECK would
    // reject a mismatched pair anyway; this yields the better error).
    const freshRows = await txn.getAllAsync<Pick<CardRow, 'typ' | 'mc_optionen' | 'mc_richtige_indizes'>>(
      'SELECT typ, mc_optionen, mc_richtige_indizes FROM cards WHERE id = ?',
      id,
    );
    const fresh = freshRows[0];
    if (!fresh) {
      throw new Error(`Card not found: ${id}`);
    }
    if (fresh.typ === 'mc') {
      const freshOptionen = parseJsonArray(
        fresh.mc_optionen,
        'mc_optionen',
        id,
      ) as string[] | null;
      const freshIndizes = parseJsonArray(
        fresh.mc_richtige_indizes,
        'mc_richtige_indizes',
        id,
      ) as number[] | null;
      // Merge against the FRESH row, not the pre-transaction snapshot:
      // patched field wins, the other one comes from the row as it is now
      // (falling back to the snapshot only if the fresh column is NULL).
      const keptOptionen =
        patch.mcOptionen !== undefined
          ? patch.mcOptionen
          : (freshOptionen ?? mcOptionen);
      const keptIndizes =
        patch.mcRichtigeIndizes !== undefined
          ? patch.mcRichtigeIndizes
          : (freshIndizes ?? mcRichtigeIndizes);
      validateMcFields('mc', keptOptionen, keptIndizes);
      mcOptionen = keptOptionen;
      mcRichtigeIndizes = keptIndizes;
    }

    const result = await txn.runAsync(
      `UPDATE cards SET
         frage = ?, antwort = ?, mc_optionen = ?, mc_richtige_indizes = ?,
         updated_at = ?
       WHERE id = ?`,
      frage ?? existing.frage,
      antwort ?? existing.antwort,
      mcOptionen === null ? null : JSON.stringify(mcOptionen),
      mcRichtigeIndizes === null ? null : JSON.stringify(mcRichtigeIndizes),
      now,
      id,
    );
    if (Number(result.changes) === 0) {
      throw new Error(`Card not found: ${id}`);
    }
  });

  return getCardOrThrow(db, id);
}

/**
 * Move a card to `entwurfsstatus='reviewed'` (content signed off, not yet in
 * rotation). Allowed from draft and reviewed. Does NOT touch the FSRS state
 * (activation happens via reviewCard). Throws when the card does not exist
 * or is already active.
 */
export async function markCardReviewed(
  db: DbConnection,
  id: string,
): Promise<Card> {
  return db.withExclusiveTransactionAsync(async (txn) => {
    const rows = await txn.getAllAsync<Pick<CardRow, 'entwurfsstatus'>>(
      'SELECT entwurfsstatus FROM cards WHERE id = ?',
      id,
    );
    const current = rows[0]?.entwurfsstatus;
    if (current === undefined) {
      throw new Error(`Card not found: ${id}`);
    }
    if (current === 'active') {
      throw new Error(
        `Card ${id} is already active; draft→reviewed is the only reviewed-transition`,
      );
    }
    await txn.runAsync(
      "UPDATE cards SET entwurfsstatus = 'reviewed', updated_at = ? WHERE id = ?",
      nowIso(),
      id,
    );
    const updated = await txn.getAllAsync<CardRow>(
      `SELECT ${CARD_COLUMNS} FROM cards WHERE id = ?`,
      id,
    );
    return rowToCard(updated[0]);
  });
}

/**
 * Entwurfs-Workflow: activate a card for FSRS scheduling.
 *
 * Allowed from 'draft' or 'reviewed'; a no-op (returns the unchanged card)
 * when the card is already active. On first activation the FSRS state is
 * initialized (createEmptyCard equivalent, ts-fsrs v6 newCard):
 *   fsrs_due = now, stability/stabilityFast/difficulty = 0, state = 0 (New),
 *   scheduleStatus = 'new', last_review = NULL, reps/lapses/learning_steps = 0.
 * updated_at is set whenever the row actually changes.
 */
export async function reviewCard(
  db: DbConnection,
  id: string,
): Promise<Card> {
  const existing = await getCardOrThrow(db, id);
  if (existing.entwurfsstatus === 'active') {
    return existing; // no-op, no updated_at churn
  }

  const fsrsCard = await createNewCard(new Date());
  const serialized = serializeCard(fsrsCard);

  await db.withExclusiveTransactionAsync(async (txn) => {
    const result = await txn.runAsync(
      `UPDATE cards SET
         entwurfsstatus = 'active',
         fsrs_due = ?, fsrs_stability = ?, fsrs_stability_fast = ?,
         fsrs_difficulty = ?, fsrs_state = ?, fsrs_schedule_status = ?,
         fsrs_card_id = ?, fsrs_last_review = NULL,
         fsrs_reps = 0, fsrs_lapses = 0, fsrs_learning_steps = 0,
         updated_at = ?
       WHERE id = ?`,
      serialized.dueAt,
      serialized.stability,
      serialized.stabilityFast,
      serialized.difficulty,
      serialized.state,
      serialized.scheduleStatus,
      serialized.cardId,
      nowIso(),
      id,
    );
    if (Number(result.changes) === 0) {
      throw new Error(`Card not found: ${id}`);
    }
  });

  return getCardOrThrow(db, id);
}

/** Delete a card (its review_log rows go with it via CASCADE). */
export async function deleteCard(
  db: DbConnection,
  id: string,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const result = await txn.runAsync('DELETE FROM cards WHERE id = ?', id);
    if (Number(result.changes) === 0) {
      throw new Error(`Card not found: ${id}`);
    }
  });
}
