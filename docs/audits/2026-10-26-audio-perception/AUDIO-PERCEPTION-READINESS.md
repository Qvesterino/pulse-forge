# THE AUDIO PERCEPTION READINESS AUDIT — KYX / Pulse Forge

**Mode:** read-only, evidence-driven. No code was modified; the only artifact is this report.
**Date:** 2026-10-26 · **Repo:** `D:\pulse-forge` (browser DAW — Web Audio + AudioWorklet, TypeScript,
React 18, IndexedDB; Electron shell; MCP tool server) · **Method:** parallel evidence collection over
the analysis, engine, MCP, persistence and model surfaces (three structured sweeps, ~160 tool calls,
every claim below carries a `file:line` citation), plus targeted self-verification of the
load-bearing claims. Evidence classes: **Observed** (read directly), **Code-inferred** (derived from
code paths), **Measured** (numbers recorded in repo docs/tests), **Hypothesis**, **Not verified**.

> **Commit at time of audit:** `26adf66f` (main). A parallel session was landing
> `lowEndMeasure.ts`/`lowEndRender.ts` (`tests/lowend/measure.test.ts`) during collection — noted as
> in-flight, not audited.

---

## 1. Executive Verdict

**Readiness level: Tier A for deterministic perception; prototype tier for model-based semantic
perception.** The central question — _can an AI reliably hear, locate, characterize and reason about
the actual audio being produced?_ — is answered **yes for hear/locate/characterize** through an
unusually deep deterministic DSP layer (BS.1770 LUFS with spec-vector tests, ITU-R true peak,
multi-band transcription of tempo/key/chords/bass/drums, onset detection, YIN pitch, HPSS +
gated-ONNX stem separation, mix diagnostics with callable fixes), **partially for reason**: the AI
consumes bounded, verdict-shaped tool results (`kyx_render_summary`, `kyx_diagnose_mix`,
`kyx_meter`, `kyx_unsuno transcribe`) rather than raw audio, which is the right shape — but there is
no unified analysis contract tying those results to project revisions, and semantic audio
understanding beyond a q8 AST tagger does not exist.

**Strongest assets** (each would be expensive to rebuild):

1. **One engine, two clocks** — analysis can run on the SAME `renderProject` path playback uses
   (`src/rendering/renderer.ts:525`), with per-track renders (`track-renderer.ts:17`) and a PDC
   settle barrier (`renderer.ts:744`). What the AI is told about is what the mix actually is.
2. **Honesty as a designed property** — analyzers return `null` rather than guess
   (`audio-tempo-key.ts` crest/chroma/concentration gates; `transientProfile.ts:169`; HPSS near-silence),
   with absolute floors pinned in `tests/honest-gates.test.ts`.
3. **Never-throw worker isolation with watchdogs** — every analysis client (stem model, AST tagger,
   STT, onset, warp, ultina) is lazy, timeout-bounded, circuit-broken, and resolves `null` on failure.
4. **Zero off-device audio egress** — a negative sweep found no path carrying audio bytes to a
   network host; models are on-device or localhost (`§10`).
5. **MCP exposure shaped for bounded context** — numbers and verdicts with callable fixes, not
   spectrogram dumps.

**Biggest blockers** (detailed in §13): no unified
`AudioAnalysisRequest/Result` contract with provenance/revision; caches keyed on `bufferId` +
geometry rather than audio content; the Yjs-backed store reports `null` revision so the MCP
staleness lattice skips enforcement; frozen-loop playback ignores scene BPM pins (tick→seconds
mismatch); and there is no analysis job manager (queue/priority/backpressure) for bulk perception.

**Model-agnosticism:** real, not aspirational — ONNX manifests pin `modelHash` (sha-256) and
`gatePassed`; a candidate artifact never activates (`model-loader.ts:33`); runtime selection probes
WebGPU→WASM at session creation (`stem-model/client.ts:56`); the one text LLM (LFM2.5 SFT, q8) is
localhost, TEXT-only, kill-switched, and strictly downstream of a deterministic router
(`model-route-gate.ts:144`). **LFM 2.5 Audio 1.5B** is noted in §6 as an unverified external
candidate — nothing in this repository integrates it, and no claim about its music capabilities is
made here.

---

## 2. Audit Coverage & Evidence Ledger

| Inspected                   | Evidence                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine taps/threading       | `AudioEngine.ts:1904-1918, 2110-2235, 4208-4244`; `masterChain.ts:933-1006`; `meteringRig.ts:36-374`; `rafLoop.ts:27`                                                                                                                                                                                                                                             |
| Metering/LUFS/true-peak     | `metering.ts:38-621`; `kweighting.ts:25-61`; `kwmeter-node.ts:39-66`                                                                                                                                                                                                                                                                                              |
| Offline render + stems      | `renderer.ts:50-785`; `track-renderer.ts:17-25`; `rendering/stems.ts`; `export/scorepack.ts:59`                                                                                                                                                                                                                                                                   |
| Recording                   | `PcmMicRecorder.ts:162-966`; `pcmRecording.ts:41-129`; `take-scoring.ts:1-30`                                                                                                                                                                                                                                                                                     |
| Workers                     | `audio-workers/{onset-detector,warp-render,ir-generator,pitch-tracker,hum-onsets}.ts`; `reference/workers/reference.worker.ts:18-36`                                                                                                                                                                                                                              |
| Analysis DSP                | `analysis/{mixDoctor,sectionMixDoctor,transientProfile,audio-tempo-key,vlyxClaim,levelMatch,hpss,similarity-advisory}.ts`; `ultinaAnalysis{Client,Worker}.ts`; `ultina-core/analysis/featureExtractor.ts`                                                                                                                                                         |
| Perception-adjacent AI      | `ai/audio-features.ts`; `ai/features/pattern-features{-v2}.ts`; `ai/ranking/*`; `intent/voice-take.ts`; `intent/groove-extraction.ts`; `kopa/forge.ts`; `reference/transcribe.ts`                                                                                                                                                                                 |
| MCP exposure                | `mcp/tools.ts` (`kyx_meter` :2545/6246, `kyx_render_summary` :2919/7314, `kyx_diagnose_mix` :2940/7336, `kyx_loudness` :2832, `kyx_unsuno` :3215); `mcp/meters.ts`; `mcp/render-summary.ts`; `mcp/mix-diagnosis.ts`                                                                                                                                               |
| Models/caching              | `public/models/**/manifest.json`; `intent/model-loader.ts`; `analysis/stem-model/{client,gate}.ts`; `ai/packs/{modelPackManager,registry}.ts`; `persistence/FrozenBufferRepository.ts`; `rendering/freezeSignature.ts`; `warpManager.ts:37-246`                                                                                                                   |
| Timeline                    | `project-model/types.ts:1` (PPQ 480); `schema.ts:609-641`; `scene-time.ts:16-151`; `rendering/tempoMap.ts`; `scheduler/Scheduler.ts:1033-1178`; `permissionLattice.ts:104-147`; `mcp/revision.ts`                                                                                                                                                                 |
| Tests                       | `honest-gates`, `kweighting`, `truepeak-ebu`, `aliasing-truepeak`, `mix-doctor{,-verdict}`, `transient-profile`, `level-match`, `ultina-vectors`, `vlyx-claim`, `voice-take`, `onset-detector-client`, `kopa/forge`, `unsuno/golden-set`, `audio-reference`, `reference/key-chroma`, `intent-ranker-golden`, `hum-to-melody`, `hum-harmonize`, 300 s plugin soaks |
| **Unknowns / not verified** | Runtime audio under real recording+playback+analysis load (no benchmark was run — see §9 plan); perceptual quality of any analysis (no human eval exists for perception outputs); WebGPU availability matrix in the wild (S5 measurements recorded in-repo, not re-measured here); mobile/thermal behavior                                                        |

---

## 3. Audio Signal-Flow & Threading Map (evidence-linked)

```
 ┌── AUDIO THREAD (AudioWorklet, 51 registered processors; AGENTS.md invariant:
 │    "custom realtime DSP, never the main thread") ──────────────────────────
 │   strip chains (tracks/groups/returns) → MasterChain → destination
 │   ├─ kwmeter worklet: K-weight + block loudness → posts SCALARS {m,s,i}
 │   │    (kwmeter-node.ts:58-66; coefficients computed main-thread, shipped
 │   │    via processorOptions :39-47 — audio thread does no allocation)
 │   ├─ per-FX meter FRAMES (worklet-posted, transferred Float32Array):
 │   │    kaskada bands (kaskada-processor.js:460), compressor GR, envfollower,
 │   │    KOREŇ f0/clarity/harm/key (bass-harmonic-node.ts:16,62-131)
 │   ├─ rt-monitor-processor.js:52 (callback-load counters)
 │   └─ capture-processor.js:70 (live master tap for null tests) /
 │      recording-capture-worklet.js:152 (mic PCM, transferred, durable-acked)
 │
 ├── MAIN THREAD (MeteringRig on the one-bus rAF, rafLoop.ts:27) ─────────────
 │   AnalyserNode reads (per-strip post-fader fftSize 2048, AudioEngine.ts:2232;
 │   pre-fader lazy per-strip toggle :1904-1918 — ADR 0048 budget 209→109),
 │   master taps: post-limiter spectrum, L/R, spectrogram, low/mid/side
 │   (masterChain.ts:933-1006 → MeteringRig.attachMasterTaps meteringRig.ts:99)
 │   4× true-peak oversample, correlation, LUFS fallback (meteringRig.ts:258-270;
 │   12 ms TTL so 3 rAF consumers share one computation)
 │   → UI (Meter.tsx:44, MasterMeter.tsx:104, LoudnessHistory.tsx:7) and AI via
 │     MCP kyx_meter (mcp/meters.ts:20-31)
 │
 ├── WORKERS (offline/near-RT analysis; all never-throw, watchdogged) ────────
 │   onset-detector (flux+adaptive threshold) · warp-render (phase vocoder,
 │   worker only ≥2 s, 120 s watchdog, deterministic sync fallback) ·
 │   pitch-tracker (YIN, 70–1050 Hz, clarity 0.5) · hum-onsets (envelope dip) ·
 │   reference.worker (transcription jobs; separation "off"|"hpss"|"model") ·
 │   ultinaAnalysisWorker (VLYX: STFT 2048/1024, 10 octave bands, 3-min
 │   watchdog, cancellation via terminate) · stem-model client (htdemucs ONNX,
 │   WebGPU probe → WASM SIMD, chunked overlap-add, never-throw → HPSS Tier-1)
 │
 └── OFFLINE (the SAME engine on OfflineAudioContext) ────────────────────────
     renderProject(doc, bank, {sampleRate, mode, quality, AbortSignal})
     → float32 stereo AudioBuffer (renderer.ts:525-785; PCM budget cap 320 MiB
     :107; PDC settle :744; unfreeze-and-re-render :495)
     → kyx_render_summary (per-strip BS.1770 LUFS + peak + crest, master
       bypassed per strip), mixDoctor, mastering scorepack (48 kHz),
       export WAV 16/24/32f, unsuno transcription
```

**Boundary discipline (Observed):** the audio thread hosts only DSP and scalar/transferable posts;
every heavy analysis (true-peak oversampling, LUFS gating, FFT features, transcription, separation)
runs main-thread-bounded or in workers. `pcmRing.ts:122` documents the audio-thread consumer as
never-blocking.

---

## 4. Audio Tap-Point Matrix

Legend: availability during **S**topped / **P**layback / **R**ecording / **O**ffline-render /
**E**xport. Risk: 🟢 low · 🟡 medium · 🔴 high.

| #   | Tap point                                                 | Signal stage                  | Format / clock                         | S/P/R/O/E | Reflects FX·automation·PDC·mute                  | Access                                            | Risk                                            | Evidence                                                   |
| --- | --------------------------------------------------------- | ----------------------------- | -------------------------------------- | --------- | ------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| 1   | Per-strip post-fader analyser                             | track post-fade               | f32, ctx rate, fft 2048, live clock    | −/✓/✓/−/− | yes (graph position), PDC yes, mute kills signal | sync rAF pull                                     | 🟢 budgeted (ADR 0048)                          | AudioEngine.ts:2232                                        |
| 2   | Per-strip PRE-fader analyser                              | post-insert/pre-fade          | same                                   | −/✓/✓/−/− | insert chain yes, fader no                       | lazy toggle                                       | 🟢 lazy (209→109)                               | AudioEngine.ts:1904                                        |
| 3   | Master taps (spectrum, L/R, spectrogram, low/mid/side)    | post-limiter master           | same                                   | −/✓/✓/−/− | everything incl. limiter                         | sync rAF                                          | 🟢                                              | masterChain.ts:933-1006                                    |
| 4   | kwmeter worklet                                           | master K-weighted             | scalars {m,s,i}                        | −/✓/−/−/− | yes                                              | message                                           | 🟢 scalar-only                                  | kwmeter-node.ts:58                                         |
| 5   | Per-FX meter frames (KOREŇ f0/clarity, kaskada bands, GR) | in-processor                  | frame Float32Array                     | −/✓/−/−/− | per-device                                       | message, throttled                                | 🟢                                              | bass-harmonic-node.ts:16                                   |
| 6   | `renderProject` full mix                                  | final master (offline)        | f32 stereo, caller rate 44.1/48k       | ✓/−/−/✓/✓ | everything; deterministic; PDC settle            | batch (PCM)                                       | 🟡 320 MiB cap                                  | renderer.ts:525-785                                        |
| 7   | `renderTrack` per-strip                                   | post-strip into master-params | f32 stereo                             | ✓/−/−/✓/✓ | strip chain + group + sends; master bypassed     | batch                                             | 🟢                                              | track-renderer.ts:17                                       |
| 8   | Stem renders (drums/bass/music) + user stems              | group bus                     | f32 → WAV                              | ✓/−/−/✓/✓ | group chains                                     | batch                                             | 🟢                                              | rendering/stems.ts                                         |
| 9   | Mic capture (PcmMicRecorder)                              | recording input               | planar f32, 0.5 s chunks, device clock | −/−/✓/−/− | pre-DSP raw; input meter analyser                | durable chunks → `materializePcmTake` AudioBuffer | 🟡 device-latency offset (localStorage ±500 ms) | PcmMicRecorder.ts:175,912-966; recordingAlignment.ts:19-28 |
| 10  | Take PCM (recorded)                                       | source media                  | f32 via reassembly                     | ✓/✓/✓/✓/✓ | raw (no FX)                                      | pure analyzers (take-scoring)                     | 🟢                                              | pcmRecording.ts:70                                         |
| 11  | SampleBank AudioBuffers                                   | source media                  | decoded f32                            | ✓/✓/✓/✓/✓ | none (source)                                    | sync channel data                                 | 🟡 no peaks cache; redraw cost                  | audioClipChannels.ts:25                                    |
| 12  | Frozen track buffers                                      | rendered-at-freeze            | WAV in IndexedDB + signature           | ✓/✓/−/−/− | frozen at freeze time                            | rehydrate                                         | 🔴 scene-BPM offset gap (F-4)                   | FrozenBufferRepository.ts:26-43                            |
| 13  | Warp/stretch cached renders                               | time-stretched clip           | f32, keyed bufferId+rate+pins          | −/✓/−/−/− | warp pins yes; trim applied at play-window       | cached jobs                                       | 🟡 key not content-hash                         | warpManager.ts:58-87                                       |
| 14  | Stem separation (Tier1/2)                                 | decoded source → 4 stems      | f32 planar + EP label                  | ✓/−/−/✓/− | source-domain                                    | worker batch                                      | 🟢 never-throw, gated                           | stem-model/client.ts:33-108                                |
| 15  | Live↔offline null-test tap                                | master capture                | transferred f32                        | −/✓/−/✓/− | full                                             | worker                                            | 🟢                                              | capture-processor.js:70                                    |

**Missing / Unknown:** no send-only or bus-only live tap (bus audio reaches analyser via strip
parallels only for groups/returns — `AudioEngine.ts:2110,2163`); no pre-FX _send_ stage tap;
`Unknown` = SpectrogramTrackAnalyser reuse cost under 100-track load (budgeted, not re-measured).

---

## 5. Timeline/Alignment Contract Review

**What exists (Observed, strong):**

- One musical-time owner: PPQ 480 (`types.ts:1`), bar length via `ticksPerBar(doc)` — **required-arg,
  never defaulted to 4/4** after ADR 0056 (`schema.ts:609-641`).
- Scene-Mode tempo is a single mapping used by BOTH playback and edit math: `tempoAtTick` +
  `buildArrangementSpans` + piecewise integral (`scene-time.ts:39-151`), mirrored offline by
  `rendering/tempoMap.ts`; the invariant "edit math must convert bars↔seconds at the SAME tempo
  playback uses" is written at `scene-time.ts:31-38` and enforced by audit waves (ADR 0056/0057
  suites, meter-disclosure ledger).
- Offline renders pass a PDC settle barrier before measurement (`renderer.ts:744`), and live↔offline
  parity has a dedicated null corpus (`verify-browser` FX null test; earlier runs measured −39 dB…
  class outliers with documented realtime-nondeterminism semantics).
- Project revision: monotonic per store (`ProjectStore.ts:50-55,572`), surfaced to MCP
  (`mcp/revision.ts:11`), enforced by the permission lattice against declared plan revisions
  (`permissionLattice.ts:104-147`) with a per-field `WriteConflict` fallback (`write-conflict.ts`).

**Where an AI could point at the wrong musical moment (all Code-inferred):**

- **F-4 (correctness, frozen audio):** `frozenPlaybackOffset` maps tick→seconds using **doc.bpm only**
  (`warpManager.ts:444-448`) — a frozen loop under a scene BPM pin plays/aligns at project tempo.
  Analysis reading frozen-buffer audio inherits the mismatch. Pre-existing playback behavior, not
  introduced by analysis.
- **F-5 (perf, not correctness):** `warmWarpForClip` prewarms at project BPM while the trigger keys
  on scene tempo — mismatched keys simply miss and re-warm (`warpManager.ts:151-161`, documented).
- **Stretch cache keys omit trim/offset/warp geometry** (`triggerEngine.ts:508` key =
  `bufferId|rate|reverse`); trim applies at play-window time — correct for playback, but any future
  cache that assumed the key fully identifies the AUDIO WINDOW would be wrong.
- **Recording alignment** is a per-input-device localStorage offset ±500 ms
  (`recordingAlignment.ts:19-28`) — recorded-take analysis inherits whatever the user calibrated.
- **Collab/Yjs:** the Yjs-backed store reports `null` revision → the lattice SKIPS the staleness
  rule and falls back to per-field diffing (`mcp/revision.ts:4-9`) — an AI plan in a collab session
  has no document-age guarantee.

**Proposed canonical time-coordinate contract (PROPOSAL, not implemented):** every analysis result
carries `{ projectId, projectRevision, scope: {kind: track|clip|bus|master, id, takeId?},
window: {startTick, endTick, startSec, endSec, sampleRate}, tempoContext: [{fromTick, bpm}],
stage: "source|clip|track|bus|master", algorithm: {name, version, featureVersion}, confidence }`,
with `projectRevision` mandatory for post-FX stages and `null`-revision stores required to say so.
Seconds SHOULD be computed by `scene-time.ts`/`tempoMap.ts` only.

---

## 6. Perception Capability Matrix

Scale: **I**mplemented / **E**xposed-to-AI / **T**ested / **Q**uality-known / **M**issing.

| Domain     | Capability                                                                       | I                                                       | E                                                            | T                                              | Q                                                | Evidence + notes                                              |
| ---------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| Signal     | peak / RMS / crest / clipping                                                    | ✓                                                       | ✓ (`kyx_meter`, `kyx_render_summary`, mixDoctor)             | ✓                                              | ✓ spec+genre-calibrated                          | metering.ts:367; mixDoctor.ts:153-61                          |
| Signal     | true peak (ITU-R BS.1770-5 4×)                                                   | ✓                                                       | ✓                                                            | ✓ EBU Tech 3341 vectors                        | ✓                                                | metering.ts:566-621; truepeak-ebu.test                        |
| Signal     | LUFS M/S/I (BS.1770-4)                                                           | ✓                                                       | ✓ (`kyx_loudness` measure→trim→verify, `kyx_render_summary`) | ✓ spec vectors incl. dual gate, <400 ms        | ✓                                                | kweighting.ts:25-61; kweighting.test:108-158                  |
| Signal     | stereo correlation / width / mono-loss                                           | ✓                                                       | ✓                                                            | ✓                                              | ✓                                                | metering.ts:383; mixDoctor.ts:340                             |
| Signal     | spectral centroid/rolloff/flatness/harmonicity                                   | ✓ (v2 features)                                         | ✗ internal ranker features only                              | ✓ (feature tests)                              | partial (ranking utility, not absolute accuracy) | audio-features.ts:22-40                                       |
| Signal     | 7-band energy shares / DC / headroom                                             | ✓                                                       | ✓ (mixDoctor via diagnose/export verdict)                    | ✓                                              | ✓ genre-measured thresholds                      | mixDoctor.ts:95-105                                           |
| Rhythmic   | onset detection (flux + adaptive threshold + hysteresis)                         | ✓                                                       | ✓ (kyx_unsuno drums layer; SliceLab)                         | ✓ client/fallback tests; golden "onsets exist" | ✓ floors                                         | onset-detector.ts:21-96                                       |
| Rhythmic   | tempo estimation (multi-band flux → HE autocorrelation, half/double fold 70–180) | ✓                                                       | ✓ (`kyx_unsuno transcribe`)                                  | ✓ ±4 BPM windows; crest honesty gate           | ✓                                                | audio-tempo-key.ts:60-81; audio-reference.test:164            |
| Rhythmic   | beat/downbeat grid                                                               | ✗                                                       | ✗                                                            | —                                              | —                                                | **Missing** (tempo yes, beat phase no)                        |
| Rhythmic   | swing/microtiming/groove                                                         | ✓ (extraction vs grid; velocity)                        | ✓ (hum→groove, unsuno drums)                                 | ✓ voice-take/groove tests                      | partial                                          | groove-extraction.ts:1-9                                      |
| Tonal      | pitch track (YIN, clarity-gated)                                                 | ✓                                                       | ✓ (hum→melody, harmonize)                                    | ✓                                              | ✓ range-bound                                    | pitch-tracker.ts:1-26                                         |
| Tonal      | key (Goertzel chroma → Krumhansl-Kessler, concentration+correlation gates)       | ✓                                                       | ✓                                                            | ✓ noise→null floors                            | ✓                                                | audio-tempo-key.ts:132-173                                    |
| Tonal      | chords / bass / drums transcription (DSP+symbolic layers)                        | ✓                                                       | ✓ (`kyx_unsuno transcribe`; golden LIVE floors)              | ✓ golden-set                                   | partial (layer-activation skipIf documented)     | reference/transcribe.ts:23-49; unsuno/golden-set.test:101-127 |
| Tonal      | tuning drift                                                                     | ✗                                                       | —                                                            | —                                              | —                                                | Missing                                                       |
| Structural | segmentation/sections                                                            | partial (section doctor measures, no boundary detector) | ✓ (diagnose context)                                         | ✓                                              | partial                                          | sectionMixDoctor.ts:81                                        |
| Vocal      | voice-take class (melodic/percussive/empty)                                      | ✓                                                       | ✓ (IDEA 2.0 strip)                                           | ✓ determinism + negative cases                 | ✓                                                | voice-take.ts:127-148                                         |
| Vocal      | speech/music / STT                                                               | partial (vendored Whisper worker, own-origin)           | ✗ (no MCP/UI consumer found this pass)                       | Not verified                                   | —                                                | stt-worker.ts:3-36                                            |
| Vocal      | singing evaluation (intelligibility, breath)                                     | ✗                                                       | —                                                            | —                                              | —                                                | Missing                                                       |
| Relational | low-end masking + transient contrast                                             | ✓                                                       | ✓ (diagnose/section findings)                                | ✓ DC-free probe, positive control              | ✓                                                | sectionMixDoctor.ts:45-102                                    |
| Relational | inter-track balance / buried strip                                               | ✓                                                       | ✓ (`kyx_diagnose_mix` attributed findings + callable fixes)  | ✓ diagnose tests                               | ✓                                                | mcp/mix-diagnosis.ts:1-25                                     |
| Semantic   | audio tagging (AST q8, on-device)                                                | ✓                                                       | **internal only** (reference intake + sample-library index)  | Not verified (no accuracy suite)               | —                                                | audio-client.ts:1-40; audio-index.ts:118                      |
| Semantic   | source separation (HPSS + gated htdemucs)                                        | ✓                                                       | ✓ (stems lanes/export; `mcp/stem-mastering.ts`)              | ✓ S0-S6 gate evidence                          | ✓ Tier-2 webgpu 6.58× recorded                   | hpss.ts; stem-model/*                                         |
| Semantic   | parameter inversion (kick → synth params)                                        | ✓                                                       | ✗ (UI command only)                                          | ✓ synthesized ground truth ±2 st               | ✓ documented biases                              | kopa/forge.ts:92-257                                          |
| Semantic   | audio embeddings / similarity / audio-text                                       | ✗ (text embeddings only, semantic manifest)             | ✗                                                            | —                                              | —                                                | Missing for audio                                             |
| Semantic   | A/B level-matched comparison                                                     | ✓                                                       | ✓ (`kyx_blind_ab` measured LUFS match)                       | ✓                                              | ✓                                                | levelMatch.ts:33                                              |

**The audit's own warning holds here:** the AST tagger's AudioSet labels and the transcription
layers are pattern statistics, not musical understanding — nothing in the repo claims otherwise,
and `similarity-advisory.ts` explicitly disclaims copyright semantics.

---

## 7. Data Pipeline & Schema Assessment

**Path (Observed):** source (SampleBank decode / mic take / offline render) → optional worker
segmentation (onsets) → transform (warp/stretch/HPSS/separation) → feature extraction
(per-analyzer, pure functions over Float32 + sampleRate) → analyzer-specific report object →
per-analyzer alignment (seconds) → **no shared cache layer** → AI-facing API (MCP tool result or
internal consumer).

**Strengths:** pure-function cores (`take-scoring`, `mixDoctor`, `transientProfile`, `levelMatch`)
are worker-compatible and unit-tested; PCM budgets exist (renderer 320 MiB cap); cancellation is
real (`AbortSignal` through render; watchdog terminate in ultina/stem clients); loudness
normalization is a designed, clamped step (`levelMatch` ±12 dB; preset-loudness tramps −18…+12 dB);
missing media / failed decode degrade to null with reasons (`stem-model` never-throw; forge
warnings, not silent patches).

**Gaps:**

- **No `AudioAnalysisRequest/Result` envelope** — ten analyzers, ten shapes
  (`MixHealthReport`, `SectionMixFinding[]`, `VlyxClaim`, `KickForgePlan`, `VoiceTakeAnalysis`,
  `TranscribedTrack`, meter snapshots, impact estimates, forge plans, ultina cards). None carries
  project revision, preprocessing version, or a shared confidence field. _(Code-inferred from the
  export list sweep.)_
- **No chunking/overlap policy shared across analyzers** — each FFT user owns its windowing
  (2048/1024 ultina, 2048/256 flux, per-frame YIN); boundary artifacts are handled per-analyzer or
  not at all.
- **Resampling/channel policy implicit** — renders resample via `OfflineAudioContext` at
  caller-chosen rate; mono/stereo folding is per-analyzer (mixDoctor assumes stereo pairs;
  transcription downmixes). No documented policy table.

**Recommended minimal contract (PROPOSAL):**
`AudioAnalysisRequest { revision, scope{kind,id,takeId?}, stage, window{ticks+sec}, featureSet,
algorithm? }` → `AudioAnalysisResult { request, algorithm{name,version}, preprocessing{resample,
channels}, producedAtRevision, confidence: 0..1|null, partial?: reason, payload (per-featureSet
typed schema) }` — one envelope, typed payloads per feature set, versioned by
`algorithm.version + preprocessing`, cacheable by the request hash (§8).

---

## 8. Real-Time Safety Risk Register

| ID   | Risk                                                         | Status                                                                                                                                                                  | Evidence                                                  |
| ---- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| RT-1 | Analysis on the audio callback                               | **Confirmed absent by design** — audio thread hosts DSP + scalar/transfer posts only; kwmeter ships coefficients in, scalars out                                        | Observed (kwmeter-node.ts:39-66; worklet inventory §3)    |
| RT-2 | Metering allocation/oversampling on audio thread             | Confirmed absent — 4× true-peak + LUFS gating run main-thread rAF with TTL                                                                                              | Observed (meteringRig.ts:258-270)                         |
| RT-3 | Unbounded cache growth in wrappers                           | Bounded — warp 6 slots, stretch LRU 48, onset cache FIFO 96, IR caches FIFO                                                                                             | Observed (warpManager.ts:37-56; ArrangementPanel.tsx:232) |
| RT-4 | Analysis worker overruns during recording                    | Mitigated, **untested under combined load** — watchdogs (120 s warp, 3 min ultina, 20 s tagger), never-throw nulls; but no recorded-session + bulk-analysis soak exists | Code-inferred + **Not verified**                          |
| RT-5 | GC pressure from transferred buffers                         | Transferables used at every audio post (capture, mic, kaskada, warp); main-thread copies for analyser reads are small (2×2048)                                          | Observed                                                  |
| RT-6 | Sample-library semantic indexing fan-out while playing       | Partial — `buildAudioIndex` is progress-callback based and worker-side, but no global queue/priority exists                                                             | Code-inferred (audio-index.ts:118-234)                    |
| RT-7 | Tab throttling / thermal (mobile) degrading analysis cadence | Not verified (no mobile measurement this pass; browser rAF gating applies to meters, not workers)                                                                       | Not verified                                              |
| RT-8 | Frozen-buffer rehydrate stalls during playback               | Managed (async rehydrate + restartFrozenSources)                                                                                                                        | Observed (warpManager.ts:212-246)                         |

**Proposed tiered policy (PROPOSAL, matches what the code already does informally):**

1. _Realtime-safe observation_ — analyser pulls + worklet scalars only (current MeteringRig; keep).
2. _Near-RT analysis_ — single-flight, droppable, worker-based (current onset/tagger pattern;
   formalize as one scheduler with `maxConcurrent: 1–2`, `dropIfStale(revision)`).
3. _Offline deep analysis_ — job queue over explicit renders (`renderTrack`/`renderProject`) with
   revision-pinned inputs and persisted results (does not exist yet — see G-1/G-6).

**Overload rule to write down:** drop/defer ANALYSIS, never audio — today this holds implicitly
because nothing analytical shares the audio thread; make it an invariant + test.

---

## 9. Model Integration Readiness

**Runtime foundation (Observed):** `onnxruntime-web` with WebGPU-probe→WASM-SIMD fallback;
manifests pin sha-256 `modelHash` + `gatePassed`; candidates never activate ungated
(`model-loader.ts:33`, `stem-model/gate.ts:12-58`); Model Pack Manager does explicit, verified,
resumable downloads into a Cache Storage bucket (`modelPackManager.ts:1-60`); every client is
lazy/timeout/circuit-broken/never-throw. Text SFT (LFM2.5 q8) runs on localhost Ollama,
TEXT-only, behind `pf:intent-model-ollama` kill switch, strictly downstream of the deterministic
router (`model-route-gate.ts:144` — the deterministic layer outranks the model).

**Adapter boundary:** there is NO shared adapter interface — each model integrates as its own
client+worker pair with a private manifest. That is a deliberate per-model safety choice, but a
future interchangeable-perception layer would want a thin common interface
(`probe() / analyze(AudioAnalysisRequest) / cancel() / capabilities()`). The pieces (manifest gate,
hash pin, pack manager, worker pattern) are already the 80%.

**Options compared against the repo's actual needs:**

| Option                     | Fits                                                             | Cost                                                             | Verdict for KYX                                   |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| DSP-only                   | LUFS/TP/onset/pitch/mix diagnostics                              | none — shipped                                                   | **Current backbone; keep primary**                |
| DSP+MIR                    | tempo/key/chords/bass/drums transcription, forge inversion       | none — shipped                                                   | Current; extend (beat grid, tuning)               |
| Embedding+retrieval        | sample-library search, "find like this", arrangement suggestions | q8 AST exists; audio embeddings missing; retrieval layer missing | Highest near-term value per cost (Experiment E-5) |
| Audio-language model       | open-ended "what does this sound like" reasoning                 | new runtime + eval burden; **no candidate validated here**       | Research bet; requires the §5 contract first      |
| Hybrid (DSP + small heads) | KOREŇ-style telemetry generalized                                | medium                                                           | Natural extension of an existing pattern          |

**LFM 2.5 Audio 1.5B:** appears NOWHERE in this repository (no fetch, manifest, or adapter). As an
external candidate it is **Not verified**: exact identifier, release status, license, modality
coverage (audio understanding vs generation), and deployment shape were not validated during this
audit, and no recommendation is made. The architecture's own gates (`gatePassed` + hash + flag)
are exactly the path any such candidate would have to pass.

---

## 10. AI Tool/Observability Coverage

**What an AI can request today (Observed, all structured + bounded):**

- `kyx_meter` — live master (dBTP, RMS, LUFS M/S/I, correlation, clip flag), per-track peak/RMS,
  per-FX telemetry incl. KOREŇ f0/clarity/harmonics; honest refusal without a live context
  (`mcp/meters.ts:11-13`).
- `kyx_render_summary` — "the agent's ears": offline N+1 strip renders, per-strip integrated LUFS,
  peak, crest, deltas vs −14 reference (`render-summary.ts:1-16`).
- `kyx_diagnose_mix` — attributed findings (low-end ownership, buried strip, over-compression, sub
  collision), each mapped to a callable fix (`SuggestedAction{tool,args,why}`), diagnose→fix→verify.
- `kyx_loudness` — measure → trim → verify with LANDED/NOT-LANDED verdict.
- `kyx_unsuno transcribe` — tempo/key/chords/bass/drums from a user-library audio id.
- `kyx_blind_ab` — level-matched A/B from measured LUFS.

**Gaps:** (a) no tool returns analysis for an arbitrary time RANGE or clip-local window (renders are
whole-strip); (b) no raw-audio access tool — correct for privacy/context, but then every deeper
question must be a NEW tool (the audit's "avoid redundant endpoints" pushes toward a parametrized
`kyx_analyze` once the §7 contract exists); (c) analysis results are not revision-stamped in their
payloads, so an agent cannot check freshness itself (the lattice checks plans, not analyses);
(d) `analysis unavailable` vs `low confidence` vs `no event` IS distinguished per-analyzer by
convention (null vs findings vs floors) but not in a shared vocabulary.

---

## 11. Caching, Invalidation & Reproducibility

| Cache           | Key                                                                         | Content-addressed?   | Invalidation                         | Persistent          | Evidence                         |
| --------------- | --------------------------------------------------------------------------- | -------------------- | ------------------------------------ | ------------------- | -------------------------------- |
| Warp renders    | `bufferId\|wallSec\|hash(pins)`                                             | geometry, not bytes  | project-id sync, context swap, epoch | no (session)        | warpManager.ts:84-193            |
| Stretch LRU     | `bufferId\|rate\|reverse`                                                   | no                   | with warp cache                      | no                  | triggerEngine.ts:508             |
| Frozen buffers  | bufferId → WAV + **doc signature (sha-256, tri-state fresh/stale/unknown)** | signature yes        | explicit staleness check             | **yes** (IndexedDB) | freezeSignature.ts:36-134        |
| Onset cache     | `bufferId:channel`                                                          | no                   | FIFO 96                              | no                  | ArrangementPanel.tsx:229-313     |
| Stem separation | none for results (ORT session only)                                         | —                    | recompute per run                    | no                  | stem-model/client.ts:42          |
| Model bytes     | sha-256 verified Cache bucket                                               | **yes**              | explicit pack mgmt                   | **yes**             | modelPackManager.ts              |
| Preset loudness | generated static map (regen = drift control)                                | deterministic probes | build-time regen                     | yes                 | preset-loudness.generated.ts:1-7 |

**Assessment:** the freeze signature is the model citizen (content-derived, tri-state, honest
"unknown"); everything else leans on `bufferId` immutability in the SampleBank — which holds today
because clips are non-destructive and buffers immutable-by-convention, but **no invariant/test
pins buffer immutability**, and no cache records the revision it was computed at. Stale analysis is
therefore detected only where a signature exists (freeze) — an AI consuming, say, onset positions
after a time-stretch edit has no freshness signal. _(Code-inferred.)_

---

## 12. Security, Privacy & Failure Resilience

- **Egress:** negative sweep found **no audio bytes leaving the device** — no fetch/XHR/sendBeacon
  with PCM/WAV/Blob bodies, no remote WebSocket (the one binary-audio transport, MRT2 companion,
  is hard-restricted to localhost loops or the local desktop bridge, `websocket-transport.ts:23-36`).
  Ollama is localhost, text-only. Model downloads are inbound, own-origin or HuggingFace, sha-256
  verified. _(Observed.)_
- **Consent/retention:** mic takes persist durably to IndexedDB (durable-acked chunks,
  `PcmMicRecorder.ts:941-966`) — local-only, but there is no user-facing retention/consent surface
  for analysis over takes; delete paths exist via project/take deletion. _(Code-inferred.)_
- **Licensing:** sample side is exemplary (`docs/SAMPLE-SOURCES.md` redistribution filter +
  generated `public/licenses/credits.md` + gate test). Model weights carry registry `licenseUrl`
  but no gate/doc equivalent — thin, worth one doc page if packs grow.
- **Failure modes:** never-throw is consistent across every analysis client; the DAW stays fully
  usable with all perception unavailable (workers refuse honestly, UI degrades silently, MCP tools
  return typed refusals). Prompt-injection surface via analysis OUTPUTS is minimal today (numeric
  verdicts; Slovak fixed finding strings; the one LLM route consumes user TEXT through a gated,
  non-mutating planner).
- **Hallucination guard:** the model route cannot mutate without an executable plan
  (`model-route-gate.ts`), and descriptions never mutate.

---

## 13. Top 15 Gaps

| #    | Gap                                                                                                        | Sev                 | Confidence                           | Impact                                                                               | Effort                     | Mitigation path                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------- |
| G-1  | No unified `AudioAnalysisRequest/Result` envelope (revision, stage, window, algorithm version, confidence) | **P1 foundational** | Observed (10 schemas, none shared)   | every future AI-perception feature re-invents plumbing; agents can't check freshness | M                          | define contract + wrap 3 existing analyzers first (mixDoctor, transcribe, render-summary) |
| G-2  | Caches keyed by `bufferId`+geometry, not audio content; buffer immutability unpinned                       | P2                  | Code-inferred                        | stale onsets/warps after any future destructive edit; silent wrong analysis          | S–M                        | content hash at decode/ingest; immutability invariant test                                |
| G-3  | Yjs store → `null` revision → staleness lattice skipped in collab                                          | P2                  | Observed (mcp/revision.ts:4-9)       | AI plans in collab lack age guarantees                                               | M                          | revision mirror into Yjs or explicit "freshness unknown" in results                       |
| G-4  | Frozen-loop playback/alignment ignores scene BPM pins                                                      | P2 correctness      | Observed (warpManager.ts:444-448)    | analysis over frozen loops mis-locates by the pin ratio                              | M                          | route frozen offset through scene-time like live clips                                    |
| G-5  | No beat/downbeat grid (tempo only)                                                                         | P2                  | Observed                             | groove/arrangement reasoning stays approximate                                       | M                          | extend flux pipeline with phase histogram (DSP-only)                                      |
| G-6  | No analysis job manager (queue/priority/backpressure/dedupe)                                               | P2                  | Code-inferred                        | bulk flows (index a library, analyze N clips) fan out unbounded near RT              | M                          | one scheduler service implementing the §8 tiers                                           |
| G-7  | AST tagger not exposed to agents; no audio embeddings                                                      | P2 leverage         | Observed                             | agents can't ask "what is this sample like"                                          | S–M                        | expose tagging via one tool + store labels in audio-index (already built!)                |
| G-8  | Analysis results carry no confidence/uncertainty convention                                                | P3                  | Observed                             | agents can't weigh evidence uniformly                                                | S                          | field in G-1 envelope; map existing null/floors                                           |
| G-9  | No peaks/mip cache for waveforms (UI cost, ARCHITECTURE:1706 says "should be cached")                      | P3                  | Observed                             | redraw cost on long projects                                                         | S                          | min/max pyramid at decode                                                                 |
| G-10 | Recording-alignment offset only in localStorage (±500 ms, per device)                                      | P3                  | Observed                             | take analysis inherits unshared calibration                                          | S                          | move into project/device settings doc                                                     |
| G-11 | No perception benchmark suite as a suite (fixtures are per-analyzer)                                       | P2                  | Observed                             | regressions in quality have no single gate                                           | M                          | §9 suite, reuse golden-synth + honest floors                                              |
| G-12 | No human-eval harness for perception usefulness (ABX exists only for drum pairs)                           | P3                  | Observed                             | subjective claims stay unmeasured                                                    | M                          | extend the listening/ABX page                                                             |
| G-13 | STT worker exists without a consumer/product surface                                                       | P3                  | Observed (no caller found this pass) | dead capability or intended-future                                                   | S                          | decide: wire into vocal lane or remove                                                    |
| G-14 | Model-weight licensing not documented like samples                                                         | P3                  | Observed                             | redistribution clarity as packs grow                                                 | S                          | one doc + registry field already exists                                                   |
| G-15 | `kyx_meter` unusable headless (needs live engine) — agents get meters only in-app                          | P3 honest limit     | Observed (meters.ts:11-13)           | headless agents rely on render_summary alone                                         | none (by design; document) | keep refusal, cross-link to `kyx_render_summary`                                          |

---

## 14. Target Architecture Proposal (minimal, evolutionary)

1. **`src/analysis/contract.ts`** — the §7 envelope + a `defineAnalyzer()` helper that wraps the
   existing pure functions (no analyzer rewritten; mixDoctor, transcribe, render-summary first).
2. **`src/analysis/jobs.ts`** — the tier scheduler (single-flight near-RT + offline queue) with
   `dropIfStale(revision)` and the written overload rule; existing clients migrate at their own pace.
3. **Content identity** — `contentHash(bufferId)` computed at ingest/decode, added to warp/stretch/
   onset keys; one invariant test: mutating a buffer changes its hash (catches G-2 forever).
4. **`kyx_analyze` MCP tool** — one parametrized entry (`scope, stage, window, featureSet`) returning
   the envelope; `kyx_render_summary`/`kyx_diagnose_mix` stay (they're compositions, not duplicates).
5. **Expose what exists** — tagger labels into `audio-index` results + one read-only MCP surface;
   beat grid into the transcribe layers.
   Nothing here rewrites the engine, touches the audio thread, or changes a shipped sound.

---

## 15. Experiment Cards

| #    | Hypothesis                                                                 | Fixture                                                                      | Success / no-go                                                                                                               | Guardrails                             | Effort |
| ---- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------ |
| E-1  | Clip-level feature extraction with exact timeline mapping (envelope + G-1) | seeded golden-synth clips at known ticks, incl. scene-BPM pin + trim + warp  | extracted window == declared window ±1 sample across 20 cases; **no-go** if frozen-loop misalignment (G-4) reproduces unfixed | offline renders only                   | S      |
| E-2  | Pre/post-FX comparison on a stable render                                  | `renderTrack` twice (bypass vs engaged) per strip                            | stable delta per feature, deterministic across 3 runs                                                                         | PDC settle always; AbortSignal plumbed | S      |
| E-3  | Cache invalidation after edits + automation                                | edit matrix (trim/stretch/gain/automate/freeze) over cached analyses         | stale detection 100% via signature/hash; **no-go** if any silent hit                                                          | none (pure)                            | M      |
| E-4  | Async analysis under recording+playback load                               | live drum loop + mic take while indexing 50 clips                            | 0 xruns on rt-monitor, analysis lags/drops per tier; **no-go** if any audio glitch attributable to analysis                   | tier scheduler, single-flight          | M      |
| E-5  | One model-agnostic adapter PoC (AST tagger behind `defineAnalyzer`)        | 20-library clips                                                             | labels + confidence in envelope, worker-isolated, never-throw                                                                 | existing gates unchanged               | S      |
| E-6  | AI tool retrieval of provenance-rich results                               | `kyx_analyze` on 3 scenarios (mix fix, transcribe, tag)                      | agent completes task with ≤2 calls, no raw arrays in context                                                                  | bounded outputs (existing convention)  | M      |
| E-7  | Human evaluation of one perception task                                    | level-matched A/B: "diagnose low-end masking" findings vs 3 engineer ratings | agreement ≥ 2/3; else recalibrate thresholds                                                                                  | existing ABX page pattern              | M      |
| E-8  | Beat/downbeat grid DSP                                                     | golden rhythmic fixtures w/ known downbeats                                  | ≤1-beat error on 90% fixtures                                                                                                 | DSP-only                               | M      |
| E-9  | Embedding+retrieval over the sample library                                | library index + query set                                                    | top-5 relevance rated useful by author; store labels reused                                                                   | all on-device                          | M–L    |
| E-10 | Headless perception parity                                                 | `kyx_render_summary` vs in-app meters on same doc                            | values within documented tolerance                                                                                            | none                                   | S      |
| E-11 | Collab freshness semantics                                                 | two-browser edit while an agent plans                                        | agent refuses or re-reads on stale analysis                                                                                   | lattice + envelope                     | M      |
| E-12 | (Research bet) audio-LM candidate evaluation                               | —                                                                            | only after E-1/E-6 + a public candidate passes license/capability validation                                                  | never on RT path; never auto-activated | L      |

**Roadmap:** **0–30 d:** E-1, E-2, E-5, G-8/G-9/G-10 quick wins, contract doc (ADR). **30–90 d:**
E-3, E-4, E-6, G-1 wrap-out, G-2 hashes, G-7 exposure. **3–6 mo:** E-7..E-11, G-3/G-4/G-5/G-6,
benchmark suite formalized. **12–36 mo (speculative):** E-12, semantic arrangement reasoning,
cross-product analyzer reuse.

---

## 16. Prioritized Roadmap (condensed)

See §15 table — the ordering is deliberate: **contract and identity first** (they multiply every
later feature), exposure of existing capability second, new perception third, models last.

---

## 17. Preserve List (do not change)

1. One-engine live/offline parity + `renderProject` determinism (exports sound like the project).
2. `scene-time.ts` as the ONLY bars↔seconds owner; ADR 0056 required-arg `ticksPerBar`.
3. The never-throw worker-client pattern (lazy + timeout + circuit breaker + null) at every analysis boundary.
4. `gatePassed`/hash manifest pins — candidates never activate ungated.
5. Honesty floors: `null` over a guess (honest-gates suite is the reference).
6. ADR 0048 analyser budgets and the engine graph census.
7. MCP bounded-output convention (numbers/verdicts/callable fixes, never raw arrays).
8. `levelMatch` for any A/B (comparisons about timbre, not loudness).
9. The local-first egress posture (localhost-only transports; own-origin models).
10. Audio-thread purity: no allocation, no analysis, scalar posts only.

## 18. Open Questions & Verification Checklist

- [ ] Runtime soak: recording + playback + E-4 bulk analysis — xrun count, heap, thermal (needs a real session; plan in E-4).
- [ ] AST tagger accuracy on THIS library's material (no accuracy suite exists — build one before trusting labels).
- [ ] WebGPU stem-separation availability matrix on target machines (S5 numbers are recorded, not re-measured).
- [ ] Human usefulness of `kyx_diagnose_mix` findings (E-7 listening study).
- [ ] Does any target user workflow need raw audio access by an agent, or are bounded descriptors sufficient? (Product question.)
- [ ] STT worker: intended consumer? (G-13 decision.)
- [ ] Collab revision mirror design (G-3) — Yjs awareness vs doc field.
- [ ] Any future audio-LM candidate: license, modality, deployment validated through the existing gates — never assumed.

**Final quality gate:** code inspected and cited ✔ · raw media vs processed output distinguished
(tap matrix stage column) ✔ · alignment + revision freshness audited (§5, §11) ✔ · RT path
protected (§8; proposals are off-thread) ✔ · no model assumed suitable without validation (§6, §9,
LFM caveat) ✔ · proposals incremental and reversible ✔ · unknowns plain (§2 ledger, this list) ✔ ·
repository unmodified except this report ✔.
