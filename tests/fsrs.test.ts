import { describe, expect, it } from 'vitest';
import {
  applyReview,
  cardFromJson,
  cardToJson,
  createNewCard,
  deserializeCard,
  deserializeRevlog,
  Rating,
  serializeCard,
  serializeRevlog,
  State,
} from '../src/db/fsrs';

/** Deep-compare two Date values (millisecond precision). */
function expectSameDate(a: unknown, b: unknown): void {
  if (a === null && b === null) return;
  expect(a instanceof Date).toBe(true);
  expect(b instanceof Date).toBe(true);
  expect((a as Date).getTime()).toBe((b as Date).getTime());
}

describe('ts-fsrs serialization (src/db/fsrs.ts)', () => {
  it('roundtrips a fresh New card losslessly through JSON', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const card = await createNewCard(now);

    const json = cardToJson(card);
    const restored = cardFromJson(json);

    expect(restored).toEqual(card); // deep equality incl. Date instances
    expect(restored.dueAt instanceof Date).toBe(true);
    expect(restored.state).toBe(State.New);
    expect(restored.scheduleStatus).toBe('new');
    // JSON layout is versioned and stable
    expect(JSON.parse(json)).toMatchObject({ v: 1, state: 0, scheduleStatus: 'new' });
  });

  it('roundtrips reviewed card states losslessly (all grades)', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    let card = await createNewCard(now);

    for (const grade of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
      const result = await applyReview(card, grade, now);
      card = result.card;

      const restored = cardFromJson(cardToJson(card));
      expect(restored).toEqual(card);
      expectSameDate(restored.dueAt, card.dueAt);
      expectSameDate(restored.lastReviewAt, card.lastReviewAt);
    }
    // the sequence advanced the card into a real review state
    expect(card.state).toBe(State.Review);
    expect(card.reps).toBe(4);
  });

  it('roundtrips revlog entries losslessly', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const card = await createNewCard(now);
    const { revlog } = await applyReview(card, Rating.Good, now);

    const restored = deserializeRevlog(JSON.parse(JSON.stringify(serializeRevlog(revlog))));
    expect(restored).toEqual(revlog);
    expect(restored.reviewTime instanceof Date).toBe(true);
  });

  it('survives a full stringify→parse cycle (storage realism)', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const card = await createNewCard(now);
    const { card: reviewed } = await applyReview(card, Rating.Hard, now);

    // simulate storage: JSON string → DB → JSON string → parse → deserialize
    const json = JSON.stringify(JSON.parse(cardToJson(reviewed)));
    const restored = cardFromJson(json);
    expect(restored).toEqual(reviewed);
  });

  it('rejects unknown serialization versions', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const card = await createNewCard(now);
    const data = serializeCard(card);
    const broken = { ...data, v: 99 } as unknown as Parameters<typeof deserializeCard>[0];
    expect(() => deserializeCard(broken)).toThrow(/Unsupported fsrs serialization version/);
  });

  it('rejects invalid dates instead of silently producing NaN', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const card = await createNewCard(now);
    const data = serializeCard(card);
    const broken = { ...data, dueAt: 'not-a-date' } as unknown as Parameters<
      typeof deserializeCard
    >[0];
    expect(() => deserializeCard(broken)).toThrow(/Invalid ISO date/);
  });

  it('restored cards are directly usable for further reviews', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    let card = await createNewCard(t0);
    card = (await applyReview(card, Rating.Good, t0)).card;

    // simulate: persist, app restart, load, review again
    const restored = cardFromJson(cardToJson(card));
    const t1 = new Date('2026-01-02T00:00:00.000Z');
    const next = await applyReview(restored, Rating.Good, t1);

    expect(next.card.reps).toBe(card.reps + 1);
    expect(next.card.dueAt.getTime()).toBeGreaterThan(t1.getTime());
    expect(next.revlog.rating).toBe(Rating.Good);
  });
});
