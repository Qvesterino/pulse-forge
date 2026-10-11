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
   (`SKRUTKA_WORKLET_BUDGET_KB = 16`, measured ~3 KB at v1 / ~7 KB at v2,
   with a missing-file failure).
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

## Addendum (2026-10-11) — v2: DYNAMIC + KEY + MOTION + SHAPE

v1 was a static disperser. v2 makes the phase react to the signal, to a
sidechain key and to the grid — the "dynamic phase" generation. Every
addition keeps the v1 contract: all-pass only, AudioParam-only parameters,
no RNG in the signal path, `mix = 0` bit-exact dry, and **the v1 parameter
set renders bit-identically to v1** (frozen FNV hash `e6cb495b83b6556c`
over a 1.2 s tonal + kick probe, pinned in `tests/skrutka-golden.test.ts`).

1. **DYNAMIC (`dyn`, signed −1..1, default 0).** A fast follower (1 ms atk /
   15 ms rel) versus its 60 ms lag yields a transient score with a 0.4 margin
   (a rectified sine's own ripple never reads as an attack); a 10/150 ms
   follower yields the body score, attack-suppressed. `dyn > 0` (ATTACK)
   deepens the pole radius toward 0.995 on transients; `dyn < 0` (BODY)
   deepens it on sustain, leaving the click clean. The radius DELTA glides
   with a 15 ms one-pole: an envelope-following pole radius on a
   near-unit-circle all-pass is a parametric amplifier if it tracks audio-rate
   envelope ripple — measured 10× gain before the glide, ≤ 1.1× after
   (bounded by the parameter-extreme test). `dyn = 0` does not even update
   the followers.
2. **KEY (`keyMode`: 0 OFF / 1 PUMP / 2 DUCK, default 0).** A second worklet
   input carries a sidechain key through the engine's generic
   `setSidechainInput` contract (KOREŇ wave-4 precedent; zero engine
   changes). A 2 ms/180 ms key envelope drives the radius: PUMP deepens it
   toward the ceiling on every kick, DUCK thins it (×0.3..1) so the kick
   clears its own phase smear. No key connected is bit-exact to OFF.
3. **MOTION (`lfoRate` Hz + `lfoSync` division + `lfoShape` SINE/TRI/RAND +
   `lfoDepth`, default 0).** The rate is converted host-side and written as
   `lfoHz` (the flanger/tremolo `createLfoSyncController` contract, so BPM
   pushes work and offline automation is native). FOCUS sweeps ±
   `lfoDepth` octaves; the random shape steps once per cycle from a xorshift
   seeded by the persisted factory seed. `onTransportStarted` writes
   `lfoPhase` (position beats × cycles-per-beat, fraction) so the sweep is
   grid-anchored when the transport starts and free-runs deterministically
   from 0 otherwise. With `lfoDepth = 0` the LFO is exactly 1.0× (no-op).
4. **SHAPE (`shape` 0..3, default 0).** GULP = 8 sections at FOCUS (v1);
   CHIRP = angles log-spread 0.5×…2× FOCUS; DOUBLE = 4 at FOCUS/3.5 + 4 at
   FOCUS×3.5; RESO = the hot radius mapping (0.45 + 0.53·dispersion) for a
   tall narrow hump. Plus `punchHz` (0 = AUTO ratio, explicit center
   otherwise) and `punchMix` (parallel blend of the punch stage against the
   long output; 0 removes the stage exactly).
5. **Panel v2** — the analytic curve is now SHAPE-aware and **editable**
   (horizontal drag = FOCUS, vertical = DISPERSION by bisection over the
   peak-delay mapping, one undo frame per gesture); DYNAMIC/KEY draw the
   driven-radius band, the LFO shades its sweep range, and a live dot follows
   the processor telemetry (throttled `type:"skrutka"` frame: lfo phase,
   envelope, key gain, current radius). **BAND SOLO** auditions the focus
   band through a new monitor-only lowpass: `MasterChain.setMonitorBand` /
   `AudioEngine.setMonitorBand` add the mirror half of PHONE CHECK's
   highpass on the same LIVE-only branch (glide 20 ms; offline renders
   connect straight to their destination; released on unmount).
6. **Coupled controls, stated honestly.** `punchHz`/`punchMix` are only
   audible with PUNCH ≠ 0 and `lfoRate`/`lfoSync` only with LFO DEPTH > 0
   (the parameter audit reports them as context-coupled, same class as
   KOREŇ's `keyMode`); the defaults keep every coupled section off so the
   v1 render is untouched.

Validation additions (`tests/skrutka.test.ts` v2 block, `tests/skrutka-soak.test.ts`,
`tests/ui/SkrutkaPanel.test.tsx`, `tests/master-chain.test.ts`):

- SHAPE: CHIRP/DOUBLE/RESO each move the render; CHIRP and RESO still match
  the analytic curve (model↔processor lockstep survives the distributions).
- DYNAMIC: BODY moves the steady-state phase while ATTACK does not; on a
  note onset ATTACK's difference energy is concentrated early and decays,
  while BODY is suppressed at the onset and grows once settled.
- KEY: PUMP and DUCK move the wet-vs-dry phase in OPPOSITE directions during
  a key burst (against the pre-key reference); keyless renders are bit-exact
  to OFF; node-level key wiring repoints without double-connecting.
- PUNCH: explicit `punchHz` relocates the hump (≥ 1.5× at the new center);
  `punchMix = 0` equals `punch = 0` bit-exactly.
- MOTION: an 8 Hz LFO at full depth moves the phase deterministically across
  runs; the node wrapper converts `lfoRate`/`lfoSync` to Hz (free 2 Hz →
  4 Hz at 1/8 → 3 Hz at 90 BPM) and anchors `lfoPhase = 0.5` for position
  2.25 beats at 1/8.
- Legacy: the frozen v1 hash + abs-sum pins bit-exact backward compatibility;
  v2-only params at their defaults do not change a render.
- Soak (120 s worst case: CHIRP + spread + dyn + key + 8 Hz random LFO):
  zero non-finite samples, zero subnormals, flat CPU through silence
  (late median ≤ early median), heap growth ≤ 6 MB (measured 0.5 MB).
- Browser: the shipped bundle loads the module, shifts a 200 Hz sine's phase
  while preserving RMS, and KEY PUMP moves a real keyed render while the
  keyless render stays bit-identical to OFF.
- 8 new factory presets (Kick Duck Phase / Attack Smear / Tail Liquid /
  LFO Throw / Chirp Rise / Double Gulp / Reso Vowel / Punch Band) — the FX
  loudness map regenerated with all 18 `skrutka-*` entries.
