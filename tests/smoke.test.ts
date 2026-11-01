/**
 * End-to-end smoke test — the full M1 data-layer feedback loop
 * (docs/schema.md §5: Generator → Karten → Auswahl → Session → Feedback →
 * Metriken → zurück in Auswahl UND Generator) against a FRESH in-memory
 * SQLite database, running the EXACT production repos.
 *
 * Flow under test:
 *   1. Deck anlegen
 *   2. Karten als Entwürfe anlegen (selbstbewertung + mc, manuell + ki)
 *   3. reviewCard → Status aktiv, FSRS-Zustand initialisiert
 *   4. Mehrere logReviews über verschiedene Ratings (Good/Again/Hard/Easy)
 *   5. getDueCards liefert die korrekte Reihenfolge (due aufsteigend)
 *   6. getReviewStats stimmt mit den Logs überein (COUNT + AVG(ergebnis))
 *   7. Qualitätsregelkreis: active→reviewed ("zur Überarbeitung gezogen") —
 *      Karte verschwindet aus getDueCards, FSRS-Zustand bleibt erhalten
 *   8. Deck-Löschung kaskadiert wie dokumentiert (D5: cards + review_log)
 *
 * Timing: `reviewCard` aktiviert mit der echten Systemzeit; alle Testzeiten
 * sind relativ zu einem Startzeitpunkt t0 (T(min) = t0 + min Minuten), die
 * FSRS-Intervalle der Review-Sequenz sind mit dem echten Scheduler (FSRS-7,
 * DefaultScheduler) probe-verifiziert: Good-from-New ≈ +4,78 d, Easy ≈ +53,9 d,
 * Again-from-Review ≈ +12 min (Learning-Step), Again nach Easy ≈ +24 min,
 * Relearning-Hard ≈ +22 min, Good aus Relearning ≈ +1,01 d.
 *
 * Run: npm test (vitest) — see docs/seed-and-tests.md.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeck, deleteDeck, getDeck, listDecks } from '../src/db/decksRepo';
import {
  createCard,
  getCard,
  markCardReviewed,
  reviewCard,
} from '../src/db/cardsRepo';
import {
  getDueCards,
  getReviewStats,
  logReview,
} from '../src/db/reviewLogRepo';
import { Rating, State } from '../src/db/fsrs';
import { makeTestDb, type DbConnection } from './helpers/db';

let sqlite: DatabaseSync;
let db: DbConnection;

/** Test start (real clock — reviewCard uses Date.now() for activation). */
let t0 = 0;
/** T(min) = t0 + min Minuten. */
const T = (minutes: number) => new Date(t0 + minutes * 60_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  ({ sqlite, db } = await makeTestDb());
  t0 = Date.now();
});

afterEach(() => {
  sqlite.close();
});

describe('M1-Regelkreis: Deck → Entwürfe → Aktivierung → Reviews → Auswahl → Metriken → Qualitätsregelkreis → Löschung', () => {
  it('durchläuft den vollen Datenfluss wie in docs/schema.md §5 beschrieben', async () => {
    //
    // 1) Deck anlegen
    //
    const deck = await createDeck(db, {
      titel: 'Smoke: Biologie',
      beschreibung: 'End-to-end-Beispieldeck',
    });
    expect(deck.id).toBeTruthy();
    expect((await listDecks(db)).map((d) => d.id)).toContain(deck.id);

    //
    // 2) Karten als Entwürfe anlegen (Mix: Typ, quelle; createCard liefert
    //    IMMER entwurfsstatus='draft' mit uninitialisiertem FSRS-Zustand)
    //
    const draftSelf = await createCard(db, {
      deck_id: deck.id,
      frage: 'Welche Organelle produziert ATP?',
      antwort: 'Das Mitochondrium.',
      typ: 'selbstbewertung',
      quelle: 'manuell',
    });
    const draftMc = await createCard(db, {
      deck_id: deck.id,
      frage: 'Welche Strukturen hat eine Pflanzenzelle?',
      antwort: 'Zellwand, Chloroplasten, Vakuole.',
      typ: 'mc',
      mcOptionen: ['Zellwand', 'Chloroplasten', 'Zentriolen', 'Vakuole'],
      mcRichtigeIndizes: [0, 1, 3],
      quelle: 'ki',
    });
    const draftLater = await createCard(db, {
      deck_id: deck.id,
      frage: 'Was beschreibt Osmose?',
      antwort: 'Wasserdiffusion durch eine semipermeable Membran.',
      typ: 'selbstbewertung',
      quelle: 'ki',
    });

    for (const card of [draftSelf, draftMc, draftLater]) {
      expect(card.entwurfsstatus).toBe('draft');
      expect(card.fsrs_due).toBeNull();
      expect(card.fsrs_state).toBeNull();
    }
    // Drafts nehmen nicht am Lernbetrieb teil
    expect(await getDueCards(db, T(60), 0)).toEqual([]);

    //
    // 3) reviewCard → aktiv (draft→active), FSRS-Zustand initialisiert
    //
    const activeSelf = await reviewCard(db, draftSelf.id);
    await sleep(20); // unterschiedliche Aktivierungszeiten → deterministische due-Order
    const activeMc = await reviewCard(db, draftMc.id);
    expect(activeSelf.entwurfsstatus).toBe('active');
    expect(activeSelf.fsrs_due).not.toBeNull();
    expect(activeSelf.fsrs_state).toBe(State.New);
    expect(activeSelf.fsrs_stability).toBe(0);
    expect(activeMc.entwurfsstatus).toBe('active');

    // Beide sofort fällig (due = Aktivierungszeitpunkt), Reihenfolge nach due
    const firstDue = await getDueCards(db, T(1), 0);
    expect(firstDue.map((c) => c.id)).toEqual([activeSelf.id, activeMc.id]);

    //
    // 4) Mehrere logReviews über verschiedene Ratings (atomar: Log + Karte)
    //
    // Karte A (Selbstbewertung): New →Good→ Review →Again→ Relearning
    // →Hard→ Relearning →Good→ Review. Karte B (MC): New →Easy→ Review →Again.
    await logReview(db, activeSelf.id, Rating.Good, 1, T(2)); // due ≈ +4,78 d
    await logReview(db, activeMc.id, Rating.Easy, 1, T(2)); // due ≈ +53,9 d
    expect(await getDueCards(db, T(3), 0)).toEqual([]); // beide in der Zukunft

    const afterAgain = await logReview(db, activeSelf.id, Rating.Again, 0, T(10));
    expect(afterAgain.ergebnis).toBe(0); // Again = falsch
    await logReview(db, activeSelf.id, Rating.Hard, 1, T(11)); // due ≈ t0+33,1 min
    await logReview(db, activeMc.id, Rating.Again, 0, T(12)); // due ≈ t0+36,1 min

    // Log-Historie je Karte: Snapshot VOR dem Review (D4), append-only
    const selfHistory = sqlite
      .prepare(
        'SELECT rating, ergebnis, fsrs_state FROM review_log WHERE karte_id = ? ORDER BY reviewed_at',
      )
      .all(activeSelf.id) as Array<{ rating: number; ergebnis: number; fsrs_state: number }>;
    expect(selfHistory.map((r) => r.rating)).toEqual([3, 1, 2]); // Good, Again, Hard
    expect(selfHistory.map((r) => r.ergebnis)).toEqual([1, 0, 1]);
    expect(selfHistory[0].fsrs_state).toBe(State.New); // vor dem 1. Review
    expect(selfHistory[1].fsrs_state).toBe(State.Review); // vor dem 2. Review
    expect(selfHistory[2].fsrs_state).toBe(State.Relearning); // nach dem Again

    //
    // 5) getDueCards: korrekte Reihenfolge (due aufsteigend, älteste zuerst)
    //
    // Reale FSRS-Intervalle dieser Sequenz (echter Scheduler): A-Hard ≈
    // t0+33,1 min, B-Again ≈ t0+23,6 min (B hatte nur 10 min auf Easy).
    expect((await getDueCards(db, T(20), 0))).toEqual([]); // beide future-due
    expect((await getDueCards(db, T(25), 0)).map((c) => c.id)).toEqual([activeMc.id]);
    const bothDue = await getDueCards(db, T(34), 0);
    expect(bothDue.map((c) => c.id)).toEqual([activeMc.id, activeSelf.id]);
    expect(bothDue[0].fsrs_due < bothDue[1].fsrs_due).toBe(true);

    //
    // 6) getReviewStats: stimmt mit den Logs überein (COUNT + AVG über ergebnis)
    //
    // 5 Reviews bisher: A(Good✓, Again✗, Hard✓) + B(Easy✓, Again✗) → 3/5
    const statsMid = await getReviewStats(db);
    expect(statsMid.total).toBe(5);
    expect(statsMid.korrekt_anteil).toBeCloseTo(3 / 5, 10);
    const deckStatsMid = await getReviewStats(db, deck.id);
    expect(deckStatsMid).toEqual(statsMid); // alle Reviews gehören zu diesem Deck

    // A wird an ihrer fälligen Zeit erneut gut bewertet → 6 Reviews, 4/6
    await logReview(db, activeSelf.id, Rating.Good, 1, T(35));
    const stats = await getReviewStats(db);
    expect(stats.total).toBe(6);
    expect(stats.korrekt_anteil).toBeCloseTo(4 / 6, 10);
    const deckStats = await getReviewStats(db, deck.id);
    expect(deckStats).toEqual(stats); // alle Reviews gehören zu diesem Deck

    // Ein Deck ohne Reviews → 0/null (nicht 0/0)
    const emptyDeck = await createDeck(db, { titel: 'Smoke: leer' });
    const emptyStats = await getReviewStats(db, emptyDeck.id);
    expect(emptyStats.total).toBe(0);
    expect(emptyStats.korrekt_anteil).toBeNull();

    //
    // 7) Qualitätsregelkreis: active→reviewed ("zur Überarbeitung gezogen")
    //
    // Karte A hat eine Again-Lapse → Generator-Zurückziehung (§5 Pfeil 8)
    const beforePull = await getCard(db, activeSelf.id);
    const pulled = await markCardReviewed(db, activeSelf.id);
    expect(pulled.entwurfsstatus).toBe('reviewed');
    // FSRS-Zustand bleibt vollständig erhalten
    expect(pulled.fsrs_due).toBe(beforePull?.fsrs_due);
    expect(pulled.fsrs_stability).toBe(beforePull?.fsrs_stability);
    expect(pulled.fsrs_difficulty).toBe(beforePull?.fsrs_difficulty);
    expect(pulled.fsrs_state).toBe(beforePull?.fsrs_state);
    expect(pulled.fsrs_reps).toBe(4);
    expect(pulled.fsrs_lapses).toBe(1);

    // Karte A ist aus dem Lernbetrieb raus; Karte B (Relearning, due t0+36,1) bleibt
    expect((await getDueCards(db, T(45), 0)).map((c) => c.id)).toEqual([activeMc.id]);

    // logReview auf der gezogenen Karte wird abgewiesen (nicht aktiv)
    await expect(
      logReview(db, activeSelf.id, Rating.Good, 1, T(46)),
    ).rejects.toThrow(/not active/);

    // Re-Aktivierung (reviewed→active) initialisiert den FSRS-Zustand NEU
    // (schema.md §4: „reviewed → active = Initialisierung") — die Karte startet
    // wieder als New-Karte mit due=jetzt, vorn im due-Fenster.
    const reactivated = await reviewCard(db, activeSelf.id);
    expect(reactivated.entwurfsstatus).toBe('active');
    expect(reactivated.fsrs_state).toBe(State.New);
    expect(reactivated.fsrs_reps).toBe(0);
    expect(reactivated.fsrs_lapses).toBe(0);
    // due = Aktivierungszeitpunkt (≈ t0) → sofort wieder fällig, vor B
    // (B: due t0+36,1 min, wurde nicht weiter reviewt).
    expect(reactivated.fsrs_due !== null && new Date(reactivated.fsrs_due) <= T(1)).toBe(true);
    expect((await getDueCards(db, T(45), 0)).map((c) => c.id)).toEqual([
      activeSelf.id,
      activeMc.id,
    ]);

    // Langfristig bleibt A vorne — ihr neuer due (≈ t0) liegt weit vor Bs.
    const farDue = await getDueCards(db, T(3 * 24 * 60), 0);
    expect(farDue.map((c) => c.id)).toEqual([activeSelf.id, activeMc.id]);

    //
    // 8) Deck-Löschung verhält sich wie dokumentiert (D5: CASCADE)
    //
    const logsBefore = (sqlite.prepare('SELECT COUNT(*) n FROM review_log').get() as { n: number }).n;
    expect(logsBefore).toBe(6); // alle 6 Reviews gehören zu Deck 1

    const { deletedCards } = await deleteDeck(db, deck.id);
    expect(deletedCards).toBe(3); // alle drei Karten des Decks (inkl. Entwurf)

    expect(await getDeck(db, deck.id)).toBeNull();
    expect((await listDecks(db)).map((d) => d.id)).toEqual([emptyDeck.id]);
    // Kaskade: Karten und deren Review-Logs sind mit weg
    const remaining = {
      cards: (sqlite.prepare('SELECT COUNT(*) n FROM cards').get() as { n: number }).n,
      logs: (sqlite.prepare('SELECT COUNT(*) n FROM review_log').get() as { n: number }).n,
    };
    expect(remaining.cards).toBe(0);
    expect(remaining.logs).toBe(0);

    // Stats nach der Löschung: leerer Log → 0/null statt Fehler
    const statsAfterDelete = await getReviewStats(db);
    expect(statsAfterDelete.total).toBe(0);
    expect(statsAfterDelete.korrekt_anteil).toBeNull();
    expect(await getDueCards(db, T(3 * 24 * 60), 0)).toEqual([]);
  });
});
