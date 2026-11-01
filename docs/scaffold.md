# Scaffold-Konventionen (M1-Fundament)

Entstanden beim Aufsetzen des Expo/React-Native-Projekts (Task M1-Scaffold).
Diese Datei dokumentiert die minimale Konvention, solange die Repo-Strategie
(Issues, PRs, Governance) noch nicht final von Lukas eingerichtet ist.

## Repo-Strategie (provisorisch)

- **Ein Repo** (`kvasir-app/kvasir`) für App + Dokumentation.
- **Arbeiten auf Feature-Branches**, Merge nach Review (Merge-Modus wird pro
  Aufgabe mit Lukas geklärt: Bob mergt selbst / Bob stellt MR / eigene Branches
  mit gegenseitigem Review).
- Struktur: Expo-Projekt im Repo-Root (`package.json` auf Root-Ebene),
  Code unter `src/`, Dokumentation unter `docs/`.

## Stack (installiert und verifiziert)

| Baustein | Version | Anmerkung |
|---|---|---|
| Expo SDK | 58.0.22 | blank-typescript Template als Basis |
| React / React Native | 19.3.0 / 0.88.1 | react-dom 19.3.0 gepinnt (Peer-Konflikt mit 19.3.1) |
| expo-sqlite | 58.0.15 | via `npx expo install` (SDK-kompatible Version) |
| ts-fsrs | 6.0.0 | **Neue v6-API**: `DefaultScheduler` (async Factory) statt `fsrs()` |
| expo-router | 58.0.29 | Dateibasiertes Routing, Routes in `src/app/` |
| TypeScript | ~6.0.3 | strict; `baseUrl` ist deprecated (TS 7) — `paths` ohne `baseUrl` |
| Vitest | 5.0.5 | Unit-Tests laufen auf plain Node (`node:sqlite` als Test-Engine) |

## Entscheidungen beim Scaffold

1. **Expo-Projekt im Repo-Root** (nicht in `app/`): Das vorhandene `.gitignore`
   war bereits auf ein Root-Projekt ausgelegt; `expo prebuild`, EAS und Metro
   erwarten die Config auf Root-Ebene. `src/` und `docs/` bleiben wie vereinbart.
2. **expo-router statt App.tsx-Einstieg**: `"main": "expo-router/entry"` in
   `package.json`, Routes in `src/app/` (Konvention aus AGENTS.md des Templates).
3. **Migration-Runner entkoppelt von expo-sqlite** (`src/db/migrations/runner.ts`):
   Er arbeitet auf einem minimalen `MigrationConnection`-Interface, damit die
   echten Migrationen in Unit-Tests gegen `node:sqlite` laufen können —
   ohne Emulator. `src/db/index.ts` ist das Expo-Fassade (`openDatabase()`).
4. **PRAGMAs nie in Migrationen**: `foreign_keys`/`journal_mode` sind innerhalb
   einer Transaktion No-ops; sie werden pro Verbindung gesetzt
   (`openDatabase()`, Test-Adapter).
5. **ts-fsrs v6 Card-Shape**: `review()` validiert das vollständige Card-Objekt
   (inkl. `stabilityFast`, `scheduleStatus`, `cardId`) und verlangt echte
   `Date`-Objekte. Deshalb: Serialisierung mit Versions-Tag (`v: 1`),
   Deserialisierung reanimiert Dates. Die mitgelieferten .d.ts-Typen von
   ts-fsrs sind schmaler als die Runtime-Objekte — `src/db/fsrs.ts` definiert
   eigene exakte Interfaces und castet nur an der Scheduler-Grenze.
6. **Schema-Abweichungen gegenüber docs/schema.md §3**: `cards` hat zusätzlich
   `fsrs_stability_fast`, `fsrs_schedule_status`, `fsrs_card_id`; `review_log`
   zusätzlich `fsrs_stability_fast` (Snapshot). Grund: siehe 5 — ts-fsrs v6
   braucht diese Felder für den Review-Replay. Dem Datenmodell-Task wurde das
   per Kommentar gemeldet; schema.md im Repo enthält den Stand inkl. dieser
   Felder (Addendum unten).

## Nächste Schritte (M1-Rest)

- `src/db/decksRepo.ts` / `cardsRepo.ts` (CRUD-Task)
- `src/db/reviewLogRepo.ts` (Review-Log-Task, atomar mit `withExclusiveTransactionAsync`)
- Seed + Smoke-Test (`src/db/seed.ts`, Integrationstest über alle Repos)
