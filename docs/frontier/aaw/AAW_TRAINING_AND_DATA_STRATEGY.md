# AAW_TRAINING_AND_DATA_STRATEGY

**Status:** build-vs-buy-vs-train decisions, consent, data provenance, and the economics of a one-person ML program
**Date:** 2026-10-25
**Applies to:** KYX (`D:\pulse-forge`) primarily; ZYVO (`D:\VocalForge_DAW`) for voice data
**Companions:** `AAW_AUDIO_MODEL_LANDSCAPE.md`, `AAW_EVALUATION_BENCHMARKS.md`, `AAW_SECURITY_AND_REALTIME_SAFETY.md`

---

## 0. The headline

> **As of 2026-10-25, no training is justified anywhere in this program.** Every capability in the
> frontier roadmap is reachable with deterministic DSP/MIR, retrieval over embeddings, tool
> orchestration, and the models the repo already pins. Training becomes justified only by a
> **measured, held-out, reproducible baseline failure** — and the repo already contains a textbook
> example of what happens when that gate is skipped.

**The gate:** _no training without a published baseline failure._ Not "we think a model would do
better". Not "the demo looked nicer". A failure table, on a held-out split, with the failing cases
enumerated.

---

## 1. What KYX already has (measured, in-repo)

This is the baseline every future proposal must beat. Sourced from the repository, 2026-10-25.

| Asset                                      | Evidence                                                                      | What it is                                                                                                                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Intent SFT corpus, v17**                 | `scripts/data/intent-sft/manifest.json`                                       | 2,618 examples: 2,244 train / 374 val / **77 golden**; **686 Slovak + 1,932 English**; 26 intent kinds; 2,580 deterministic + 38 reviewed-residual                                                                                                 |
| **A working LoRA SFT pipeline**            | `scripts/data/intent-sft/sft-report.json`                                     | LoRA r=16, α=32, lr 2e-5, 1 epoch, eff. batch 16, seq 1280 → **exact 45/60 (75 %), kind 60/60 (100 %)** on val                                                                                                                                     |
| **A failed creative-task SFT, documented** | `scripts/data/creative-task-sft/README.md`                                    | Adapter passed 25/32 schema checks but **all 24 expected creative proposals failed** (17 abstentions, 7 rejected). Not promotion-eligible, must not be routed                                                                                      |
| **Leakage discipline already enforced**    | same README                                                                   | Golden set is never a training source; exact prompt/ID overlap **and family-disjoint splits** are checked; synthetic rows carry `synthetic: true`, `humanReviewed: false`, `eligibleForModelPromotion: false`; no automatic merge/import/promotion |
| **A legally clean MIDI corpus**            | `scripts/data/midi-corpus/`                                                   | Mutopia (public-domain classical MIDI), locally vendored with a manifest                                                                                                                                                                           |
| **Embedding retrieval, validated**         | `scripts/data/embedding-ab-report.json`                                       | embedding **v3** passes both mood-only and style-varying pair-distance tests → `functional: true`, `verdict: "RECOMMEND-ON"`                                                                                                                       |
| **A determinism + latency harness**        | `scripts/data/taste-benchmark.baseline.json` (2026-10-17)                     | Per-row checks (accepted/genre/candidates/deterministic/rationale), `selectedHash === secondRunHash` determinism proof, 13–104 ms per prompt, `rankerSource: "fallback"` — **the learned ranker is not yet active**                                |
| **A listening-verdict pipeline**           | `scripts/ingest-listening-verdicts.mjs`, `scripts/render-morph-listening.mjs` | Human listening verdicts are already ingested as structured data                                                                                                                                                                                   |
| **Model-gated runtime discipline**         | `docs/AI-PRODUCER-CONTRACT.md` §5                                             | Providers are optional and removable; the product is complete without them; weights are a versioned, integrity-checked pack                                                                                                                        |

**Read together, this is a mature small-scale ML program with a mature sense of its own limits.** The
frontier plan should _extend_ it, not restart it.

---

## 2. The decision tree — seven rungs, in order

```
                                        ┌──────────────────────────────────────┐
                                        │ Q0. Is there a measured failure?     │── no ──▶ stop. Not a training problem.
                                        │     (held-out, reproducible, table)  │
                                        └───────────────┬──────────────────────┘
                                                        │ yes
                                        ▼
                        ┌───────────────────────────────────────────────────────┐
                        │ Q1. Is the failure a LABEL/SPEC problem rather than    │── yes ──▶ fix labels, spec,
                        │     a capability problem?                              │          retrieval, prompts
                        └───────────────┬───────────────────────────────────────┘
                                        │ no
                                        ▼
             ┌──────────────────────────────────────────────────────────────┐
             │ Q2. Can a competent engineer write a deterministic algorithm   │── yes ──▶ WRITE IT. A model is a
             │     that solves it in < 2 weeks and is more reliable?           │          liability here.
             └───────────────┬──────────────────────────────────────────────┘
                             │ no
                             ▼
        ┌────────────────────────────────────────────────────────────────────┐
        │ Q3. Does an EXISTING open model fail on a held-out slice by a      │── no ──▶ stop. The model is good
        │     publishable margin?                                           │          enough; ship it.
        └───────────────┬────────────────────────────────────────────────────┘
                        │ yes
                        ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ Q4. Is the task narrow, high-value, stable, and label-cheap?            │── no ──▶ prefer retrieval +
   │                                                                          │          explicit user preference
   └───────────────┬──────────────────────────────────────────────────────────┘
                   │ yes
                   ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ Q5. Would a small task-specific model (classifier / ranker / adapter)   │── yes ──▶ RUNG 5: small model
   │     beat the zero-shot baseline on the held-out slice?                  │          (cheap, replaceable)
   └───────────────┬──────────────────────────────────────────────────────────┘
                   │ no
                   ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ Q6. Would fine-tuning an existing audio/text foundation model beat the   │── yes ──▶ RUNG 6: LoRA
   │     small model by a publishable margin, on the same split?             │          (expensive, licence-bound)
   └───────────────┬──────────────────────────────────────────────────────────┘
                   │ no
                   ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ Q7. Extraordinary justification? (unique dataset nobody else has + a     │── yes ──▶ RUNG 7: from scratch
   │     published baseline failure + a named scientific claim)              │          (research project, not a
   └──────────────────────────────────────────────────────────────────────────┘                 product plan)
```

**Rungs and their economics for a one-person team:**

| Rung                                                    | Typical cost         | Time   | Ongoing maintenance                     | Replacement risk | Recommended?                         |
| ------------------------------------------------------- | -------------------- | ------ | --------------------------------------- | ---------------- | ------------------------------------ |
| **0–2** Deterministic DSP / MIR / algorithm             | days–weeks           | low    | low (code maintenance)                  | none             | **Default. Use first, always.**      |
| **3** Existing open model, zero-shot                    | 0 licensing (mostly) | hours  | low (dependency drift)                  | medium           | **Default. Use early.**              |
| **4** Prompt / tool orchestration + structured context  | days                 | low    | medium (prompt drift)                   | low              | **Default. Cheap capability.**       |
| **5** Retrieval + explicit preference memory            | days–weeks           | medium | medium                                  | none             | **Default for "taste".**             |
| **6** Small task-specific classifier / ranker / adapter | hours–days of GPU    | low    | medium                                  | low              | **Only after a measured failure.**   |
| **7** Fine-tune an audio/text foundation model          | days of GPU          | medium | **high** (rebase on every base release) | medium           | **Rarely. Justify every time.**      |
| **8** Train from scratch                                | weeks of GPU         | high   | very high                               | n/a              | **Essentially never for a product.** |

---

## 3. The lesson from the repo's own failed experiment (read this before proposing any training)

`scripts/data/creative-task-sft/README.md` records, in the repo's own words, a LoRA run on the pinned
`LiquidAI/LFM2.5-1.2B-Instruct` snapshot over a **32-row synthetic train split**:

- The adapter **passed 25/32** schema/context checks — the _format_ learning worked.
- **All 24 expected creative proposals failed**: 17 abstentions, 7 rejected proposals.
- Its four "exact matches" were **out-of-scope abstentions** — i.e. wrong in the safe direction.
- Verdict: **not promotion-eligible, must not be routed in the UI.**

**What this teaches, precisely:**

1. **Format learning and musical learning are different problems.** The adapter learned the output
   contract perfectly and learned nothing about producing a creative proposal. A schema-valid metric
   is a _proxy_ for nothing the user cares about.
2. **Synthetic corpora cannot teach creative judgement.** 32 rows authored by the same person who
   wrote the prompt template contain no signal a 1.2B model can generalise from.
3. **Abstention is a real behaviour to measure** — and 17/32 abstentions on creative requests is the
   model correctly refusing to guess, or the model failing to recognise a creative request at all.
   Either way, it is a **diagnosis to run**, not a metric to optimise.
4. **The repo's refusal to promote it is the correct behaviour and should be preserved.** Any frontier
   plan that re-introduces "train on a synthetic corpus and ship it" is re-litigating a decision the
   project already made correctly.

**Therefore: any proposal in this program that trains on synthetic data and measures schema validity
is, by the repo's own precedent, predicted to fail.**

---

## 4. Candidate training projects — ranked, each with a trigger

None of these is approved. Each becomes live only when its **trigger** is met.

### T-1 — Slovak lyric/phrase ASR adaptation _(trigger: E-02 shows Whisper degrades on sung Slovak)_

| Field                      | Specification                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**                | Measured: Whisper-large-v3-turbo WER on sung Slovak > 15 % on a held-out set of 20 minutes of licensed Slovak vocal recordings, while read-Slovak WER < 8 %                     |
| **Objective**              | Fine-tune an ASR model (Whisper-family adapter, or `LFM2.5-Audio` ASR fine-tune via `liquid-audio` v1.2.0) for sung, accented, noisy Slovak                                     |
| **Labels**                 | Forced-alignment + manual correction by a native Slovak speaker; 100 % human-reviewed (the repo's existing gate: `humanReviewed: false` rows are never trainable)               |
| **Legal sources**          | Only performer-owned recordings with an explicit, revocable grant; public-domain Slovak corpora if any exist (**not verified — must be checked**)                               |
| **Leakage prevention**     | Split by **artist and song**, never by utterance; the repo's existing family-disjoint + exact-overlap checks apply; no row from the listening-verdict corpus may enter training |
| **Offline metrics**        | WER/CER on held-out artist-disjoint split; per-difficulty strata (studio / noisy room / live room)                                                                              |
| **Human protocol**         | Not a listening test — an **orthographic transcription** protocol, double-annotated, with inter-annotator agreement reported                                                    |
| **Hardware / time / cost** | 8–16 GB VRAM, 2–6 GPU-hours for an adapter on a 1–2B model; negligible cloud cost if local                                                                                      |
| **Exit criteria**          | ≥ 30 % relative WER reduction vs the Whisper baseline on the held-out split, **with no regression on English**                                                                  |
| **Kill criteria**          | < 15 % relative reduction after two adapter configurations → stop; use the baseline                                                                                             |
| **Why this one first**     | It is the only candidate where the _absence_ is measurable, the labels are cheap, and the win is objectively verifiable                                                         |

### T-2 — Intent ranker activation _(trigger: the deterministic ranker leaves measurable headroom)_

| Field                      | Specification                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**                | `taste-benchmark.baseline.json` shows `rankerSource: "fallback"` and the deterministic fit score's margin over the runner-up is thin (e.g. +0.005 — which the baseline literally reports) → candidates are frequently ambiguous |
| **Objective**              | A small ranker over candidate plans/samples, trained on **explicit** preference signals                                                                                                                                         |
| **Labels**                 | Only **explicit** user signals: "I chose B over A" on an A/B pair, or a starred selection. **Never** implicit edits, never "kept the default"                                                                                   |
| **Legal sources**          | The user's own opt-in signals, stored locally with provenance (see §5)                                                                                                                                                          |
| **Leakage prevention**     | Signals are split by project and by user; a signal from project A never appears in training for project B                                                                                                                       |
| **Offline metrics**        | Top-1 agreement with the user's explicit choice on a held-out A/B set; NDCG@4 over candidates                                                                                                                                   |
| **Human protocol**         | Blinded A/B: the model never sees which variant the user preferred before predicting it                                                                                                                                         |
| **Hardware / time / cost** | CPU-trainable ONNX head over existing embeddings; hours, not days                                                                                                                                                               |
| **Exit criteria**          | Top-1 agreement ≥ 65 % on a held-out explicit-preference set **and** no regression in the deterministic path                                                                                                                    |
| **Kill criteria**          | < 55 % agreement → the preference signal is too sparse or too noisy to learn; keep retrieval                                                                                                                                    |
| **Note**                   | The infrastructure (`intent-ranker-dataset.json`, `intent-ranker-golden.json`, `scripts/activate-intent-ranker.mjs`) **already exists** — this is activation, not invention                                                     |

### T-3 — Perceptual embedding improvement for timbral search _(trigger: embedding v3 fails a real retrieval task)_

| Field                      | Specification                                                                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**                | Embedding v3 (`RECOMMEND-ON` on the current pair tests) **fails** a task-level retrieval benchmark: given a text prompt, the correct sample is not in the top-k for ≥ 20 % of a 100-prompt set |
| **Objective**              | A LoRA/adapter on the existing embedding model, or a distillation into a smaller embedding for the browser                                                                                     |
| **Labels**                 | Human relevance judgements on (text, sample) pairs — cheap, but must be collected with the A/B protocol already in `scripts/ingest-listening-verdicts.mjs`                                     |
| **Legal sources**          | The repo's own factory/curated library (already licensed); Mutopia MIDI corpus for symbolic priors                                                                                             |
| **Leakage prevention**     | Split by **sample family** (a kit's variants stay on one side of the split)                                                                                                                    |
| **Offline metrics**        | Recall@k, MRR against human relevance judgements                                                                                                                                               |
| **Hardware / time / cost** | 8–16 GB VRAM, 1–4 GPU-hours for an adapter; or CPU-only distillation                                                                                                                           |
| **Exit criteria**          | Recall@5 ≥ +15 % absolute over v3 on the held-out set, with **no regression** on the existing mood/style pair tests                                                                            |
| **Kill criteria**          | < +5 % absolute → ship v3; the gap is not in the embedding                                                                                                                                     |

### T-4 — Perceived-tension / musical-affect estimator _(trigger: E-07 shows no DSP feature correlates)_

| Field                                                 | Specification                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**                                           | A **blinded human study** shows that no combination of existing DSP/MIR features (spectral flux, onset density, harmonic density, loudness range, dynamic range, register spread) separates "more tense" from "less tense" at better than chance on a paired set |
| **Objective**                                         | A small regressor over audio features predicting a human tension rating                                                                                                                                                                                          |
| **Labels**                                            | Paired human ratings (forced choice + 1–7 scale) on the repo's own rendered variants — this is a _listening_ dataset and must be gathered with the blind protocol in §6                                                                                          |
| **Legal sources**                                     | The repo's own renders                                                                                                                                                                                                                                           |
| **Leakage prevention**                                | Split by **source project**, never by rendered clip                                                                                                                                                                                                              |
| **Offline metrics**                                   | Pairwise accuracy vs the human majority; Spearman ρ against the 1–7 scale                                                                                                                                                                                        |
| **Hardware / time / cost**                            | CPU, hours                                                                                                                                                                                                                                                       |
| **Exit criteria**                                     | Pairwise accuracy ≥ 65 % (vs ~50 % chance) **and** it beats the best single DSP feature by ≥ 10 points                                                                                                                                                           |
| **Kill criteria**                                     | Below 60 % → **do not ship a "tension" meter.** The honest product is to offer the alternatives and let the user choose                                                                                                                                          |
| **This is the highest-risk candidate in the program** | It is also the one the red team will attack hardest. See `AAW_DECISION_LOG.md`                                                                                                                                                                                   |

### T-5 — Voice-model adaptation for ZYVO _(trigger: E-11 shows the singer's own voice fails the target task)_

| Field                      | Specification                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**                | Measured: the performer's own voice (or a licensed voice model) fails an objective task — e.g. intelligibility under a live-room reverb chain — by a publishable margin |
| **Objective**              | A speaker-adapted enhancement or conversion model **for that performer only**, with an explicit revocable grant                                                         |
| **Labels**                 | The performer's own recordings, explicitly granted; no third-party voices                                                                                               |
| **Legal sources**          | Performer-owned only                                                                                                                                                    |
| **Leakage prevention**     | The grant is per-performer and per-project; the artefact is stored in the grant's scope and destroyed on revocation                                                     |
| **Offline metrics**        | Objective audio metrics (e.g. intelligibility proxy, spectral distortion) on held-out phrases                                                                           |
| **Hardware / time / cost** | 16 GB VRAM, 4–12 GPU-hours; inference cost dominates thereafter                                                                                                         |
| **Exit criteria**          | ≥ 20 % improvement on the objective metric, **and** a blinded listening pass that does not report a loss of vocal identity                                              |
| **Kill criteria**          | Any measurable identity loss in the blinded protocol → **kill**, regardless of metric gains                                                                             |
| **Absolute rule**          | No voice model may be trained on a performer's audio without an explicit, revocable, recorded grant. Voice is the one asset where "probably fine" is unacceptable       |

### T-6 — A learned project/world model _(trigger: E-11 rejects the typed graph for edit-target selection)_

| Field                      | Specification                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**                | A benchmark where the **typed graph** fails to identify the correct edit target, and a learned embedding of the project beats it reproducibly |
| **Objective**              | A project embedding for target selection                                                                                                      |
| **Labels**                 | Human-labelled edit targets (the user chose this region)                                                                                      |
| **Leakage prevention**     | Split by project, never by clip                                                                                                               |
| **Offline metrics**        | Top-1 target accuracy vs the typed-graph baseline                                                                                             |
| **Hardware / time / cost** | 8 GB VRAM, hours                                                                                                                              |
| **Exit criteria**          | ≥ +10 % absolute over the typed graph on held-out projects                                                                                    |
| **Kill criteria**          | < +5 % → the typed graph stays; this was Alt-4 in the architecture doc and it is the most likely rejection                                    |

---

## 5. Preference data from user edits — the rules

The brief asks specifically about datasets built from reversible user edits and A/B selections. The
repo's own contract already forbids the naive version of this ("merely applying or previewing
something is not automatically a taste label"). Formalising it:

### 5.1 What counts as a preference signal

| Action                                                   | Is it a signal?      | Why                                                          |
| -------------------------------------------------------- | -------------------- | ------------------------------------------------------------ |
| User explicitly picks variant A over B in an A/B compare | **Yes — strong**     | A forced choice between two known alternatives               |
| User stars / rejects a proposal                          | **Yes — strong**     | Explicit                                                     |
| User edits a proposed change after applying it           | **Weak — ambiguous** | The edit may fix the proposal _or_ express a different taste |
| User accepts a proposal unchanged                        | **No**               | Acceptance is not endorsement; it may be convenience         |
| User ignores a proposal                                  | **No**               | Silence is not data                                          |
| User plays/auditions a variant                           | **No**               | Audition ≠ preference                                        |
| User keeps the default                                   | **No**               | Default-kept is the _absence_ of information                 |

### 5.2 The capture rules

1. **Explicit only by default.** Signals are captured only from an explicit, labelled UI action.
2. **Opt-in, per-project, revocable.** A preference ledger is off by default; enabling it is an
   explicit user act with a visible scope; the ledger is inspectable, editable, exportable and
   erasable.
3. **Provenance on every record.** `{ signalType, projectId, capability, scopeHash, providerId,
variantHash, timestamp, consentScope }`.
4. **Never auto-promoted to training data.** A ledger is a _retrieval_ corpus by default. Turning it
   into a training set is a **separate, explicit, second consent** with a visible diff of what would
   be trained on.
5. **Bounded retention.** Sliding window by default (e.g. last 200 signals per project), because an
   old taste is often a stale taste.
6. **Never raw audio, never lyrics.** A signal stores _what was chosen_, not the audio. Audio and
   lyrics stay in the project, referenced by hash.

### 5.3 Why "user actions are ground truth" is wrong

Three reasons, all observed in the repo's own baselines:

1. **The deterministic fit score's margin is thin** (+0.005 in the `taste-benchmark` rationale), so
   "the best candidate" is often nearly arbitrary — keeping it teaches noise.
2. **Acceptance is confounded by cost.** Users accept the _cheapest_ correct option. A model trained
   on acceptance learns to be cheap, not good.
3. **The user is often matching a reference they cannot articulate.** That is exactly the case where
   retrieval over their past work beats a learned preference.

---

## 6. The blinded human listening protocol (required for any audible claim)

This is the repo's existing human-eval path (`docs/CREATIVE-TASK-HUMAN-EVALUATION.md`) extended to
the frontier. Any claim of the form "this makes the music better" **must** pass it.

| Element                    | Rule                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Blinding**               | The listener never sees which variant came from the model, which from the baseline, or which is the original. Variants are shuffled and relabelled per session. |
| **Pairwise, not absolute** | "Which do you prefer?" is answerable by a musician; "rate this mix out of 10" is not. Use forced choice with a tie option.                                      |
| **Original included**      | The original is one of the arms, unlabeled. This is what makes the result meaningful — an A/B against a model that wins by default is worthless.                |
| **Sample size**            | ≥ 30 pairs per claim for a directional read; ≥ 100 for a release-gating claim. Report the confidence interval, not just the point estimate.                     |
| **Listener set**           | At least one experienced producer/engineer plus at least one target-segment musician; report both.                                                              |
| **Order effects**          | Latin-square-ish counterbalancing; listener position effects measured.                                                                                          |
| **Reported**               | Win rate, tie rate, CI, and **the failure cases** — a claim with a 60 % win rate is a _failure_, and saying so is required.                                     |
| **Consent**                | Listening data is captured only with explicit consent; the participant may withdraw, and their data is deleted on request.                                      |

**Non-negotiable:** a model-generated variant that wins 55 % of pairwise comparisons has **not**
earned the right to be applied automatically.

---

## 7. Consent, provenance, rights

| Data                             | Rule                                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Private sessions**             | **Never** used for training without explicit, recorded permission + provenance (session id, date, scope, revocable)                                         |
| **Voice**                        | Performer-owned; per-project grants; revocation destroys the artefacts; no cross-project or cross-product transfer without an explicit export action        |
| **Preference ledger**            | Local; explicit signals only; separate consent for training use; erasable                                                                                   |
| **Listening verdicts**           | Consent at capture; participant withdrawable; stored with the project, not in a global pool                                                                 |
| **Datasets shipped in the repo** | Only public-domain or explicitly licensed material (Mutopia is the current example); a `manifest.json` per corpus recording source, licence, and provenance |
| **Provenance on outputs**        | Every receipt records provider, version, artifact digest, seed. Output ownership is answerable later                                                        |
| **Right to delete**              | Delete project ⇒ delete its artifacts, its ledger, its consent records, and any derived features                                                            |

---

## 8. Continual-learning hazards

| Hazard                                    | Reality                                                               | Control                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catastrophic forgetting**               | A new adapter overwrites general capability                           | Ship **adapters**, never merged models; keep the base pinned; keep a regression suite per release                                                 |
| **Silent drift**                          | The base model is updated upstream, behaviour changes                 | Pin the artifact digest; the provider interface carries `version` + `artifactDigest`; re-run the eval suite on every base bump                    |
| **Preference drift**                      | Last month's taste is not this month's                                | Sliding-window ledger; the ledger is a _retrieval_ corpus by default, so drift is visible rather than baked in                                    |
| **Feedback loops**                        | The model's own output becomes the training data, amplifying its bias | Explicit-signal-only capture; training data is never generated by the product without human review                                                |
| **Licence drift**                         | A fine-tune inherits a base licence that can change                   | The licence record ships with the pack; the LFM Open License v1.0's automatic-termination clause is why the licence file is vendored, not fetched |
| **Overfitting to the developer**          | The dataset is authored by the same person who writes the rubric      | Require a second reviewer and, for any release-gating claim, an outside listener                                                                  |
| **Capability cliff on model replacement** | A new base model silently changes proposal quality                    | The eval suite is versioned with the model pack; a base bump requires a full re-run before shipping                                               |

---

## 9. The economics of a training decision

For a one-person team, the cost of a model is **not** the training run. It is everything after.

| Cost line                    | Deterministic | Small model                             | Foundation fine-tune             | From scratch |
| ---------------------------- | ------------- | --------------------------------------- | -------------------------------- | ------------ |
| Initial engineering          | days          | days–weeks                              | weeks                            | months       |
| GPU time                     | none          | hours                                   | 1–3 days                         | weeks        |
| Rebase on every base release | n/a           | low                                     | **high**                         | n/a          |
| Serving/inference cost       | none          | negligible CPU                          | ~1 GB RAM + CPU per instance     | larger       |
| Licence exposure             | none          | low (own weights)                       | **vendor licence + inheritance** | own          |
| Evaluation burden            | low           | medium                                  | **high** (full re-run per bump)  | very high    |
| Failure mode if abandoned    | none          | regression test                         | stale model in prod              | dead project |
| **Verdict for this team**    | **default**   | justified only after a measured failure | **rare**                         | **no**       |

**The decisive argument is not cost, it is _surface area_.** Every model added is a permanent
maintenance, evaluation, licence and security obligation. The frontier program's credibility will be
measured by how little it adds that it cannot justify — not by how much AI it contains.

---

## 10. What this program will not train

- A "musical quality" predictor. Nobody can label it reliably, and a proxy becomes a lie.
- A model that writes project state.
- A model that decides what a user meant.
- A taste model trained on acceptance, edits, or silence.
- A voice model without a recorded, revocable, performer-owned grant.
- A generative music model as the core of the beat workflow (see `AAW_ROADMAP_2026_2029.md` — the
  honest use of generation today is _variation inside a user-specified constraint_, not composition).
- Anything trained on synthetic data and evaluated by schema validity (see §3).
