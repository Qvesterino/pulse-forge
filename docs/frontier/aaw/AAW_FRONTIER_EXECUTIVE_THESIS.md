# AAW_FRONTIER_EXECUTIVE_THESIS

**KYX / ZYVO — Toward a category: AI-Assisted Audio Workstation (AAW)**
**Date:** 2026-10-25 · **Research cutoff:** 2026-10-25 · **Status:** decision document
**Companions:** all 14 sibling documents in `docs/frontier/aaw/`

---

## 1. The thesis

> **An AI-Assisted Audio Workstation is not a DAW with a chatbot, and it is not a DAW with a
> generator bolted on. It is a DAW in which an agent can _perceive_ the project, _propose_ a scoped
> and reversible change, _prove_ what it changed — and hand the decision back to a musician who can
> see exactly what happened and take it back with one keystroke.**
>
> **The differentiator is not intelligence. It is legibility, reversibility and proof.**

Three findings from this program establish that, and they invert the brief's starting assumptions.

**Finding 1 — The substrate already exists; the intelligence does not.**
KYX already ships a reversible command layer, frame-grouped undo, **39** typed MCP tools with a
`read|runtime|mutate|destructive` risk taxonomy, a **real** dry-run sandbox (the handler runs against
a throwaway document), live/offline render parity through **one** engine class, a hard real-time
boundary (51 AudioWorklet processors, **zero** network calls in `src/audio-worklets/**`), typed effect
metadata for 57 effects, and a deterministic-first intent pipeline with a measured local slot-filler
(`valHeadAccuracyMean = 0.9949`). ZYVO already ships **283** typed commands, **61** MCP tools, a
**draft-only** external agent surface, a **fail-closed** show preflight and an allocation-free
worklet. **Neither product needs a new architecture. Both need consent, scope enforcement and
perception.**

**Finding 2 — The whitespace is real, and it is narrow.**
No major DAW vendor ships an MCP server. Exactly one ships a first-party LLM agent — FL Studio's
**Gopher**, cloud-backed, experimental, with an Approve/Deny gate. The famous AI music tools are
**cloud generators that emit audio**, not systems that edit a project you already have. The gap is
not "nobody has AI in a DAW"; it is that **nobody has shipped the loop**. KYX and ZYVO already own
more of it than any commercial DAW — and neither has shipped the _perception_ that would make it
feel like a product rather than a control panel.

**Finding 3 — The most consequential finding in the entire program is a licence, not a model.**
The LFM Open License v1.0 conditions commercial use on the using legal entity staying under
**USD 10,000,000 annual revenue** (§5(b): above the Threshold, commercial use "is not licensed"). It
applies to `LiquidAI/LFM2.5-1.2B-Instruct` — **the model KYX already ships and pins**. The audio
sibling `LFM2.5-Audio-1.5B` is under the same licence. The decision to fix this is cheap today and
expensive after the cliff. **Nobody should plan a product on a licence they have not read.**

---

## 2. What the candidate in the brief actually is

The brief proposed "LFM 2.5 Audio 1.5B". Verified:

| Question                   | Verified answer                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does it exist?             | **Yes** — `LiquidAI/LFM2.5-Audio-1.5B`, HF repo created 2025-12-18                                                                                                                                                      |
| What is it?                | **A speech-to-speech model** — ASR + TTS + interleaved voice chat. 1,470,308,496 params, 32,768 ctx, 24 kHz out, 16 kHz in, English only                                                                                |
| Is it a music model?       | **No.** Speech benchmarks only; no music task anywhere in the card                                                                                                                                                      |
| Is it the accuracy leader? | **No** — VoiceBench **54.92** vs Qwen2.5-Omni-3B **63.57**; ASR WER **7.53** vs Whisper-large-v3 **7.44**                                                                                                               |
| Why would you use it?      | **Shape, not accuracy** — 1.5 B, llama.cpp CPU path (~1.07 GB Q4_0), ONNX/WebGPU path (~2.14 GB), a first-party fine-tune recipe, one model for ASR+TTS+chat, and **CPU-only ASR measured at RTF 0.077**                |
| Its worst property?        | **The official path degenerates on song-length audio**: WER 2.8 % → 83 % → **296 %** at 30/120/180 s, while the llama.cpp adapter holds 1.3–2.3 %. A song is 2–5 minutes. **The runtime is the risk, not the weights.** |
| Does it speak Slovak?      | **No.** English + a separate JP checkpoint. Slovak stays on Whisper (MIT / Apache-2.0, verified `sk`+`cs`)                                                                                                              |

**And the correction I owe the record:** an earlier draft of this program asserted that the
publisher had not published ASR accuracy for the English checkpoint. That was wrong — the model card
does carry VoiceBench and WER tables, and the numbers change the recommendation. It is stated
explicitly in `AAW_AUDIO_MODEL_LANDSCAPE.md` §1.6 rather than quietly edited.

---

## 3. Non-goals — what this program will _not_ do

1. **Not** claim a "mix quality score", a "musical tension meter", or any label nobody can produce
   reliably.
2. **Not** put inference, network access or unbounded work in an audio callback — in either product,
   in any mode. Both repos are clean today; that is an asset to protect, not a frontier to push.
3. **Not** let a model write project state, ever.
4. **Not** train anything without a **published, held-out baseline failure**. At the time of writing
   the count of justified training projects is **zero**.
5. **Not** infer taste from ordinary edits. KYX's own code already forbids it (_"Feedback is never
   inferred from USE"_), and it is right.
6. **Not** clone a voice without a recorded, revocable, performer-owned grant.
7. **Not** promise autonomous musical excellence. The honest promise is narrower and better.
8. **Not** put a chat panel at the centre of the product.
9. **Not** ship the most famous models. The best-known open music generators are **CC-BY-NC-4.0**
   (MusicGen, AudioGen, YuE2, MMAudio, MERT, Music2Latent) or NVIDIA-noncommercial (Audio Flamingo).
   The one that is commercially licensed — **ACE-Step 1.5** (MIT, < 4 GB VRAM, < 10 s/song on a
   3090, LoRA-able from 8 songs) — is also the small one.

---

## 4. The five key bets

**Bet 1 — Trust infrastructure is the moat, not intelligence.**
Versioned capability metadata + a deterministic permission lattice + a scope-diff verifier +
one-undo transactions + receipts. This is the hardest thing in the category to copy, because it is
unglamorous and it is a product decision rather than a model decision. It is also what makes the
AI parts acceptable at all. **Wave 0 is blocking, not parallel.**

**Bet 2 — Perception stays deterministic (DSP/MIR + commercially-licensed embeddings) and becomes a
cache, not a stage.**
KYX has excellent classical DSP perception (transients, impulse-train tempo, Goertzel chroma +
Krumhansl key with honest evidence floors, RMS-energy sections, BS.1770-4 loudness) and **no** audio
embeddings, **no** tagging, **no** audio-LLM — verified by exhaustive search of `src/`. The
landscape says close that gap with **embeddings and cached, revision-keyed analysis artifacts**,
not with a frontier audio-LM: the strong ones are non-commercial or server-class. Keyed by
`(projectRevision, artifactId, algoVersion)`, so perception is **reproducible** and the verifier's
claims stay checkable.

**Bet 3 — The category-defining interaction is _situated_, not conversational.**
Selection-aware, two-variant, instantly switchable, with a **numeric diff** ("+4 ghost notes, −2
bass notes; velocity correlation 0.99; swing 54 % → 56 %") and a statement of what was **not**
verified. StudioPilot already markets itself as _"not a chatbot sitting beside your DAW"_. That
framing is the category.

**Bet 4 — The intelligence is optional.**
Every capability has a deterministic fallback; the product is complete with every model uninstalled
and the network off; a provider is an implementor of a versioned interface, never a dependency.
This is simultaneously the trust argument, the vendor-independence argument, and the licence-cliff
hedge.

**Bet 5 — Honesty is the differentiator.**
"This change does not measurably increase tension" is a **feature**. The weakest point of the whole
AI-music category is claiming feelings; the strongest available position is _measuring_ and saying
when it did not work.

---

## 5. The strongest counterarguments — and what they change

These are the arguments that should win if they are right. Each one is answered with a measurement
plan, not a reassurance.

| Counterargument                                                                | Honest answer                                                                                                                                                                                                                                                                                                                                             | What changes because of it                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"No audio model understands subjective music well enough."**                 | **Already true, and it is the binding constraint.** No open, commercially usable, music-understanding model fits a 6–16 GB tier.                                                                                                                                                                                                                          | The perception layer is deterministic DSP/MIR + embeddings. "Tension" ships as **the dimension that changed**, not as a feeling. E-07 decides whether we may even claim it.                                               |
| **"Tool orchestration will be slower and less reliable than manual editing."** | **Possible.** The deterministic path resolves most asks before any model runs; the model's measured contribution is 91.7 % attempted-exact on the routed subset; and the repo's own negative result (a creative-task LoRA that passed 25/32 schema checks and produced **0 of 24** creative proposals) shows that adding a model does not add capability. | Every capability has a deterministic fallback; latency budgets are release gates; **E-10** is the decisive experiment, and **any task where the assisted path is slower gets dropped.**                                   |
| **"AAW features will harm flow and autonomy."**                                | **The highest-probability failure mode.**                                                                                                                                                                                                                                                                                                                 | Rejection rate ≤ 40 %, later-undo ≤ 15 %, a hard three-variant cap, and a permission lattice a model can never raise. The attention budget is now a first-class metric, not a UI preference.                              |
| **"The model will disappear, change licence, or get expensive."**              | **It already has.** The $10M revenue cliff applies to the model KYX ships today.                                                                                                                                                                                                                                                                          | P-8 (an Apache/MIT fallback backbone with a parity gate) becomes a scheduled deliverable; the licence record ships _with_ the model pack, never fetched at runtime; **D-02**.                                             |
| **"Training data will be too sparse, biased or unusable."**                    | **Likely — which is why nothing here trains a model.**                                                                                                                                                                                                                                                                                                    | Seven-rung decision tree with a published-failure gate; six candidate training projects, each with a trigger _and_ a kill criterion.                                                                                      |
| **"KYX and ZYVO have incompatible state and plugin contracts."**               | **They do.** Different schemas, different effect systems, different time bases (KYX: 480 PPQ; ZYVO: currently **no addressable musical time at all**).                                                                                                                                                                                                    | The shared plane defines **formats and protocols only**; musical vocabulary stays a product adapter; the first cross-product step is carrying the **notes** across `.kyxzyvo` so a KYX beat arrives in ZYVO **editable**. |
| **"Maybe the best outcome is a simpler deterministic feature, not AI."**       | **For the top eight items on the list, that is exactly what happened.**                                                                                                                                                                                                                                                                                   | Stated as the thesis, not hidden: the category claim is _"a trustworthy, reversible, verified loop a musician can drive"_ — not _"we have a model"_.                                                                      |

**The revised plan after the critique** is in `AAW_ROADMAP_2026_2029.md` §8. In short: the
capability metadata + permission lattice + scope verifier became a **blocking gate**; E-07, E-10
and the licence question were promoted; the cross-product note transfer moved up; and **Z-9 (live
cue prediction)** and the **learned project representation** moved from roadmap to _explicit
rejections_.

---

## 6. What the prioritization actually says

The scoring is reproducible (`docs/frontier/_research/score-model.mjs` — it asserts every weight set
sums to 1.0 and every score is in range; it caught an error in my own weight set during drafting).

**Base ranking (top 8 of 36):** Z-1 take comparison (4.86) · Z-11 rehearsal-to-show (4.63) ·
P-1 permission lattice (4.63) · K-4 multi-variant A/B (4.57) · K-7 rhythm transformation (4.56) ·
P-3 capability metadata (4.56) · K-5 context-sensitive selection (4.49) · K-1 timbral search (4.48).

**The sensitivity analysis is the real finding:**

- **Z-1 ranks #1 under all four weightings** — safety-first, evidence-first, ship-fast and base. The
  most robust item in the entire program.
- **P-1 and P-3 are top-6 under every weighting.**
- **K-2 (groove-preserving edits) is the most weight-sensitive**: rank 11 base, **17** under
  safety-first, **7** under evidence-first. It is a judgement call and must be argued, not assumed.
- **Z-9 is last under three of four weightings** and 34th under the fourth → **robustly rejected**.
- **K-8 (editable generative stems) is 34th/35th/36th** → the most famous idea in the program is
  the least defensible.

**The uncomfortable, correct conclusion: the top of the list is trust and measurement
infrastructure, not AI features.** That is what prioritization looks like when the substrate already
exists and the real risk is overreach.

---

## 7. A 30-day sprint that decides the most

**Week 1 — Repository audit and baselines.** The two repository audits in this program are the
baseline; re-run them against the current tree before touching anything. Confirm the three numbers
that everything else depends on: the **21 mutating tools that run without consent**, the
**in-memory undo stack**, and the **absence of any audio embedding path**.

**Week 2 — The three experiments that discriminate.** **E-03** (does the official LFM audio path
survive a 3-minute song on Windows? — CPU, ~20 GB disk), **E-07** (can any DSP feature separate
"more tense" from "less tense"? — 60 blind pairs), **E-06** (does embedding retrieval beat metadata
search? — 100 prompts, human labels). All three are CPU-only, all three can _cancel_ work rather
than create it, and E-07 alone can cancel the most expensive feature in the program.

**Week 3 — The blocking wave.** Write the capability-descriptor extension (`version`, `sideEffects`,
`realtimeSafe`, `latencyClass`, `riskClass`, `undoUnit`) over the 57 effects and 39 tools; write
the permission lattice as a pure function with a test table; write the scope-diff verifier against
protected-content hashes. **No model, no new feature, no UI change.**

**Week 3, as it actually landed (2026-10-25).** One of the three week-3 items shipped, and it
shipped completely: the **permission lattice** (`src/mcp/permissionLattice.ts`) is a pure function
returning `auto` / `confirm` / `forbid`, reusing the existing `ToolRisk` vocabulary rather than
inventing a second one; the **scope guard** (`src/mcp/scope-guard.ts`) enforces a declared scope
before the write lands and verifies it after; a **document revision counter** gives the lattice
something to refuse a stale plan against; and the MCP write path consults the lattice before it
mutates. **29 unit tests** in `tests/permission-lattice.test.ts`; the decision is
`docs/adr/0065-permission-lattice-and-scope-guard.md`. The other two week-3 items did **not**
land: the capability-descriptor extension (**P-3**) is untouched — a grep for
`requiresApproval|permissionTier|riskClass|realtimeSafe` across `src/` returns **0** hits — and
the scope guard verifies **declared paths and operations, not protected-content hashes**, so the
hash-based protected-object verifier (the second half of **P-2**) is still open. See
`AAW_ROADMAP_2026_2029.md` §3 for the item-by-item Wave 0 status.

**Week 4 — Ship the trust gate and open the first capability.** Release the lattice and the verifier
behind the existing tools; add the **destructive-vs-mutate consent split** (ZYVO's posture, ported to
KYX); build **Z-1 take comparison** — the top-ranked capability, no model required — as the first
end-to-end demonstration of the loop. Then decide, with numbers: does the official LFM audio path
stay in the plan (E-03), does "tension" stay in the vocabulary (E-07), and does the intent backbone
need a permissively-licensed fallback (D-02)?

**Week 4, as it actually stands (2026-10-25).** The consent split **is** the shipped part: KYX now
separates external from local traffic, and an external agent's mutating call needs standing consent
(`pf:mcp-allow-mutations`, default **OFF**) — ZYVO's draft-only posture, ported. The known gap is
that this is a **standing** consent, not ZYVO's **per-call** one; the per-call proposal UI does not
exist in KYX yet, and that is the next increment of D-14, not a footnote. **D-02** was decided in
the same window: **document and defer** (assumption: below USD 10M annual revenue for two years;
re-review 2028-10-25 or on any trigger). **E-07** runs with a **two-listener panel** — directional
only, never a release gate. Still open in this week: the hash-based protected-object verifier, the
**P-3** registry metadata, **Z-1 take comparison**, and the three experiments (E-03, E-06, E-07).

**Compute:** no GPU required for any week-1..4 item. A 6–16 GB VRAM machine is only needed for E-01,
E-04 and E-05, which are months 2–6. **Cost:** ~0. **Model downloads:** ~1.1 GB (E-03 only).

**Decision gates at day 30:**

1. E-03 → keep or drop `LFM2.5-Audio` from the product plan. **(OPEN)**
2. E-07 → ship "tension" as a measurement, or ship it as "the dimension that changed". **(OPEN —
   with n = 2 listeners, directional only; it may cancel the capability, never certify it.)**
3. D-02 → start the Apache/MIT fallback backbone, or accept the licence risk in writing.
   **(CLOSED 2026-10-25: document and defer — the licence risk is written down, the licence file is
   vendored, the re-review date is 2028-10-25.)**
4. The permission lattice + scope verifier → **green**, or Wave 0 does not close and nothing else
   starts. **(PARTIALLY GREEN 2026-10-25: the lattice and the path/operation scope guard are green
   with 29 passing tests; the hash-based protected-object verifier is still open, so Wave 0 does
   not close.)**

---

## 8. Top 5 Strategic Bets

1. **Trust is the moat, not intelligence.** Versioned capability metadata + a deterministic permission
   lattice + a scope-diff verifier + one-undo transactions + receipts. Nothing else in the category is
   as hard to copy, and it is what makes the AI parts acceptable.
2. **Perception stays deterministic and becomes a cache.** No open, commercially usable,
   music-understanding model fits the tier; reproducible revision-keyed analysis artifacts are the
   enabler for every future AI claim.
3. **The category-defining interaction is situated, not conversational.** Selection-aware,
   two-variant, instantly switchable, numerically diffed, with what was preserved stated in numbers.
4. **The intelligence is optional.** Every capability works with no model installed; providers are
   versioned and removable. Trust argument and vendor-independence argument in one decision.
5. **Honesty is the differentiator.** "This change does not measurably increase tension" is a
   feature. Measurement is the position competitors cannot take.

---

## 9. Top 5 Things NOT to Build Yet

1. **Editable generative stems (K-8)** — ranked 34th/35th/36th across three weightings; generation
   that is not editable is a demo, and the baseline it must beat does not exist yet.
2. **Live cue prediction (Z-9)** — last-ranked under three of four weightings; the arrangement
   already knows the structure, and a wrong cue on stage is a performance failure.
3. **A learned project representation / world model** — the most expensive idea with the weakest
   falsifiable hypothesis; E-11 decides it, and E-11 is cheap.
4. **A "musical quality" or "mix score" meter** — unlabelable; a proxy becomes a lie; it would
   violate this program's own evidence discipline.
5. **A local speech model in the product (P-12)** — within ±10 % of Whisper on the metrics that
   exist, English-only, a $10M licence cliff, and a known long-audio degeneration in the official
   path. **The experiments are worth running; the product feature is not.**

---

## 10. Next 3 Experiments

1. **E-03 — Does the official LFM audio path survive a full-length song?** _(M, CPU)_ — decides
   whether a whole capability class is real, on Windows, with the runtime that matters.
2. **E-07 — Can any DSP feature separate "more tense" from "less tense"?** _(M + M, CPU)_ — decides
   whether the flagship claim is a measurement or a hope, and can cancel the most expensive feature.
3. **E-06 — Does embedding retrieval beat metadata search for the library?** _(S–M, CPU)_ — the
   cheapest high-visibility capability, with an immediate ship/kill answer.

---

## 11. Honest positioning

> **KYX and ZYVO are the DAWs where an AI agent is a first-class, permissioned, reversible
> participant in the project — not a chat panel, and not a generator you export from.**
>
> Every change an agent proposes is scoped, previewed, applied as one undoable transaction, verified
> against the audio, and recorded. Every capability still works with no model installed. We do not
> claim the agent makes better music than you. We claim **you can see exactly what it changed, hear
> exactly what it changed, and take it back in one keypress** — and that no other DAW lets you do
> that today, because no other DAW ships the loop.

**What would make this thesis wrong.** If E-10 shows the assisted path is not faster than manual
editing on any task; if E-07 shows "tension" is not measurable from the audio; if the permission
lattice turns out to annoy the users it is meant to protect; or if the licence and cost of the
model stack make the AI parts unaffordable in practice. **Each of those is a measurement with a
deadline in the 30-day sprint — which is the point of writing the thesis this way.**

---

## 12. The document set

| Document                              | What it answers                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `AAW_FRONTIER_EXECUTIVE_THESIS.md`    | this document — thesis, non-goals, bets, counterarguments, the 30-day sprint                    |
| `AAW_STATE_OF_THE_ART_2026.md`        | what exists today (code-verified, both repos), the four structural gaps, the capability horizon |
| `AAW_COMPETITIVE_CAPABILITY_MAP.md`   | the market, with verified absences and table stakes vs genuinely rare                           |
| `AAW_AUDIO_MODEL_LANDSCAPE.md`        | the models, the LFM candidate dossier, the licence findings, deployment by tier                 |
| `AAW_REFERENCE_ARCHITECTURE.md`       | the brief's stack, nine things wrong with it, the revised one, six alternatives rejected        |
| `AAW_AI_CONTROL_CONTRACTS.md`         | the typed contracts: brief, plan, registry, permission lattice, preview, verification, receipt  |
| `AAW_TRAINING_AND_DATA_STRATEGY.md`   | the seven-rung decision tree, six triggered candidates, consent, economics                      |
| `KYX_FRONTIER_CAPABILITIES.md`        | 12 KYX capabilities, ranked, each with JTBD → prototype                                         |
| `ZYVO_FRONTIER_CAPABILITIES.md`       | 12 ZYVO capabilities by mode (OFF/REC/REH/LIVE), with real-time constraints and fallbacks       |
| `AAW_EXPERIMENT_BACKLOG.md`           | 13 falsifiable experiments with baselines, metrics and kill criteria                            |
| `AAW_EVALUATION_BENCHMARKS.md`        | 10 benchmark suites, failure budgets, stop/go criteria                                          |
| `AAW_SECURITY_AND_REALTIME_SAFETY.md` | threat model, 9 verified live hazards, permission tiers, the release gate                       |
| `AAW_ROADMAP_2026_2029.md`            | the scored portfolio, the hostile review, the revised plan, two resource scenarios              |
| `AAW_DECISION_LOG.md`                 | 20 ADR-style decisions, 10 open questions, 12 evidence gaps                                     |
| `AAW_SOURCE_LEDGER.md`                | 117 numbered sources with grades, dates, methods and revalidation dates                         |
| `_research/`                          | the raw evidence files and the reproducible scoring script behind this document set             |
