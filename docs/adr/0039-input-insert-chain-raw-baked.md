# ADR 0039: Per-track input insert chain and raw vs baked recording mode

Date: 2026-10-11 · Status: Accepted · Scope: project model, audio engine, recording contract

## Context

ADR 0014 §3 put instrument and microphone recording in scope and stated a
contract: _"Recording remains raw, recoverable audio until the user chooses
processing or commit."_ A guitar or bass workflow needs an amp/cabinet stage
that colours the signal the way an interface input does — before the track FX —
not as another downstream rack effect. There was nowhere to put it.

Three readings on 2026-10-11 established what was actually missing:

- **Recording is not missing.** `PcmMicRecorder.ts`, `recordingInput.ts` and
  `latencyProbe.ts` already capture PCM in bounded worklet blocks, select a
  device, trim, and calibrate. ADR 0014 lines 16–22 say so.
- **The insert point is missing.** `grep "inputFx|preInsert|inputChain|ampTrack|inputBus|recordingChain"`
  over `src/` returned zero matches. `attachDryInputMonitor`
  (`AudioEngine.ts:551-589`) connects the source straight to `nodes.panner`,
  skipping `nodes.input`, documented as "avoids adding their latency". Today
  the path is dry-in, effects-on-playback.
- **The convolution already exists.** VØID loads user IRs (`ozvenaNode.ts`
  `loadUserIr`, worklet `loadIr`, upload UI at `EffectRack.tsx:777`).

There is no `AudioTrack`: `Track = DrumTrack | InstrumentTrack | GroupTrack |
GenerativeTrack`. Recorded audio lives on `InstrumentTrack`.

### Measured, not assumed

`tests/ozvena-cab-latency-spike.test.ts` (8 specs, 2026-10-11):

- `createConvolutionEngine(partitionSize = 2048)` is how `ozvenaProcessor.ts:321`
  builds the live engine, and `loadIr` takes
  `Math.max(partitionSize, recommendPartitionSize(irLength))` — so the
  configured value is a floor that never drops. Latency is pinned at
  **1024 samples = 21.33 ms @ 48 kHz, independent of IR length**.
- `recommendPartitionSize` would pick **128 (1.33 ms)** for a 30 ms cab IR, and
  still escalates for long IRs rather than degrading them.
- Lowering the floor **does not change the signal**: the best-aligning lag
  between partition 2048 and 128 is exactly 960 samples (= 1024 − 64, the
  documented latency delta) with a mean residual of 1.937e-10 against a
  5.873e-2 peak — a relative error of **3.3e-9**, i.e. double-precision
  roundoff. Partition size changes _when_ samples arrive, not _what_ they are.
- It costs **1.19x** CPU (realtime factor 0.013x → 0.015x). The CPU risk is
  therefore not a phase gate; the real cost of a floor change is that it alters
  VØID latency for every existing reverb project.

The first version of that equivalence assertion **failed** with a residual of
0.0866: two partition sizes carry different latency, so a sample-for-sample
comparison measures the offset, not the fidelity. It only proved anything once
it went looking for the offset instead of relaxing the threshold.

Reference hardware is identified, not chosen: **Universal Audio Volt 276**,
48 kHz, WASAPI shared 10 ms / exclusive 3 ms minimum
(`WINDOWS-AUDIO-SPIKE-2026-09.md`). The latency implications below are
**arithmetic on endpoint metadata, not measured round trips**, and are labelled
as such everywhere they appear.

## Decision

1. **`TrackInputInsert` is project state on `DrumTrack` and `InstrumentTrack`
   only.** It holds the effect chain, the recording `mode` and an optional
   whole-chain `presetId`. Absent means dry monitoring — the existing
   behaviour — so older projects are unchanged and carry no insert.

2. **`GroupTrack` and `GenerativeTrack` cannot own an insert.** A group is a
   routing bus with no armed input; a generative track produces audio rather
   than capturing it. Commands throw rather than accept a field the track
   cannot honour.

3. **Two recording modes, per track, chosen by the user.**
   - `raw` — the committed take is untouched input PCM. The chain runs on
     monitoring and playback only. **This is the ADR 0014 §3 contract.**
   - `baked` — the post-insert signal is what gets committed.
     `baked` is a deliberate, owner-approved relaxation of ADR 0014 §3, and the
     raw take is retained alongside the processed one in both modes: a `baked`
     take that destroys the raw take also destroys the double-tracking that is
     the reason to record raw at all.

4. **The insert chain runs before the track FX, on the armed input.** It is
   built through `AudioEngine.useContext` like every other node, and it is
   built by the same code path for live and offline rendering — a chain that
   exists only while recording breaks the parity contract in AGENTS.md §3.3.

5. **Every mutation is a command with full undo.** Undoing back to "no
   insert" removes the field rather than leaving an empty husk. Editing the
   chain nulls `presetId`, because editing a chain invalidates the
   whole-chain preset identity.

6. **The insert chain's own latency is reported, not inferred.** It is
   compensated through the existing PDC path. A chain that adds latency
   without reporting it is a chain that drifts against the project.

7. **Latency is disclosed, never promised.** Web capture on WASAPI shared mode
   projects to roughly 21 ms round trip on the Volt 276 (20 ms device + 1.33 ms
   insert) and Studio on ASIO exclusive to roughly 7 ms (6 ms + 1.33 ms). The
   first is marginal for unboxed guitar playing and the second is not. Both are
   arithmetic until `measureAudioRoundTrip()` runs on real hardware, and the UI
   must show measured numbers, never these projections.

## Alternatives considered

- **Post-FX recording only (an "amp track").** Rejected. It contradicts ADR
  0014 §3 outright, makes the recorded audio unrecoverable, and is exactly the
  choice this ADR exists to make explicit rather than to smuggle in. It remains
  available as `baked`, per user decision.
- **A global input chain instead of per-track.** Rejected. It cannot serve two
  simultaneous sources differently, which is a normal recording situation, and
  it would put device-adjacent state in the wrong place.
- **A new cab convolution engine.** Rejected on evidence: the existing core
  with a lower floor is 1.19x CPU and bit-equivalent after alignment.
- **Vendoring an open-source cab plugin.** Not available: the active
  alternatives (OrbitCab, Nave, AmpForge, Soundshed Guitar) are AGPL-3.0 /
  GPL-3.0. NAM A2 is MIT and remains the candidate for phase 2 amp modelling,
  but its **capture files carry their own licenses** and are a separate
  question from the engine's.
- **`normalizeProject` sanitizer for `inputInsert`.** Deliberately deferred,
  matching how `midiOutput`, `sampleIdB` and `velocityLayers` are trusted. A
  hostile-doc guard belongs with the engine work, where the effects it holds
  actually execute.

## Consequences

- Recording a guitar or bass through an interface finally has somewhere to put
  a cabinet, ahead of the track FX, and the choice of raw versus baked is the
  user's per track rather than an architectural accident.
- VØID's convolution latency is shared state. Changing the floor to make the
  insert playable changes reverb latency for every existing project, so that
  change must be pinned by a golden test and shipped deliberately — it is not a
  free optimization.
- `baked` weakens an invariant that was written down for a reason. What keeps
  the weakening honest is that the raw take survives it and the mode is
  explicit, per track, and undoable.
- The insert chain is a second place where latency enters the graph. Reporting
  it through PDC is not optional; an unreported insert latency is a silent
  drift between what a performer hears while recording and what the project
  plays back.
- Phase 1 of the roadmap is satisfied by this ADR; the code phases are tracked
  in `docs/IMPLEMENTATION-ROADMAP-INPUT-FX-CAB.md`.
- **Not claimed here:** any low-latency monitoring figure, any playable-guitar
  claim, any hardware certification. Those require the owner gate in Phase 7 of
  the roadmap against the Volt 276.
