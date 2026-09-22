# LISTENING ROOM

> The ear gate of KYX — a standalone listening surface where GOLDEN presets,
> scene presets and intent-engine candidates are judged BY EAR, and where
> those verdicts become training data for the intent engine (ranker golden
> orders + favourites that retrain all three learned models).
>
> Created 2026-09-21 (FX-ADD-REWORK wave follow-up). Owner-facing how-to for
> adding new suites and presets is §6; the verdict→training contract is §5.

---

## 1. Why this exists

Presets and generated candidates are built from defensible constants, but
constants are never ear-tuned. The Listening Room makes the human ear the
final gate AND turns every judgement into engine training:

- **A/B judgements** approve or reject presets (quality gate),
- **rankings** of intent candidates become human-preferred orders for the
  ONNX ranker (`intent-ranker-golden.json`),
- **★ favourites** become weighted samples that retrain the drum prior, the
  melodic prior and the ranker together (`favorites:retrain`).

Nothing leaves the machine: renders, verdicts and packs live under
`listening/` (gitignored) and the training scripts read local files.

## 2. Quick start

```bash
npm run listening:room     # render all suites → listening/room/  (~5–10 min)
npm run listening:serve    # http://127.0.0.1:5179/room/
# …listen, rank, ★ — verdicts POST to listening/verdicts.json
npm run listening:ingest   # verdicts → ranker golden + favorites pack
npm run favorites:retrain -- listening/favorites-pack.json   # all 3 models
npm run ranker:train       # retrains the ranker incl. new golden orders
```

The morph-only pack (`npm run listening:morph` → `listening/morph/`) stays
available as the legacy single-suite variant.

## 2.1 TRAIN MY TASTE — the one-command learning loop

```bash
npm run taste:train          # full loop (add --dry-run to preview)
```

Orchestrator (`scripts/train-my-taste.mjs`) runs, in order:

1. **ingest** — room verdicts → ranker golden (complete index permutations:
   your ranked top-N sits on top, unheard candidates fill the tail by
   descending heuristic score) + top-level `golden.reviewed` flag,
2. **merge favourites** — `listening/favorites-pack.json` (room ★) + every
   pack in `listening/dice-packs/` (dice tray ⬇★ export, or
   `POST /api/favorites` on the serve port) → `favorites-combined.json`,
3. **retrain** — `favorites:retrain` (drum prior + melodic prior + ranker),
4. **activate** — `ranker:activate`: golden review gate → `ranker:train` →
   independent holdout validation → flips `DEFAULT_RANKER_MODE` to
   `"active"` when the holdout gate passes,
5. **before/after** — model manifests + validation report diffed and printed
   (retrained models marked ●, holdout accuracy before vs after).

First real run (2026-09-22): one room ranking session retrained
`intent-ranker-v1` and lifted `goldenHoldoutPairwiseAccuracy` 0.7083 →
**0.7500** — the gate flipped the ranker **active**.

Known limits: dice pack entries need a real `grooveId` (the drum prior
skips unknown grooves); the activation gate demands an independent holdout
— more listening sessions raise it.

## 3. Files

| Path | Role |
| --- | --- |
| `scripts/render-listening-room.mjs` | renders every suite through the REAL engine (vite + headless Chromium, `renderProject` pattern mode), writes WAVs + `room.json` + copies the page template |
| `scripts/listening-room-template.html` | the room page (static; fetches `room.json`, POSTs verdicts) |
| `scripts/serve-listening.mjs` | static server on 127.0.0.1:5179 **+ verdict API** (`POST /api/verdict`, `GET /api/verdicts`) |
| `scripts/ingest-listening-verdicts.mjs` | verdicts → ranker golden merge + FavoritesPack |
| `listening/room/` | output (gitignored): WAVs, `room.json`, `room.html` |
| `listening/verdicts.json` | raw verdict ledger (append-only) |

## 4. Suites

### 4.1 MORPH — golden preset gate (auto-joining)

Renders every id in `GOLDEN_PRESET_IDS`
(`src/effects/morph-dynamics-core/presets/factoryPresets.ts`) on the house
beat, twice per preset: on the DRUM track and on the 808 track, plus one
shared bypass. **New GOLDEN morph presets join automatically** — add the id
to `GOLDEN_PRESET_IDS`, re-run `listening:room`, the row appears.

Each preset A/B answers: is the difference musical (not just louder), does
the drive react to the performance, are transients protected, does the sub
stay clean on the 808 path.

### 4.2 SCENES — genre presets on their own beats

`SCENE_PRESET_IDS` (drill / phonk / jersey / dnb) rendered on their matching
genre template (`createProjectFromTemplate`), each with its own bypass.
Note: there is no `dnb` TemplateId — the DnB preset listens on a drill beat
(closest energetic pairing).

### 4.3 INTENT — rank candidates, teach the ranker

Three groups picked **directly from `scripts/data/intent-ranker-dataset.json`**
(first house / techno / trap group with ≥4 candidates). Seeds and groupKeys
match the dataset walk 1:1, so a ranking verdict ingests without any
translation. The room page asks for a preference order (click candidates
1→4) and optional ★ favourites.

The rendered candidates come from the canonical pipeline
(`normalizeIntent → planGeneration → generatePattern`) with the same slider
formula the dataset walk uses, so what you hear is what the ranker scored.

## 5. Verdict → training contract

`room.html` POSTs to `/api/verdict`; everything appends to
`listening/verdicts.json`:

```jsonc
// ranking — trains the ONNX ranker (ingest §6 merges into golden)
{ "kind": "ranking", "groupKey": "house:Driving:ds-house-Driving-0",
  "order": ["ds-house-Driving-2", "ds-house-Driving-0", "ds-house-Driving-3", "ds-house-Driving-1"],
  "savedAt": 1769000000000 }

// favourite — retrains drum prior + melodic prior + ranker
{ "kind": "favorite", "groupKey": "…", "savedAt": 1769000000000,
  "entry": { /* FavoriteLedgerEntry — see src/intent/favorites.ts */ } }
```

`npm run listening:ingest` then:

1. **ranking** → upserts `{ groupKey, order, reviewed: true, reviewedBy:
   "listening-room", source: "listening-room" }` into
   `scripts/data/intent-ranker-golden.json` — **only when the groupKey
   exists in the ranker dataset** (unmatched keys are reported and left in
   the verdict file; never invent golden entries for groups the ranker
   cannot score).
2. **favourite** → appends `entry` to `listening/favorites-pack.json`
   (`{ version: 1, source: "listening-room", entries: [...] }`), ready for
   `npm run favorites:retrain -- listening/favorites-pack.json`.

The ingest only appends training data — it never deletes or rewrites
golden orders from other sources.

## 6. How to attach new things

### 6.1 A new GOLDEN morph preset

1. Add the preset to `factoryPresets.ts` and its id to `GOLDEN_PRESET_IDS`
   (the room reads that list dynamically — no room changes needed).
2. `npm run listening:room` → the row appears in the MORPH suite.
3. Listen, judge. Golden = regression-locked constants that PASSED the ear
   gate (PRESET_SYSTEM.md §21). A rejected preset either gets its constants
   tuned or loses its golden id.

### 6.2 A new preset suite (other plugin, new preset family)

The renderer and the page are data-driven through the `room.json` manifest:

1. **Render**: in `scripts/render-listening-room.mjs`, extend the page-side
   body — push entries into a new `out.<suite>` array with
   `{ id, label, description, …audio base64 }` (copy the SCENES block: it
   is the minimal bypass-vs-variant shape). Remember the page-side rules:
   the evaluate body is a STRING (vite-node rewrites `import()` inside
   evaluate functions), string-concat instead of `${}` inside, ASCII only.
2. **Manifest**: write the files under `listening/room/<suite>/` and push a
   `room.<suite>` array: `{ id, label, description, files: { … } }`.
3. **Page**: add a builder `build<Suite>(entries)` in
   `scripts/listening-room-template.html` (copy `buildScenes`) + a tab
   button (`data-suite="<suite>"`).
4. No ingest changes needed unless the suite should TRAIN something — then
   add a verdict kind + a block in `scripts/ingest-listening-verdicts.mjs`
   (§5 contract).

### 6.3 New INTENT groups

Intent groups are picked from the dataset at render time (first
house/techno/trap group with ≥4 candidates). To listen to other groups,
change the `wanted` genres / pick logic in the `GROUPS_DATA` builder inside
`render-listening-room.mjs` — groupKey compatibility is automatic because
the groups ARE dataset rows. After regenerating the dataset
(`npx vite-node scripts/generate-intent-ranker-dataset.mts`) re-run the
room so seeds stay 1:1.

### 6.4 Golden preset definition conventions (repo contract)

- A golden preset is a FACTORY preset whose id is listed in the plugin's
  golden id export (`GOLDEN_PRESET_IDS` for morph) — that list is what the
  regression locks and the room both read.
- Golden promotion REQUIRES a listening pass through this room (or an
  equivalent documented session): constants-only presets enter as
  candidates, not as golden.
- Keep golden ids STABLE once approved — the room, regression fixtures and
  (future) preset packs key on them.

## 7. Troubleshooting

- **`__vite_ssr_dynamic_import__` is not defined** — the evaluate body was
  passed as a FUNCTION; vite-node rewrites `import()` inside it. Keep the
  body as a string (see the morph/room renderers).
- **`Invalid or unexpected token` in the page** — the body picked up `${}`
  interpolation or non-ASCII. Keep the body string-concatenated and ASCII.
- **`Cannot read properties of undefined (reading 'bpm')`** — a scene was
  rendered on a templateId that does not exist (`createProjectFromTemplate`
  returns undefined for unknown ids). Check the TemplateId union.
- **Ranking verdict "unmatched"** — the groupKey is not in the current
  dataset; regenerate the dataset or fix the key (§6.3).
- Port conflicts: render uses 5237, server 5179 (`PORT=` overrides both).
