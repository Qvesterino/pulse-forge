# AAW_EVALUATION_BENCHMARKS

**Status:** the benchmark suite that decides whether an AI-Assisted Audio Workstation feature is real
**Date:** 2026-10-25
**Companions:** `AAW_TRAINING_AND_DATA_STRATEGY.md`, `AAW_EXPERIMENT_BACKLOG.md`, `AAW_SECURITY_AND_REALTIME_SAFETY.md`

---

## 0. The principle

> **A capability is not "AI-assisted" because a model was involved. It is AI-assisted when it
> produces a measurable improvement over the deterministic baseline, at an acceptable latency, with
> an acceptable failure rate, that a musician actually wants.**

Three rules follow, and they are the difference between a benchmark suite and a demo:

1. **Every benchmark has a baseline.** A number without a baseline is a feeling.
2. **Automatically measurable properties and subjective listening are never mixed.** The first are
   regression gates; the second are release gates with humans and a protocol.
3. **Negative results are recorded, not buried.** A suite that only ever reports wins is a
   marketing document. This repository already keeps such a record
   (`scripts/data/creative-task-sft/README.md` — a failed adapter, kept in the tree with its
   diagnosis).

---

## 1. Suite overview

| Suite | What it measures                                   | Type                 | Runs in CI?                | Release gate? |
| ----- | -------------------------------------------------- | -------------------- | -------------------------- | ------------- |
| **A** | Command grounding & correct tool selection         | auto                 | ✅                         | ✅            |
| **B** | Musical intent interpretation & ambiguity handling | auto + human         | ✅ (auto) / manual (human) | ✅ (both)     |
| **C** | State correctness & invariant preservation         | auto                 | ✅                         | ✅            |
| **D** | Audible result quality                             | blinded listening    | manual                     | ✅            |
| **E** | Timing/groove preservation & vocal intelligibility | auto (objective)     | ✅                         | ✅            |
| **F** | Preview-to-commit consistency                      | auto                 | ✅                         | ✅            |
| **G** | Undo/redo & crash recovery                         | auto                 | ✅                         | ✅            |
| **H** | Latency & resource budgets                         | auto                 | ✅                         | ✅            |
| **I** | Live stability under adverse conditions            | auto                 | ✅                         | ✅            |
| **J** | User trust, creativity, workflow time saved        | instrumented + human | manual                     | ✅ (J-2 only) |

---

## 2. Suite A — Command grounding and correct tool selection

**Question:** given a brief and a project state, does the system choose the right capability, with
the right arguments, and refuse when it should?

| Metric                          | Definition                                                                | Baseline                     | Threshold                                  |
| ------------------------------- | ------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| **A-1 Tool selection accuracy** | % of briefs where the chosen capability is the human-labelled correct one | deterministic provider alone | ≥ 95 % on the golden set (R1 capabilities) |
| **A-2 Argument exactness**      | % of steps whose arguments match the human-labelled arguments exactly     | deterministic provider alone | ≥ 85 %; ≥ 60 % on freeform parameters      |
| **A-3 Abstention precision**    | % of abstentions that a human agrees were genuinely ambiguous             | —                            | ≥ 70 % (over-abstention is a failure too)  |
| **A-4 Abstention recall**       | % of genuinely ambiguous briefs that were abstained on                    | —                            | ≥ 80 %                                     |
| **A-5 Illegal capability rate** | % of generated steps naming a capability not in the registry              | 0 (must be)                  | **0**                                      |
| **A-6 Unknown-argument rate**   | % of steps with arguments outside the capability's input schema           | 0 (must be)                  | **0**                                      |

**Adversarial cases (must be present in the golden set):**

- a brief whose correct answer is "no capability exists for this" → must abstain, not improvise;
- a brief naming two mutually protected objects → must ask one concise question;
- a brief with a typo'd role name → must map or refuse, never guess;
- a brief that is only satisfiable by an R3 capability → must not auto-apply.

**Baseline comparison:** every AI number is reported **beside** the deterministic provider's number
on the same set. The repo already has a deterministic provider path and a golden set
(`scripts/data/creative-task-v1-golden.jsonl`, `scripts/data/intent-sft/golden.jsonl`), so this
comparison is cheap.

---

## 3. Suite B — Musical intent interpretation and ambiguity handling

**Question:** does the system understand what was _meant_, and does it know when it does not?

| Metric                           | Definition                                                                 | Threshold                                   |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| **B-1 Clause extraction F1**     | precision/recall of required/preserve/prefer/avoid clauses vs human labels | ≥ 0.85 / 0.80 (auto)                        |
| **B-2 Protected-object recall**  | % of "preserve" clauses correctly turned into protected scopes             | **100 %** (a missed protect is a scope bug) |
| **B-3 Ambiguity surfacing rate** | % of briefs with ≥ 2 defensible readings where alternatives were offered   | ≥ 90 % (human-labelled)                     |
| **B-4 Language coverage**        | % of the Slovak golden briefs handled at least as well as English          | **parity** (≤ 2 points behind)              |

**The repo's Slovak corpus is an asset here:** `intent-sft` v17 already carries **686 Slovak** and
1,932 English examples. Suite B must report the two languages **separately** — an aggregate number
hides the failure mode that matters most.

**Human part:** for a sample of ≥ 30 briefs, a producer answers one question: _"Did the system
understand what I asked?"_ (yes / partly / no) and _"Did the alternatives reflect real musical
choices?"_ Thresholds: ≥ 85 % "yes or partly", and ≥ 60 % of "partly" must resolve after one
clarification.

---

## 4. Suite C — State correctness and invariant preservation

**Question:** did the system change exactly what it said it would change, and nothing else?

| Metric                              | Definition                                                         | Threshold |
| ----------------------------------- | ------------------------------------------------------------------ | --------- |
| **C-1 Scope fidelity**              | % of applied transactions whose actual diff ⊆ declared scope       | **100 %** |
| **C-2 Protected-content integrity** | % of transactions where protected object hashes are unchanged      | **100 %** |
| **C-3 Schema integrity**            | post-state passes the project schema validator                     | **100 %** |
| **C-4 Invariant set**               | % of transactions passing the full invariant register              | **100 %** |
| **C-5 Declared-vs-actual parity**   | % of transactions where the receipt's diff matches the actual diff | **100 %** |
| **C-6 No-orphan state**             | no transaction leaves dangling references                          | **100 %** |

**Every one of these is 100 %.** They are not "quality metrics"; they are correctness. A feature that
fails C-1 even once on the golden set does not ship.

---

## 5. Suite D — Audible result quality (blinded listening)

**Question:** do people prefer the result?

**Protocol** (per `AAW_TRAINING_AND_DATA_STRATEGY.md` §6): pairwise, blinded, original included as
an unlabeled arm, ≥ 30 pairs per claim (≥ 100 for a release-gating claim), CI reported, failure
cases published. **A panel of 2 produces a DIRECTIONAL read only — it may cancel a capability, never
certify one** (D-22).

| Metric                               | Threshold                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| **D-1 Win rate vs original**         | ≥ 60 % pairwise win **and** ≥ 15 points above the baseline variant's win rate |
| **D-2 Win rate vs baseline feature** | ≥ 60 % pairwise win, CI lower bound > 50 %                                    |
| **D-3 Tie rate**                     | ≤ 25 % (a high tie rate means "no perceptible difference")                    |
| **D-4 Identity preservation**        | for vocal: ≤ 5 % of listeners report a change in vocal identity               |
| **D-5 Expert agreement**             | the expert panel's preference direction agrees with the aggregate             |

**A claim below 60 % is reported as a FAILURE.** The suite's output is a number, not a story.

---

## 6. Suite E — Timing, groove preservation, vocal intelligibility

**Question:** did the musical _time_ survive the edit? This is where most AI edits fail silently.

| Metric                              | Definition                                                               | Threshold                        |
| ----------------------------------- | ------------------------------------------------------------------------ | -------------------------------- |
| **E-1 Grid preservation**           | % of notes whose absolute tick is unchanged (when not explicitly edited) | **100 %**                        |
| **E-2 Swing preservation**          | swing ratio delta outside edited regions                                 | ≤ 0.5 %                          |
| **E-3 Velocity-curve preservation** | correlation of untouched velocity curves                                 | ≥ 0.99                           |
| **E-4 Groove stability**            | onset-time deviation (median / p95) vs original, in ms                   | median ≤ 2 ms, p95 ≤ 8 ms        |
| **E-5 Section-boundary integrity**  | no clip boundary moved unless declared                                   | **100 %**                        |
| **E-6 Vocal intelligibility**       | objective proxy (e.g. ASR WER on the processed vocal vs the dry vocal)   | WER increase ≤ 5 points absolute |
| **E-7 Tempo-lock**                  | % of projects where a non-musical edit left the tempo map untouched      | **100 %**                        |

**E-1 and E-3 are the ones the repo can already assert mechanically** and should be the first
regression gates built, because they are cheap, exact, and catch the most damaging AI edits.

---

## 7. Suite F — Preview-to-commit consistency

**Question:** is what you heard what you got?

| Metric                      | Definition                                                                                | Threshold                   |
| --------------------------- | ----------------------------------------------------------------------------------------- | --------------------------- |
| **F-1 Plan identity**       | committed plan id == previewed plan id                                                    | **100 %**                   |
| **F-2 Stale rejection**     | commits against a changed revision are refused                                            | **100 %**                   |
| **F-3 Audio identity**      | the committed render is byte-identical to the previewed render (same engine, same inputs) | **100 %**                   |
| **F-4 Structural identity** | the committed diff == the previewed diff                                                  | **100 %**                   |
| **F-5 Metric parity**       | post-commit measured metrics match the preview's to within tolerance                      | ≤ 0.1 dB / ≤ 0.5 % relative |

---

## 8. Suite G — Undo/redo and crash recovery

| Metric                    | Definition                                                                       | Threshold                 |
| ------------------------- | -------------------------------------------------------------------------------- | ------------------------- |
| **G-1 Undo completeness** | one undo restores the pre-proposal state exactly (hash comparison)               | **100 %** of capabilities |
| **G-2 Undo granularity**  | one proposal = one undo unit                                                     | **100 %**                 |
| **G-3 Redo symmetry**     | redo reproduces the applied state exactly                                        | **100 %**                 |
| **G-4 Undo after crash**  | state after a crash + undo == state before the proposal                          | **100 %**                 |
| **G-5 Recovery**          | kill during save → recoverable session, no silent data loss                      | **100 %**                 |
| **G-6 Undo availability** | an applied AI proposal's undo entry is discoverable in the UI and in the receipt | **100 %**                 |

---

## 9. Suite H — Latency and resource budgets

**Question:** does the feature fit a musician's attention span and a developer's machine?

| Tier                     | Interaction                                        | Budget                                                                               | Measured by           |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------- |
| **H-1 Instant**          | parameter-level suggestion, selection-aware action | ≤ 100 ms                                                                             | in-app timer          |
| **H-2 Quick**            | brief → typed plan (no render)                     | ≤ 2 s                                                                                | in-app timer          |
| **H-3 Preview**          | brief → offline preview audio                      | ≤ 8 s for a 30 s region; ≤ 20 s for a full project                                   | render timer          |
| **H-4 Apply**            | commit                                             | ≤ 500 ms                                                                             | command-gateway timer |
| **H-5 Verify**           | post-commit verification                           | ≤ 2 s                                                                                | verifier timer        |
| **H-6 Model cold start** | first inference after app launch                   | ≤ 8 s (text) / ≤ 20 s (audio model, if opted in)                                     | model-manager timer   |
| **H-7 Memory**           | added RAM per enabled AI feature                   | ≤ 1.5 GB for the text path; audio model is a **separate, opt-in, explicit** download | process memory        |

**Reference points already in the repo:** the deterministic taste benchmark records **13–104 ms**
per prompt (`scripts/data/taste-benchmark.baseline.json`). Any AI path that is _slower than the
deterministic path_ for the same interaction is a candidate for rejection on latency grounds alone —
this is the red-team question "what if tool orchestration is slower than manual editing?" answered
with a number instead of an opinion.

---

## 10. Suite I — Live stability under adverse conditions (ZYVO)

| Scenario                    | Test                                                                  | Threshold                                                                                     |
| --------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **I-1 Worker death**        | kill the inference worker mid-session                                 | audio continues; parameters hold last value; **zero** glitch samples in the capture           |
| **I-2 Model timeout**       | force a 30 s model timeout                                            | audio unaffected; the feature degrades to advisory                                            |
| **I-3 Mic dropout**         | unplug / mute the input                                               | no runaway gain; silence or last-safe state; **zero** NaN samples                             |
| **I-4 Stage noise**         | play broadband noise at show level                                    | no automatic scene change; no parameter jump beyond the envelope                              |
| **I-5 Wrong prediction**    | force a deliberately wrong cue prediction                             | the scene does **not** change automatically; the suggestion is visible and dismissible        |
| **I-6 Resource exhaustion** | fill the disk / starve the CPU                                        | the show profile keeps running; the show path is pre-warmed and deprioritises everything else |
| **I-7 Latency**             | measure input-to-monitor latency with the AI path enabled vs disabled | delta ≤ 2 ms (the AI path must not sit in the monitor chain)                                  |

**Zero-tolerance items:** I-1, I-3 and I-5 are **zero-tolerance**. A single NaN sample or a single
automatic scene change on a wrong prediction is a release blocker.

---

## 11. Suite J — User trust, creativity, and time saved

| Metric                       | Method                                                                           | Threshold                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **J-1 Workflow time saved**  | task-time comparison (same task, AI on vs off), ≥ 10 users, ≥ 5 tasks            | ≥ 20 % median reduction **on tasks the feature targets**; and no task slower by > 10 % |
| **J-2 Creativity preserved** | blinded expert panel: does the output still sound like _this_ producer?          | ≥ 70 % "yes"                                                                           |
| **J-3 Rejection rate**       | % of proposals rejected by the user                                              | ≤ 40 % (a high rate means the feature is noise)                                        |
| **J-4 Approval latency**     | time from proposal to decision                                                   | ≤ 8 s (the user is reading, not evaluating)                                            |
| **J-5 Trust after error**    | after one deliberately wrong proposal, % of users who continue using the feature | ≥ 80 %                                                                                 |
| **J-6 Undo usage**           | % of accepted proposals later undone                                             | ≤ 15 % (a high rate means the feature misreads intent)                                 |

**J-3, J-5 and J-6 are the metrics that catch "the AI hurts flow and autonomy"** — and they are the
ones most likely to be quietly omitted. They are therefore release gates, not nice-to-haves.

---

## 12. Failure budgets (per feature, per release)

A feature may not exceed these; exceeding any one is a stop.

| Category                                     | Budget                       |
| -------------------------------------------- | ---------------------------- |
| Illegal capability invocation                | **0**                        |
| Scope violation                              | **0**                        |
| Protected-content modification               | **0**                        |
| Stale commit                                 | **0**                        |
| Preview ≠ commit                             | **0**                        |
| Undo incompleteness                          | **0**                        |
| Abstention on an unambiguous request         | ≤ 5 %                        |
| Wrong-but-applied change (R1, auto-approved) | ≤ 0.5 % of applications      |
| Model-caused audio artefact (measured)       | ≤ 0.1 % of previewed renders |
| Show-mode automatic scene change             | **0**                        |

---

## 13. Stop/go criteria for an AI capability

A capability is **GO** when:

- it beats the deterministic baseline on its suite by the stated margin, with a CI that excludes the
  baseline;
- it meets its latency budget at p95 on the reference machine;
- it passes C-1..C-6 at 100 %;
- it has a deterministic fallback of equal scope;
- its failure mode is bounded and visible (no silent wrongness).

A capability is **NO-GO** when any of these hold:

- the win rate is below 60 % in blinded listening;
- the deterministic baseline is within noise of it (then the baseline wins on cost, always);
- it can only be evaluated by schema validity (see `AAW_TRAINING_AND_DATA_STRATEGY.md` §3);
- it requires a model that cannot be removed without breaking the product;
- its failure mode is silence or wrongness the user cannot see.

---

## 14. How the suite runs

| Layer                              | Where                                                                                                     | When                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Fast regression (A, C, F, G, H, I) | vitest + Playwright, in CI                                                                                | every commit                        |
| Golden evaluation (A, B, E)        | pinned JSONL golden sets + deterministic runners                                                          | nightly, and on any model-pack bump |
| Listening (D, J-2, J-3)            | manual protocol, recorded verdicts ingested via the existing `scripts/ingest-listening-verdicts.mjs` path | release candidate                   |
| Adversarial + injection corpus     | dedicated spec                                                                                            | every commit                        |
| Live stability (I)                 | desktop-only harness, manual trigger                                                                      | release candidate                   |

**Model-pack changes trigger a full re-run.** The suite is versioned alongside the provider
contract, so a model bump cannot silently change a score.

---

## 15. Negative results registry (the part everyone skips)

The repository's own negative result is the template:

| Experiment                                      | Result                                                                                                         | Status                | Where                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------- |
| Creative-task LoRA on a 32-row synthetic corpus | 25/32 schema passes; **0/24 creative proposals accepted** (17 abstentions, 7 rejected); not promotion-eligible | **recorded, closed**  | `scripts/data/creative-task-sft/README.md`   |
| Embedding v1 → v3 pair-distance tests           | v1 failed mood pairs (distance 0); v3 passes mood + style pairs → `RECOMMEND-ON`                               | recorded, **shipped** | `scripts/data/embedding-ab-report.json`      |
| Learned intent ranker                           | `rankerSource: "fallback"` — the deterministic fit score is still the active path                              | **open, unpromoted**  | `scripts/data/taste-benchmark.baseline.json` |

**Every future experiment adds a row here — successes and failures alike.** A programme that only
accumulates successes is not measuring; it is collecting ammunition.
