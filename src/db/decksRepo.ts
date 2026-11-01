/**
 * decksRepo — CRUD for the `decks` table (Kvasir M1).
 *
 * Conventions (docs/schema.md, verbindliche Entscheidungen):
 *  - IDs are client-generated UUIDv4 TEXT PKs (sync prep; no autoincrement).
 *  - Timestamps are ISO-8601 UTC strings (`new Date().toISOString()`); the
 *    APP sets `updated_at` on every update — SQLite does not do it for us.
 *  - deleteDeck is CASCADE (schema decision D5): deleting a deck removes its
 *    cards and, transitively, their review_log rows. This is a deliberate,
 *    documented decision — NOT a blocking delete. It requires
 *    `PRAGMA foreign_keys = ON` on the connection (expo-sqlite does not
 *    persist PRAGMAs; the app sets it in prepareDatabase, tests set it per
 *    connection).
 *
 * Every write runs inside withExclusiveTransactionAsync so a multi-statement
 * operation can never land half-applied.
 */
import type { DbBindValue, DbConnection } from './connection';
import { generateId, nowIso } from './util';

/** Deck row as stored in SQLite (all fields TEXT). */
export interface DeckRow {
  id: string;
  titel: string;
  beschreibung: string | null;
  created_at: string;
  updated_at: string;
}

/** Payload for creating a deck. `beschreibung` is optional. */
export interface CreateDeckInput {
  titel: string;
  beschreibung?: string | null;
}

/** Payload for updating a deck. Only provided fields are written. */
export interface UpdateDeckInput {
  titel?: string;
  beschreibung?: string | null;
}

const DECK_COLUMNS = 'id, titel, beschreibung, created_at, updated_at';

function rowToDeck(row: DeckRow): DeckRow {
  return row;
}

/**
 * Create a deck. `titel` must be a non-empty string (NOT NULL in the DDL);
 * empty/whitespace-only titles are rejected app-side.
 */
export async function createDeck(
  db: DbConnection,
  input: CreateDeckInput,
): Promise<DeckRow> {
  const titel = input.titel?.trim();
  if (!titel) {
    throw new Error('createDeck: titel must be a non-empty string');
  }

  const now = nowIso();
  const deck: DeckRow = {
    id: generateId(),
    titel,
    beschreibung: input.beschreibung ?? null,
    created_at: now,
    updated_at: now,
  };

  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `INSERT INTO decks (id, titel, beschreibung, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      deck.id,
      deck.titel,
      deck.beschreibung,
      deck.created_at,
      deck.updated_at,
    );
  });
  return deck;
}

/** Fetch a single deck by id, or `null` when it does not exist. */
export async function getDeck(
  db: DbConnection,
  id: string,
): Promise<DeckRow | null> {
  const rows = await db.getAllAsync<DeckRow>(
    `SELECT ${DECK_COLUMNS} FROM decks WHERE id = ?`,
    id,
  );
  const row = rows[0];
  return row ? rowToDeck(row) : null;
}

/** Same as getDeck, but throws when the deck does not exist. */
export async function getDeckOrThrow(
  db: DbConnection,
  id: string,
): Promise<DeckRow> {
  const deck = await getDeck(db, id);
  if (!deck) {
    throw new Error(`Deck not found: ${id}`);
  }
  return deck;
}

/**
 * List all decks, newest first (created_at DESC, id as deterministic
 * tiebreaker for identical timestamps).
 */
export async function listDecks(db: DbConnection): Promise<DeckRow[]> {
  return db.getAllAsync<DeckRow>(
    `SELECT ${DECK_COLUMNS} FROM decks ORDER BY created_at DESC, id DESC`,
  );
}

/**
 * Update a deck (partial). Sets `updated_at` app-side. Throws when the deck
 * does not exist (missing id is an error, not a silent no-op).
 */
export async function updateDeck(
  db: DbConnection,
  id: string,
  patch: UpdateDeckInput,
): Promise<DeckRow> {
  const sets: string[] = [];
  const params: DbBindValue[] = [];

  if (patch.titel !== undefined) {
    const titel = patch.titel?.trim();
    if (!titel) {
      throw new Error('updateDeck: titel must be a non-empty string');
    }
    sets.push('titel = ?');
    params.push(titel);
  }
  if (patch.beschreibung !== undefined) {
    sets.push('beschreibung = ?');
    params.push(patch.beschreibung);
  }
  if (sets.length === 0) {
    throw new Error('updateDeck: empty patch');
  }

  sets.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);

  await db.withExclusiveTransactionAsync(async (txn) => {
    const result = await txn.runAsync(
      `UPDATE decks SET ${sets.join(', ')} WHERE id = ?`,
      ...params,
    );
    if (Number(result.changes) === 0) {
      throw new Error(`Deck not found: ${id}`);
    }
  });

  return getDeckOrThrow(db, id);
}

/**
 * Delete a deck. CASCADE removes its cards and their review_log rows
 * (schema decision D5) — see the module docblock. Throws when the deck does
 * not exist. Returns the number of cards that were removed with it.
 */
export async function deleteDeck(
  db: DbConnection,
  id: string,
): Promise<{ deletedCards: number }> {
  return await db.withExclusiveTransactionAsync(async (txn) => {
    const deck = await txn.getAllAsync<{ id: string }>(
      'SELECT id FROM decks WHERE id = ?',
      id,
    );
    if (deck.length === 0) {
      throw new Error(`Deck not found: ${id}`);
    }
    const counted = await txn.getAllAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM cards WHERE deck_id = ?',
      id,
    );
    const deletedCards = Number(counted[0]?.n ?? 0);
    await txn.runAsync('DELETE FROM decks WHERE id = ?', id);
    return { deletedCards };
  });
}
