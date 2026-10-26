# THE MUSICAL UNDERSTANDING GAP AUDIT — KYX / Pulse Forge

**Date:** 2026-10-26
**Scope:** Read-only investigation of the working tree at `main` (HEAD `6a21ad29`, with one concurrent session's ADR 0067 landing as `64e71cd3` mid-audit). No source changes; verification limited to targeted `vitest` runs of existing suites.
**Question:** What must an AI assistant know about the music, project, and user intent to make musically competent decisions — and how much of that knowledge is genuinely available today?

---

## Method and evidence levels

The audit traced producer→consumer paths for every musical capability, in seven parallel domain investigations (temporal/rhythmic; pitch/harmony; structure/arrangement; timbre/dynamics/mixing; vocals/performance; intent/semantics/MCP; state/commands/verification), followed by direct spot-checks of the most load-bearing claims and a runtime verification pass.

Evidence levels used throughout:

| Level                  | Meaning                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **OBSERVED_RUNTIME**   | Executed in this audit: `npx vitest run` over six perception suites — 104/104 pass (log in Appendix A).                     |
| **VERIFIED_CODE_PATH** | Traced end-to-end in the working tree with file:line evidence; key claims re-checked by the auditor.                        |
| **DOCUMENTED_ONLY**    | Claimed in docs/ADRs but not traced to a working consumer.                                                                  |
| **PROPOSED**           | Appears only in roadmap/ADR material as a future plan.                                                                      |
| **UNKNOWN**            | Could not be established without resources unavailable to this audit (listening, live model inference, real user projects). |
| **NOT_APPLICABLE**     | Outside the product's actual scope; not penalized.                                                                          |

What this audit could **not** do (limitations, stated up front): no human listening was performed and none is claimed; no live browser/Electron boot was driven; no ONNX model inference was executed live (model gates were verified from committed manifests and reports, not by running the models); no real user projects were inspected; all "sound quality" statements below are statements about what the code _measures_, not about whether it _sounds good_.

---

## 0. Executive verdict

**The system is metadata-aware and command-aware, with a genuine but deliberately narrow audio-perception layer. It is music-aware for _measured_ properties and honest about everything else; it is not yet "listening-aware" for interpretation.**

On the four-label scale the audit was asked to apply:

- **Merely conversational — NO.** There is no free-text chat surface at all. Every AI entry point (in-app intent bar, `src/intent/route.ts`; 39 MCP tools, `src/mcp/tools.ts`) routes through the deterministic command layer with inverse-patch undo (`src/commands/core.ts:34-72`), stale-write guards (`src/mcp/write-conflict.ts:38-52`), a mandatory post-handler verification choke point (`src/mcp/verified-mutation.ts:90`: "A SUCCESS WITH AN IDENTICAL DOCUMENT IS NOT A SUCCESS"), and human-sentence clarify chips instead of guesses (`src/intent/clarify-messages.ts:79`).
- **Command-aware — YES, strongly.** 39 MCP tools enumerated at `grep -c 'name: "kyx_'` = 39; every mutating tool returns committed read-backs; `kyx_diagnose_mix` closes its own loop ("apply, then re-run kyx_diagnose_mix to verify", `src/mcp/mix-diagnosis.ts:381`).
- **Metadata-aware — YES, unusually so.** The project model is a real musical world model: scenes with first-class `SceneRole` ("verse/chorus/bridge", `src/project-model/types.ts:716-727`), per-scene BPM pins and intensity curves, a chord track (`types.ts:992-1000`), groove microtiming in ticks, automation lanes per target, routing with sends/returns/sidechains, and a revision counter (`ProjectStore.getRevision`, ADR 0065) that agents can plan against.
- **Music-aware — PARTIALLY, in two distinct senses:**
  1. _Perception of measurable properties: real and standards-grade._ BS.1770-4 loudness (M/S/I + LRA) and BS.1770-5 order-48 true peak (`src/audio-engine/kweighting.ts`, `metering.ts:559-643`); tempo estimation from audio with a crest-gate honesty floor (`src/ai/audio-tempo-key.ts:60-86`); key via Goertzel chroma + Krumhansl and via STFT chroma + Camelot (`src/reference/analysis/tonal.ts`); onset/transient detection (`src/audio-workers/onset-detector.ts`); monophonic YIN pitch ×3 implementations; groove extraction from audio (`src/audio-engine/groove-extract.ts`); HT-Demucs stem separation (WebGPU, gatePassed, 6.58× realtime); AST (AudioSet) audio tagging; multilingual MiniLM text embeddings for intent. The refusal-to-fabricate property is _tested_: `tests/honest-gates.test.ts` asserts noise of any color yields `estimateKey → null` and `estimateTempo → null` — OBSERVED_RUNTIME pass in this audit.
  2. _Musical interpretation: rule-based and symbolic, not perceptual._ Structure roles are authored (or energy-threshold-derived on reference import); there is no chorus/novelty detection from audio (grep `selfSimilar|similarityMatrix|novelty|chorusDetection` → 0 hits); dissonance/tension is unmeasured (grep → 0 real hits); masking is band-share heuristics, not a time-frequency model; "warm/intimate/aggressive" style language resolves through ~26 curated production concepts (`src/intent/production.ts:15-44`) and bounded EQ moves — not through any representation of timbre meaning.

The single most distinctive property — and the one most worth preserving — is the **verification culture**: the codebase systematically distinguishes "I changed something" from "the intended sonic change occurred," states its units, refuses to answer without measurements, and labels its own approximations in comments. Examples: param read-back maps role→metric and answers "lead jasnejší o +12 % ✓" or refuses (`src/intent/param-readback.ts:185-196`); mastering verification states "These are measurements, not a taste verdict. A human A/B is still the final gate" (`src/intent/mastering-verification.ts:8-9`); blind A/B turns listening into a two-sided binomial the agent can count (`src/mcp/blind-ab.ts`).

**Domain scoreboard** (2 = end-to-end, 1 = partial, 0 = absent, NA = out of scope):

| Domain                    | Observe | Represent | Interpret | Act | Verify | Weakest link                                                                             |
| ------------------------- | ------- | --------- | --------- | --- | ------ | ---------------------------------------------------------------------------------------- |
| A. Temporal/rhythmic      | 2       | 2         | 1.5       | 2   | 2      | No beat/downbeat tracking from audio; no continuous tempo curves                         |
| B. Pitch/harmony          | 1.5     | 2         | 1         | 2   | 1.5    | No polyphonic audio→notes; no tension/dissonance measure                                 |
| C. Structure/arrangement  | 1       | 2         | 1         | 2   | 1      | Structure perception from audio = energy thresholds only; no repetition census           |
| D. Timbre/mixing          | 2       | 2         | 1.5       | 2   | 2      | Masking = band-share heuristics; no time-frequency interaction model                     |
| E. Vocals/performance     | 1.5     | 1.5       | 1         | 1.5 | 1.5    | Take-level understanding only; no VAD/breath; no per-note pitch view of audio            |
| F. Intent/semantics       | 1       | 2         | 1.5       | 2   | 2      | MCP context excludes selection and audio evidence; descriptor vocabulary curated, closed |
| G. Cross-track/cross-time | 1.5     | 2         | 1         | 2   | 1.5    | No per-time-range verification; automation conflict detection partial                    |

---

## 1. Evidence and coverage ledger

### 1.1 What was inspected

**Traced end-to-end (primary evidence):** `src/transport/Transport.ts`, `src/scheduler/Scheduler.ts`, `src/project-model/{schema,types,groove,scene-time,intensity,markers,scales,automation,modulation-precedence,timeline}.ts`, `src/audio-engine/{AudioEngine,metering,kweighting,automationBridge,take-scoring,groove-extract,bpm-detect,transients,latencyProbe,recordingAlignment,vocal-alignment,meteringRig,harmonyContext,NoteRepeat}.ts`, `src/audio-workers/{onset-detector,pitch-tracker,warp-render}.ts`, `src/analysis/{mixDoctor,sectionMixDoctor,levelMatch,transientProfile,similarity-advisory,hpss}.ts`, `src/analysis/ultinaAnalysis{Client,Worker}.ts` + vendored `ultina-core/analysis/featureExtractor.ts`, `src/reference/*` (transcribe, structure, descriptors, match, unsuno, restyle, regen-style, analysis/{tonal,chords,bass,melody,camelot}), `src/vocal/*` (17 modules), `src/intent/*` (pipeline, plan, normalize, text-parser, route, exact, song, transitions, param-intent, param-readback, audio-feedback, audio-reference, production, model-decoder, model-resolver, model-route-gate, clarify-_, mining), `src/effect-intent/*`, `src/assist/*`, `src/mcp/*` (tools, mix-idea, mix-diagnosis, mix-preview, render-summary, blind-ab, meters, loudness, verified-mutation, write-conflict, master-_, desktop-host), `src/mastering/*` (39 modules), `src/ai/*` (audio-tempo-key, audio-features, audio/, semantic/, features/pattern-features, harmony, grooves/, flip, meter, style-quality), `src/commands/*` (50 modules), `src/store/ProjectStore.ts`, `src/store/SelectionStore.ts`, `src/collab/{YDocStore,transportSync}.ts`, `src/embed/energy.ts`, `src/rendering/{renderer,tempoMap,stems,bounce,freezeSignature}.ts`, `src/audio-worklets/` (limiter, sidechain, pitchcorrect, pitchshift, kwmeter, sirka), `src/presets/normalization.ts`, `public/models/*` manifests.

**Docs read:** `AGENTS.md`, `ARCHITECTURE.md` (section map), `docs/CURRENT-STATE.md` (headline numbers + AI models table), ADR 0056 (bar length/time signature), ADR 0067 (modulation precedence, shipped mid-audit), ADR 0031 (SVS, PROPOSED), ADR 0025 (timeline surface).

**Executed (runtime):** one bounded vitest invocation, six suites, 104/104 pass (Appendix A). No dev servers, watchers, or builds were started; no processes remain.

**Missing access / not executed:** human listening; live browser boot; live ONNX inference (AST/MiniLM/Demucs/intent model verified from manifests + committed gate reports only); real user projects; iOS/Safari runtime.

### 1.2 Capability Evidence Ledger (principal rows)

Full detail with file:line evidence lives in §2 (taxonomy). This is the condensed ledger; "Exec" = execution status, "Unc." = principal uncertainty.

| #   | Capability                                 | Entry point                                                                  | Producer                                                           | Representation                                                    | Consumer                                                   | Evidence path                                                                 | Exec                                                                    | Unc.                                                              |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | Musical time (PPQ 480, ticks↔sec)          | `Transport.ts`                                                               | `secondsPerTick` (60/bpm/PPQ)                                      | ticks + seconds, anchor rebased on BPM change                     | Scheduler, arrangement, MCP                                | `Transport.ts:315-330`                                                        | VERIFIED_CODE_PATH                                                      | wall-clock fallback wired to audio clock live                     |
| 2   | Tempo map                                  | scene BPM pins                                                               | `tempoAtTick` / `buildTempoMap`                                    | piecewise-constant spans                                          | live seam-flip (5 ms committer) + offline render           | `scene-time.ts:39-57`, `rendering/tempoMap.ts:34-104`, `Scheduler.ts:258-264` | VERIFIED_CODE_PATH                                                      | no continuous curves (by design v1)                               |
| 3   | Meter / bar-beat coords                    | `schema.ts:3675-3724`                                                        | `ticksPerBarFor`                                                   | single doc time signature, 1-indexed bars                         | grids, scheduler, ADR 0056 dual-unit discipline            | VERIFIED_CODE_PATH                                                            | no per-bar signature changes                                            |
| 4   | Onset/transient detection                  | `onset-detector.ts` worker                                                   | log-energy flux + adaptive threshold                               | onset times in **seconds**                                        | warp pins, slices, take scoring, groove steal              | `onset-detector.ts:21-93`                                                     | VERIFIED_CODE_PATH                                                      | FIFO-only cache on immutable bufferIds (content-keyed, by design) |
| 5   | Tempo from audio                           | `ai/audio-tempo-key.ts:60` + `audio-engine/bpm-detect.ts`                    | spectral-flux ACF / transient ACF+IOI                              | `{bpm 0.1 precision, confidence}` or **null**                     | reference import, AI Flip, voice ideas                     | OBSERVED_RUNTIME (30 tests pass)                                              | octave-fold 70–180; no beat tracking                                    |
| 6   | Key from audio                             | `audio-tempo-key.ts:132`, `reference/analysis/tonal.ts:56`                   | Goertzel chroma+Krumhansl / STFT chroma+KS+Camelot                 | `{key, confidence}` or null                                       | reference flows, vocal profile                             | OBSERVED_RUNTIME (honest-gates: noise→null)                                   | chroma-level only; no modulation tracking                               |
| 7   | Monophonic f0                              | `audio-workers/pitch-tracker.ts`                                             | YIN (CMND, octave-jump correction)                                 | continuous MIDI + clarity + rms frames                            | hum→melody, harmonize, voiceify, transcribe                | VERIFIED_CODE_PATH                                                            | 70–1050 Hz; 3 parallel implementations (drift risk documented)          |
| 8   | Chords from audio                          | `reference/analysis/chords.ts`                                               | per-bar chroma → root+quality                                      | `ChordSpan{rootPc, quality, confidence, degree, func}`            | UN-SUNO rebuild, similarity advisory                       | VERIFIED_CODE_PATH                                                            | bar resolution; honesty gate 0.55 correlation                           |
| 9   | Polyphonic transcription                   | `reference/transcribe.ts:143`                                                | HPSS stems → per-stem mono YIN + chroma                            | tempo/key/drums/bass/chords/melody lanes with `implemented` flags | kyx_unsuno, ReferenceMapPanel                              | VERIFIED_CODE_PATH                                                            | no note-level polyphony; melody often honestly empty                    |
| 10  | Groove extraction from audio               | `audio-engine/groove-extract.ts:34`                                          | transient anchors → per-step timing/accent/swing                   | timing −1..1 (→±36 ticks), accent 0..1, swing 0..1                | steal-groove command, AI Flip, groove pool                 | OBSERVED_RUNTIME (15 tests pass)                                              | assumes beat grid near 16ths                                            |
| 11  | Symbolic groove metrics                    | `ai/style-quality.ts:142-169`, `ai/meter.ts:118`                             | density/syncopation/downbeat ratio, meter-weighted                 | unitless 0..1                                                     | ranker features, quality gates                             | VERIFIED_CODE_PATH                                                            | symbolic only; never measured from audio                                |
| 12  | Loudness (BS.1770-4 M/S/I + LRA)           | `kweighting.ts`                                                              | two-biquad K-weight + gated blocks                                 | LUFS/LU                                                           | export verdicts, mastering, presets, MCP                   | VERIFIED_CODE_PATH                                                            | exact; live kwmeter worklet variant                                     |
| 13  | True peak (BS.1770-5)                      | `metering.ts:559-643`, `limiter-processor.js`                                | order-48 4×-phase FIR                                              | dBTP                                                              | export guard, limiter, codec-loss verdict                  | VERIFIED_CODE_PATH                                                            | shared coefficients, documented                                         |
| 14  | Mix measurement (bands/crest/DC/clip/corr) | `analysis/mixDoctor.ts:272-379`                                              | 7-band biquad shares + BS.1770                                     | findings red/yellow + verdict line                                | diagnose_mix, export, mastering, previews                  | OBSERVED_RUNTIME (18 tests pass)                                              | mono-downmix biquads, not FFT                                           |
| 15  | Section mix check (60–120 Hz masking)      | `analysis/sectionMixDoctor.ts:81-160`                                        | low-band share + transient contrast 1.7                            | report-only findings                                              | ReferenceMapPanel post-build                               | VERIFIED_CODE_PATH                                                            | 2 heuristics only, report-only                                          |
| 16  | VLYX Mix Assist                            | `analysis/ultinaAnalysisClient.ts`                                           | vendored 10-band feature extractor                                 | octave-band profile, width, transient density, LUFS est.          | UltinaPanel proposals + claim line                         | VERIFIED_CODE_PATH                                                            | internal LUFS admitted approximation; analysis = rendered post-FX audio |
| 17  | Mastering chain + delivery verdicts        | `mastering/*` (39 modules)                                                   | profiles.ts targets                                                | −14/−16 LUFS + dBTP pass/warn/fail                                | ZENIT UI, kyx_master                                       | VERIFIED_CODE_PATH                                                            | provenance + review-due dates on sources                                |
| 18  | Post-encode verification                   | `mastering/encodedInspection.ts`, `mcp/master-profiles.ts:36`                | decode + re-measure                                                | codecLossVerdict (LU shift, dBTP overshoot, HF loss)              | file mastering sessions                                    | VERIFIED_CODE_PATH                                                            | honest about MP3 overshoot behavior                                     |
| 19  | Preset loudness normalization              | `presets/normalization.ts`                                                   | offline probe render + BS.1770                                     | per-family median targets (generated table)                       | chain build gain                                           | VERIFIED_CODE_PATH                                                            | ±18 dB clamp                                                            |
| 20  | Audio tagging (pretrained)                 | `ai/audio/audio-client.ts`                                                   | AST AudioSet q8 (flag `pf:audio-tag`)                              | AudioSet labels                                                   | reference audio analysis (`intent/audio-reference.ts:104`) | VERIFIED_CODE_PATH                                                            | in-domain tag quality UNKNOWN (not run here)                            |
| 21  | Text semantic embedding                    | `ai/semantic/semantic-client.ts`                                             | multilingual MiniLM q8 (~118 MB, flag)                             | embeddings                                                        | intent semantic matching, style vectors                    | VERIFIED_CODE_PATH                                                            | cold-load 60 s budget; desktop-lean opt-out                             |
| 22  | Stem separation                            | `analysis/stem-model/`                                                       | HT-Demucs fp32graph ONNX                                           | 4 stems                                                           | vocal/harmony lanes, UN-SUNO separation                    | VERIFIED_CODE_PATH (manifest gatePassed)                                      | WebGPU required; wasm tier fails (documented)                           |
| 23  | Intent text→command                        | `intent/route.ts:743`                                                        | ~40-route deterministic dispatch + ONNX heads (59)                 | RoutedIntent / model action with abstain                          | IntentPanel, kyx_intent                                    | VERIFIED_CODE_PATH                                                            | margin abstain 4.8/2.0; deterministic layer owns precedence             |
| 24  | Candidate ranking                          | `intent/pipeline.ts:133`                                                     | bank → invariants → repair → heuristic + ONNX ranker (54 features) | ranked candidates + provenance                                    | generation flows                                           | VERIFIED_CODE_PATH                                                            | ranker fallback always deterministic                                    |
| 25  | Audio-fit rerank                           | `intent/audio-feedback.ts:236`                                               | offline render per candidate + features vs genre ranges            | 4-dim fit score                                                   | rerankTopBySound (w=0.3)                                   | VERIFIED_CODE_PATH                                                            | measured table overrides hand-written targets                           |
| 26  | Mix idea loop                              | `mcp/mix-idea.ts:117`                                                        | pure plan (WHY attributed) → apply:true one snapshot               | steps+reasons; verify delegated                                   | MCP agents                                                 | VERIFIED_CODE_PATH                                                            | verify is a separate tool call (documented in result)                   |
| 27  | Render summary ("agent's ears")            | `mcp/render-summary.ts:135`                                                  | N+1 offline renders                                                | per-strip LUFS/peak/crest + WHY deltas                            | MCP agents                                                 | VERIFIED_CODE_PATH                                                            | **per-strip, not per-time-range**                                       |
| 28  | Param read-back verification               | `intent/param-readback.ts`                                                   | render before/after, role→metric map                               | "+12 % ✓" or honest correction chip                               | param asks                                                 | OBSERVED_RUNTIME (14 tests pass)                                              | 5 params measured, rest honestly null                                   |
| 29  | Verified mutation choke                    | `mcp/verified-mutation.ts:90`                                                | post-handler read-back + undo-claim correction                     | receipt                                                           | all 39 tools                                               | VERIFIED_CODE_PATH                                                            | the load-bearing honesty seam                                           |
| 30  | Stale-write guard                          | `mcp/write-conflict.ts:38`                                                   | per-field base-vs-current diff                                     | WRITE_CONFLICT refusal                                            | all AI writes                                              | VERIFIED_CODE_PATH                                                            | field-level, not range-level                                            |
| 31  | Modulation precedence                      | `project-model/modulation-precedence.ts` + `automationBridge.writeModulated` | automation > modulator > macro > CC single gate                    | owner read model + UI badge                                       | engine + UI                                                | VERIFIED_CODE_PATH (ADR 0067, landed `64e71cd3` mid-audit)                    | solves audible ownership, not intent-layer conflict queries             |
| 32  | Vocal take scoring                         | `audio-engine/take-scoring.ts:281-324`                                       | onsets vs grid, pitch drift, floor, clipping                       | 4-axis score + evidence strings                                   | smart comp UI                                              | VERIFIED_CODE_PATH                                                            | composite ranking by design (tightness>clip>pitch>floor)                |
| 33  | Vocal profile analysis                     | `vocal/analyze.ts:91-198`                                                    | key+tempo+phrases+SNR+per-bar energy                               | VocalProfile (+hash)                                              | vocal lane cards, song form bend                           | VERIFIED_CODE_PATH                                                            | no VAD/breath; 90 s cap                                                 |
| 34  | Record alignment                           | `latencyProbe.ts`, `recordingAlignment.ts`, `vocal-alignment.ts`             | 8-pulse round-trip + per-pass entry alignment                      | ms offsets, device-keyed, ±500 ms clamp                           | take placement                                             | VERIFIED_CODE_PATH                                                            | auto-align bounded ±120 ms (deliberate late entry preserved)            |
| 35  | PDC                                        | `AudioEngine.syncPdc` + browser check                                        | per-chain latency sums → compensation delays                       | sample-aligned export                                             | live + offline                                             | VERIFIED_CODE_PATH + browser check ≤2 samples                                 | —                                                                       |
| 36  | Undo/commands                              | `commands/core.ts:34-72`                                                     | id-anchored inverse delta patches, dev round-trip verified         | 256-cap history, coalesce, frames                                 | everything                                                 | VERIFIED_CODE_PATH                                                            | —                                                                       |
| 37  | Analysis caching                           | (absence)                                                                    | every analysis recomputes per call                                 | —                                                                 | —                                                          | grep cache → 0 hits in analysis clients                                       | VERIFIED ABSENCE                                                        | recompute cost; no stale-analysis risk (documented trade)         |
| 38  | Repetition/novelty detection               | (absence)                                                                    | —                                                                  | —                                                                 | —                                                          | grep `selfSimilar                                                             | novelty                                                                 | chorusDetection` → 0                                              | VERIFIED ABSENCE          | —                |
| 39  | Beat/downbeat tracking from audio          | (absence)                                                                    | —                                                                  | —                                                                 | —                                                          | grep `beatTrack                                                               | downbeat detect` → 0 (only loudest-onset anchor)                        | VERIFIED ABSENCE                                                  | —                         |
| 40  | VAD / breath / intelligibility             | (absence)                                                                    | —                                                                  | —                                                                 | —                                                          | grep `voiceActivity                                                           | VAD                                                                     | breath                                                            | intelligib` → 0 real hits | VERIFIED ABSENCE | —   |

---

## 2. Musical understanding taxonomy — seven domains

Format per domain: **Observe → Represent → Interpret → Act → Verify**, each with evidence, then the domain's gap line.

### A. Temporal and rhythmic intelligence

**Observe — IMPLEMENTED (audio-side, tempo/phase/onsets), with one hole (beat tracking).**
Two independent BPM engines: `src/ai/audio-tempo-key.ts:60-86` (multi-band spectral flux → harmonically enhanced autocorrelation → fold 70–180, `{bpm: 0.1 precision, confidence} | null`, null below 4 s and under an onset-crest honesty floor) and `src/audio-engine/bpm-detect.ts:35-133` (transient impulse train → unbiased ACF 60–240 → harmonic walk-down → parabolic refinement → inter-onset-interval median vote). OBSERVED_RUNTIME: 30 bpm-detect tests pass. Onsets: `src/audio-workers/onset-detector.ts:21-72` — 1024/256 RMS envelope → positive log-energy flux → adaptive threshold `mean*2.5*sensitivity + globalMaxFlux*0.2` with settled-env gate and re-arm; output in seconds; twin main-thread copy for slicing (`src/audio-engine/transients.ts`). Phase: `groove-extract.ts:73-77` anchors the grid at the strongest onset ("a loop's downbeat is its loudest attack far more often than its literal first sample").
**The hole:** beat/downbeat _tracking_ from audio is ABSENT (searched `beatTrack|downbeat detect|detectBeats|beat phase|beatTracker` → 0 hits). Tempo is known; the beat phase comes from a single strongest-onset heuristic, not a tracked beat sequence. Downbeat statistics exist only symbolically over patterns (`src/ai/evaluation.ts:222-244`).

**Represent — IMPLEMENTED (the strongest layer in the repo).** PPQ 480, `STEP_TICKS=120`, `BAR_TICKS=1920` (`src/project-model/types.ts:1-4`); groove microtiming per step −1..1 × 36 ticks, humanize ±30 ticks/±0.25 velocity, ratchets 1..8 with 0.88 decay, all seeded per (pattern,pad,step,pass) (`src/project-model/groove.ts:21-28,181-244`); velocity layers with disjoint windows + round-robin by absolute step ordinal so "LIVE == OFFLINE by construction" (`groove.ts:60-73,208-211`). Record quantize off/16th/8th with _strength_ interpolation; default OFF preserves raw played microtiming as integer ticks (`src/midi/patternRecorder.ts:53,190-198`).

**Interpret — PARTIAL (symbolic only).** Syncopation/density/downbeat metrics are computed over the pattern grid with meter-aware weights (`src/ai/meter.ts:118-122` `syncopationWeight` — 0 on pulse, 0.35 half-group start, 1 off-grid; `src/ai/style-quality.ts:142-169`). Nothing measures rhythm from audio except tempo and the groove timing/accent map. Swing is representable and applied (odd-16th delay toward triplet, `swingOffsetTicks`, groove.ts:111-115) and _extractable_ from audio (`groove-extract.ts:97-102` swing fit = mean odd-16th late shift / ⅓) — but no system compares "intended swing" against "played swing" in a recorded take beyond take-scoring's tightness/spread/feel readings (`take-scoring.ts:64-90`, which honestly labels the median deviation "a character reading, NOT a quality score").

**Act — IMPLEMENTED end-to-end.** Quantize (pattern command with scale/grid variants, `src/commands/quantize.ts`), steal-groove-into-pattern writing microtiming + accent-scaled velocity while preserving locks (`src/commands/drumContent.ts:25-70`), groove pool persistence (IndexedDB, 128-step cap), AI Flip (analyze loop → fold to 1–4 bars → install, `src/ai/flip.ts:27-42`), fills (6 recipes × 2 tiers, seeded per boundary, `src/intent/transitions.ts:94-204`), transitions re-validated after every layout edit (`schema.ts:761-792`), note repeat transport-locked (`NoteRepeat.ts:223-273`).

**Verify — IMPLEMENTED.** Groove command read-backs (`kyx_groove`, `tools.ts:1435`), transport read-backs with `PARTIAL_FAILURE` when loop-region read-back differs from request (`tools.ts:3948`), and the live==offline parity invariant guarded by shared consumption of `drumHitsInWindow` (Scheduler.ts:1284 + renderer.ts:801).

**Domain gap line:** tempo-from-audio yes, beat-_tracking_ no; rhythmic quality is measurable for recorded takes and _generable_ for patterns, but there is no "is this groove consistent with itself / with the reference" comparison surface over MCP.

### B. Pitch, harmony, and tonality

**Observe — IMPLEMENTED for monophonic f0 and chroma; PARTIAL for polyphony.**
Monophonic: worker YIN (`src/audio-workers/pitch-tracker.ts`, CMND + octave-jump correction, 70–1050 Hz, continuous MIDI output with clarity gate) + realtime worklet copies (`rezonans-core/dsp/pitchTrack.ts`, `pitchcorrect-processor.js`, `bass-harmonic-processor.js` private copy — four implementations total; the drift risk between them is documented in the rezonans header and caught only by that plugin's goldens). Key from audio: two lanes (Goertzel chroma + Krumhansl in `ai/audio-tempo-key.ts:132-181`; STFT chroma + KS + Camelot in `reference/analysis/tonal.ts:56`) plus key _derived from chord sequences_ (`reference/analysis/chords.ts:105`, first-chord ×2 weight). OBSERVED_RUNTIME: noise → null key (honest-gates). Polyphony: NOT note-level. `src/reference/transcribe.ts:143` separates via HPSS (or neural stems) then transcribes each stem monophonically; the melody layer reports only if coverage ≥ 0.04 with clarity ≥ 0.65 ("polyphonic bleed beats the gates" — honest emptiness, transcribe.ts:340). Searched `basic-pitch|crepe|onsets-and-frames|nmf` → 0.

**Represent — IMPLEMENTED (symbolic).** `MusicalKey` = 108 string-literal combos; 9 Western scale types with semitone tables (`src/project-model/scales.ts:9-54`); chord track as pitch _classes_ + quality, "voicing belongs to the instruments" (`types.ts:992-1000`); harmony functions T/S/D/p on chord events (`src/ai/harmony.ts:18-25`); Roman-numeral labels for diagnostics (`harmony.ts:46`).

**Interpret — PARTIAL.** Voice leading is real (`voiceLead` L1-minimal rotation, `harmony.ts:921`) and vocal stacks are diatonic with octave folding (`src/vocal/harmony.ts:44-86`). But: dissonance/tension computation ABSENT (grep `dissonan|consonan|tension|roughness` → only phoneme "consonants" and preset names); melodic contour exists as a 5-class symbolic feature for the ONNX prior (`src/ai/symbolic/melodic-features.ts:82-88`) but no audio-side contour descriptor; harmonic-rhythm analysis absent; modulation/key-change detection absent; non-Western scales/microtonality ABSENT (grep `maqam|raga|quarter.?tone|microton` → 0 real hits); A4 = 440 hardcoded at every conversion (`pitch-tracker.ts:153`, `reference/dsp/chroma.ts:33`) with no global tuning reference.

**Act — IMPLEMENTED.** Transpose verbs with exact semantics (`src/intent/exact.ts:40`, commands `transposeSemitones` clamped 0..127); scale-snap quantize command (`quantize.ts:14-37`); REZONANS key-aware harmonizer whose key comes from **project metadata** — `harmonyContext.ts:69` resolves `doc.key` + `doc.arrangement.chords` into scale/chord masks, degrading to chromatic when absent (the worklet then snaps detected f0 to scale degrees or chord tones via `nthScaleTone`); pitchCorrect effect (realtime scale-snap, ≤200-cent grab limit); `planVocalHarmony` stacks; `snapNotesToChords` post-process; chord-track progression stamping.

**Verify — PARTIAL.** DSP-level: bit-exact goldens for rezonans/pitchcorrect (`tests/rezonans-golden/`, `tests/pitchcorrect-*`). Musical-level: nothing verifies "does this harmony fit" beyond the rule layer; harmony proposals are not A/B'd.

**Domain gap line:** the system hears pitch monophonically and labels harmony at bar resolution; it cannot hear polyphony as notes, cannot measure tension, and assumes 12-TET A440.

### C. Structure and arrangement

**Observe — PARTIAL (audio structure = energy thresholds, reference flows only).** `src/reference/structure.ts:73-101` computes an RMS energy curve (16–64 points) and `sectionsFromEnergy:167-243` thresholds at 0.4×/0.7× median → intro/drop/breakdown/development/outro, merged ≥1.5 s, snapped to the beat grid, honest null on flat curves (peak−floor < 0.05 → no sections). This runs only inside the reference/UN-SUNO flow. No novelty curve, no self-similarity matrix, no chorus detection (grep `selfSimilar|similarityMatrix|novelty|chorusDetection` → 0). Phrase grid: markers on every N-bar phrase boundary of the beat grid, explicitly documented as not section detection (`reference/apply.ts:162-167`: "It cannot say 'the drop is here'").

**Represent — IMPLEMENTED (first-class).** `SceneRole = intro|build|drop|break|outro|fill|verse|chorus|bridge|custom` (`types.ts:716-727`); scenes carry patternId, intensity 0..1 (+curve), optional BPM pin, pack/macro/CC/modulator pins; arrangement clips are integer-bar, no-overlap scene placements; markers typed drop/buildup/riser/impact/cue; `ArrangementTransition` typed fill/riser/impact/drop/break with cue assets. SUNO bracket import maps tags (EN+SK) to roles with repeat counts (`src/intent/suno-format.ts:35-89`).

**Interpret — PARTIAL (generation-side dramaturgy is rich; perception-side is thin).** Generated songs get: one progression identity + bridge turn (`planSongHarmony`, `src/intent/song.ts:2782-2789`), hook reprise (first lead-bearing hook donates its motif to all later hooks, `applyLeadHook:2690-2723`), section development rules (later verses quote the hook at 0.55 velocity; last hook lifts drums +0.08; second verses thin odd 16ths ×0.5, `applySectionDevelopment:2549-2680`), fill tier gated by incoming intensity, dramaturgy ranking (`song-dramaturgy-ranker.ts`). But for a _hand-built_ arrangement the system computes almost nothing about structure — no repetition/variation census across patterns (groove-library dedup and warp-pin dedupe are the only similarity detectors, both narrow, `src/ai/grooves/dedup.ts`), no energy trajectory measurement of the user's own arrangement (scene intensity is authored, not measured).

**Act — IMPLEMENTED (a genuine product strength).** Auto-arrange buckets scenes by role into the SKELETON_LAYOUT (intro 8 → build 8 → drop 16 → break 8 → outro 8) with role cycling (`src/commands/arrangementShapes.ts:121-327`); NL arrangement editing with contiguous relayout (`src/intent/arrangeWords.ts`); buildSong installs form + scenes + clips + markers + transitions + chord track + per-section FX automation lanes in ONE undo (`applySongCommand`, song.ts:3081-3420); section revise/revise-flow with same-seed guarantees; MCP `kyx_sections`/`kyx_arrange`/`kyx_song`.

**Verify — PARTIAL.** `song-audio-review.ts:93-130` measures the audition render per section: non-finite, near-full-scale, clipping (≥3 consecutive samples at FS), near-silence, per-section RMS, and `suggestSectionRevivals` (a loud-carrying role ≥8 dB under the song median → energy suggestion) — but only for generated songs. `sectionMixDoctor` fires quiet-section and 60–120 Hz masking findings — only in the reference rebuild flow. No structural verification exists for user-built arrangements.

**Domain gap line:** structure is a rich authored vocabulary with strong generation-side dramaturgy, but perception is a single energy-threshold heuristic applied only to imported references; "why does my arrangement feel static" has no observable-evidence answer outside generated songs.

### D. Timbre, dynamics, and mixing context

**Observe — IMPLEMENTED (standards-grade).** BS.1770-4 K-weighting (M/S/I + EBU R-128 LRA from 3 s windows), exact coefficients per sample rate (`src/audio-engine/kweighting.ts:3-57,103-112,212-225`); BS.1770-5 order-48 4×-phase true peak (`metering.ts:559-643`, mirrored in the limiter worklet `limiter-processor.js:31-60`); peak/RMS/correlation/mono-loss/crest; spectrum/spectrogram taps (master 2048 + 4096/8192/1024 multi-res + M/S matrix, `masterChain.ts:932-1068`); per-strip post-fader analysers with lazy pre-fader taps ("209 analysers at 100 tracks, 100 of them never read" — `AudioEngine.ts:1690-1706`); band shares via 7-band biquads on mono downmix (`mixDoctor.ts:95-105`); AST audio tagging; spectral descriptors (centroid/rolloff/flatness/harmonicity; `reference/descriptors.ts`). OBSERVED_RUNTIME: mix-doctor 18 tests, honest-gates 17 tests pass.

**Represent — IMPLEMENTED.** `summarizeBuffer` whole-buffer summaries; mastering `MasteringAnalysisSnapshotV1` with per-field provenance ("rendered-master" | "decoded-reference", `mastering/intelligence.ts:22-28`); timeline LRA buckets ≤1200 points; delivery profile verdicts with tolerances and _provenance with review dates_ (`mastering/profiles.ts:170-181`).

**Interpret — PARTIAL (honest heuristics).** Mix Doctor rules with published thresholds: crest-collapse <6 dB ("over-compressed"), low-end dominance >82 %, harmonic-deficit ("phone speakers will barely hear the bass"), phase corr <−0.2, HF >28 % harshness risk — with auto-fix confined to two cases and everything else "REPORTED, never auto-corrected" (`mixDoctor.ts:520-548`). `kyx_diagnose_mix` adds low-end-collision (two strips with lowEndShare>0.5 within 3 LU of loudest), top-end ownership ranking, narrow-stereo (corr>0.98), and attributes ownership in energy terms ("Bass ≈62 % of low energy"). Masking is band-share + transient-contrast heuristics ONLY — no time-frequency masking model (grep for Zwicker-style models → 0). Kick/bass interaction is not measured onset-aligned; the onset machinery exists but is not wired into mix analysis.

**Effect-chain awareness — IMPLEMENTED and explicitly documented.** Each analysis tap states where it sits: mix diagnosis renders master FULL chain ("what the listener hears") vs strips with `masterProcessing:false` ("per-strip numbers with master processing bypassed", `mix-diagnosis.ts:444-470`); VLYX analyzes one-track renders post-FX with master ON by default (and its claim layer states exactly what it does and does not claim: "does NOT claim that the render sounds better", `vlyxClaim.ts:22-25`); reference match measures "the MIX" pre-master (`reference/match.ts:36-39`).

**Act — IMPLEMENTED.** 57 effect types incl. 6 flagship suites; ZENIT mastering device composing six audited runtimes with a fixed stage list (`mastering/signalFlow.ts:1-14`); M/S processing (master stage, bass-mono, SIRKA per-band imager); sidechain DSP with split-band ducking; loudness trim with nonlinear re-verification loop (`intent/loudness.ts:280-395`); genre mix profiles; bounded iterate executor (render→measure→plan→apply, 3 iterations, "ctx.renderMix is the AI's ears", `tools.ts:11764`).

**Verify — IMPLEMENTED (best-in-repo).** `codecLossVerdict` post-encode re-measurement; A/B snapshots; level-matched blind A/B with binomial verdicts; mix preview (render BEFORE and AFTER, level-match ±12 dB, arm a session preview card — nothing applied until human decides, `mix-preview.ts:129-187`); iterate convergence data.

**Domain gap line:** measurement is excellent and honestly scoped; the missing layer is _interaction_ (who masks whom, when) and _meaning_ (what "warm" means beyond ±0.8 dB shelves — the three descriptor systems are curated mappings, explicitly `evidence: "curated-unreviewed"`, `effect-intent/capabilities.ts`).

### E. Vocals and performance

**Observe — PARTIAL.** `src/vocal/analyze.ts:91-198` builds a VocalProfile: key, tempo (+octave sibling), per-bar energy, phrases (contiguous above-threshold bars, single-audible-bar bridging), silenceRatio, rough SNR (peak-to-quiet-decile dB), hash; never throws — unmeasured is a state. Take scoring (`take-scoring.ts:281-324`): grooveTightness (onsets within 25 ms of median grid deviation), pitchDriftSemitones (first-vs-last voiced third, 0.25 st bandwidth), noiseFloorDb, clippedShare + human evidence lines ("groove 92 % locked (spread ±12 ms, feel 18 ms)"). Record alignment: 8-pulse round-trip probe with device pinning ("measuring a different microphone and filing the result under the wrong device is worse than no measurement", `latencyProbe.ts:89-92`), per-device offsets ±500 ms, and per-pass vocal entry auto-alignment bounded ±120 ms so "a DELIBERATE late entry … is a musical choice, not a defect" (`vocal-alignment.ts:42-58`). ABSENT: voice activity detection, breath detection, silence-trim tools, intelligibility measures (greps → 0), per-note pitch/timing display of a recorded vocal.

**Represent — PARTIAL.** Takes are AudioTakeGroups + recorded-session recovery chunks (0.5 s durable writes); vocal lane keeps an in-memory take history capped at 3; comp plans are bar-resolution (peakEnergy 0.6 + energy 0.4 + SNR bonus); no note-level representation of sung audio (hum→notes exists only for _hummed_ input via `framesToNotes`).

**Interpret — PARTIAL.** Producer notes render measured fields only: "unmeasured fields get an honest 'I can't hear it' line instead of a guess" (`vocal/notes.ts:20-65`); arrangement dialog suggests intro shortening when the strongest phrase lands late (`vocal/comping.ts:105-197` — implemented + tested, **no UI consumer**). Phrase→section role inference (peak=chorus, first=intro, last=outro) exists but is test-only (`vocal/revise.ts` — PARTIAL, no wiring).

**Act — IMPLEMENTED.** Comp planning + apply (one snapshot, per-take vocalchop tracks, velocity mapped from score); smart comp over arrangement take groups with crossfades and compound undo; hum→melody→harmony stacks (YIN → segmented notes → third-above/below diatonic, octave-folded); hum→voice (voiceify loop playback at target pitch ratios + opt-in TD-PSOLA with formant preservation, "opt-in pending owner ear-pass"); vocal ensemble (lead/double/harmony with fixed offsets, "NEVER random"); pitchCorrect realtime scale-snap; de-essing (compressor band mode 2–12 kHz + FXEQ fixed ~5 kHz); key/tempo/hook adapt commands; prosody grid from lyrics (stress → beat placement, velocity 0.85/0.6).

**Verify — PARTIAL.** Evidence strings per take; alignment status ("+38 ms … N take pass(es) aligned onto their entry"); comp strip UI colors winning bars and renders gaps honestly. No intelligibility check, no "did the comp improve the phrase" verification beyond scores.

**Domain gap line:** a working record→align→comp→harmonize loop exists, but understanding stops at the take/bar level; sung audio is never represented as notes, and performance expressiveness (articulation, breath, phrasing nuance) is invisible.

### F. Musical semantics and intent

**Observe — PARTIAL (doc context rich; selection in-app only; no audio evidence in context).** In-app routing carries selection state (selected step/clip/range, `route.ts:747-750`). Over MCP: `kyx_state` exposes tempo/key/meter/tracks/markers/groove/pattern grid/scenes/sends/undo history/FX/automation/reference/model-misses (`tools.ts:1633-1662`) — but **no MCP tool sees the UI selection** (grep `selection` in tools.ts → 0 hits) and none receives precomputed audio evidence; an agent must call `kyx_render_summary`/`kyx_meter`/`kyx_diagnose_mix` to "hear."

**Represent — IMPLEMENTED.** `IntentSpec` with validated ranges (genre/energy/density/complexity/variation 0..1, roles, preserve, constraints, controls incl. temperature 0.2..2); plans are pure and serializable with per-stream seeded RNG (`forkRandom` named streams, `plan.ts:226`); generation seed chain `genre|seed|grooveId` makes same-request ⇒ same-music a contract (guarded by tests).

**Interpret — IMPLEMENTED with honest uncertainty handling.** Deterministic ~40-kind route dispatch with a gate-locked lexicon (three-layer test: no token may steer two tables; deliberate dual effects explicitly allowlisted; corpus pinned — `tests/intent-routing-lexicon.test.ts:5-33`); ONNX intent model (6144 features, 59 heads, INT8 2.48 MB, gatePassed per committed report) with margin abstain (`INTENT_MODEL_KIND_MARGIN=4.8`, `INTENT_MODEL_ABSTAIN_MARGIN=2.0` — "a mute must never become a delete") and a model-route _gate_ that forbids the model from overruling specific deterministic routes or turning descriptions into mutations (`model-route-gate.ts:8-15`); clarify-first fences (negated mutations stop the command: "'turn down the drums and DON'T TOUCH the bass' must stop the command — the product rule is to ask rather than mutate", route.ts:107; hypothetical questions never mutate; send-vs-return ambiguity offers clickable chips); optional local Ollama SFT provider (localhost, kill-switched) — **no cloud LLM anywhere** (grep `openai|anthropic|api.?key|chatcomplet` in intent/mcp/ai → 0).

**Act — IMPLEMENTED (39 tools).** Full enumeration in §1.2; writes go through canonical commands with coalescing undo; batch tool (≤10 calls, one undo frame where supported); destructive ops gated; idempotency ledger with replay.

**Verify — IMPLEMENTED (the differentiator).** `verifiedMutation` choke point for every tool (undo-claim corrected against the real stack; identical-doc "success" demoted; missing read-backs auto-appended); value-level read-backs ("mix 0.30→0.46 on Bass"); param read-back with role→metric mapping and an honest correction chip when the measurement shows no move ("meranie neukazuje počuteľnú zmenu — skúsiť ×1,5 alebo väčší stupeň?", `param-readback.ts:185-196`); loudness measure→trim→verify with nonlinear-chain re-iteration; mix preview before/after cards; blind A/B for subjective calls.

**Domain gap line:** intent interpretation is unusually disciplined, but it is _command-aware_ rather than _evidence-aware_: the reasoning layer never receives structured musical evidence (per-range measurements, selection, cached analysis) — it gets doc JSON and must instrument the world itself, per call, from scratch.

### G. Cross-track and cross-time reasoning

**Observe — PARTIAL.** Per-strip renders (STRIP_CAP 14) with documented graph taps; live data twin (`kyx_state` mixer view) + live meters (`kyx_meter` incl. FX gain-reduction telemetry); but no cross-track _interaction_ analysis beyond low-end-collision, and no per-time-range cross-strip comparison.

**Represent — IMPLEMENTED.** Routing model deliberately flat (one group per track, "routing cycles are impossible by construction", `tools.ts:3015`); sends/returns/sidechains in schema; automation lanes per target + scene automation (scene-relative ticks) + arrangement automation clips; modulation ownership now single-gated (ADR 0067: **automation > modulator > macro > midiCC**, `modulation-precedence.ts:55`, enforced at `automationBridge.writeModulated:646-672` with a live-bit so "Automation owns a parameter only while it has actually written since the last takeover").

**Interpret — PARTIAL.** Cross-change consequences are tracked for _who owns a parameter_ (ADR 0067 + `ModulationOwnerBadge` UI) but not for _what a proposed change would do_ (no what-if propagation, no conflict query "does automation exist on X in range Y" — one-lane-per-target refusal plus the per-field stale-write guard are the only checks; `param-intent.ts` contains **zero** references to automation, verified by grep).

**Act — IMPLEMENTED.** Batch edits, routing tool, automation tool (points/ramps/lanes, destructive-gated), freeze/bounce/stems, checkpoints (named, diffable, restorable), revision-declared planning (`getRevision` guard for agents).

**Verify — PARTIAL.** Per-strip render summaries verify _that_ strips differ; nothing verifies _where in time_ a change landed; cross-time verification exists only for loudness (before/after) and blind A/B.

**Domain gap line:** the state model supports cross-track reasoning but no reasoning engine consumes it at range granularity; the deepest cross-domain fact in the system is ADR 0067's ownership ordering — a correctness invariant, not a musical analysis.

---

## 3. Perception-to-action pipeline map

Generic chain: **source → acquisition → analysis → structured representation → context assembly → reasoning → proposal → command → verification.** The table marks where information is lost, stale, ambiguous, or unverifiable, with the exact seam.

| Stage                           | What exists                                                                                                               | Loss / risk point (exact seam)                                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source audio/MIDI/project state | Project doc (serializable, revision-counted, ADR 0065); audio in immutable SampleBank buffers; MIDI truth in patterns     | Audio truth exists only as buffers + waveform peaks; no derived musical representation is persisted alongside it                                                                                                                                                                        |
| Acquisition                     | Decoding (mediabunny/flac/wasm), PCM mic recorder (0.5 s durable chunks), MIDI import (tempo-map rescale to project grid) | MIDI import **drops pitch bends** (`midiFile.ts:129` counts them as unsupported); SMPTE-timed MIDI rejected                                                                                                                                                                             |
| Analysis                        | Onsets, tempo, key, chroma chords, per-stem mono transcription, band shares, LUFS/TP, descriptors, AST tags, Demucs stems | **(L1) Audio→symbolic conversion is one-way and lossy with honesty gates**: melody transcription returns empty when coverage <0.04; chord spans drop bars below 0.55 correlation; no polyphonic notes ever; downbeat = strongest-onset heuristic                                        |
| Structured representation       | Findings, summaries, VocalProfile, UnSunoTranscription, MixIdeaPlan                                                       | **(L2) Nothing is persisted or cached with doc-revision keys** — every analysis recomputes from scratch per call; there is no drill-down artifact an agent can reference across turns                                                                                                   |
| Context assembly                | `kyx_state` doc JSON; in-app selection for the intent bar                                                                 | **(L3) MCP context excludes selection and all audio evidence**; an agent assembles its own context via separate read/render tools each turn                                                                                                                                             |
| Reasoning                       | Deterministic route dispatch; ONNX intent heads; rankers; production-concept planner                                      | **(L4) Reasoning sees the plan, not the sound**: descriptor mapping is curated (±0.8 dB shelf for "warmth"); candidate audio-fit uses 4 crude features (rms/crest/zcr/lowRatio) vs genre ranges; no model reasons over actual audio semantics beyond AST labels                         |
| Proposal                        | MixIdeaPlan (pure, attributed WHY), paramIntent, automation plans, clarify chips                                          | **(L5) Proposals are not range-aware**: paramIntent writes a static param value with **zero** awareness of existing automation lanes on that param (grep → 0 hits in `param-intent.ts`); the lane keeps animating and ADR 0067 says automation outranks the static write while it lives |
| Command                         | Canonical commands, inverse-patch undo, coalescing, checkpoints, stale-write guard, idempotency                           | Guard is **field-level**: an AI write to a field the human did not touch between read and apply succeeds even if the human moved a _different_ field the plan depended on (by design, but plan-vs-world drift beyond one field is unguarded)                                            |
| Verification                    | verifiedMutation read-backs; loudness verify loop; param read-back; mix preview; blind A/B; song-audio-review             | **(L6) Verification is whole-strip or whole-song**; no per-time-range before/after diff exists, so "did the chorus lift?" cannot be answered programmatically today                                                                                                                     |

**Units and clocks:** disciplined. Ticks (PPQ 480) are the musical authority; seconds come from `tempoAtTick`/`buildTempoMap` (piecewise scene pins, gaps at project BPM); sample-exact alignment is proven by the PDC browser check (≤2 samples). Known seams: `BAR_TICKS=1920` vs document `ticksPerBar` dual-unit discipline (ADR 0056, migrated, guarded by tests); tempo is piecewise-constant (no curves — also an expressivity limit); `quantize.cmd.ts` does not exist (the real file is `src/commands/quantize.ts`; `src/export/quantize.ts` is unrelated PCM dither — a naming landmine for agents).

**Cached analysis invalidation:** the two caches that exist are safe-by-construction: warp cache keys include wall-length + warp-marker hash; onset-dot cache is keyed on immutable `bufferId` + channel (source-absolute transients, deliberately not invalidated by clip edits) with FIFO cap 96. Frozen buffers are staleness-_detected_ ("EDITED SINCE FREEZE" chip, document-signature SHA-256, `freezeSignature.ts`). Analysis results are never cached, so they can never go stale — at the price of recompute.

**"Syntactically valid but musically wrong" seam (the sharpest finding):** every AI write passes structural verification, but ADR 0067 introduces a _temporal_ ownership dimension the intent layer does not consult: a static param write during an automation lane is legal, verified, read back — and inaudible wherever the lane has points. The system knows this at the engine layer (`ownerOf`) and shows it in the UI (ModulationOwnerBadge) but does not tell the writing agent.

---

## 4. Human–AI musical parity matrix

Legend: **AI tools** = concrete surfaces; **Verification** = can the system check the outcome; Gap = remaining distance. NOT_APPLICABLE used where the product's beat-first scope makes the task out of scope.

| #   | Musical task                                                                  | Human-visible evidence   | AI-readable evidence today                                                                                                                                                                | Inference required                              | AI tools                                                                | Preview/undo           | Outcome verification                                          | Gap                                                                                       | Confidence  |
| --- | ----------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------- |
| 1   | Find the chorus, compare its energy to the verse                              | Hears the form           | Generated songs: SceneRole + per-section RMS review (`song-audio-review.ts`). Imported audio: energy-threshold sections (reference flow only). **No per-range measurement tool over MCP** | Medium (role = authored label)                  | kyx_state, kyx_sections, kyx_song review, sectionMixDoctor (build flow) | One-undo commands      | Per-section RMS for generated songs only                      | **Per-time-range measurement surface missing (MUG-01)**                                   | High        |
| 2   | Kick vs bass: rhythmically or spectrally competing?                           | Hears interaction        | Low-end-collision heuristic (band share + LU proximity, `mix-diagnosis.ts:244-269`); 60–120 Hz transient contrast (sectionMixDoctor); sidechain DSP exists                                | High — no onset-aligned interaction measurement | kyx_diagnose_mix, kyx_fx pump                                           | Preview card, one undo | Re-diagnose loop                                              | **Interaction unmeasured (MUG-06)**                                                       | High        |
| 3   | Tighten a groove without destroying intended swing                            | Hears feel               | Groove extraction + microtiming in ticks; quantize with strength; take-scoring tightness/spread/feel; density/syncopation symbolic metrics                                                | Low-medium                                      | kyx_groove, steal-groove, quantize, kyx_steps                           | Commands + read-back   | Groove read-backs; live==offline invariant                    | Swing-intent preservation unverified (no before/after groove-distance metric) — MUG-03/E3 | High        |
| 4   | Detect vocal timing/pitch inconsistencies without enforcing uniformity        | Hears take details       | Take-level: tightness, pitch drift, spread, feel (evidence strings). **No per-phrase/per-note deviation view**                                                                            | Medium                                          | smart comp evidence, vocal profile                                      | Comp preview strip     | Score + evidence lines                                        | **Note-level performance map missing (MUG-08)**                                           | High        |
| 5   | Suggest complementary harmony preserving the composition                      | Knows the key/genre      | Chord track, `planVocalHarmony` diatonic stacks, `voiceLead`, REZONANS chord-tone solver, chord-snap                                                                                      | Low (rules)                                     | kyx_music, harmony commands, rezonans                                   | One undo               | Scale-membership is structural; no "does it sound good" check | Tension/voice-leading quality unmeasured (MUG-09)                                         | High        |
| 6   | Make a vocal more intimate, preserve intelligibility                          | Hears intimacy + clarity | "Intimate" NOT in the 26 production concepts; nearest curated concepts (warmer/air/deess) map to shelves; **intelligibility unmeasurable** (grep → 0)                                     | Very high                                       | kyx_mix_idea (partial), kyx_fx                                          | Preview + undo         | Only spectral/proxy metrics                                   | **Semantic descriptor + intelligibility gap (MUG-05)**                                    | High        |
| 7   | Prepare an effect transition at a musical boundary                            | Knows the form           | Typed transitions + cue clips + marker auto-triggers + automation grammar in bars + scene automation lanes                                                                                | Low                                             | kyx_automation, kyx_sections, transitions                               | One undo               | Read-backs; transitions re-validated on edits                 | Strong — near parity                                                                      | High        |
| 8   | Explain why an arrangement feels static, with evidence                        | Hears monotony           | Generated songs: development rules + revivals (≥8 dB under median). Hand-built: **no repetition/variation census, no measured energy trajectory**                                         | Medium-high                                     | (generated flow only)                                                   | n/a                    | song-audio-review for generated                               | **Repetition census missing (MUG-07)**                                                    | High        |
| 9   | Compare two takes; explain differences; no absolute winner                    | Hears both               | 4-axis score + evidence strings — **but `planSmartComp` ranks by design** (tightness>clip>pitch>floor); blind A/B exists for subjective calls                                             | Low                                             | smart comp, kyx_blind_ab                                                | Comp preview, one undo | Evidence strings; human A/B verdicts                          | **Composite winner by default (MUG-13)** — deltas explained, ranking imposed              | Medium-high |
| 10  | Check whether a proposed automation change conflicts with existing automation | Sees the lane            | One-lane-per-target refusal; per-field stale-write guard; ADR 0067 ownership at engine layer; **no range/point conflict query; paramIntent blind to lanes**                               | Low (it's a query, not a judgment)              | kyx_automation, write-conflict guard                                    | One undo               | Read-back only                                                | **Automation-aware writes missing (MUG-02)**                                              | High        |

---

## 5. Top 15 musical intelligence gaps

Mandatory format per finding. Severity: HIGH = blocks a core musical competency for the intended user; MED = meaningful quality/ergonomics loss; LOW = ceiling, not a wall.

---

**MUG-01 · No per-time-range musical measurement or verification surface**

- ID: MUG-01 / Severity: HIGH / Evidence level: VERIFIED_CODE_PATH + VERIFIED ABSENCE / Confidence: High
- Capability & task: "Find the chorus and compare its energy to the verse"; verify any change landed _where_ intended.
- Observed behavior: `kyx_render_summary` measures per **strip** only (`render-summary.ts:135`); `song-audio-review` measures per section but only inside the generated-song flow; `sectionMixDoctor` needs an imported reference; no MCP tool accepts a tick/bar range for measurement. Greps for range-scoped measurement surfaces → none.
- Missing stage: representation (range-scoped evidence) and verification (range-scoped before/after).
- Why it matters musically: nearly every production judgment ("the drop hits harder than the chorus", "the bridge is too quiet") is range-conditional; today an agent can only answer these by building bespoke renders.
- Smallest credible solution: add a `range {fromBar,toBar}` scope to the existing render-summary/mix-doctor path (pure project-truth + offline render, no model). Alternatives: expose `song-audio-review`'s per-section RMS as a tool for any doc with markers.
- Risks/dependencies/validation: render cost per call (bounded by duration); validation = golden parity of range math with `buildTempoMap`.

**MUG-02 · Param writes are blind to existing automation (syntactically valid, potentially inaudible)**

- ID: MUG-02 / Severity: HIGH / Evidence level: VERIFIED_CODE_PATH / Confidence: High
- Capability & task: intent/MCP asks that set a param value must be musically effective.
- Observed behavior: `src/intent/param-intent.ts` contains zero references to automation (grep); `applyParamIntent` writes the static `instance.params[paramId]`; an existing lane keeps animating the same param, and per ADR 0067 (`modulation-precedence.ts:55`) automation outranks the static value while live. The engine knows (`ownerOf`, `automationBridge.ts:664-672`) and the UI shows it (`ModulationOwnerBadge`), but the writing agent is not told.
- Missing stage: reasoning (effective-value query) and verification (did the value actually move _and stick_).
- Why it matters musically: "make the pad filter open up" applied under an existing filter lane silently does nothing the human can hear — the worst kind of AI failure: verified success, inaudible result.
- Smallest credible solution: before any param write, query lane existence for the target; refuse-with-explanation or propose a lane edit. Extend param read-back to measure at a _point inside_ the lane's span when one exists. No model needed.
- Risks: product decision on refuse-vs-merge; validation = adversarial test suite (write-under-lane cases).

**MUG-03 · No repetition/variation census across patterns and sections**

- ID: MUG-03 / Severity: MED-HIGH / Evidence level: VERIFIED ABSENCE / Confidence: High
- Capability & task: "explain why the arrangement feels static, with observable evidence."
- Observed behavior: similarity machinery exists only for groove-library dedup (`ai/grooves/dedup.ts`, narrow rule) and preset ranking (`presets/similar.ts`, parameter distance). No pattern-fingerprint graph, no instance-similarity, no measured energy trajectory for hand-built arrangements (scene intensity is authored).
- Missing stage: observation + interpretation.
- Why it matters: static-ness is a top-3 producer complaint and is _computable_ from project truth (pattern reuse, velocity variance, section contrast in rendered energy).
- Smallest credible solution: offline analysis that renders section energy + computes pattern-similarity (existing `canonicalizePattern` + Jaccard machinery from `similarity-advisory.ts`); report as findings. Alternatives: reuse `song-audio-review`'s revivals logic for arbitrary docs with markers.
- Risks: false "static" verdicts on intentionally minimal genres (drone) — gate by genre/role.

**MUG-04 · No polyphonic audio→note transcription**

- ID: MUG-04 / Severity: MED-HIGH / Evidence level: VERIFIED_CODE_PATH / Confidence: High
- Capability & task: rebuild/cover flows from real recordings; "what notes are in this sample?"
- Observed behavior: `reference/transcribe.ts` = HPSS/neural stems → per-stem monophonic YIN + chroma chords; melody layer honestly empty when coverage <0.04 ("polyphonic bleed beats the gates"); greps for `basic-pitch|crepe|onsets-and-frames` → 0.
- Missing stage: observation.
- Why it matters: covers/restyle quality is capped by transcription fidelity; piano-pads and polyphonic leads are invisible as notes.
- Smallest credible solution: keep stems+mono as the _shipping_ path (it is honest and bounded); prototype a small note-level polyphonic transcription model (e.g., basic-pitch-class, ~17 MB, Apache-2.0 — **licensing/size/budget review required**) behind the existing manifest-gate + worker + breaker pattern used by every model in this repo.
- Risks: bundle/model budget (repo has hard budget lines), WASM memory (fp32 Demucs already requires WebGPU), license review (owner gate).

**MUG-05 · Semantic timbre space is a closed curated vocabulary**

- ID: MUG-05 / Severity: MED-HIGH / Evidence level: VERIFIED_CODE_PATH / Confidence: High
- Capability & task: "make it more intimate / mellow / vintage / expensive."
- Observed behavior: three systems, all curated: production concepts (26 fixed words → device plans, `production.ts:15-44`), effect-intent goals (bounded ±0.8–1.1 dB moves, `capabilities.ts`, explicitly `evidence: "curated-unreviewed"`), and measured correlates (crest/zcr/centroid) scored against genre ranges. The multilingual MiniLM embedding model exists but embeds **text**, not audio; AST gives AudioSet labels (527 classes, not aesthetic descriptors). No audio-text similarity, no audio embedding retrieval.
- Missing stage: interpretation (mapping free aesthetic language to measurable/audio-grounded targets) and verification (only proxies exist).
- Why it matters: this is the difference between a tool that executes taste words and one that understands them; it is also where LLM reasoning over _structured evidence_ could pay off without training.
- Smallest credible solution: (a) extend the curated table with per-concept verification metrics (e.g., "intimate" → proximity/ratio + HF roll + dynamic range) — pure DSP + data; (b) prototype an audio-embedding model (e.g., CLAP-family) offline for descriptor retrieval — RESEARCH, budget/licensing-gated.
- Risks: subjective ground truth; must keep "measurements, not taste verdicts" honesty line.

**MUG-06 · Masking/interaction analysis = band-share heuristics**

- ID: MUG-06 / Severity: MED / Evidence level: VERIFIED_CODE_PATH / Confidence: High
- Capability & task: "identify whether kick and bass compete rhythmically or spectrally" — and verify a fix helped.
- Observed: `mix-diagnosis.ts:244-295` low-end-collision (band share >0.5 + LU proximity), `sectionMixDoctor.ts:150-157` (60–120 Hz share >0.55 + transient contrast <1.7). No per-bin/time-frequency masking model; onset machinery not wired into mix analysis; no kick-vs-bass transient-alignment measurement.
- Missing stage: observation (interaction), verification (did the fix help _at the mask_).
- Why it matters musically: masking is a _time-domain_ interaction — a bass that is quiet on average can still swallow every kick transient; band shares cannot see that, so both findings and fix-verification measure the wrong axis.
- Smallest credible solution: classical DSP — onset-windowed band energy of kick vs bass, overlap integral per beat; add one finding type + one verification metric. No model.
- Risks/dependencies/validation: threshold tuning per genre; keep report-only until validated; validation = agreement with known sidechain on/off states (experiment E2).

**MUG-07 · Take-level vocal understanding only (no note-level performance map)**

- ID: MUG-07 / Severity: MED / Evidence level: VERIFIED_CODE_PATH / Confidence: High
- Capability & task: "detect vocal timing/pitch inconsistencies without enforcing stylistic uniformity."
- Observed: take-scoring is take-granular; hum→notes segmentation exists but only for hummed input; no per-phrase onset/pitch deviation display for _sung_ takes; no VAD/breath/silence tools (greps → 0).
- Missing stage: representation (notes/phrases of sung audio) + interpretation (deviation vs choice).
- Why it matters musically: "the second chorus was 40 ms late" is exactly the feedback a singer can act on; a take-level score cannot express where or when, so the user cannot preserve the deviations that were deliberate.
- Smallest credible solution: reuse `detectTransients` + YIN over the take's playable window to render a per-phrase timing/pitch map (read-only panel + tool); VAD from the existing RMS-floor machinery. No model.
- Risks/dependencies/validation: false positives on breathy/vibrato material — display with confidence, never auto-edit; validation = manual annotation agreement (E4).

**MUG-08 · Dissonance/tension unmeasured; harmony suggestions diatonic-only**

- ID: MUG-08 / Severity: MED-LOW / Evidence level: VERIFIED ABSENCE / Confidence: High
- Capability & task: "suggest a complementary harmony while preserving the composition"; judge whether a voicing adds or destroys tension.
- Observed: greps for dissonance/roughness → 0 real hits; 9 Western scales; no microtonality; A4 hardcoded 440.
- Missing stage: observation (tension as a measurable) and interpretation (tension curves across a progression).
- Why it matters musically: harmony quality is largely tension management; without any tension measure, suggestions can be diatonically correct and dramatically wrong (a resolved cadence where a suspended lift was wanted).
- Smallest credible solution: sensory roughness (Sethares/Plomp-Levelt over partials) as a symbolic+DSP metric for chord-track and harmony proposals; scale tables are data. Non-Western scales = data + tests.
- Risks/dependencies/validation: product scope (beat tool) — the diatonic ceiling is deliberate today; validation = roughness rankings match music-theory expectations on a golden progression set.

**MUG-09 · Beat/downbeat tracking from audio absent**

- ID: MUG-09 / Severity: MED / Evidence level: VERIFIED ABSENCE / Confidence: High
- Capability & task: align imported/recorded audio to the grid with bar-accurate downbeats; "steal the groove" phase correctness.
- Observed: tempo engines exist; phase = loudest-onset anchor (`groove-extract.ts:73-77`); no tracked beat sequence; grid alignment of free-recorded audio is phase-risky.
- Missing stage: observation (tracked beat phase over time, not a single anchor).
- Why it matters musically: every downstream groove-steal, tempo-fit and grid-slice operation inherits the anchor's error; a wrong downbeat flips swing from "laid back" to "rushed" — the feel inverts.
- Smallest credible solution: local MIR beat/downbeat tracker (e.g., a small DBN over onset envelopes, or a pretrained beat model behind the manifest gate); start with downbeat-anchor improvement using the existing multi-band onset envelopes.
- Risks/dependencies/validation: tempo-curves-in-audio (the system itself is piecewise-constant, MUG-13); validation needs labeled data (licensing owner gate).

**MUG-10 · No analysis persistence / revision-keyed evidence cache**

- ID: MUG-10 / Severity: MED-LOW / Evidence level: VERIFIED ABSENCE / Confidence: High
- Capability & task: multi-step agent loops (diagnose → fix → verify) and any cross-turn reference to earlier measurements.
- Observed: every analysis (render summary, diagnose, loudness, VLYX features) recomputes per call; nothing is keyed on `ProjectStore.getRevision()`. Benefit: zero stale-analysis risk. Cost: an agent doing diagnose→fix→verify pays full render cost every step; no drill-down history.
- Missing stage: representation (persisted evidence with invalidation policy).
- Why it matters musically: without cached evidence, agents shorten their measurement loops to stay fast — which is exactly how musically wrong-but-verified actions slip through; also no way to ask "what did the verse measure an hour ago?"
- Smallest credible solution: revision-keyed evidence envelope cache (see §7 contract) with explicit invalidation = revision change; freeze/frozen-buffer signatures already model the pattern.
- Risks/dependencies/validation: cache correctness — mitigate with the existing revision counter, never wall-clock; validation = 0 stale hits under mutation fuzz (E10).

**MUG-11 · MCP context excludes selection and structured evidence**

- ID: MUG-11 / Severity: MED-LOW / Evidence level: VERIFIED_CODE_PATH / Confidence: High
- Capability & task: "tighten THIS fill" / "fix THESE steps" — range- and selection-conditional asks over MCP.
- Observed: no MCP tool receives UI selection (grep → 0); context = doc JSON + capabilities; agents self-instrument via renders.
- Missing stage: context assembly (what the human is pointing at; precomputed evidence).
- Why it matters musically: deictic intent ("this", "here") is the most natural producer language; an agent that cannot see the selection must guess the target or ask — and asking for what the UI already knows erodes trust.
- Smallest credible solution: optional `scope` argument (selection summary) + evidence envelope in `kyx_state`; in-app intent routes already carry selection, so parity is the goal, not new capability.
- Risks/dependencies/validation: leaking overly large context — enforce caps like the existing 14-strip diagnosis cap; validation = targeting accuracy on deictic prompts (E9).

**MUG-12 · Take comparison imposes a composite winner by default**

- ID: MUG-12 / Severity: LOW-MED / Evidence level: VERIFIED_CODE_PATH / Confidence: Medium-High
- Capability & task: "compare two takes and explain measurable differences without declaring an absolute winner."
- Observed: `planSmartComp` ranks (tightness > clipping > pitch > floor, `smart-comp.ts` + `tests/smart-comp-scoring.test.ts` pins the product decision); evidence strings explain deltas, but ranking is product truth. The system's own honesty culture ("character reading, NOT a quality score") is partially overridden by the score.
- Missing stage: interpretation mode (deltas as explanations vs deltas as a ranking).
- Why it matters musically: take choice is artistic — tightness is not always the winning axis (a loose chorus take can be the right one); a default winner nudges users toward the tool's priority ordering instead of their own.
- Smallest credible solution: expose a "differences only" mode (no composite) as the default view; keep ranking opt-in. Pure UX/data change.
- Risks/dependencies/validation: decision paralysis for users who want the pick — keep the default one click away; validation = blind A/B that the deltas shown are the ones humans actually disagree on.

**MUG-13 · Continuous tempo automation absent (piecewise scene pins only)**

- ID: MUG-13 / Severity: LOW (product scope) / Evidence level: VERIFIED_CODE_PATH / Confidence: High
- Capability & task: ritardando/accelerando builds; tempo-mapped imported audio that bends over time.
- Observed: scene BPM pins + 5 ms seam flip + offline `buildTempoMap`; no user tempo curve (grep → 0). Correctly coordinated live/offline; the limit is expressivity, not correctness.
- Missing stage: representation (tempo as a curve) and consequently observation (alignment of tempo-drifting audio).
- Why it matters musically: many imported references and recorded intros drift; a piecewise map treats them as wrong tempos rather than shaped tempos, so fit/warp decisions inherit a systematic bias.
- Smallest credible solution: DEFER until a user demand signal exists; the piecewise machinery is the right foundation (curves would slot into `tempoAtTick`/`buildTempoMap`).
- Risks/dependencies/validation: touching the time authority is the highest-blast-radius change in the repo — any future curve work needs the full tempo-gate suite plus new goldens.

**MUG-14 · Sung-audio pitch editing absent beyond global scale-snap**

- ID: MUG-14 / Severity: MED (for vocal-product claims) / Evidence level: VERIFIED_CODE_PATH / Confidence: High
- Capability & task: correct one wrong note in a sung take while keeping the performance's character.
- Observed: pitchCorrect is a realtime global scale-snap effect (≤200 cents); no note-level pitch editing of recorded audio; PSOLA exists offline, opt-in, "amplitude behaviour on real hums not yet owner-verified" (`voiceify.ts:42-50`).
- Missing stage: action (note-scoped edit) on top of MUG-07's missing representation.
- Why it matters musically: global scale-snap corrects everything equally, which flattens expressiveness; producers want surgical, per-note moves with the original vibrato and breath preserved.
- Smallest credible solution: pair MUG-07's note map with offline per-note PSOLA correction behind an explicit user action; owner ear-pass gate before default.
- Risks/dependencies/validation: artifact risk; PSOLA already flagged as needing owner verification; validation = formant-preservation ABX on real takes.

**MUG-15 · No cross-track "what-if" reasoning over routing/automation**

- ID: MUG-15 / Severity: MED-LOW / Evidence level: VERIFIED_CODE_PATH / Confidence: Medium
- Capability & task: "if I duck the bass on the drop, what else moves?" — consequences of a change across the signal chain and later sections.
- Observed: the state model (flat routing, sends, lanes, scene automation, revision guard) supports it; nothing consumes it to answer the question. Iterate executor (`master-iterate.ts`) is target-seeking over the _master_, not relational.
- Missing stage: reasoning (relational queries over routing/automation/ownership state).
- Why it matters musically: mixing IS cross-track reasoning — sidechains, send changes and automation interact; an agent that plans one track at a time will produce changes that fight each other (e.g., a pump fighting an existing duck automation on the same target).
- Smallest credible solution: evidence-first: expose sidechain/duck targets and send graph in `kyx_state` reasoning docs + let the plan layer validate against ADR 0067 ownership (pure queries). What-if DSP simulation = RESEARCH/DEFER.
- Risks/dependencies/validation: depends on the §7 envelope and MUG-02's lane queries; validation = adversarial plans that previously conflicted are now caught at plan time.

---

## 6. DSP vs MIR vs pretrained-model vs LLM decision table

Principle observed in this repo and endorsed here: **project-truth first, DSP second, MIR algorithms third, pretrained models only behind manifest gates with honest fallbacks, LLM reasoning last (currently only local Ollama, kill-switched).** "Training needed?" is almost always NO.

| Gap                            | Project-truth query                   | Classical DSP                | MIR algorithm                | Pretrained model                          | LLM reasoning                        | Training?                          |
| ------------------------------ | ------------------------------------- | ---------------------------- | ---------------------------- | ----------------------------------------- | ------------------------------------ | ---------------------------------- |
| MUG-01 range measurement       | ✔ (bars→ticks→render windows)         | ✔ offline render + BS.1770   | —                            | —                                         | narrates numbers                     | NO                                 |
| MUG-02 automation-aware writes | ✔ lane queries + ownership read model | —                            | —                            | —                                         | explain refusal                      | NO                                 |
| MUG-03 repetition census       | ✔ pattern fingerprints                | ✔ section energy render      | similarity (Jaccard exists)  | —                                         | explain                              | NO                                 |
| MUG-04 polyphonic notes        | —                                     | stems+mono (have)            | —                            | **candidate** (small transcription model) | —                                    | NO (use pretrained) — license gate |
| MUG-05 semantic timbre         | curated table (have)                  | ✔ per-concept metrics        | —                            | **candidate** (audio embedding)           | ✔ map language→metrics over evidence | NO for (a); RESEARCH for (b)       |
| MUG-06 masking interaction     | —                                     | ✔ onset-windowed band energy | —                            | —                                         | —                                    | NO                                 |
| MUG-07 note-level vocal map    | —                                     | ✔ onsets+YIN (have)          | segmentation (have, for hum) | —                                         | —                                    | NO                                 |
| MUG-08 tension/dissonance      | ✔ chord track                         | ✔ roughness over partials    | —                            | —                                         | —                                    | NO                                 |
| MUG-09 beat tracking           | —                                     | onset envelopes (have)       | ✔ beat/downbeat tracker      | optional small model                      | —                                    | NO for DSP tracker                 |
| MUG-10 evidence cache          | ✔ revision key (have)                 | —                            | —                            | —                                         | —                                    | NO                                 |
| MUG-11 selection scope         | ✔ SelectionStore (have)               | —                            | —                            | —                                         | —                                    | NO                                 |
| MUG-12 compare w/o winner      | ✔ scoring data (have)                 | —                            | —                            | —                                         | —                                    | NO                                 |
| MUG-13 tempo curves            | ✔ (extend tempoAtTick)                | —                            | —                            | —                                         | —                                    | NO                                 |
| MUG-14 note pitch edit         | —                                     | ✔ PSOLA (have, offline)      | note segmentation            | —                                         | —                                    | NO                                 |
| MUG-15 what-if reasoning       | ✔ graph + ownership queries           | —                            | —                            | —                                         | ✔ plan narration                     | NO                                 |

**Models already in the repo** (verified from manifests/reports): intent-ranker-v1 (~25 KB, active), intent-model-v1 (2.48 MB INT8, 59 heads, gatePassed), symbolic prior v1–v3, symbolic melodic v1–v3, mastering assistant (shadow), semantic MiniLM (~118 MB q8, flag), AST AudioSet tagging (q8, flag), HT-Demucs fp32graph (WebGPU-required, gatePassed, 6.58× realtime). The repo's model-infra pattern (manifest + sha256 + gatePassed pin + worker + timeout + breaker + deterministic fallback) is the right chassis for any addition.

**Hard real-time rule (protected):** nothing in this report proposes analysis on the audio callback. Every existing analyzer either runs offline (renders), in a worker, or as a bounded worklet (kwmeter). All proposals above inherit that constraint; MUG-10's cache is main-thread-safe by construction (revision key + no audio I/O).

---

## 7. Proposed minimal musical context contract (PROPOSAL — nothing like this exists today)

A model-agnostic **MusicalEvidence** envelope: small, serializable, provenance-tagged, revision-keyed. It reuses existing primitives (PPQ 480 ticks; `tempoAtTick`/`buildTempoMap` conversion semantics; `ProjectStore.getRevision()`; bufferIds) and adds nothing to the project schema.

Common envelope fields: `schemaVersion`; `subject {trackId?, clipId?, patternId?}`; `span {fromTick, toTick, fromSec?, toSec?}` with **conversion semantics stated**: ticks are authoritative, seconds derived via the piecewise tempo map (scene pins; gaps at project BPM), samples only meaningful at a named render sampleRate; `provenance: "project-truth" | "dsp-estimate" | "model-inference" | "user-annotation"`; `confidence 0..1 | null`; `measuredAt` (doc revision + wall clock); `analyzer {id, version}`; `invalidation: "revision"` (recompute when revision changes) — mirroring the freeze-signature pattern.

**Example 1 — rhythmic evidence for a clip (proposal):**

```json
{
  "schemaVersion": "musical-evidence.v1",
  "subject": { "clipId": "clip_9f2", "trackId": "tr_kick" },
  "kind": "rhythm",
  "span": { "fromTick": 0, "toTick": 7680, "secondsNote": "via buildTempoMap @ rev 4123; 4 bars @ 124 bpm scene pin" },
  "provenance": "dsp-estimate",
  "confidence": 0.82,
  "analyzer": { "id": "onset-flux+v1", "version": "worker@6a21ad29" },
  "data": {
    "estimatedBpm": 124.0,
    "bpmConfidence": 0.91,
    "onsetsSec": [0.0, 0.4839, 0.9677],
    "gridDeviationMs": [-3.1, 5.2, -1.0],
    "downbeatAnchor": "strongest-onset",
    "downbeatConfidence": null
  }
}
```

**Example 2 — mix evidence for a strip in a range (proposal):**

```json
{
  "schemaVersion": "musical-evidence.v1",
  "subject": { "trackId": "tr_bass" },
  "kind": "mix-band",
  "span": { "fromBar": 17, "toBar": 33 },
  "provenance": "dsp-estimate",
  "confidence": null,
  "analyzer": { "id": "mix-doctor@analyzeMixHealth", "version": "v1" },
  "invalidation": "revision",
  "data": {
    "render": { "sampleRate": 44100, "masterChain": false },
    "lufsIntegrated": -12.4,
    "peakDb": -0.9,
    "crestDb": 7.1,
    "bandShares": { "sub": 0.41, "low": 0.33, "lowmid": 0.09 },
    "correlation": 0.6
  }
}
```

**Example 3 — agent context packet for an intent call (proposal):**

```json
{
  "schemaVersion": "musical-evidence.v1",
  "kind": "context-packet",
  "docRevision": 4123,
  "selection": { "kind": "steps", "padIds": ["hat_c"], "fromStep": 8, "toStep": 15 },
  "targets": { "candidateTracks": ["tr_hat_c"], "roles": { "tr_hat_c": "hats" } },
  "evidence": [{ "$ref": "rhythm@tr_kick:0-7680" }, { "$ref": "mix-band@tr_bass:bar17-33" }],
  "capabilities": { "verify": ["render-summary", "param-readback", "blind-ab"] },
  "policy": { "clarifyFirst": ["negated-mutation", "ambiguous-send-return"] }
}
```

Ground truth vs measurement vs inference vs preference: `project-truth` (schema fields) is ground truth for _what the user built_; `dsp-estimate` is measurement; `model-inference` is inference and must carry confidence + version; preference (does it _sound_ good) is **never** in the envelope — it lives in blind-A/B verdicts and user ratings, which the codebase already keeps separate (`vocal/sessions.ts` ratings, `blind-ab` trial records).

Permissions/minimization: envelopes carry ids and numbers, never audio; reference audio stays local (`referenceRepository.ts` is IndexedDB local-only) — any future envelope over MCP must keep that boundary.

---

## 8. Evaluation design — prove understanding, not fluent language

**Layer 1 — Perception accuracy.** Extend the existing golden/honest-gate pattern. Datasets: (a) in-repo synthesized corpora (current practice — deterministic, license-clean); (b) owner-gated public corpora for _calibration only_ (tempo/key/onset ground truth — licensing review required per repo culture; e.g., GTZAN/LAKH-class sets are research-licensed: human decision, no bundling into the product). Metrics: tempo error distribution (±0.1 BPM hit rate), key accuracy (and honest-abstain rate — abstaining on ambiguous input is a _feature_ to measure, not a failure), onset F-score at ±50 ms, chord-span label accuracy at bar resolution, LUFS error vs reference implementation, true-peak error vs a reference oversampler. Variation axes: genre, tempo, instrumentation, noise floor, MP3/limiting processing.

**Layer 2 — Reasoning and planning quality.** Grounded-answer benchmark over the 39-tool surface: given a seeded doc + a task, does the agent's plan target the right object/time range with valid actions? Metrics: object/time targeting accuracy, invalid-action rate (already partially observable via `WRITE_CONFLICT`/`POLICY_REFUSED`/`clarify` outcomes), uncertainty calibration (does abstain rate track actual ambiguity?), groundedness (every claim traceable to an evidence id in the §7 envelope). Required adversarial sets (all constructible in-repo): metadata-vs-audio disagreement (doc says A minor, audio is F# — who wins and does the system _say_ what it used?), stale state (plan against rev N, doc moves — the revision guard's real test), contradictory requests ("make it quieter and louder"), missing context (no key set, REZONANS degradation honesty).

**Layer 3 — Audible usefulness and trust.** The repo already owns the right instrument: `kyx_blind_ab` (symmetric LUFS level-matching, two-sided binomial, "The agent plans and counts; the human listens") plus ABX scripting (`listening:abx`). Protocol: task-based A/B (AI-assisted vs manual vs deterministic-only), forced choice per task, corrective-action count, rollback count, time-to-done; human raters blind to condition; never treat one aesthetic as correct — report preference distributions. Baselines are mandatory: (1) no-AI manual workflow, (2) deterministic DSP/MIR only (models off — the flag system makes this a real condition, not a hypothetical), (3) full model-assisted. Never fabricate scores; publish the harness + seeds.

**Leakage/limits:** synthesized-only training data risks overfitting to the generator; any public-corpus calibration must document splits; listening tests are small-N by nature (binomial honesty is already the house style).

---

## 9. Focused experiments (10, prioritized by learning value)

Format: Hypothesis | User scenario | Minimum implementation | Baseline | Data | Metrics | Pass threshold | Time/compute | Dependencies | Risks | Stop condition.

**E1 — Range-scoped render measurement (mixing context; serves MUG-01).**

- H: Range-scoped offline render + BS.1770 measurement reproduces whole-strip numbers within ±0.3 LU when range = full strip.
- Scenario: "Is the drop louder than the chorus?" over MCP.
- Min impl: read-only tool/flag on the existing render-summary path accepting `{fromBar,toBar}`; windows derived via `buildTempoMap`.
- Baseline: whole-strip summary. Data: seeded generated songs (house/dnb/ambient). Metrics: LU delta vs known synthetic section levels; duration cost.
- Pass: measured delta within ±0.3 LU of ground truth; <5 s per call for ≤3 min docs. Time: ~1 day. Deps: none. Risks: tail ringing across boundaries — fixed 0.6 s tail policy. Stop: if range math disagrees with `buildTempoMap` golden, fix before shipping.

**E2 — Onset-aligned kick/bass interaction metric (mixing; MUG-06).**

- H: Kick-windowed 60–150 Hz bass energy (during kick transients vs between) separates "competing" from "locked" mixes better than the current band-share heuristic.
- Scenario: diagnose_mix finding upgrade; verify sidechain fix helped.
- Min impl: offline analysis module reusing `detectTransients` + existing band biquads; report-only finding + a verify metric.
- Baseline: current low-end-collision heuristic. Data: 30 seeded docs (sidechain on/off × tempo). Metrics: separation between conditions; agreement with the known sidechain state.
- Pass: >90 % agreement with ground-truth sidechain state; finding fires on the classic case. Time: 2–3 days. Deps: none. Risks: genre variance (808 glides). Stop: if separation < heuristic on adversarial set, keep heuristic and record why.

**E3 — Groove-distance metric + "tighten while preserving swing" preview (rhythm; parity #3).**

- H: A per-step timing-distance metric between a pattern and its groove reference predicts human "same feel" judgments above chance.
- Scenario: tighten drums without flattening intended swing.
- Min impl: read-only metric over `stepMeta.microtiming` + `swingOffsetTicks`; before/after render A/B cards (existing mix-preview chassis).
- Baseline: raw quantize-to-grid. Data: groove library + steal-extracted grooves. Metrics: timing entropy preserved %; blind A/B preference.
- Pass: ≥70 % "same feel" blind A/B vs original after max-tighten; timing-entropy drop ≤20 %. Time: 2–3 days + one listening session. Deps: listening protocol. Risks: swing perception is tempo-dependent. Stop: if blind A/B ≤ chance, the metric is not capturing feel — do not ship.

**E4 — Recorded-vocal note-level timing/pitch map (vocals; MUG-07).**

- H: Existing transients+YIN assembled per-phrase produce a useful deviation map (±25 ms timing, ±0.1 st pitch display) without false-positive noise dominating.
- Scenario: singer asks "where was I off?" — read-only display, no auto-edit.
- Min impl: analysis module over take's playable window; panel + tool result with confidence per phrase.
- Baseline: take-scoring evidence strings. Data: recorded takes (owner-provided) + synthesized vocal-like material. Metrics: agreement with manual annotation (small N), display stability across re-runs.
- Pass: stable across re-runs (deterministic); manual agreement on ≥80 % of flagged deviations. Time: 3–4 days. Deps: none. Risks: vibrato vs pitch error confusion — display, never judge. Stop: if vibrato/breath dominates flags, add phrase-level smoothing gate before reconsidering.

**E5 — Automation-aware param writes (intent grounding; MUG-02).**

- H: Querying lane existence + ownership before param writes eliminates "verified success, inaudible result" cases with negligible latency.
- Scenario: "open the pad filter" while a filter lane animates.
- Min impl: pre-write lane query in `param-intent`/`kyx_plugin_param`; refusal message naming the lane + owner (reuses ADR 0067 read model); adversarial tests.
- Baseline: current blind write. Data: adversarial docs (lane spanning write point; lane in gap). Metrics: inaudible-write count (should go to 0), false refusals (lane-in-gap case must still succeed).
- Pass: 0 silent no-ops; 0 false refusals in the gap case. Time: 1–2 days. Deps: none (read model exists). Risks: UX friction — message must offer the lane-edit alternative. Stop: n/a (correctness fix).

**E6 — Arrangement repetition/variation census (arrangement; MUG-03).**

- H: Pattern-instance similarity + section energy deltas yield findings that humans rate as "explains the staticness" ≥70 % of the time.
- Scenario: "why does my track feel static?"
- Min impl: offline census over `canonicalizePattern` fingerprints + range-scoped energy (E1); findings format like mix-diagnosis.
- Baseline: no tool. Data: hand-built arrangements (owner-provided) + generated songs (where the truth is known). Metrics: detection of known generated-drum repetition; human rating.
- Pass: catches ≥2 of the seeded known-repetition cases; human "useful" ≥70 %. Time: 3 days. Deps: E1 helper. Risks: minimal-genre false positives — role/genre gating. Stop: if human rating ≤ chance, publish as data-only.

**E7 — Audio structure segmentation: novelty vs energy-threshold (arrangement; MUG-04-adjacent).**

- H: A spectral-flux novelty/SSM segmentation beats the current energy-threshold `sectionsFromEnergy` on section-boundary F-score, at bounded cost.
- Scenario: import a reference and get true chorus boundaries, not just loud/quiet spans.
- Min impl: offline prototype (Hopcroft-style novelty on existing feature extractor bands), compared against `reference/structure.ts`.
- Baseline: current energy thresholds. Data: songs with known forms (owner-gated public set + synthesized sectional builds). Metrics: boundary F-score ±2 s.
- Pass: ≥ +0.1 F over baseline on held-out set; runtime ≤10 s for 3 min. Time: 4–5 days. Deps: licensing for eval audio (owner gate). Risks: O(n²) SSM — window to ≤3 min. Stop: if not beating baseline, document and defer.

**E8 — Descriptor verification for "intimate"-class asks (intent; MUG-05a).**

- H: Each of 6 new production concepts can be paired with a measurable proxy (e.g., intimate → proximity/side reduction + HF roll + crest increase) such that the param read-back loop reports a move ≥ threshold when the concept is applied.
- Scenario: "make the vocal more intimate" — plan, apply, verify with numbers.
- Min impl: extend `production.ts` table + `param-readback` role→metric map; honest null when proxy unmeasurable.
- Baseline: current unsupported-word path (clarify). Data: seeded vocal-ish docs. Metrics: read-back pass rate; blind A/B "did it get more intimate?" preference.
- Pass: read-back move ≥ threshold on all 6; blind A/B ≥ 60 % preference (small N, directional). Time: 2–3 days + listening. Deps: listening protocol. Risks: proxies ≠ perception — the honesty line stays ("measurements, not taste verdicts"). Stop: if blind A/B ≤ chance, downgrade concept to clarify-only.

**E9 — Intent target-grounding eval over MCP (Layer 2 benchmark seed).**

- H: A seeded doc + task benchmark can measure targeting accuracy/invalid-action rate/clarify calibration for the 39-tool surface, reproducibly.
- Scenario: harness for all future agent changes.
- Min impl: benchmark script driving `executeMcpToolAsync` over 50 seeded scenarios incl. adversarial ones (metadata-vs-audio disagreement, stale revision, contradictory ask); scoring from receipts (targeting, refusal, clarify).
- Baseline: current head. Data: seeded docs. Metrics: targeting accuracy, invalid-action rate, clarify precision/recall.
- Pass: harness reproducible (same seeds ⇒ same receipts); baseline numbers published. Time: 3–4 days. Deps: none. Risks: gaming the metric — keep adversarial sets private-rotating. Stop: n/a (infrastructure).

**E10 — Revision-keyed evidence cache (infrastructure; MUG-10).**

- H: Caching range-scoped evidence on `docRevision` cuts diagnose→fix→verify loop cost ≥3× with zero stale hits (revision always invalidates).
- Scenario: multi-turn agent sessions.
- Min impl: envelope store keyed `revision+subject+analyzer`; explicit invalidation test.
- Baseline: recompute-per-call. Metrics: loop wall time; stale-hit count (must be 0).
- Pass: ≥3× speedup on a 3-step loop; 0 stale hits across a mutation fuzz run. Time: 2 days. Deps: E1 for the evidence shape. Risks: memory growth — LRU like warp cache. Stop: if any stale hit is reproducible, the key is wrong — do not ship.

---

## 10. Architecture and roadmap

Dependency order: E5/E1 are prerequisites (correctness + measurement substrate) → evidence envelope + cache (E10) → perception upgrades (E2/E4/E6/E7) → semantics (E8) → benchmark infrastructure (E9) continuous.

### 0–30 days (all RESEARCH/PROTOTYPE, read-only or report-only)

- **E5 automation-aware writes** — PRODUCTION_CANDIDATE (correctness fix, no new surface). Gate: adversarial suite green. Failure mode: false refusals in lane-gap case.
- **E1 range-scoped measurement** — PROTOTYPE behind flag. Gate: ±0.3 LU parity vs buildTempoMap golden.
- **E2 kick/bass metric** — PROTOTYPE, report-only. Gate: ground-truth sidechain agreement >90 %.
- **E9 benchmark harness v0** — PROTOTYPE. Gate: reproducible receipts.
- **E4 note-level vocal map** — PROTOTYPE, display-only. Gate: deterministic + manual agreement.
- Go/no-go: any experiment that cannot beat or explain-vs its deterministic baseline in two weeks is recorded and stopped.

### 1–3 months (foundations)

- **MusicalEvidence envelope + revision-keyed cache (§7, E10)** — PRODUCTION_CANDIDATE. Gate: 0 stale hits under fuzz; no bundle-budget impact (main-thread, no audio I/O).
- **E6 repetition census** — PRODUCTION_CANDIDATE (findings tool + MCP), gated on human "useful" rating.
- **E3 groove-distance + tighten preview** — PROTOTYPE → owner A/B gate.
- **E8 descriptor table extension** — PRODUCTION_CANDIDATE behind existing curated-evidence discipline (`evidence:` field, review status).
- Likely failure modes: listening-test bandwidth (owner's ears are the bottleneck — batch into scheduled sessions); range-measurement cost on long docs (cap + chunk like the 14-strip diagnosis).

### 3–6 months (verified intent-to-sound, limited autonomy)

- **Per-range before/after verification** as a first-class receipt for all mix/arrangement intents (extends verifiedMutation). PRODUCTION_CANDIDATE.
- **E7 structure segmentation** — PROTOTYPE → production only if F-score gate passed on held-out data; else stays report-only.
- **Agent guardrails expansion**: plan-against-revision as the default contract for multi-step MCP sessions (the revision guard exists; make it universal). PRODUCTION_CANDIDATE.
- Owner-gated decisions: licensing review for any public eval corpus; model additions through the manifest-gate chassis only.

### 6–12 months

- **Multi-track relational reasoning over the evidence envelope** (sidechain/duck what-ifs as queries, MUG-15) — RESEARCH → PROTOTYPE.
- **Small polyphonic transcription model** (MUG-04) behind the model chassis, contingent on license + budget review and a golden eval beating stems+mono on held-out polyphonic material — RESEARCH.
- **Personalized assistance from existing ledgers** (vocal session ratings, intent mining ring, mastering corrections) — the data plumbing already exists and is dormant (`vocal/sessions.ts` PARTIAL, mining ring local-only); activation requires owner decision on using preference data. RESEARCH.

### 12–36 months (frontier, contingent)

- Audio-embedding retrieval for descriptor/aesthetic search (MUG-05b) — RESEARCH; contingent on demonstrated E8-style utility first.
- SVS / singing-voice synthesis per ADR 0031 — PROPOSED, owner-gated on corpus licensing (the ADR already says W3 hum→voice is the answer if the gate disqualifies).
- Continuous tempo curves (MUG-13) — DEFER unless user demand appears; the piecewise machinery is the correct foundation.
- True perceptual masking models, cross-time what-if simulation — DEFER; heuristics + queries cover the current need.

---

## 11. What already works and must be preserved

1. **The verification culture.** `verifiedMutation` choke point ("a success with an identical document is not a success"), value-level read-backs, param read-back with honest correction chips, loudness re-verify loop, codec-loss re-inspection, blind A/B binomial. This is the rarest thing in AI+audio tooling and every future capability should inherit it.
2. **Honest refusal to fabricate.** Honest-gates suite (noise → no tempo, no key); melody transcription returning empty; "unmeasured fields get an honest 'I can't hear it' line"; capability snapshots with `unavailableByDesign`; null-on-no-context meters. OBSERVED_RUNTIME green in this audit.
3. **Deterministic-first with model abstain.** The model route _gate_ (model may not overrule deterministic routes or invent mutations), margin abstain (4.8/2.0), clarify chips re-verified as executable, and mining of every miss into a local ring buffer.
4. **Live==offline parity as an invariant**, from groove consumption to PDC (browser check: sample-aligned export ≤2 samples) to offline intensity scheduling.
5. **Units discipline**: PPQ 480 authority, piecewise tempo map shared by live and offline, sample-exact PDC, ADR 0056's dual-unit honesty.
6. **Local-first model governance**: every model behind manifest + sha256 + gatePassed pin + worker + timeout + breaker + deterministic fallback; no cloud LLM; feature flags with opt-outs.
7. **Command/undo integrity**: inverse-patch deltas with dev round-trip verification, coalescing, checkpoints, revision guards — the substrate that makes agentic writes safe at all.
8. **The musical world model itself**: SceneRole, chord track, groove microtiming in ticks, automation lanes, ADR 0067 ownership — the representation layer is ahead of the perception layer; preserve and build on it rather than replacing it.

---

## 12. Unknowns, architectural risks, decisions requiring human approval

**Unknowns (not established by this audit):**

- In-domain quality of the AST tagger and MiniLM embeddings (manifests verified; no live inference run). UNKNOWN.
- Whether range-scoped measurement cost stays acceptable on long, dense projects. UNKNOWN until E1 measures.
- Blind-A/B statistical power at realistic small-N for E3/E8 style questions. UNKNOWN (binomial honesty helps but does not create power).
- Real-user failure distribution of intent parsing beyond the mining corpus (local-only by design). UNKNOWN to this audit.

**Architectural risks:**

- Four parallel YIN implementations (worker TS, rezonans TS port, pitchcorrect JS, bass-harmonic private copy) — drift is only caught by per-plugin goldens; a shared source would need the worklet/TS split solved deliberately.
- Recompute-per-call analysis economics as agents scale up multi-step loops (MUG-10).
- `BAR_TICKS=1920` vs document `ticksPerBar` dual-unit surfaces remain a permanent landmine class (ADR 0056 mitigations + tests are load-bearing — keep them).
- Naming collision: `src/commands/quantize.ts` (timing) vs `src/export/quantize.ts` (PCM dither) vs the nonexistent `quantize.cmd.ts`.
- Bundle/model budget pressure: any new model (MUG-04/MUG-05b) collides with hard budget lines and the 1070 KB entry budget — the budget process requires measured justification.

**Decisions requiring human approval (owner gates):**

1. Licensing review for any public eval corpus (Layer-1 calibration) and for any new pretrained model (transcription, audio embedding). The repo already treats licensing as an owner gate (ADR 0031 precedent).
2. Product call on MUG-02 policy: refuse vs offer-lane-edit vs merge when a param write meets an existing lane.
3. Product call on MUG-12: is the composite take ranking default-on (current) or differences-first?
4. Any change to the protected workflows (recording chain, live monitoring, undo semantics) — none is proposed; all proposals are additive read/analysis surfaces or pre-write guards.
5. Budget lines: range-scoped render tooling and any evidence cache add runtime cost; bundle budgets are frozen policy.
6. Listening bandwidth: every subjective gate (E3/E8) consumes owner A/B sessions; scheduling them is a human decision.

---

## 13. Final adversarial review

- **Did I mistake exposed controls for musical understanding?** Checked: every "capability" above is traced producer→consumer; PARTIAL labels are applied where consumers are missing (e.g., `suggestArrangementFromVocal` computed-but-unwired, `humAndHarmonizeCommand` without a UI caller, `transientProfile` with only an audit-script consumer). The scoreboard downgrades such items deliberately.
- **Did I mistake model-generated descriptions for measured facts?** The audit's own claims are code-traced or test-run; model _outputs_ were not executed and are marked UNKNOWN. The report keeps the codebase's own honesty line: measurements vs taste are separated everywhere, and the one place the code blurs it (composite take ranking, MUG-12) is flagged.
- **Did I confuse artistic preference with objective correctness?** §8 Layer 3 and MUG-12/E8 explicitly route subjective calls to humans; no recommendation trains a "goodness" model; the report endorses the repo's "human A/B is the final gate" stance.
- **Did I propose training where project metadata or DSP suffices?** The decision table (§6) marks training "NO" for 13 of 15 gaps; the two model candidates (MUG-04, MUG-05b) are pretrained-model or research-class, owner-gated, and only after deterministic alternatives are exhausted.
- **Did I ignore latency, audio-thread safety, licensing, privacy?** Real-time rule restated in §6; every proposal is offline/worker/main-thread-safe; licensing is an explicit owner gate; the evidence envelope carries ids/numbers only and reference audio stays local-first, matching `referenceRepository`'s IndexedDB boundary.
- **Are the highest-priority recommendations supported by direct evidence?** MUG-01 (per-strip-only summary: `render-summary.ts:135`), MUG-02 (zero automation refs in `param-intent.ts`, ADR 0067 ownership), MUG-03 (zero similarity/novelty hits) are each backed by greps + file:line re-checked by the auditor.
- **Have I preserved strengths?** §11 names eight, all evidence-backed; the roadmap explicitly builds _on_ the existing world model rather than proposing schema rewrites.
- **Can another engineer reproduce?** Every claim carries a path(+line where stable); the runtime claims are one vitest command (Appendix A); the experiments specify baselines, data, thresholds, and stop conditions; grep terms for absences are listed so absences can be falsified.
- **Self-corrections made during the audit:** the pitch agent initially expected audio key detection to be ABSENT — evidence showed three implemented lanes; corrected. The vocals agent expected uncommitted latency files — the working tree was clean at read time (concurrent session had committed); noted. ADR 0067 landed mid-audit (`64e71cd3`); both pre- and post-land states were read and the report describes the landed state.

---

## Appendix A — Runtime verification log (OBSERVED_RUNTIME)

Command: `npx vitest run tests/audio-reference.test.ts tests/bpm-detect.test.ts tests/groove-extract.test.ts tests/mix-doctor.test.ts tests/honest-gates.test.ts tests/param-readback.test.ts`
Result: **Test Files 6 passed (6) · Tests 104 passed (104)** — 29.89 s.
Highlights: honest-gates ("noise of any color has no tempo", "noise gets no key", "estimateTempo crest gate holds on adversarial input"), bpm-detect (30 tests), groove-extract (15), mix-doctor (18, incl. post-fix shaped mix → no red flags), audio-reference (tempo+key flow into reference patch), param-readback (14).
No dev servers, watchers, or builds were started during this audit; the vitest run was synchronous and finite; no processes remain (per `AGENTS.md` process lifecycle).

## Appendix B — Headline numbers used (from `docs/CURRENT-STATE.md`, verified 2026-10-14 tables)

31 instrument kinds · 57 effect types (6 flagship suites) · 264 groove library entries (6 odd-metre) · 643 factory presets · 658 artist presets · 21 genres · 1268 vitest spec files · 66 ADRs · intent model 2.48 MB INT8, 59 heads, 6144 features, gatePassed · intent-ranker ~25 KB, 54 features, active · symbolic prior/melodic v1–v3 · semantic MiniLM ~118 MB q8 (flag) · AST AudioSet q8 (flag) · HT-Demucs fp32graph gatePassed, WebGPU required · 39 MCP tools · 50 command modules · PPQ 480.

_End of audit. No source files were modified; this report is the only artifact produced._
