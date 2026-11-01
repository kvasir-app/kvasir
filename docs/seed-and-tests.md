# Seed-Daten und Tests ausführen (M1)

## Seed (Beispieldaten)

Das Seed-Skript erzeugt 2 Beispiel-Decks mit je 5 Karten (Mix aus
Selbstbewertung und Multiple-Choice, `quelle` manuell/ki, Mischung aus
`entwurfsstatus='draft'` und `'active'` — aktive Karten werden über denselben
`reviewCard`-Pfad aktiviert, den auch die App nutzt).

```bash
# In-Memory-Dry-Run: seedet eine temporäre DB und gibt das Ergebnis aus
node --experimental-strip-types --import ./scripts/seed-register.mjs src/db/seed.ts

# In eine Datei seeden (Datenbank wird bei Bedarf automatisch migriert)
node --experimental-strip-types --import ./scripts/seed-register.mjs src/db/seed.ts kvasir.db
```

Das Skript ist idempotent: Es löscht vor jedem Lauf nur seine eigenen Decks
(deterministische IDs `seed-deck-biologie` / `seed-deck-geschichte`; Deck-Löschung
kaskadiert zu Karten und Review-Logs) und legt sie neu an. Nutzerdaten mit
anderen IDs bleiben unberührt.

## Tests

```bash
npm test          # gesamte Suite (Unit-Tests + End-to-End-Smoke-Test)
npx vitest run tests/smoke.test.ts   # nur der Smoke-Test
```

Der Smoke-Test (`tests/smoke.test.ts`) läuft gegen eine frische In-Memory-Datenbank
und bildet den vollen Regelkreis aus `docs/schema.md` §5 ab:

1. Deck anlegen
2. Karten als Entwürfe anlegen (Selbstbewertung + MC, manuell + ki)
3. `reviewCard` → Status aktiv, FSRS-Zustand initialisiert
4. Mehrere `logReview` über verschiedene Ratings (Good/Again/Hard/Easy)
5. `getDueCards` liefert die korrekte Reihenfolge (due aufsteigend)
6. `getReviewStats` stimmt mit den Logs überein (COUNT + AVG(ergebnis))
7. Qualitätsregelkreis: `active→reviewed` („zur Überarbeitung gezogen“) —
   Karte fällt aus `getDueCards` heraus, FSRS-Zustand bleibt erhalten;
   Re-Aktivierung initialisiert neu (§4: „reviewed → active = Initialisierung“)
8. Deck-Löschung kaskadiert wie dokumentiert (D5: Karten + Review-Logs)

## Weitere Checks

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # expo lint
```
