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

## Principles

- **Local-first:** Your data lives on your device. No account needed.
- **Open core:** The app is free and open source. Optional cloud storage and extra features will be paid services later.
- **BYOK:** AI features use your own API key (OpenAI-compatible endpoints, local models work too). Keys never leave your device.

## License

To be decided before the first public release (open core; commercial services will be separate). Until then, all rights reserved.

## Branding

See [`branding/`](branding/) — `icon.svg` is the master, PNGs are rendered exports.
