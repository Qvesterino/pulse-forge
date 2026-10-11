# REZONANS — Vocal Formant + Key-Aware Harmonizer

**Status:** plan approved for execution (owner decisions D1–D5 below)
**Date:** 2026-10-11
**Effect type id:** `rezonans`
**Class:** flagship suite (6th, after `fxeq`, `ultina`, `ozvena`, `kaskada`, `morphdynamics`)

---

## 0. What this is

A vocal effect that does two things that no single effect in this repo does today,
and does them together, because doing them separately is why the current toolbox
cannot make a hyperpop / drill / house / R&B vocal:

1. **True formant shifting** — spectral envelope warp (cepstral lifter + frequency-axis
   warp) that is independent of pitch, so a voice can be transposed _without_ moving its
   vocal-tract colour, and a voice can be re-coloured _without_ moving its pitch.
2. **Key-aware harmony** — four harmony voices whose intervals are chosen from the
   project's key/scale and, optionally, the arrangement's chord track, so the stack
   lands on scale tones and chord tones instead of on fixed semitones.

### Non-goals (V1)

- No third-party plugin hosting. Native plug-ins stay a separate ADR (0014/0016).
- No stem separation, no AI re-synthesis, no generative harmony.
- No per-note MIDI harmony; the harmony reacts to the _singing_, not to a score.

---

## 1. Owner decisions

| #   | Decision                                                                              | Rationale (as given)                               |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------- |
| D1  | **Spectral** formant from the start (cepstral lifter + axis warp, ~43 ms latency)     | prefer the real thing over the cheap approximation |
| D2  | **Key + per-bar chord following** (chord-tone mode)                                   | harmony should react to the arrangement            |
| D3  | **Full production integration** — flagship class, own core, panel, goldens, soak, ADR |                                                    |
| D4  | **4 harmony voices**                                                                  | matches `HARM_VOICE_COUNT` precedent in MORPH      |
| D5  | **Name: REZONANS**                                                                    | fits the KOREN / SKRUTKA / KOPA series             |

---

## 2. Verified ground truth

Everything below was measured against the working tree on 2026-10-11, not recalled
from `AGENTS.md` (which is stale in several places — see §11).

### 2.1 The owner's three premises — all three confirmed

| Premise                                             | Verdict                    | Evidence                                                                                                                                                                                                                                      |
| --------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vocoder can only do formant within its own spectrum | **Confirmed**              | `src/audio-worklets/vocoder-processor.js` is an amplitude-transfer filterbank. `shift` retunes the _modulator_ bandpass centres to `f0 / 2^(shift/12)` (`:129`). No envelope is ever estimated, stored or rewritten.                          |
| MORPH harmonizer is BODY-only and interval-based    | **Confirmed**              | Body mask is a time-domain gain: `w * hfGate * gate` (`src/effects/morph-dynamics-core/dsp/harmony.ts:510`). `setParams` computes `ratio` from `interval + detune` verbatim (`:148-149`) — no detector, no scale, no key.                     |
| pitchCorrect is hard-tune without formant           | **Confirmed** (one nuance) | Its shift stage is the same time-domain COLA engine, so formants move with the correction. Nuance: it is not strictly _hard_ — `speed` maps τ from 150 ms to 4 ms (`:346`), so at `speed=0` it glides. "No formant control" is exactly right. |

### 2.2 The premise that was not on the list, and is bigger than all three

**`doc.key` is metadata-only. Nothing in `src/audio-engine/` reads it.**
The field's own docstring says so: `/** Optional musical key (display + scorepack). */`
(`src/project-model/types.ts:1214-1215`). Every consumer is non-audio: `src/ai/generator.ts:179`,
`src/vocal/adapt.ts:66`, `src/export/scorepack.ts:187`, `src/ui/DiceTray.tsx:591`.

**And `pitchCorrect`'s "key-aware" params have no writer at all.** `root` / `scaleMode`
appear only in the worklet, its node wrapper, `definitions.ts` and `browser-checks.ts`.
Zero writers in `src/ui` or `src/commands`. Those two sliders are set by hand and they
are the whole of the current key awareness in the audio path.

So "key-aware harmonizer" is not a parameter problem. It is a missing bridge. §4
specifies it, and — importantly — §4.3 shows it is **far cheaper than it looks**.

### 2.3 Reusable assets

| Primitive                                                          | Where                                                                                                                                             | Limits / notes                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YIN detector (difference function + CMND)                          | `src/audio-worklets/pitchcorrect-processor.js:73-174`                                                                                             | `ANALYSIS_W=2048`, `HOP=1024` (~21 ms), `MIN_HZ=70`, `MAX_HZ=800`, ~0.87 ms/pass (~4 % of one core). Clarity gate 0.75, calibrated: pure tone 0.85 / chord mush 0.61 / noise 0.12. **Module-scope in plain JS — copyable, not importable** (there is no shared DSP module between `src/audio-worklets/*.js` and `src/effects/*-core/dsp/*.ts`). |
| `snapCents(hz, rootPc, scaleMode)`                                 | `pitchcorrect-processor.js:180-202`                                                                                                               | Already takes a mask argument and does `mask & (1 << pc)` (`:193`). Accepting an arbitrary mask is ~10 lines.                                                                                                                                                                                                                                   |
| Laroche–Dolson phase propagation                                   | `src/audio-engine/phase-vocoder.ts:153-158`                                                                                                       | Correct formulation, incl. `princarg` wrapping and DC/Nyquist staying real. **No transient preservation** — `:12` says so explicitly.                                                                                                                                                                                                           |
| IFFT via conjugate trick + Hann OLA + sum-of-squares normalization | `phase-vocoder.ts:177-191`                                                                                                                        | Reusable verbatim.                                                                                                                                                                                                                                                                                                                              |
| Catmull-Rom fractional read                                        | `phase-vocoder.ts:77-87`                                                                                                                          | Zero outside — keep this property for the V1 (see §4.4 latency).                                                                                                                                                                                                                                                                                |
| Radix-2 FFT in the **audio thread**                                | `src/audio-worklets/kaskada-processor.js:379` (`runFft`), 2048 + Hann at `:109`                                                                   | Proof that a realtime FFT runs in a plain-JS worklet here. Kaskada is the precedent for a core doing spectral work on the audio thread.                                                                                                                                                                                                         |
| Vendored FFT per flagship                                          | `src/effects/ozvena-core/dsp/fft.ts`, `src/effects/ultina-core/dsp/fft.ts`                                                                        | **Each flagship vendors its own FFT.** REZONANS gets a third; it does _not_ import ozvena's (cross-suite dependency + reconciliation markers).                                                                                                                                                                                                  |
| Grain engine with per-grain parameter latch                        | `src/effects/morph-dynamics-core/dsp/harmony.ts:133-215`                                                                                          | `grainRatios[2]` (`:144`, `:183-188`) is the pattern for "a parameter changes without clicking".                                                                                                                                                                                                                                                |
| Body mask (transient/body split)                                   | `harmony.ts:484-512`                                                                                                                              | Sustainedness × HF-share gate × presence gate, band-limited 110 Hz–3.2 kHz. Reusable as REZONANS' unvoiced gate.                                                                                                                                                                                                                                |
| Click-free coefficient glide                                       | `src/audio-worklets/vowel-processor.js:131-140`                                                                                                   | 4 ms one-pole per block; per-block (not per-sample) application.                                                                                                                                                                                                                                                                                |
| Musical clock hooks on `EffectRuntime`                             | `syncBpm?(bpm, when?)` `src/effects/types.ts:69`; `onTransportStarted?(time, beatPhase, positionBeats?)` `:70`; `prepareOfflineRender?()`         | Already fanned out by the engine (`AudioEngine.ts:1695`, `:1023`, `:1888`).                                                                                                                                                                                                                                                                     |
| Time-stamped param over port                                       | `setParameterAt(id, value, when)` — flagship protocol, `src/effects/morphDynamicsNode.ts:99-102`                                                  | Worklet queues and applies when the render clock reaches `when`. Explicitly documented as existing _because_ offline renders collapse un-timed port writes.                                                                                                                                                                                     |
| Latency contract + PDC                                             | `getLatencySec?()` `types.ts:101`; `onLatencyChange` `:112`; `waitForLatencyReport` `:119`; `syncPdc()` `AudioEngine.ts:1754-1760`                | Chain latency is summed and compensated. **Hard ceiling: `pdcDelay = ctx.createDelay(0.2)` (`:1206`) = 200 ms.**                                                                                                                                                                                                                                |
| Chord data                                                         | `Arrangement.chords?: ChordEvent[]` `types.ts:843-849`; `ChordEvent = { id, startBar, lengthBars, root: 0–11, quality }` `:834-841`               | Whole bars, no overlap, pitch class not note. Docstring calls it "the harmonic map".                                                                                                                                                                                                                                                            |
| Chord / scale interval tables                                      | `src/project-model/chords.ts` `CHORD_INTERVALS`, `CHORD_QUALITIES`; `src/project-model/scales.ts` `SCALE_INTERVALS`, `SCALE_TYPES`, `snapToScale` | Host-side; the worklet receives masks, never tables.                                                                                                                                                                                                                                                                                            |

### 2.4 Hard gaps

| Gap                                          | Verdict                                                                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spectral envelope / cepstral / LPC machinery | **Zero.** Repo-wide grep for `cepstrum\|cepstral\|lifter\|LPC\|levinson\|linear prediction` returns no real hits in `src/`. Formant shifting is entirely new DSP. |
| Transient preservation in the phase vocoder  | Absent (`phase-vocoder.ts:12`). **Must be added** — see §3.3.                                                                                                     |
| Peak picking + phase locking                 | Absent anywhere. **Must be added.**                                                                                                                               |
| Arbitrary (user/host) scale bitmask          | `SCALE_MASKS` is a 3-entry literal (`pitchcorrect-processor.js:52-56`), `scaleMode` clamps 0–2.                                                                   |
| Key → audio path                             | Absent (§2.2).                                                                                                                                                    |
| Per-bar chord context in audio               | No effect anywhere reacts to a chord change. `chordAtTick` is used only by `PianoRoll.tsx` and `commands/chordTrack.ts`.                                          |

---

## 3. DSP architecture

### 3.1 Signal flow

```
                              ┌──────────────────────────────────────────┐
  input (stereo, 2 ch)       │ SHARED ANALYSIS (mono = 0.5(L+R))         │
        │                    │  Hann 2048 / hop 512 @48k = 93.75 fps    │
        ▼                    │  ├─ FFT ─────────────┐                    │
  ┌───────────┐               │  ├─ YIN → f0, clarity│  (hop 1024 = 21ms)│
  │ body gate │               │  └─ log|X| → cepstrum│                    │
  │ (transient│               │       → lifter → E(f) │  (refresh 1/2)   │
  │  reject)  │               └──────────┬───────────┴────────┬──────────┘
  └─────┬─────┘                          │                    │
        │ dry                    X (analysis spectrum)  E(f) envelope
        │                                │                    │
        │                    ┌───────────┴────────────────────┴─────────┐
        │                    │  PER VOICE × 4                          │
        │                    │   warp E'(f) = E(f/αᵥ)  [αᵥ = per-voice]  │
        │                    │   residual R = X / E                     │
        │                    │   Xᵥ = R × E'                             │
        │                    │   PV shift: adv = Hs × ratioᵥ             │
        │                    │   + peak phase locking                   │
        │                    │   IFFT → Hann → OLA                      │
        │                    └──────────────┬───────────────────────────┘
        │                                   │ 4× (gain, pan)
        │                          ┌────────┴────────┐
        │                          │ bus: 1/√n, gain │ → spread / width
        ▼                          └────────┬────────┘
  out = dry·(1−mix) + bus·mix
```

**The economics that make 4 voices affordable:** all voices share ONE analysis FFT.
They diverge only at synthesis. Per hop: 1 FFT + 2 cepstrum transforms + 4 IFFT ≈
7 transforms at 2048, 93.75 hops/s ≈ **660 transforms/s**, estimated 3–6 % of one core.
The estimate must be _measured_ (§10, P1), not trusted.

### 3.2 Cepstral envelope + warp (the formant stage)

Per frame, on the half-spectrum `X[0..N/2]`:

1. `L = log(max(|X|, ε))` — natural log; ε floor prevents `-Inf` on silent bins.
2. Compute the real cepstrum of `L` (FFT → IFFT of the symmetrically mirrored log-magnitude).
3. Lifter: keep quefrency bins below `qCut` (≈ 2.0–3.0 ms → quefrency bin index
   `qCut·fs`). Everything above is the excitation and is discarded from the envelope.
4. `E(f) = exp(cepstrum_lifted)` — the vocal-tract envelope.
5. **Warp:** `E'(f) = E(f / α)` where `α = 2^(semitones/12)`, sampled with
   log-frequency interpolation (uniform interpolation on a linear axis makes the
   perceived shift depend on frequency).
6. **Edge handling (must be specified, not improvised):** below ~80 Hz and above
   ~8 kHz the envelope is extrapolated by _edge-slope clamping_, not by zero-padding —
   zero-padding collapses the shifted voice at both ends and is audible as a
   mid-scoped "boxy" voice.
7. `R = X / E`, `X' = R × E'`. Guard `E ≥ ε` so a silent frame cannot produce `Inf`.

Refresh `E` every 2nd frame and interpolate between refreshes: vocal-tract envelopes
move far slower than 93 fps, and this removes 2 transforms from the hot path.

**Sanity property to pin in the golden vectors:** at `α = 1` the round trip must be
bit-comparable to the no-warp path within a stated tolerance. A formant shifter whose
identity setting colours the voice is a bug users hear immediately.

### 3.3 Phase vocoder + phase locking (transients)

Shift with `adv = Hs × ratioᵥ` and instantaneous frequency exactly as
`phase-vocoder.ts:153-158`. **Then** apply peak-locked phases:

1. Find spectral peaks in `X'` (local maxima above a magnitude threshold).
2. For each peak, take its phase and assign that phase to every bin within a
   neighbourhood (±2 bins, wider for broad peaks).
3. Integrate those locked phases across the frame with the same phase-advance rule.

This is the standard cure for phasiness and it is **not optional here**: `phase-vocoder.ts:12`
states the repo's PV has no transient preservation, and in a vocal the transients are
the consonants — the parts that carry the intelligibility. This is the single highest-risk
item in the project and the reason P1 exists as an isolated gate (§10).

### 3.4 Unvoiced / transient gate

Reuse MORPH's approach, not a new invention. When `clarity < threshold` or the body
mask closes, harmony voices fade to zero over ~10 ms and the dry passes untouched.
The dry path is never reconstructed or phase-shifted, so consonants cannot comb
against the harmony — the same invariant MORPH relies on (`harmony.ts:33-36`).

Note the asymmetry that must be respected: because the dry is delay-free and the PV is not,
the wet necessarily arrives late relative to the dry. That is handled by the latency
contract (§5), not by trying to time-align inside the processor.

---

## 4. The key / chord bridge

### 4.1 What the effect needs to know

| Input            | Source                                    | Form                                             |
| ---------------- | ----------------------------------------- | ------------------------------------------------ |
| Key root + scale | `doc.key` (`types.ts:1215`)               | `rootPc: 0–11`, `scaleMask: 12-bit`              |
| Chord lane       | `doc.arrangement.chords` (`types.ts:849`) | ordered `{ startBar, lengthBars, root, mask }[]` |
| Musical position | worklet's own clock (§4.3)                | sample counter                                   |

### 4.2 Correction to the 2026-10-11 working plan

An earlier draft of this plan proposed routing chords through the automation bridge as
scheduled `fxParam` writes, plus a new `syncHarmonyContext` hook on `EffectRuntime`, plus
per-window pushes from the scheduler. **Reading the flagship node protocol showed that is
the expensive route and it is not needed.**

`src/effects/morphDynamicsNode.ts` already ships:

- `processorOptions: { params: initial }` at construction (`:36`) — arbitrary host-side
  context can ride in at build time;
- `setParameterAt(id, value, when)` (`:99-102`) — time-stamped changes over the port,
  explicitly documented as existing _because_ un-timed port writes collapse in offline renders;
- `syncBpm` + `onTransportStarted` + `prepareOfflineRender` on the runtime, all already fanned out by the engine.

Therefore the bridge is: **one optional field on `EffectEnv`, and nothing else.**

### 4.3 The bridge, final form

**(a) One optional `EffectEnv` field.** `EffectEnv` today is `{ bpm: number; seed?: number }`
(`src/effects/types.ts:174-178`) and exists precisely to hand factories ambient project
context. Add:

```ts
export interface EffectEnv {
  bpm: number;
  seed?: number;
  /** REZONANS: project musical context for key-aware harmony. */
  harmonyContext?: {
    keyRootPc: number; // 0–11
    scaleMask: number; // 12-bit, bit n = pitch class n allowed
    chords: ReadonlyArray<{
      startBar: number; // integer, absolute bar
      lengthBars: number; // integer, ≥ 1
      rootPc: number; // 0–11
      chordMask: number; // 12-bit pitch-class set for this chord
    }>;
  };
}
```

The engine populates it at the FX-chain build site (`AudioEngine.ts:1145-1156`, where
`doc` is in scope). Cost: one optional field, one population site, zero scheduler
changes, zero automation-bridge changes, zero renderer changes.

**(b) Musical clock owned by the worklet.** REZONANS maintains its own bar position:

- `onTransportStarted(time, beatPhase, positionBeats)` seeds it.
- `syncBpm(bpm, when)` schedules a tempo change at `when`; between changes, position
  integrates from the processor's own sample counter.
- `prepareOfflineRender()` seeds it at position 0 — this closes the offline gap, because
  the renderer replays `setEffectiveBpm` per window (`renderer.ts:560`) but never calls
  `onTransportStarted`.
- Seek / loop: the engine re-seeds via `onTransportStarted`; the lane lookup is by absolute
  bar, so a seek simply re-resolves. This is why `ChordEvent.startBar` being an absolute
  integer matters.

**(c) Chord changes as timed port writes.** Even with a clock, the safest delivery is
belt-and-braces: when the host pushes a chord lane, REZONANS schedules the boundary
crossings itself from the clock; when the host edits a chord live, it sends
`paramAt("harmony.chordMask", mask, when)` per boundary. Both paths converge on the same
worklet-side resolver, so a missed live edit degrades to "resolves at the next boundary",
never to "wrong forever".

**(d) Mask derivation, host side.** `scaleMask` from `SCALE_INTERVALS[parseKey(doc.key).scaleType]`;
`chordMask` from `CHORD_INTERVALS[quality]` shifted by `rootPc`. The worklet receives
masks only — no scale table is duplicated in the worklet. This is what makes "arbitrary
user scale" a V2 feature that costs ~10 lines rather than a worklet rebuild.

### 4.4 Latency budget and its honest ceiling

PV with N=2048, Hs=512 needs analysis lookahead. The zero-latency trick MORPH uses
(`harmony.ts:201-203`, reads pinned to end at the write line) is **deliberately given up
in V1** — a spectral formant shifter cannot be causal. Expect ~32–43 ms algorithmic
delay; the exact figure must be measured and reported through `getLatencySec()` /
the `latency` port message, never guessed.

Constraints to respect:

- Must stay well under the **200 ms PDC ceiling** (`AudioEngine.ts:1206`). At ~43 ms it does.
- Offline export gets exact `setValueAtTime` PDC writes and a locked graph
  (`AudioEngine.ts:1893-1895`), so latency is handled correctly in bounce/stems/export.
- `waitForLatencyReport` must be implemented or `prepareOfflineRender()` will abort
  (`AudioEngine.ts:1836-1838`).

---

## 5. Parameter surface (doc scale)

Doc-scale is 0..1-ish and human-facing; the node bridges to DSP scale exactly like
`morphDynamicsNode.ts:23` does for `global.mix`. Every parameter below needs a
`ScaleBridge` entry in `src/effects/scale-bridges.ts` where it is not 1:1 — skipping
that is silent-wrong-automation failure mode #3.

### Global

| id        | range | default  | note                                                                  |
| --------- | ----- | -------- | --------------------------------------------------------------------- |
| `mix`     | 0..1  | 0.5      | dry/wet, doc scale                                                    |
| `glide`   | 0..1  | 0.35     | target-change smoothing, maps 0→80 ms, 1→5 ms                         |
| `quality` | enum  | balanced | `economy` 1024 / `balanced` 2048 / `fine` 4096 — drives latency + CPU |

### Formant

| id                  | range    | default | note                                                     |
| ------------------- | -------- | ------- | -------------------------------------------------------- |
| `formant`           | −12..+12 | 0       | semitones, global warp factor α                          |
| `formantVoiceScale` | 0..1     | 1       | how much per-voice α may deviate from global             |
| `envelopeSmooth`    | 0..1     | 0.5     | lifter quefrency, lower = follows the voice more closely |

### Harmony

| id            | range | default | note                                                  |
| ------------- | ----- | ------- | ----------------------------------------------------- |
| `harmonyMode` | enum  | degrees | `off` / `interval` / `degrees` / `chordTones`         |
| `voices`      | 1..4  | 4       | active voice count (bus compensates 1/√n)             |
| `spread`      | 0..2  | 1       | same law as MORPH (`harmony.ts:539-559`)              |
| `width`       | 0..2  | 1       | M/S on the bus, side HP at 150 Hz                     |
| `chordFollow` | 0..1  | 1       | blend between scale-derived and chord-derived targets |
| `bodyGate`    | 0..1  | 0.5     | how aggressively unvoiced material is excluded        |

### Per voice ×4 (`voice{n}.*`)

| id                  | range    | default              | note                                                   |
| ------------------- | -------- | -------------------- | ------------------------------------------------------ |
| `voice{n}.enabled`  | 0/1      | n<3                  |                                                        |
| `voice{n}.degree`   | 0..14    | 3,5,8,12             | scale degree / semitone target, mode-dependent meaning |
| `voice{n}.level`    | 0..1.5   | 0.7                  |                                                        |
| `voice{n}.pan`      | −1..1    | −0.6, −0.2, 0.2, 0.6 | constant-power, clamped at the speakers                |
| `voice{n}.formant`  | −12..+12 | 0                    | per-voice α, free within `formantVoiceScale`           |
| `voice{n}.humanize` | 0..1     | 0.15                 | deterministic timing/detune variation (§6)             |

### Detection

| id        | range   | default | note                                        |
| --------- | ------- | ------- | ------------------------------------------- |
| `minHz`   | 50..200 | 70      |                                             |
| `clarity` | 0..1    | 0.75    | calibrated against the measurements in §2.3 |

### Context (not user-exposed; arrives via `EffectEnv.harmonyContext`)

`keyRootPc`, `scaleMask`, `chordMask`, `chordResetBar`. Shown read-only in the panel
so the user can see _why_ the stack chose what it chose — otherwise chord-tone mode
looks arbitrary and they will file it as a bug.

---

## 6. Determinism

Invariant #4 (same seed + intent + project → same content) plus the live/offline parity law.

- No RNG anywhere. `env.seed` (`types.ts:176-177`) is available if a deterministic
  PRNG is ever needed; the grain/frame scheduling derives from the absolute sample
  counter, following `harmony.ts:119` ("grain phases derive from an absolute sample
  counter, never random").
- `humanize` therefore varies from a hash of the absolute sample counter and voice
  index — it must sound alive and be bit-identical between live and offline.
- Golden vectors must include a **two-variant ping-pong** check (render v1, v2, v1, v2:
  r1 must equal r3 and differ from r2). A mismatch is a render-path defect, not HMR noise.

---

## 7. File plan

```
src/effects/rezonans-core/
  dsp/fft.ts                       NEW  vendored-style radix-2 (own copy; do NOT import ozvena's)
  dsp/cepstrum.ts                  NEW  real cepstrum, lifter, log-freq axis warp
  dsp/phaseLock.ts                 NEW  peak picking + neighbourhood phase locking
  dsp/pitchTrack.ts                NEW  YIN port (from pitchcorrect-processor.js:73-174)
  dsp/voice.ts                     NEW  one harmony voice: warp + PV + lock + OLA
  dsp/frame.ts                     NEW  shared analysis (FFT, f0, envelope)
  dsp/harmony.ts                   NEW  4-voice bus, spread/width, chord resolver
  dsp/rezonansProcessor.ts         NEW  processor entry, port protocol
  contracts/parameterSchema.ts     NEW  namespaced param surface
  contracts/parameterIds.ts        NEW
  contracts/state.ts               NEW
  contracts/meters.ts              NEW
scripts/build-rezonans-worklet.mjs NEW  copy of build-morph-dynamics-worklet.mjs
src/audio-worklets/rezonans-worklet.entry.js NEW
src/effects/rezonansNode.ts        NEW  main-thread runtime (mirror morphDynamicsNode.ts)
src/effects/rezonans-params.ts     NEW  (mirror ozvena-params.ts) if the surface outgrows one file
src/ui/RezonansPanel.tsx           NEW  4 voice strips + key readout + mode
src/styles/21-device-panel.css     EDIT append panel styles
```

### Integration surface (mandatory, ordered)

1. `src/project-model/types.ts` — `| "rezonans"` in `EffectType` (~line 72).
2. `src/effects/types.ts` — `EffectEnv.harmonyContext` (§4.3a).
3. `src/effects/definitions.ts` — `REZONANS_PARAMS: ParamDef[]`, `REZONANS_PARAM_DEFAULTS`,
   `EFFECT_META` entry, append to `EFFECT_ORDER` **and** `FLAGSHIP_EFFECT_ORDER`.
4. `src/effects/registry.ts` — `EffectDefinition` + `EFFECT_DEFS` + `WORKLET_EFFECTS` (`"degraded"`),
   with the universal `isWorkletReady → bypassRuntime` guard.
5. `src/effects/scale-bridges.ts` — dual-scale params.
6. `src/audio-worklets/loader.ts` — lazy type + module URL (`assetUrl("/rezonans-worklet.js")`).
7. `package.json` — `build:rezonans` + `predev`/`prebuild` chains.
8. `scripts/check-bundle-size.mjs` — budget row (the script exits 1 if the artifact is missing).
9. `src/ui/EffectRack.tsx` — `lazy()` import + panel branch. **`dockLayout.ts` is not touched**
   (it contains no per-effect panel wiring today).
10. `src/effects/blurbs.ts` — one-line Add-Effect blurb.
11. `src/effects/presets.ts` / `role-presets.ts` / `chains.ts`, then regenerate
    `preset-loudness.generated.ts` via `npm run presets:fx-loudness`.
12. `src/intent/mix.ts` — signature param + alias regex so text intent can reach it.
13. `src/browser-checks.ts` — real check: load worklets → build chain → render → assert non-silence.
14. `docs/CURRENT-STATE.md` — effect count 54 → 55 + a flagship row.
15. `docs/adr/0038-rezonans-vocal-formant-harmonizer.md`.

### Engine touch (deliberately minimal)

`EffectEnv.harmonyContext` population at the FX-chain build site. **Nothing in the
scheduler, the automation bridge or the renderer changes.** If P2 starts growing beyond
that, stop and revisit this plan — the whole argument of §4.2 is that it should not.

### Schema

**No `SCHEMA_VERSION` bump.** A new `EffectType` is additive; `SCHEMA_VERSION = 21`
(`schema.ts:52`) has no effect-type migration branch, and `normalizeEffects` silently
drops instances whose type is missing from `EFFECT_META` (`schema.ts:769-775`) rather than
rejecting the document.

> ⚠️ That silent drop is the sharpest edge in this integration: **omitting the `EFFECT_META`
> entry deletes users' saved instances on load with no error.** It is step 3 above and it
> is not optional.

---

## 8. Modes

| Mode         | Behaviour                                                                               | Needs            |
| ------------ | --------------------------------------------------------------------------------------- | ---------------- |
| `off`        | dry only, bit-exact bypass                                                              | —                |
| `interval`   | fixed semitones per voice (today's MORPH behaviour, minus the body-only gate)           | nothing          |
| `degrees`    | target = key root + `SCALE_INTERVALS[degree]`, octave nearest the detected f0           | key              |
| `chordTones` | target = nearest chord tone at the current bar, blended with `degrees` by `chordFollow` | key + chord lane |

Octave selection: given detected `f0` and target pitch class, pick the octave whose ratio
lies closest to 1 within ±12 semitones, then **clamp the total ratio to [0.5, 2.0]**
(±12 st). Beyond that the PV quality and the vocal intelligibility both fall apart.

Unvoiced handling in every mode except `off`: `clarity < clarity` threshold or body mask
closed → hold the last ratio, fade the voice over ~10 ms, never chase noise.

---

## 9. Risk register

| Risk                                                       | Why it is real                                                                                            | Mitigation                                                                     | Verified when         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------- |
| **Phasiness / smearing on consonants**                     | repo PV has no transient preservation (`phase-vocoder.ts:12`); consonants _are_ the transients in a vocal | peak phase locking (§3.3) + body gate                                          | P1 golden + listening |
| **4 voices blow the CPU budget**                           | 7 transforms/hop at 2048 is an estimate, not a measurement                                                | `quality` enum; shared analysis; measure with `quality=fine` as the worst case | P1, before P3         |
| Latency exceeds PDC ceiling                                | `createDelay(0.2)` caps compensation at 200 ms                                                            | ~43 ms is well inside; assert `getLatencySec() < 0.2` in a test                | P3                    |
| Offline/live parity on chord changes                       | chord lane is the newest surface in the plan                                                              | parity golden (§10 P2)                                                         | P2, before P4         |
| A formant shifter whose identity setting colours the voice | classic cepstral-lifter failure                                                                           | α=1 round-trip golden (§3.2)                                                   | P1                    |
| Silent loss of saved instances                             | `EFFECT_META` omission drops instances silently (`schema.ts:774`)                                         | `tests/` binding test; explicit step 3                                         | P3                    |
| Params land on the wrong scale                             | dual-scale params without a `ScaleBridge`                                                                 | `scale-bridges.ts` step 5 + `param-range-coherence`                            | P3                    |
| Envelope warp collapses at band edges                      | zero-padding instead of edge-slope extrapolation                                                          | explicit edge rule (§3.2 step 6) + golden                                      | P1                    |

**The stop condition:** if phase locking cannot make consonants clean in P1, the honest
move is to stop and re-scope (cascade fallback, §3 of the working plan), not to ship a
spectral shifter that only sounds good on held vowels.

---

## 10. Phases and acceptance criteria

### P0 — ADR `0038`

Decisions D1–D5, the latency contract, the `EffectEnv` bridge argument, the deterministic
humanize rule, the stop condition. Written **before** P1.

### P1 — DSP core in isolation, zero project integration

Build `rezonans-core/dsp/*` and prove the sound from a real vocal recording, wired
standalone. Nothing in the project graph changes.

- **A1** golden: two-variant ping-pong bit-identical.
- **A2** α=1 round trip matches the unwarpred path within a stated tolerance.
- **A3** measured CPU for 4 voices at `quality=fine`, reported as a number.
- **A4** measured algorithmic latency, reported as a number.
- **A5** consonantal transients clean on a real phrase — **pass/fail by listening**, with
  the stop condition honoured.
- **A6** determinism: two renders of the same input are bit-identical.

### P2 — Bridge

`EffectEnv.harmonyContext`, engine population, worklet musical clock, chord resolver.

- **B1** key-only mode works with `chordFollow = 0`.
- **B2** chord-tone mode follows a chord change at the right bar, live.
- **B3** **parity golden**: live render vs `renderProject()` offline render of the same
  project with chord changes are bit-identical.

### P3 — Integration scaffolding

`EffectType`, `EffectEnv`, definitions, `EFFECT_META`, registry, node, loader, build
script, bundle budget. Effect appears in the rack and loads.

- **C1** effect loads and passes through audio 1:1 when `harmonyMode = off`.
- **C2** bundle budget respected; `npm run build` exit 0.
- **C3** saved instance survives a save → load → reload cycle (regression test for the
  `EFFECT_META` silent drop).

### P4 — Harmony

4 voices, all modes, unvoiced gate, spread/width, bus compensation.

- **D1** voice count 1..4 keeps level stable (1/√n).
- **D2** unvoiced material never produces harmony garbage.
- **D3** ratio always within [0.5, 2.0].

### P5 — Product

Panel, presets, intent aliases, blurbs, browser check.

- **E1** panel shows the key/chord it is currently honouring.
- **E2** factory presets audible via `npm run test:browser:factory-presets`.

### P6 — Gates

All of §11 green.

### P7 — Quality

Phase-locking tuning, transient preservation tuning, CPU headroom, `quality=fine`
path, V2 hooks (user scale override, per-voice humanize depth).

---

## 11. Test and gate obligations

| Gate                     | Command                                                                | Notes                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck                | `npm run typecheck`                                                    | clean                                                                                                                                                                         |
| Full suite               | `npm run test`                                                         | see `docs/CURRENT-STATE.md` for the current count                                                                                                                             |
| Expectations ratchet     | `npm run test:expectations`                                            | new reds **and** cured reds both fail                                                                                                                                         |
| Derivable-artifact drift | `npm run drift:check`                                                  | needs `docs/CURRENT-STATE.md` + regenerated goldens                                                                                                                           |
| Format                   | `npm run format:check`                                                 |                                                                                                                                                                               |
| Real-browser audio       | `npm run test:browser`                                                 |                                                                                                                                                                               |
| Factory preset QA        | `npm run test:browser:factory-presets`                                 |                                                                                                                                                                               |
| Production build         | `npm run build`                                                        | bundle budgets                                                                                                                                                                |
| **Plugin audit**         | `plugin-audit-checks.ts` sweeps every `EFFECT_META` param by RMS delta | a `peak > 0` check is explicitly worthless (`docs/NEW-EFFECT-CHECKLIST.md`)                                                                                                   |
| Param coherence          | `tests/param-range-coherence.test.ts`                                  | registry ↔ param cross-check                                                                                                                                                  |
| Functional audit         | `tests/plugin-functional-audit.test.ts`                                | `{ effect, proc, reg }` triple binding                                                                                                                                        |
| Golden suite             | `tests/rezonans-golden/`                                               | precedent: `tests/morph-dynamics-golden/`, `tests/ultina-vectors/`, `tests/fxeq-golden/`                                                                                      |
| Soak                     | `tests/rezonans-soak.test.ts`                                          | heap growth, drift, zero non-finite. Precedent soak says **120 s** (`tests/skrutka-soak.test.ts:75`), while `AGENTS.md` §6 claims 300 s — reality wins; state the real number |
| Live/offline parity      | §10 B3                                                                 | the only proof that the chord bridge is sound                                                                                                                                 |

Three rules from `docs/NEW-EFFECT-CHECKLIST.md` that will bite here:

1. Per-sample smoothing applied **per block** inflates τ by the block length. Vowel and
   svfilter each shipped ~100× too slow because of this.
2. `public/*.js` is generated — the audit reads the bundle, not your source. Rebuild
   before measuring.
3. `port.postMessage` DSP renders silent in offline export unless writes are time-stamped.
   The flagship `paramAt` protocol exists precisely because of this.

---

## 12. Where `AGENTS.md` is wrong about this

| AGENTS.md says                                                                       | Reality                                                                                                                                       |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| "48 core effects", "implement in `registry.ts` after the existing 36/42/48"          | 54 effects (`docs/CURRENT-STATE.md:17`); metadata is duplicated in `definitions.ts` `EFFECT_META` and **both** must be filled or `tsc` breaks |
| "Add a panel under `src/ui/<Name>Panel.tsx` and wire it into `src/ui/dockLayout.ts`" | panels are wired in `src/ui/EffectRack.tsx` (lazy import + type branch). `dockLayout.ts` has no per-effect panel wiring                       |
| flagship = vendored upstream plugin suite                                            | MORPH DYNAMICS is a self-authored flagship with `contracts/` and no vendoring. REZONANS follows MORPH, not the vendor recipe                  |
| `npm run drift:check` is separate                                                    | it is **release-blocking**: it fails on a count mismatch (`drift-check.ts:268-277`)                                                           |

---

## 13. Open items to resolve during P1

These are measurement questions, deliberately not answered in this plan because
guessing them is how formant shifters end up shipping wrong:

1. Exact algorithmic latency of N=2048 / Hs=512 at 48 kHz with the chosen lookahead.
2. Whether `envelopeSmooth` every-2nd-frame interpolation is inaudible at 4096.
3. The clarity threshold under real hyperpop vocals (double-tracked, heavily compressed,
   de-essed) — the 0.75 figure was calibrated on a clean tone and a chord mush, not on
   a mastered drill vocal.
4. Peak-locking neighbourhood width: ±2 bins is a starting point, not a result.
5. Whether `quality=fine` (4096) is viable at 4 voices or whether `fine` should be
   1–2 voices only.
