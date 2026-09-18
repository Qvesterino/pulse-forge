# KYX — Current State Report

**Date of investigation:** 2026-09-18
**Method:** Read-only repository inspection (`D:\pulse-forge`, branch `main`, HEAD `258a342` + uncommitted working-tree changes). Every claim below is backed by a file path in the repository. No files were modified.

> **Naming note (important).** The product is called **KYX** (`index.html:11` `<title>KYX</title>`, `README.md` title, export filename suffix `.kyx.json` in `src/export/project-io.ts:16`, IndexedDB error strings in `src/persistence/db.ts:63`). The repository, npm package, and IndexedDB database are codenamed **pulse-forge** (`package.json` `"name": "pulse-forge"`, `src/persistence/db.ts:1`). Older docs and some code comments still say "Pulse Forge"; the legacy import suffix `.pulseforge.json` is still accepted (`src/export/project-io.ts:14-16`). "Qvester" is the umbrella ecosystem name used in `VISION.md` and `ARCHITECTURE.md` §93 ("Qvester Interoperability"). All three names refer to the same application. This report uses **KYX**.

---

## 1. Product Overview

KYX is a **browser-first, local-first electronic-music production workstation** — a hybrid of a groovebox, a step sequencer, a piano-roll DAW, and a sound-design tool. `index.html` describes it as "a full DAW in your browser. Step sequencer, synths, effects and arrangement. Works offline."

- **Type:** hybrid. Core interaction loop is a drum-machine/step-sequencer (pattern mode), but it also has a clip-based arrangement timeline (song mode), a piano roll, a full mixer with sends/returns/groups, 14 synth engines, 36 effect types (including three large "flagship" multi-effect plugins), offline rendering and multi-format export.
- **Architecture:** pure web app (Vite + React 18 + strict TypeScript, PWA with offline install via `vite-plugin-pwa` in `vite.config.ts`, update lifecycle in `src/sw-update.ts`). No desktop shell. A small optional Node server (`server/collab-server.mjs`) provides CRDT relay + a public gallery; the studio itself runs entirely client-side against IndexedDB.
- **Primary workflow:** open app → landing page (`src/landing/LandingPage.tsx`) → project browser (12 genre templates; `src/project-model/templates.ts`) → studio. In the studio: edit 16/32-step drum grid and/or piano-roll notes per track, apply presets/FX, play scenes (clip launcher semantics), arrange clips on the timeline, then export WAV/MP3/stems/scorepack/MIDI/video or share a link.
- **Designed primarily for:** beatmaking + composition at the core, with substantial sound design (synth/FX depth) and live performance features (pads, note repeat, macros, quantized scene launches, multi-user jam). It is explicitly *not* an attempt to clone Ableton/FL feature-for-feature (`Pulse Forge — Master Build Prompt.md:5`).
- **Maturity:** unusually high for a browser DAW. ~127k lines of application TypeScript, ~55k lines of tests across 282 test files, CI enforcing clean typecheck + unit tests + production build + release preflight (`.github/workflows/ci.yml`). The audio path is verified with real-Chromium browser tests (`scripts/verify-browser.mjs`, golden render/vector tests).

**What a user can actually do end-to-end today:** create a House/Techno/Trap/Ambient/UKG/… project from a template (each ships a working groove, instrument tracks, macros and often a pre-built arrangement), generate patterns from a text prompt ("dark rolling techno at 140") or the Dice tray, edit everything by hand, mix with real metering, master through limiter/clipper/LUFS metering, render the exact playback to WAV/MP3/stems, package a scorepack, export/import MIDI, and publish the beat to a public gallery or a share link that renders identically for anyone who opens it.

---

## 2. Current User Interface

UI shell: `src/ui/App.tsx` (1,299 lines). React function components; heavy panels are lazy-loaded. State enters components only via `useSyncExternalStore` hooks (`src/ui/context.ts`) or explicit props; components mutate exclusively through command factories + `store.execute(...)`.

Top-level surfaces (verified in `App.tsx:1147-1191` render tree):

| Surface | File | Purpose / data |
|---|---|---|
| **Landing page** | `src/landing/LandingPage.tsx` | Marketing/entry page with a live embed-rendered hero beat; "ENTER STUDIO" CTA. |
| **Project browser** | `src/ui/ProjectBrowser.tsx` | Continue-last-project card, project list (open/duplicate/rename/delete), 12-template grid, "import" (JSON file / share code). Reads/writes `ProjectRepository` (IndexedDB). |
| **TopBar** | `src/ui/TopBar.tsx` | Transport (play/stop), BPM, play-mode (pattern/song), loop IN/OUT, metronome/count-in/pre-roll, scene launcher trigger, master meter, save status, panel toggles, command palette (Ctrl+K). |
| **TrackTabs / RackStrip** | `src/ui/TrackTabs.tsx`, `src/ui/RackStrip.tsx` | Track selection + 16-pad drum rack per drum track (click = audition/rebind, pad colors, slice markers). |
| **Sequencer** | `src/ui/Sequencer.tsx` | 16/32-step grid, virtualized, per-track rows. Toggle steps, vertical drag velocity, shift-drag rectangle multi-select, right-click step editor (PROB / RATCHET / MICRO / p-locks, verified at `Sequencer.tsx:843-867`), remote collab cursors. Mutates `pattern.rows` + `pattern.stepMeta`. |
| **PianoRoll** | `src/ui/PianoRoll.tsx` | Melodic note editor for instrument tracks: draw/move/resize notes (pitch/start/duration ticks/velocity), slide notes, quantize, duplicate/split/glue (commands in `src/commands/commands.ts:1601-1978`). |
| **PatternBar** | `src/ui/PatternBar.tsx` | Pattern chips (create/duplicate/rename/reorder), groove drag controls (SWING / HUM·T / HUM·V), MUT/FILL variation buttons, pattern launch queueing. |
| **Inspector** | `src/ui/Inspector.tsx` | Per-track instrument parameter panel driven by `INSTRUMENT_DEFS[kind].params` metadata; embedded preset browser (genre/mood chips, favorites, save-as-user-preset). |
| **Bottom dock (8 panels)** | `src/ui/dockLayout.ts:1` | `mixer`, `fx`, `arr`, `mod`, `exp`, `midi`, `dice`, `intent` — two dockable slots + height. |
| **Mixer** | `src/ui/Mixer.tsx` | Channel strips (rename/volume/pan/mute/solo/delete/color/group), real peak meters, send knobs per return, return strips, master strip (IN/CEIL/LIMIT/CLIP/tape/M-S), group collapse. |
| **EffectRack / FxEqPanel / UltinaPanel / OzvenaPanel / KaskadaPanel** | `src/ui/EffectRack.tsx` + flagship panels | Per-track insert rack: add/remove/reorder/bypass, parameter editors; flagship plugins get full custom editors (EQ curve drag, spectral displays, A/B, presets). Also opens in `FloatingPlugin.tsx` windows. |
| **ArrangementPanel** | `src/ui/ArrangementPanel.tsx` | Song timeline: scene clips (move/resize/duplicate), audio clips (drag, split at playhead, trim, fades, warp/stretch), markers, arrangement transitions, tempo per scene, auto-arrange. |
| **ModPanel** | `src/ui/ModPanel.tsx` | Automation lanes, LFO/modulators (osc/random/step/envFollower), macro → target mappings, MIDI CC mappings. |
| **ExportPanel** | `src/ui/ExportPanel.tsx` | Master WAV (16/24/32-bit, 44.1/48 kHz), MP3 192/320, video (Reels/TikTok framing), grouped + per-track stems, SCOREPACK, MIDI export. Shows measured peak/true-peak/RMS/correlation after every render. |
| **MidiPanel** | `src/ui/MidiPanel.tsx` | Web MIDI device setup, drum note map, CC mappings, program change/bank/aftertouch, MIDI clock master/slave. |
| **DiceTray / IntentPanel** | `src/ui/DiceTray.tsx`, `src/ui/IntentPanel.tsx` | Generative surfaces (see §9): text prompt → intent; dice session with locks/favorites/jitter. |
| **Others** | `SceneLauncher`, `ScalePanel`, `SliceLab`, `GranularPanel`, `WavetablePanel`, `EnvEditor`, `MacroPerformanceBar`, `Goniometer`, `SpectrumAnalyzer`, `LoudnessHistory`, `LatencyCalibrationWizard`, `UndoHistoryPanel`, `Diagnostics`, `OnboardingTour`, `HelpOverlay`, `ThemePanel`, `CollabPanel`, `FreezeButton` | All present and wired; each has a dedicated test under `tests/ui/`. |
| **Gallery page** | `src/gallery/GalleryPage.tsx` + `galleryApi.ts` | Public beat feed (list/play/report/remix) served by the collab server's `/api/gallery`. |
| **Embed page** | `src/embed/EmbedApp.tsx` | `/embed/#p=<share-code>`: decodes a full project from the URL, renders it with the *same offline engine*, minimal play/seek chrome, "Open in KYX" hand-off. No IndexedDB, no services booted. |

All panels are functional; nothing in the shell is a stub. The panel-to-app communication is uniformly: read via `useDoc()` (reactive `ProjectDocument`), mutate via a command factory + `services.store.execute(command)`.

---

## 3. Audio Engine

**Central module:** `src/audio-engine/AudioEngine.ts` (4,548 lines, class `AudioEngine` at line 314). One `AudioContext` is created lazily on first user gesture and **shared across project switches** (`ensureContext()` at line 667; `openProject()` in `src/services.ts:265` reuses the core engine and calls `engine.setProject(doc)` which diffs the graph — `services.ts:398`).

**Graph topology (verified from node containers `AudioEngine.ts:125-167` and connect calls):**

```
drum/instrument voice ─► track.input (gain)
                        ─► [FX insert chain, EffectRuntime per instance]
                        ─► panner ─► gain ─► modAuto gain/pan ─► modMacro gain/pan
                        ├─► analyser (per-track metering)
                        └─► sends (per-return gain nodes)
group tracks: children ─► group.input ─► [group FX] ─► group pan/gain ─► master
returns: input ─► [return FX] ─► return gain ─► master
master: gain ─► [tape] ─► [M/S matrix] ─► soft-clipper ─► look-ahead limiter (worklet)
        ─► analyser ─► destination   (+ K-weighted LUFS meter branch, splitter L/R analysers)
```

**Scheduling strategy:** classic look-ahead. `src/scheduler/Scheduler.ts` runs a 25 ms `setInterval` with a 120 ms horizon against `AudioContext.currentTime` (`Scheduler.ts:102-103`), converting transport ticks (PPQ 480) to audio times through `Transport.timeAtTick`. The scheduler re-reads `store.doc` **every window**, so project edits apply within one window without any explicit push. Robustness features (all verified in code): AudioContext-state gating so a suspended tab cannot machine-gun bursts on resume (`Scheduler.ts:392-414`), failed-window skipping with observable stats (`Scheduler.ts:419-429`), quantized pattern launches committed mid-window with the window split at the boundary (`Scheduler.ts:504-570`), a piecewise tick→time map that pre-schedules scene-tempo changes exactly at the seam (`Scheduler.ts:160-166, 642-684`), loop wrap with event clamping, and lead-in (count-in + pre-roll) click scheduling.

**Playback clock:** `src/transport/Transport.ts` — anchor-based musical clock (`tickAt`/`timeAtTick`), position-preserving BPM changes, `setBpmAnchored` for zero-drift tempo seams, loop region, seek guards, `onGesture` hook used by collab transport sync.

**Musical event flow:**

```
user edit ─► command factory (pure doc→doc) ─► store.execute() ─► new ProjectDocument
      ─► store.onDocChanged ─► engine.setProject(doc) (graph diff) + transport/autoflush
playback: Scheduler.tick() every 25 ms ─► drumHitsInWindow()/noteEventsInWindow()
      (src/project-model/groove.ts, src/project-model/events.ts — SHARED with offline render)
      ─► engine.trigger()/noteOn()/triggerAudioClip() ─► voices/instrument runtimes ─► track chain ─► master ─► out
```

**Sample playback:** `SampleBank` (`src/sample-library/factory.ts`) maps asset-id → `AudioBuffer`. Drum pads support choke groups, pitch, slice regions (start/end/reverse/fades/loop — `resolveSlicePlayback` at `AudioEngine.ts:280`), per-pad synth voices, per-pad LFO (`PadMod`), velocity layers and round-robin on the sampler (`SampleLayer` in `src/project-model/types.ts:198`). Arrangement `AudioClip`s get time-stretch (grain-based, cached LRU), warp markers rendered in a worker (`src/audio-workers/warp-render.ts`), reverse, loop, fades, tempo-fit (`fitAudioClipTempo`).

**Synthesis:** 14 instrument runtimes behind the `InstrumentRuntime` interface (`src/instruments/types.ts:4`): `noteOn/noteOff/setParameter/syncBpm/panic/dispose` plus optional MPE `polyPressure`/`polyTimbre`. Voices are created per note with envelope-driven gain; polyphony is unbounded but bounded in practice by voice stealing/panic and one-shot source tracking (`oneShotSources`).

**Modulation:** project LFOs in 4 kinds (osc, random S&H/glide, step sequence, envelope follower — `src/project-model/types.ts:594-647`), 4 performance macros with mappings (source: macro/intensity/midiCC), scene intensity as a global modulation source (static + per-scene curve), per-step p-locks, MIDI CC → any `AutomationTarget`. Automation lanes target track gain/pan, FX params, instrument params.

**Latency:** user-calibratable offset — `LatencyCalibrationController` + wizard + probe worklet (`src/audio-engine/latencyCalibration.ts`, `src/audio-worklets/latency-probe-processor.js`); the measured `midiReferenceOffsetMs` is applied as the scheduler's `getScheduleOffsetSec()` (`services.ts:342`).

**Worklets:** 26 AudioWorklet processors in `src/audio-worklets/*-processor.js` plus 5 pre-bundled plugin worklets in `public/` (core, fxeq, ultina, ozvena, bitcrusher). A loader (`src/audio-worklets/loader.ts`) pre-loads exactly the modules a project uses; every worklet effect has a non-worklet fallback path and reports degraded status (`WORKLET_EFFECTS` map, `effectProcessorStatus` in `src/effects/registry.ts:90-127`; `engine.getDegradedFx()`).

**Offline rendering:** `src/rendering/renderer.ts:172 renderProject()` constructs an `OfflineAudioContext`, loads the same worklets, instantiates a **fresh `AudioEngine`** on it, and schedules with the *same* deterministic event-expansion modules (`groove.ts`, `events.ts`), the same tempo-map math (`buildTempoMap`), scene-intensity points, scene automation, and offline modulator sweeps. Live/export parity is an explicit, tested design goal (`tests/offline-parity.test.ts`, `tests/render-event-parity.test.ts`, `KNOWN_LIMITATIONS.md` documents the remaining ≤25 ms scene-boundary residuals).

**Verdict on timing infrastructure:** this is one of the most robust browser-audio scheduling stacks I have inspected — the known browser failure modes (tab suspension, device change, mid-window edits, tempo seams, loop wraps) are each individually handled and pinned by tests. The code is heavily annotated with defect IDs from dedicated audits (`prompts/01_COMMON/*`, `docs/` audit roadmaps).

---

## 4. Musical Data Model

Single source of truth: `ProjectDocument` in `src/project-model/types.ts:873-903`. **Pure, JSON-serializable data; no class instances, no node references.** `schemaVersion: 1`; loading paths run `normalizeProject` / `migrateProject` (`src/project-model/schema.ts`, 1,951 lines of sanitizers/clamps — the model is defensively normalized at every entry point: store construction, import, collab merge).

```ts
interface ProjectDocument {
  schemaVersion: number; id: ID; name: string;
  bpm: number;                      // clamped 20..300 (schema.ts MIN_BPM/MAX_BPM)
  timeSignature: TimeSignature;     // numerator/denominator
  key?: MusicalKey;                 // 12 roots × 9 scales = 108 combos (types.ts:749)
  tags?: string[];
  tracks: Track[];                  // DrumTrack | InstrumentTrack | GroupTrack
  patterns: Pattern[];
  activePatternId: ID;              // invariant: must resolve (types.ts:913-928 comment)
  scenes: Scene[];                  // patternId + intensity(+curve) + role + per-scene bpm + loop
  arrangement: Arrangement;         // clips: scene clips; audioClips: waveform clips; transitions
  markers: Marker[];                // drop/buildup/riser/impact/cue, absolute tick, optional clip link
  sceneAutomation: SceneAutomation[]; automation: AutomationLane[];  // point lists in ticks
  lfos: Lfo[]; macros: Macro[];     // modulators (4 kinds) + 4 performance macros
  returns: ReturnTrack[];           // send/return buses with FX chains
  master: MasterConfig;             // gain, ceiling, limiter, clipper, tape, M/S, LUFS target
  groove?: Partial<GrooveSettings>; // swing + humanize timing/velocity (project level)
  midi?: MidiConfig;                // Web MIDI in/out, clock, CC map, GM drum map, program map
  createdAt: string; updatedAt: string;
}

interface Pattern {
  id: ID; name: string; stepCount: number;             // 16 or 32
  rows: Record<padId, number[]>;                        // drum velocities per step (0 = off)
  notes: Record<trackId, NoteEvent[]>;                  // melodic notes in ticks
  stepMeta?: Record<padId, Record<step, StepMeta>>;     // probability, ratchet 1..8, microtiming ±, p-locks, amount
  phrasePlan?: PatternPhraseBar[];                      // multi-bar sections for Assist BUILD/FILL
  assist?: PatternAssist;                               // surgical-transform provenance
  generation?: PatternGeneration;                       // full AI recipe: seed, hashes, ranker, quality
}

interface NoteEvent { id; pitch; start; duration; velocity; slide?; locks? }   // start/duration in ticks
interface AudioClip  { trackId; bufferId; startBar; lengthBars; trimStart/End; gain; fadeIn/Out;
                       stretchRate; stretchMode: "resample"|"stretch"; warpMarkers?; loop; reverse }
```

Key observations:

- **Time** is integer ticks (PPQ 480, `STEP_TICKS = 120` = 1/16). Velocity 0..1, probability 0..1, ratchet 1..8, microtiming −1..+1 (fraction of a step). Swing/humanize are *project-level* and applied deterministically at schedule time, not stored per event.
- **Two clip worlds:** scene clips (`ArrangementClip` → `Scene` → `Pattern`) and audio clips (`AudioClip` → stored buffer). Both live on one timeline measured in bars.
- **Provenance is first-class:** every AI-generated pattern carries a full reproducibility recipe (`PatternGeneration`, `types.ts:387-431`) including seed, content hashes, the normalized intent snapshot, ranker version/mode, and quality diagnostics.
- **Stability:** the model is mature and heavily guarded (`tests/project-invariants.test.ts`, `tests/persistence/round-trip-integrity.test.ts`, `tests/state-store-adversarial.test.ts`). Fields added later are optional with normalization defaults, so old projects keep loading (schema v1 has never broken).
- **Mappable to another DAW:** yes — the model is a superset of a typical session (tracks/channels, clips, patterns, notes, automation, tempo map via per-scene BPM, markers, sends). The main KYX-specific concepts an adapter must interpret are: scenes-with-intensity, per-pad step rows (vs notes), stepMeta performance data, and p-locks.

---

## 5. State Management

No Redux/Zustand. Hand-rolled, framework-free stores consumed via React 18 `useSyncExternalStore`.

| Store | File | Role |
|---|---|---|
| **ProjectStore** | `src/store/ProjectStore.ts` | The plain-document authority. Holds `doc_`, undo/redo stacks (cap 256), command coalescing (1 s window, e.g. CC sweeps), history diffs via `computeDocDelta` (`src/commands/docDelta.ts`), `replaceDoc` for project switches, save status. Mutations only through `execute/undo/redo/replaceDoc`. |
| **YDocStore** | `src/collab/YDocStore.ts` | Drop-in replacement with the *same public surface* backed by a Yjs `Y.Doc`; per-user undo via `Y.UndoManager`, role gating (`jamRoles.ts`), normalization of remote merges. Collab is loaded lazily only when a session starts (`services.ts:279-299`). |
| **Transport** | `src/transport/Transport.ts` | Musical clock (not persisted except BPM which lives in the doc). |
| **SelectionStore / ToolStore** | `src/store/SelectionStore.ts`, `src/store/ToolStore.ts` | UI-only (selection, active tool). |
| **AudioEngine state** | `AudioEngine.ts` | Derived cache: node graphs, instrument runtimes, FX runtimes, LFO runtimes, meter rings, stretch/warp caches. Rebuilt by diffing on every `setProject`. Holds **no** musical truth. |
| **Repositories** | `src/persistence/*Repository.ts` | IndexedDB-backed side data (projects, presets, samples, kits, snapshots). |

**Boundaries (verified):**

- `store.onDocChanged` is the single fan-out point: `services.ts:667-676` wires it to `engine.setProject(doc)`, `transport.setBpm`, autosave. The scheduler reads `store.doc` live per window. The UI reads via `useDoc()`.
- **Musical/project state is fully independent of the UI.** Every mutation goes through pure command factories (`(doc, …) → Command`) that import nothing from `src/ui`. An integration can construct a `ProjectDocument` and execute commands headlessly — this is exactly what the test suite does (e.g. `tests/commands.test.ts` runs commands with no React mounted), and what `scripts/make-promo-beat.mjs` does in Node.
- The audio engine never mutates the doc (one deliberate exception: the scheduler's quantized pattern launch, which routes back through `store.execute(setActivePattern(...))` — `services.ts:362`).

**Conclusion for external integration:** an external module can drive the whole model through `store` + command factories with zero React involvement. The `ProjectStore | YDocStore` union means an integration must target the shared surface (getDoc/execute/undo/redo/subscribe/replaceDoc), which is stable and tested for both.

---

## 6. Sequencer and Composition System

Verified implemented (all backed by `src/commands/commands.ts` and unit tests):

- **Patterns:** create/duplicate/rename/delete/reorder/copy-paste/clear; 16- and 32-step lengths with content preservation (`setPatternLength`); `activePatternId` invariant enforced everywhere.
- **Step sequencing (drums):** per-pad velocity rows; toggle, paint, vertical velocity drag, rectangle multi-select, batch velocity scaling (`setStepsVelocity`), per-step PROB (0..1, deterministic seeded roll), RATCHET (1..8 retriggers with velocity decay), MICROTIMING (±1 step fraction), per-step `amount` (ghost vs accent), **p-locks** — Elektron-style per-step absolute overrides for pitch/gain/pan/cutoff/sampleStart/length/ratio (`StepMeta`, `STEP_LOCK_DEFS` in `types.ts:326-356`).
- **Note sequencing (melodic):** full piano roll per instrument track — draw/move/resize/delete, multi-select, quantize to 1/8/1/16/1/32 (`quantizeNotes`), duplicate, split, glue, nudge, velocity batch, **slide notes** (FL-style portamento with cross-loop glide origin — `events.ts:31-38`).
- **Groove:** project-level swing (0–100% toward triplet 16ths) + humanize timing/velocity (seeded); deterministic module shared by live scheduler and offline render (`src/project-model/groove.ts` — verified: exports groove exactly like playback).
- **Multi-track composition:** drum tracks + instrument tracks + group tracks; pattern rows auto-cover all tracks; 12 genre templates ship complete multi-track grooves.
- **Scale/key:** 108 musical keys, scale panel, `snapNotesToScale` (`src/midi/creative.ts:242`), generated melodies are scale-constrained (`src/ai/melodic.ts`).
- **Variation/generative:** `mutatePattern` (MUT — seeded velocity jitter, ghost notes, dropped weak hits, microtiming), `createFill` (FILL — explicit fill with rising snare roll), `duplicateSceneAsVariation`, Assist pipeline (`src/assist/` — vary/build/replace/fill with provenance), full AI generation (§9).
- **Arrangement:** scene clips (move/resize/duplicate/loop), **auto-arrange** (`autoArrangeSong` — builds an intro/build/drop/break/outro arrangement from existing scenes, `commands.ts:3664`), arrangement skeleton, arrangement transitions (fill/riser/impact/drop/break, quantized 1–4 bars), `duplicateTimeRange` / `consolidateTimeRange` region ops, audio-clip slicing at transients, bounce stems→audio clip, consolidate clips.
- **Performance:** quantized scene launches (queued to next bar, committed at the boundary), pattern launch queueing, capture-last-take ring (Ableton-style, `src/arrangement/capture.ts`, 2048-event FIFO fed by the scheduler and live hits), note repeat pad mode (`src/audio-engine/NoteRepeat.ts`), MIDI creative tools (chord stamps with voicings/strum, arpeggiator up/down/up-down/random, euclidean fills, bassline generator, humanize, gate, reverse/invert/mirror/retrograde/cluster/halve/double — `src/midi/creative.ts`, all applied as undoable commands via `applyMidiCreativeTool`, `commands.ts:2028`).

---

## 7. Instruments and Sound Generation

Registry: `src/instruments/registry.ts` (5,190 lines), `INSTRUMENT_DEFS: Record<InstrumentKind, InstrumentDefinition>` at line 5144 — **14 instruments**, each a metadata table (`ParamDef[]` with ranges/defaults/formats — this metadata directly drives the Inspector UI and parameter clamping) plus a `factory(ctx, track, env) → InstrumentRuntime`:

| Kind | Architecture (from implementation) |
|---|---|
| `sampler` | Single sample or **velocity layers / round-robin** (`SampleLayer` with velocity + key zones), root note, keytrack, loop with crossfade, reverse, time-stretch option, filter+envelope |
| `analog` | 2 osc + sub + noise, state-variable filter w/ env + keytrack, unison up to 8× with spread, LFO with sync, full ADSR with shapes/loop/hold/delay |
| `bass` | Sub/body/punch/grit model with glide, distortion types, unison, SVF |
| `808` | Pitch-dropping sine bass: decay, P-DROP, click, drive, glide, distortion, gate, mono |
| `texture` | Granular/scenic texture engine (color/motion/space/density/chaos/drift/diffuse, sync delay) |
| `wavetable` | Morphing wavetable voice (worklet-backed `wtvoice-processor.js`), tables in `src/instruments/wavetables.ts`, unison, SVF |
| `granular` | Grain engine (position/size/rate/spread/sync) over a sample, worklet-backed (`granular-voice-processor.js`) |
| `keys`, `fm`, `pluck`, `logdrum`, `spectral`, `vocalchop`, `drumsynth` | Additional engines (FM operator pair, plucked string model, log-drum, spectral resynth, vocal-chop slicer, synthetic drum voice) — all with parameter tables and runtimes; covered by `tests/instruments.test.ts`, `tests/ui/new-instruments.test.tsx` |

- **Presets:** 199 factory preset objects in `src/presets/factory.ts` (README claims 172 — count drift, see §"Docs vs code"), tagged genre (House/Techno/Trap/Ambient/Score) + mood, with a "similar presets" feature (`src/presets/similar.ts`), favorites/recents in IndexedDB, audio-quality gate for presets (`src/presets/audioQuality.ts`). User presets persist via `PresetRepository`.
- **Drum content:** default 16-pad kit (`makeKit` in `schema.ts`); **procedural factory bank** — 41 asset ids synthesized offline at boot (`FACTORY_ASSETS` in `src/sample-library/manifest.ts`, rendered in `src/sample-library/factory.ts`) with 7 curated recorded WAVs progressively overriding them (`src/sample-library/curated.ts`, `public/samples/`); per-pad synth voices (hat/clap/perc/cowbell/kick/snare) needing no sample; velocity layers (`src/sample-library/velocity-layers.ts`); user kits saved to IndexedDB (`KitRepository`), shareable as kit codes.
- **Sample import:** drag-and-drop (`DropZone`) → decoded into `UserSampleRepository` (metadata + audio blobs in IndexedDB, restored on boot); auto-mapping chops (`src/samples/autoMap.ts`); transient-based slicing (`SliceLab` UI, onset detector worker); **Freesound CC0 search** with a user-supplied API token (`src/samples/freesound.ts` — the only external audio API integration in the codebase).

---

## 8. Audio Effects and Mixing

**36 effect types**, all registered in `EFFECT_DEFS` (`src/effects/registry.ts:3253-3290`), each with parameter metadata, defaults, and a runtime factory. Placement: **track-level inserts** (drum/instrument/group), **return-bus inserts** (send/return, default two returns: Reverb, Delay), and **master** (clipper + look-ahead limiter + optional tape + M/S). Per-instance bypass, reorder, step-sequenced gating (`stepGate` with `steps` array in the doc), A/B snapshots via `deviceState` blobs.

Groups (all verified in `src/effects/registry.ts` + `src/audio-worklets/`):

- **Tone/EQ:** 3-band EQ, M/S EQ, SVF filter, vowel filter, multiband, **PRISM/FXEQ** (flagship: band-based EQ+dynamics+saturation+modulation plugin with its own worklet, presets, crossover engine, command history — `src/effects/fxeq-core/`, ~30 files).
- **Dynamics:** compressor, sidechain (with cross-track sidechain feed via `sidechainTrackId`), gate, transient shaper, limiter (true-peak look-ahead worklet — `tests/aliasing-truepeak.test.ts`), drumBuss, bassBuss, utility.
- **Character:** saturation, tape saturation, clipper, distortion, bitcrusher, **Ultina** (flagship mastering plugin: module graph of eq/comp/clipper/exciter/transient/unmask/sculptor/density/phase modules, LUFS metering, mix assistant, target matching, factory presets — `src/effects/ultina-core/`, worklet + analysis worker + automation).
- **Space:** convolution-style reverb, delay (+stock delay with sync divisions + ping-pong), **Ozvena** (flagship reverb: multi-engine — convolution/hall/plate-chamber/reflections — with masking meter, per-frequency decay network, factory IRs, its own worklet; ADR `docs/adr/0007-ozvena-per-frequency-decay-network.md`), shimmer.
- **Movement:** chorus, phaser, flanger, tremolo, autowah, stutter, comb, step gate, **Kaskada** (spectral ducking/unmask delay hybrid with drag-EQ display — `src/audio-worklets/kaskada-processor.js`, recent commits), ducking delay, pump (tempo-synced volume shaping).

**Mixer architecture:** per-track strip (gain/pan/mute/solo/group/color), group tracks with collapsed nesting, solo-is-global + pad-solo-per-track, post-fader sends to returns, return strips with gain + FX, master strip with IN/CEIL/LIMIT/CLIP/tape/M-S/LUFS target. Metering: per-track Analysers, stereo master L/R with correlation, K-weighted LUFS with history, goniometer, spectrum analyser, per-FX meters on demand. Batch operations (`tests/mixer-batch.test.ts`).

Reusability: the `EffectRuntime` + `EffectDefinition` contract (`src/effects/types.ts`) is uniform — the same definition drives UI metadata, live runtime, and offline render. The three flagship plugins are also *vendored cores* kept in sync with an upstream plugin repo (`scripts/vendor-*.mjs`, golden-vector tests), i.e. they are genuine plugin-grade DSP, not toy chains.

---

## 9. AI / Intent / Generative Features

This is a major, heavily engineered subsystem — not a demo. Verified breakdown:

### Fully implemented
- **Rule/statistical generation core** (`src/ai/`): curated groove libraries for 4 genres × styles (`src/ai/grooves/*.ts` with drum + melodic reference data), **Markov chain** drum generation with velocity-level states (`src/ai/markov.ts`), melodic generator for bass/chords/lead constrained to the project key (`src/ai/melodic.ts`), quality gates (style distance, syncopation, anchor coverage, motif repetition — `src/ai/quality.ts`, `style-quality.ts`), adversarial-correctness tests (`tests/ai-correctness.test.ts`, `tests/ai-adversarial.test.ts`, golden baselines `tests/fixtures/ai-baseline.*`).
- **Intent pipeline** (`src/intent/`): `IntentInput` (untrusted) → `normalizeIntent` → `IntentSpec` (versioned, hashable, serializable contract, `intent/types.ts:25`) → `planGeneration` (role plans, sub-seeds, candidate seeds) → `localDeterministicProvider` → quality gate (accepted / repaired / fallback / rejected) → `Pattern` with full provenance. **Callable headlessly and synchronously**: `generateLocalResult(doc, input)` (`src/intent/pipeline.ts:25`).
- **Natural-language prompt parser** (`src/intent/text-parser.ts`): deterministic keyword extraction of genre/style/energy/density/complexity/variation/BPM/roles from text like "dark rolling techno at 140" — no network, no RNG.
- **Text → arrangement:** `src/intent/arrangeWords.ts` (403 lines, tested) maps scene words to arrangement skeletons.
- **ONNX intent ranker** (`src/ai/ranking/`): a real trained model — 54 features, MLP 64/32/16 (`public/models/intent-ranker-v1.onnx` + manifest with training metrics: val pairwise accuracy 0.80 vs heuristic, golden verdict "ready-for-active"), runs in a lazy Web Worker via `onnxruntime-web` with timeouts, circuit breaker, and heuristic fallback; modes off/shadow/active with provenance recorded on the pattern (`ranker` field in `PatternGeneration`). Training pipeline scripted in npm (`ranker:train`, `scripts/generate-intent-ranker-dataset.mts`, `scripts/train-intent-ranker.py`).
- **Dice tray** (`src/intent/dice.ts`, `src/ui/DiceTray.tsx`, `DiceContext.tsx`): session-based generate-and-jump workflow with per-axis **locks**, favorites, jitter, kit selection; `applyDiceLocks` merges locked regions of the previous pattern into the new one.
- **Assist transforms** (`src/assist/`): surgical vary/build/replace/fill operations with content-hash provenance written into the pattern.
- **MUT/FILL**, **auto-arrange**, **duplicate-scene-as-variation**, **MIDI creative tools** (chords/arps/euclidean/bassline — see §6).
- **AI bandmate** (`src/collab/bandmate.ts`): in jam sessions an AI drummer listens to performed notes (call & response) and generates into the shared doc.

### Partially implemented
- The ranker defaults to `"active"` (`ranker-client.ts:24`) but its own manifest notes val top-1 agreement with the heuristic is only 0.6 — the heuristic gates and repairs still dominate outcomes; the model re-ranks candidates rather than generating.

### Stub/prototype
- None found in this area — earlier-phase stubs were replaced by the real pipeline.

### Documentation/planned only
- `docs/intent-engine-roadmap.md`, `docs/intent-engine-ai-ranker-goal.md`, `.agent/plans/deep-dice-engine.md` — forward-looking plans; the implemented state already covers most of the near-term items.

**Intent → project flow:** `text prompt / sliders / dice` → `IntentSpec` (hashed) → candidate patterns (N seeds) → quality gate + ranker → winning `Pattern` (+`PatternGeneration` provenance) → command factory applies it (new or replace mode, optionally per-role and per-target-track, optionally also groove settings and BPM from the intent range) → standard undoable store mutation. No black boxes outside the deterministic local provider.

---

## 10. Project Persistence

- **IndexedDB** database `pulse-forge`, version 10, **11 object stores** (`src/persistence/db.ts`): projects, meta, presets, library (favorites/recent), user-samples (+ separate audio-blob store), frozen-audio, user-kits, groove-pool, project-snapshots (+ index), ultina-presets.
- **Autosave:** debounced 800 ms with a 5 s / 50-arm max-defer ceiling (`src/persistence/autosave-debouncer.ts`, wired at `services.ts:660-676`), revision-capture against racing edits, flush on `visibilitychange`/`pagehide`/`beforeunload` (`src/persistence/save-lifecycle.ts`), status indicator with retry.
- **Snapshots:** one at session start + daily, full-document copies pruned to newest 20 (`SnapshotRepository`, `services.ts:302-322`).
- **Simplified project JSON** — the exported file *is* the `ProjectDocument` of §4 (pretty-printed): `{"schemaVersion":1,"id":"…","name":"…","bpm":124,"tracks":[…],"patterns":[…],"scenes":[…],"arrangement":{…},"master":{…},…}`. Export as `<name>.kyx.json`; import validates shape (`validateProjectShape`) then migrates + normalizes; 10 MB import ceiling (`src/export/project-io.ts`).
- **Programmatic safety:** yes — round-trip integrity is explicitly tested (`tests/persistence/round-trip-integrity.test.ts`, `tests/export/project-io.test.ts`), and every read path funnels through `normalizeProject`. Share codes (lz-string URI tokens) additionally enforce decompression-bomb caps (`src/export/shareCode.ts:18-20`).
- Collab rooms live in server memory (Y.Doc per room, `server/collab-server.mjs:409`); the **gallery persists to `gallery.json`** on the server. `y-indexeddb` is a declared dependency but is not imported anywhere in `src/collab` (offline CRDT persistence is currently not wired — the plain project store covers local durability).

---

## 11. Import / Export (genuinely implemented)

| Direction | Format | Implementation |
|---|---|---|
| Export | **WAV master** 16/24/32-bit float/PCM, 44.1/48 kHz, deterministic dither for 16-bit (`src/rendering/wav.ts`, `src/export/quantize.ts`) + measured peak/true-peak/RMS/correlation readout | ✅ |
| Export | **MP3** 192/320 via `@breezystack/lamejs`, lazily fetched (`src/export/mp3.ts`) | ✅ |
| Export | **Stems** — grouped Drums/Bass/Music (`src/rendering/stems.ts`) + one-stem-per-track | ✅ |
| Export | **SCOREPACK** (`.scorepack` = ZIP): master WAV + stems + marker cue WAVs + `score.json` + `markers.json` + `automation.json` + `intensity.json` + README (`src/export/scorepack.ts`, hand-written ZIP `src/export/zip.ts`) | ✅ — note `ARCHITECTURE.md` §94 still labels this "potential future structure"; **the code is implemented and tested** (`tests/scorepack.test.ts`) |
| Export | **MIDI** — active pattern as format-1 SMF, drums on ch 10 (`src/midi/midiFile.ts` hand-written SMF writer, `src/midi/midiProject.ts:215`) | ✅ |
| Export | **Video** — MediaRecorder render of the waveform + audio, Reels/TikTok framing (`src/export/video.ts`) | ✅ (codec-granularity caveats documented) |
| Export | **Share code / embed link** — whole project compressed into URL token; `/embed` renders it | ✅ |
| Export | Project JSON, kit codes, pack codes, theme codes, keybind codes (`src/export/*.ts`) | ✅ |
| Import | Project JSON (`.kyx.json`, legacy `.pulseforge.json`), share-code URLs (`?import=`), MIDI files (full parser → `importMidiCommand` creates tracks/notes, `midiProject.ts:82`), audio files (user samples), Freesound search, kit/pack/theme/bind codes | ✅ |

---

## 12. External Integration Surface

This is where KYX is unusually well-prepared. The reusable boundaries that already exist:

1. **Serialization layer** — `ProjectDocument` is plain JSON; `encodeShareCode`/`decodeShareCode`, `exportProject`/`importProject`, and `validateProjectShape`+`migrateProject`+`normalizeProject` give lossless, validated transport today.
2. **Command system** — ~150 pure command factories in `src/commands/commands.ts` (`(doc, args) → Command` with `execute/undo`). This is a de-facto command API covering: tempo (`setBpm:172`), tracks (`createDrumTrack:1096`, `createInstrumentTrack:1104`, `createGroupTrack:1111`, `deleteTrack:1178`, `duplicateTrack:1222`, `setTrackParams:436`), patterns (`createPattern:465`, `duplicatePattern:492`, `setPatternLength:619`, `clearPattern:669`), notes (`addNote:1601`, `moveNote:1617`, `deleteNote:1699`, `quantizeNotes:1742`, …), instruments (`setInstrumentParam:2204`, `applyInstrumentPreset:2266`), effects (`addEffect:4339`, `removeEffect:4372`, `setEffectParam:4421`, `toggleEffectBypass:4486`, `moveEffect:4514`), scenes/clips/arrangement, automation, LFOs, macros, markers, master config.
3. **Generative API** — `generateLocalResult(doc, intentInput)` (`src/intent/pipeline.ts`) is a pure function from (project, intent) → validated pattern + diagnostics + provenance. An external service can call it in Node or browser without any UI.
4. **Headless engine** — `AudioEngine` runs on any `BaseAudioContext` including `OfflineAudioContext` (the whole export suite proves it); `scripts/make-promo-beat.mjs` already drives the pipeline from Node.
5. **Reactive notification** — `store.subscribe()` (fine for UI) and `store.onDocChanged(doc)` (whole-document callback on every mutation, `ProjectStore.ts:45`). The scheduler proves an external consumer can live off `store.doc` reads with no push at all.
6. **Live network surface** — the collab stack is a real-time external integration that already works: a `YDocStore` over `y-websocket` rooms, shared transport pulses, role-based command gating. Any CRDT client speaking the Yjs protocol could join a room.

### Could an external module currently…

| Capability | Answer | How |
|---|---|---|
| Read the KYX project | **Yes** | `store.getDoc()` in-process, or decode a share code / import the JSON file out-of-process. |
| Enumerate tracks / inspect notes / patterns / instruments / effects | **Yes** | Plain field access on the doc (`doc.tracks`, `pattern.rows/notes/stepMeta`, `track.params`, `track.effects`); pure helpers exist (`drumTracksOf`, `instrumentTracksOf`, `activeTrackNotes` in schema.ts/commands.ts). |
| Change tempo | **Yes** | `setBpm(doc, 140)` → `store.execute`. Transport follows via `onDocChanged`. |
| Create tracks / patterns / insert notes | **Yes** | Command factories above; every one is undoable and schema-normalized. |
| Change instrument / effect parameters | **Yes** | `setInstrumentParam` / `setEffectParam` (clamped against the same metadata tables the UI uses). |
| Do any of the above **from a separate process/device against a running studio** | **No dedicated API** | There is no HTTP/RPC/PostMessage control API for the studio. The only live external write path is joining a collab room as a Yjs client (full CRDT access, gated by jam roles), or shipping code that runs in-page. This is the one seam that would need to be built. |

**Architectural note:** nothing *requires* going through React components; the store boundary is real and tested. But there is **no fine-grained change feed** — observers see "the doc changed", not "note X was added" (deltas can be computed via `computeDocDelta`, as the history panel does, at O(doc) cost).

---

## 13. Event / Change Notification System

- **`ProjectStore.subscribe(listener)`** — coalesced tick notifications (React `useSyncExternalStore` compatible; used by every panel).
- **`store.onDocChanged(doc)`** — single whole-document callback per mutation (`services.ts:667`). This is the integration-grade hook; it fires for local commands, undo/redo, and remote collab merges alike.
- **`Scheduler.subscribe`**, **`PlaybackController.subscribe`**, **`LatencyCalibrationController.subscribe`**, **library/capture stores** — additional scoped observables.
- **`Transport.onGesture`** — fires on every user-visible transport change; consumed by collab transport sync (`services.ts:431`).
- **`scheduler.pendingPatternId`** + scheduler listeners — UI-visible queued-launch state.
- **Yjs observers** on the Y.Doc in collab mode (remote merges re-project and re-notify through the same `onDocChanged`).
- **Reliability:** high. Every mutation path (execute/undo/redo/coalesce/replaceDoc) funnels through one `afterMutation()` that both emits and calls `onDocChanged` (`ProjectStore.ts:267-271`). There is **no per-entity diff event stream**; consumers either re-read the doc (cheap reference check + derived caches exist in scheduler/engine) or compute a delta with `computeDocDelta`.

---

## 14. Audio Tool / DAW Interoperability

- **No reference to Audiotool anywhere** (searched `src/`, `docs/`, root `.md`, `server/`). No WebMIDI-to-Audiotool, no Audiotool API client, no mention in roadmaps.
- **Existing interchange assets relevant to any DAW integration:**
  - MIDI: full import (multi-track → command), export (SMF format-1), Web MIDI in/out with clock master/slave (`src/midi/`), MPE support (per-note pressure/timbre in runtimes), GM drum mapping, program change/bank select.
  - SCOREPACK: self-describing ZIP with `score.json` (tempo map, scene timing), `markers.json`, `automation.json`, `intensity.json` + 24-bit WAVs — designed by the author as a *transport format* ("The package should be a transport format. Not an internal runtime dependency." — `ARCHITECTURE.md` §94).
  - Share codes/embed URLs: lossless project transport with zero backend.
  - `ARCHITECTURE.md` §93 "Qvester Interoperability" prescribes exactly this direction: exchange via explicit schemas (BPM, markers, stems, intensity, automation, scene timing), no direct runtime coupling. `VISION.md:117` states "Designed for interoperability with other Qvester applications."
  - Docs reject full Ableton-warp parity as a goal (`FEATURES.md:1911`), yet the code implements a scoped warp/stretch system (`warpMarkers`, `phase-vocoder.ts`, `time-stretch.ts`) sufficient for beat-level fit.
- **What would help a DAW integration:** the typed project model + command layer + scorepack + share codes all exist. **What is missing:** any Audiotool-specific connector, an OAuth/API client scaffold, and a fine-grained change feed.

---

## 15. Codebase Architecture

```text
D:\pulse-forge\
├─ src/
│  ├─ project-model/    # THE domain model: types.ts, schema.ts (validate/normalize/migrate),
│  │                    # groove.ts + events.ts (deterministic event expansion, shared live/offline),
│  │                    # scales, intensity, markers, modulators, templates
│  ├─ commands/         # ~150 pure command factories + undo; Y.Doc helpers via bridge
│  ├─ store/            # ProjectStore (authority), SelectionStore, ToolStore (UI-only)
│  ├─ transport/        # Transport tick clock
│  ├─ scheduler/        # 25 ms lookahead Scheduler (pattern+song, tempo seams, launches)
│  ├─ audio-engine/     # AudioEngine (graph), synth-voices, recorder, time-stretch, phase-vocoder,
│  │                    # latencyCalibration, metering, NoteRepeat, GhostPreviewPlayer
│  ├─ audio-worklets/   # 26 worklet processors + typed node wrappers + loader
│  ├─ effects/          # registry (36 effects) + 3 vendored flagship cores (fxeq, ultina, ozvena)
│  │                    # + kaskada; each core = pure DSP modules + worklet entry
│  ├─ instruments/      # registry (14 instruments), wavetables, modmatrix, envelope
│  ├─ ai/ + intent/ + assist/   # generative stack (see §9)
│  ├─ rendering/        # offline renderer, wav writer, stems, bounce, track-renderer
│  ├─ export/           # mp3, zip, scorepack, share/kit/pack/theme/binds codes, video, quantize
│  ├─ persistence/      # IndexedDB repos (projects/presets/library/samples/kits/snapshots…), autosave
│  ├─ collab/           # YDocStore, CollabSession (y-websocket), transportSync, jamRoles, bandmate
│  ├─ midi/             # SMF parse/write, Web MIDI in/out, clock, creative tools
│  ├─ ui/               # React app (60+ components; App.tsx shell + dock panels)
│  ├─ gallery/ embed/ landing/   # public feed UI, /embed player, entry page
│  ├─ services.ts       # composition root: CoreServices + openProject() wiring everything
│  └─ audio-workers/    # warp render, onset detector, IR generator workers
├─ server/collab-server.mjs   # y-websocket relay (in-memory rooms) + gallery API (gallery.json)
├─ tests/               # 282 vitest files (~55k LOC) incl. Playwright e2e (5 specs)
├─ docs/ (ADR 0001-0009, roadmaps) + ARCHITECTURE.md (97 sections) + FEATURES.md
└─ public/              # worklet bundles, factory samples, ONNX model + ORT wasm
```

**The 15 files that matter most** (in dependency order):

1. `src/project-model/types.ts` — the entire musical data model.
2. `src/project-model/schema.ts` — validation/normalization/migration; model integrity lives here.
3. `src/project-model/groove.ts` + `src/project-model/events.ts` — deterministic step/note expansion shared by live and offline paths (the live/export parity guarantee).
4. `src/commands/commands.ts` — every mutation as a pure undoable command (de-facto API).
5. `src/store/ProjectStore.ts` — document authority, undo/redo, notification.
6. `src/transport/Transport.ts` — musical time.
7. `src/scheduler/Scheduler.ts` — the playback brain.
8. `src/audio-engine/AudioEngine.ts` — the audio graph and runtime diffing.
9. `src/services.ts` — composition root; read this to see how everything is wired.
10. `src/instruments/registry.ts` — instrument metadata + factories.
11. `src/effects/registry.ts` — effect metadata + factories + fallback policy.
12. `src/intent/pipeline.ts` (+ `types.ts`, `text-parser.ts`) — the generative entry point.
13. `src/rendering/renderer.ts` — offline render = export correctness.
14. `src/export/scorepack.ts` + `src/export/shareCode.ts` — the interchange artifacts.
15. `src/ui/context.ts` — proof that UI is a thin subscriber over the services/store layer.

---

## 16. Architectural Strengths (code-supported)

- **Clean, versioned, serializable project model** with defensive normalization at every entry point and an explicit documented invariant policy (`types.ts:913`).
- **True UI/audio decoupling:** commands are pure functions; the engine consumes immutable docs; React only subscribes. Headless operation is proven by the test suite and Node scripts.
- **Deterministic, shared scheduling core** between realtime and offline — the rarest and most valuable property for export fidelity and reproducibility (content hashes, seeds, golden render tests).
- **Command layer with undo/redo, coalescing, history diffs, and a collab dual-implementation** behind one interface.
- **Provenance-first generative stack:** every generated pattern records seed/hashes/intent/ranker/quality — reproducible and auditable.
- **Plugin-grade effect architecture** with metadata-driven UI, worklet DSP + graceful fallbacks, golden-vector tests for vendored cores.
- **Strong TypeScript** throughout (strict, no `any` outside collab bridges), 282 test files, CI with typecheck + tests + build + release preflight, extensive ADRs.
- **Battle-tested browser lifecycle handling** (context suspension, tab hide, device change, close-race guards) — the code reads like the output of the dedicated audit prompts it contains.

---

## 17. Architectural Risks (with practical consequences)

- **Whole-doc change granularity.** `onDocChanged` fires per mutation with the full doc; consumers must diff themselves. Consequence: an integration wanting "note added" events must compute deltas (`computeDocDelta`) or re-derive; very chatty external syncs would be O(doc) per event.
- **Monolithic hotspots.** `commands.ts` (5,776 lines), `AudioEngine.ts` (4,548), `instruments/registry.ts` (5,190), `effects/registry.ts` (3,474). Consequence: merge conflicts and review cost; also `AudioEngine.setProject` re-diffs the entire doc on every mutation — fine today (reference-equality fast paths exist in the scheduler), but an integration issuing hundreds of micro-commands per second (e.g. streaming AI edits) would amplify this cost.
- **Two store implementations to keep in lockstep** (`ProjectStore` vs `YDocStore`). Tests pin parity (`tests/collab-contract-parity.test.ts`), but a new integration feature touching the store surface must be implemented twice or fail in collab mode.
- **No external runtime control API.** Driving a *running* studio from outside the page currently means joining the Yjs room (heavy, protocol-level) or in-page code. Consequence: an Audiotool-side connector cannot simply REST-call into KYX today.
- **IDs are runtime-generated strings** (`uid()` — `src/shared/ids.ts`). Stable within a project's lifetime and persisted, but there is no namespacing/global uniqueness contract for cross-app merges; importing two projects into one would need an id-mapping pass.
- **Collab rooms are in-memory server-side** (`server/collab-server.mjs:409`): a server restart kills jam sessions. Gallery persists; rooms don't.
- **Doc/README drift:** README claims 51 factory sounds / 172 presets; the manifest defines 41 synthesized asset ids (+7 curated WAVs) and `presets/factory.ts` holds ~199 preset objects. Cosmetic, but plan against the code, not the README.
- **Effect degradation is silent by design:** worklet-backed effects fall back to simpler DSP when worklets are unavailable (`getDegradedFx()` exposes it), so an external analysis of "what DSP is in this project" must consult runtime status, not just the doc.

---

## 18. Implementation Maturity

| System | Status | Evidence | Notes |
|---|---|---|---|
| Audio engine | **Production-ready / mature** | `AudioEngine.ts` + audit-driven defect fixes; `tests/audio-engine-*`, browser verification suite | Context lifecycle, degradation fallbacks, metering |
| Sequencer/scheduler | **Production-ready / mature** | `Scheduler.ts` guards; `tests/scheduler.test.ts`, precision-audit fixes | Scene-tempo residual ≤25 ms documented |
| Project model | **Production-ready / mature** | `schema.ts` normalizers, `tests/project-invariants*`, round-trip tests | schemaVersion 1, no breaking migrations so far |
| Mixer | **Production-ready / mature** | `Mixer.tsx`, groups, sends, true-peak/K-metering tests | Group freeze explicitly unsupported (documented) |
| Instruments (14) | **Production-ready** | `instruments/registry.ts`, `tests/instruments.test.ts`, `tests/ui/new-instruments.test.tsx` | Preset bank large + quality-gated |
| Effects (36) | **Production-ready**, flagship cores golden-locked | `tests/fxeq-*` (~25 files), `tests/ultina-*` (~15), `tests/ozvena-*` (~10) | Vendored cores synced to upstream plugin repo |
| Save/load | **Production-ready** | autosave debouncer + lifecycle tests, snapshot repo, adversarial persistence tests | |
| Export (WAV/MP3/stems/scorepack/MIDI/video) | **Production-ready** | `tests/export/*`, `tests/offline-parity.test.ts` | Documented scene-boundary residuals |
| AI / intent | **Functional, actively maturing** | full pipeline + tests + trained ONNX ranker | Ranker val top-1 agreement 0.6 → heuristic still dominant |
| Collab / jam | **Functional but needs polishing** | `tests/collab-*` (12 files) | Server rooms in-memory; roles gate writes |
| UI | **Production-ready** | 90+ UI test files, e2e specs, onboarding, touch/mobile tests | |
| External integration readiness | **Strong seams, no facade** | §12 | Adapter needed for out-of-process control |

---

## 19. KYX's Current Differentiator (implemented, not aspirational)

1. **Prompt-to-pattern intent engine with full provenance** — deterministic NL parsing + genre grooves + Markov + scale-constrained melodic generation + quality gates + a *trained* ONNX ranker, every result reproducible from its recorded recipe.
2. **Bit-honest live/export parity** — the same DSP, event expansion, groove, tempo-map and modulator math render offline; exports measure their own true-peak/RMS/correlation.
3. **Plugin-grade native effect suite in the browser** — three flagship multi-engine plugins (PRISM FXEQ, Ultina, Ozvena) with worklet DSP, golden-vector locks, A/B state, preset systems — plus 33 more effect types.
4. **Performance DNA** — quantized scene launches, pattern queueing, capture-last-take, note repeat, macro/intensity modulation, 4 performance macros per project, pads + melodic QWERTY, MPE.
5. **Multiplayer jam with shared transport and an AI bandmate** — CRDT sync, role gating, remote cursors, wall-clock transport anchoring ("Instant Jam").
6. **Zero-backend portability** — whole-project share codes, an `/embed` renderer that reproduces any beat identically from a URL, and a public gallery + remix lineage.
7. **Scorepack** — a self-describing export bundle (audio + score/markers/automation/intensity JSON) designed as a transport format.

---

## 20. Audiotool "Let's Build!" Hackathon Relevance (capability mapping only)

**Composition / Songstarter**
- Already implemented: intent engine (`generateLocalResult`) produces genre/style/BPM/role-aware patterns + `autoArrangeSong` builds a full arrangement from scenes — together a genuine songstarter primitive; templates + provenance make outputs reproducible; `arrangeWords` maps scene words to structure.
- Small extension: expose the intent pipeline + arrangement skeleton behind a thin adapter (§21); feed Audiotool-side metadata (genre/mood/key) straight into `IntentSpec`.
- Major new feature: server-side generation service, or model-driven arrangement length/energy shaping beyond `autoArrangeSong` heuristics.

**Sound Design**
- Already implemented: 14 synth engines with metadata-driven parameter surfaces, preset catalog with genre/mood tags + similar-presets, auto-sampling/preset quality gates; flagship FX with presets and mix-assist (Ultina analyzes and proposes settings).
- Small extension: preset/pattern export via existing code/pack codes; map Audiotool device params ↔ `EffectInstance.params` (both are flat numeric records with schema metadata).
- Major new feature: bidirectional device state translation for Audiotool's native devices.

**Connect**
- Already implemented: the collab stack is the closest analog — Yjs CRDT rooms over WebSocket, shared transport pulses, roles, remote cursors; plus share codes and a gallery with remix lineage.
- Small extension: room persistence server-side (currently in-memory), auth/handshake, room tokens.
- Major new feature: an Audiotool-hosted relay or protocol bridge; identity linking.

**("DAW-in/out" generally)** — Already implemented: MIDI import/export, WAV/stem/scorepack export, project JSON/share-code lossless round-trip. Small extension: a KYX↔Audiotool schema mapping layer over `scorepack` JSON manifests, which were designed for exactly this purpose.

---

## 21. Minimum Integration Surface (based on actual architecture — NOT a design proposal)

The seams already exist; a thin adapter over them would look like:

```ts
// All of this is implementable today against existing public functions —
// names below map 1:1 to real exports in the repo.
interface KyxProjectAdapter {
  // Read (already pure — src/project-model/types.ts + schema.ts helpers)
  getProject(): ProjectDocument;                 // store.getDoc()
  getTracks(): Track[];                          // doc.tracks
  getPattern(id: ID): Pattern | undefined;       // doc.patterns.find
  listEffects(trackId: ID): EffectInstance[];    // track.effects

  // Write (already pure command factories — src/commands/commands.ts)
  setTempo(bpm: number): void;                   // setBpm(doc, bpm)
  createTrack(kind: InstrumentKind): void;       // createInstrumentTrack(doc, kind)
  createPattern(name?: string): void;            // createPattern(doc, name)
  addNotes(trackId: ID, notes: NoteEvent[]): void; // addNote(...) per note
  setInstrumentParam(trackId: ID, paramId: string, v: number): void;
  updateEffect(trackId: ID, fxId: ID, paramId: string, v: number): void; // setEffectParam

  // Generate (already pure — src/intent/pipeline.ts)
  generate(input: IntentInput): GenerationResult; // generateLocalResult(doc, input)

  // Observe (already exists — src/store/ProjectStore.ts)
  subscribe(listener: () => void): () => void;   // store.subscribe
  onDocChanged(cb: (doc: ProjectDocument) => void): void;

  // Transport (already exists — services)
  play(): void; stop(): void; seekTick(tick: number): void;  // playback.playPause/stop/seek

  // Transport out (already exists — src/export/*)
  encodeShareCode(): string;                     // shareCode.encodeShareCode(doc)
  buildScorepack(): Promise<Blob>;               // scorepack.buildScorepack(...)
  exportMidi(): Uint8Array;                      // midiProject.patternToMidi(...)
}
```

**Where a thin adapter is genuinely required:** mounting this interface onto a *running studio from outside the page* (the missing facade — e.g. a small in-page bridge or a channel to the collab room), and fine-grained change events (derive from `computeDocDelta`). Everything inside the interface is existing, tested code.

---

## 22. Final Executive Summary

### KYX in one sentence
KYX is a mature, browser-first electronic-music workstation — step sequencer + piano roll + 14 synths + 36 effects (three plugin-grade) + clip arrangement — with a deterministic, provenance-tracking AI intent engine and bit-honest offline export, all built on a clean serializable project model and a pure command system.

### KYX in one paragraph
KYX (repo codename `pulse-forge`) boots into a project browser with 12 genre templates and runs entirely client-side: a React UI subscribes to a framework-free `ProjectStore` whose document (`ProjectDocument`) is plain versioned JSON; all edits flow through ~150 pure, undoable command factories; a tick-based `Transport` and a 25 ms look-ahead `Scheduler` expand patterns (with swing, humanize, probability, ratchets, microtiming, p-locks) into AudioContext-scheduled events executed by a shared `AudioEngine` whose graph (tracks → insert FX → sends → returns → master chain) is diffed from the document on every change; the identical engine and event math render projects deterministically to WAV/MP3/stems/scorepack/video/MIDI. A distinctive generative stack (NL prompt → `IntentSpec` → genre grooves + Markov + scale-constrained melody → quality gates → trained ONNX ranker) writes fully-provenanced patterns, and a Yjs collab layer adds multiplayer jams with shared transport and an AI drummer. Persistence is IndexedDB with autosave/snapshots; sharing works with zero backend via URL share codes and an `/embed` renderer.

### Current strongest capabilities
Deterministic live/export parity; the command/project-model separation; the intent/generative pipeline with reproducibility; the flagship DSP suite; performance/jam features; lossless portability (share codes, JSON, scorepack); test/CI discipline.

### Current weak/incomplete areas
No out-of-process control API for a running studio; whole-doc-only change notifications; monolithic mega-modules (commands/AudioEngine/registries); collab rooms not persisted server-side; ranker quality still heuristic-dominated; minor doc/code drift (preset/sample counts, scorepack labeled "future"); `y-indexeddb` dependency present but unused.

### Most important architectural components
`ProjectDocument` (types/schema) → command layer → `ProjectStore` → `Transport` → `Scheduler` → `AudioEngine` (+ worklet effects) → offline `renderer`/export — wired in `services.ts`; generative entry `intent/pipeline.ts`; interchange artifacts `shareCode.ts`/`scorepack.ts`.

### External integration readiness
**Manageable — leaning easy for anything that can run in-process or consume files; significant work only for live out-of-process control of a running studio.** The project model, command API, generative API, and export/share artifacts are already clean, typed, and tested integration seams; the missing piece is a facade (fine-grained events + a runtime bridge), which the `services.ts` composition root would host naturally.

### Five things another engineer MUST understand before modifying KYX
1. **The document is the truth.** Never mutate `ProjectDocument` in place; create a command (pure `execute/undo`) and `store.execute` it — normalization, undo, autosave, engine diff, collab all hang off that single path.
2. **Live and offline must stay identical.** Any scheduling/timing change must go through the shared modules (`project-model/groove.ts`, `events.ts`, tempo-map math) so playback and export don't diverge; parity tests will pin you.
3. **`normalizeProject` is the border.** Every doc entering the store (import, collab, test fixture) passes schema validation; new optional fields need defaulting rules there or old projects will break.
4. **`services.ts` is the wiring diagram.** The scheduler's dependency object shows exactly how engine/transport/store/MIDI/collab interconnect; most "where is this hooked?" answers live there.
5. **Ids and invariants matter.** `activePatternId` must always resolve (documented invariant with dedicated tests); ids are opaque strings — never parse or regenerate them casually.

### Five things another engineer SHOULD NOT assume about KYX
1. **That a React component is required to change music** — the whole model is drivable headlessly (tests and Node scripts do it).
2. **That the README numbers are current** — code is authority (e.g., 41 synthesized factory assets + 7 curated WAVs, ~199 presets, not the README's 51/172).
3. **That effects always run their full DSP** — worklet-backed effects silently degrade to fallbacks when worklets are unavailable; consult `getDegradedFx()`, not just the doc.
4. **That collab state is durable** — jam rooms live in server memory and vanish on restart; only projects (IndexedDB) and gallery items (`gallery.json`) persist.
5. **That KYX has any Audiotool-specific code today** — it doesn't; interoperability exists only as generic MIDI/JSON/scorepack/share-code infrastructure and the "Qvester Interoperability" architectural intent (§14).
