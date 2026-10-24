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

## Addendum 4 (2026-10-10) — content surfaces: chain, intent concept, Mix Doctor

1. **BASS PHONE READY chain** (`BEATMAKING_EFFECT_CHAINS`): KOREŇ
   (`bassharmonic-808-phone`) then `eq-air`, applied through the existing
   `applyEffectChainPreset` fold (one undo, output trims from the measured
   loudness map). A coherence test now pins every chain item to a real
   factory preset of the same type — a dead entry fails at insert time, so
   the table gets a compile-adjacent pin.
2. **`phone` production concept**: "phone-ready bass", "on/through/for a
   phone | mobile | small speakers", "small/laptop speakers", SK "na
   telefóne", "na mobile", "na malých reprákoch", "malé repro". Targets bass
   by default; plans KOREŇ (drive/mix/sustain scaled by the amount) plus an
   air-EQ lift, folded into ONE undo step by the existing intent applier.
   Precedence: when `phone` and `telephone` match the same clause — SK "na
   telefóne" hits both word families — the telephone goal is dropped, so the
   readability ask never stacks a handset band-pass on the harmonics it
   wants; "add telephone to the lead" still reaches the telephone chain.
   Schema flow: "phone" joins `VOCAB.productionConcept`, so the GBNF grammar
   hash changed and the artifact was re-pinned with
   `intent-model:manifest` + `intent-model:validate` (the ONNX model itself
   is unchanged — its head classes are a subset and no retrain is implied).
3. **Mix Doctor `harmonic-deficit` advisory**: a yellow flag that fires when
   the sub carries ≥ 25 % of the mix energy while 120–350 Hz — the band a
   phone speaker can actually reproduce — carries less than a fifth of the
   sub's share. The detail names KOREŇ as the repair path. Diagnosis only:
   the auto-fix derivation produces an identical result with the flag
   removed (pinned), and the flag never escalates to red.
4. Deliberately NOT built yet: the MATCH-tab owner-strip proposal ("the
   reference bass has more 100–350 Hz — this is a KOREŇ job") waits for the
   match surface's proposal pipeline.

## Addendum 5 (2026-10-10) — the PRESENCE band (the phone-readability fix)

**The finding:** waves 1–4 are tuned for small/laptop speakers, but the
PHONE CHECK highpass (350 Hz) filtered out almost everything the effect
adds — the 808 Phone preset shipped `range 2` → partials 110/165/220 Hz, ALL
below the band a phone speaker can reproduce. Through its own phone check
the effect was nearly inaudible: the harmonics earn their name only where
phones listen (~350–1200 Hz).

**The fix:**

1. `presence` (0..1, default 0) — a log-frequency hump (center 650 Hz, σ
   0.45, ≈+10× at the peak) multiplies the raw partial weights BEFORE
   normalization, so energy is REDISTRIBUTED into the phone band instead of
   added; the total stack level is preserved.
2. The `range` ladder now reaches 16 partials (was capped at 10) — a 55 Hz
   bass gets partials up to 880 Hz to redistribute.
3. The deficit proxy for partials ≥ 4 is `max(deficit2, deficit3)` — one
   rich low partial no longer kills the whole phone stack.
4. The quadrature (cos) accumulator is skipped when width = 0 — halves the
   trig cost of the bigger stack, bit-exact.
5. Preset retune: 808 Phone → range 4 + presence 1; Drill Growl → range 4 +
   presence 0.6; Subtle Body → range 3 + presence 0.4; Club Sub stays the
   legacy big-system reference.
6. Panel: axis to 1400 Hz, a 350 Hz PHONE line, bars to the 16th partial,
   three-band colours (mono ≤ 120 / laptop 120–350 / phone > 350). The
   telemetry frame now carries 15 partial amplitudes.

**Measured:** through a 350 Hz 2nd-order highpass (the PHONE CHECK shape)
the 808-phone recipe's audible energy goes ×1.8 (presence vs legacy, ×3.6 vs
dry) in the real browser bundle; the summed 7th–16th partial energy rises
×3.2 in the node harness; full-band RMS moves < 0.5 dB (redistribution, not
gain). Preset loudness re-measured (`presets:fx-loudness`): 808 Phone gain
0.9 → 0.7 dB, Drill Growl 3.7 → 3.8 dB. The same blessing picked up the
committed-but-unblessed `tpSafe` (ZENIT) and SKRUTKA param defaults in the
domain golden. `presence = 0` keeps the legacy curve; only `range 4` now
trades up to 16 partials instead of 10.

## Addendum 6 (2026-10-11) — stale-lock release, Nyquist taper and measurements

1. **Nyquist taper:** generated partials fade smoothly from 0.42 to 0.48 ×
   sample rate, before Nyquist, including at low sample rates. `presence` and
   the 16-partial range remain as specified in Addendum 5.
2. **Stale tracking releases safely.** After two consecutive detector misses,
   the generator target ramps down on the next missed window; the last f0
   remains available to the UI as HOLD for up to 250 ms, then clears to SEARCH.
   Telemetry exposes confidence beside the LOCKED/HOLD/SEARCH label. Corpus,
   alias-energy and release-click measurements remain required before calling
   this behavior regression-validated.
3. **Measured build footprint (2026-10-11):** KOREŇ's worklet is 9 KB against
   its 24 KB cap; KOPA's is 16 KB against 32 KB. Factory FX loudness measured
   all four KOREŇ presets, with generated corrections from −0.6 to +3.5 dB;
   the meter constrains preset and chain trims to a −1 dBFS sample-peak ceiling
   across three reference loops. These are bundle and reference-loop readings,
   not tracker-quality or mono-compatibility evidence on arbitrary sources.

## Addendum 7 (2026-10-11) — stale-lock release vs RETRIG

The untracked gate (Addendum 6.2) and the RETRIG note-on reset (wave 3)
interact on staccato lines: the YIN ring needs ~80–100 ms to refill after a
gap, so the gate muted the very attack RETRIG exists to glue (measured: a
70 ms dropout right after the second note, with the previous committed test
flipping red). The gate now **yields to a fresh note-on** — a transient is
evidence of pitched content, so generation continues from the held root for
150 ms after an accepted reset (`retrigHold`). Gaps with NO note-on (fades,
polyphonic mush) still mute exactly as designed. Re-measured on the pinned
retrig fixture: the glue window converges (onset divergence 0.30, fresh
attack audible at 0.17 RMS) while the free-running reference still diverges
(1.26) — both contract assertions hold again. `retrig = 0` keeps the pure
stale-lock behavior.

## Addendum 8 (2026-10-11) — GLIDE tracking refinement

YIN owns octave disambiguation but its 125 ms window lags a pitch sweep
(measured 5.1 % mean / 5.4 % max tracking error on a 55→75 Hz exponential
glide). The interval between ACCEPTED rising edge pairs is the CURRENT
period, so the same crossings the PLL already gates now refine f0 between
YIN updates: `f0 += 0.6 × (sr/sincePll − f0)` on every accepted edge, with a
±35 % plausibility clamp (a harmonic-spiked interval — or the first edge
after a gap, whose interval spans the silence — is rejected, and YIN
re-seeds at its cadence). While measurements are flowing, a small YIN
disagreement pulls gently (0.15 — it is just window lag) and a large one
still pulls hard (0.5 — octave/harmonic confusion); when no measurement has
landed for 120 ms the full 0.5 pull returns, so harmonic-rich material keeps
the pre-refinement tracking. Measured on the same sweep: **mean 1.9 % / max
2.5 %** error. Locked by `tests/bass-harmonic.test.ts` (wave-7 block):
tracker f0 within 3 % mean / 4 % max of the true glide, and a 55 + strong
165 Hz input still settling on 55.0 (the clamp never yanks the root).

## Addendum 9 (2026-10-11) — engine pitch hints (`hintHz`)

The tracker's remaining latency was structural: whatever the input, YIN needs
2–3 periods of a refilled window before the root is known, and an arbitrary
input can never be disambiguated at all. But on a MIDI-driven bass the HOST
already knows the note. The engine now taps its own note funnel:

- `AudioEngine.noteOn/noteOff` maintain a per-track held-pitch stack (most
  recent wins, duplicates replaced) and write the current pitch as **native
  AudioParam automation** — `rt.setParameterAt("hintHz", hz, when)` on every
  insert of the track, at the event's own `when`. Effects without the
  parameter no-op inside their wrapper (`safeApplyAudioParam`), so no
  capability list is needed. `panic()` clears the stack (writing 0 when a
  context exists), and a chain rebuild re-asserts the held hint on the fresh
  runtimes (lazy hot-swap mid-note).
- The processor treats a hint CHANGE as exact knowledge: `f0 = hint` snaps
  instantly, `untrackedPasses` clears, the untracked release and the
  generation gate stand down while a hint is live, and the deficit read runs
  at the known pitch. Between changes YIN and the crossing refinement still
  fine-tune toward the AUDIO (detune, vibrato, bends) — the hint is an
  initial condition, not a lock.
- `hintHz = 0` (note-off / release) hands acquisition back to pure YIN.
- **Live == offline by construction**: `when` is the same scheduled time in
  both paths and `setValueAtTime` is render-timeline state, so an
  `OfflineAudioContext` export receives identical hints with no event-queue
  gating (same contract as the M2 params).
- Not a user knob: `hintHz` stays out of `EFFECT_META` / `EFFECT_DEFS` (like
  kaskada's hidden `bpm`), the FULL SWEEP skips extra descriptors, and the
  telemetry frame gains a `hint` flag for the panel label.
- Scope: one pitch per track (top of the held stack). Preview auditions and
  ghost renders also write hints; a stale top-of-stack pitch only biases
  acquisition while silent audio renders nothing.

Measured: with a 55 Hz hint the generated 2nd is present at working level
within the first 60 ms (0.118 vs 0.000 without — the untracked gate holds
YIN-only generation off until ~90 ms); an automated 55→75 Hz hint glide
tracks with 0.20 % mean error (max 0.76 %); an untrackable 55 + 82.4 Hz
two-tone still generates at the hinted root (8.6× the YIN-only floor, the
deficit honestly generating the 2nd — no 110 in the input); clearing the
hint hands back to YIN with no gap. Locked by
`tests/audio-engine-pitch-hint.test.ts` (engine write path,
most-recent-wins, panic clear, safety) and the wave-8 block in
`tests/bass-harmonic.test.ts`.

## Addendum 10 (2026-10-11) — timbre profilers: PHASE + TILT

Two character axes over the generated stack, both bit-exact at their defaults:

1. **`phase` (0..1)** — a Schroeder-style quadratic profile (psi_n = phase x pi(n-2)^2/15)
   added as a static per-partial offset inside the output (`sin(p + psi_n)`,
   quadrature included) while the PLL keeps locking the accumulators to the
   input crossings. The spectrum and RMS are untouched — only the waveform's
   time shape changes: with the presence band active the ~7 comparable
   partials in 385–880 Hz crest at 11.4 dB aligned vs 5.6 dB dispersed
   (measured), so a phone-ready preset fits substantially more level under
   the same limiter. `phase = 0` is the legacy aligned stack, bit-exactly.
2. **`tilt` (−1..+1)** — a spectral slope `w_n *= n^tilt` applied to the raw
   weights before normalization: +1 flattens the tail toward a saw-like 1/n
   (buzzier, richer — measured high-band x2.4 vs neutral), −1 steepens toward
   1/n² (darker, rounder — high-band x0.33). Normalization keeps it a
   redistribution, not a level change at the full output.

**Preset adoption (loudness-measured, same wave):** 808 Phone `phase 0.4`
(the crest-reduced profile fits more phone-band level), Drill Growl
`phase 0.3` + `tilt 0.4` (saw-leaning buzz feeding FOLD), Subtle Body
`phase 0.6` + `tilt −0.25` (smooth and round); Club Sub deliberately stays
the legacy aligned reference (0/0). Re-measured with
`presets:fx-loudness`: Drill Growl target −25.0 → −24.9 LUFS (gain 3.5 → 3.4 dB)
and the BASS PHONE READY chain gain 0.7 → 0.6 dB; 808 Phone and Subtle Body
measured unchanged. Locked by the wave-9 block in
`tests/bass-harmonic.test.ts` (crest collapse with spectrum/RMS invariance
across phases; monotone phase ordering; tilt high-band redistribution and
2nd-harmonic trade against neutral) plus the preset-adoption pin (the bank
carries the characters; Club Sub stays neutral).

## Addendum 11 (2026-10-11) — 300 s flagship soak + denormal flushes

    ests/bass-harmonic-soak.test.ts gives GROW the AGENTS hardening gate

(parity with PRISM/VLYX/VØID/TWIST): two 300 s runs at 44.1 kHz over a
strictly loop-periodic staccato bass pattern (four notes, the last one
gliding, key pulses and per-note engine hints):

- **MOTION** (FOLD character, phase 1, presence 1, width 1, key PUMP, hint
  cycling): zero non-finite, zero subnormal outputs, zero subnormal internal
  one-poles, peak 0.670, flat CPU (early median 0.2045 ms → late 0.0971 ms
  per 128-sample block; the late run is the JIT-warmed one), heap growth
  1.1 MB.
- **STATIC** (pure YIN, no key/hint): drift between the 10 s and the 280 s
  windows 0.00025 dB (gate ≤ 0.003 dB, 12x margin), zero subnormals, heap
  0.0 MB.

The soak immediately justified a real fix: deficit2/3, nvFast and
nvLag were the only stateful one-poles without the 1e-20 flush, and their
targets sit at 0 for minutes on rich input or silence. Measured without the
flush: deficit2 decays to 4.94e-324 (the smallest Float64 denormal) within
120 s of a 55 + 110 Hz input — the soak's internal counter fires on every
10 s check. The flushes are in the same commit; the soak is the regression
pin for them.

## Addendum 12 (2026-10-11) — SCENE PACK (A/B pairs bound to scene intensity)

Nine curated A/B pairs (`src/effects/koren-scene-pack.ts`, Drill Phone →
Growl through Ambient Still → Bloom) carry the phone-intro → drop arc per
genre. GROW has no DSP-side morph scalar (unlike TWIST), so the pair
materializes through the engine's own modulation law instead of new DSP:
`applyKorenScenePair` (commands/korenScene.ts) is ONE undoable command that

1. stores both param maps on the effect's deviceState as `koren-scene-v1`
   (sanitized, known ids clamped against the GROW catalog, unknown dropped),
2. writes each param's MIDPOINT `(a + b)/2` as the live base, and
3. adds an intensity-sourced mapping per differing param with
   `amount = (b − a)/(max − min)`.

The engine resolves an intensity fxParam mapping as
`(max − min)/2 · bipolar · amount` around the persisted base
(`bipolar = intensity·2 − 1`), so intensity 0 lands side A exactly and
intensity 1 side B exactly — the intro scene is the phone-ready voicing, the
drop lands the growl, with no lanes to draw. Stepped ids (CHARACTER, RANGE,
RETRIG) cannot interpolate; the DSP rounds, so they switch at their rounding
boundary mid-swing (a CLEAN → SAT → FOLD character sweep plays as the three
characters, not a smear) — pinned by tests rather than described as morphing.

The command OWNS the effect's scene-intensity binding: any pre-existing
intensity mapping that targets this effect — wherever it lives — is rewritten
in the same command (two offset mappings to one param would stack and double
the swing), while macro-sourced mappings are left untouched. The binding is
idempotent across pair switches and the whole apply is one undo step.

Validation: `tests/koren-scene-pack.test.ts` pins the pack inside the rack
ranges (clamp identity, stepped ids integer), the A/B key PARITY the command
relies on, the ≥ 2-param contrast, the exact-match finder, the sanitizer
(clamp known, drop unknown, reject hostile blobs), the midpoint bases and the
endpoint arithmetic (`base ± halfspan = a/b`), the one-macro/one-mapping-per-
diff shape, the rewrite-not-stack behavior across pair switches AND against a
hand-made intensity mapping, and the non-GROW refusal. The panel suite covers
the select → apply wiring, the SCENE-INTENSITY chip, and the CUSTOM fallback
for hand-stored slots.

## Addendum 13 (2026-10-18) — key-mode change reset (recovery/quality audit)

**Finding.** `keyEnv` only advanced while a key mode was active, so switching
PUMP → OFF **froze** the envelope at its last value; switching back ON (or
PUMP ↔ DUCK) then applied that stale bloom as an **unsmoothed gain step** on the
generated layer — up to +6 dB within one block, the exact class of defect the
effect checklist §4 forbids (a per-sample gain that steps when a parameter
changes). The OFF window itself was inaudible (`keyGain` is 1 in OFF), which is
why no existing spec saw it.

**Fix.** `lastKeyMode` tracks the mode the envelope belongs to; ANY mode change
resets `keyEnv` to 0. OFF → ON and PUMP ↔ DUCK now start from rest and ride the
existing 2 ms key attack instead of jumping. Constant modes remain
bit-identical (the wave-4 PUMP/DUCK ratio and no-key no-op specs pass
unchanged).

**Pin.** `tests/bass-harmonic.test.ts` (wave-4 block) drives a constant hot key
through PUMP → OFF → PUMP block by block with the harness's new `perBlock`
hook: the bloom must exist before the switch (`keyEnv > 0.5`), the re-enable
must start from rest (`keyEnv < 0.1`), and it must settle again (`> 0.5`).
Falsification: removing the reset turns **exactly this spec** red
(`expected 0.8000000119209236 to be less than 0.1`) and leaves the other 42
green.

**Evidence.** All five KOREŇ suites green — 60/60 including the two 300 s
soaks; `tsc --noEmit` and Prettier clean. No other change to the effect.

## Addendum 14 (2026-10-18) — AI legibility + the robustness measurements

### 14.1 Every knob now explains itself to an agent

An MCP client saw only `presence: 0..1, default 0` — a range with no meaning —
so it could not distinguish PRESENCE (the phone band) from TILT (a spectral
slope) and had no way to choose values deliberately. `ParamDef` gains an
optional `description`; **every** KOREŇ parameter carries one sentence (what it
does, the direction, units, and the interaction that matters — PRESENCE needs a
wide RANGE, KEY MODE needs the engine's key feed, CHARACTER is generated-layer
only). `kyx_catalog subject:effect effect:bassHarmonic` prints it on an
indented line beneath each range line, and an effect without descriptions gets
no invented text.

Pin: `tests/koren-catalog.test.ts` — completeness over `bassHarmonicParams`
(a new knob cannot ship undocumented), the REAL catalog through the headless
MCP host (every description appears, the CHARACTER/KEY MODE option ladders are
present), and a no-leak negative (KOREŇ's text never appears in another
effect's listing). `hintHz` is deliberately absent from the definitions — the
catalog must not invent a parameter the engine alone writes.

### 14.2 The measurements Addendum 6.2 listed as required

- **Nyquist taper (8 kHz** — the only rate where the 16-partial ladder crosses
  Nyquist; f0 = 400 Hz, focus 220, range 4, presence 1, tilt 1, FOLD):
  the 2nd partial (800 Hz) is the reference; the 8th (3200 Hz) is present; the
  9th (3600 Hz) is **attenuated to under 0.7×** of the 8th although its raw
  weight is ~equal (that is the taper, not the ladder); the 10th (4000 Hz =
  Nyquist) is zeroed; and six between-harmonic bins (1000/1800/2600/3000/3400/
  3800 Hz) stay below 6 % of the 2nd — no shaping junk off the 400 Hz grid.
  Honest limit: **a DTFT bin above Nyquist is its own alias**, so "energy above
  Nyquist" is not measurable; the taper is proven by the attenuated 9th and the
  zeroed Nyquist partial instead.
- **Release clicks**: a 0.5-amplitude 55 Hz tone stopped dead at 0.4 s — the
  peak sample-to-sample delta after the stop stays under 1.5× the steady
  signal's own slew (+1e-3), and a hint jump 55 → 82.4 Hz stays under 2× the
  steady slew either side (the frequency change scales the slew; a click would
  be an order of magnitude above it).
- **Mono compatibility**: at WIDTH = 1 a fold-down keeps the generated 2nd
  (no null; theory cos 0.6 ≈ −1.7 dB), the side signal is real at the 3rd
  (165 Hz) and absent at the 2nd (110 Hz, below the 120 Hz mono crossover).

Pins live in `tests/bass-harmonic.test.ts`
(`GROW robustness — Nyquist taper, release clicks, mono compatibility`).
The only DSP change in this audit remains the key-mode reset of Addendum 13;
the rest of this addendum is documentation and measurement.

## Addendum 15 (2026-10-24) — the monitor-only audition: level-matched A/B + the harmonic branch alone

### 15.1 Why this needed a decision

The flaghip roadmap's wave 1 asks for one thing: a user must be able to
answer "did the harmonic layer help, or does it just sound louder?" Until now
KOREŇ had exactly ONE listening aid — PHONE CHECK, a monitor-only 350 Hz
highpass on the master path. It answers "can a phone reproduce this?", not
"what did KOREŇ add?".

Three ways to build the A/B, and only one of them is honest:

1. **Use `mix` as the switch.** `mix` is a PROJECT parameter. Switching it
   changes a saved value, an automation lane, the mix and the export. It is
   not an audition; it is an edit that pretends to be a comparison.
2. **A second worklet or a second graph branch.** The plugin's chain would
   grow a parallel path that must be kept in sync with the main path — and
   the export would inherit it unless it is branched out again.
3. **A runtime-only AudioParam on the existing processor.** The switch lives
   on the runtime, so nothing in the document can reach it.

Chosen: **(3)**, plus a level match, because a comparison without one is a
lie: "the effect sounds better" is otherwise "the effect is louder".

### 15.2 The contract

- `audition` (0..2) is a **plain AudioParam on the processor** — the same
  native mechanism the other 18 project parameters use, so it costs no port
  traffic and never depends on an open panel. **It is NOT a project
  parameter**: it is absent from `bassHarmonicParams`, from the catalog and
  from `EFFECT_META`.
  - 0 = the normal path, 1 = DRY (the input alone), 2 = HARMONICS (the
    generated branch `genL/genR` alone — the sub-anchor branch is the dry's
    own highpassed part, so it is not part of the "generated" branch).
- The **node wrapper refuses the id on the project sync path** (`setParameter`
  and `setParameterAt` drop it). This is the barrier, not a comment: a
  hand-edited or migrated document carrying `audition: 2` in `fx.params` must
  not be able to push an audition into a render. Only `setAudition` — the
  engine's runtime path — writes the parameter.
- **`EffectRuntime.setAudition?(mode)`** is an optional capability, like
  `setMetersEnabled?`. Only plugins with a real A/B surface implement it.
- **`AudioEngine.setFxAudition(trackId, fxId, mode)`** writes the mode to the
  runtime and remembers it per fx id, so a chain rebuild (an insert, a
  reorder, a bypass toggle — all of which dispose and recreate every runtime)
  re-applies the user's A/B position instead of silently snapping back to
  WET. The remembered mode dies with the effect it belonged to.
- **The export cannot inherit it.** The offline renderer builds its OWN
  `AudioEngine` (`src/rendering/renderer.ts`), and the mode is engine
  instance state — not document state. There is no command, no undo entry, no
  persistence path, and therefore nothing for an export to read.

### 15.3 The level match, and what it refuses to claim

The processor tracks three smoothed RMS values (0.3 s time constant, per-block
coefficient `1 - exp(-len/(tc·sr))`): the dry path, the normal output and the
generated branch. The auditioned path is scaled by `audOutRms / audSourceRms`
— computed from the PREVIOUS block, so it is a per-block step of a slowly
moving number, never a per-sample jump. The dry and generated paths carry the
`output` trim, so the trim cancels out of the ratio and the clamp only ever
reports a genuine level difference between paths.

The clamp is `[-12 dB, +18 dB]`. Inside it the match is exact; outside it the
panel says **MATCH LIMIT** — the comparison is then not level-neutral, and the
panel must not pretend otherwise.

**No false benefit.** At silence, or while the tracker holds nothing (so the
generated branch is empty), the source RMS is below the floor and the match
falls back to unity. The telemetry then reports `audDb = -120` and the panel
reads **NOTHING TO COMPARE** (or **NO HARMONIC LAYER** for the harmonic
branch). A panel that cannot measure must not display a gain.

### 15.4 The switch is a crossfade, not a cut

A hard cut between two level-matched paths is a click, and a click makes a
listening test useless. The processor keeps two slots (`audFrom`, `audTo`) and
a per-sample fade (10 ms) between them: the output is the equal-gain blend of
the two paths. A new request snaps the in-flight fade to its end state and
crossfades from there.

### 15.5 Evidence (measured, not asserted)

Measured with `scratch/measure-audition.mts` — the SAME script against the
parent commit `1f7ba68b` in a detached worktree and against the working tree,
same seed, same signal (a 55 Hz bass with 2nd/3rd content, `drive 0.9`,
`mix 0.6`, `focusHz 90`, `subAnchor 0.7`, `lowCut 45`):

| Measurement                 | Before (`1f7ba68b`) | After               | Verdict           |
| --------------------------- | ------------------- | ------------------- | ----------------- |
| normal path, SHA-256 of 3 s | `5821fcf9d22f3dd0`  | `5821fcf9d22f3dd0`  | **bit-identical** |
| normal path RMS [2,3 s]     | 0.267341            | 0.267341            | unchanged         |
| normal path peak            | 0.531550            | 0.531550            | unchanged         |
| normal path 55 Hz / 110 Hz  | 0.170551 / 0.060287 | 0.170551 / 0.060287 | unchanged         |

The audition itself (after only):

| Path      | RMS [2,3 s] | vs normal    | matchDb | audDb  | 55 Hz        | 110 Hz   |
| --------- | ----------- | ------------ | ------- | ------ | ------------ | -------- |
| DRY       | 0.263835    | **−0.12 dB** | −2.810  | +2.852 | 0.180585     | 0.043216 |
| HARMONICS | 0.255557    | **−0.39 dB** | +6.188  | −6.151 | **0.000387** | 0.053045 |

Read: the DRY path sits 0.12 dB from the processed path (level-matched, and
it is the input — the match ATTENUATES it because the processed path is the
quieter one: the 45 Hz highpass removes energy from a 55 Hz fundamental). The
HARMONICS path is lifted 6.19 dB to the processed path's level, and its
fundamental is **52.9 dB below** the processed path's — the dry fundamental is
gone and what remains is the generated stack.

**Pins.** `tests/bass-harmonic-audition.test.ts` (the REAL processor, driven
like the audio thread drives it): the level match on both paths (< 1 dB), the
DRY identity (the best-fit gain against the input explains the whole signal —
the residual is under 2 % of the path's RMS), the HARMONICS spectrum (the dry
fundamental under 20 % of the processed path's, the generated 2nd harmonic
above 3× the fundamental in the auditioned path), silence → no false benefit,
an untrackable input → no false benefit, the click guard (the transition's
max sample-to-sample slew under 5× the signal's own steady-state slew — a
hard cut would be orders of magnitude above it), and the barrier (the catalog
has no `audition`; the node wrapper refuses the id on the sync path and
accepts it only on the runtime path).

`tests/koren-audition-engine.test.ts`: the document is byte-identical before
and after `setFxAudition` and carries no field for the mode; the runtime
receives it; the mode survives a chain rebuild; the mode dies with the effect.

`tests/ui/KorenPanel.test.tsx`: the panel writes the mode to the engine (never
to a command), releases it on unmount, shows MATCHED / MATCH LIMIT / NOTHING
TO COMPARE from the PROCESSOR's own telemetry, disables the switch while the
worklet is degraded, and explains `lowCut` / `subAnchor` / `mix` behind a
disclosure — including the truth the DSP actually implements: **at `mix = 1`
the dry is gone**, so the sub below `lowCut` disappears.

### 15.6 What this addendum does NOT change

The normal path is untouched (bit-identical, measured above). The project
model, the schema, the command system, the automation and the export path
are untouched — there is no new field, no new command and no migration. The
worklet bundle is rebuilt (`public/bass-harmonic-worklet.js`, 11.9 KB) because
the audit measures the BUNDLE, not the source.
