# ADR 0040 — REZONANS: spectral formant shifting + key-aware vocal harmony (flagship suite)

Date: 2026-10-11 · Status: Accepted · Scope: effects registry, flagship suite, `EffectEnv` contract, worklet latency/PDC, project musical context reaching the audio thread

## Context

The roster can pitch a vocal, but it cannot re-colour one, and it cannot harmonize one that is musical. Three separate walls, all measured on this tree before deciding anything:

1. **`vocoder` is not a formant shifter.** It is an amplitude-transfer
   filterbank: `shift` retunes the _modulator_ bandpass centres to
   `f0 / 2^(shift/12)` (`src/audio-worklets/vocoder-processor.js:129`) so a
   modulator peak lands on a shifted carrier band. No spectral envelope is
   estimated, stored or rewritten anywhere in that processor. Its formant range
   is bounded by its own 8/12/16-band grid, exactly as suspected — but the real
   reason it cannot serve is that it needs a second input and never touches the
   carrier's own spectral shape.
2. **MORPH's harmonizer is BODY-only and interval-only.** The body is a
   time-domain gain (`sustainedness × hfGate × presence gate`,
   `src/effects/morph-dynamics-core/dsp/harmony.ts:510`); the interval is
   `2^((interval + detune)/12)` and nothing else (`harmony.ts:148-149`). No
   pitch detector, no scale, no key. It is a transient-clean granular shifter,
   not a musical one.
3. **`pitchCorrect` has no formant control.** It reuses the same time-domain
   COLA engine, so formants ride along with the ≤200 ¢ correction. (It is not
   strictly _hard_-tune: `speed` maps τ from 150 ms to 4 ms, so at `speed = 0` it
   glides. "No formant" is exact.)

Behind those three sits a fourth, larger one that was not part of the request:

4. **`doc.key` never reaches audio.** The field's own docstring says it —
   `/** Optional musical key (display + scorepack). */` —
   at `src/project-model/types.ts:1214-1215`. Every consumer is non-audio
   (`src/ai/generator.ts:179`, `src/vocal/adapt.ts:66`,
   `src/export/scorepack.ts:187`, `src/ui/DiceTray.tsx:591`), and **nothing in
   `src/audio-engine/` reads it**. `pitchCorrect`'s `root`/`scaleMode` params
   look like the existing key bridge; they are not — they have **zero writers**
   in `src/ui` or `src/commands`. Two sliders a user drags by hand are the whole
   of current key awareness in the signal path.

And one that argues for it: repo-wide, `cepstrum|cepstral|lifter|LPC|levinson`
has **no real hits in `src/`**. No spectral-envelope machinery has ever been
written here. This is new DSP, not an integration.

What hyperpop / drill / house / R&B needs is those two axes together — a stack
that is in key _and_ re-coloured — and every existing tool supplies at most one.

## Decision

1. **REZONANS** (effect type `rezonans`, category `character`) is the sixth
   flagship suite, DSP in `src/effects/rezonans-core/`, shipped as its own lazy
   worklet `public/rezonans-worklet.js` via `scripts/build-rezonans-worklet.mjs`
   with its own bundle budget row. It follows MORPH DYNAMICS (self-authored
   flagship with `contracts/`), **not** the vendored-plugin recipe.
2. **Formant shifting is spectral: cepstral lifter + frequency-axis warp.**
   Per frame: `log|X|` → real cepstrum → lifter at a 2–3 ms quefrency cutoff →
   envelope `E(f)`; warp `E'(f) = E(f/α)` sampled on a **log-frequency** axis;
   residual `R = X/E`; `X' = R·E'`. At α = 1 the round trip must match the
   unwarpred path — a formant shifter whose identity setting colours the voice
   is a defect users hear on the first note.
3. **Envelope edges extrapolate by edge-slope clamping**, never zero-padding.
   Zero-padding collapses the shifted voice at both band ends and reads as a
   mid-scoped "boxy" voice. Below ~80 Hz and above ~8 kHz the slope of the last
   valid bin carries outward.
4. **Envelope refresh is every 2nd frame with interpolation** between refreshes;
   vocal-tract envelopes move far slower than 93.75 fps and this removes two
   transforms from the hot path. `quality = fine` (4096) is the worst case and
   is measured, not assumed.
5. **Pitch shifting is a Laroche–Dolson phase vocoder reusing the formulation
   already proven in `src/audio-engine/phase-vocoder.ts:153-158`, plus peak
   phase locking.** The repo's PV has **no transient preservation** — it says so
   at `phase-vocoder.ts:12` — and in a vocal the transients are the consonants,
   i.e. the intelligibility. Peak picking plus neighbourhood phase locking is
   therefore a **precondition for shipping**, not a quality pass.
6. **All four voices share one analysis FFT.** They diverge only at synthesis
   (different ratio, different α), so a hop costs 1 FFT + 2 cepstrum transforms
   - 4 IFFT ≈ 660 transforms/s at 2048. Per-voice α is then free, which is what
     makes "one voice natural, one shifted" cost nothing. The total per-voice
     formant displacement is `clamp(global + voiceShift × voiceScale, −12, +12)`
     semitones; the DSP and panel use the same resolver so the drawn ladder stays
     aligned with the rendered warp.
7. **Ratio is clamped to [0.5, 2.0] (±12 st).** Past that the PV quality and
   vocal intelligibility both fall apart.
8. **Unvoiced and transient source material stays audible at every wet mix.**
   Low YIN clarity holds the last ratio and fades the harmony voices over
   ~10 ms. A separate per-channel source delay is aligned to the STFT latency:
   its gain is full when no voice is being synthesized, follows the complement
   of the body gate on attacks, and falls away on voiced sustain. This preserves
   consonants and stereo image at 100% wet without pitch-shifting or phase-warping
   the source; the normal mix control remains bit-exact at zero.
9. **Harmony modes:** `off` (bit-exact bypass), `interval` (fixed semitones
   that preserve the singer's fractional pitch), `degrees` (target = key root +
   scale degree, nearest octave to the detected f0), `chordTones` (each voice's
   scale-degree target is pulled toward the current chord). `chordFollow = 0`
   selects the scale target and `1` selects its nearest chord tone; intermediate
   values use deterministic weighted candidate selection rather than blending
   two notes into an out-of-tune pitch.
10. **The key/chord bridge is ONE optional field on `EffectEnv`.** It is already
    `{ bpm, seed }` (`src/effects/types.ts:174-178`) and exists precisely to hand
    factories ambient project context; it gains
    `harmonyContext?: { keyRootPc, scaleMask, chords: [{ startBar, lengthBars,
rootPc, chordMask }] }`, populated at the FX-chain build site where `doc` is
    in scope. Masks are computed **host-side** from `SCALE_INTERVALS`
    (`src/project-model/scales.ts`) and `CHORD_INTERVALS`
    (`src/project-model/chords.ts`); the worklet receives masks, never a scale
    table. **Nothing in the scheduler, the automation bridge or the renderer
    changes.** An earlier draft of this plan routed chords through the automation
    bridge as timed `fxParam` writes plus a new `syncHarmonyContext` hook; the
    flagship node protocol already carries `processorOptions` at construction and
    a time-stamped `setParameterAt(id, value, when)` (`morphDynamicsNode.ts:36`,
    `:99-102`), which is both cheaper and safer. If implementation of this item
    starts growing past that, this ADR is being violated and must be revisited.
11. **The worklet owns its own musical clock.** Seeded by the existing
    `onTransportStarted(time, beatPhase, positionBeats)` and
    `syncBpm(bpm, when)` hooks, integrated from its own sample counter between
    tempo changes, and seeded at position 0 by `prepareOfflineRender()`. That
    last one closes the offline gap: the renderer replays `setEffectiveBpm` per
    window (`src/rendering/renderer.ts:560`) but never calls
    `onTransportStarted`. Chord lookup is by **absolute** integer bar
    (`ChordEvent.startBar`, `types.ts:834-841`), so seek and loop simply
    re-resolve.
12. **Latency is a declared contract, FFT size − 1 samples.** At 48 kHz the
    economy, balanced and fine tiers report 21.3, 42.6 and 85.3 ms. REZONANS
    deliberately gives up MORPH's zero-latency past-only read invariant
    (`harmony.ts:201-203`) — a
    spectral formant shifter cannot be causal. The processor reports measured
    latency over the port; `getLatencySec()` feeds `syncPdc()`
    (`AudioEngine.ts:1754-1760`), and `prepareOfflineRender()` writes exact
    `setValueAtTime` compensation and locks the graph. **The PDC delay is capped
    at 200 ms** (`ctx.createDelay(0.2)`, `AudioEngine.ts:1206`) — asserted in a
    test, because exceeding it silently produces an uncompensated export.
    `waitForLatencyReport` must be implemented or `prepareOfflineRender()` aborts
    (`AudioEngine.ts:1836-1838`).
13. **Parameters are AudioParams + time-stamped port writes**, never un-timed
    port writes — the flagship `paramAt` contract, for the documented reason that
    offline renders collapse un-timed port writes to the last value. Meters and
    telemetry may use the port; DSP parameters may not.
14. **Determinism: no RNG in the signal path.** Per-voice `humanize` applies a
    smooth, hashed pitch drift of up to ±15 cents, with new anchors every eight
    analysis frames. This avoids stepped MIDI-chord motion and keeps repeated
    live/offline renders bit-identical. Frame scheduling follows the processor's
    monotonic analysis-frame counter; it never calls `Math.random()`.
15. **No `SCHEMA_VERSION` bump.** A new `EffectType` is additive; there is no
    effect-type migration branch, and `normalizeEffects` drops instances whose
    type is absent from `EFFECT_META` (`src/project-model/schema.ts:769-775`)
    rather than rejecting the document.
16. **Fallback is honest:** `WORKLET_EFFECTS.rezonans = "degraded"` — a 1:1
    bypass with `degradedReason` until the module lands, replaced by the
    engine's hot-swap when ready.
17. **`interval` mode applies the semitone count directly; `degrees` mode
    resolves a pitch class to its nearest instance.** These are two different
    operations and must not share code. An interval IS a distance, so it is
    `f0_midi + d`, preserving the singer's fractional pitch and vibrato.
    Degrees and chord tones name a pitch CLASS, and the solver picks the nearest
    instance of it. Routing both through the
    pitch-class search made "an octave up" resolve to the singer's own note —
    the nearest note carrying the singer's pitch class is the note being sung
    — so the most basic request the mode exists for was silently a unison.
18. **Scale degrees WRAP past the end of the scale.** Every scale in the
    project model has 5 or 7 tones, so with a `0..14` degree range the octave
    and everything above it (degrees 7..14) resolved to "no tone", which the
    solver degrades to unison. Half the default four-voice stack was silent
    doubling. `nthScaleTone` now returns `degree mod scaleLength`, and `-1` is
    reserved for a mask that allows nothing — the one case that genuinely means
    "no scale yet" and must stay distinguishable from degree 0.
19. **The panel reads the solver's answer, never re-derives it.** The meter
    carries `voiceMidi` straight off `HarmonySolver.lastMidi`. A host-side
    recomputation would have to replicate the mask, the clarity gate and the
    unvoiced hold to match, and any divergence draws a harmony the audio is
    not producing — an instrument that lies about itself. Where the meter is
    absent the panel says "waiting" instead of guessing.

## Consequences

- The first effect in the repo whose parameters are derived from **project
  musical context**, and the first to use `EffectEnv` beyond bpm/seed. The
  contract grows by one optional field and nothing else changes shape.
- **The sharpest edge in the integration is not DSP.** Omitting the
  `EFFECT_META` entry silently deletes users' saved REZONANS instances on load
  (`schema.ts:774` filters without raising). It is a two-line step and it is not
  optional; a save→load→reload regression test guards it.
- Four voices at `quality = fine` is the CPU worst case and is measured before
  P3 lands. If it is not viable, `fine` is capped at 1–2 voices — that is a
  parameter-range decision, not a DSP rewrite.
- Projects that never use REZONANS never fetch its module
  (`lazyWorkletTypesInDoc` → `ensureWorkletsForDoc`, live and offline).
- Registry counts move **54 → 55 effects**; flagship count **5 → 6**; the
  Add-Effect menu gains one entry. Re-measured in the same commit
  (`docs/CURRENT-STATE.md`).
- Latency depends on quality: at 48 kHz REZONANS adds 21.3, 42.6 or 85.3 ms
  (economy / balanced / fine), compensated by PDC against the rest of the
  graph. Offline export is exact, not glided.
- The worklet DSP is new code that never existed here, so its golden vectors are
  the only thing standing between a formant shifter and a very expensive reverb.

## Validation contract

P1 is an **isolated gate**: the DSP is proved standalone, wired to a real vocal
recording, with **zero** changes to the project graph. It is where the risk is,
and it is deliberately before any of the 15 integration files.

- **P1/A1** determinism: three consecutive renders sample-identical; two-variant
  ping-pong (v1, v2, v1, v2) has r1 === r3 ≠ r2.
- **P1/A2** α = 1 round trip matches the unwarpred path within a stated tolerance.
- **P1/A3** measured CPU for 4 voices at `quality = fine`, reported as a number,
  not an estimate.
- **P1/A4** measured algorithmic latency, reported as a number, asserted
  < 200 ms (the PDC ceiling).
- **P1/A5** consonantal transients clean on a real phrase — pass/fail **by
  listening**, honouring the stop condition below.
- **P2/B3** live vs `renderProject()` offline parity on a project containing
  chord changes: bit-identical.
- **P3/C3** saved instance survives save → load → reload (the `EFFECT_META` trap).
- **P3/C4** `harmonyMode = off` passes audio 1:1 from a cold instance.
- **P4/D2** unvoiced material never produces harmony garbage and remains
  source-audible at 100% wet (synthetic sibilant regression);
  **P4/D3** ratio never leaves [0.5, 2.0].
- Registration binds: `EFFECT_PROC_PAIRS` + `WORKLET_CASES`,
  `tests/param-range-coherence.test.ts`, `tests/plugin-functional-audit.test.ts`,
  golden suite at `tests/rezonans-golden/` (precedent:
  `tests/morph-dynamics-golden/`, `tests/ultina-vectors/`), soak for heap /
  drift / zero non-finite, and a real-browser check through the shipped bundle.

**Stop condition.** If peak phase locking cannot make consonants clean in P1, the
honest move is to stop and re-scope to the cascade approximation (per-voice
formant-scaled peaking banks, zero latency, substantially less work), not to ship
a spectral shifter that only sounds good on held vowels. Hyperpop vocals are
consonant-dense; a shifter that fails there has no market.

## Consequences of the stop condition

Recorded deliberately: the cascade fallback is a different ADR-shaped decision
(zero latency, no `getLatencySec` requirement, no phase locking) and would
supersede decisions 2–5 and 12 of this ADR rather than amend them. Until P1/A5
passes, this ADR describes intent, not shipped behaviour.
