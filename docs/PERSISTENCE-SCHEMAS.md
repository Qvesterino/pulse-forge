# PERSISTENCE SCHEMAS

> **Cross-platform readiness campaign — GOAL 05 deliverable** (2026-09-22).
> Complete inventory of every persisted byte: the 15 IndexedDB stores, 35
> localStorage + 4 sessionStorage keys, and the 11 export/share formats —
> with ownership, versioning class (explicit / implicit / unversioned),
> read-side sanitize behavior, binary payload formats and identifier
> schemes. Method: two parallel read-only sweeps, spot-verified.
> Companion: `docs/PLATFORM-CONTRACTS.md` (the storage seam),
> `docs/STATE-MACHINES.md`, `CAMPAIGN_STATE.md`.
>
> Campaign rule honored: **stable formats are NOT redesigned.** The gaps
> found are pinned by tests (`tests/persistence/schema-evolution.test.ts`,
> `tests/collab-ydoc-drift.test.ts`) and queued fixes are listed in §7.

---

## 1. IndexedDB — single choke point `src/persistence/db.ts`

`DB_NAME "pulse-forge"`, `DB_VERSION 12`, 15 object stores. Every repo goes
through `openDb()`/`tx()`. Contracts frozen in `src/persistence/contracts.ts`.
Future-version policy: `onversionchange` yields the connection immediately
(never block another tab); a blocked open times out after 5 s with an
actionable error; rejections are never cached. Known asymmetry (RECORDED):
another tab holding a HIGHER version surfaces as a raw `VersionError`
without a friendly message.

### Per-store registry

| Store | Owner repo | Record shape (essentials) | Versioning | Read sanitize | Binary | Id scheme |
|---|---|---|---|---|---|---|
| `projects` | ProjectRepository | full `ProjectDocument` + `updatedAt` re-stamped on save | **explicit** `schemaVersion` (SCHEMA_VERSION 1); future rows quarantined via `listIncompatible` | `validateProjectShape` → `migrateProject` → `normalizeProject`; bad rows skipped, never fatal | — (audio by ref) | `uid("project")` |
| `meta` | ProjectRepository | KV: `"recentProjectId"` → string | unversioned | n/a (string) | — | project id |
| `presets` | PresetRepository | `InstrumentPreset` (+ forced `user:true`, legacy `metadata?`) | unversioned | light filter (string id/name/instrument, `mood ?? []`), else raw cast | — | `uid("preset")` |
| `library` | LibraryRepository | single row `"library-state"`: favorite/recent id arrays (cap 24) | unversioned | per-field Array+string filter; load failure → EMPTY | — | fixed key |
| `user-samples` | UserSampleRepository | `UserSampleAsset` {id,name,fileName,category,duration,sampleRate,channels,createdAt,bpm?} | unversioned (optional-field accretion) | **raw cast** (memoized; failure → `[]`) | — | `user.${slug}-${Date.now().toString(36)}` / stable `user.recording-*` |
| `user-sample-audio` | UserSampleRepository | `UserSampleAudio` {id, data: ArrayBuffer\|Blob\|PcmRef} | **format-tagged only for the PCM ref** (`kind:"pcm-f32-planar-v1"`) | discriminator check on the ref variant only | encoded source bytes / Blob / PCM pointer | = metadata row id (audio written FIRST) |
| `recording-sessions` | RecordingRecoveryRepository | `RecordingSession` {id,ownerId?,projectId,trackId,trackName,placeOnTimeline?,startBar,bpm,recordingInputOffsetMs?,sampleRate,channels,createdAt,updatedAt,status,totalFrames,chunkCount} | unversioned (3 optional fields accreted) | raw casts + strict status/staleness filters; quota typed | — | `recording.${uuid}`; ownerId = per-tab-load token |
| `recording-chunks` | RecordingRecoveryRepository | `RecordingPcmChunk` {sessionId, sequence, frames, channels: ArrayBuffer[]} | unversioned (validated structurally per read) | strict: sequence-exact, byte-length-exact, all-or-nothing take | **raw planar Float32 PCM**, ≤1 s/chunk | composite `[sessionId, sequence]` |
| `frozen-audio` | FrozenBufferRepository | `FrozenAudioEntry` {id, data} | unversioned (WAV header self-describes) | raw; decode failure → track unfreezes | **WAV 16-bit PCM**, 44100 Hz | `frozen-${trackId}-${Date.now().toString(36)}` |
| `user-kits` | KitRepository | `UserKit` {id,name,genre,description,pads[16],createdAt} | unversioned | **none** (raw cast + sort) | — | `ukit-${Date.now().toString(36)}-${rand}` |
| `groove-pool` | GroovePoolRepository | `GroovePoolEntry` {id,name,timing[],accent[],createdAt} | unversioned | **none** (raw cast + sort) | — | `groove-${Date.now().toString(36)}-${rand}` |
| `project-snapshots` | SnapshotRepository | `ProjectSnapshot` {id,projectId,label,createdAt,doc,seq?} (cap 20/project) | **explicit via inner doc** (`validateProjectShape(snap.doc)`) | corrupt rows skipped per-id | — | `${projectId}:${Date.now().toString(36)}+rand` |
| `project-snapshot-index` | SnapshotRepository | KV: snapshot id (dual legacy keys still written+cleaned; reads use the rebuilt in-memory index) | unversioned | non-strings skipped | — | derived keys |
| `ultina-presets` | UltinaPresetRepository | `UltinaPresetEntry` {id,name,params,createdAt,schemaVersion:1} | **explicit** (stamped to current after re-validation; readers never branch) | `sanitizeEntry` + vendored-schema clamp (unknown ids dropped) | — | `ultina-preset-${Date.now()}-${rand}` |
| `morph-presets` | MorphPresetRepository | `MorphPresetEntry` {…same shape, schemaVersion:1} | **explicit** (same policy) | mirror of Ultina sanitizers | — | `morph-preset-${Date.now()}-${rand}` |

### DB_VERSION history 1 → 12 (store creation only — zero data migrations ever)

`onupgradeneeded` is an idempotent `if (!contains) createObjectStore` list,
so upgrades are monotonic-safe from any prior version. v1 pre-repo; v2
projects+meta+presets · v3 +library · v4 +user-samples · v5
+user-sample-audio · v6 +frozen-audio · v7 +user-kits · v8
+project-snapshots · v9 +ultina-presets · v10 +project-snapshot-index ·
v11 +recording-sessions/chunks · v12 +morph-presets.

**⚠ v8 incident (pinned by test):** groove-pool was added to
`onupgradeneeded` WITHOUT bumping DB_VERSION (9c9327c) — installs that ran
the 9-store v8 would never get the store (the upgrade path never re-runs).
Only v9+ reopening the upgrade path saved real installs.
`tests/persistence/schema-evolution.test.ts` now pins: (a) all 15 stores
exist at DB_VERSION 12; (b) the upgrade path from a hand-built v8-shaped DB
completes to all 15 stores; (c) a DB at a FUTURE version fails the open
cleanly.

### Save/load authority

`ProjectRepository.save()` stamps `updatedAt` only — validation lives on
READ (`validateProjectShape → migrateProject → normalizeProject`); the
18-domain normalizer is the authoritative repair. `SCHEMA_VERSION` has
stayed 1 while the shape grew optional fields — the version field
discriminates nothing today; **actual compatibility = normalizeProject**
(RECORDED: if a breaking shape change ever lands, this is the field to bump,
with a real migration step in `migrateProject`).

## 2. Web storage — 35 localStorage + 4 sessionStorage keys

Complete table (owner · format · sanitize · migration):

| Key | Owner | Format | Versioned | Sanitize | Migration |
|---|---|---|---|---|---|
| `pf:intent-favorites` | intent/favorites | JSON ledger | additive v2 fields | `isValidLedgerEntry` filter, FIFO 200 | drop-invalid |
| `pf-theme-v1` | ui/theme | ThemeState JSON | v1 suffix | clamp via `normalizeThemeState` | normalize-is-migration |
| `pf-padkeys-v1` | ui/padKeys | 16-key JSON | v1 | `normalizePadKeyMap` | — |
| `pf:recording-input-device` | audio-engine/recordingInput | string | no | catch → delete on empty | — |
| `pf:recording-input-gain-db` | recordingInput | numeric string | no | non-finite → 0 | — |
| `pulse-forge:latency-calibration:v1` | latencyCalibration | JSON record | v1 | per-field finite/parse checks, catch → defaults | field-tolerant |
| `pulse-forge:recording-alignment:v1` | recordingAlignment | numeric string | v1 | clamp ±500 | — |
| `pf-funnel-v1` / `pf-funnel-timings-v1` | services/funnel | JSON records | v1 | shape guard, junk dropped at write | — |
| `pf:audio-tag` / `pf:intent-ranker` / `pf:semantic-embed` / `pf:symbolic-prior` / `pf:embedding-conditioned` / `pf:style-vector` | ai clients + intent/style-vector | `"on"/"off"/"shadow"/"active"` flags | no | exact-match else default | — |
| `pf:style-vector-cache` | intent/style-vector | {version:1, signature, vector} | **embedded v1 + fingerprint** | version/signature mismatch → recompute | drop-not-migrate |
| `pf:audio-index-cache` | sample-library/audio-index | {version:1, signature, index} | **embedded v1 + fingerprint** | mismatch → rebuild | drop-not-migrate |
| `pulse-forge.freesound-token` | samples/freesound | string | no | catch → "" | — |
| `pf-gallery-api` / `pf-creator-name` | gallery/galleryApi | strings | no | trim / strip slash | — |
| `pf-remix-parent` | galleryApi | JSON {id,title,savedAt} | TTL 24 h | expired/invalid → remove | TTL expiry |
| `pf-intent-opened` / `pf-macros-collapsed` / `pf-tour-v1` / `pf-onboarded` | ui flags | `"1"` flags | partial v1 suffix | `=== "1"` | — |
| `pf:pluginMode` | ui/FloatingPlugin | `"hobby"\|"profi"` | no | **was blind cast — FIXED (GOAL 05)**: validated against the union | — |
| `fxeq.band.${fxId}` | ui/FxEqPanel | numeric string | no | finite + 1..6 else 1; unbounded key namespace (RECORDED) | — |
| `pf-dock-v1` | ui/dockLayout | {height,slotA,slotB} | v1 | normalize + clamp; **real migration exists**: legacy `"fx"/"plugin"` → `"devices"` | remap |
| `pulse-forge.gesture-hints.v1` | ui/gestureHints | JSON record | v1 | try/catch → {} (verified) | — |
| `pulse-forge.install.dismissed.v1` / `pulse-forge.onboarding.done.v1` | ui prompts | ISO date strings | v1 | truthiness | — |
| `pf-publish-code` (session) | gallery publish | lz-string token | — | validated downstream on publish | take-semantics |
| `pf-handoff` / `pf-intent-prefill` / `pf-intent-regen` (session) | landing/handoff | JSON/strings | — | field-validated, corrupt → null | take-semantics |

Storage-blocked policy is uniform: try/catch everywhere, degrade to default
(best-effort never breaks a user path).

## 3. Export / share formats (11)

| Format | Marker/version | Import validation | Caps |
|---|---|---|---|
| Project `.kyx.json` (legacy `.pulseforge.json` importable) | `schemaVersion` in doc | shape gate → migrate (throws on future) → normalize | 10 MiB |
| Share code | **no prefix** (bare lz-string URI token); version = doc.schemaVersion | decode caps → parse → shape gate → normalize | 2 M chars / 8 M decompressed |
| Kit code | `PFKIT1:` | name ≤60, per-pad full clamp | ≤16 pads |
| Binds code | `PFBINDS1:` (PFBIND1) | `normalizePadKeyMap` | 16 slots |
| Theme code | `PFTHM1:` | preset whitelist + clamps | — |
| Pack code | `PFPACK1:` | per-part sanitizers; ≥1 part | 8 grooves / 16 scenes / 64 clips |
| MIDI `.mid` | `MThd`, format 1 written | format 2 + SMPTE rejected; truncated chunks tolerated as empty | VLQ ≤4 B |
| WAV | RIFF/WAVE, 16/24/32f | writer-only | 4 GB guard; seeded dither (byte-reproducible) |
| MP3 | raw LAME, no ID3 | — | fixed dither seeds (byte-reproducible) |
| Video | MediaRecorder mux | — | MP4 preferred else WebM |
| Scorepack `.scorepack` | ZIP; `score.json` `version:"1.0"` | no importer (interchange) | 24-bit WAVs inside |
| Zyvo `.kyxzyvo` | manifest `format:"com.kyx.zyvo-transfer"`, version 1 | no importer here ("keep in sync with VocalForge") | 1 GiB classic-ZIP bound |
| Favorites pack JSON | `{version:1, exportedAt, entries[]}` (same format from dice tray) | shallow `isValidLedgerEntry`; `key` unchecked cast (RECORDED) | 200 entries / 128 notes |

**RECORDED divergences:** client share cap (2 M) vs gallery server cap
(400 k chars) — a studio-valid code can be rejected at publish; the server's
`decodeShareCodeMeta` must agree with the studio (comment in-file). Share
code has no container prefix — adding one breaks every existing share, so it
stays; the version travels in `doc.schemaVersion`.

## 4. YDocAdapter — the second serialization path (top cross-platform risk)

`src/collab/YDocAdapter.ts` hand-maintains a Y.Doc ↔ ProjectDocument codec:
structured Y types for id-keyed entities (per-cell pattern rows, note
entities), **plain JSON blobs** for `generation/assist/phrasePlan`,
`pad.mod`, `fx.deviceState`, `velocityLayers`, `audioClips`,
`midi.*Maps`. Scalar mirror lists (`TRACK_SCALARS`, `PAD_SCALARS`) are
hand-duplicated — a new model field must be added in up to 4 places with no
compile-time tie. Three documented silent-loss episodes (audioClips,
generation/assist, master keys) attest the drift class.

**Drift pin (GOAL 05):** `tests/collab-ydoc-drift.test.ts` — a
compile-time-exhaustive `Record<keyof ProjectDocument, true>` key list (a
new model key breaks the test build), a rich round-trip through
`projectToYDoc → yDocToProject` asserting key-set preservation and deep
equality against the fixture, and per-key survival for master/track/pad
scalars. Extend the fixture when a domain is added.

## 5. Ownership map (who owns which schema)

| Domain | Owner | Evolves via |
|---|---|---|
| Project model (projects, snapshots, share codes, Y.Doc codec) | `src/project-model/schema.ts` (+ YDocAdapter for collab) | SCHEMA_VERSION + migrateProject + normalizeProject |
| Recovery/PCM binary | `src/persistence/RecordingRecoveryRepository.ts` + worklet cadence | structural validation (no version field) |
| Frozen audio | FreezeButton + `rendering/wav.ts` | WAV container self-describes |
| Presets (ultina/morph) | their repos + vendored parameter schemas | explicit schemaVersion stamps |
| Small stores (kits, grooves, presets, library, user samples) | their repos | unversioned; optional-field accretion |
| Web storage | per-feature modules | `-v1` suffix convention |
| Export containers | `src/export/*` | prefixed codes / manifest versions |

## 6. Riskiest schemas for cross-platform reproduction (ranked)

1. **YDocAdapter** — hand-dual-listed codec with a silent-loss history; drift pin landed (§4).
2. **projects / ProjectDocument** — explicit version that discriminates nothing; normalize-on-load means stored bytes can normalize differently across builds; non-reproducible ids. Mitigation path (NOT done — would be a real schema change): make normalize a pure function of (doc, schemaVersion) with per-version steps, bump SCHEMA_VERSION when shape breaks.
3. **recording-chunks + sessions** — raw planar Float32 with unversioned metadata carrying optional fields; all-or-nothing strict reads mean any chunking-contract change orphans takes. The PCM ref's `kind:"pcm-f32-planar-v1"` tag is the pattern to follow if chunking ever changes (write `pcm-f32-planar-v2`, read both).
4. **user-kits / groove-pool** — unversioned, no sanitize, ids non-reproducible; payload flows into the live project model. Pinned by the malformed-row matrix (schema-evolution tests).

## 7. Fixes taken in GOAL 05 + queue

**FIXED:** `pf:pluginMode` validated against its union (was a blind cast —
a garbage string became live state). Store-existence + upgrade-path +
future-version tests pinned (the v8 incident class). YDocAdapter drift pin
landed. AGENTS.md key-name correction (`kyx-onboarded` → the real
`pf-onboarded`).

**QUEUED (deliberately not done — would redesign stable formats):** share
code container prefix (breaks all existing shares); sanitizers for
kits/groove-pool rows (pin-first, add when a real writer bug appears);
ProjectDocument per-version migration ladder (only on the first breaking
shape change); gallery-cap divergence (server-side decision).
