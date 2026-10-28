# KYX Musical Understanding Gap Audit

**Date:** 2026-10-27  
**Repository:** Pulse Forge, product name KYX  
**Type:** Read-only repository and code-path review  
**Verdict:** Project-state-aware, measurement-aware and partly audio-MIR-aware in separate workflows; not a unified musical-understanding assistant.

## 1. Executive verdict

KYX stores substantial musical truth: authored notes and drum steps, tempo and meter, tracks, clips, scenes, markers, automation and effect chains. Typed commands provide reversible changes. Separate analysis workflows estimate tempo, key, chords, energy-based sections, audio descriptors, vocal profiles and mix properties; selected results can become editable project structure.

The gap is integration and verification. Evidence is distributed across workflows and schemas. The local intent model receives instruction text as a bag-of-words input and no project context. Optional Ollama gets bounded tempo/key/meter, tracks, effects and action contract, but not note/clip timelines, audio analyses, automation, full routing or an audio excerpt. Reference Map and UN-SUNO outputs do not become general-purpose assistant evidence. MCP exposes structured tools and a short opening preview, but no unified selection-aware perception-to-action transaction.

Thus KYX is strongly project-state-aware for explicit symbolic facts; measurement-aware for defined signal properties; partly audio-MIR-aware in distinct reference, transcription and vocal workflows; and command-aware for supported actions and structural readback. It is not end-to-end music-aware in the sense of grounding open-ended requests in relevant audio/timeline, explaining evidence, proposing an appropriate action and verifying audible results.

No app was launched, audio auditioned, model inference run, or tests/build executed. There are no OBSERVED_RUNTIME findings. Source-traced paths are VERIFIED_CODE_PATH; documentation claims are DOCUMENTED_ONLY. Metrics are not treated as proof of quality.

Best next step: a small, versioned evidence contract joining project truth and analyses with explicit musical/sample time, provenance, uncertainty and invalidation. Start with deterministic queries and focused DSP/MIR before larger models or training.

## 2. Evidence and coverage ledger

**Evidence levels:** OBSERVED_RUNTIME = reproduced in running product (none); VERIFIED_CODE_PATH = source path traced; DOCUMENTED_ONLY = documentation claim; PROPOSED = recommendation; UNKNOWN = not established; NOT_APPLICABLE = outside scope.

| Feature                                | Entry/producer → representation/consumer                                                                                                                                                               | Evidence                        | Status / uncertainty                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Symbolic project state                 | **src/project-model/types.ts**, schema/store → BPM/key/meter, notes, patterns, clips, scenes, automation, effects → UI/commands/engine                                                                 | VERIFIED_CODE_PATH              | Rich authored state; not automatically relevant assistant context.                                                                                                                                               |
| Musical time                           | **src/transport/Transport.ts**, **src/rendering/tempoMap.ts** → ticks/bars/beats/seconds                                                                                                               | VERIFIED_CODE_PATH              | Project clock explicit; reference beat times use seconds, are not downbeats, and have no common assistant conversion contract.                                                                                   |
| Commands/undo                          | **src/commands/**, **src/mcp/verified-mutation.ts** → typed mutation, history/readback                                                                                                                 | VERIFIED_CODE_PATH              | Strong structural safeguards; cannot establish sound.                                                                                                                                                            |
| Pattern assist                         | **src/ui/AssistPanel.tsx**, intent pipeline → selected pattern preview/apply/undo                                                                                                                      | VERIFIED_CODE_PATH              | Seeded, scoped composition aid; not general audio reasoning.                                                                                                                                                     |
| Intent                                 | **src/intent/route.ts**, **pipeline.ts**, **model-resolver.ts** → constrained actions                                                                                                                  | VERIFIED_CODE_PATH              | Routes/schema exist; broad semantics and musical quality unproven.                                                                                                                                               |
| Local intent model                     | **src/intent/model-loader.ts**, **model-worker.ts**, manifest → instruction bag-of-words/action heads                                                                                                  | VERIFIED_CODE_PATH              | Local constrained classifier, not audio model/general LLM. Manifest’s internal accuracy/counts are not independently reproduced or a music-understanding score.                                                  |
| Ollama context                         | **src/intent/model-ollama.ts**, **model-context.ts** → instruction plus bounded tempo/key/meter, up to 8 tracks/effects, 12k chars                                                                     | VERIFIED_CODE_PATH              | Excludes events, clips, analysis, automation and detailed routing; not run.                                                                                                                                      |
| Audio labels                           | **src/ai/audio/audio-worker.ts**, **src/intent/audio-reference.ts** → mono 16 kHz, up to 8 AudioSet-style labels/features                                                                              | VERIFIED_CODE_PATH              | Narrow classification/conditioning, not audio QA, transcription or structure. Full local artifact license/provenance is not pinned.                                                                              |
| Reference analysis                     | **src/reference/analysis/analyzeReference.ts**, worker/client, **ReferenceMapPanel.tsx** → tempo/rhythm, key/chroma, energy sections, descriptors                                                      | VERIFIED_CODE_PATH              | Offline MIR workflow; roles estimated; no audio time signature/downbeat fact.                                                                                                                                    |
| Reference-to-pattern groove            | **src/intent/audio-reference.ts**, **src/intent/groove-extraction.ts**, **src/ui/IntentPanel.tsx** → mono 16 kHz reference, tempo and onset/band estimates → 16-step drum rows                         | VERIFIED_CODE_PATH              | Narrow import workflow; the full reference folds onto one 16-step cycle, same-step hits collapse to the loudest, and band labels are frequency heuristics. Install replaces the active pattern in one undo step. |
| Audio transcription                    | **src/reference/transcribe.ts**, **src/reference/analysis/melody.ts** → best-effort chords/drums/bass/melody as editable project material                                                              | VERIFIED_CODE_PATH              | Gated/warned estimates; MCP supports off/HPSS, UI may use neural tier.                                                                                                                                           |
| Stem separation                        | **src/analysis/stem-model/client.ts**, worker/manifest → bounded offline WebGPU/WASM and HPSS fallback                                                                                                 | VERIFIED_CODE_PATH              | Quality, device performance and pretrained-weight rights not established.                                                                                                                                        |
| Mix analysis                           | **src/analysis/mixDoctor.ts**, **sectionMixDoctor.ts**, **src/mcp/mix-diagnosis.ts** → peak/loudness/RMS/crest/bands/correlation/section metrics                                                       | VERIFIED_CODE_PATH              | Heuristics are not proof of masking/quality. Mix/render summaries cap at 14 strips without explicit overflow field.                                                                                              |
| MCP/audio preview                      | **src/mcp/tools.ts** → project queries and opening 1–4 bars as audio                                                                                                                                   | VERIFIED_CODE_PATH              | No unified evidence bundle; preview is not selection-aware. Related test source read, not run.                                                                                                                   |
| Vocal profile                          | **src/vocal/analyze.ts**, **src/vocal/types.ts** → up to 90s mono: key/tempo, bar energy, phrase heuristic, silence, rough SNR                                                                         | VERIFIED_CODE_PATH              | Not performance auditor: no timing/pitch errors, articulation or intelligibility.                                                                                                                                |
| Vocal phrase alignment                 | **src/audio-engine/vocal-alignment.ts**, **src/ui/ArrangementPanel.tsx** → per-take/pass phrase-onset measurement and bounded content slip                                                             | VERIFIED_CODE_PATH              | High-confidence 5–120 ms shifts may auto-apply; larger offsets are offered through a manual path. This finds leading silence, not guide-relative timing or pitch errors.                                         |
| Audio smart comp                       | **src/audio-engine/take-scoring.ts**, **src/commands/smart-comp.ts**, **src/ui/ArrangementPanel.tsx** → whole-pass groove/noise/clipping/pitch-drift scores + bar coverage → crossfaded, undoable comp | VERIFIED_CODE_PATH              | The same whole-pass score is used for every covered bar; this is a comp heuristic, not a matched-range comparison or a claim of best performance.                                                                |
| Vocal comp and arrangement suggestions | **src/vocal/comping.ts**, **src/ui/IntentPanel.tsx** → VocalProfile phrase energy/SNR → per-bar comp spans and energy-based suggestions                                                                | VERIFIED_CODE_PATH              | Phrase energy and SNR choose spans; no guide-relative contour, articulation, or intelligibility analysis.                                                                                                        |
| Pitch/harmony                          | **src/audio-workers/pitch-tracker.ts**, **src/vocal/harmony.ts** → monophonic hum/melody pitch; scale harmony                                                                                          | VERIFIED_CODE_PATH              | Not polyphonic transcription, tuning diagnosis or take comparison.                                                                                                                                               |
| AI Bandmate                            | **src/collab/bandmate.ts** → shared transport, phrase clock, seeded drum generation, note-event hook                                                                                                   | VERIFIED_CODE_PATH              | “Listening” is note events/control, not audio understanding.                                                                                                                                                     |
| FX telemetry                           | **src/audio-engine/AudioEngine.ts**, panels → panel-gated FX meters                                                                                                                                    | VERIFIED_CODE_PATH              | May be unavailable when panel closed; MCP runtime not exercised.                                                                                                                                                 |
| Docs                                   | **docs/manual/07-ai-assistants.md**, architecture/ADRs                                                                                                                                                 | DOCUMENTED_ONLY                 | Product intent, not proof of runtime quality.                                                                                                                                                                    |
| Low-end WIP                            | Uncommitted **src/instruments/lowEndMeasure.ts**, **lowEndRender.ts**, Kopa changes                                                                                                                    | NOT_APPLICABLE to shipped state | Excluded as in-flight; not edited or counted as assistant capability.                                                                                                                                            |

Scope included project model, transport, commands, intent/model adapters, AI audio/symbolic utilities, Reference Map/UN-SUNO, vocals, mix diagnosis, MCP, UI entry points, architecture and relevant tests. Existing unrelated dirty/untracked MCP, Kopa/low-end, collaboration-server and audit work was left alone. This report is the only requested artifact.

Not performed: app startup, real project/audio playback/render, model inference, tests/build, device/latency measurement or reproduction of manifest metrics. Tests were read, not run. Cache invalidation, real-client audio support, perceptual quality and broad model performance remain UNKNOWN.

## 3. Musical-understanding taxonomy

| Domain                  | Observe / represent                                                                                              | Interpret / act / verify                                                                                                                                                 | Boundary                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| **A. Rhythm/time**      | MIDI timing direct; audio beat/BPM/stability estimated; uploaded references also yield a 16-step onset/band grid | Reference grid can replace the active drum pattern; no general downbeat/meter reasoner; 16-step folding loses cycle position and same-step polyphony, and feel needs A/B | Strong authored MIDI; bounded recorded-audio workflows           |
| **B. Pitch/harmony**    | MIDI notes explicit; key/chroma/chords/monophonic pitch estimated                                                | Narrow scale harmony/transcription; no broad polyphonic, tuning, non-Western-scale or calibrated ambiguity reasoning                                                     | Project pitch is fact; audio pitch best-effort                   |
| **C. Structure**        | Explicit scenes/markers and energy sections                                                                      | Estimated roles, no reliable chorus/motif reasoner; marker edits inspectable, perceived lift needs human                                                                 | Metadata strong; section semantics heuristic                     |
| **D. Mixing/timbre**    | Defined metrics, strips and some audio descriptors                                                               | Low-band overlap is risk, not masking; supported effect actions, metric rerun/A-B                                                                                        | Fragmented; analysis scope (dry/post-FX/master) must be explicit |
| **E. Vocals**           | Coarse profile, phrase-onset alignment, whole-take smart-comp metrics, and monophonic pitch                      | Bounded onset slips and heuristic comp selection exist; no guide-relative pitch/contour, articulation, intelligibility or expressive analysis                            | Useful recording aids; they do not judge performance quality     |
| **F. Intent**           | User text plus some selected project context                                                                     | Deterministic/constrained route; preview/apply/undo for supported actions                                                                                                | Command-aware; open-ended intent-to-sound partial                |
| **G. Cross-track/time** | Project queries and bounded strip renders                                                                        | No unified routing/automation consequence reasoning or joint plan                                                                                                        | Data exists; assembly/reasoning is the gap                       |

## 4. Perception-to-action map

| Stage          | Existing path                                                                   | Main gap                                                                                   |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Acquisition    | Project store, uploaded reference, user-library UN-SUNO, short MCP preview      | No single binding of selected range, current audio, edits and analysis revision            |
| Analysis       | Reference, vocal, AST, mix, stem workflows                                      | Different rates/scopes/schemas; no common provenance envelope                              |
| Representation | Project model, ReferenceMap v3, VocalProfile, mix reports, intent context       | Ticks/seconds/samples/bars not joined; beat phase is not downbeat                          |
| Context        | Ollama bounded context, deterministic MCP queries, local instruction classifier | Local classifier sees instruction only; no unified timeline/audio/analysis/routing context |
| Reasoning      | Deterministic routes, constrained intents, narrow heuristics                    | No demonstrated joint reasoning over audio, notes, arrangement and effects                 |
| Mutation       | Typed commands, preview/apply, undo/history                                     | Valid action can miss target or goal                                                       |
| Verification   | Structural readback, render summary, diagnosis, optional preview                | No standard goal-linked fresh render; subjective outcomes need human A/B                   |
| Freshness      | Some hashes/versions/diagnostics                                                | Repository-wide invalidation after edits/FX/routing/tempo/source changes UNKNOWN           |

## 5. Human–AI musical parity matrix

Confidence describes this static audit, not calibrated task success.

| Task                              | Human evidence                   | AI evidence/tools                                                                                                                                                 | Missing inference/verification                                                                                               | Confidence |
| --------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Find chorus, compare verse energy | Audio, markers, timeline         | Explicit scenes or separate energy analysis                                                                                                                       | Chorus grounding and same-range comparison                                                                                   | High       |
| Kick/bass competition             | Waveforms, piano roll, listening | Notes/steps, low-band metrics, mix diagnosis                                                                                                                      | Time-aligned overlap and masking A/B                                                                                         | High       |
| Tighten drums, retain swing       | MIDI timing and feel             | Positions/microtiming; reference-to-16-step groove import; bounded pattern edits                                                                                  | Intentional-offset baseline and preservation check; groove import folds the reference across one cycle                       | Med-high   |
| Vocal timing/pitch issues         | Takes, waveform, pitch display   | Coarse profile, phrase-onset slip, whole-take comp metrics, monophonic tracker                                                                                    | Guide-targeted local pitch/contour and expressive timing analysis                                                            | High       |
| Complementary harmony             | Notes/chords/key/audio           | Separate key/chord/note paths, harmony generator                                                                                                                  | Full composition context and audible fit                                                                                     | Med-high   |
| Intimate but intelligible vocal   | Take/effects/listening           | Effect context, rough SNR/energy                                                                                                                                  | Clarify goal and verify intelligibility                                                                                      | High       |
| Transition at musical boundary    | Automation/tempo/arrangement     | Automation and effect tools separately                                                                                                                            | Conflict check across target and time                                                                                        | Med-high   |
| Explain static arrangement        | Clips/sections/density/listening | Project queries and separate energy                                                                                                                               | Joint evidence timeline and cited deltas                                                                                     | High       |
| Compare two takes neutrally       | Take lanes/listening             | Smart comp ranks whole passes using groove spread, pitch drift, noise floor and clipping, then uses coverage to form bar spans; vocal comp uses phrase energy/SNR | Matched-range, per-bar evidence report; current smart comp applies the same whole-pass score across each take's covered bars | High       |
| Check automation conflict         | Automation lane/target           | Project state and tools                                                                                                                                           | Deterministic same-target overlap preflight                                                                                  | Med-high   |

## 6. Top 15 gaps

Severity: P0 blocks trustworthy end-to-end assistance; P1 high value; P2 narrower. Each item includes evidence level/confidence, behavior, missing stage, musical impact, smallest solution, and validation risk.

1. **G01 / P0 / VERIFIED_CODE_PATH / High — Unified evidence context.** Reference/vocal/mix outputs are separate; **src/intent/model-context.ts** is bounded metadata/effect context and **src/intent/model-worker.ts** vectorizes only instruction. Missing analysis-to-context assembly/citation means the assistant lacks the passage motivating a change. Add a read-only evidence bundle with revision/range/provenance; test grounded answers and abstention. Risk: size and stale cache.
2. **G02 / P1 / VERIFIED_CODE_PATH / High — Selection/time semantics.** Project ticks/tempo windows coexist with seconds-based ReferenceMap; **src/reference/types.ts** explicitly says beat times are not downbeats; intent has no range. Missing mapping can target wrong passage. Add versioned sample/musical range conversion; test tempo changes, warps, offsets and ambiguity rejection.
3. **G03 / P1 / VERIFIED_CODE_PATH / High — General audio access.** AST labels, MIR, reference-to-16-step groove import and opening-bar MCP preview exist as separate workflows; no selected-range audio-QA evidence consumer found. Missing routing from a question to relevant analysis leaves general audio reasoning unavailable to the assistant. Add selected-range DSP/MIR first; validate with consented clips and source citations. Risk: privacy/device cost.
4. **G04 / P1 / VERIFIED_CODE_PATH / High — Downbeat/meter.** Reference rhythm has beat/BPM/stability but no downbeat or audio meter field. Missing bar phase can shift actions. Add candidate estimates separate from explicit MIDI meter; evaluate genres/pickups and abstain on ambiguity.
5. **G05 / P1 / VERIFIED_CODE_PATH / High — Section roles.** **src/reference/structure.ts** estimates energy roles; scene labels are user data. Missing provenance can make a guessed chorus sound factual. Prefer user labels; show unnamed candidates/spans. Validate boundary vs role separately.
6. **G06 / P1 / VERIFIED_CODE_PATH / High — Kick/bass diagnosis.** **src/mcp/mix-diagnosis.ts** uses strip/low-band summaries, capped at 14; section doctor measures broad band/transient differences. Shared spectrum is not masking. Add onset-aligned low-band risk and A/B; producer-labeled genre-diverse validation. Risk: solo strips omit bus/master effects.
7. **G07 / P1 / VERIFIED_CODE_PATH / Med-high — Swing preservation.** MIDI timing/microtiming exists and **src/intent/groove-extraction.ts** can fold a reference into a 16-step grid, but no general swing-constrained correction was traced. The import also merges hits that land on one step and does not preserve their cycle or microtiming. Start read-only with a user-approved template and proposed deltas; test intentional-offset preservation and blind preference. Risk: template misses expression.
8. **G08 / P1 / VERIFIED_CODE_PATH / High — Guide-relative vocal performance.** **src/vocal/analyze.ts** gives a coarse profile; **src/audio-engine/vocal-alignment.ts** measures phrase onset and ArrangementPanel bounds automatic content slips to high-confidence latency-scale shifts; smart comp ranks whole takes with fixed groove/noise/clipping/pitch-drift weights. **src/audio-workers/pitch-tracker.ts** tracks monophonic pitch but not guide-relative errors. Missing local aligned contour, articulation, and intelligibility evidence matters for expressive timing. Add read-only comparison to an explicit guide; validate with singers; no automatic pitch correction initially.
9. **G09 / P1 / VERIFIED_CODE_PATH / High — Intimacy/intelligibility.** Effect intents and rough profile are separate; no intelligibility measure found. A darker/quieter sound may lose clarity. Clarify or offer reversible A/B with warning proxy; human review required. Risk: subjectivity and proxy limits.
10. **G10 / P1 / VERIFIED_CODE_PATH / High — Arrangement explanation.** Clips/scenes/notes and Reference energy are not joined in intent context. Missing section timeline risks generic/contradicted explanations. Report measurable density/register/repetition/energy deltas first; assess evidence accuracy separately from usefulness.
11. **G11 / P2 / VERIFIED_CODE_PATH / High — Matched-range take comparison.** **src/commands/smart-comp.ts** compares whole passes using **src/audio-engine/take-scoring.ts**, applies each whole-pass score to every covered bar, and creates an undoable crossfaded comp; vocal comp ranks bars using phrase energy/SNR. These are existing, bounded selection paths. Missing matched-range per-bar evidence makes the chosen winner hard to audit when performance quality changes within a pass. Show the metric evidence per candidate/range and let users override; validate with deliberately mixed-quality takes and producer review. Risk: fixed weights reward the wrong musical priority.
12. **G12 / P1 / VERIFIED_CODE_PATH / Med-high — Automation conflict.** Automation and tempo map exist but are absent from bounded model context; no general conflict preflight evidenced. Add deterministic same-target/instance overlap dry run; test overlaps, adjacency and tempo boundaries. Warn if semantics are unclear.
13. **G13 / P1 / VERIFIED_CODE_PATH / High — Provenance/calibration.** Some outputs have confidence/hash/version, schemas differ; calibration is unproven. Estimates may appear as authored fact. Add typed source/scope/version/uncertainty/invalidation envelope; every claim should resolve to its range.
14. **G14 / P2 / VERIFIED_CODE_PATH / High — Silent diagnostic truncation.** **src/mcp/mix-diagnosis.ts** and **src/mcp/render-summary.ts** cap strips at 14 without overflow flag. Partial coverage can sound complete. Return IDs/count/truncated and drill down; test above/below cap.
15. **G15 / P0 / VERIFIED_CODE_PATH / High — Post-action sonic verification.** **src/mcp/verified-mutation.ts** checks structure; render/preview are separate. “Applied” can be mistaken for “sounds better.” Attach goal/range/check plan, fresh-render the affected range and distinguish structural/acoustic/subjective outcomes; validate false-success rate. Risk: cost/stale analysis.

## 7. DSP vs MIR vs audio model vs LLM

| Task                                           | First method                                     | Escalate only if measured                     | Avoid                                 |
| ---------------------------------------------- | ------------------------------------------------ | --------------------------------------------- | ------------------------------------- |
| Tempo, loudness, peak, bands, correlation      | Deterministic DSP, explicit units/scope          | MIR for downbeat/meter                        | LLM guessing measurements             |
| Authored notes/clips/scenes/automation/effects | Project query                                    | LLM explanation over selected versioned facts | Audio model rereading project truth   |
| Recorded beat/downbeat/meter                   | MIR candidates/confidence                        | Model after failure-set benchmark             | Treat beat as downbeat                |
| Chords/melody                                  | MIR with quality gates/separation as needed      | Targeted model after benchmark                | Key estimate as transcription         |
| Kick/bass                                      | Time-aligned DSP/MIR plus A/B                    | Separation if it helps measured task          | Spectrum overlap equals masking       |
| Intent planning                                | Deterministic schema + bounded LLM over evidence | Adaptation after labeled failure              | Broad training before task definition |
| Subjective goals                               | Clarification, alternatives, human A/B           | Audio-text model as evaluated suggestion      | “Warm/intimate” as objective truth    |
| Post-action                                    | State checks + fresh render                      | Perceptual model only with human labels       | Command success as sound success      |

The local AST path is mono 16 kHz and returns top labels. [Xenova AST card](https://huggingface.co/Xenova/ast-finetuned-audioset-10-10-0.4593) describes an AudioSet classifier conversion; [MIT AST card](https://huggingface.co/MIT/ast-finetuned-audioset-10-10-0.4593) describes its source classifier. Local manifest lacks full artifact provenance/license pin.

Stem manifest identifies about 312 MB HTDemucs ONNX with bounded offline WebGPU/WASM. [Conversion card](https://huggingface.co/adowu/htdemucs-onnx) claims MIT; [Demucs author issue](https://github.com/facebookresearch/demucs/issues/327) says code licensing did not settle pretrained-weight rights. This unresolved conflict is not a legal finding; obtain human/legal review before reliance on redistribution/commercial use. No model is recommended merely because available. Keep inference off the audio callback.

## 8. Proposed minimal context contract

**PROPOSED, not existing schema.** Include project/revision/hash; stable track/clip/take/effect IDs; audio sample rate/indices; musical ticks/bars only with tempo-map revision and conversion semantics; evidence type; producer/version/timestamp/source hash; source-native uncertainty; invalidation dependencies; relationship references; compact summary/drill-down; consent and minimization scope.

Distinguish **ground truth** (authored note/user label), **measurement** (defined RMS), **inference** (estimated key/section) and **preference** (user wants late hats retained). Do not treat unrelated scores as calibrated probabilities.

### Example A — authored MIDI

```json
{
  "kind": "ground_truth",
  "project": { "id": "p1", "revision": 182 },
  "object": { "trackId": "bass", "clipId": "c12", "eventId": "n9" },
  "time": { "musical": { "startTick": 7680, "durationTicks": 480, "tempoMapRevision": 31 } },
  "value": { "midiPitch": 36, "velocity": 0.82 },
  "provenance": { "source": "project_model", "version": "schema-38" },
  "uncertainty": { "kind": "none_for_authored_value" },
  "invalidatedBy": ["project_revision", "clip_edit"]
}
```

### Example B — measured energy

```json
{
  "kind": "measurement",
  "claim": "relative_rms_energy",
  "project": { "id": "p1", "revision": 182 },
  "object": { "trackId": "master", "sectionId": "s4" },
  "time": {
    "sourceAudio": { "startSample": 5292000, "endSample": 6174000, "sampleRate": 44100 },
    "musical": { "startTick": 15360, "endTick": 17920, "tempoMapRevision": 31, "mapping": "render_alignment" }
  },
  "value": { "rmsDbfs": -13.7, "referenceRmsDbfs": -16.2, "deltaDb": 2.5 },
  "provenance": { "source": "offline_render", "algorithm": "rms", "version": "1" },
  "uncertainty": { "kind": "scope", "note": "Does not prove perceived lift." },
  "invalidatedBy": ["project_revision", "source_audio", "render_chain", "tempo_map"]
}
```

### Example C — section estimate and preference

```json
{
  "kind": "inference",
  "claim": "section_role_candidate",
  "project": { "id": "p1", "revision": 182 },
  "object": { "sectionId": "s4" },
  "time": { "sourceAudio": { "startSample": 5292000, "endSample": 6174000, "sampleRate": 44100 } },
  "value": { "role": "drop", "energyTrajectory": "rising" },
  "provenance": { "source": "reference_analysis", "algorithmVersion": "recorded-in-output" },
  "uncertainty": { "kind": "algorithm_score", "value": 0.71, "calibration": "not_established" },
  "relatedPreference": { "kind": "preference", "claim": "keep_hat_microtiming", "source": "user_annotation" },
  "invalidatedBy": ["source_audio", "analysis_settings"]
}
```

Examples are illustrative; existing types do not promise these fields or invalidation rules.

## 9. Evaluation design

**Layer 1 — Perception:** Rights-cleared set stratified by genre, tempo, meter, instrumentation, recording quality and processing. Include swing, pickups, tempo changes, sparse content, mixed meters and effects. Keep MIDI truth separate from audio labels. Measure task-specific beat/downbeat error, onset F-score, bar-phase accuracy, key/chord accuracy with ambiguity, boundary plus role quality, loudness/peak error, and vocal contour only on annotated suitable material. Report strata/failures.

**Layer 2 — Reasoning/planning:** Paired projects and counterfactuals: stale tempo, moved selection, metadata/audio mismatch, changed FX, missing routing, omitted tracks and conflicting automation. Measure grounded claim rate, target/range accuracy, abstention calibration, unsupported claims and invalid actions. Compare manual, deterministic DSP/MIR/query, and model-assisted baselines. Do not score prose fluency as understanding.

**Layer 3 — Audible usefulness/trust:** Randomized loudness-matched A/B with diverse musicians and “no preference.” Measure time, corrections, rollback, preference, preserved intent and trust. Separate objective metric success from subjective judgment; report disagreement.

Document data licenses/consent/redistribution. Split by artist/recording/source to prevent leakage. Pin preprocessing, rates, versions, revision, hardware/browser and cold/warm timing. First deliver protocol and baseline, not fabricated scores.

## 10. Prioritized experiments

Estimates are planning estimates for prototypes, not measurements. Begin read-only except reversible mutation verification.

1. **E01 Rhythm/bar phase.** Hypothesis: separate beat from downbeat/meter to prevent wrong-bar actions. Scenario: locate transition in a recorded loop. Minimum: evaluate current beat path, annotate bar-phase candidates. Baseline: current output/manual. Data: 80–150 licensed clips, varied meter/pickups. Metrics: beat error, downbeat F-score, bar-phase, abstention. Pass: pre-registered common-meter tolerance (e.g. 100 ms) and abstain on ambiguity. Time/compute: 3–5 days, CPU. Dependencies: annotations/provenance. Risks: genre/pickup ambiguity. Stop if annotator agreement is weak.
2. **E02 Section energy.** Hypothesis: user-labeled ranges support useful comparison without chorus guessing. Scenario: verse vs chorus. Minimum: measure RMS/LUFS/peak on two selected ranges. Baseline: manual + mix doctor. Data: 30–50 labeled excerpts. Metrics: range and numeric accuracy, correction rate. Pass: exact range and independent recomputation. Time: 2–3 days, CPU. Dependencies: render alignment. Risk: energy is not excitement. Stop semantic labels if agreement is poor.
3. **E03 Kick/bass.** Hypothesis: time-aligned occupancy localizes risk better than global spectrum. Scenario: crowded low end in one section. Minimum: isolated strip onset/low-band summary. Baseline: current strip summary/listening. Data: 40–60 projects with producer labels. Metrics: risk localization, false positives, blind A/B. Pass: better localization, never claim proven masking. Time: 4–6 days, offline render. Dependencies: range/track IDs. Risk: solo strips omit buses. Stop fixes without producer confirmation.
4. **E04 Swing preservation.** Hypothesis: user-approved template identifies outliers without flattening feel. Scenario: tighten drums, retain late hats. Minimum: read-only offsets and proposed deltas. Baseline: manual/simple quantize. Data: 20–30 annotated patterns. Metrics: intentional-offset preservation, correction precision, rollback and preference. Pass: no approved offset moved beyond tolerance. Time: 3–5 days deterministic. Dependencies: IDs/undo. Risk: template misses expression. Stop when users reject outlier flags.
5. **E05 Vocal contour/timing.** Hypothesis: guide comparison can localize issues without flattening expression. Scenario: review take before comp. Minimum: clear/isolated vocal phrase and monophonic contour comparison. Baseline: vocal profile, bounded phrase-onset alignment, whole-take smart comp and human review. Data: 30–50 consented annotated takes. Metrics: contour error, boundary F-score, false expressive flags, singer trust. Pass: acceptable preregistered false-flag rate. Time: 5–8 days CPU. Dependencies: consent/alignment. Risk: effects/doubles. Stop without consent or if style uniformity required.
6. **E06 Harmony.** Hypothesis: explicit notes/chords beat audio-caption prompting for composition preservation. Scenario: complementary harmony. Minimum: symbolic candidate generation with constraints. Baseline: existing generator/manual. Data: 30 annotated passages. Metrics: constraints, voice-leading, blinded preference/preservation. Pass: musician acceptance without changing hook. Time: 3–6 days symbolic. Dependencies: note query/user constraints. Risk: tonal bias. Stop model work if deterministic is equal.
7. **E07 Intimate/intelligible.** Hypothesis: clarification and reversible alternatives beat one ambiguous change. Scenario: vocal intimacy. Minimum: render two options, state changes, use proxy only as warning. Baseline: current effect flow/manual. Data: 20–30 consented diverse vocals. Metrics: intelligibility, preference, time, corrections. Pass: non-inferior intelligibility and user choice. Time: 4–6 days plus listening. Dependencies: preview/consent. Risk: subjective. Stop automated scoring if raters disagree.
8. **E08 Intent grounding.** Hypothesis: selected IDs/range/revision improves target accuracy. Scenario: lower bass in section, leave chorus. Minimum: read-only planner returns target/range/evidence/ambiguity/action. Baseline: instruction-only/deterministic/Ollama. Data: 100–200 prompts/fixtures with stale counterfactuals. Metrics: target accuracy, unsupported claims, abstention, invalid actions. Pass: context improves targeting without more unsupported actions. Time: 4–7 days. Dependencies: evidence contract. Risk: privacy/truncation. Stop adding fields that do not help held-out set.
9. **E09 Automation preflight.** Hypothesis: deterministic overlap query catches conflicts. Scenario: filter transition at boundary. Minimum: dry-run same target/instance/parameter overlap. Baseline: manual lane review. Data: overlap/adjacency/multi-instance/tempo fixtures. Metrics: precision/recall, false blocks, round trip. Pass: catch seeded overlap, allow adjacency. Time: 2–4 days deterministic. Dependencies: IDs/tempo/dry run. Risk: intentional layering. Stop blocking if semantics ambiguous; warn.
10. **E10 Post-action verification.** Hypothesis: fresh affected-range render distinguishes applied from achieved. Scenario: reduce low-end competition or create section lift. Minimum: store goal/range, reversible action, re-render, named checks and preview. Baseline: structural readback + optional tools. Data: 30 controlled pairs plus subjective cases. Metrics: state/metric correctness, false success, rollback/trust. Pass: always distinguish structural/acoustic/subjective success. Time: 5–8 days offline. Dependencies: contract/invalidation. Risk: cost/metric gaming. Stop success language for unverifiable subjective goals.
11. **E11 Reference groove import.** Hypothesis: the existing 16-step groove path preserves a recognizable pattern only on appropriate single-cycle material and reports collisions clearly. Scenario: import a drum reference into the active pattern. Minimum: exercise `extractGrooveGrid` → `grooveRowsForPads` on annotated references, including multi-bar loops, swing, fills, syncopation and simultaneous hits. Baseline: current import plus producer transcription. Data: 40–60 rights-cleared references with step and band annotations. Metrics: step precision/recall, band confusion, same-step collision loss, cycle-to-cycle variance, user corrections. Pass: pre-registered step/band thresholds by stratum and explicit disclosure when folding loses structure. Time/compute: 3–5 days, CPU. Dependencies: rights-cleared audio and annotations. Risks: timbre-based bands can confuse roles and phase search can favor a misleading grid. Stop presenting imports as representative when collisions or multi-cycle loss exceed the agreed limit.

## 11. Roadmap and gates

Proposed horizons, not delivery promises.

| Horizon                      | Status                     | Milestone and gate                                                                                                                                                    |
| ---------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0–30 days**                | **RESEARCH**               | Freeze evidence/time inventory; read-only E02/E08/E09 baselines. Gate: claims cite source/range/truncation. No general model addition.                                |
| **1–3 months / 30–90 days**  | **PROTOTYPE**              | Evidence envelope, revision/range binding, invalidation, selected-range metrics. Gate: improve held-out targeting; reject stale evidence.                             |
| **3–6 months / 90–180 days** | **PRODUCTION_CANDIDATE**   | One human-approved objective workflow plus fresh render. Gate: correct range/object, no silent truncation, undo and bounded claims; otherwise prototype.              |
| **6–12 months**              | **RESEARCH / PROTOTYPE**   | Cross-track/time summaries, take comparison, vocal contour, explicit preference; compare audio models against DSP/MIR. Gate: held-out value and rights/device review. |
| **12–36 months**             | **DEFER pending evidence** | Broad audio-language models/adaptation only after narrow workflows prove utility, privacy, latency and licensing. Gate: measured win vs model-agnostic baseline.      |

**Go:** current revision/range, provenance, visible uncertainty/omissions, reversible action and fresh verification.  
**No-go:** hidden network, claims from absent context, uncalibrated certainty, increased wrong targets, or stale analysis.  
**Failure modes:** truncation, time alignment, genre bias, dry/post-FX mismatch, false section labels, preference treated as fact, browser resource limits, license/consent ambiguity. Keep model/MIR work in bounded workers/offline tasks, never the audio callback.

## 12. What works and must be preserved

- Project model captures musical truth; React is not realtime audio source of truth.
- Commands/undo/readback protect supported changes.
- Deterministic routes and constrained models give a local baseline.
- Workers, bounds, diagnostics and coverage gates limit unsafe analysis; transcription can omit uncertain notes instead of inventing them.
- Mix metrics are useful when described as measurements/heuristics.
- Local-first worker design supports privacy/realtime safety when limits and provenance remain explicit.
- Keep authored MIDI distinct from audio estimates, and user preference distinct from both.

## 13. Unknowns, risks and human approval

UNKNOWN: quality on representative user music; model latency/memory/battery/browser support; full cache invalidation; MCP audio-client usability; FX telemetry in real panel states; stem quality/alignment; exact model provenance; test coverage. Tests not run.

Human approval: subjective goals (“better,” “intimate,” “warm,” “static”); recording consent/retention/scope; model/training/deployment choices; legal review of stem weights; action authority before measurable and user-review gates.

The [HTDemucs conversion card](https://huggingface.co/adowu/htdemucs-onnx) claims MIT, while the [Demucs author issue](https://github.com/facebookresearch/demucs/issues/327) says code licensing did not settle pretrained-weight rights. This is an unresolved provenance risk, not a legal conclusion. The local AST artifact also needs a pinned provenance/license record; see [Xenova AST](https://huggingface.co/Xenova/ast-finetuned-audioset-10-10-0.4593) and [MIT AST](https://huggingface.co/MIT/ast-finetuned-audioset-10-10-0.4593).

## 14. Final adversarial review

- Controls/tools were not equated with understanding; paths were traced and WIP/docs-only claims excluded.
- Model descriptions/scores were not treated as measurements or ground truth.
- Subjective preference was kept separate from objective correctness.
- Project queries/DSP precede training recommendations.
- Realtime, latency uncertainty, licensing and privacy were considered.
- Highest priorities are source-supported: narrow context, separate schemas, seconds/ticks boundary and structural-only verification.
- Strengths and unknowns are explicit; no runtime/test/audio success is claimed.
- Paths and experiment criteria make reproduction possible once app/tests and rights-cleared audio are available.
