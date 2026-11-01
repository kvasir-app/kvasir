# Kvasir — Datenmodell & SQLite-Schema (M1)

**Status:** Verbindlich für M1 · **Datum:** 01.11.2026
**Quellen:** `MVP - Open-Core.md` (Meilenstein M1), `Projekt - Lernapp.md` (Kernarchitektur: Lernkarten-Zyklus)
**Gültig für:** expo-sqlite (SQLite ≥ 3.39), ts-fsrs 5.x
**Kontext:** MVP v0.1, Mobile-first, local-first, kein Backend. Später geplante optionale Datenspeicherung (Cloud-Sync) ist beim Schema mitgedacht, aber nicht implementiert.

---

## 1. Prinzipien

| Prinzip | Entscheidung | Begründung |
|---|---|---|
| Primärschlüssel | `TEXT` UUIDv4, client-seitig generiert (kein `AUTOINCREMENT`) | Cloud-Sync (geplante Bezahl-Feature „optionale Datenspeicherung“) braucht gerätweit eindeutige IDs; Autoincrement kollidiert beim Merge über Geräte. |
| Zeitstempel | `TEXT`, ISO-8601 UTC in Millisekunden (`new Date().toISOString()`, z. B. `2026-11-01T16:20:00.000Z`) | Lexikografische Sortierung = chronologische Sortierung; Format ist identisch mit der JSON-Serialisierung der ts-fsrs-Daten (`Date` → ISO-String) — kein Konvertierungspfad. Debug-freundlich lesbar. |
| Fremdschlüssel | `PRAGMA foreign_keys = ON` **pro Verbindung** (expo-sqlite setzt PRAGMAs nicht dauerhaft) | SQLite erzwingt FKs sonst nicht; Deletionen müssen zuverlässig kaskadieren. |
| Journal-Modus | `PRAGMA journal_mode = WAL` (Empfehlung, im DB-Layer zu setzen) | Lesezugriff (Session-Composer) und Schreibzugriff (Log-Insert) parallel ohne Lock-Konflikte. |
| Validierung | Struktur (JSON-Form, Indizes-Bereich) validiert die App-Schicht; die DB prüft Typ, NOT NULL, CHECKs | SQLite kann JSON-Inhalte nicht sinnvoll per CHECK prüfen; doppelte Prüfung bringt wenig. |
| Namenskonvention | Tabellen Englisch (`decks`, `cards`, `review_log`), Fachspalten wie im Task spezifiziert Deutsch (`frage`, `antwort`, `entwurfsstatus` …) | Repo-Konvention der Scaffold-Karte (`cardsRepo.ts`, `createCard` …) und Task-Spezifikation bleiben deckungsgleich. |

---

## 2. Entitäten

### 2.1 `decks` — Lernkartensätze

| Spalte | Typ | Constraints | Begründung |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUIDv4, client-generiert (s. o.). |
| `titel` | TEXT | NOT NULL | Anzeigename des Decks; Duplikate erlaubt (lokale App, keine natürliche Unique-Eigenschaft). |
| `beschreibung` | TEXT | NULL | Optional; NULL statt `''`, damit „nichts gesetzt“ vom leeren Text unterscheidbar bleibt. |
| `created_at` | TEXT | NOT NULL | ISO-8601 UTC. |
| `updated_at` | TEXT | NOT NULL | ISO-8601 UTC; App setzt ihn bei jedem Update (kein DB-Trigger — explizit im Repo-Layer, siehe CRUD-Karte). |

### 2.2 `cards` — Fragen/Karten

Eine Zeile = eine Lernkarte inkl. ihrem **aktuellen** FSRS-Zustand (denormalisiert, s. Entscheidung D3).

**Inhaltliche Felder**

| Spalte | Typ | Constraints | Begründung |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUIDv4. |
| `deck_id` | TEXT | NOT NULL, FK → `decks(id)` `ON DELETE CASCADE` | Deck-Löscher entfernt Karten mit (lokale App, UI bestätigt; keine Waisen). Index s. Abschnitt 3. |
| `frage` | TEXT | NOT NULL | Vorderseite bzw. Question-Stem (auch bei MC). |
| `antwort` | TEXT | NOT NULL | Rückseite; bei MC die **Lösung/Erklärung**, die nach dem Beantworten als Feedback gezeigt wird („richtig/falsch + Lösung“). |
| `typ` | TEXT | NOT NULL, CHECK `('selbstbewertung','mc')` | Zwei Fragetypen des MVP: freier Abruf (Anki-Stil) und Multiple Choice mit Auto-Korrektur. |
| `mc_optionen` | TEXT | NULL; JSON-Array aus Strings | Nur `typ='mc'`; Serialisierung `JSON.stringify(string[])`, z. B. `["Mitose","Meiose","Beides"]`. App validiert Struktur. |
| `mc_richtige_indizes` | TEXT | NULL; JSON-Array aus Ints | Nur `typ='mc'`; Array, weil mehrere richtige Antworten möglich sein sollen; Werte sind Indizes in `mc_optionen` (0-basiert), z. B. `[0,2]`. App validiert Bereich. |
| `entwurfsstatus` | TEXT | NOT NULL, DEFAULT `'draft'`, CHECK `('draft','reviewed','active')` | Entwurfs-/Review-Workflow (Abschnitt 4). Nur `active` Karten sind im Lernbetrieb. |
| `quelle` | TEXT | NOT NULL, DEFAULT `'manuell'`, CHECK `('manuell','ki')` | Herkunft der Karte. Serviert den Qualitätsregelkreis (Abschnitt 5): KI-generierte Karten haben statistisch höhere Überarbeitungsquoten — ohne Ursprungskennzeichnung ist das nicht auswertbar. Erweiterbar (z. B. `'institution'`) per Migration, wenn der Institutionsserver kommt. |
| `created_at` / `updated_at` | TEXT | NOT NULL | ISO-8601 UTC; `updated_at` app-seitig bei jedem Update. |

**MC-Integrität** (DB-seitig erzwungen, s. DDL):

- `typ='mc'` ⇒ `mc_optionen` und `mc_richtige_indizes` sind NOT NULL.
- `typ='selbstbewertung'` ⇒ beide sind NULL.

**Aktueller FSRS-Zustand** (Spiegel der ts-fsrs-`Card`, Präfix `fsrs_` zur klaren Trennung Inhalt/Scheduling):

| Spalte | Typ | ts-fsrs `Card`-Feld | Begründung |
|---|---|---|---|
| `fsrs_due` | TEXT (ISO-8601 UTC) | `due: Date` | Nächste Fälligkeit; **NULL bis zur Aktivierung** (Drafts sind nicht selektierbar). Trägt den partiellen Index für `getDueCards`. |
| `fsrs_stability` | REAL | `stability: number` | FSRS-Stabilität (Intervall bei R = 90 %); 0 bis zum ersten Review. |
| `fsrs_difficulty` | REAL | `difficulty: number` | FSRS-Schwierigkeit; 0 bis zum ersten Review. |
| `fsrs_state` | INTEGER | `state: State` | 0 = New, 1 = Learning, 2 = Review, 3 = Relearning (exakte ts-fsrs-Enum-Werte); NULL bis zur Aktivierung. |
| `fsrs_last_review` | TEXT (ISO-8601 UTC) | `last_review?: Date` | NULL bis zum ersten Review. |
| `fsrs_reps` | INTEGER, DEFAULT 0 | `reps: number` | Anzahl Reviews insgesamt. |
| `fsrs_lapses` | INTEGER, DEFAULT 0 | `lapses: number` | Anzahl Vergessensereignisse (Again in State Review/Relearning). |
| `fsrs_learning_steps` | INTEGER, DEFAULT 0 | `learning_steps: number` | Position in den (Re)learning-Steps. |

Bewusst **nicht** auf `cards` gespeichert: `elapsed_days` und `scheduled_days` (in ts-fsrs 5.x deprecated, Entfernung in 6.0 angekündigt; beide sind aus `last_review`/`due` ableitbar). Die aktuelle Karte bleibt damit v6-kompatibel.

**Mapping zur ts-fsrs-Kapselung (Scaffold):** `serializeState`/`deserializeState` operieren auf dem ts-fsrs-`Card`-Objekt (JSON: Daten als ISO-Strings). Die Repos mappen feldweise zwischen Objekt und Spalten — **kein** JSON-Blob in einer Spalte, damit `fsrs_due` in SQL abfragbar und indizierbar bleibt.

### 2.3 `review_log` — Review-Protokoll

Eine Zeile = ein absolviertes Review. Append-only (nur INSERTs, keine UPDATEs/DELETEs). Jede Zeile ist zugleich der **Snapshot des Zustands VOR dem Review** — exakt die Semantik des ts-fsrs-`ReviewLog`-Objekts (dort ist `state`/`due`/`stability`/`difficulty` der Zustand vor der Bewertung). Das macht die Historie replaysbar (z. B. `get_review_history`, FSRS-Parameter-Optimierung später).

| Spalte | Typ | ts-fsrs `ReviewLog`-Feld | Begründung |
|---|---|---|---|
| `id` | TEXT | — | UUIDv4. |
| `karte_id` | TEXT | — | FK → `cards(id)` `ON DELETE CASCADE`; mit Karte verschwindet auch ihre Historie (lokale App; Sync/Backup kommt später). Index s. Abschnitt 3. |
| `reviewed_at` | TEXT | `review: Date` | Zeitpunkt des Reviews, ISO-8601 UTC. Basis für Zeitfenster-Metriken (Phasenauswertung M3). |
| `rating` | INTEGER | `rating: Rating` | 1 = Again, 2 = Hard, 3 = Good, 4 = Easy (ts-fsrs-Enum; `Manual`=0 kommt in echten Reviews nicht vor → CHECK 1–4). Selbstbewertung: die vier Anki-Stufen direkt. MC: App leitet ab (Abschnitt 5). |
| `ergebnis` | INTEGER | — | 0 = falsch, 1 = richtig. **Getrennt von `rating`**, weil die Metrik „korrekt-Anteil“ (`getReviewStats`) die binäre Wahrheit braucht, unabhängig davon, welche FSRS-Stufe die App daraus gemacht hat. |
| `fsrs_state` | INTEGER | `state` | Zustand **vor** dem Review (0–3). |
| `fsrs_due` | TEXT | `due` | Fälligkeit **vor** dem Review (bei Erstreview: Aktivierungszeitpunkt). |
| `fsrs_stability` | REAL | `stability` | Stabilität **vor** dem Review. |
| `fsrs_difficulty` | REAL | `difficulty` | Schwierigkeit **vor** dem Review. |
| `fsrs_elapsed_days` | REAL, DEFAULT 0 | `elapsed_days` | Verstrichene Tage seit letztem Review. Deprecated in ts-fsrs 5.x (Entfernung 6.0), hier behalten für Replay-Treue der Historie. |
| `fsrs_scheduled_days` | REAL, DEFAULT 0 | `scheduled_days` | Geplantes Intervall des Reviews. |
| `fsrs_learning_steps` | INTEGER, DEFAULT 0 | `learning_steps` | Step-Position vor dem Review. |

(`last_elapsed_days` aus ts-fsrs wird nicht gespiegelt — deprecated und redundant zu `elapsed_days` der Vorzeile.)

---

## 3. SQL-DDL (Migration 0001)

```sql
-- Kvasir M1 · Migration 0001
-- Vor Ausführung pro Verbindung:
--   PRAGMA foreign_keys = ON;
--   PRAGMA journal_mode = WAL;   -- Empfehlung, im DB-Layer setzen

CREATE TABLE decks (
    id           TEXT PRIMARY KEY,
    titel        TEXT NOT NULL,
    beschreibung TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE cards (
    id                  TEXT PRIMARY KEY,
    deck_id             TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    frage               TEXT NOT NULL,
    antwort             TEXT NOT NULL,
    typ                 TEXT NOT NULL CHECK (typ IN ('selbstbewertung', 'mc')),
    mc_optionen         TEXT,
    mc_richtige_indizes TEXT,
    entwurfsstatus      TEXT NOT NULL DEFAULT 'draft'
                        CHECK (entwurfsstatus IN ('draft', 'reviewed', 'active')),
    quelle              TEXT NOT NULL DEFAULT 'manuell' CHECK (quelle IN ('manuell', 'ki')),
    -- aktueller ts-fsrs-Zustand (Spiegel der ts-fsrs-Card, ohne deprecated-Felder)
    fsrs_due            TEXT,
    fsrs_stability      REAL,
    fsrs_difficulty     REAL,
    fsrs_state          INTEGER,
    fsrs_last_review    TEXT,
    fsrs_reps           INTEGER NOT NULL DEFAULT 0,
    fsrs_lapses         INTEGER NOT NULL DEFAULT 0,
    fsrs_learning_steps INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    CHECK (
        (typ = 'mc' AND mc_optionen IS NOT NULL AND mc_richtige_indizes IS NOT NULL)
        OR
        (typ = 'selbstbewertung' AND mc_optionen IS NULL AND mc_richtige_indizes IS NULL)
    )
);

CREATE TABLE review_log (
    id                  TEXT PRIMARY KEY,
    karte_id            TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    reviewed_at         TEXT NOT NULL,
    rating              INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
    ergebnis            INTEGER NOT NULL CHECK (ergebnis IN (0, 1)),
    -- ts-fsrs-ReviewLog-Snapshot: Zustand VOR dem Review
    fsrs_state          INTEGER NOT NULL,
    fsrs_due            TEXT NOT NULL,
    fsrs_stability      REAL NOT NULL,
    fsrs_difficulty     REAL NOT NULL,
    fsrs_elapsed_days   REAL NOT NULL DEFAULT 0,
    fsrs_scheduled_days REAL NOT NULL DEFAULT 0,
    fsrs_learning_steps INTEGER NOT NULL DEFAULT 0
);

-- Indizes (Task-Anforderung: deck_id und due)
CREATE INDEX idx_cards_deck_id ON cards (deck_id);

-- Partieller Index: getDueCards liest genau diese Teilmenge
-- (nur aktive Karten mit Fälligkeit)
CREATE INDEX idx_cards_due_active ON cards (fsrs_due)
    WHERE entwurfsstatus = 'active' AND fsrs_due IS NOT NULL;

-- Historie je Karte in Zeitreihenfolge (Stats, Verlauf, Replay)
CREATE INDEX idx_review_log_karte ON review_log (karte_id, reviewed_at);
```

Referenz — Migrations-Buchhaltung (gehört zum DB-Layer-Scaffold, hier nur der Vollständigkeit halber):

```sql
CREATE TABLE IF NOT EXISTS migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);
```

---

## 4. Entwurfs-/Review-Workflow (Karten als Entwürfe)

Hintergrund: KI-generierte Karten kommen **immer** als Entwürfe mit Review-Schritt — keine stille Übernahme (MVP-Risiko „KI-Qualität Fragengenerierung“). Der Status steuert, was am Regelkreis teilnimmt.

```
            reviewCard()          reviewCard()
  draft  ───────────────►  active     (direkte Freigabe erlaubt)
    │  ▲
    │  └── Nachbesserung
    ▼  │
 reviewed ──── reviewCard() ────► active
    ▲
    │  Qualitätsregelkreis: „zur Überarbeitung gezogen“
    └── active
```

| Übergang | Bedeutung | FSRS-Zustand |
|---|---|---|
| `draft → reviewed` | Entwurf gesichtet/überarbeitet, noch nicht freigegeben (z. B. KI-Entwurf geprüft, Freigabe später). | unverändert (uninitialisiert) |
| `reviewed → active` | Freigabe in den Lernbetrieb. | **Initialisierung** (s. u.) |
| `draft → active` | Direkte Freigabe (manuell erstellte Karte, Nutzer ist sicher). Genau das ist die vereinbarte Semantik von `reviewCard(cardId)` in `cardsRepo`. | **Initialisierung** (s. u.) |
| `reviewed → draft` | Zurück zur Nachbesserung. | unverändert |
| `active → reviewed` | **Qualitätsregelkreis:** Karte wird wegen schlechter Performanz zur Überarbeitung gezogen (Abschnitt 5). FSRS-Zustand bleibt erhalten; die Karte fällt aus `getDueCards` heraus, bis sie wieder freigegeben wird. | bleibt erhalten |

**Initialisierung bei Aktivierung** (entspricht ts-fsrs-Neukarte, `createEmptyCard`):

`fsrs_due = jetzt`, `fsrs_stability = 0`, `fsrs_difficulty = 0`, `fsrs_state = 0 (New)`, `fsrs_last_review = NULL`, `fsrs_reps = 0`, `fsrs_lapses = 0`, `fsrs_learning_steps = 0`. Das erste Review initialisiert Stabilität/Schwierigkeit aus den FSRS-Gewichten `w[]`.

---

## 5. Regelkreis: Feld → Pfeil

Kurzform: **Generator → Karten → Auswahl (via FSRS) → Session → Feedback → Metriken → zurück in Auswahl UND Generator.**

| # | Pfeil | Felder, die den Pfeil speisen |
|---|---|---|
| 1 | **Generator → Kartenmodell** | Generator (M4: KI via BYOK; vorher: manuelle Eingabe) schreibt `cards` mit `quelle='ki'|'manuell'`, `entwurfsstatus='draft'`, plus `frage`, `antwort`, `typ`, `mc_optionen`, `mc_richtige_indizes`. Keine stille Übernahme: Lernbetrieb erst nach `reviewCard()`. |
| 2 | **Kartenmodell → Auswahl (Session-Composer)** | Auswahl liest `WHERE entwurfsstatus='active' AND fsrs_due <= jetzt ORDER BY fsrs_due` (partieller Index `idx_cards_due_active`). Mix/Priorität aus `fsrs_state` (New = neue Karte, Review/Relearning = Wiederholung), `fsrs_reps`, `fsrs_lapses`, `fsrs_difficulty` (schwere zuerst bzw. ausgleichen), `fsrs_stability`. **`due` und der FSRS-Zustand sind die quantitative Metrik der Auswahl.** |
| 3 | **Auswahl → Session** | Liefert `frage`, `typ`, `mc_optionen` + `mc_richtige_indizes` (bei MC zur Auto-Korrektur), `antwort` als Lösung für das sofortige Feedback. |
| 4 | **Session → Feedback** | Nutzerurteil wird zu `rating` (1–4) und `ergebnis` (0/1): Selbstbewertung: wieder zeigen = Again(1)/falsch, schwer = Hard(2)/richtig, gut = Good(3)/richtig, leicht = Easy(4)/richtig. MC: falsch = Again(1)/0, richtig = Good(3)/1 (v0.1 ohne Zwischenstufen; App mappt). |
| 5 | **Feedback → Scheduling (atomar, eine Transaktion)** | INSERT in `review_log` (Zeile inkl. Snapshot des Zustands **vor** dem Review: `fsrs_state`, `fsrs_due`, `fsrs_stability`, `fsrs_difficulty`, `fsrs_elapsed_days`, `fsrs_scheduled_days`, `fsrs_learning_steps`) **und** UPDATE von `cards` mit dem neuen ts-fsrs-Zustand: `fsrs_due`, `fsrs_stability`, `fsrs_difficulty`, `fsrs_state`, `fsrs_last_review`, `fsrs_reps + 1`, `fsrs_lapses` (+1 bei Again in Review/Relearning), `fsrs_learning_steps`. Beides zusammen, nie einzeln (Konsistenzregel aus der Review-Log-Karte). |
| 6 | **Feedback → Metriken** | `getReviewStats(deckId?)` aggregiert `review_log`: `COUNT(*)` (Anzahl Reviews), `AVG(ergebnis)` (korrekt-Anteil), gruppiert nach Karte/Deck; Verläufe über `reviewed_at` (Zeitfenster — Grundlage der Phasenauswertung in M3, ohne eigene Session-Tabelle in M1). |
| 7 | **Metriken → Auswahl** | Läuft über den Karten-Zustand: die in Schritt 5 geschriebenen `fsrs_due`/`fsrs_reps`/`fsrs_lapses`/`fsrs_difficulty` **sind** die quantitative Metrik, die die nächste Auswahl prioritisiert (Schritt 2). Kein separater Metrik-Speicher nötig. |
| 8 | **Metriken → Generator (Qualitätsregelkreis)** | Karten mit hohem `fsrs_lapses`, niedrigem `AVG(ergebnis)` oder hoher `fsrs_difficulty` werden markiert: `entwurfsstatus active → reviewed` („zur Überarbeitung gezogen“) → zurück an Generator/Redaktion (M4: KI-Rewrite; vorher: manuelle Nachbesserung). `quelle` trennt Generator-Probleme (KI) von Inhaltsproblemen (manuell). |

---

## 6. Bewusste Entscheidungen und Abgrenzungen

| # | Entscheidung | Begründung |
|---|---|---|
| D1 | UUIDv4-Text-IDs statt `AUTOINCREMENT` | Sync-Fähigkeit der geplanten Datenspeicherung; gerätlokal erzeugte IDs kollidieren nie. |
| D2 | ISO-8601-UTC-TEXT statt Epoch-Integer | Identischer String-Format wie die ts-fsrs-JSON-Serialisierung; korrekt sortier- und vergleichbar; menschenlesbar. Einzige Regel: immer `new Date().toISOString()` (UTC, mit Millisekunden). |
| D3 | FSRS-Zustand denormalisiert auf `cards` (nicht eigene Tabelle) | `getDueCards` braucht keinen Join; eine Zeile = voller Auswahlkontext. 1:1-Beziehung macht eine eigene Tabelle zu Ballast ohne Vorteil. |
| D4 | `review_log` speichert den Zustand **vor** dem Review | Exakte ts-fsrs-`ReviewLog`-Semantik → Historie ist replaysbar (später: FSRS-Parameter-Optimierung, „true retention“-Auswertung). |
| D5 | `ON DELETE CASCADE` für Deck→Karten und Karte→Log | Lokale Single-User-DB; Löschen eines Decks ist eine bewusste UI-Aktion mit Bestätigung; keine Waisen. Das Löschverhalten dokumentiert die CRUD-Karte an dieser Stelle weiter. |
| D6 | `elapsed_days`/`scheduled_days` nur im Log, nicht auf `cards` | In ts-fsrs 5.x deprecated (Entfernung in 6.0) und aus `last_review`/`due` ableitbar — `cards` bleibt v6-sauber; das Log behält sie für Replay-Treue. |
| D7 | `ergebnis` (0/1) zusätzlich zu `rating` (1–4) | „korrekt-Anteil“ ist eine binäre Wahrheit; die FSRS-Stufe ist eine Scheduling-Entscheidung der App. Beides zu vermischen macht Stats unzuverlässig. |
| D8 | `quelle` jetzt, Tags/Themen später | `quelle` kostet nichts (DEFAULT) und serviert den Qualitätsregelkreis. Tags/Themen kommen mit der KI-Fragengenerierung (M4) als eigene Migration (`tags`-Tabelle + Join), nicht als kommasepariertes Textfeld. |
| D9 | Keine Session-/Phasen-Tabelle in M1 | Lernphasen sind M2/M3. Für v0.1 reicht die Fensterung über `review_log.reviewed_at`; eine `sessions`-Tabelle ist eine saubere Migration, wenn der Phasen-Flow steht. |
| D10 | Kein JSON-Blob für den FSRS-Zustand | `fsrs_due` muss in SQL vergleichbar und indizierbar sein (Auswahl!). Die Kapselung serialisiert das ts-fsrs-Objekt, die Repos mappen feldweise auf Spalten. |
| D11 | `antwort` auch bei MC NOT NULL | MC zeigt nach dem Beantworten die Lösung/Erklärung als Feedback — dafür ist `antwort` da, nicht `mc_optionen`. |

## 7. Addendum: ts-fsrs v6 Felder (Scaffold-Task, 01.11.2026)

Beim Implementieren des DB-Layers (Migration 0001 in `src/db/migrations/`) hat
sich gezeigt: ts-fsrs v6 (`DefaultScheduler`) hat ein anderes Card-Shape als
die deprecated 5.x-API. `scheduler.review()` validiert das **vollständige**
Card-Objekt und bricht sonst mit `Expected valid Date fields` /
`Expected FSRS7 memory state` ab (probe-verified). Drei Felder fehlen in
Abschnitt 2/3 und wurden in der Migration ergänzt:

| Feld | cards-Spalte | review_log-Spalte | Warum nötig |
|---|---|---|---|
| `stabilityFast` | `fsrs_stability_fast REAL` | `fsrs_stability_fast REAL` | FSRS-7-Zweitgedächtnisgröße; `review()` validiert sie als Teil des Memory-States |
| `scheduleStatus` | `fsrs_schedule_status TEXT` (`new`/`review`/`learning`/…) | `fsrs_schedule_status TEXT` | Scheduling-Status des v6-Modells; Teil der validierten Card |
| `cardId` | `fsrs_card_id TEXT` | `fsrs_card_id TEXT` | v6-Karten-ID (UUID); Teil der validierten Card |

Die Serialisierung (`src/db/fsrs.ts`) speichert die Felder mit Versions-Tag
(`v: 1`); Deserialisierung reanimiert `Date`-Objekte (v6 verlangt echte Dates).
Die Spiegel-Spalten auf `cards` bleiben wie in D10 feldweise (kein JSON-Blob),
damit `fsrs_due` sortier-/indizierbar bleibt — die drei neuen Felder sind
rein pass-through (Roundtrip), die Auswahl nutzt sie nicht direkt.

## 8. Ausblick (nicht Teil von M1)

- **M2:** Lernphase/Session-Flow auf genau diesem Schema; `getDueCards` + Mix-Logik im Session-Composer.
- **M3:** Phasen-Auswertung; ggf. `sessions`-Tabelle als Migration.
- **M4:** KI-Fragengenerierung schreibt ausschließlich `entwurfsstatus='draft'`, `quelle='ki'`; Tags-Migration.
- **v0.2:** Anki-Import (.apkg) → Karten-Masseninsert, `quelle` erweitern (z. B. `'anki'`).
- **nach v0.1:** Cloud-Sync (Bezahl-Feature) — UUIDs und Append-only-Log sind die Vorbereitung; Konfliktlösung (LWW je Feld / Log-Replay) wird dort entschieden.
