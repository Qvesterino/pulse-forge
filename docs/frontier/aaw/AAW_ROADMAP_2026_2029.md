# AAW_ROADMAP_2026_2029

**Status:** a staged 24–36 month program for KYX and ZYVO, with prioritisation, a hostile review, and a revised plan
**Date:** 2026-10-25
**Companions:** `AAW_FRONTIER_EXECUTIVE_THESIS.md`, `AAW_EXPERIMENT_BACKLOG.md`, `AAW_DECISION_LOG.md`

---

## 1. How this plan was built, and what it assumes

**It assumes** the verified substrate in `AAW_STATE_OF_THE_ART_2026.md` §1: a reversible command
layer, frame-grouped undo, a 39-tool MCP surface with a real dry-run sandbox, live/offline render
parity, a hard real-time boundary, typed effect metadata, a deterministic-first intent pipeline, a
local ONNX slot-filler, a local LLM path, deterministic DSP perception, a local preference loop, and
a vendored (flag-gated) separation model.

**It assumes** it does **not** have: audio understanding, a consent lattice for mutating tools,
transactional rollback, durable undo, a project-graph planner, or a rate limit.

**It assumes** the developer is **one primary developer with coding agents**, a 6–16 GB VRAM machine
and 64 GB RAM for the local tier, and a budget that does not support a 30 B model or a hosted
inference bill at scale.

**Scoring is reproducible.** Every number in §2 is produced by
`docs/frontier/_research/score-model.mjs`; the script asserts that every weight set sums to 1.0 and
that every score is within 1–5. (It caught an author error in a weight set during drafting, which is
the point of having it.)

---

## 2. Prioritisation

### 2.1 Criteria and weights

| #   | Criterion                           | Base weight | Why this weight                                                                                                         |
| --- | ----------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | User value                          | **0.16**    | The program's purpose is to help musicians. Highest single weight, but not higher, because value must be _demonstrable_ |
| 2   | Musical differentiation             | **0.14**    | If it is not a category claim, it does not define a product                                                             |
| 3   | Technical feasibility               | **0.13**    | A one-person team must finish                                                                                           |
| 4   | Evidence strength                   | **0.13**    | Equal to feasibility on purpose: this program's credibility is its evidence                                             |
| 5   | Data availability                   | **0.09**    | Data is a precondition, rarely a differentiator                                                                         |
| 6   | Latency feasibility                 | **0.08**    | Latency is a _filter_, expressed through feasibility — not double-counted                                               |
| 7   | Safety                              | **0.10**    | The product holds people's work; a safety failure can end a product                                                     |
| 8   | Maintainability                     | **0.09**    | Everything shipped is forever                                                                                           |
| 9   | Independent-developer affordability | **0.08**    | The binding resource constraint                                                                                         |

**Sum: 1.00** (enforced by the script).

### 2.2 The scored table

Scores are 1–5. `Δ` columns show the rank change under three alternative weightings.

| id       | Capability                                                    | base     | rank   | safety | evidence | ship-fast | Δ rank (safety / evid / ship) |
| -------- | ------------------------------------------------------------- | -------- | ------ | ------ | -------- | --------- | ----------------------------- |
| **Z-1**  | Take comparison (A/B with measurable diff)                    | **4.86** | **1**  | 1      | 1        | 1         | 0 / 0 / 0                     |
| **Z-11** | Rehearsal-to-show transfer (show profile + self-test)         | **4.63** | **2**  | 2      | 2        | 5         | 0 / 0 / +3                    |
| **P-1**  | Permission lattice (consent for the 21 mutating tools)        | **4.63** | **3**  | 3      | 3        | 6         | 0 / 0 / +3                    |
| **K-4**  | Multi-variant A/B arrangement                                 | **4.57** | **4**  | 6      | 9        | 4         | +2 / +5 / 0                   |
| **K-7**  | Rhythm transformation with musical constraint                 | **4.56** | **5**  | 4      | 4        | 2         | −1 / −1 / −3                  |
| **P-3**  | Capability registry versioning (side-effect + RT metadata)    | **4.56** | **6**  | 5      | 5        | 3         | −1 / −1 / −3                  |
| **K-5**  | Context-sensitive sound selection                             | **4.49** | **7**  | 9      | 12       | 14        | +2 / +5 / +7                  |
| **K-1**  | Timbral search by intent                                      | **4.48** | **8**  | 8      | 11       | 9         | 0 / +3 / +1                   |
| **Z-3**  | Context-sensitive vocal effects (scene by section)            | **4.47** | **9**  | 13     | 13       | 8         | +4 / +4 / −1                  |
| **Z-12** | Voice identity protection (grants + audit)                    | **4.42** | **10** | 7      | 6        | 7         | −3 / −4 / −3                  |
| **K-2**  | Groove-preserving edits                                       | **4.39** | **11** | 17     | 7        | 16        | +6 / −4 / +5                  |
| **P-11** | Slovak ASR path (Whisper)                                     | **4.39** | **12** | 10     | 8        | 10        | −2 / −4 / −2                  |
| **P-2**  | Scope-diff verifier (pre-commit gate)                         | **4.35** | **13** | 12     | 10       | 15        | −1 / −3 / +2                  |
| **P-9**  | Cross-product musical transfer (notes/patterns in `.kyxzyvo`) | **4.32** | **14** | 14     | 14       | 19        | 0 / 0 / +5                    |
| **K-12** | Transition & fill generation                                  | **4.27** | **15** | 11     | 19       | 11        | −4 / +4 / −4                  |
| **P-4**  | Perception cache / typed analysis artifacts                   | **4.19** | **16** | 16     | 16       | 20        | 0 / 0 / +4                    |
| **P-7**  | Rate limiting on the MCP relay                                | **4.16** | **17** | 20     | 17       | 13        | +3 / 0 / −4                   |
| **K-6**  | Musical tension planning (deterministic)                      | **4.14** | **18** | 18     | 23       | 18        | 0 / +5 / 0                    |
| **Z-10** | Vocal clarity monitoring                                      | **4.13** | **19** | 15     | 22       | 12        | −4 / +3 / −7                  |
| **P-5**  | Durable undo (survives reload)                                | **4.13** | **20** | 19     | 18       | 17        | −1 / −2 / −3                  |
| **Z-4**  | Safe pitch-effect control                                     | **4.11** | **21** | 22     | 15       | 21        | +1 / −6 / 0                   |
| **P-6**  | Transactional batch (rollback, not stop-on-failure)           | **4.04** | **22** | 21     | 20       | 22        | −1 / −2 / 0                   |
| **Z-2**  | Phrase-aware vocal coaching                                   | **4.00** | **23** | 23     | 21       | 23        | 0 / −2 / 0                    |
| **P-8**  | Intent backbone licence migration (Apache/MIT fallback)       | **3.80** | **24** | 24     | 24       | 24        | 0 / 0 / 0                     |
| **Z-8**  | Performance scene orchestration                               | **3.63** | **25** | 26     | 25       | 25        | +1 / 0 / 0                    |
| **K-11** | Reference-matched mastering moves                             | **3.55** | **26** | 28     | 26       | 26        | +2 / 0 / 0                    |
| **P-10** | Audio embedding layer                                         | **3.54** | **27** | 25     | 27       | 29        | −2 / 0 / +2                   |
| **K-10** | Producer-specific creative assistant                          | **3.43** | **28** | 29     | 29       | 28        | +1 / +1 / 0                   |
| **Z-7**  | Expressive automation from performance                        | **3.39** | **29** | 27     | 30       | 27        | −2 / +1 / −2                  |
| **Z-6**  | Vocal comping assistance                                      | **3.38** | **30** | 30     | 28       | 30        | 0 / −2 / 0                    |
| **K-3**  | Mix-aware beat generation (constrained)                       | **3.06** | **31** | 34     | 31       | 35        | +3 / 0 / +4                   |
| **P-12** | Local speech model (LFM audio)                                | **3.05** | **32** | 33     | 32       | 33        | +1 / 0 / +1                   |
| **Z-5**  | Word-level lyric/phonetic alignment                           | **3.01** | **33** | 31     | 33       | 31        | −2 / 0 / −2                   |
| **K-8**  | Editable generative stems                                     | **2.98** | **34** | 35     | 34       | 36        | +1 / 0 / +2                   |
| **K-9**  | Energy-aware arrangement                                      | **2.88** | **35** | 32     | 35       | 32        | −3 / 0 / −3                   |
| **Z-9**  | Live cue prediction                                           | **2.61** | **36** | 36     | 36       | 34        | 0 / 0 / −2                    |

### 2.3 What the sensitivity analysis actually tells us

The alternative weightings are not decoration. They answer "what if the team disagrees with me?":

| Finding                                                                                                                                                                  | Evidence                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **Z-1 (take comparison) is the most robust item in the program** — rank **1 under all four weightings**, including ship-fast, evidence-first and safety-first            | the table above                                                                                                |
| **P-1 (permission lattice) and P-3 (registry metadata) are top-6 under every weighting**                                                                                 | rank 3/6/3 and 6/5/5                                                                                           |
| **K-2 (groove-preserving edits) is the most weight-sensitive item in the program**: rank 11 base, but **17 under safety-first** (+6) and **7 under evidence-first** (−4) | a judgement call, not a fact — it must be argued, not assumed                                                  |
| **K-5 (context selection) and K-4 (multi-variant A/B) collapse under evidence-first** (+5 each)                                                                          | their evidence base is the thinnest of the top group; they need E-09/E-10 evidence _before_ they are committed |
| **Z-9 (live cue prediction) is last under three of four weightings and 34th under the fourth**                                                                           | **robustly rejected** — not merely deprioritised                                                               |
| **K-8 (editable generative stems) is 34th/35th/36th across three weightings**                                                                                            | **robustly last-tier** — the most famous idea in the program is the least defensible                           |
| **P-8 (licence migration) sits at 24 under every weighting**                                                                                                             | it is not a _feature_; it is insurance. It should be scheduled, not ranked against features                    |

**The honest conclusion:** the top of the list is dominated by **trust and measurement
infrastructure**, not by AI features. That is what a red-team-correct prioritization looks like when
the substrate already exists and the risk is in overreach.

---

## 3. Portfolio I — Near-term foundation (0–6 months)

**Thesis of this wave:** _make the existing AI surface safe, scoped and measurable — and add the two
capabilities that are already 80 % built._ Nothing in this wave requires a new model.

| #        | Initiative                                                                                                                                                      | Type                   | Effort | Hardware           | Op. cost | Uncertainty                                | Value                        | Moat                                                               | Milestone                                                                                | Falsification                  | Kill criteria                                                         | Maintenance                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------ | ------------------ | -------- | ------------------------------------------ | ---------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- | -------------------------------------- |
| **P-3**  | **Capability registry versioning**: add `version`, `sideEffects`, `realtimeSafe`, `latencyClass`, `riskClass`, `undoUnit` to every effect/param/tool descriptor | _shippable product_    | **M**  | CPU                | ~0       | Low (metadata only)                        | Med                          | **High** — it is the substrate every later capability reasons over | registry v1 with 57 effects + 39 tools annotated                                         | E-08 (preview↔commit parity)   | none (it is pure metadata)                                            | Low (one-time + version bumps)         |
| **P-1**  | **Permission lattice**: wire `read\|runtime\|mutate\|destructive` to a deterministic decision (auto / confirm / forbid) with per-project autonomy ceilings      | _shippable product_    | **L**  | CPU                | ~0       | Low                                        | **High**                     | **High** — trust is the moat in this category                      | 21 mutating tools classified; a red-team corpus proves injection cannot approve anything | injection corpus (T-1..T-6)    | any tool found that mutates without a lattice decision                | Low (policy table)                     |
| **P-2**  | **Scope-diff verifier**: compare the applied diff to the declared scope; hash protected objects before/after                                                    | _shippable product_    | **L**  | CPU                | ~0       | Med (hash semantics for every object kind) | **High**                     | **High**                                                           | C-1/C-2 at 100 % on the golden set                                                       | Suite C on the golden set      | any protected object observed mutated                                 | Low–Med (new object kinds need hashes) |
| **P-6**  | **Transactional batch**: rollback already-applied steps on failure instead of stopping                                                                          | _production candidate_ | **M**  | CPU                | ~0       | Med                                        | Med                          | Med                                                                | `kyx_batch` becomes atomic (or is renamed — the audit forbids calling it atomic today)   | Suite C + G                    | rollback proves impossible for a command kind                         | Med                                    |
| **P-5**  | **Durable undo**: persist the undo stack so history survives a reload                                                                                           | _production candidate_ | **L**  | disk               | ~0       | Med                                        | Med                          | Low (a hygiene feature)                                            | undo survives reload; snapshot cadence decoupled                                         | Suite G                        | storage cost of the history exceeds the benefit                       | Med                                    |
| **P-7**  | **Rate limiting + loop guards on the MCP relay**                                                                                                                | _shippable product_    | **S**  | CPU                | ~0       | Low                                        | Med                          | Low                                                                | a runaway agent loop is capped                                                           | Suite I                        | —                                                                     | Low                                    |
| **P-11** | **Slovak ASR path**: Whisper-large-v3(-turbo) for Slovak transcription, as a local, optional model                                                              | _shippable product_    | **M**  | CPU, ~1.6 GB model | ~0       | Med (singing ≠ reading)                    | **High for a Slovak market** | Med (the _only_ verified Slovak-capable path)                      | Slovak lyrics transcribe with a measured WER                                             | **E-02**                       | sung WER > 20 % → keep it for read/notes use only                     | Med (model packaging)                  |
| **P-9**  | **Cross-product musical transfer**: carry notes/patterns through `.kyxzyvo`                                                                                     | _shippable product_    | **L**  | CPU                | ~0       | Med (two schemas)                          | High                         | Med                                                                | a KYX beat arrives in ZYVO **editable**                                                  | round-trip test on 20 projects | transfer fidelity < 90 % → ship the manifest-only transfer and say so | Med                                    |
| **K-4**  | **Multi-variant A/B arrangement** + the diff card                                                                                                               | _shippable product_    | **M**  | CPU                | ~0       | Low                                        | High                         | **High** — it is the review instrument for the whole category      | 2–3 variants, instant switch, numeric diff                                               | **E-09**                       | rejection rate > 60 % → one proposal + "show alternatives"            | Med                                    |
| **K-7**  | **Rhythm transformation with musical constraint**                                                                                                               | _shippable product_    | **M**  | CPU                | ~0       | Low                                        | Med                          | Low                                                                | four transforms + preserved-swing/velocity readout                                       | Suite E                        | grid preservation < 100 % outside the declared edit                   | Low                                    |
| **K-1**  | **Timbral search by intent** (embeddings + retrieval over the library)                                                                                          | _shippable product_    | **M**  | CPU, ~0.6 GB       | ~0       | Low                                        | High                         | **High**                                                           | search-by-description in the browser                                                     | **E-06**                       | < 10 points over metadata search                                      | Med                                    |
| **Z-1**  | **Take comparison (A/B with a measurable diff)**                                                                                                                | _shippable product_    | **M**  | CPU                | ~0       | Low                                        | **High**                     | Med                                                                | per-pair diff: pitch, timing, loudness, spectral delta                                   | **D-2**                        | the diff disagrees with blind preference > 20 %                       | Med                                    |
| **Z-11** | **Show profile freeze + pre-show self-test**                                                                                                                    | _shippable product_    | **M**  | CPU                | ~0       | Low                                        | **High**                     | Low                                                                | the show reproduces the rehearsal exactly                                                | self-test diff = empty         | any parameter drift the self-test cannot see                          | Low                                    |
| **Z-12** | **Voice grants + voice-use audit**                                                                                                                              | _shippable product_    | **S**  | CPU                | ~0       | Low                                        | Med                          | Low                                                                | every voice capability checks a grant; an audit view lists every use                     | grant-revocation test          | —                                                                     | Low                                    |

**Wave 0 exit criterion:** P-3 + P-1 + P-2 shipped, the injection corpus passes at 100 %, and Suite
C runs at 100 % on the golden set. **Nothing else starts before this.** It is the wave that makes
every later wave safe.

---

## 4. Portfolio II — Medium-term breakthroughs (6–18 months)

**Thesis:** with the trust substrate in place, add the capabilities that make the products feel
different — and the _first_ perception layer that can talk about sound.

| #        | Initiative                                                                                                | Type                              | Effort  | Hardware            | Op. cost | Uncertainty              | Value    | Moat                                                                | Milestone                                                                             | Falsification                                      | Kill criteria                                                 | Maintenance                     |
| -------- | --------------------------------------------------------------------------------------------------------- | --------------------------------- | ------- | ------------------- | -------- | ------------------------ | -------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------- | ------------------------------- |
| **P-4**  | **Perception cache + typed analysis artifacts** (key = revision × algorithm × params; reproducible bytes) | _production candidate_            | **L**   | CPU                 | ~0       | Med (cache invalidation) | Med      | **High** — reproducible perception is the enabler of every AI claim | the same project+version yields identical bytes                                       | golden-vector test                                 | determinism cannot be achieved for an artifact                | Med                             |
| **K-5**  | **Context-sensitive sound selection** (re-rank the library by project state)                              | _production candidate_            | **M**   | CPU                 | ~0       | Low–Med                  | High     | **High**                                                            | 3 project-aware suggestions with a one-line reason                                    | **E-06**, **E-10**                                 | user rejection > 40 %                                         | Low                             |
| **K-2**  | **Groove-preserving edits** (thresholded re-quantisation + preservation report)                           | _production candidate_            | **L**   | CPU                 | ~0       | Med                      | **High** | **High**                                                            | "tighten but keep the feel" with a measurable preservation statement                  | **E-10**, Suite E                                  | median onset deviation > 8 ms, or velocity correlation < 0.99 | Med                             |
| **K-12** | **Transition & fill generation** (tagged library + energy-context matching)                               | _production candidate_            | **S–M** | CPU                 | ~0       | Low                      | Med      | Low                                                                 | 3 fills matched to the project's energy, auditionable in place                        | Suite D                                            | —                                                             | Low                             |
| **Z-3**  | **Context-sensitive vocal effects** (scene per song section)                                              | _production candidate_            | **L**   | CPU                 | ~0       | Med                      | High     | Med                                                                 | one undo unit for a whole scene set                                                   | Suite D + G                                        | a scene measurably fights the performance                     | Med                             |
| **Z-4**  | **Safe pitch-effect control** (confidence-gated, bounded, slewed)                                         | _production candidate_            | **M**   | CPU, real-time-safe | ~0       | Med                      | High     | Med                                                                 | correction curve display; per-phrase bypass                                           | Suite D + I                                        | identity change reported by > 5 % of listeners                | Med                             |
| **Z-10** | **Vocal clarity monitoring** (deterministic, conservative)                                                | _production candidate_            | **S–M** | CPU, RT-safe        | ~0       | Low                      | Med      | Low                                                                 | a calibrated warning band with hysteresis                                             | agreement with human "can I hear the words" ≥ 80 % | agreement < 70 %                                              | Low                             |
| **P-10** | **Audio embedding layer** (commercial embeddings only: CLAP-class, Apache-2.0)                            | _research prototype → production_ | **L**   | CPU, ~0.6 GB        | ~0       | Med                      | High     | Med                                                                 | embeddings for the library; a measured A/B against metadata search                    | **E-06**                                           | no gain over metadata search                                  | Med                             |
| **P-8**  | **Intent backbone licence migration** (an Apache/MIT fallback path, fully evaluated)                      | _production candidate_            | **M**   | CPU                 | ~0       | Med                      | Med      | **High** — it is insurance against a $10M cliff                     | a second permitted backbone runs the golden intent suite at ≥ parity                  | Suite A on the alternate backbone                  | parity is unachievable → escalate to legal                    | Med (two backbones to maintain) |
| **Z-6**  | **Vocal comping assistance** (continuity inspector first, proposals later)                                | _research prototype_              | **L**   | CPU                 | ~0       | Med                      | Med      | Med                                                                 | a splice-continuity inspector that flags bad joins                                    | Suite D                                            | the inspector is not useful on its own                        | Med                             |
| **Z-2**  | **Phrase-aware vocal coaching** (target-relative, performer-owned targets)                                | _research prototype_              | **L**   | CPU                 | ~0       | Med                      | Med      | Med                                                                 | phrase-level overlay against the performer's own best take                            | Suite D                                            | performers find it discouraging (measured)                    | Med                             |
| **K-6**  | **Musical tension planning** (deterministic, honest reporting)                                            | _production candidate_            | **M**   | CPU                 | ~0       | Med                      | Med      | Med                                                                 | concrete moves + the dimension changed + "tension not measurably increased" when true | **E-07**                                           | E-07 shows tension is not measurable → ship without the claim | Low                             |

---

## 5. Portfolio III — Frontier horizon (18–36 months)

**Thesis:** the bets that could define the category — **all conditional on a measured precondition**.

| #        | Initiative                                                                                          | Type                 | Effort | Hardware               | Op. cost         | Uncertainty                        | Value   | Moat | Milestone                                                                 | Falsification                                         | Kill criteria                                                                                             | Maintenance |
| -------- | --------------------------------------------------------------------------------------------------- | -------------------- | ------ | ---------------------- | ---------------- | ---------------------------------- | ------- | ---- | ------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------- |
| **K-3**  | **Mix-aware beat generation** (constrained; ACE-Step 1.5 as the only verified commercial generator) | _research prototype_ | **XL** | 8–16 GB VRAM           | ~0 locally (MIT) | **High**                           | High    | Med  | generation inside a user-specified constraint                             | **E-07** + a listening gate vs the retrieval baseline | the retrieval baseline is preferred → generation loses                                                    | High        |
| **K-8**  | **Editable generative stems** (generation that lands as editable material)                          | _research prototype_ | **XL** | 8–16 GB VRAM           | ~0               | **High**                           | Med     | Med  | a stem a human can edit without re-generation                             | Suite D + editability check                           | generation output is not editable in practice                                                             | High        |
| **K-9**  | **Energy-aware arrangement** (needs a human-labelled energy curve)                                  | _research prototype_ | **XL** | CPU                    | ~0               | **High**                           | Med     | Low  | the realised arc matches the requested arc                                | objective arc correlation                             | labelling cost exceeds the value                                                                          | High        |
| **Z-5**  | **Word-level lyric alignment** (Slovak)                                                             | _research prototype_ | **L**  | CPU                    | ~0               | **High**                           | Med     | Low  | word-level timeline with ±100 ms accuracy                                 | **E-02**                                              | WER > 20 % → needs a fine-tune; defer                                                                     | Med         |
| **Z-7**  | **Expressive automation from performance**                                                          | _research prototype_ | **M**  | CPU                    | ~0               | Med                                | Med     | Low  | curves that follow the performance without over-smoothing                 | Suite E                                               | curves are more regular than the performance                                                              | Med         |
| **Z-8**  | **Performance scene orchestration** (suggestion-only; human triggers)                               | _research prototype_ | **M**  | CPU                    | ~0               | Med                                | Med     | Med  | a pre-show self-test that exercises every transition                      | Suite I                                               | any scene change needs a model to trigger                                                                 | Med         |
| **P-12** | **Local speech model** (LFM2.5-Audio-1.5B, GGUF/ONNX)                                               | _research prototype_ | **L**  | CPU (GGUF) / WebGPU    | ~0               | **High** (long-audio degeneration) | Med     | Med  | CPU-only speech in the product                                            | **E-01**, **E-03**, **E-04**                          | within ±10 % of Whisper → do not adopt; use Whisper                                                       | High        |
| **K-10** | **Producer-specific creative assistant** (opt-in, explicit signals)                                 | _research prototype_ | **L**  | CPU                    | ~0               | Med                                | Med     | Med  | retrieval over explicit preferences; a ranker only if T-2's trigger fires | **T-2**                                               | top-1 agreement < 55 %                                                                                    | Med         |
| **—**    | **Learned project representation** (replacing the typed graph)                                      | _research bet_       | **XL** | 8 GB VRAM              | ~0               | **High**                           | Low–Med | Low  | —                                                                         | **E-11**                                              | < 5 points over the typed graph → **rejected**                                                            | Very high   |
| **Z-9**  | **Live cue prediction**                                                                             | _research bet_       | **L**  | CPU                    | ~0               | **Very high**                      | Low     | Low  | —                                                                         | —                                                     | **rejected by scoring (last under three of four weightings)**                                             | —           |
| **—**    | **Frontier audio-LLM as the perception layer**                                                      | _research bet_       | **XL** | 20–35 GB VRAM / server | High             | **Very high**                      | ?       | ?    | —                                                                         | —                                                     | **no commercially usable candidate exists at this tier** (NVIDIA-noncommercial / CC-BY-NC / server-class) | Very high   |

---

## 6. Two resource scenarios

### 6.1 The real scenario — one primary developer + coding agents

**Constraint:** ~160–200 working days per year of human attention; coding agents supply maybe 3–5×
that in mechanical work, and **cannot supply judgement**.

**What this changes:**

1. **Sequencing is everything.** Waves I and II are ordered so that each wave makes the next one
   cheaper. P-3 before P-1; P-1 before P-2; P-2 before K-2/K-4.
2. **Two initiatives can be "in flight"; not five.** The agent-parallelism budget is spent on
   _independent, mechanical_ work (tests, contracts, docs, golden sets) — never on two
   architecture-changing items at once.
3. **The research portfolio must fit in the gaps.** E-03/E-07/E-06/E-01 are **M** and mostly CPU —
   they fit between shipping waves, and their results can _cancel_ work before it starts. That is
   their highest value: **E-07 alone could cancel the most expensive feature in the program.**
4. **No cloud inference at scale.** It converts a licence-and-cost problem into a privacy problem,
   and the user's audio is the asset.
5. **The one thing to protect is the review loop.** A human reviewing agent output is the
   bottleneck; everything else should be delegated to agents.

**A realistic 12 months on this scenario:**

| Quarter | Work                                                                          | Output                                                                                    |
| ------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Q1      | P-3 (registry metadata) + P-7 (rate limit) + E-07 (tension experiment)        | The substrate every later capability reasons over; one expensive idea measured            |
| Q2      | P-1 (permission lattice) + P-11 (Slovak ASR) + E-06 (retrieval A/B)           | 21 mutating tools now gated; Slovak transcription measured; search-by-description decided |
| Q3      | P-2 (scope verifier) + K-4 (multi-variant A/B) + P-9 (cross-product transfer) | Scope integrity at 100 %; the review instrument; a KYX beat editable in ZYVO              |
| Q4      | K-1 (timbral search) + Z-1 (take comparison) + Z-11 (show profile)            | Two flagship capabilities that need no model; the show is safe                            |

### 6.2 The better-funded scenario

With a team of 3–5 and a compute budget, the changes are: P-5/P-6/P-7 move to Q1; **E-03/E-01/E-04/E-05** run in parallel on separate machines (they need GPU or long runs); the **audio perception track** (P-4 + P-10 + a measured learned-perception experiment) becomes a real sub-team; K-3/K-8 get a fair trial against a proper baseline; and a **listening-lab capability** (recruiting, hosting, blinded protocol tooling) becomes a permanent asset rather than a per-project cost.

**What does _not_ change:** the wave boundaries, the kill criteria, and the rule that no model is
adopted without a measured baseline failure. Money buys more experiments; it does not buy a
different decision rule.

---

## 7. The hostile review (red team)

> Conducted against the draft plan, before the revision in §8. Each question is answered honestly,
> and where the answer is "yes, this could kill the program", the consequence is a concrete change.

### Q1 — "What if no audio model understands subjective music well enough?"

**Honest answer: this is already true.** The verified landscape says the strongest open
music-understanding models are **non-commercial** (Audio Flamingo: NVIDIA OneWay; MERT, Music2Latent,
MusicGen, YuE2: CC-BY-NC-4.0) or **server-class** (Qwen3-Omni: 35 B). No open, commercially usable,
music-understanding model fits a 6–16 GB tier. KYX today has **no** audio embeddings, **no**
tagging, **no** audio-LLM — verified by exhaustive search of `src/`.

**Consequence:** the perception layer must be **deterministic DSP/MIR plus embeddings**, and the
_tension_ claim must go. → **Changed:** K-6 ships without an emotional claim; E-07 was promoted to
the #2 experiment; "musical tension" was removed from the flagship language.

### Q2 — "What if tool orchestration is slower and less reliable than manual editing?"

**Honest answer: possible, and it is measurable.** The deterministic path resolves the vast majority
of asks _before_ any model runs; the model's measured contribution is 91.7 % attempted-exact on the
routed subset. The repo's own negative result — a creative-task LoRA that passed 25/32 schema checks
but produced **0 of 24** expected creative proposals — is direct evidence that adding a model does
not add capability.

**Consequence:** every capability has a **deterministic fallback**, latency budgets are release
gates (H-1 ≤ 100 ms, H-2 ≤ 2 s, H-3 ≤ 8 s), and the decisive experiment is E-10 (assisted vs manual
wall-clock, with a rule that _any_ task where the assisted path is slower gets dropped). →
**Changed:** E-10 was promoted to a release gate; "no task may be slower" was written into
`AAW_EVALUATION_BENCHMARKS.md` §11.

### Q3 — "What if AAW features harm flow and autonomy?"

**Honest answer: the highest-probability failure mode.** Mitigations that were added: J-3 rejection
≤ 40 %, J-6 later-undo ≤ 15 %, the three-variant cap, "one clear recommendation + at most two
alternatives" as a product invariant, and R2/R3 always confirmed.

**Consequence:** the attention budget became a first-class metric (research track N-4), and the
autonomy setting can only be **raised** by the user, never by the model. → **Changed:** the
permission lattice's decision function is now explicit about who may raise autonomy.

### Q4 — "What if the chosen model disappears, changes licence, or becomes expensive?"

**Honest answer: it already happened in a sense — the pinned model has a $10M revenue cliff.**
The LFM Open License v1.0 conditions commercial use on the using legal entity staying under
$10,000,000 annual revenue (§5(a)/§5(b)), and it applies to `LiquidAI/LFM2.5-1.2B-Instruct`, the
model KYX already ships. The audio sibling is under the same licence.

**Consequence:** P-8 (an Apache/MIT fallback backbone) moved from "nice" to a scheduled initiative
with a parity gate; the model-provider interface became mandatory; the licence record must ship
_with_ the model pack (the licence terminates automatically on breach, so it cannot be fetched at
runtime). → **Changed:** P-8 is now in Portfolio II with a hard acceptance criterion, and the
licence question is ADR **D-02**.

### Q5 — "What if training data is too sparse, biased, or legally unusable?"

**Honest answer: likely, which is why nothing in this plan trains a model.** The repo's synthetic
bootstrap corpus failed to produce a single acceptable creative proposal. The preference ledger
only accepts _explicit_ signals, and "keeping the default" is the dominant behaviour.

**Consequence:** the decision tree in `AAW_TRAINING_AND_DATA_STRATEGY.md` §2 requires a published
baseline failure before any training; six candidate training projects each name their trigger,
their exit criteria _and_ their kill criteria. → **Changed:** T-1..T-6 were reduced to six
candidates with explicit triggers; "no training" became the plan's default state.

### Q6 — "What if KYX and ZYVO have incompatible state and plugin contracts?"

**Honest answer: they are incompatible today, and that is fine.** Two different schemas, two
effect systems, two time bases (KYX: 480 PPQ; ZYVO: sample/beat grids), two engines. The one
existing seam — `.kyxzyvo` — carries tempo, structure, markers, master and stems but **drops
MIDI/patterns/notes**.

**Consequence:** the shared control plane is defined as **formats and protocols only**
(`AAW_REFERENCE_ARCHITECTURE.md` §7); musical vocabulary is a product adapter; and the first
concrete cross-product work is **P-9** (carry the notes) rather than a shared planner. → **Changed:**
P-9 was promoted to Portfolio I on the argument that it is the precondition for every cross-product
AAW feature.

### Q7 — "What if the best outcome is a simpler deterministic feature, not AI?"

**Honest answer: for the top eight items on the list, that is exactly what happened.** The
highest-scoring capabilities — take comparison, show profile, permission lattice, registry
metadata, multi-variant A/B, rhythm transformation, context selection, timbral search — are
**deterministic or retrieval-based**. The genuinely AI-dependent items (K-3, K-8, K-9, P-12, Z-5)
occupy the bottom of the ranking.

**Consequence:** this is stated as the program's thesis rather than hidden. The AAW category claim
is _not_ "we have a model" — it is **"we have a trustworthy, reversible, verified loop that a
musician can drive, and the model is optional inside it."** → **Changed:** the executive thesis
was rewritten around this, and "Top 5 Things Not to Build Yet" now leads with the AI-shaped ideas.

---

## 8. The revised plan (what changed, and why)

| Change                                                                                            | Trigger         | Effect on the plan                                                            |
| ------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------- |
| P-3, P-1, P-2 form an **unbreakable gate** before any new AI capability                           | Q2, Q5          | Wave 0 is now blocking, not parallel                                          |
| "Tension" removed as an **emotional** claim                                                       | Q1, E-07        | K-6 reports the _dimension_ it changed, not a feeling                         |
| E-10 (assisted vs manual) promoted to a **release gate**                                          | Q2              | "no task may be slower" is now a rule                                         |
| P-8 (licence fallback backbone) scheduled with a parity gate                                      | Q4              | Insurance is now a deliverable, not a footnote                                |
| Attention budget added as a first-class metric                                                    | Q3              | J-3/J-6 are release gates                                                     |
| P-9 (carry notes across products) promoted to Wave I                                              | Q6              | The cheapest possible cross-product AAW step                                  |
| The "no training" default made explicit with 6 triggered candidates                               | Q5              | T-1..T-6 each have a kill criterion                                           |
| Z-9 (live cue prediction) and the learned project representation moved to **explicit rejections** | Q1, Q6, scoring | They are no longer on the roadmap; they are recorded as rejected with reasons |
| K-3/K-8/K-9 demoted to Portfolio III _with a baseline prerequisite_                               | Q1, Q7          | No generative work before the retrieval baseline is measured                  |

---

## 9. Explicitly rejected concepts (and why)

| Rejected                                                               | Reason                                                                                                                                    | What would revive it                                                                                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live cue prediction (Z-9)**                                          | Last under three of four weightings; the deterministic arrangement already knows the structure; a wrong cue on stage is a visible failure | A measured case where the arrangement is _wrong_ at performance time (ad-libs, dropped sections) and a human confirmation is still required |
| **A learned project/world model**                                      | The typed graph (schema v38, 480 PPQ) is already exact; a learned version is a proxy with no verifiable advantage                         | E-11 shows ≥ 10 points absolute over graph traversal                                                                                        |
| **A "mix quality score"**                                              | Nobody can label it reliably; a proxy becomes a lie; the repo has no such label                                                           | A reproducible human-labelled dataset of > 1000 pairs                                                                                       |
| **Frontier audio-LLM as the perception layer**                         | No commercially usable candidate at this tier (NVIDIA-noncommercial / CC-BY-NC / server-class)                                            | A permissively licensed, music-capable model under ~4 B appears                                                                             |
| **Real-time inference in the audio path**                              | Violates the invariant that is verified to hold today (zero network calls in `src/audio-worklets/**`)                                     | Never, without an ADR that changes the invariant                                                                                            |
| **Voice cloning without a recorded, revocable grant**                  | Voice is the one asset where "probably fine" is unacceptable                                                                              | Never                                                                                                                                       |
| **Training a "musical taste" model from ordinary edits**               | The repo's own code forbids it (`preference-ledger.ts:594-599`); acceptance ≠ endorsement                                                 | Explicit-signal-only data above the T-2 threshold                                                                                           |
| **A chat assistant as the product centre**                             | Contradicts the repo's own contract; destroys the attention budget                                                                        | Never                                                                                                                                       |
| **Auto-mastering optimisation**                                        | Objective substitution — the classic AI failure                                                                                           | Only _constraint matching_ to a user-supplied reference                                                                                     |
| **Embedding the local intent model in the web bundle's critical path** | Bundle budget; the model is already an opt-in download                                                                                    | A model small enough to be free at load                                                                                                     |
| **A second source of truth (a world-model store)**                     | Drift, two undo paths, unverifiable beliefs                                                                                               | Never                                                                                                                                       |

---

## 10. Top 5 Strategic Bets

1. **Trust is the moat, not intelligence.** Versioned capability metadata + a deterministic
   permission lattice + a scope-diff verifier + one-undo transactions + receipts. Nothing else in
   the category is as hard to copy, and it is the only thing that makes the AI parts acceptable.
2. **Perception stays deterministic (DSP/MIR + commercially-licensed embeddings) and becomes a
   _cache_, not a stage.** The evidence says no open, commercially usable music-understanding model
   fits the tier. Reproducible, revision-keyed analysis artifacts are the enabler for every future
   AI claim.
3. **The category-defining interaction is _situated_, not conversational**: selection-aware,
   two-variant, instantly switchable, with a numeric diff and a statement of what was preserved.
4. **The AAW's intelligence is optional.** Every capability has a deterministic fallback; the
   product is complete with every model uninstalled and the network off. This is both the
   trust argument and the vendor-independence argument.
5. **Honesty is the differentiator.** "This change does not measurably increase tension" is a
   feature. The competitors' weakest point is claiming feelings; KYX's strongest available position
   is _measuring_ and saying when it did not work.

---

## 11. Top 5 Things NOT to Build Yet

1. **Editable generative stems (K-8)** — 34th/35th/36th across three weightings; generation that
   is not editable is a demo, and the baseline it must beat does not exist yet.
2. **Live cue prediction (Z-9)** — last-ranked, deterministic structure already covers the common
   case, and a wrong cue on stage is a performance failure.
3. **A learned project representation / world model** — the most expensive idea with the weakest
   falsifiable hypothesis; E-11 decides it, and E-11 is cheap.
4. **A "musical quality" or "mix score" meter** — unlabelable; a proxy becomes a lie; it would
   violate the program's own evidence discipline.
5. **A local speech model in the product (P-12)** — within ±10 % of Whisper on the metrics that
   exist, English-only, a $10M licence cliff, and a known long-audio degeneration in the official
   path. The _experiments_ are worth running; the _product feature_ is not.

---

## 12. Next 3 Experiments

1. **E-03 — Does the official LFM audio path survive a full-length song?** (M, CPU) — decides
   whether a whole capability class is real, on Windows, with the runtime that matters.
2. **E-07 — Can any DSP feature separate "more tense" from "less tense"?** (M + M, CPU) — decides
   whether the flagship claim is a measurement or a hope, and can cancel the most expensive feature.
3. **E-06 — Does embedding retrieval beat metadata search for the library?** (S–M, CPU) — the
   cheapest high-visibility capability, with an immediate ship/kill answer.
