# ZYVO_FRONTIER_CAPABILITIES

**Status:** ranked ZYVO-specific frontier capabilities for an AI-Assisted Audio Workstation
**Date:** 2026-10-25
**Product:** ZYVO — vocal-centric recording, editing, mixing and performance (Electron desktop; native audio I/O; live/show workflows)
**Companions:** `KYX_FRONTIER_CAPABILITIES.md`, `AAW_SECURITY_AND_REALTIME_SAFETY.md`, `AAW_REFERENCE_ARCHITECTURE.md`

---

## 0. The rule that shapes every ZYVO capability

> **A vocal DAW is used on stage. On stage, the cost of a wrong autonomous decision is not a wasted
> minute — it is a performance. Therefore every ZYVO capability declares, in advance: which of the
> four modes it operates in, what its hard real-time constraint is, what it does when its model is
> wrong, and whether any part of it may be automated at all.**

**The four modes** (every capability below is tagged with the modes it applies to):

| Mode                                | Latency class      | Who is present             | Autonomy allowed                        |
| ----------------------------------- | ------------------ | -------------------------- | --------------------------------------- |
| **OFF** — offline editing           | seconds to minutes | the engineer               | up to R3 with approval                  |
| **REC** — recording-time assistance | 100 ms – 1 s       | the performer              | suggestions only                        |
| **REH** — rehearsal                 | 100 ms – 2 s       | the performer (+ engineer) | suggestions; one-push confirm           |
| **LIVE** — live show                | hard real-time     | the performer, on stage    | **suggestion only; the human executes** |

**The LIVE rule (non-negotiable):** in show mode, no AI decision may change an audible parameter
without a human action. This follows from the repo's own live-failure analysis and from
`AAW_SECURITY_AND_REALTIME_SAFETY.md` RT-9.

### 0.1 The verified starting state (2026-10-25 code audit)

This portfolio is written against a **verified** ZYVO baseline, not an impression of one:

| Asset                                                                                                                     | Verdict          | Evidence                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 283 typed commands, snapshot undo (200), pre/post validation, audit log                                                   | **SHIPS**        | `packages/command-core/src/index.ts:1011-1290`; `packages/command-core/src/undo.ts:2958`; `packages/agent-runtime/src/agentAuditLogger.ts:21-148` |
| 61 MCP tools; **external MCP is draft-only — acceptance is a UI click**                                                   | **SHIPS**        | `apps/vocalforge-daw/electron/generalMcpServer.ts:106,115-136`; `apps/vocalforge-daw/src/agentVoiceManager.ts:5671-5679`                          |
| Live-show attach core: loopback-only, bearer token, constant-time compare, rate-limited                                   | **SHIPS**        | `apps/vocalforge-daw/electron/liveShowMcpAttachCore.ts:11-19,242-269,284-317`                                                                     |
| Fail-closed show preflight (`FATAL_NATIVE_PLAN_BLOCKERS`)                                                                 | **SHIPS**        | `packages/project-format/src/liveShowAssessment.ts:34-40`                                                                                         |
| Clean real-time boundary: allocation-free worklet, all throws caught, Parakeet off-thread                                 | **SHIPS**        | `packages/audio-engine/src/dspChainWorklet.ts:412-444,535-539`; `packages/native-audio-engine/src/parakeet_runtime.cc:216,1339-1347`              |
| Objective vocal analysis: pitch contour (40 ms/10 ms, 65–800 Hz), timing confidence, loudness, clipping, spectral balance | **SHIPS (DSP)**  | `packages/vocal-align-map/src/pitchContour.ts:51-90`; `packages/analysis-pipeline/src/takeScoring.ts:83-157`                                      |
| 62 genre reference blueprints (heuristic targets, not learned)                                                            | **SHIPS (data)** | `packages/analysis-pipeline/src/referenceBlueprintData.ts`                                                                                        |
| `.kyxzyvo` transfer both ways                                                                                             | **SHIPS**        | `D:\pulse-forge\src\export\zyvo-transfer.ts:121,238-296`; `packages/project-format/src/kyxTransfer.ts:140-253,358-393,420-483`                    |

**Four facts that change this portfolio:**

1. **Coaching is greenfield** — there is **no `*coach*` file anywhere** in `apps/` or `packages/`.
   Z-2 is a new product, not an extension.
2. **Musical time is not addressable** — _"trim at bar 3"_ / _"move to bar 5"_ are **not expressible**.
   An AI that must reason about form has no coordinate system to reason in. This is the single
   highest-value missing primitive in ZYVO, and several items below depend on it.
3. **Pitch correction costs 83–167 ms** (`docs/LATENCY_AUDIT_2026-09-25.md:16`) and the default
   WASAPI buffer is **100 ms** (`wasapi_player.cc:262`). Any live-latency claim must be measured
   against these numbers, not against the aspirational ones.
4. **There is no general modulation matrix** — `modRoutes` exist **only** for Morph
   (`packages/audio-engine/src/dsp/dspChainRunner.ts:249-252`). A singer-as-modulator architecture
   needs it, and nothing else can substitute for it.

**And one asset to protect:** ZYVO's external-MCP consent posture (**draft-only**, autonomy not
forwarded, acceptance is a UI click) is **stronger than KYX's**, where 21 of 39 tools mutate with no
per-call approval. It is the model the shared control plane should adopt.

---

## 1. The portfolio at a glance

| #        | Capability                                         | Modes          | Verdict                       | Score | The one-line case                                                                   |
| -------- | -------------------------------------------------- | -------------- | ----------------------------- | ----- | ----------------------------------------------------------------------------------- |
| **Z-1**  | Take comparison (A/B with measurable diff)         | OFF            | **Build now**                 | 4.5   | Competing takes, compared _quantitatively and audibly_, not by filename             |
| **Z-2**  | Phrase-aware vocal coaching                        | OFF, REH       | **Build now (deterministic)** | 4.3   | Objective feedback (pitch, timing, breath) against the performer's _own_ target     |
| **Z-3**  | Context-sensitive vocal effects (scene by section) | OFF, REH, LIVE | **Build now (deterministic)** | 4.2   | The vocal chain follows the song, deterministically                                 |
| **Z-4**  | Safe pitch-effect control                          | REC, REH, LIVE | **Build now**                 | 4.2   | Bounded, slewed, recoverable pitch correction that cannot artefact                  |
| **Z-5**  | Word-level lyric/phonetic alignment                | OFF, REC       | **Experiment**                | 3.8   | Needs a Slovak-capable ASR; the alignment quality is the blocker                    |
| **Z-6**  | Vocal comping assistance                           | OFF            | **Experiment**                | 3.6   | Comp selection is a musical judgement — the model must _propose_, the human decides |
| **Z-7**  | Expressive automation from performance             | OFF            | **Experiment**                | 3.5   | Derive fader/effect curves from how the performer actually sang                     |
| **Z-8**  | Performance scene orchestration                    | REH, LIVE      | **Experiment**                | 3.4   | Scene _suggestion_ for section transitions — never automatic in LIVE                |
| **Z-9**  | Live cue prediction                                | REH, LIVE      | **Research bet**              | 2.7   | The highest-value and highest-risk item in the portfolio                            |
| **Z-10** | Vocal clarity monitoring                           | REH, LIVE      | **Build now (deterministic)** | 3.9   | Objective intelligibility/level monitoring with a safe envelope                     |
| **Z-11** | Rehearsal-to-show transfer                         | REH → LIVE     | **Build now (workflow)**      | 3.8   | Make rehearsal _be_ the show config, so the show is a rehearsal of itself           |
| **Z-12** | Voice identity protection                          | all            | **Build now (policy)**        | 4.0   | Guardrails: no voice cloning without a grant; identity preserved under processing   |

---

## 2. Z-1 — Take comparison (A/B with a measurable diff)

| Field                          | Specification                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JTBD**                       | _"Which of these four takes is actually better, and better in what way?"_                                                                                                                                           |
| **Minimum viable interaction** | Select 2–4 takes → instant switch (no re-render) → a **diff card** per pair: pitch deviation (mean/95th), onset timing deviation, loudness/peak, spectral centroid delta, and a "where they differ" timeline.       |
| **Data required**              | The takes' audio + the analysis pipeline's per-take features (pitch, timing, dynamics)                                                                                                                              |
| **Components**                 | Deterministic feature extraction + a paired-difference view. **No model needed for the comparison**; a model may _summarise_ the differences in words, but the numbers come first.                                  |
| **Action APIs**                | `takes.compare(takeIds) → TakeDiff` (R0); `takes.preview(takeId)` (R0)                                                                                                                                              |
| **Quality metric**             | D-1/D-2 blinded preference (the user's pick agrees with the panel's ≥ 60 %); H-1 switch latency ≤ 100 ms                                                                                                            |
| **Hard real-time constraint**  | None in OFF; in REC/LIVE the comparison is read-only and must not touch the monitor path                                                                                                                            |
| **Fallback**                   | The diff card is fully deterministic — it exists with no model at all                                                                                                                                               |
| **Risk**                       | Low. The risk is a _false metric_; every number must be reproducible from the audio.                                                                                                                                |
| **Differentiation**            | **High.** Comping is the most-wanted and most-manual vocal task. A DAW that turns "take 3 sounds better" into "take 3 is 14 ms late on 6 phrases and 0.8 dB quieter in the chorus" changes the engineer's workflow. |
| **Small prototype**            | Per-take feature extraction (already the pipeline's job) + a paired diff view + instant switching.                                                                                                                  |
| **Verdict**                    | **Build now.** The reference interaction for the whole AAW loop, in the product where it matters most.                                                                                                              |

---

## 3. Z-2 — Phrase-aware vocal coaching

| Field                          | Specification                                                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JTBD**                       | _"Am I actually getting better at this part — and where exactly?"_                                                                                                                                                                                                                            |
| **Minimum viable interaction** | Record a rehearsal take → the system shows a **phrase-by-phrase** overlay: for each phrase, the pitch contour vs the target contour, the timing offset vs the grid, breath gaps, and the two worst moments. The performer clicks a phrase to hear it isolated.                                |
| **Data required**              | The performance audio + a **target**: either a reference melody (MIDI) or the performer's own best take. Targets are **performer-owned**; a target is never invented.                                                                                                                         |
| **Components**                 | Deterministic F0 extraction, voicing detection, note/phrase segmentation, DTW alignment to the target, and objective scoring (mean absolute cents deviation, onset deviation, coverage of the intended phrase map). A model may turn the score into a sentence; it may not produce the score. |
| **Action APIs**                | `vocal.analyzePerformance(takeId, targetRef) → PhraseReport` (R0)                                                                                                                                                                                                                             |
| **Quality metric**             | Objective accuracy vs a hand-aligned reference (cents MAE, onset MAE) — measurable; plus D-2: "this tells me something true" ≥ 60 %                                                                                                                                                           |
| **Hard real-time constraint**  | None in OFF; in REH the report must complete within 2 s of the take ending                                                                                                                                                                                                                    |
| **Fallback**                   | Fully deterministic                                                                                                                                                                                                                                                                           |
| **Risk**                       | Medium: **the pedagogical risk**. Telling a singer they are 18 cents flat on a phrase they sang intentionally is corrosive. Mitigation: confidence thresholds + the ability to mark a phrase as "intentional" + the performer's own take as the baseline.                                     |
| **Differentiation**            | **Medium-high.** Singing-feedback apps exist, but they are generic pitch trainers. A _project-aware, phrase-level, target-relative_ coach inside the DAW is rare.                                                                                                                             |
| **Small prototype**            | F0 + DTW alignment + a phrase table; targets from the performer's own best take. **Requires the musical-time primitive first** (see §0.1)                                                                                                                                                     |
| **Verdict**                    | **Build now (deterministic) — but it is greenfield, and it is blocked on addressable musical time.**                                                                                                                                                                                          |

---

## 4. Z-3 — Context-sensitive vocal effects (scene by section)

| Field                          | Specification                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JTBD**                       | _"The vocal should sit differently in the verse than in the chorus — automatically."_                                                                                       |
| **Minimum viable interaction** | The system proposes a **scene** per song section (verse / pre / chorus / bridge), showing the chain and the deltas; the performer accepts the whole set at once.            |
| **Data required**              | The song structure (from the project's section map / tempo map) + the vocal chain definition + a per-section energy profile                                                 |
| **Components**                 | Deterministic: a rule set mapping section role → chain deltas, with a bounded parameter envelope per scene. Optionally a learned mapping _later_; the rule set ships first. |
| **Action APIs**                | `vocal.proposeScenes(structure) → Scene[]` (R2); `vocal.applySceneSet(scenes)` (R2, **one undo unit**)                                                                      |
| **Quality metric**             | Constraint satisfaction 100 % (every scene's params within the safe envelope); D-1 blinded preference ≥ 60 %; **the scene set is one undo unit**                            |
| **Hard real-time constraint**  | In LIVE, scene switching must be **atomic and instant** and must never be triggered by a model                                                                              |
| **Fallback**                   | Deterministic rules; the performer can always pick a scene manually                                                                                                         |
| **Risk**                       | Medium: the classic failure is a scene that fights the performance. Mitigation: the performer can veto a scene; LIVE switching is manual.                                   |
| **Differentiation**            | **High.** This is a _sounding_ difference, not a UI difference — and it is achievable without any model.                                                                    |
| **Small prototype**            | Section map → scene proposals → an A/B of two scenes.                                                                                                                       |
| **Verdict**                    | **Build now (deterministic).**                                                                                                                                              |

---

## 5. Z-4 — Safe pitch-effect control

| Field                          | Specification                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **JTBD**                       | _"Fix the pitch, but keep the character — and never make it sound like a robot."_                                                                                                                                                                                                                                                                |
| **Minimum viable interaction** | Toggle a correction amount; the system shows the **correction curve** (how much was moved, where it backed off) rather than a single knob.                                                                                                                                                                                                       |
| **Data required**              | The vocal audio; the performer's consent to process it                                                                                                                                                                                                                                                                                           |
| **Components**                 | Deterministic pitch tracking + a **bounded, slewed** correction: cents limit, rate limit, a **confidence gate** (low-confidence frames are left alone), and an optional "preserve vibrato" mode.                                                                                                                                                 |
| **Action APIs**                | `vocal.applyPitchEffect(clipId, params)` (R2) — params include `maxCents`, `rateLimit`, `confidenceGate`, `preserveVibrato`                                                                                                                                                                                                                      |
| **Quality metric**             | E-6 intelligibility (ASR WER increase ≤ 5 points); **vocal-identity blinded check** (≤ 5 % report identity change); D-1 ≥ 60 % preference                                                                                                                                                                                                        |
| **Hard real-time constraint**  | **The correction must be real-time-safe**: fixed-block latency budget, no allocation, bounded per-block work; RT-5's envelope applies to every parameter                                                                                                                                                                                         |
| **Fallback**                   | If tracking confidence collapses (noise, breath), the effect passes the audio through unchanged                                                                                                                                                                                                                                                  |
| **Risk**                       | Medium-high: the "robotic" artefact is a real product-killer. Mitigation: the confidence gate, the vibrato preservation mode, and a **per-phrase bypass** the performer can trigger.                                                                                                                                                             |
| **Differentiation**            | **Medium.** Pitch correction is everywhere; _safe, transparent, confidence-gated, per-phrase bypassable_ correction is rarer and is a quality story.                                                                                                                                                                                             |
| **Small prototype**            | A confidence-gated corrector with a bounded envelope + a correction-curve display. **Measured against the real numbers: the existing Vocallab NIRA path costs 83 ms (≈167 ms with the ±24 st chain) and the default WASAPI buffer is 100 ms.** Any pitch feature must state its added latency against that baseline, or it is a stage liability. |
| **Verdict**                    | **Build now.**                                                                                                                                                                                                                                                                                                                                   |

---

## 6. Z-5 — Word-level lyric and phonetic alignment

| Field                          | Specification                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JTBD**                       | _"Show me where I slur the word in the second chorus — and let me jump straight to it."_                                                                                                                                                                                                                             |
| **Minimum viable interaction** | A word-level timeline over the waveform; clicking a word seeks to it; off-timing words are flagged.                                                                                                                                                                                                                  |
| **Data required**              | The vocal audio + the lyrics (performer-owned)                                                                                                                                                                                                                                                                       |
| **Components**                 | ASR + forced alignment. **Slovak is the constraint**: `openai/whisper-large-v3-turbo` is MIT-licensed and verified to support `sk`; `LiquidAI/LFM2.5-Audio-1.5B` is **English/Japanese only** and is therefore _not_ a candidate for Slovak alignment without fine-tuning (see `AAW_AUDIO_MODEL_LANDSCAPE.md` §3.2). |
| **Action APIs**                | `vocal.alignLyrics(clipId, lyrics) → WordTimeline` (R0)                                                                                                                                                                                                                                                              |
| **Quality metric**             | Alignment accuracy on a hand-aligned Slovak test set (target: ≥ 90 % of words within ±100 ms); E-6 intelligibility                                                                                                                                                                                                   |
| **Hard real-time constraint**  | None in OFF; REC assistance must not add latency to the monitor path — run alignment **after** the take, never during                                                                                                                                                                                                |
| **Fallback**                   | Manual lyric marking (the performer taps phrases) — the system degrades to a phrase-level timeline                                                                                                                                                                                                                   |
| **Risk**                       | Medium: sung-speech ASR is much harder than read speech, and the honest state of the art is "unreliable on clean studio singing, worse live"                                                                                                                                                                         |
| **Differentiation**            | **Medium.** Useful, competitive, not defining.                                                                                                                                                                                                                                                                       |
| **Small prototype**            | Whisper-turbo over a 60 s Slovak test set; report WER before building anything else.                                                                                                                                                                                                                                 |
| **Verdict**                    | **Experiment**, and the **first** thing to measure is the Slovak WER on singing.                                                                                                                                                                                                                                     |

---

## 7. Z-6 — Vocal comping assistance

| Field                          | Specification                                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JTBD**                       | _"Build me the best comp of this chorus — and let me audition every splice before I accept it."_                                                                                        |
| **Minimum viable interaction** | The system proposes a comp (which take for which phrase) and renders **audition variants**; the engineer can audition each splice in context.                                           |
| **Data required**              | The take set + per-take phrase alignment (Z-5's pipeline)                                                                                                                               |
| **Components**                 | Alignment + **objective comparison** (continuity of pitch, energy and timbre across splice points) → a _ranked proposal list_, not a single answer. A model may phrase the trade-off.   |
| **Action APIs**                | `vocal.proposeComp(takeIds, region) → CompProposal[]` (R0); `vocal.applyComp(proposal)` (R3 — it alters recorded material)                                                              |
| **Quality metric**             | D-1 blinded preference ≥ 60 % vs the engineer's own comp; **splice continuity** objective metrics (pitch/energy step at each splice); J-3 rejection ≤ 40 %                              |
| **Hard real-time constraint**  | None in OFF                                                                                                                                                                             |
| **Fallback**                   | Manual comping (the existing workflow) plus a **continuity inspector** that flags bad splice points — useful even if the proposal is never accepted                                     |
| **Risk**                       | **High** (R3, touches the recording). A comp that is technically smooth and artistically wrong is worse than no comp. Mitigation: proposals only, R3 confirmation, per-splice audition. |
| **Differentiation**            | **Medium-high.** Comping assistants exist (e.g. commercial comping tools); being _inside_ the DAW, auditionable per splice, with the take set as the only source, is a real difference. |
| **Small prototype**            | The continuity inspector alone (flags bad splices). It is useful without any model and is the honest first step.                                                                        |
| **Verdict**                    | **Experiment.** Ship the inspector first.                                                                                                                                               |

---

## 8. Z-7 — Expressive automation derived from performance

| Field                          | Specification                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JTBD**                       | _"I sang the chorus with a big lift — make the mix feel that."_                                                                                                                              |
| **Minimum viable interaction** | After a rehearsal take, the system proposes automation curves (vocal fader, reverb send, filter) that follow the performer's own dynamics.                                                   |
| **Data required**              | The performance audio + the take's phrase map + the vocal chain                                                                                                                              |
| **Components**                 | Deterministic extraction of the performance envelope (energy, pitch excursion, breath gaps) → curve generation with smoothing and **musical clamping** (no automation faster than X per bar) |
| **Action APIs**                | `mix.proposeAutomation(clipId, params) → AutomationCurve[]` (R2)                                                                                                                             |
| **Quality metric**             | E-4-style envelope preservation; D-1 ≥ 60 %; **and**: the curve must not be _more_ regular than the performance — a curve that over-smooths kills the expression it was meant to capture     |
| **Hard real-time constraint**  | Curves must respect RT-5's slew limits and a per-bar rate limit                                                                                                                              |
| **Fallback**                   | Manual automation, plus a "draw from performance" helper that copies the envelope                                                                                                            |
| **Risk**                       | Medium: over-automation is the failure mode — it makes a human performance sound machine-quantised.                                                                                          |
| **Differentiation**            | **Medium.**                                                                                                                                                                                  |
| **Small prototype**            | Envelope extraction → curve proposal → A/B.                                                                                                                                                  |
| **Verdict**                    | **Experiment.**                                                                                                                                                                              |

---

## 9. Z-8 — Performance scene orchestration

| Field                          | Specification                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JTBD**                       | _"When the song hits the chorus, everything should open up — and I want to be able to hit one thing."_                                                                                                                      |
| **Minimum viable interaction** | The system prepares **scene snapshots** (chain + routing + levels) and binds them to musical positions; during REH the performer can hear the transition; during LIVE the performer triggers them (or a foot pedal / MIDI). |
| **Data required**              | The arrangement's section map + the chain graph + the show profile                                                                                                                                                          |
| **Components**                 | Deterministic scene derivation + **atomic, pre-warmed** application. No model in the live path (RT-9).                                                                                                                      |
| **Action APIs**                | `show.prepareScenes(profile)` (R2); `show.trigger(sceneId)` — **human-initiated only**                                                                                                                                      |
| **Quality metric**             | Transition latency budget (≤ 50 ms audible change); zero-parameter-jump artifacts; a **pre-show self-test** that plays the transitions offline                                                                              |
| **Hard real-time constraint**  | **Hard real-time.** Pre-warmed parameters only; a scene change is a parameter slew, never a graph rebuild in the audio path                                                                                                 |
| **Fallback**                   | Manual triggering; the scenes exist without any AI                                                                                                                                                                          |
| **Risk**                       | High if automated, low if manual. **LIVE triggering is human-only.**                                                                                                                                                        |
| **Differentiation**            | **Medium-high** — but mostly as a _product quality_ story (a show that cannot be broken), not as an AI story.                                                                                                               |
| **Small prototype**            | Scene snapshots + manual trigger + the pre-show self-test.                                                                                                                                                                  |
| **Verdict**                    | **Experiment**, with a strong bias toward the deterministic version.                                                                                                                                                        |

---

## 10. Z-9 — Live cue prediction

| Field                          | Specification                                                                                                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JTBD**                       | _"Tell me the chorus is coming so I can build to it."_                                                                                                                                                                                                                                              |
| **Minimum viable interaction** | In REH, a **countdown/cue** appears (and optionally in the performer's in-ear) a bar or two before the section change.                                                                                                                                                                              |
| **Data required**              | The arrangement (section map, tempo map), the performance audio up to "now", and (for a live set) the set list / song order                                                                                                                                                                         |
| **Components**                 | A model would predict the next section from the performance; the **deterministic** baseline is simply _the arrangement knows_ — the section boundary is already in the project. So the model is only needed for **exceptions**: an ad-lib, a dropped section, a modified arrangement in the moment. |
| **Action APIs**                | `show.cue(nextSection, atBar)` (R0 — an advisory display). **No automatic scene trigger.**                                                                                                                                                                                                          |
| **Quality metric**             | Cue precision/recall on the arrangement (deterministic: 100 %) vs on **deviations** (model: unknown). The interesting metric is the deviation case only.                                                                                                                                            |
| **Hard real-time constraint**  | The cue must appear **before** the boundary (a full bar of lead time at minimum); a late cue is worse than no cue                                                                                                                                                                                   |
| **Fallback**                   | The deterministic arrangement cue; and in LIVE, a manual "next section" button                                                                                                                                                                                                                      |
| **Risk**                       | **Very high.** A wrong cue in a live show is a visible, humiliating failure. Combined with the fact that the deterministic baseline already covers the common case, the **model's marginal value is small and its downside is large**.                                                              |
| **Differentiation**            | Low. Cue lights are a solved problem in live audio.                                                                                                                                                                                                                                                 |
| **Small prototype**            | The deterministic cue from the arrangement + the manual button.                                                                                                                                                                                                                                     |
| **Verdict**                    | **Research bet — and the first candidate for outright rejection.** See `AAW_DECISION_LOG.md`.                                                                                                                                                                                                       |

---

## 11. Z-10 — Vocal clarity monitoring

| Field                          | Specification                                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JTBD**                       | _"Is the singer actually audible over this band right now?"_                                                                                                                                                     |
| **Minimum viable interaction** | A live meter: vocal-to-mix level ratio, intelligibility proxy, and a **warning band** — with a conservative action (e.g. "the vocal is 3 dB under the band at this point") rather than an automatic gain change. |
| **Data required**              | The live input + the mix buses                                                                                                                                                                                   |
| **Components**                 | Deterministic metering (level ratio, plus an objective intelligibility proxy such as band-weighted SNR or a light ASR-based check in REH only)                                                                   |
| **Action APIs**                | `mix.monitorClarity() → ClarityReport` (R0); in LIVE, a display-only band                                                                                                                                        |
| **Quality metric**             | The monitor must agree with a human's judgement of "can I hear the words" ≥ 80 % on a test set                                                                                                                   |
| **Hard real-time constraint**  | Metering runs on the audio thread budget — fixed, allocation-free, bounded. **No ASR in LIVE.**                                                                                                                  |
| **Fallback**                   | A plain level-ratio meter (already standard)                                                                                                                                                                     |
| **Risk**                       | Low. The risk is over-warning → the performer ignores it. Mitigation: conservative thresholds, hysteresis, and a "disable warnings" option.                                                                      |
| **Differentiation**            | **Low-medium.** Useful, not defining.                                                                                                                                                                            |
| **Small prototype**            | Level-ratio meter + a calibrated warning band.                                                                                                                                                                   |
| **Verdict**                    | **Build now (deterministic).**                                                                                                                                                                                   |

---

## 12. Z-11 — Rehearsal-to-show transfer

| Field                          | Specification                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JTBD**                       | _"What I rehearsed must be what I play — no show-day surprises."_                                                                                                                             |
| **Minimum viable interaction** | One button: _"Build show profile from this rehearsal"_ → a frozen, self-contained profile with all parameters resolved, all assets local, all fonts/paths embedded, and a pre-show self-test. |
| **Data required**              | The rehearsal session's final state + all referenced assets                                                                                                                                   |
| **Components**                 | Deterministic: profile freezing, asset embedding, dependency closure, a self-test that renders the whole set offline and checks for missing assets, parameter drift and latency violations    |
| **Action APIs**                | `show.freezeProfile(sessionId) → ShowProfile` (R2); `show.selfTest(profileId) → SelfTestReport` (R0)                                                                                          |
| **Quality metric**             | **The metric is a binary: the show profile reproduces the rehearsal state exactly** (parameter hashes equal, asset hashes equal) — plus a self-test that reports every difference             |
| **Hard real-time constraint**  | The show profile must not require any live analysis; it is a frozen parameter set                                                                                                             |
| **Fallback**                   | Manual show setup (the status quo) — the feature is an improvement, not a dependency                                                                                                          |
| **Risk**                       | Low, and the _absence_ of this is a large risk (show-day surprises are the classic failure)                                                                                                   |
| **Differentiation**            | **Medium** — but it is the kind of reliability that makes a product professional rather than impressive.                                                                                      |
| **Small prototype**            | Profile freezing + a self-test report. **This is arguably the highest value-per-hour item in the ZYVO portfolio.**                                                                            |
| **Verdict**                    | **Build now.**                                                                                                                                                                                |

---

## 13. Z-12 — Voice identity protection

| Field                          | Specification                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JTBD**                       | _"Use my voice, but never let it escape or be turned into something I didn't agree to."_                                                                  |
| **Minimum viable interaction** | A visible **voice grant** panel: what may be processed, what may be cloned, what may be exported, what may be learned from — each revocable, each logged. |
| **Data required**              | The performer's own audio + the grant records                                                                                                             |
| **Components**                 | Policy + enforcement, not a model. Every voice-related capability checks the grant before executing; every use is written to the receipt.                 |
| **Action APIs**                | `voice.grant(scope, capabilities)`; `voice.revoke(grantId)`; `voice.audit()` → the complete list of every use of the performer's voice                    |
| **Quality metric**             | 100 % of voice capabilities check a grant; **zero** voice-derived artefacts outside a grant's scope; revocation destroys artefacts within one session     |
| **Hard real-time constraint**  | The check is a cheap local lookup, performed at capability invocation, not per audio block                                                                |
| **Fallback**                   | Without a grant, voice capabilities are unavailable (they are opt-in by construction)                                                                     |
| **Risk**                       | The _absence_ of this is the real risk. The failure mode (an AI cloning a user's voice) is severe, reputationally and legally.                            |
| **Differentiation**            | **Not a differentiator — a requirement.** It is listed because a category-defining AAW must have it and most competitors will not.                        |
| **Small prototype**            | A grant store + an audit view + enforcement in the capability path.                                                                                       |
| **Verdict**                    | **Build now (policy).**                                                                                                                                   |

---

## 14. What ZYVO should explicitly NOT build

| Rejected concept                                              | Why                                                                                                                                                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Automatic live scene changes driven by a model**            | RT-9; a wrong guess on stage is a performance failure; the deterministic arrangement already covers the common case (Z-9)                                                          |
| **Live AI in the monitor chain**                              | The monitor path must be the most predictable thing in the product; AI latency there is unacceptable                                                                               |
| **A "vocal quality score"**                                   | Unlabelable; the same fabrication trap as a mix score                                                                                                                              |
| **Voice cloning / conversion without an explicit grant**      | Non-negotiable; see Z-12                                                                                                                                                           |
| **ASR-driven live cueing in the show path**                   | Late cues are worse than none; the arrangement already knows the structure                                                                                                         |
| **AI that "improves" the performance (re-tuning the singer)** | The performer's voice is the asset; a plan that changes how they sang must be a distinct, explicitly-labelled, higher-risk capability class (`AAW_AI_CONTROL_CONTRACTS.md` §4, R3) |
| **Training on the performer's private sessions**              | Forbidden without explicit permission and provenance                                                                                                                               |

---

## 15. Sequencing recommendation

| Order                | Items           | Rationale                                                                                                                           |
| -------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **1 (0–3 months)**   | Z-11, Z-1, Z-12 | Reliability first: a show profile that works, a comping comparison that is honest, and voice-grant enforcement. None needs a model. |
| **2 (3–6 months)**   | Z-3, Z-4, Z-10  | The chain/scene/pitch features that make a vocal mix sound professional — deterministic, envelope-bounded, safe                     |
| **3 (6–12 months)**  | Z-2, Z-7        | Coaching and expressive automation — objective, target-relative, performer-controlled                                               |
| **4 (12–24 months)** | Z-5, Z-6, Z-8   | Alignment, comping proposals, scene orchestration — each gated on the objective measurement above it                                |
| **5 (research)**     | Z-9             | The only genuinely speculative item; the first candidate for rejection                                                              |
