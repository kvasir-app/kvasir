# Kvasir

> **Learn, don't scroll.** — *Lern, statt zu scrollen.*

Kvasir is an open-source, local-first learning app for everyone who wants to learn something — a healthy alternative to doomscrolling. Guided learning sessions, spaced repetition, instant feedback, and optional AI assistance through your own API key. No account, no cloud required.

Named after Kvasir, the wisest of the Norse gods — whose knowledge was shared with everyone. Knowledge for all.

## Status

Early development — the open-core MVP is being built. Scope and milestones are tracked in the project planning (see `docs/` once public).

## Planned for the MVP (v0.1)

- **Decks & questions** — create your own, stored locally on your device (SQLite)
- **Question types** — self-assessment (Anki-style) + multiple choice with auto-grading
- **Guided learning sessions** — focus blocks of 30/45/60/90 minutes with distraction blocking (Android first)
- **Spaced repetition** — FSRS-based scheduling
- **Session feedback** — rule-based evaluation after every session, plus AI feedback via BYOK
- **AI question generation** — turn your own material into question drafts (review before use), via BYOK
- **Study plan (basic)** — daily suggestion + weekly goal

## Tech stack

React Native (Expo) + TypeScript · SQLite (on-device) · ts-fsrs · lucide icons

## Development

Requirements: Node.js >= 24 (ts-fsrs v6), npm.

```bash
npm install          # install dependencies
npm run start        # Expo dev server (press a = Android, i = iOS, w = web)
npm run typecheck    # tsc --noEmit
npm run test         # vitest (unit tests, no emulator needed)
npx expo-doctor      # dependency/config sanity check
```

The first run on a device/emulator needs a development build (`npx expo run:android`)
because expo-sqlite ships native code that is not part of Expo Go.

## Project structure

```
app.json            Expo config (SDK 58, expo-router + expo-sqlite plugins)
src/app/            expo-router routes (every file here is a screen)
src/db/             data layer: openDatabase(), migrations, ts-fsrs wrapper
src/db/migrations/  numbered SQL migrations (runner is idempotent)
tests/              vitest unit tests (run on plain Node, no emulator)
branding/           icon sources (icon.svg is the master)
docs/               project documentation (schema.md = data model)
```

## Data layer conventions

- `src/db/index.ts` exposes `openDatabase()` — the single entry point. It sets
  connection PRAGMAs (`foreign_keys`, WAL) and runs pending migrations.
- Migrations are numbered files in `src/db/migrations/NNNN_name.ts`, registered
  in `migrations/index.ts`; applied versions are tracked in the `migrations`
  table. Never edit a shipped migration — add a new one.
- The ts-fsrs card state is persisted via `src/db/fsrs.ts`
  (`serializeCard`/`deserializeCard`, lossless JSON roundtrip with version tag).
  ts-fsrs v6 requires real `Date` objects — deserialization reanimates them.
- Unit tests run the real migrations against Node's built-in SQLite
  (`node:sqlite`) via a thin adapter — no emulator required.

## Principles

- **Local-first:** Your data lives on your device. No account needed.
- **Open core:** The app is free and open source. Optional cloud storage and extra features will be paid services later.
- **BYOK:** AI features use your own API key (OpenAI-compatible endpoints, local models work too). Keys never leave your device.

## License

To be decided before the first public release (open core; commercial services will be separate). Until then, all rights reserved.

## Branding

See [`branding/`](branding/) — `icon.svg` is the master, PNGs are rendered exports.
