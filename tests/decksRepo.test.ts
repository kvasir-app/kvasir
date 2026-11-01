/**
 * Unit tests for decksRepo — CRUD on the `decks` table (Kvasir M1).
 *
 * Runs the EXACT production repo code against an in-memory SQLite
 * (node:sqlite) via the shared adapter in ./helpers/db. No emulator needed.
 *
 * Conventions under test (docs/schema.md + verbindliche Entscheidungen):
 *  - deleteDeck = CASCADE (D5): deck deletion removes its cards and their
 *    review_log rows — requires PRAGMA foreign_keys = ON per connection.
 *  - updated_at is set app-side on every update.
 *  - missing ids are errors, not silent no-ops.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDeck,
  deleteDeck,
  getDeck,
  getDeckOrThrow,
  listDecks,
  updateDeck,
} from '../src/db/decksRepo';
import { createCard } from '../src/db/cardsRepo';
import { makeTestDb, type DbConnection } from './helpers/db';
import type { DatabaseSync } from 'node:sqlite';

let sqlite: DatabaseSync;
let db: DbConnection;

beforeEach(async () => {
  ({ sqlite, db } = await makeTestDb());
});

afterEach(() => {
  sqlite.close();
});

describe('createDeck', () => {
  it('creates a deck with generated UUID, timestamps, and trimmed title', async () => {
    const before = new Date().toISOString();

    const deck = await createDeck(db, {
      titel: '  Anatomie  ',
      beschreibung: 'Grundlagen',
    });

    expect(deck.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(deck.titel).toBe('Anatomie');
    expect(deck.beschreibung).toBe('Grundlagen');
    expect(deck.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(deck.updated_at).toBe(deck.created_at);
    expect(deck.created_at >= before.slice(0, 19)).toBe(true);

    const raw = sqlite
      .prepare('SELECT * FROM decks WHERE id = ?')
      .get(deck.id) as Record<string, unknown>;
    expect(raw.titel).toBe('Anatomie');
    expect(raw.beschreibung).toBe('Grundlagen');
  });

  it('persists beschreibung = NULL when omitted', async () => {
    const deck = await createDeck(db, { titel: 'Ohne Beschreibung' });
    expect(deck.beschreibung).toBeNull();
  });

  it('rejects an empty title', async () => {
    await expect(createDeck(db, { titel: '' })).rejects.toThrow(/titel/);
    await expect(createDeck(db, { titel: '   ' })).rejects.toThrow(/titel/);
  });
});

describe('getDeck / getDeckOrThrow', () => {
  it('returns the created deck', async () => {
    const created = await createDeck(db, { titel: 'Deck A' });
    const loaded = await getDeck(db, created.id);
    expect(loaded).toEqual(created);
  });

  it('returns null for a missing id', async () => {
    expect(await getDeck(db, 'does-not-exist')).toBeNull();
  });

  it('getDeckOrThrow throws for a missing id', async () => {
    await expect(getDeckOrThrow(db, 'does-not-exist')).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('listDecks', () => {
  it('lists decks newest first with a deterministic tiebreak', async () => {
    const a = await createDeck(db, { titel: 'A' });
    await new Promise((r) => setTimeout(r, 2));
    const b = await createDeck(db, { titel: 'B' });
    await new Promise((r) => setTimeout(r, 2));
    const c = await createDeck(db, { titel: 'C' });

    const decks = await listDecks(db);
    expect(decks.map((d) => d.id)).toEqual([c.id, b.id, a.id]);
  });

  it('returns [] on an empty database', async () => {
    expect(await listDecks(db)).toEqual([]);
  });
});

describe('updateDeck', () => {
  it('updates the title and bumps updated_at', async () => {
    const deck = await createDeck(db, { titel: 'Alt' });
    await new Promise((r) => setTimeout(r, 5));

    const updated = await updateDeck(db, deck.id, { titel: 'Neu' });
    expect(updated.titel).toBe('Neu');
    expect(updated.beschreibung).toBeNull();
    expect(updated.updated_at > deck.updated_at).toBe(true);
    expect(updated.created_at).toBe(deck.created_at);
  });

  it('updates only beschreibung when titel is not in the patch', async () => {
    const deck = await createDeck(db, { titel: 'Titel', beschreibung: 'alt' });
    const updated = await updateDeck(db, deck.id, { beschreibung: 'neu' });
    expect(updated.titel).toBe('Titel');
    expect(updated.beschreibung).toBe('neu');
  });

  it('sets beschreibung to NULL via explicit null', async () => {
    const deck = await createDeck(db, { titel: 'T', beschreibung: 'x' });
    const updated = await updateDeck(db, deck.id, { beschreibung: null });
    expect(updated.beschreibung).toBeNull();
  });

  it('rejects an empty title patch', async () => {
    const deck = await createDeck(db, { titel: 'T' });
    await expect(updateDeck(db, deck.id, { titel: '  ' })).rejects.toThrow(
      /titel/,
    );
  });

  it('rejects an empty patch', async () => {
    const deck = await createDeck(db, { titel: 'T' });
    await expect(updateDeck(db, deck.id, {})).rejects.toThrow(/empty patch/);
  });

  it('throws for a missing id', async () => {
    await expect(
      updateDeck(db, 'missing', { titel: 'X' }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('deleteDeck (CASCADE)', () => {
  it('deletes the deck and cascades to cards and review_log rows', async () => {
    const deck = await createDeck(db, { titel: 'Kaskade' });
    await createCard(db, {
      deck_id: deck.id,
      frage: 'F',
      antwort: 'A',
      typ: 'selbstbewertung',
    });
    await createCard(db, {
      deck_id: deck.id,
      frage: 'F2',
      antwort: 'A2',
      typ: 'mc',
      mcOptionen: ['a', 'b'],
      mcRichtigeIndizes: [0],
    });

    const rawLogCount = sqlite
      .prepare('SELECT COUNT(*) AS n FROM review_log')
      .get() as { n: number };
    expect(rawLogCount.n).toBe(0);

    const result = await deleteDeck(db, deck.id);
    expect(result.deletedCards).toBe(2);

    expect(await getDeck(db, deck.id)).toBeNull();
    const cardsLeft = sqlite
      .prepare('SELECT COUNT(*) AS n FROM cards')
      .get() as { n: number };
    expect(cardsLeft.n).toBe(0);
    const logsLeft = sqlite
      .prepare('SELECT COUNT(*) AS n FROM review_log')
      .get() as { n: number };
    expect(logsLeft.n).toBe(0);
  });

  it('reports deletedCards = 0 for an empty deck', async () => {
    const deck = await createDeck(db, { titel: 'Leer' });
    const result = await deleteDeck(db, deck.id);
    expect(result.deletedCards).toBe(0);
    expect(await getDeck(db, deck.id)).toBeNull();
  });

  it('throws for a missing id', async () => {
    await expect(deleteDeck(db, 'missing')).rejects.toThrow(/not found/i);
  });
});
