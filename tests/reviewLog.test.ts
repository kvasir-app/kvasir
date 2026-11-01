/**
 * reviewLogRepo tests against a real SQLite engine.
 *
 * Same pattern as tests/migrations.test.ts: the repo operates on the minimal
 * `MigrationConnection` interface, so these tests run the EXACT production
 * logic against node:sqlite (DatabaseSync) — no emulator needed. The ts-fsrs
 * scheduler is the real one (DefaultScheduler, FSRS-7 weights).
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initializeFsrsState,
  getDueCards,
  getReviewStats,
  logReview,
  type ReviewLogRow,
} from '../src/db/reviewLogRepo';
import { Rating, State } from '../src/db/fsrs';
import { runMigrations } from '../src/db/migrations/runner';
import type { MigrationConnection } from '../src/db/migrations';

/** Wrap node:sqlite's synchronous DatabaseSync as an async MigrationConnection. */
function makeConnection(db: DatabaseSync): MigrationConnection {
  return {
    async execAsync(source: string) {
      db.exec(source);
    },
    async runAsync(source: string, ...params: unknown[]) {
      // node:sqlite names it `lastInsertRowid`, expo-sqlite `lastInsertRowId`
      // — same value (sqlite3_last_insert_rowid), only the casing differs.
      const result = db.prepare(source).run(...(trimParams(params) as never[]));
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
    async getAllAsync<T>(source: string, ...params: unknown[]) {
      return db.prepare(source).all(...(trimParams(params) as never[])) as T[];
    },
    async withExclusiveTransactionAsync<T>(task: (txn: MigrationConnection) => Promise<T>) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await task(this);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

/**
 * node:sqlite rejects extra statement parameters ("column index out of
 * range"); expo-sqlite ignores them. The adapter drops trailing undefined
 * params so both engines behave identically (expo semantics are the app
 * truth; node:sqlite is only the test engine).
 */
function trimParams(params: unknown[]): unknown[] {
  const trimmed = [...params];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) {
    trimmed.pop();
  }
  return trimmed;
}

let sqlite: DatabaseSync;
let conn: MigrationConnection;
let deckSeq = 0;
let cardSeq = 0;

/** Insert a deck and return its id. */
async function seedDeck(): Promise<string> {
  const id = `deck-${++deckSeq}`;
  await conn.runAsync(
    'INSERT INTO decks (id, titel, created_at, updated_at) VALUES (?, ?, ?, ?)',
    id,
    `Deck ${deckSeq}`,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );
  return id;
}

/** Insert a card (draft by default) and return its id. */
async function seedCard(deckId: string, status: 'draft' | 'active' | 'reviewed' = 'draft'): Promise<string> {
  const id = `card-${++cardSeq}`;
  await conn.runAsync(
    `INSERT INTO cards (id, deck_id, frage, antwort, typ, entwurfsstatus, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'selbstbewertung', ?, ?, ?)`,
    id,
    deckId,
    `Frage ${cardSeq}`,
    'Antwort',
    status,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );
  return id;
}

/** Seed card + activate it the way reviewCard() will: initialize the FSRS
 * state (while the card is still draft/reviewed — initializeFsrsState keeps a
 * running state untouched), THEN set entwurfsstatus='active'. */
async function seedActiveCard(deckId: string, now = new Date('2026-01-01T00:00:00.000Z')): Promise<string> {
  const id = await seedCard(deckId);
  await initializeFsrsState(conn, id, now);
  await conn.runAsync('UPDATE cards SET entwurfsstatus = ? WHERE id = ?', 'active', id);
  return id;
}

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-01T01:00:00.000Z');
const T2 = new Date('2026-01-01T02:00:00.000Z');

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  conn = makeConnection(sqlite);
  await runMigrations(conn);
  deckSeq = 0;
  cardSeq = 0;
});

afterEach(() => {
  sqlite.close();
});

describe('logReview — state persistence and atomicity', () => {
  it('writes a log row (state BEFORE review) and advances the card state atomically', async () => {
    const deck = await seedDeck();
    const card = await seedActiveCard(deck);

    const row = await logReview(conn, card, Rating.Good, 1, T0);

    // Log row: snapshot BEFORE the review (D4) — New card: stability/difficulty 0
    const log = sqlite
      .prepare('SELECT * FROM review_log WHERE id = ?')
      .get(row.id) as unknown as ReviewLogRow;
    expect(log.karte_id).toBe(card);
    expect(log.reviewed_at).toBe(T0.toISOString());
    expect(log.rating).toBe(Rating.Good);
    expect(log.ergebnis).toBe(1);
    expect(log.fsrs_state).toBe(State.New);
    expect(log.fsrs_due).toBe(T0.toISOString()); // activation time
    expect(log.fsrs_stability).toBe(0);
    expect(log.fsrs_difficulty).toBe(0);

    // Card: advanced state — due strictly in the future, reps incremented
    const after = sqlite.prepare('SELECT * FROM cards WHERE id = ?').get(card) as {
      fsrs_due: string;
      fsrs_stability: number;
      fsrs_difficulty: number;
      fsrs_state: number;
      fsrs_last_review: string;
      fsrs_reps: number;
      entwurfsstatus: string;
    };
    expect(BigInt(Date.parse(after.fsrs_due))).toBeGreaterThan(BigInt(T0.getTime()));
    expect(after.fsrs_stability).toBeGreaterThan(0);
    expect(after.fsrs_state).toBe(State.Review);
    expect(after.fsrs_last_review).toBe(T0.toISOString());
    expect(after.fsrs_reps).toBe(1);
    expect(after.entwurfsstatus).toBe('active');
  });

  it('keeps log and card consistent across a multi-review sequence (due advances monotonically)', async () => {
    const deck = await seedDeck();
    const card = await seedActiveCard(deck);

    const times = [T0, T1, T2];
    for (let i = 0; i < times.length; i++) {
      // Card state BEFORE this review
      const before = sqlite
        .prepare('SELECT fsrs_due, fsrs_state, fsrs_reps FROM cards WHERE id = ?')
        .get(card) as { fsrs_due: string; fsrs_state: number; fsrs_reps: number };

      const row = await logReview(conn, card, Rating.Good, 1, times[i]);

      // Log row snapshots the state BEFORE the review (D4)
      expect(row.fsrs_due).toBe(before.fsrs_due);
      expect(row.fsrs_state).toBe(before.fsrs_state);

      // Card advanced: due strictly later, reps incremented
      const after = sqlite
        .prepare('SELECT fsrs_due, fsrs_state, fsrs_reps FROM cards WHERE id = ?')
        .get(card) as { fsrs_due: string; fsrs_state: number; fsrs_reps: number };
      expect(Date.parse(after.fsrs_due)).toBeGreaterThan(Date.parse(before.fsrs_due));
      expect(after.fsrs_reps).toBe(before.fsrs_reps + 1);
      expect(after.fsrs_state).toBe(State.Review); // Good from New/Review stays Review
    }

    // The log replays the chain: each row's snapshot is the previous review's outcome
    const history = sqlite
      .prepare('SELECT fsrs_due, fsrs_state FROM review_log WHERE karte_id = ? ORDER BY reviewed_at')
      .all(card) as Pick<ReviewLogRow, 'fsrs_due' | 'fsrs_state'>[];
    expect(history).toHaveLength(3);
    expect(history[0].fsrs_state).toBe(State.New);
    for (let i = 1; i < history.length; i++) {
      expect(history[i].fsrs_state).toBe(State.Review);
      expect(Date.parse(history[i].fsrs_due)).toBeGreaterThan(
        Date.parse(history[i - 1].fsrs_due),
      );
    }
  });

  it('an Again on a Review-state card increments lapses and moves the card to Relearning', async () => {
    const deck = await seedDeck();
    const card = await seedActiveCard(deck);

    await logReview(conn, card, Rating.Good, 1, T0); // -> Review
    const row = await logReview(conn, card, Rating.Again, 0, T1); // lapse

    const after = sqlite.prepare('SELECT * FROM cards WHERE id = ?').get(card) as {
      fsrs_state: number;
      fsrs_lapses: number;
      fsrs_reps: number;
    };
    expect(after.fsrs_state).toBe(State.Relearning);
    expect(after.fsrs_lapses).toBe(1);
    expect(after.fsrs_reps).toBe(2);
    expect(row.ergebnis).toBe(0);
    // the log snapshot still shows the pre-review Review state
    expect(row.fsrs_state).toBe(State.Review);
  });

  it('rolls back completely when the card update fails (log INSERT is not left behind)', async () => {
    const deck = await seedDeck();
    const card = await seedActiveCard(deck);

    // Sabotage: make the cards UPDATE fail (fsrs_reps NOT NULL violated by a
    // trigger-free constraint is hard to hit, so drop the column's data via a
    // CHECK violation instead: set fsrs_state to an impossible value through a
    // BEFORE UPDATE trigger).
    sqlite.exec(
      `CREATE TRIGGER block_update BEFORE UPDATE ON cards
       BEGIN SELECT RAISE(ABORT, 'sabotaged'); END`,
    );

    await expect(logReview(conn, card, Rating.Good, 1, T0)).rejects.toThrow(/sabotaged/);

    // Nothing persisted: no log row, card state untouched
    const logs = sqlite.prepare('SELECT COUNT(*) AS n FROM review_log').get() as { n: number };
    expect(logs.n).toBe(0);
    const dbCard = sqlite.prepare('SELECT fsrs_reps, fsrs_due FROM cards WHERE id = ?').get(card) as {
      fsrs_reps: number;
      fsrs_due: string | null;
    };
    expect(dbCard.fsrs_reps).toBe(0);
    expect(dbCard.fsrs_due).toBe(T0.toISOString()); // activation due, unchanged
  });

  it('rejects reviews of non-existent, non-active and uninitialized cards', async () => {
    const deck = await seedDeck();
    const draft = await seedCard(deck, 'draft'); // no FSRS state, not active
    const reviewed = await seedCard(deck, 'reviewed');

    await expect(logReview(conn, 'missing-card', Rating.Good, 1, T0)).rejects.toThrow(/does not exist/);
    await expect(logReview(conn, draft, Rating.Good, 1, T0)).rejects.toThrow(/not active/);
    await expect(logReview(conn, reviewed, Rating.Good, 1, T0)).rejects.toThrow(/not active/);

    // Nothing was logged
    const logs = sqlite.prepare('SELECT COUNT(*) AS n FROM review_log').get() as { n: number };
    expect(logs.n).toBe(0);
  });

  it('rejects invalid ratings (scheduler validation) without writing anything', async () => {
    const deck = await seedDeck();
    const card = await seedActiveCard(deck);

    // ts-fsrs validates the grade before any DB write ("Expected grade");
    // the review_log CHECK (rating BETWEEN 1 AND 4) is the DB-level backstop.
    await expect(
      logReview(conn, card, 5 as 1 | 2 | 3 | 4, 1, T0),
    ).rejects.toThrow(/Expected grade/);
    const logs = sqlite.prepare('SELECT COUNT(*) AS n FROM review_log').get() as { n: number };
    expect(logs.n).toBe(0);
  });
});

describe('getDueCards', () => {
  it('returns only active cards whose due has passed, ordered by due ascending', async () => {
    const deck = await seedDeck();
    const a = await seedActiveCard(deck); // due = T0, never reviewed
    const b = await seedActiveCard(deck); // reviewed Good at T1 -> due ~T1+4.8d (future at T2)
    const c = await seedActiveCard(deck); // reviewed Again at T1 -> due = T1+1min

    await logReview(conn, b, Rating.Good, 1, T1); // due moves days out — not due at T2
    await logReview(conn, c, Rating.Again, 0, T1); // due = T1 + 1min (learning step)

    // At T2: only a (due T0) and c (due T1+1min) are due; b is future-due.
    // Order: a (T0) < c (T1+1min).
    const due = await getDueCards(conn, T2);
    expect(due.map((d) => d.id)).toEqual([a, c]);

    // Limit truncates to the most overdue
    const limited = await getDueCards(conn, T2, 1);
    expect(limited.map((d) => d.id)).toEqual([a]);

    // Past b's due date it joins the queue, still sorted correctly
    const later = await getDueCards(conn, new Date('2026-01-10T00:00:00.000Z'));
    expect(later.map((d) => d.id)).toEqual([a, c, b]);
  });

  it('excludes future-due, draft, reviewed and NULL-due cards', async () => {
    const deck = await seedDeck();
    const future = await seedActiveCard(deck);
    await logReview(conn, future, Rating.Easy, 1, T0); // due ~7 weeks out

    const draft = await seedCard(deck, 'draft');
    const reviewed = await seedCard(deck, 'reviewed');

    const due = await getDueCards(conn, T1);
    expect(due.map((d) => d.id)).not.toContain(future);
    expect(due.map((d) => d.id)).not.toContain(draft);
    expect(due.map((d) => d.id)).not.toContain(reviewed);
    expect(due).toHaveLength(0);
  });

  it('returns empty for a fresh database and supports limit=0 (no limit)', async () => {
    expect(await getDueCards(conn, T0)).toEqual([]);

    const deck = await seedDeck();
    for (let i = 0; i < 3; i++) {
      const card = await seedActiveCard(deck);
      await logReview(conn, card, Rating.Good, 1, T0);
    }
    const all = await getDueCards(conn, new Date('2027-01-01T00:00:00.000Z'), 0);
    expect(all).toHaveLength(3);
  });
});

describe('getReviewStats', () => {
  it('aggregates count and korrekt-Anteil over ergebnis (not rating)', async () => {
    const deck = await seedDeck();
    const card = await seedActiveCard(deck);

    // 3 reviews: 2 correct, 1 wrong → korrekt-Anteil 2/3
    await logReview(conn, card, Rating.Good, 1, T0);
    await logReview(conn, card, Rating.Again, 0, T1);
    await logReview(conn, card, Rating.Good, 1, T2);

    const stats = await getReviewStats(conn);
    expect(stats.total).toBe(3);
    expect(stats.korrekt_anteil).toBeCloseTo(2 / 3, 10);

    const deckStats = await getReviewStats(conn, deck);
    expect(deckStats.total).toBe(3);
    expect(deckStats.korrekt_anteil).toBeCloseTo(2 / 3, 10);
  });

  it('filters by deck and returns null korrekt-Anteil for empty logs', async () => {
    const deckA = await seedDeck();
    const deckB = await seedDeck();

    const cardA = await seedActiveCard(deckA);
    await logReview(conn, cardA, Rating.Good, 1, T0);
    await logReview(conn, cardA, Rating.Hard, 1, T1);

    const cardB = await seedActiveCard(deckB);
    await logReview(conn, cardB, Rating.Again, 0, T0);

    const statsA = await getReviewStats(conn, deckA);
    expect(statsA.total).toBe(2);
    expect(statsA.korrekt_anteil).toBe(1);

    const statsB = await getReviewStats(conn, deckB);
    expect(statsB.total).toBe(1);
    expect(statsB.korrekt_anteil).toBe(0);

    // Deck without reviews → 0 reviews, null anteil
    const deckC = await seedDeck();
    const empty = await getReviewStats(conn, deckC);
    expect(empty.total).toBe(0);
    expect(empty.korrekt_anteil).toBeNull();

    // Whole-log stats
    const all = await getReviewStats(conn);
    expect(all.total).toBe(3);
    expect(all.korrekt_anteil).toBeCloseTo(2 / 3, 10);
  });
});

describe('initializeFsrsState (activation helper)', () => {
  it('initializes a New-card state on a draft (createEmptyCard equivalent)', async () => {
    const deck = await seedDeck();
    const card = await seedCard(deck, 'draft');

    await initializeFsrsState(conn, card, T0);

    const row = sqlite.prepare('SELECT * FROM cards WHERE id = ?').get(card) as {
      fsrs_due: string;
      fsrs_stability: number;
      fsrs_state: number;
      fsrs_last_review: string | null;
      fsrs_reps: number;
      fsrs_card_id: string;
      entwurfsstatus: string;
    };
    expect(row.fsrs_due).toBe(T0.toISOString());
    expect(row.fsrs_stability).toBe(0);
    expect(row.fsrs_state).toBe(State.New);
    expect(row.fsrs_last_review).toBeNull();
    expect(row.fsrs_reps).toBe(0);
    expect(row.fsrs_card_id).toBeTruthy();
    expect(row.entwurfsstatus).toBe('draft'); // status untouched — that's reviewCard's job
  });

  it('is a no-op on already-active cards (running state kept)', async () => {
    const deck = await seedDeck();
    const card = await seedActiveCard(deck);
    await logReview(conn, card, Rating.Good, 1, T0);
    const before = sqlite.prepare('SELECT fsrs_due, fsrs_reps FROM cards WHERE id = ?').get(card) as {
      fsrs_due: string;
      fsrs_reps: number;
    };

    await initializeFsrsState(conn, card, T1);

    const after = sqlite.prepare('SELECT fsrs_due, fsrs_reps FROM cards WHERE id = ?').get(card) as {
      fsrs_due: string;
      fsrs_reps: number;
    };
    expect(after.fsrs_due).toBe(before.fsrs_due);
    expect(after.fsrs_reps).toBe(before.fsrs_reps);
  });

  it('silently ignores non-existent cards (delete race is a no-op)', async () => {
    await expect(initializeFsrsState(conn, 'missing', T0)).resolves.toBeUndefined();
  });
});
