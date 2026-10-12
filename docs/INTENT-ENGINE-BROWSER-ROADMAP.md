# KYX Browser Intent Engine — world-class roadmap

> Long-term product and research roadmap for the browser-first intent engine.
> It covers natural-language control, artist and style interpretation, creative
> briefs, generated music quality, model training, quantization, and browser
> delivery. It is a plan and an evidence standard, not a claim that every stage
> is already shipped.
>
> Baseline snapshot: 2026-10-12. Recheck live code and manifests before using
> any baseline figure for a release decision.

## 1. Vision

KYX should let a producer describe a musical goal or a DAW change in ordinary
language, understand the request in the browser, and receive a useful,
reviewable result. A request may describe a broad direction (“dark, spacious
UK drill”), a reference artist, a change to the current beat, or a concrete
operation such as setting a tempo, changing a fader, choosing a preset, or
adjusting a supported effect parameter.

The experience must remain local-first, deterministic where the task permits,
and usable when an optional model is unavailable. Models propose typed intent
or rank candidates. They do not mutate the project directly. Existing command,
validation, preview, undo, timeout, circuit-breaker, and heuristic-fallback
boundaries remain in force.

“World-class” means measured improvements on independent prompts and real
browser hardware, across supported languages and tasks. It does not mean the
largest model, the most training rows, a high score on a familiar golden set,
or the smallest ONNX file by itself.

## 2. Product surfaces and model boundaries

The engine contains several different problems. They need distinct contracts,
data, and release gates.

| Surface                    | What it should understand or produce                                                                                        | Preferred path                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| DAW action intent          | A bounded operation and its validated slots: target, value, direction, amount, preset, or clarification                     | Deterministic routes first; local action model for hard cases; validated command proposal                                  |
| Artist and style reference | A sourced, abstract profile: genre lanes, tempo pocket, groove, energy, instrumentation, arrangement, and production traits | Researched profile catalog plus deterministic matching; optional semantic retrieval when it demonstrably improves coverage |
| Creative brief             | A structured `IntentSpec` from an open-ended request, with constraints, preferences, unknowns, and confidence               | Existing parser and generation pipeline first; a separate model only after a measured gap                                  |
| Music generation           | Original drum, bass, melodic, and arrangement candidates that obey the brief                                                | Symbolic/procedural generation and priors; model-assisted conditioning only behind the existing provider boundary          |
| Candidate choice           | Which generated option best fits the request and producer preferences                                                       | Heuristics plus ranker; train from genuine, blinded preferences rather than the current heuristic teacher                  |

Do not train one classifier to conflate DAW commands, artist lookup, creative
briefs, and “which beat sounds better.” Their outputs and error costs differ.

## 3. Browser quality contract

Every model-backed route should satisfy these product guarantees:

- **Correct operation:** never silently turn a request for one action into a
  different action. An uncertain or unsupported request should clarify or
  abstain.
- **Correct fields:** measure exact operation and slot values, not just the
  predicted intent kind. Count abstentions as misses when reporting overall
  success, and report coverage separately.
- **Safe proposal:** parse against the versioned schema, clamp numeric values,
  resolve references against the current project, and pass the result through
  existing command and preview flows.
- **Useful music:** evaluate generated audio and MIDI with listeners as well as
  structural checks. Parser accuracy is not evidence that a beat sounds good.
- **Language coverage:** publish separate English and Slovak results, and add
  another language only when the data and evaluation support it.
- **Browser readiness:** measure cold and warm latency, peak memory, download
  size, cache behavior, and offline behavior on real supported browsers and
  representative devices.
- **Graceful fallback:** model load, inference, or validation failure must leave
  the deterministic engine available and must never throw into the UI or audio
  callback.

Thresholds should be registered before each release candidate is evaluated.
Use the frozen deterministic route and currently active model as baselines.
For command intent, a wrong-kind action is a release blocker; a new model must
also improve exact results or useful coverage on a family-disjoint holdout.
For generated music and ranking, require blinded human preference evidence
with confidence intervals and breakdowns by task and style. Do not promote on
an aggregate score that hides a failing language or long-tail task.

Initial target ranges for Phase 0 to validate and preregister:

- Clear, supported action prompts: at least 95% end-to-end exact output overall
  and at least 90% for each sufficiently sampled language/task slice; an
  abstention counts as not exact. Keep the wrong-kind count at zero on the
  frozen release challenge set.
- Clear, supported action coverage: at least 85%, reported separately from
  exactness. Ambiguous or unsupported requests are a separate set; measure
  correct clarification/abstention and false action rate there.
- Candidate ranking: blinded pairwise preference must have a 95% confidence
  interval whose lower bound is above 50% against the frozen baseline, with
  ties and style slices reported separately.
- Browser latency and memory: register cold/warm P50/P95 and peak-memory
  budgets for each device class after measuring the current build. Do not hide
  slow low-memory devices inside a desktop average.

## 4. Starting point and measured gaps

The active browser action model is `public/models/intent-model-v1.onnx`
(6,799,814 bytes), with a 4,015-token vocabulary and 47 output heads. It is a
multi-head, closed-set slot-filling classifier. File size supports download
planning; it does not reveal the exact parameter count or prediction quality.

The current checked-in dataset is v5: 1,793 train rows, 299 validation rows,
and a 74-row golden regression set, in English and Slovak. Train and validation
have no exact prompt overlap; golden overlaps train on 67 prompts and validation
on 7, so golden is not an independent holdout. The active artifact was trained
against the previous v4 snapshot (1,790/298/74); its report pins those old input
hashes, while the v5 validator now evaluates and pins the active model against
the current splits. Do not present the old training provenance as a v5 retrain.

The current active-model validation is 285/287 exact among attempted outputs
(99.3%), with zero wrong-kind and 12/299 abstentions (4.0%) on validation. The
golden regression set is 63/63 exact among attempted outputs, with zero
wrong-kind and 11/74 abstentions (14.9%). The release gate passes, but this is
still a familiar, synthetic corpus rather than independent generalization or
musical-quality evidence.

Browser verification (`npm run verify:intent-model -- --full-eval`) also
measured the actual dispatch path. All 299 current validation phrases were
handled by deterministic routes, with 299/299 exact outputs and zero model
fallback calls. This validates the existing deterministic path and adapter
serialization; it does not measure the model's contribution. A separate
model-only pass returned 241/242 exact routes (99.6% conditional exactness),
zero wrong-kind, one slot mismatch, and 57/299 abstentions (19.1%). Those
abstentions include creative-brief protection and routes whose references or
fields the adapter refuses. The next model-quality gate needs a held-out set
of genuinely unmatched phrasings and a combined route report by language,
operation, and slot.

The browser run found and fixed a runtime failure mode: an expected ONNX
abstention was being counted as a worker failure, so two ordinary out-of-scope
prompts disabled the worker for the rest of that session. Abstention is now a
distinct reply from infrastructure failure; a browser test sends three
abstentions and then verifies that a later valid command still routes.
The browser full-eval also sends a valid model request after its abstain rows
and fails if the real worker does not recover; the latest Chromium run passed
that recovery check.

The browser audit found a field-name mismatch on the loudness action: the
trained head and decoder use `targetDb`, while the schema and resolver used
`targetLUFS`. The schema and adapter now match the trained `targetDb` contract;
the live grammar pin and validation report were refreshed without changing the
active weights.

The 2026-10-12 contract audit (`scripts/audit-intent-model-contract.mts`)
found 23 action kinds in the model schema, but only 21 in the trainer, active
ONNX artifact, and decoder. `stepEdit` and `soundSwap` remain absent end to end.
The v5 dataset generator now excludes seven teacher outputs outside the
executable model schema, and the trainer rejects any unseen closed-class label
instead of silently treating it as absent. Arrange and clip operation labels
are separated; the trainer now includes all 24 instrument kinds and all current
production concepts. This fixes label integrity but does not add missing model
operations or justify a broader model claim.

Known remaining capability gaps:

- Preset recognition heads are absent from the active artifact. The decoder
  abstains rather than inventing a preset; the deterministic preset registry
  remains the source for known names and suggestions.
- `stepEdit` and `soundSwap` need a complete schema → training → decoder →
  resolver → command and preview contract before they are advertised as model
  capabilities.
- Effect intent has bounded effect, target, direction, and percent fields. It
  does not imply arbitrary control of every plugin parameter. Add parameter
  actions only where project state, command, clamp, preview, and undo support
  them.
- The ONNX candidate ranker is about 25 KB and uses 54 features. Its labels
  remain heuristic-derived (`favoriteGroups: 0`), not evidence of human
  musical preference.
- The optional multilingual MiniLM model is already Q8 quantized and roughly
  118–120 MB. Keep it in a separately managed browser model pack, not on the
  boot path.

A v5 challenger trained in ignored `.sft/intent-model-v2-challenger/` reached
99.37% mean validation head accuracy, but decoded end-to-end it produced
260/299 exact validation routes (90.6% coverage, 95.9% attempted exactness),
two wrong-kind outputs, and 28 abstentions. The active model scored 285/299
exact, 96.0% coverage, zero wrong-kind, and 12 abstentions. The challenger is
rejected. It scored 70/74 on golden versus the active model's 63/74, but 67
golden prompts overlap training, so that difference is not generalization
evidence. Per-head accuracy alone is not a checkpoint or promotion metric.

Reconcile this snapshot with
[`docs/LOCAL-INTENT-MODEL.md`](LOCAL-INTENT-MODEL.md),
[`docs/intent-engine-ai-ranker-goal.md`](intent-engine-ai-ranker-goal.md),
[`docs/GENRE-RESEARCH.md`](GENRE-RESEARCH.md), and
[`docs/CREATIVE-TASK-HUMAN-EVALUATION.md`](CREATIVE-TASK-HUMAN-EVALUATION.md)
before implementation; those documents own detailed recipes and contracts.

## 5. Roadmap, in dependency order

### Phase 0 — Freeze the baseline and capability contract

**Goal:** know exactly what ships, what is measurable, and what each output is
allowed to do.

1. Pin the model, vocabulary, training data, feature/schema versions, runtime,
   and evaluation corpus by hash in manifests and reports.
2. Build a source-of-truth matrix from user phrase → router → model schema →
   decoded proposal → command and preview. For each operation, list every
   required field, allowed enum, numeric range, clarification rule, fallback,
   and unsupported case.
3. Keep three separate evaluation sets: training, tuning/validation, and
   family-disjoint held-out. Keep paraphrases, translations, and follow-up
   prompts from one scenario in one split. Keep a prospective challenge set
   private until release evaluation.
4. Re-run the deterministic route alone, model fallback alone, and combined
   route. Report per-kind and per-language exact action, exact slots,
   wrong-kind, abstain, coverage, calibration, and confusion pairs.
5. Freeze a browser harness for cold load, warm inference, failure fallback,
   offline-after-cache, and the actual shipped artifacts.

**Exit gate:** every advertised action has an end-to-end contract; golden and
held-out data are demonstrably disjoint; the baseline can be reproduced from
the pinned hashes.

### Phase 1 — Action model v2: complete supported command coverage

**Goal:** make the action model a dependable fallback for natural-language DAW
control, including effect values where the command contract supports them.

1. Fix the contract-to-code gaps from Phase 0 before expanding vocabulary.
   Add a `presetId` head only for the closed, versioned preset registry; use
   deterministic registry resolution for aliases and ask when the name is
   absent or ambiguous. Avoid learning arbitrary preset names as a closed
   classifier.
2. Decide per operation whether a closed head is enough, whether a deterministic
   resolver should fill a slot, or whether the operation belongs in a separate
   structured parser. Do not add a head solely because examples can be
   generated for it.
3. Prioritize measured failures: multi-step edits, protected/current selection,
   compound operations, indirect phrasing, colloquial English/Slovak, negation,
   ambiguous targets, and unsupported plugin controls. Add hard negatives and
   explicit clarify/abstain cases.
4. Generate synthetic examples through the real route and schema, then have
   humans review representative edge cases. Split by prompt family and source
   scenario before augmentation; translations stay with their source family.
5. Train a challenger with the current compact architecture first. Change
   vocabulary, features, loss, or architecture one at a time and keep a run
   manifest. A larger model is justified only if it improves the independent
   task score enough to pay for its browser cost.
6. Test exact slots and downstream command proposals, not just kind accuracy.
   Keep wrong-kind at zero on the registered release set. Track quality and
   coverage together so abstaining on everything cannot look successful.

**Exit gate:** independent, family-disjoint evaluation improves exact outcomes
without a wrong-kind regression; each supported action has browser inference
and safe command-resolution evidence; unsupported and ambiguous cases reliably
clarify or abstain.

### Phase 2 — Research-backed artist and style mapping

**Goal:** understand named references and genre language as an explainable,
editable profile of musical attributes, not as a promise to reproduce a song.

1. Extend the existing genre and artist research catalog. Store canonical name,
   aliases, language variants, style lanes, tempo anchors, rhythmic traits,
   instrumentation, energy, arrangement tendencies, confidence per claim,
   source URL, access date, and reviewer.
2. Keep evidence and interpretation separate. Use the existing confidence
   layers: sourced facts/anchors, engine mapping, and estimated sliders. Mark
   uncertain mappings as estimates and let explicit user constraints override
   profile defaults.
3. Describe abstract, original traits. Do not ingest or reproduce protected
   recordings, lyrics, riffs, or melodies. Record provenance and licensing for
   every data source; do not train from scraped material without a documented
   right to use it.
4. Add alias, ambiguity, multi-reference blend, explicit-override, and
   out-of-catalog evaluation cases in English and Slovak. Review mappings with
   producers familiar with the style; an artist name matching successfully is
   not proof that the generated result fits.
5. Keep the deterministic profile path as the small, always-available
   baseline. Test the optional semantic retrieval model only on unseen aliases
   and descriptions, against that baseline.

**Exit gate:** profile entries have traceable sources and confidence; the
independent artist/style set shows better attribute extraction and appropriate
clarification; explicit user constraints always win.

### Phase 3 — Creative-brief interpreter, only if the gap is real

**Goal:** turn an open-ended music brief into a typed, reviewable `IntentSpec`
without confusing it with a DAW command.

1. Establish a human-reviewed brief corpus under the existing
   [`docs/CREATIVE-TASK-HUMAN-EVALUATION.md`](CREATIVE-TASK-HUMAN-EVALUATION.md)
   protocol: affirmative purpose-specific consent, redaction, two independent
   annotations, adjudication, family-disjoint splits, and held-out exclusion
   from training.
2. Label hard constraints, soft preferences, protected roles, unavailable
   project assets, unknowns, contradictions, confidence, and whether to
   propose, clarify, or abstain. Do not treat genre stereotypes as facts.
3. Compare the current deterministic parser, artist profiles, semantic
   retrieval, and a separate compact model on the same held-out briefs. Train
   only if the model wins on useful, exact fields and clarification quality.
4. Require schema validation, range clamps, unknown-field preservation,
   project-context checks, and a human-visible proposal before generation.
5. Keep interpretation quality separate from the quality of the resulting
   audio. Evaluate the latter in Phase 5.

**Exit gate:** the model reduces meaningful interpretation errors against the
deterministic baseline on independent human-reviewed data, with acceptable
language coverage and no increase in unsupported assumptions. If it does not,
improve the parser/catalog instead of shipping another model.

### Phase 4 — Improve original composition and candidate ranking

**Goal:** make the beat candidates musically stronger and make ranking reflect
what producers actually prefer.

1. Extend drum and melodic priors using original, provenance-tracked material
   and held-out groove families. Keep deterministic seeds and the existing
   symbolic fallback. Do not claim that intent-classification accuracy proves
   musical quality.
2. Build a blinded listening protocol that compares candidates against the
   current engine and useful baselines. Collect pairwise preference, tie,
   reject, brief-fit, groove, arrangement, and artifact reports. Stratify by
   genre, language, prompt difficulty, and listener experience.
3. Replace heuristic-only ranker labels with consented human preference data.
   Split by listener, prompt family, candidate seed, and session to prevent
   near-duplicate leakage. Track inter-rater agreement and confidence
   intervals.
4. Train a ranker v2 as a challenger. Keep the current ranker and deterministic
   scoring available for shadow comparison. Promote only when blinded outcomes
   beat the registered baseline and no important slice regresses.
5. Test diversity as well as preference: the top candidates should fit the
   brief without collapsing to one groove or arrangement.

**Exit gate:** blinded evaluation shows a statistically credible preference
gain over the frozen baseline, with the target brief respected and no material
regression in diversity or a supported style slice.

### Phase 5 — Quantize the selected models and build browser model packs

**Goal:** reduce download, memory, and inference cost without silently changing
the product quality contract.

Quantization is a measured export variant, not a retraining shortcut. Preserve
the full-precision artifact, evaluate quantized output on the same exact
independent set, and ship the quantized file only when its quality and browser
behavior pass the same gates.

Retraining the same architecture can keep the FP32 model around its current
size while improving its learned boundaries, if the labels and examples expose
real gaps. That is a sensible first challenger: model size stays broadly
similar, but improvement is a hypothesis to prove on unseen prompts. INT8
quantization is a separate later step that can reduce the shipped artifact;
neither step guarantees better predictions by itself.

| Model                       | Current position                | Candidate optimization                                                                                                                               | Priority and acceptance                                                                                                                                                                              |
| --------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Action classifier           | 6.8 MB FP32 ONNX                | Export challenger as dynamic INT8 and calibrated static INT8; compare file size, browser latency, exact slots, calibration, and per-kind regressions | Highest. Aim for a materially smaller artifact (initial target ≤2.5 MB); zero wrong-kind on the release set and no material exactness/coverage regression. Keep FP32 if the browser result is worse. |
| Candidate ranker            | About 25 KB FP32 ONNX           | First improve labels and ranking evidence; benchmark quantization only if packaging or latency shows a real need                                     | Low. Model size is already negligible. Do not spend quality risk to save a few KB.                                                                                                                   |
| Symbolic priors             | Small, compact assets           | Keep existing compact/integer encodings; optimize only a measured memory or load bottleneck                                                          | Low. Preserve exact deterministic behavior and golden vectors.                                                                                                                                       |
| Multilingual semantic model | About 118–120 MB, Q8 model pack | Compare a supported Q4 export and/or a smaller multilingual encoder on held-out retrieval, artist/style coverage, memory, and cold latency           | High impact, high risk. Remains opt-in/on-demand. Never make it part of the initial studio boot download.                                                                                            |
| Future brief model          | Not selected                    | Decide after Phase 3; benchmark a compact model and its INT8 export against deterministic parsing                                                    | Conditional. No model or quantization work until the independent evaluation demonstrates value.                                                                                                      |

For each candidate, record source checkpoint/revision, export and quantization
commands, calibration data hash if used, ONNX opset, runtime version, artifact
SHA-256, exact evaluation report, browser engine, device class, cold/warm
latency, and peak memory. Never overwrite the active artifact in place; use a
versioned challenger and explicit promotion.

The official ONNX Runtime guidance treats quantization as lossy and recommends
checking model accuracy after conversion; it describes dynamic and static
quantization as separate paths and points to quantization-aware training when
post-training conversion does not retain enough accuracy. See the [ONNX Runtime
quantization guide](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html).

For the browser, keep the portable WASM path as the universal baseline.
ONNX Runtime Web documents that WebGPU, WebGL, and WebNN have narrower operator
coverage than WASM, and browser/provider support varies. Treat GPU acceleration
as a capability-tested optimization with a WASM fallback, not a requirement.
See [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) and its
[JavaScript support matrix](https://onnxruntime.ai/docs/get-started/with-javascript/web.html).

### Phase 6 — Ship and operate a first-class browser experience

**Goal:** make model value, waiting time, and fallback behavior clear to the
person using KYX.

1. Keep the action model small and available to the local action route. Load it
   in a worker, use timeouts and circuit breakers, validate every message, and
   retain deterministic fallback.
2. Keep large semantic/creative packs separately listed with version, size,
   purpose, license, checksum, progress, and remove/retry controls. Download
   only after an explicit feature action or install choice. Explain what is
   available without the pack.
3. Use browser caching for repeat sessions and verify stale-version handling,
   interrupted downloads, cache eviction, storage failure, and offline reuse.
   ONNX Runtime Web documents browser cache approaches including Cache API and
   OPFS for large model files: [large model deployment](https://onnxruntime.ai/docs/tutorials/web/large-models.html).
4. Measure first-use and cached P50/P95 response time, time-to-first-result,
   peak worker/main-thread memory, bytes downloaded, and failure/fallback
   rates on representative devices. Measure on Chromium, Firefox, and Safari
   where the shipped feature is supported; include low-memory and
   `saveData`-like conditions.
5. Verify that the UI remains responsive during load/inference and that no
   model inference runs inside the audio callback. Browser thread behavior and
   WebGPU support are environment-dependent; ONNX Runtime notes that WASM
   multithreading requires cross-origin isolation. See its
   [performance diagnosis guide](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html).
6. Add opt-in, privacy-reviewed feedback for bad interpretations and preferred
   candidates. Default to local handling and user-initiated export. Never
   silently upload prompts, project contents, audio, or model traces.

**Exit gate:** the feature works with no network after required assets are
cached; first-time download and storage use are visible; optional-pack failure
does not block the DAW; browser performance gates pass on the declared device
matrix.

## 6. Training and release discipline

### Dataset rules

- Store generated examples through the owning generator. Do not hand-edit
  generated JSONL or labels in place.
- Keep source intent, expected typed output, language, family, split,
  provenance, consent purpose where applicable, and schema version traceable.
- Deduplicate normalized prompts and paraphrase families before splitting.
  Never move a seen validation or held-out example into training after reading
  model errors.
- Balance by meaningful task and failure mode, not only by row count. Measure
  per-kind and per-language performance before oversampling long-tail labels.
- Treat synthetic data as coverage scaffolding, not proof of real-world
  generalization. Add reviewed challenge cases and real consented data where
  the product needs them.
- Keep prompt text, audio, MIDI, project data, and derived user preferences
  under explicit provenance, retention, and consent rules. Do not collect
  production projects as a side effect of model usage.

### Model release checklist

1. **Contract:** feature version, fields, enums, decoder, runtime and fallback
   match the documented schema.
2. **Data:** pinned hashes, family-disjoint splits, deduplication, provenance,
   and consent checks pass.
3. **Quality:** exact task outputs, slots, coverage, abstentions, wrong-kind,
   confidence calibration, and per-language/per-task slices are reported.
4. **Sound:** where output affects generation or ranking, blinded listener
   results are reported separately from parser metrics.
5. **Browser:** real ONNX inference, worker failures, timeouts, cold/warm
   latency, memory, download, cache, and offline behavior are recorded.
6. **Artifact:** model and manifest hashes are pinned; versioned challenger is
   promoted explicitly; previous model remains a rollback target.
7. **Product:** unsupported actions clarify or abstain; proposals remain
   reviewable, undoable, and deterministic where promised.

## 7. What not to optimize yet

- Do not retrain the 6.8 MB action model just to keep roughly the same file
  size. First fix capability gaps and evaluation leakage, then compare a
  trained challenger against a valid holdout.
- Do not train the action classifier on artist or open-ended composition
  prompts. Those are different tasks with different labels and should use the
  profile/brief pipeline.
- Do not quantize the tiny ranker before collecting valid preference labels.
- Do not auto-download the ~120 MB semantic model on the first browser visit.
  It needs an explicit pack decision based on measured task value and real
  device performance.
- Do not use aggregate accuracy, training loss, validation attempted-exact,
  synthetic golden overlap, or a smaller file as a standalone release claim.
- Do not let a model emit arbitrary project JSON or bypass command validation,
  undo, preview, audio-thread, or deterministic fallback boundaries.

## 8. Recommended implementation start — browser action ONNX v2

The long-term ambition is a world-class browser intent engine, with the
action ONNX as the first model to improve because it already sits on the
browser control path. Keep the scope of its first upgrade measurable: produce
the right supported operation and slots, then hand a validated proposal to
the existing command flow. This is not a plan to put every creative brief,
artist reference, or music-quality decision into one classifier.

For the first implementation pass, keep the current model and architecture as
the control. The first deliverable is a reproducible, independent evaluation
set plus the schema-to-executor capability matrix; training comes after those
are usable. Then train one FP32 challenger on failure-mined, reviewed data. A
similar-size retrain is a valid outcome if it materially improves independent
results. Compare INT8 exports only after the FP32 challenger passes. Do not
change the candidate ranker, semantic model pack, or generator in the same
upgrade; they need separate evidence and release gates.

Start the engineering work in this order:

1. Rebuild the reproducible action-model baseline and a genuinely independent,
   family-disjoint challenge set; publish exactness, coverage, abstention, and
   wrong-kind by operation and language.
2. Produce the command capability matrix and close the `presetId`/slot and
   operation/head/decoder mismatches that the audit confirms.
3. Train an action-model challenger on failure-mined, reviewed examples while
   keeping the current architecture and FP32 artifact as the control.
4. Quantize the challenger to INT8 only after its FP32 quality gate passes;
   compare dynamic and calibrated static exports in the browser.
5. In parallel, continue source-backed artist/style research through
   [`docs/GENRE-RESEARCH.md`](GENRE-RESEARCH.md) and evaluate each new profile
   against held-out references.
6. Use separate human-reviewed brief and listening studies to decide whether
   a creative-brief model or a ranker retrain has enough evidence to begin.

## 9. Related implementation documents

- [`INTENT_ENGINE.md`](../INTENT_ENGINE.md) — intent system overview and
  architecture.
- [`docs/intent-engine-roadmap.md`](intent-engine-roadmap.md) — composition
  pipeline and generation implementation roadmap.
- [`docs/LOCAL-INTENT-MODEL.md`](LOCAL-INTENT-MODEL.md) — local model runtime,
  training and evaluation details.
- [`docs/intent-engine-ai-ranker-goal.md`](intent-engine-ai-ranker-goal.md) —
  feature extractor and ranker implementation notes.
- [`docs/GENRE-RESEARCH.md`](GENRE-RESEARCH.md) — sourced genre catalog and
  research protocol.
- [`docs/CREATIVE-TASK-HUMAN-EVALUATION.md`](CREATIVE-TASK-HUMAN-EVALUATION.md)
  — consent, annotation, split and human-corpus protocol.
- [`docs/intent-artists-and-revise-plan.md`](intent-artists-and-revise-plan.md)
  — artist references and revise intent history.
