/**
 * Seed — example data for development and manual testing (Kvasir M1).
 *
 * Creates 2 example decks with 5 cards each, mixing the two card types
 * (selbstbewertung / mc), both origins (quelle: manuell / ki) and the draft
 * workflow (initial `entwurfsstatus` 'draft' or 'active'; 'active' cards get
 * their FSRS state initialized via the same `reviewCard` path the app uses).
 *
 * Idempotent: seedDeck/seedCard carry deterministic, human-readable ids
 * (`seed-…`). The run first wipes any previous seed rows (deck delete is
 * CASCADE — cards and their review_log history go with it; user-created data
 * with other ids is never touched), so re-running always yields exactly the
 * same state. Fresh databases are migrated automatically (same PRAGMA +
 * migration order as the app path in src/db/index.ts).
 *
 * Import `seedDatabase` from app/test code, or run from the CLI:
 *
 *   node --experimental-strip-types --import ./scripts/seed-register.mjs src/db/seed.ts [path/to/kvasir.db]
 *
 * Without a path argument the CLI seeds a temporary in-memory database and
 * prints the result (a dry run that exercises the exact production code).
 */
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { MigrationConnection } from './migrations';
import { runMigrations } from './migrations/runner';
import { createDeck, deleteDeck, type DeckRow } from './decksRepo';
import { createCard, reviewCard, type Card } from './cardsRepo';

/** Deterministic ids so the seed can find (and wipe) its own previous run. */
export const SEED_DECK_IDS = ['seed-deck-biologie', 'seed-deck-geschichte'] as const;

/** One example card definition. */
interface SeedCardSpec {
  frage: string;
  antwort: string;
  typ: 'selbstbewertung' | 'mc';
  mcOptionen?: string[];
  mcRichtigeIndizes?: number[];
  quelle: 'manuell' | 'ki';
  /** 'active' cards are activated (FSRS-initialized) during the seed. */
  aktiv: boolean;
}

/** The two example decks and their cards (2×5, Mix aus Selbstbewertung/MC, manuell/ki, draft/active). */
const SEED_DECKS: {
  id: string;
  titel: string;
  beschreibung: string;
  cards: SeedCardSpec[];
}[] = [
  {
    id: 'seed-deck-biologie',
    titel: 'Biologie: Zellbiologie',
    beschreibung: 'Beispiel-Deck für Entwicklung und manuelle Tests.',
    cards: [
      {
        frage: 'Welche Organelle ist das „Kraftwerk" der Zelle?',
        antwort: 'Das Mitochondrium — dort läuft die Zellatmung (ATP-Synthese) ab.',
        typ: 'selbstbewertung',
        quelle: 'manuell',
        aktiv: true,
      },
      {
        frage: 'Wo findet die Photosynthese statt?',
        antwort: 'In den Chloroplasten (Thylakoide und Stroma).',
        typ: 'selbstbewertung',
        quelle: 'manuell',
        aktiv: true,
      },
      {
        frage: 'Welche der folgenden Strukturen kommen in Pflanzenzellen vor?',
        antwort: 'Zellwand und Chloroplasten kommen vor; Zentriolen fehlen höheren Pflanzen meist.',
        typ: 'mc',
        mcOptionen: ['Zellwand', 'Chloroplasten', 'Zentriolen', 'Vakuole'],
        mcRichtigeIndizes: [0, 1, 3],
        quelle: 'ki',
        aktiv: true,
      },
      {
        frage: 'Was beschreibt der Begriff „Osmose"?',
        antwort: 'Gerichtete Diffusion von Wasser durch eine semipermeable Membran.',
        typ: 'selbstbewertung',
        quelle: 'ki',
        aktiv: false,
      },
      {
        frage: 'Welcher Vorgang findet in den Ribosomen statt?',
        antwort: 'Die Translation — Proteine werden nach mRNA-Vorlage synthetisiert.',
        typ: 'selbstbewertung',
        quelle: 'manuell',
        aktiv: false,
      },
    ],
  },
  {
    id: 'seed-deck-geschichte',
    titel: 'Geschichte: 19. Jahrhundert',
    beschreibung: 'Zweites Beispiel-Deck mit Multiple-Choice-Schwerpunkt.',
    cards: [
      {
        frage: 'In welchem Jahr wurde die Paulskirchenverfassung verabschiedet?',
        antwort: '1849 — von der Frankfurter Nationalversammlung.',
        typ: 'selbstbewertung',
        quelle: 'manuell',
        aktiv: true,
      },
      {
        frage: 'Wer gilt als Begründer des Marxismus?',
        antwort: 'Karl Marx (gemeinsam mit Friedrich Engels).',
        typ: 'selbstbewertung',
        quelle: 'manuell',
        aktiv: false,
      },
      {
        frage: 'Welche Staaten gehörten zum Deutschen Bund (1815–1866)?',
        antwort: 'Österreich und Preußen waren die führenden Großmächte im Bund.',
        typ: 'mc',
        mcOptionen: ['Preußen', 'Bayern', 'Österreich', 'Frankreich'],
        mcRichtigeIndizes: [0, 1, 2],
        quelle: 'manuell',
        aktiv: true,
      },
      {
        frage: 'Wann fand die Wiener Kongress-Ära ihren Abschluss?',
        antwort: 'Mit dem Wiener Kongress 1814/15 wurde die Ordnung nach Napoleon festgelegt.',
        typ: 'selbstbewertung',
        quelle: 'ki',
        aktiv: false,
      },
      {
        frage: 'Welche Erfindungen prägten die Industrialisierung in Deutschland?',
        antwort: 'Dampfmaschine, Eisenbahn und Elektrotechnik (u. a. Werner von Siemens).',
        typ: 'mc',
        mcOptionen: ['Dampfmaschine', 'Eisenbahn', 'Fernsehtechnik', 'Elektrotechnik'],
        mcRichtigeIndizes: [0, 1, 3],
        quelle: 'ki',
        aktiv: false,
      },
    ],
  },
];

/**
 * Wipe a previous seed run (deterministic ids only — user data is safe).
 * Deck delete CASCADEs to cards and review_log, so two deletes are enough.
 */
async function wipePreviousSeedRun(db: MigrationConnection): Promise<void> {
  for (const deckId of SEED_DECK_IDS) {
    const rows = await db.getAllAsync<{ id: string }>(
      'SELECT id FROM decks WHERE id = ?',
      deckId,
    );
    if (rows.length > 0) {
      await deleteDeck(db, deckId);
    }
  }
}

/**
 * Seed the database: 2 example decks with 5 cards each. Idempotent — a
 * previous seed run is wiped first (deterministic ids; see module docblock).
 *
 * @returns the created decks (with their cards) for assertions/logging.
 */
export async function seedDatabase(
  db: MigrationConnection,
): Promise<(DeckRow & { cards: Card[] })[]> {
  await wipePreviousSeedRun(db);

  const seeded: (DeckRow & { cards: Card[] })[] = [];
  for (const spec of SEED_DECKS) {
    const deck = await createDeck(db, { titel: spec.titel, beschreibung: spec.beschreibung });
    // Overwrite the random id with the deterministic one: createDeck generates
    // a UUID; for the seed we need stable ids to make re-runs idempotent.
    await db.runAsync(
      'UPDATE decks SET id = ? WHERE id = ?',
      spec.id,
      deck.id,
    );
    deck.id = spec.id;

    const cards: Card[] = [];
    for (const cardSpec of spec.cards) {
      const card = await createCard(db, {
        deck_id: deck.id,
        frage: cardSpec.frage,
        antwort: cardSpec.antwort,
        typ: cardSpec.typ,
        mcOptionen: cardSpec.mcOptionen,
        mcRichtigeIndizes: cardSpec.mcRichtigeIndizes,
        quelle: cardSpec.quelle,
      });
      if (cardSpec.aktiv) {
        cards.push(await reviewCard(db, card.id));
      } else {
        cards.push(card);
      }
    }
    seeded.push({ ...deck, cards });
  }
  return seeded;
}

/**
 * CLI entry: `node --experimental-strip-types --import ./scripts/seed-register.mjs src/db/seed.ts [path/to/kvasir.db]`
 * Without a path: seed a temporary in-memory database and print the result.
 */
export async function main(argv: string[]): Promise<number> {
  const target = argv[0];
  const sqlite = new DatabaseSync(target ?? ':memory:');
  const db = makeNodeConnection(sqlite);
  // Same order as the app path (applyConnectionPragmas → runMigrations in
  // src/db/index.ts): PRAGMAs outside transactions, then migrations.
  sqlite.exec('PRAGMA foreign_keys = ON');
  await runMigrations(db);

  const seeded = await seedDatabase(db);
  for (const deck of seeded) {
    const active = deck.cards.filter((c) => c.entwurfsstatus === 'active').length;
    console.log(
      `Deck "${deck.titel}" (${deck.id}): ${deck.cards.length} Karten, davon ${active} aktiv`,
    );
    for (const card of deck.cards) {
      console.log(
        `  [${card.entwurfsstatus}] (${card.quelle}) ${card.typ}: ${card.frage}`,
      );
    }
  }
  console.log(
    target
      ? `Seed geschrieben: ${target}`
      : 'Seed (In-Memory-Dry-Run) erfolgreich — kein Pfad angegeben, nichts persistiert.',
  );
  return 0;
}

/**
 * Wrap node:sqlite's DatabaseSync as a MigrationConnection — the CLI mirror of
 * tests/helpers/db.ts (same adapter; duplicated because src/ must not import
 * from tests/).
 */
function makeNodeConnection(db: DatabaseSync): MigrationConnection {
  return {
    async execAsync(source: string) {
      db.exec(source);
    },
    async runAsync(source: string, ...params: unknown[]) {
      const result = db.prepare(source).run(...(params as never[]));
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
    async getAllAsync<T>(source: string, ...params: unknown[]) {
      return db.prepare(source).all(...(params as never[])) as T[];
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

// CLI detection: run main() only when executed directly (not when imported).
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
