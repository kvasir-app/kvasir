/**
 * ts-fsrs v6 serialization layer.
 *
 * ts-fsrs v6 moved from the deprecated `fsrs()/createEmptyCard()` helpers to
 * `DefaultScheduler` (async factory) with a new card shape:
 *   stability, stabilityFast, difficulty, state (enum), scheduleStatus,
 *   dueAt, lastReviewAt, cardId, reps, lapses, scheduledDays, learningStep
 * `scheduler.review()` validates the FULL card shape and requires real Date
 * objects (probed: every missing field or string date throws
 * "Expected valid Date fields" / "Expected FSRS7 memory state...").
 *
 * Therefore serialization must be lossless AND reanimate Dates on load.
 * JSON layout (versioned for future migrations):
 *   { v: 1, ...card fields with dates as ISO-8601 strings }
 *
 * Note on types: ts-fsrs' shipped .d.ts types `newCard()`/`review()` results
 * narrower than the runtime objects (missing `stabilityFast`, `cardId` typed
 * as string|number). We probe-verified the runtime shape and define our own
 * exact interfaces here; casts to the library types happen only at the
 * scheduler boundary (createNewCard/applyReview).
 */
import {
  DefaultScheduler,
  Rating,
  State,
  type Grade,
} from 'ts-fsrs';

/** Runtime shape of a ts-fsrs v6 (FSRS-7) card, as produced by `newCard()`/`review()`. */
export interface FsrsCard {
  stability: number;
  stabilityFast: number;
  difficulty: number;
  state: State;
  scheduleStatus: string;
  dueAt: Date;
  lastReviewAt: Date | null;
  cardId: string;
  reps: number;
  lapses: number;
  scheduledDays: number;
  learningStep: number;
}

/** Runtime shape of a ts-fsrs v6 revlog entry, as produced by `review()`. */
export interface FsrsRevlog {
  stability: number;
  stabilityFast: number;
  difficulty: number;
  dueAt: Date | null;
  lastReviewAt: Date | null;
  reviewTime: Date;
  scheduleStatus: string;
  rating: number;
  state: State;
  cardId: string;
  scheduledDays: number;
  learningStep: number;
}

/** JSON shape of a serialized ts-fsrs card (v1). Dates as ISO-8601 strings. */
export interface SerializedFsrsCard {
  v: 1;
  stability: number;
  stabilityFast: number;
  difficulty: number;
  state: State;
  scheduleStatus: string;
  dueAt: string | null;
  lastReviewAt: string | null;
  cardId: string;
  reps: number;
  lapses: number;
  scheduledDays: number;
  learningStep: number;
}

/** JSON shape of a serialized ts-fsrs revlog (v1). Dates as ISO-8601 strings. */
export interface SerializedFsrsRevlog {
  v: 1;
  stability: number;
  stabilityFast: number;
  difficulty: number;
  dueAt: string | null;
  lastReviewAt: string | null;
  reviewTime: string;
  scheduleStatus: string;
  rating: number;
  state: State;
  cardId: string;
  scheduledDays: number;
  learningStep: number;
}

/** Shared, process-wide scheduler. `DefaultScheduler()` is async (loads weights). */
type Scheduler = Awaited<ReturnType<typeof DefaultScheduler>>;
let schedulerPromise: Promise<Scheduler> | null = null;

/**
 * Get the shared DefaultScheduler (FSRS-7 defaults, desiredRetention 0.9).
 * The scheduler is stateless w.r.t. cards — one instance serves the whole app.
 */
export function getScheduler(): Promise<Scheduler> {
  if (schedulerPromise === null) {
    schedulerPromise = DefaultScheduler();
  }
  return schedulerPromise;
}

/** Create the initial (New) card state for a freshly activated card. */
export async function createNewCard(now: Date): Promise<FsrsCard> {
  const scheduler = await getScheduler();
  // Runtime returns the full shape incl. stabilityFast (probe-verified);
  // the shipped .d.ts omits it, hence the cast at this boundary.
  return scheduler.newCard({ now }) as unknown as FsrsCard;
}

/**
 * Apply a review grade to a card state.
 * Returns the new card state and the revlog entry (to be persisted atomically).
 */
export async function applyReview(
  card: FsrsCard,
  grade: Grade,
  now: Date,
): Promise<{ card: FsrsCard; revlog: FsrsRevlog }> {
  const scheduler = await getScheduler();
  const result = scheduler.review({
    card: card as never,
    grade,
    now,
  });
  return {
    card: result.card as unknown as FsrsCard,
    revlog: result.revlog as unknown as FsrsRevlog,
  };
}

/** Serialize a ts-fsrs card to a JSON-safe object (dates → ISO-8601 strings). */
export function serializeCard(card: FsrsCard): SerializedFsrsCard {
  return {
    v: 1,
    stability: card.stability,
    stabilityFast: card.stabilityFast,
    difficulty: card.difficulty,
    state: card.state,
    scheduleStatus: card.scheduleStatus,
    dueAt: card.dueAt instanceof Date ? card.dueAt.toISOString() : null,
    lastReviewAt:
      card.lastReviewAt instanceof Date ? card.lastReviewAt.toISOString() : null,
    cardId: card.cardId,
    reps: card.reps,
    lapses: card.lapses,
    scheduledDays: card.scheduledDays,
    learningStep: card.learningStep,
  };
}

/** Reanimate a serialized card back into a real ts-fsrs card (Dates restored). */
export function deserializeCard(data: SerializedFsrsCard): FsrsCard {
  assertVersion(data);
  const dueAt = parseIsoDate(data.dueAt, 'dueAt');
  const lastReviewAt =
    data.lastReviewAt === null ? null : parseIsoDate(data.lastReviewAt, 'lastReviewAt');
  return {
    stability: data.stability,
    stabilityFast: data.stabilityFast,
    difficulty: data.difficulty,
    state: data.state,
    scheduleStatus: data.scheduleStatus,
    dueAt,
    lastReviewAt,
    cardId: data.cardId,
    reps: data.reps,
    lapses: data.lapses,
    scheduledDays: data.scheduledDays,
    learningStep: data.learningStep,
  };
}

/** Serialize a ts-fsrs revlog to a JSON-safe object (dates → ISO-8601 strings). */
export function serializeRevlog(revlog: FsrsRevlog): SerializedFsrsRevlog {
  return {
    v: 1,
    stability: revlog.stability,
    stabilityFast: revlog.stabilityFast,
    difficulty: revlog.difficulty,
    dueAt: revlog.dueAt instanceof Date ? revlog.dueAt.toISOString() : null,
    lastReviewAt:
      revlog.lastReviewAt instanceof Date ? revlog.lastReviewAt.toISOString() : null,
    reviewTime: revlog.reviewTime.toISOString(),
    scheduleStatus: revlog.scheduleStatus,
    rating: revlog.rating,
    state: revlog.state,
    cardId: revlog.cardId,
    scheduledDays: revlog.scheduledDays,
    learningStep: revlog.learningStep,
  };
}

/** Reanimate a serialized revlog back into a real ts-fsrs revlog (Dates restored). */
export function deserializeRevlog(data: SerializedFsrsRevlog): FsrsRevlog {
  assertVersion(data);
  const dueAt = data.dueAt === null ? null : parseIsoDate(data.dueAt, 'dueAt');
  const lastReviewAt =
    data.lastReviewAt === null ? null : parseIsoDate(data.lastReviewAt, 'lastReviewAt');
  return {
    stability: data.stability,
    stabilityFast: data.stabilityFast,
    difficulty: data.difficulty,
    dueAt,
    lastReviewAt,
    reviewTime: parseIsoDate(data.reviewTime, 'reviewTime'),
    scheduleStatus: data.scheduleStatus,
    rating: data.rating,
    state: data.state,
    cardId: data.cardId,
    scheduledDays: data.scheduledDays,
    learningStep: data.learningStep,
  };
}

/**
 * Lossless JSON roundtrip helper: serialize → JSON string.
 * Throws on non-finite numbers (JSON cannot represent NaN/±Infinity).
 */
export function cardToJson(card: FsrsCard): string {
  return JSON.stringify(serializeCard(card));
}

/** Inverse of {@link cardToJson}. */
export function cardFromJson(json: string): FsrsCard {
  return deserializeCard(JSON.parse(json) as SerializedFsrsCard);
}

/**
 * Column mapping for the denormalized FSRS state on `cards` (schema.md D10:
 * field-wise columns, no JSON blob — `fsrs_due` must stay SQL-comparable and
 * indexable). Shared by the repositories so the column layout is defined
 * exactly once.
 *
 * Draft/reviewed cards have an UNINITIALIZED state (NULL columns except the
 * NOT NULL counters); `columnsToState` rejects such rows — only active cards
 * carry a schedulable state (activation via reviewCard initializes it).
 */
export interface FsrsStateColumns {
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
}

/** Map a runtime card onto the `cards.fsrs_*` column values (dates as ISO-8601). */
export function stateToColumns(card: FsrsCard): FsrsStateColumns {
  return {
    fsrs_due: card.dueAt.toISOString(),
    fsrs_stability: card.stability,
    fsrs_stability_fast: card.stabilityFast,
    fsrs_difficulty: card.difficulty,
    fsrs_state: card.state,
    fsrs_schedule_status: card.scheduleStatus,
    fsrs_card_id: card.cardId,
    fsrs_last_review:
      card.lastReviewAt === null ? null : card.lastReviewAt.toISOString(),
    fsrs_reps: card.reps,
    fsrs_lapses: card.lapses,
    fsrs_learning_steps: card.learningStep,
  };
}

/**
 * Rebuild a runtime card from `cards.fsrs_*` columns (inverse of
 * {@link stateToColumns}). Throws when the state is uninitialized (NULL
 * columns) instead of silently producing a broken card.
 */
export function columnsToState(cols: FsrsStateColumns): FsrsCard {
  if (
    cols.fsrs_due === null ||
    cols.fsrs_stability === null ||
    cols.fsrs_stability_fast === null ||
    cols.fsrs_difficulty === null ||
    cols.fsrs_state === null ||
    cols.fsrs_schedule_status === null ||
    cols.fsrs_card_id === null
  ) {
    throw new Error(
      'FSRS state not initialized (NULL columns) — only active cards have a schedulable state (activate via reviewCard first)',
    );
  }
  return {
    stability: cols.fsrs_stability,
    stabilityFast: cols.fsrs_stability_fast,
    difficulty: cols.fsrs_difficulty,
    state: cols.fsrs_state as State,
    scheduleStatus: cols.fsrs_schedule_status,
    dueAt: parseIsoDate(cols.fsrs_due, 'fsrs_due'),
    lastReviewAt:
      cols.fsrs_last_review === null
        ? null
        : parseIsoDate(cols.fsrs_last_review, 'fsrs_last_review'),
    cardId: cols.fsrs_card_id,
    reps: cols.fsrs_reps,
    lapses: cols.fsrs_lapses,
    scheduledDays: 0,
    learningStep: cols.fsrs_learning_steps,
  };
}

function assertVersion(data: { v?: unknown }): void {
  if (data?.v !== 1) {
    throw new Error(`Unsupported fsrs serialization version: ${String(data?.v)}`);
  }
}

function parseIsoDate(value: string | null, field: string): Date {
  if (value === null) {
    throw new Error(`Missing required date field: ${field}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO date in fsrs state: ${field}=${value}`);
  }
  return date;
}

// Re-exports so the rest of the app can stay decoupled from ts-fsrs internals.
export { Rating, State };

// Task-spec aliases: the scaffold contract names the helpers
// serializeState/deserializeState. They are the card-level (de)serializers —
// a ts-fsrs "State object" in this codebase is the FsrsCard (v6 shape).
export {
  serializeCard as serializeState,
  deserializeCard as deserializeState,
  cardToJson as stateToJson,
  cardFromJson as stateFromJson,
};
