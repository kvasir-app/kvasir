/**
 * Unit tests for cardsRepo — CRUD + Entwurfs-Workflow on `cards` (Kvasir M1).
 *
 * Runs the EXACT production repo code against an in-memory SQLite
 * (node:sqlite) via the shared adapter in ./helpers/db. No emulator needed.
 *
 * Conventions under test (docs/schema.md + verbindliche Entscheidungen):
 *  - createCard always stores entwurfsstatus='draft' with an untouched FSRS
 *    state; reviewCard activates (draft→active / reviewed→active) and
 *    initializes the FSRS state (createEmptyCard equivalent).
 *  - MC fields stored as JSON strings; roundtrip must be lossless.
 *  - updated_at set app-side on every update; missing ids are errors.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  createCard,
  deleteCard,
  getCard,
  getCardOrThrow,
  listCardsByDeck,
  markCardReviewed,
  reviewCard,
  updateCard,
  type Card,
} from '../src/db/cardsRepo';
import { createDeck } from '../src/db/decksRepo';
import { makeTestDb, type DbConnection } from './helpers/db';

let sqlite: DatabaseSync;
let db: DbConnection;
let deckId: string;

beforeEach(async () => {
  ({ sqlite, db } = await makeTestDb());
  deckId = (await createDeck(db, { titel: 'Testdeck' })).id;
});

afterEach(() => {
  sqlite.close();
});

/** Create a self-assessment card with defaults. */
function makeSelfInput(overrides: Partial<Parameters<typeof createCard>[1]> = {}) {
  return {
    deck_id: deckId,
    frage: 'Was ist Mitose?',
    antwort: 'Zellteilung',
    typ: 'selbstbewertung' as const,
    ...overrides,
  };
}

/** Create an MC card with defaults. */
function makeMcInput(overrides: Partial<Parameters<typeof createCard>[1]> = {}) {
  return {
    deck_id: deckId,
    frage: 'Welche sind Primzahlen?',
    antwort: '2 und 3',
    typ: 'mc' as const,
    mcOptionen: ['1', '2', '3', '4'],
    mcRichtigeIndizes: [1, 2],
    ...overrides,
  };
}

describe('createCard', () => {
  it('creates a draft card with untouched FSRS state and default quelle', async () => {
    const card = await createCard(db, makeSelfInput());

    expect(card.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(card.deck_id).toBe(deckId);
    expect(card.entwurfsstatus).toBe('draft');
    expect(card.quelle).toBe('manuell');
    expect(card.fsrs_due).toBeNull();
    expect(card.fsrs_stability).toBeNull();
    expect(card.fsrs_state).toBeNull();
    expect(card.fsrs_reps).toBe(0);
    expect(card.fsrs_lapses).toBe(0);
    expect(card.fsrs_learning_steps).toBe(0);
    expect(card.created_at).toBe(card.updated_at);
    expect(card.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('stores MC fields as JSON strings in the DB (lossless roundtrip)', async () => {
    const optionen = ['Mitose', 'Meiose', 'Apoptose'];
    const indizes = [0, 2];
    const card = await createCard(db, makeMcInput({ mcOptionen: optionen, mcRichtigeIndizes: indizes }));

    const raw = sqlite
      .prepare('SELECT mc_optionen, mc_richtige_indizes FROM cards WHERE id = ?')
      .get(card.id) as { mc_optionen: string; mc_richtige_indizes: string };
    expect(JSON.parse(raw.mc_optionen)).toEqual(optionen);
    expect(JSON.parse(raw.mc_richtige_indizes)).toEqual(indizes);

    const loaded = await getCardOrThrow(db, card.id);
    expect(loaded.mcOptionen).toEqual(optionen);
    expect(loaded.mcRichtigeIndizes).toEqual(indizes);
  });

  it('keeps unicode and special characters intact through the JSON roundtrip', async () => {
    const optionen = ['äöü "quotes"', 'back\\slash', 'emoji 🧠'];
    const card = await createCard(db, makeMcInput({ mcOptionen: optionen, mcRichtigeIndizes: [2] }));
    const loaded = await getCardOrThrow(db, card.id);
    expect(loaded.mcOptionen).toEqual(optionen);
  });

  it('accepts quelle=ki', async () => {
    const card = await createCard(db, makeSelfInput({ quelle: 'ki' }));
    expect(card.quelle).toBe('ki');
  });

  it('rejects a missing deck (FK)', async () => {
    await expect(
      createCard(db, makeSelfInput({ deck_id: 'missing-deck' })),
    ).rejects.toThrow(/FOREIGN KEY|foreign key/i);
  });

  it('rejects empty frage/antwort and unknown typ', async () => {
    await expect(createCard(db, makeSelfInput({ frage: '  ' }))).rejects.toThrow(/frage/);
    await expect(createCard(db, makeSelfInput({ antwort: '' }))).rejects.toThrow(/antwort/);
    await expect(
      createCard(db, makeSelfInput({ typ: 'cloze' as never })),
    ).rejects.toThrow(/typ/);
  });

  it('rejects MC cards without valid MC fields', async () => {
    await expect(
      createCard(db, makeMcInput({ mcOptionen: undefined })),
    ).rejects.toThrow(/mcOptionen/);
    await expect(
      createCard(db, makeMcInput({ mcRichtigeIndizes: undefined })),
    ).rejects.toThrow(/mcRichtigeIndizes/);
    await expect(
      createCard(db, makeMcInput({ mcOptionen: [] })),
    ).rejects.toThrow(/mcOptionen/);
    await expect(
      createCard(db, makeMcInput({ mcOptionen: ['a', 1 as never] })),
    ).rejects.toThrow(/mcOptionen/);
    await expect(
      createCard(db, makeMcInput({ mcRichtigeIndizes: [4] })),
    ).rejects.toThrow(/mcRichtigeIndizes/);
    await expect(
      createCard(db, makeMcInput({ mcRichtigeIndizes: [-1] })),
    ).rejects.toThrow(/mcRichtigeIndizes/);
    await expect(
      createCard(db, makeMcInput({ mcRichtigeIndizes: [1.5] })),
    ).rejects.toThrow(/mcRichtigeIndizes/);
    await expect(
      createCard(db, makeMcInput({ mcRichtigeIndizes: [1, 1] })),
    ).rejects.toThrow(/duplicates/);
  });

  it('rejects selbstbewertung cards with MC fields (DB CHECK mirrored app-side)', async () => {
    await expect(
      createCard(db, makeSelfInput({ mcOptionen: ['a'] })),
    ).rejects.toThrow(/selbstbewertung/);
    await expect(
      createCard(db, makeSelfInput({ mcRichtigeIndizes: [0] })),
    ).rejects.toThrow(/selbstbewertung/);
  });
});

describe('getCard / getCardOrThrow', () => {
  it('returns the created card with parsed MC fields', async () => {
    const created = await createCard(db, makeMcInput());
    const loaded = await getCard(db, created.id);
    expect(loaded).toEqual(created);
    expect(Array.isArray(loaded?.mcOptionen)).toBe(true);
  });

  it('returns null for a missing id; getCardOrThrow throws', async () => {
    expect(await getCard(db, 'missing')).toBeNull();
    await expect(getCardOrThrow(db, 'missing')).rejects.toThrow(/not found/i);
  });
});

describe('listCardsByDeck', () => {
  it('lists only the cards of the given deck, oldest first', async () => {
    const c1 = await createCard(db, makeSelfInput({ frage: 'F1' }));
    await new Promise((r) => setTimeout(r, 2));
    const c2 = await createCard(db, makeMcInput({ frage: 'F2' }));
    await new Promise((r) => setTimeout(r, 2));
    const c3 = await createCard(db, makeSelfInput({ frage: 'F3' }));

    const otherDeck = (await createDeck(db, { titel: 'Anderes Deck' })).id;
    await createCard(db, makeSelfInput({ deck_id: otherDeck, frage: 'Fremd' }));

    const cards = await listCardsByDeck(db, deckId);
    expect(cards.map((c) => c.id)).toEqual([c1.id, c2.id, c3.id]);
    expect(cards.every((c) => c.deck_id === deckId)).toBe(true);
  });

  it('returns [] for a deck without cards', async () => {
    expect(await listCardsByDeck(db, deckId)).toEqual([]);
  });
});

describe('updateCard', () => {
  it('updates frage/antwort and bumps updated_at only', async () => {
    const card = await createCard(db, makeSelfInput());
    await new Promise((r) => setTimeout(r, 5));

    const updated = await updateCard(db, card.id, {
      frage: 'Neue Frage',
      antwort: 'Neue Antwort',
    });
    expect(updated.frage).toBe('Neue Frage');
    expect(updated.antwort).toBe('Neue Antwort');
    expect(updated.updated_at > card.updated_at).toBe(true);
    expect(updated.created_at).toBe(card.created_at);
    // FSRS state untouched
    expect(updated.fsrs_due).toBeNull();
    expect(updated.entwurfsstatus).toBe('draft');
  });

  it('updates MC fields with a lossless roundtrip', async () => {
    const card = await createCard(db, makeMcInput());
    const updated = await updateCard(db, card.id, {
      mcOptionen: ['a', 'b', 'c'],
      mcRichtigeIndizes: [0, 2],
    });
    expect(updated.mcOptionen).toEqual(['a', 'b', 'c']);
    expect(updated.mcRichtigeIndizes).toEqual([0, 2]);

    const raw = sqlite
      .prepare('SELECT mc_optionen, mc_richtige_indizes FROM cards WHERE id = ?')
      .get(card.id) as { mc_optionen: string; mc_richtige_indizes: string };
    expect(JSON.parse(raw.mc_optionen)).toEqual(['a', 'b', 'c']);
    expect(JSON.parse(raw.mc_richtige_indizes)).toEqual([0, 2]);
  });

  it('partial MC patch: unchanged field is kept, combined state must stay valid', async () => {
    const card = await createCard(db, makeMcInput());
    // Only indices patched → options unchanged, combined state valid
    const updated = await updateCard(db, card.id, { mcRichtigeIndizes: [0] });
    expect(updated.mcOptionen).toEqual(['1', '2', '3', '4']);
    expect(updated.mcRichtigeIndizes).toEqual([0]);
    // Only options patched to a SHORTER list → the kept indices [0] stay in
    // range, so this is VALID and succeeds (partial patch semantics).
    const updated2 = await updateCard(db, card.id, { mcOptionen: ['x', 'y'] });
    expect(updated2.mcOptionen).toEqual(['x', 'y']);
    expect(updated2.mcRichtigeIndizes).toEqual([0]);
    // But a patch that leaves the combined state INVALID is rejected:
    // indices [0, 1, 2] contain 2 — out of range for the 2-element options.
    await expect(
      updateCard(db, card.id, { mcRichtigeIndizes: [0, 1, 2] }),
    ).rejects.toThrow(/mcRichtigeIndizes/);
  });

  it('rejects invalid MC patches (index out of range, duplicates)', async () => {
    const card = await createCard(db, makeMcInput());
    await expect(
      updateCard(db, card.id, { mcRichtigeIndizes: [9] }),
    ).rejects.toThrow(/mcRichtigeIndizes/);
    await expect(
      updateCard(db, card.id, { mcRichtigeIndizes: [0, 0] }),
    ).rejects.toThrow(/duplicates/);
    await expect(
      updateCard(db, card.id, { mcOptionen: ['only-one'] }),
    ).rejects.toThrow(/mcRichtigeIndizes/); // existing indices no longer in range
  });

  it('rejects MC fields on a selbstbewertung card', async () => {
    const card = await createCard(db, makeSelfInput());
    await expect(
      updateCard(db, card.id, { mcOptionen: ['a'] }),
    ).rejects.toThrow(/selbstbewertung/);
  });

  it('rejects empty frage/antwort patches', async () => {
    const card = await createCard(db, makeSelfInput());
    await expect(updateCard(db, card.id, { frage: ' ' })).rejects.toThrow(/frage/);
    await expect(updateCard(db, card.id, { antwort: '' })).rejects.toThrow(/antwort/);
  });

  it('throws for a missing id', async () => {
    await expect(
      updateCard(db, 'missing', { frage: 'X' }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('Entwurfs-Workflow: markCardReviewed / reviewCard', () => {
  it('reviewCard: draft→active initializes the FSRS state (createEmptyCard equivalent)', async () => {
    const card = await createCard(db, makeSelfInput());
    const before = card.updated_at;
    await new Promise((r) => setTimeout(r, 5));

    const active = await reviewCard(db, card.id);
    expect(active.entwurfsstatus).toBe('active');
    expect(active.fsrs_due).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(active.fsrs_stability).toBe(0);
    expect(active.fsrs_stability_fast).toBe(0);
    expect(active.fsrs_difficulty).toBe(0);
    expect(active.fsrs_state).toBe(0); // New
    expect(active.fsrs_schedule_status).toBe('new');
    expect(active.fsrs_last_review).toBeNull();
    expect(active.fsrs_reps).toBe(0);
    expect(active.fsrs_lapses).toBe(0);
    expect(active.fsrs_learning_steps).toBe(0);
    expect(active.updated_at > before).toBe(true);

    // The persisted due date must be parseable and near now
    const dueMs = Date.parse(active.fsrs_due as string);
    expect(Number.isNaN(dueMs)).toBe(false);
    expect(Math.abs(Date.now() - dueMs)).toBeLessThan(60_000);
  });

  it('reviewCard on an already active card is a no-op (no updated_at churn)', async () => {
    const card = await createCard(db, makeSelfInput());
    const active = await reviewCard(db, card.id);
    const again = await reviewCard(db, card.id);
    expect(again.updated_at).toBe(active.updated_at);
    expect(again.fsrs_due).toBe(active.fsrs_due);
  });

  it('reviewCard works from reviewed→active too', async () => {
    const card = await createCard(db, makeSelfInput());
    const reviewed = await markCardReviewed(db, card.id);
    expect(reviewed.entwurfsstatus).toBe('reviewed');
    // draft→reviewed does NOT touch the FSRS state
    expect(reviewed.fsrs_due).toBeNull();

    const active = await reviewCard(db, card.id);
    expect(active.entwurfsstatus).toBe('active');
    expect(active.fsrs_state).toBe(0);
    expect(active.fsrs_due).not.toBeNull();
  });

  it('markCardReviewed: draft→reviewed keeps the FSRS state untouched', async () => {
    const card = await createCard(db, makeSelfInput());
    await new Promise((r) => setTimeout(r, 5));
    const reviewed = await markCardReviewed(db, card.id);
    expect(reviewed.entwurfsstatus).toBe('reviewed');
    expect(reviewed.fsrs_due).toBeNull();
    expect(reviewed.fsrs_reps).toBe(0);
    expect(reviewed.updated_at > card.updated_at).toBe(true);
  });

  it('markCardReviewed: active→reviewed keeps the FSRS state (quality loop, schema.md §4)', async () => {
    const card = await createCard(db, makeSelfInput());
    const active = await reviewCard(db, card.id);
    const pulled = await markCardReviewed(db, card.id);
    expect(pulled.entwurfsstatus).toBe('reviewed');
    // The whole FSRS state survives the pull — the card keeps its scheduling
    // history and re-enters the loop with it when reviewCard re-activates it.
    expect(pulled.fsrs_due).toBe(active.fsrs_due);
    expect(pulled.fsrs_stability).toBe(active.fsrs_stability);
    expect(pulled.fsrs_difficulty).toBe(active.fsrs_difficulty);
    expect(pulled.fsrs_state).toBe(active.fsrs_state);
    expect(pulled.fsrs_reps).toBe(active.fsrs_reps);
    expect(pulled.fsrs_lapses).toBe(active.fsrs_lapses);
    expect(pulled.updated_at >= active.updated_at).toBe(true);
  });

  it('both functions throw for missing ids', async () => {
    await expect(reviewCard(db, 'missing')).rejects.toThrow(/not found/i);
    await expect(markCardReviewed(db, 'missing')).rejects.toThrow(/not found/i);
  });
});

describe('deleteCard', () => {
  it('deletes the card; review_log rows go with it via CASCADE', async () => {
    const card = await createCard(db, makeSelfInput());
    const active = await reviewCard(db, card.id);

    // Simulate a review_log row (reviewLogRepo is a separate task) to prove
    // the CASCADE path cards→review_log works from the card side.
    sqlite
      .prepare(
        `INSERT INTO review_log (id, karte_id, reviewed_at, rating, ergebnis,
           fsrs_state, fsrs_due, fsrs_stability, fsrs_difficulty)
         VALUES ('log1', ?, '2026-01-01T00:00:00.000Z', 3, 1, 0, ?, 0, 0)`,
      )
      .run(card.id, active.fsrs_due);

    await deleteCard(db, card.id);
    expect(await getCard(db, card.id)).toBeNull();
    const logs = sqlite
      .prepare('SELECT COUNT(*) AS n FROM review_log WHERE karte_id = ?')
      .get(card.id) as { n: number };
    expect(logs.n).toBe(0);
  });

  it('throws for a missing id', async () => {
    await expect(deleteCard(db, 'missing')).rejects.toThrow(/not found/i);
  });
});

describe('rowToCard robustness', () => {
  it('throws a contextual error on corrupt MC JSON instead of failing silently', async () => {
    const card = await createCard(db, makeMcInput());
    sqlite
      .prepare('UPDATE cards SET mc_optionen = ? WHERE id = ?')
      .run('{not-json', card.id);
    await expect(getCardOrThrow(db, card.id)).rejects.toThrow(
      /Corrupt JSON in cards\.mc_optionen/,
    );
  });

  it('maps a raw DB row to the app Card shape (camelCase MC fields)', async () => {
    const card: Card = await createCard(db, makeMcInput());
    expect(card).toHaveProperty('mcOptionen');
    expect(card).toHaveProperty('mcRichtigeIndizes');
    expect(card).not.toHaveProperty('mc_optionen');
  });
});
