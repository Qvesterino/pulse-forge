# ADR 0037 — SKRUTKA phase dispersion (lazy first-party worklet effect)

Date: 2026-10-11 · Status: Accepted · Scope: effects registry, lazy worklet loading, bundle budgets, device panel

## Context

The registry covers amplitude, spectrum, dynamics and time, but the one
mechanism a world-class effect lineup sells and this one lacked entirely is
**frequency-dependent arrival time**: a static all-pass group-delay shaper
("disperser"). The only all-pass use was the phaser's LFO-modulated cascade;
MORPH's harmony bus has an internal diffusion network, but it is neither
exposed nor focused. Nothing in the roster can produce the modern
kick/808/percussion "throw / gulp" character or a mono-safe transient
decorrelation, because EQ, saturation, transient shapers and compressors all
move amplitude — not phase.

Two infrastructure constraints, inherited from KOREŇ (ADR 0034):

1. The core worklet bundle sits at ~145/150 KB, so a new DSP module cannot
   ride it; it needs its own lazy bundle and budget row.
2. Parameters must be AudioParams (M2 pattern) — port-message parameters are
   not delivered during `OfflineAudioContext` renders.

## Decision

1. **SKRUTKA** (effect type `skrutka`, category `character`) is a first-party
   effect whose DSP lives in its own lazy AudioWorklet module
   `public/skrutka-worklet.js`, built by `scripts/build-skrutka-worklet.mjs`
   (esbuild, plain-JS processor). It carries its own budget row
   (`SKRUTKA_WORKLET_BUDGET_KB = 16`, measured ~3 KB, missing-file failure).
2. **DSP is all-pass only** — |H| = 1, so a steady tone keeps its level while
   its phase is warped:
   - **DISPERSION** — 8 identical 2nd-order all-pass sections with pole
     radius `r = 0.15 + 0.83·dispersion` (≤ 0.98) centered at FOCUS. The
     group-delay hump grows with dispersion (~0.2 ms → ~8-11 ms at typical
     focuses): a broadband transient smears, a steady tone does not.
   - **PUNCH** — 3 identical 2nd-order all-pass sections on radius
     `0.93·|punch|`, whose CENTER the sign selects: positive delays the body
     band (FOCUS / 3.5) so the click leads ("forward attack"); negative
     delays the click band (FOCUS × 3.5) so the transient sinks ("sucked
     attack"). At zero the radius is zero, so gliding through zero is
     silent; `punch = 0` skips the stage bit-exactly.
   - **SPREAD** — per-channel focus offset `×(1 ∓ 0.12·spread)`. `spread = 0`
     renders L and R bit-identically (mono-safe by construction).
3. Parameters are **AudioParam descriptors** with the same ranges as
   `EFFECT_META` (FULL SWEEP in `tests/param-range-coherence.test.ts` pins
   the bounds). Parameter changes glide over a 30 ms one-pole applied at
   block rate with the block-length correction (NEW-EFFECT-CHECKLIST §4);
   the FIRST block adopts the written values exactly, so a saved `mix = 0`
   project renders bit-exact dry from sample 0.
4. Fallback is honest: `WORKLET_EFFECTS.skrutka = "degraded"` — a 1:1 bypass
   with `degradedReason` until the module lands; the engine's hot-swap
   replaces the chain when it becomes ready.
5. **No telemetry.** Phase-only DSP has no level signature and the honest
   visual (the group-delay curve) is a pure function of the params:
   `src/effects/skrutka-curve.ts` is the closed-form model of the processor,
   used by BOTH the device panel (`SkrutkaPanel`) and the tests, so the
   panel can never draw a curve the DSP does not run.
6. **No project schema bump**: the `EffectType` union is additive, effect
   instances normalize against `EFFECT_META`, unknown/absent params clamp to
   the declared defaults.

## Consequences

- Projects that never use SKRUTKA never fetch its module
  (`lazyWorkletTypesInDoc` drives `ensureWorkletsForDoc` in live and offline
  paths); `loadAllWorklets` (browser check suite) now loads 10 modules — the
  count is pinned in `tests/audio-worklets.test.ts`.
- No RNG: identical input yields sample-identical output; the DSP is
  deterministic across instances from cold.
- Registry counts move **53 → 54 effects / 48 → 49 native-core / 31 → 32
  primary Add Effect choices** (re-measured in the same commit).
- Role landings (`src/effects/role-presets.ts`) and 8 factory presets ship;
  `npm run presets:fx-loudness` regenerates `FACTORY_FX_PRESET_GAIN_DB` with
  the `skrutka-*` entries.

## Validation contract

- Processor (`tests/skrutka.test.ts`): `mix = 0` bit-exact dry from a cold
  instance; level preserved within ±5 % while the phase shifts (all-pass);
  **measured group delay matches the analytic curve module** at 200/320/640 Hz
  (model↔processor lockstep); FOCUS moves the hump; PUNCH sign picks the
  delayed band (body vs click, both against the punch-off baseline); SPREAD 0
  is bit-exact mono and SPREAD 1 decorrelates; every param finite and bounded
  at both extremes.
- Determinism + transient claim (`tests/skrutka-golden.test.ts`): three
  consecutive renders sample-identical; an impulse keeps its total energy
  (phase-only) but dispersion 1 pushes energy past sample 100 while the
  near-neutral chain keeps it concentrated.
- Registration: `EFFECT_PROC_PAIRS` + `WORKLET_CASES` entries; menu order
  surfaces (`EFFECT_ORDER`, `CORE_EFFECT_ORDER`) include the type; a
  real-browser check renders through the shipped bundle and asserts the
  loaded worklet shifts a 200 Hz sine's phase while preserving its RMS.
- `npm run presets:fx-loudness` regenerated the gain map with the 8
  `skrutka-*` presets.
