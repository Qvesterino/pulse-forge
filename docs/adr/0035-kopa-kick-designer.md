# ADR 0035 — KOPA kick designer (lazy worklet instrument, drums preset family)

Date: 2026-10-10 · Status: Accepted · Scope: instruments registry, lazy instrument worklets, presets, preset-intent families

## Context

The kit carried only three kick factory presets (all on the Drum Synth kind),
and no instrument exposed kick design as a first-class surface (pitch
envelope, click, body, tail, sub, drive as one voice). The TSAR wave proved
the pattern for a lazy, event-queue AudioWorklet instrument (ADR 0023); the
KOREŇ wave proved the lazy-worklet budget seam for first-party DSP
(ADR 0034).

KOPA (`kopa`, "KOPA Kick Designer") is a dedicated kick designer: a
phase-locked sub, a 4-curve per-voice shaper, a curve-driven pitch envelope
and a deterministic offline render need per-sample work, which a native node
graph cannot express (hundreds of nodes per voice; no hold curves).

## Decision

1. KOPA is a NEW instrument kind, not a `drumsynth` extension: the Drum Synth
   stays the compact 13-type percussion synth; KOPA owns the kick-designer
   surface without forcing 20+ params onto a preset-driven drum machine.
2. DSP lives in a typed core `src/kopa/dsp/kopaProcessor.ts` (the
   `tsarProcessor` split: no AudioWorklet globals, vitest-testable) wrapped by
   `src/kopa-worklet.entry.js` and bridged by `src/instruments/kopaNode.ts`.
   Live = port messages; offline = the runtime buffers events and
   `prepareOfflineRender()` seeds them through `processorOptions.events`
   (Chromium does not pump worklet message queues during an offline render).
   Max 16 voices, oldest-steal; RNG-free (seeded LCG click noise only).
3. Lazy loading: `INSTRUMENT_WORKLET_TYPES` gains `"kopa"`; the engine's
   `queueTsarWorkletLoad` was generalized to `queueInstrumentWorkletLoad`
   (per-type queue tracking in a WeakMap) in a separate refactor commit.
   Its own bundle budget row (`KOPA_WORKLET_BUDGET_KB = 32`) — the core
   worklet bundle is untouched.
4. Fallback without the module is a REAL audible kick (oscillator pitch ramp
   - noise click through a gain envelope), the `createTsarFallbackRuntime`
     precedent — never a dead graph.
5. No project schema bump: `InstrumentKind` is additive and `normalizeProject`
   heals unknown kinds; only `INSTRUMENT_NAMES` (schema) and
   `DEFAULT_GM_PROGRAM_BY_INSTRUMENT` (Nexus mapping) are `Record`-complete
   surfaces that must list it.
6. KOPA joins the **`drums` preset-intent family** (`FAMILY_INSTRUMENTS.drums
= new Set(["kopa"])`, v1 only KOPA; `drumsynth` instrument presets stay
   outside until they have a kick-designer equivalent). Family-aware track
   resolution lives in `preset-intent.ts`
   (`resolvePresetFamilyTracks`); `resolveExactTargetTracks` is unchanged so
   fader/exact "drums" still targets the drum rack. `model-schema.ts` is
   deliberately frozen — adding the family is engine-side; the pinned
   `grammarSha256` / `schemaSourceSha256` artifacts are untouched and a
   retrain is a separate wave.
7. Factory presets: 16 hand-curated kicks (eager `FACTORY_PRESETS`), catalog
   `inferUseCase` routes `kopa` to the `drums` plateau.

## Consequences

- A project with no KOPA track never fetches `kopa-worklet.js`.
- The instrument count moves 23 → 24; the loudness harness measured 643
  presets (527 eager + 116 lazy), and the drums family median moved from
  −28.6 to −24.4 LUFS, which clamped four quiet `drumsynth` siblings (pinned
  in the loudness audit inventory — the per-family rebalance is a follow-up).
- **Worklet loudness calibration (2026-10-11):**
  `scripts/measure-preset-loudness.mjs` loads KOPA's lazy worklet and calls
  `prepareOfflineRender()` before rendering. All 16 KOPA presets measured
  −32.6 to −24.8 LUFS before normalization, with generated corrections from
  −2.5 to +2.6 dB in `src/presets/preset-loudness.generated.ts`. The projected
  sample peak after normalization and the 0.78 audition gain is −23.9 to
  −16.9 dBFS (highest: `factory.kopa.house.thump`), leaving ample audition
  sample-peak margin. This does not cover inter-sample true peak or arbitrary
  mixer/master gain. Fallback parity and practical preset-to-preset usefulness
  remain follow-up work. The live worklet path keeps its audibility gate in
  `browser-checks.ts`.
- Stems route KOPA tracks into the `drums` stem; embed energy classification
  counts KOPA as drums; intent exact parsing maps "kopa"/"kick design" to the
  instrument.

## Addendum — note length versus one-shot decay (2026-10-11)

KOPA now exposes `TRIGGER` with `ONE SHOT` and `GATED` modes. `GATED` remains
the default to preserve the existing noteOff contract; it intentionally chokes
the current hit when MIDI noteOff arrives. `ONE SHOT` lets the designed body,
sub, click and tail envelopes finish regardless of the note's grid duration.
The native fallback schedules a bounded oscillator lifetime from the longest
active layer decay, so hosts that omit noteOff cannot leave silent oscillators
running indefinitely.

## Validation contract

- `tests/kopa/engine.test.ts`: audible noteOn, self-decay, noteOff choke,
  panic, 16-voice pool with oldest-steal, pitchAmount ramp rate, keyTrack
  fixed vs note-follow, sub adds octave-below energy, click/body/tail params
  move their measured features, four drive curves distinct and measurable,
  stereo 0 = mono, live-vs-seeded bit-identity.
- `tests/kopa/offline-parity.test.ts`: identical event scripts render
  sample-identical; renderer barrier ordering (`prepareOfflineRender` before
  `startRendering`) and the KOPA `processorOptions.events` seed are pinned.
- `tests/kopa/fallback.test.ts`: native fallback builds a live graph; the
  live bridge posts noteOn/noteOff/param; the offline bridge buffers until
  `prepareOfflineRender`; velocity is applied once at the complete voice
  output (including a silent velocity-zero event), and fallback noteOff only
  chokes voices matching the requested pitch.
- `tests/kopa-presets.test.ts`: 16 unique in-range presets, all audible
  (peak floor + headroom), catalog routes them to `drums`.
- `tests/instrument-graph-reachability.test.ts` covers the fallback graph
  (kopa: audible=4, no leaks).
- Browser gate: offline export audible through the event-queue worklet with
  the lazy module loaded.
