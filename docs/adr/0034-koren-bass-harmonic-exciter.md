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

## Addendum (2026-10-10) — wave-2 DSP: YIN tracking, phase coherence, deficit, CHARACTER

The wave-1 detector was a zero-crossing-rate estimator: on harmonic-rich
basses the extra edges read an octave high (a 55 + 110 Hz signal tracked as
110 Hz and generated 220/330 — harmonics on the wrong root). Wave 2 replaces
it and adds three DSP features:

1. **YIN tracker.** A DECIM = 4 decimated copy of the 300 Hz detection band
   feeds a control-rate YIN detector (cumulative-difference
   absolute-threshold pick + parabolic refinement, the exact detector ported
   from `pitchcorrect-processor.js`) every 1024 native samples (~21 ms). The
   search range IS the focus window × [0.5, 2], floored at 20 Hz; clarity
   gate 0.85. Pitches outside the window can never be tracked — the "no
   invented harmonics" contract is preserved by construction.
2. **Phase coherence.** Each accepted rising zero crossing of the detection
   band (spacing ≥ 0.45 × the tracked period — harmonic-induced extra edges
   are rejected) nudges every active harmonic accumulator toward 0 phase
   (gain 0.5, clamped ±0.35 rad/crossing). The generated layer stays
   phase-locked to the dry fundamental (measured lock offset matches the
   detection filter's phase lag, −2·atan(f0/300) for the 2nd harmonic)
   instead of beating against it.
3. **Deficit generation.** Hann-windowed Goertzel magnitudes at f0/2f0/3f0
   over the decimated ring, compensated for the one-pole response
   (`1/sqrt(1+(f/300)²)`), measure the input's existing 2nd/3rd-harmonic
   ratios. Generated partials scale with the deficit against targets
   0.35/0.30 (one-pole 0.35 smoothing at the detection cadence); higher
   partials ride the 2nd-harmonic deficit as an even proxy. An already-fat
   bass is not doubled; a pure sine gets the full stack.
4. **`character` (0 CLEAN / 1 SAT / 2 FOLD)** shapes the generated layer
   only — soft `tanh` saturation or a sine wavefolder. `bassharmonic-drill-growl`
   ships FOLD. The AudioParam descriptor matches the def (FULL SWEEP); no
   schema bump — effect instances normalize against `EFFECT_META`, so
   absent params clamp to the declared default 0 (CLEAN).

Validation additions (`tests/bass-harmonic.test.ts`, wave-2 block): octave
safety (55 + strong 110 still tracks 55 — 3rd lands at 165, not 330),
phase-lock invariance across input phases (φ ∈ {0, 0.35π, 0.8π} → the 2nd
harmonic's phase minus 2φ is constant and matches the theory offset),
deficit suppression (a rich input's generated 2nd collapses), CHARACTER
odd-harmonic energy (SAT/FOLD vs the CLEAN floor). The four `bassharmonic-*`
preset gains were re-measured (`presets:fx-loudness`): 808 Phone 0.9 → 0.7 dB,
Drill Growl 2.9 → 3.4 dB. Determinism, `mix = 0` bit-exactness and the
`degraded` fallback contract are unchanged.

## Addendum 2 (2026-10-10) — wave-3 performance controls

Three new AudioParams, all defaulting to the legacy behavior except `retrig`
(which is the point of the feature; effects normalize against `EFFECT_META`,
and a `retrig = 0` value restores the pre-wave-3 render):

1. **`sustain` (0..1, default 0)** — generator-target envelope compression:
   the target becomes `env^gamma` with gamma `1 → 0.5` as sustain rises, so
   quiet bass passages still generate readable harmonics (measured: a
   0.06-amplitude 55 Hz note lifts from 0.016 to 0.085 generated 2nd). The
   curve fades to linear below `SUSTAIN_FLOOR = 0.01` so the noise bottom is
   never pumped.
2. **`retrig` (0/1 toggle, default 1)** — a fast/slow envelope-rise
   detector (1 ms follower vs its 20 ms lag) fires on note-ons: harmonic
   phases reset to 0 and the generator envelope restarts, so staccato lines
   glue to the attack instead of trailing the previous note like a pad.
   Guarded by a 0.005 level floor, a 0.35 rise ratio and a 40 ms minimum gap
   so sustained notes and slow pads never re-trigger.
3. **`width` (0..1, default 0)** — the generated partials above 120 Hz are
   emitted as mid + quadrature-side and rotated ±φ (φ = width · 0.6 rad) per
   channel; the sub stays mono by construction and `width = 0` is the
   bit-exact legacy mono stack. Test pins: side energy at 110 Hz ≈ 0 while
   220 Hz carries it, and the L/R phase difference at 220 Hz equals 2φ.
4. **`focusHz` automation** — no DSP was added: the param was always a plain
   AudioParam, so automating it is a free performance FX. A ramp from 40 to
   220 sweeps the tracking window past a 55 Hz note and mutes the
   generation. Pinned by a per-block automated-focus render.

`bassharmonic-drill-growl` ships FOLD + sustain 0.5 + width 0.5; the other
presets carry sustain (0.3–0.6) and width (0–0.3). Loudness re-measured
(`presets:fx-loudness`): Drill Growl 3.4 → 3.7 dB. Note the measurement
harness is environment-sensitive for pulse-shaped presets (stepgate/stutter
rows flipped between two consecutive runs and were left at the second,
consistent pass; `stutter-chop` remains the known nondeterministic entry).

## Addendum 3 (2026-10-10) — wave 4: key routing, live telemetry, panel + PHONE CHECK

1. **KEY MODE (`keyMode`: 0 OFF / 1 PUMP / 2 DUCK, default 0).** The node gets
   a second worklet input (`numberOfInputs: 2`) with the same duck-typed
   `setSidechainInput` contract as sidechain-node/compressor-node — identical
   repoints early-return because `syncFxSidechains` re-asserts wiring on every
   project sync. The engine needed ZERO changes: it already taps the source
   track's pre-insert input for any runtime exposing the method, live and
   offline through the same code path. The processor runs a 2 ms/180 ms key
   envelope on the key's mono sum and scales the GENERATED layer only — PUMP
   blooms the harmonics ×1..2 on every kick (the "phone pump", no sub clipping),
   DUCK pulls them to ×0.15..1 so the kick clears its own way. keyMode 0, or
   any mode without a key connected, is bit-exact to wave 3 (pinned by test).
2. **Live telemetry (observer-only).** The processor posts a ~20 Hz
   `{ type:"koren", f0, clarity, harm, key, partials: Float32Array(9) }` frame;
   the node wrapper caches the last VALIDATED frame behind `getMeters()` (the
   kaskada/ultina pull-cache pattern). No enable gate — a few scalars per
   frame, the same discipline as the compressor's unconditional GR posts.
   Port traffic never touches the sample path; offline renders post into the
   void (the existing `renderer` engine has no consumers).
3. **`harm` = the "+x dB harmonics" reading** — (generated stack + the input's
   own 2nd/3rd) against the input's own 2nd/3rd, both from the deficit
   Goertzel estimates, clamped 0..36. A pure 808 reads at the cap, an
   already-rich bass reads near 0 — the deficit generator made legible.
4. **KorenPanel** — a lazy inline device panel (the flagship-effect pattern,
   injected beside FxEqPanel/UltinaPanel): a live canvas with the log-frequency
   axis, the focus-window shade, the 120 Hz mono/width split line, the tracked
   f0 marker and the generated harmonic bars (green ≤ 120 Hz, amber above);
   f0/boost readouts update through refs on a 15 Hz poll — no React state on
   the hot path.
5. **PHONE CHECK** — `AudioEngine.setMonitorHighpass(hz)` on the new MasterChain
   monitor stage: a highpass gliding (20 ms) to 350 Hz, inserted after the
   monitor output gain on the LIVE listening path only. `build()` branches the
   wiring, so an offline render connects straight to its destination and an
   export can never inherit the audition filter; the panel releases it on
   unmount. Monitor-only: no command, no undo, no project state.
6. **Rack mini meter** — the EffectRack status poll reads the KOREŇ telemetry
   cache (no new engine API; `getFxMeters` already resolves track/group/return/
   master runtimes) and renders `+x dB HARMONICS` beside the GR bars.

Validation additions: processor pins (PUMP/Duck bloom ratios on a keyed burst,
bit-exact no-key no-op, telemetry cadence/frame shape at ~20 Hz); node wrapper
pins (2 inputs, key connect/detach/repoint no-op, validated frame cache,
idempotent dispose); MasterChain pins (live frequency glide on/off, offline
no-write, the live-only wiring branch); KorenPanel pins (telemetry readouts,
PHONE CHECK toggling `setMonitorHighpass(350/null)`, release on unmount,
degraded notice); and a real-browser check through the shipped bundle (keyed
PUMP raises the generated 2nd ×1.78, telemetry reports f0 = 54.9 Hz).
