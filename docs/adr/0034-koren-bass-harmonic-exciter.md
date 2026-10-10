# ADR 0034 — KOREŇ bass harmonic exciter (lazy first-party worklet effect)

Date: 2026-10-10 · Status: Accepted · Scope: effects registry, lazy worklet loading, bundle budgets

## Context

Sub-bass content (808s, subs, low synth notes) vanishes on phone speakers,
laptop drivers and small club PA systems. The registry had no effect that
tracks a bass fundamental and synthesizes its missing harmonics while keeping
the original sub intact — saturation adds broadband distortion, EQ cannot
invent frequencies.

Two technical seams needed a decision:

1. How the DSP parameters reach the worklet. Port messages (`paramAt`
   style) are not delivered during `OfflineAudioContext` renders; the
   existing event-queue worklets had to gate on `!offlineRenderContext(ctx)`.
2. Where the module lives. The core worklet bundle sits at 145/150 KB, so a
   new DSP module cannot ride it. The vendored suite precedent (`fxeq`,
   `ultina`, `ozvena`, `morphdynamics`) loads per effect type, but the list
   was named `PLUGIN_WORKLET_TYPES`, which claimed exclusively third-party
   suites.

## Decision

1. KOREŇ (effect type `bassHarmonic`, category `character`) is a first-party
   effect whose DSP lives in its own lazy AudioWorklet module
   `public/bass-harmonic-worklet.js`, built by
   `scripts/build-bass-harmonic-worklet.mjs` (esbuild, plain JS processor).
   It carries its own bundle budget row in `scripts/check-bundle-size.mjs`
   (`BASS_HARMONIC_WORKLET_BUDGET_KB = 24`, measured ~6 KB at implementation,
   with a missing-file failure).
2. Parameters are **AudioParam descriptors** with the same ranges as
   `EFFECT_META` (M2 pattern: `zenit-m2-nodes.ts` + `safeApplyAudioParam`).
   Offline automation is native render-timeline state, so live and offline
   renders are identical without any event queue. The FULL SWEEP in
   `tests/param-range-coherence.test.ts` pins descriptor bounds against the
   definitions.
3. Fallback is honest: `WORKLET_EFFECTS.bassHarmonic = "degraded"` — a 1:1
   bypass with `degradedReason` until the module lands in the context; the
   engine's existing hot-swap replaces the chain when the module becomes
   ready. No approximation pretends to process.
4. `PLUGIN_WORKLET_TYPES` was renamed to `LAZY_WORKLET_TYPES` in a separate
   mechanical first commit because the list now carries a first-party effect,
   not only vendored plugin suites. `ensureWorkletsForDoc` and the engine
   hot-swap read the same list, so no engine logic changed.
5. No project schema bump: effect instances normalize against `EFFECT_META`,
   unknown/absent params clamp to the declared defaults, and the `EffectType`
   union is additive.

## Consequences

- Projects that never use KOREŇ never fetch its module (`lazyWorkletTypesInDoc`
  drives `ensureWorkletsForDoc` in live and offline paths).
- `loadAllWorklets` (browser check suite) now loads 8 modules; the count is
  pinned in `tests/audio-worklets.test.ts`.
- The FX loudness harness loads the new module without script changes and
  produced measured gains for all 4 factory presets
  (`presets:fx-loudness`).
- The DSP detector is deliberately conservative: frequencies outside the
  `focusHz × [0.5, 2]` window are left untouched (no invented harmonics), and
  the generator mutes on polyphonic/pulsing input it cannot track.
- No RNG: identical input yields sample-identical output; `mix = 0` is a
  bit-exact dry passthrough.
- Registry counts move 52 → 53 effects / 47 → 48 native-core (re-measured in
  the same commit).

## Validation contract

- Processor behavior (`tests/bass-harmonic.test.ts`): 55 Hz probe gains
  measurable 2nd-harmonic energy at `drive` max; `drive = 0` adds nothing;
  `subAnchor = 0` mutes the fundamental; `lowCut` measurably changes the sub
  spectrum; `mix = 0` is bit-exact dry; all params finite and bounded at both
  extremes; FOCUS window limits tracking (out-of-window output matches the
  generator-off floor).
- Determinism (`tests/bass-harmonic-golden.test.ts`): consecutive renders are
  sample-identical (no ping-pong), detector state is deterministic from cold.
- Registration: `EFFECT_PROC_PAIRS` + `WORKLET_CASES` entries; menu order
  surfaces (`EFFECT_ORDER`, `CORE_EFFECT_ORDER`) include the type.
- `npm run presets:fx-loudness` regenerated `FACTORY_FX_PRESET_GAIN_DB` with
  the four `bassharmonic-*` presets.
