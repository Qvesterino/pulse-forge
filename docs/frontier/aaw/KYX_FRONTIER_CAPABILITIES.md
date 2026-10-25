# KYX_FRONTIER_CAPABILITIES

**Status:** ranked KYX-specific frontier capabilities for an AI-Assisted Audio Workstation
**Date:** 2026-10-25
**Product:** KYX — browser-first beatmaking, arrangement, sound design, production, editing, mixer/plugins
**Companions:** `AAW_EXPERIMENT_BACKLOG.md`, `AAW_ROADMAP_2026_2029.md`, `AAW_REFERENCE_ARCHITECTURE.md`

---

## 0. How these were ranked, and the honest caveat

Each capability below is scored on the nine criteria from `AAW_ROADMAP_2026_2029.md` §2
(user value, musical differentiation, technical feasibility, evidence strength, data availability,
latency feasibility, safety, maintainability, independent-developer affordability; 1–5 each).

**Two ground rules applied to every idea:**

1. **If a deterministic algorithm can do it, the deterministic algorithm wins.** A capability that
   needs a model to exist at all is a smell. Many of the strongest items here are _not_ AI — they
   are **AI-shaped products built on deterministic DSP**, which is the honest way to build in this
   category today.
2. **Every capability must have a measurable fallback.** If the AI part is removed, the capability
   must still exist in reduced form — otherwise it is a demo.

**A caveat that applies to the whole document:** the repository state referenced here is taken from
`docs/AI-PRODUCER-CONTRACT.md` §11 (the "current foundation" map), `AGENTS.md`, and the dataset and
report files under `scripts/data/`. Those are the repo's own claims about itself; the code-level
verification pass is `AAW_STATE_OF_THE_ART_2026.md` §7. Items marked _(doc claim)_ depend on that
pass.

---

## 1. The portfolio at a glance

| #        | Capability                                    | Verdict                        | Score | Why                                                                          |
| -------- | --------------------------------------------- | ------------------------------ | ----- | ---------------------------------------------------------------------------- |
| **K-1**  | Timbral search by intent                      | **Build now**                  | 4.4   | Embeddings already validated in-repo (`RECOMMEND-ON`); zero new models       |
| **K-2**  | Groove-preserving edits                       | **Build now**                  | 4.3   | The core differentiator; grid preservation is mechanically checkable         |
| **K-3**  | Mix-aware beat generation (constrained)       | **Experiment**                 | 3.9   | Highest ceiling, highest cost; the differentiator _is_ the constraint        |
| **K-4**  | Multi-variant A/B arrangement                 | **Build now**                  | 4.2   | Cheap, high trust value; the review mechanism for everything else            |
| **K-5**  | Context-sensitive sound selection             | **Build now**                  | 4.0   | Retrieval, not generation; feels like "the DAW knows my project"             |
| **K-6**  | Musical tension planning                      | **Build now (deterministic)**  | 3.9   | Arithmetic on structure, _not_ a model; ships the "tension" promise honestly |
| **K-7**  | Rhythm transformation with musical constraint | **Build now**                  | 3.8   | Deterministic; preserves swing and velocity curves                           |
| **K-8**  | Editable generative stems                     | **Research bet**               | 3.2   | Generation that lands as editable MIDI, not a baked audio file               |
| **K-9**  | Energy-aware arrangement                      | **Experiment**                 | 3.4   | Needs a human-labelled energy curve — expensive labelling                    |
| **K-10** | Producer-specific creative assistant          | **Later, opt-in**              | 3.1   | Only after the preference ledger has real signal                             |
| **K-11** | Reference-matched mastering moves             | **Experiment**                 | 3.3   | Constraint-matching, never "optimisation"                                    |
| **K-12** | Transition & fill generation                  | **Build now (template-first)** | 3.7   | Template library first; generation later                                     |

---

## 2. K-1 — Timbral search by intent

| Field                          | Specification                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job-to-be-done**             | _"I know the sound I want but I don't know its name — find it in my library, and in my factory kits."_                                                                                                                          |
| **Minimum viable interaction** | A text field in the browser search: _"warm and slightly broken, tape-ish hats"_. Results are ranked audio previews; clicking one loads it into the selected slot. Keyboard-first, one field, no modal.                          |
| **Data required**              | The repo's factory + curated sample library (already present), each item's embedding, plus its existing metadata (type, key, tempo, tags). **No user data needed.**                                                             |
| **Audio/model components**     | Text→style embedding (validated: embedding v3 passes mood-only and style-varying pair tests → `RECOMMEND-ON`), sample embeddings, cosine retrieval, optional PCA projection (already vendored: `pca-embedding-projection.json`) |
| **Action APIs**                | `library.searchByDescription(text, filters) → SampleRef[]`; `library.preview(SampleRef)`; `slot.load(SampleRef, slotId)` (R1)                                                                                                   |
| **Quality metric**             | Recall@5 against human relevance judgements on a 100-prompt set; the existing pair-distance tests must keep passing (regression)                                                                                                |
| **Latency**                    | ≤ 100 ms for 10k items (H-1); the repo's deterministic path already measures 13–104 ms                                                                                                                                          |
| **Risk**                       | Low. Read-only + one R1 write. Failure mode: irrelevant results → the user types differently.                                                                                                                                   |
| **Differentiation**            | **High.** Nobody's "library search" is the thing that makes a DAW feel intelligent; a _constrained_ library search is genuinely rare.                                                                                           |
| **Small prototype**            | Embed the factory library once (offline, cached), expose `library.searchByDescription`, wire it to the existing slot loader. **Days, not months.**                                                                              |
| **Verdict**                    | **Build now.** The cheapest high-value item on this list, and it is already 80 % built.                                                                                                                                         |

---

## 3. K-2 — Groove-preserving edits

| Field                          | Specification                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Job-to-be-done**             | _"Make this loop tighter, but don't make it sterile — keep the human push."_                                                                                                                                                                                                                                 |
| **Minimum viable interaction** | Select a clip → _"tighten this, keep the feel"_ → a preview that is audibly tighter **and** audibly still human, with a diff readout: _"16th-note grid added in bars 3–4; swing 54 % → 56 %; velocity curve preserved (r = 0.99)"_.                                                                          |
| **Data required**              | The clip's notes + velocities + swing setting (in the project), the beat grid (derived), and the **taste benchmark harness** already in the repo                                                                                                                                                             |
| **Audio/model components**     | Deterministic: grid detection, swing estimation, velocity-curve regression, a _constrained_ re-quantisation that moves only the notes whose deviation exceeds a threshold. A model is used **only** to choose the threshold from the phrase "keep the feel" — and the deterministic default is the fallback. |
| **Action APIs**                | `clip.tighten(clipId, range, {threshold, preserveSwing, preserveVelocityCurve})` (R2)                                                                                                                                                                                                                        |
| **Quality metric**             | **E-4 groove stability** (median onset deviation ≤ 2 ms, p95 ≤ 8 ms); E-3 velocity correlation ≥ 0.99; **blinded preference ≥ 60 % vs the original**                                                                                                                                                         |
| **Latency**                    | ≤ 8 s preview for a 30 s region (H-3)                                                                                                                                                                                                                                                                        |
| **Risk**                       | Medium-low. The classic failure is "tightened but robotic" — the metric to watch is _velocity correlation_, not timing                                                                                                                                                                                       |
| **Differentiation**            | **High.** Every DAW has "quantize" and "humanize"; almost none has "tighten while preserving human feel, with a measurable statement of what it preserved". The _reporting_ is the product.                                                                                                                  |
| **Small prototype**            | A `clip.tighten` command + a preview + a diff readout. The determinism tests (E-1/E-3) are the gate.                                                                                                                                                                                                         |
| **Verdict**                    | **Build now.** This is the capability that best demonstrates "AAW ≠ DAW with a chatbot".                                                                                                                                                                                                                     |

---

## 4. K-3 — Mix-aware beat generation (constrained)

| Field                          | Specification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job-to-be-done**             | _"Make me a beat that fits under this vocal / fits this mix / fits the tempo and key of this project."_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Minimum viable interaction** | With the project open: _"give me a beat at 140 that leaves room for the vocal in the chorus"_ → 2–3 variants, each as an **editable** pattern (notes), not a rendered audio file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Data required**              | The project's tempo map, key context, role occupancy (which roles are already used), plus the repo's existing candidate bank and pattern/preset library                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Audio/model components**     | Constrained generation over a **symbolic** representation (MIDI/pattern), not raw audio. Options: (a) the repo's own symbolic models + prior library (already vendored: `symbolic-prior-dataset.json`, `melodic-v3-dataset.json`), (b) a text→MIDI open model, (c) **retrieval + recombination** — the cheapest and most controllable option, (d) `ACE-Step 1.5` — the **only verified commercially-licensed** open music generator (MIT + commercial-use grant, 2.39 B, **< 4 GB VRAM**, **< 10 s/song on a 3090**, LoRA-able from 8 songs). Note the trap: MusicGen, AudioGen, YuE2, MMAudio are **CC-BY-NC-4.0** and Audio Flamingo is **NVIDIA Noncommercial** — the famous models are not usable in a commercial DAW |
| **Action APIs**                | `pattern.propose(context, constraints) → PatternCandidate[]`; `arrangement.insertPattern(candidate, slot)` (R2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Quality metric**             | Blinded listening vs the repo's existing candidate bank; **and** a constraint-satisfaction check (tempo exact, key compatible, role space reserved) which must be 100 %                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Latency**                    | ≤ 8 s for a candidate set; **symbolic generation is cheap** (this is why symbolic beats the audio-LM path)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Risk**                       | Medium-high: the risk is _mediocrity_, not breakage. Generation that produces a technically-correct, dull beat is worse than no generation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Differentiation**            | **High, if the constraint is the feature.** "Beat that leaves room for the vocal" is not something a generator does by itself; it requires the AAW to _read the project_ and constrain generation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Small prototype**            | Retrieval-based: take the repo's existing pattern library, filter by tempo/key/role-space, rank by the existing fit score, and _state the constraint satisfaction_ to the user. If the deterministic version isn't compelling, generation will not be.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Verdict**                    | **Experiment.** But **experiment with retrieval first** — the deterministic version is the baseline the generative version must beat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## 5. K-4 — Multi-variant A/B arrangement

| Field                          | Specification                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job-to-be-done**             | _"Show me two different ways this chorus could go."_                                                                                                                                                                                                 |
| **Minimum viable interaction** | One proposal → two (or three) variants → an A/B toggle that switches instantly, in place, without re-rendering, plus a **diff card** for each variant ("+4 ghost notes, −2 bass notes, chorus B adds a 2-bar fill")                                  |
| **Data required**              | The project's arrangement + the existing candidate/pattern bank + the audition infrastructure (`src/intent/audition.ts`)                                                                                                                             |
| **Audio/model components**     | Mostly deterministic variant generators (fill insertion, note-density variants, section-order variants), each a typed capability. A model may _rank_ or _propose_ variants, but the variants themselves are generated by deterministic capabilities. |
| **Action APIs**                | `arrangement.generateVariants(scope, count) → Variant[]`; `arrangement.previewVariant(variantId)`; `arrangement.commitVariant(variantId)` (R2)                                                                                                       |
| **Quality metric**             | J-1 time saved; **J-3 rejection rate ≤ 40 %**; D-1 win rate of the chosen variant ≥ 60 % against the original                                                                                                                                        |
| **Latency**                    | ≤ 8 s per variant, rendered in parallel where possible; **switching is instant** (pre-rendered)                                                                                                                                                      |
| **Risk**                       | Low-medium: the main risk is **choice overload**. Cap at 3 variants; the rule "one clear recommendation + at most two alternatives" is a product invariant, not a preference.                                                                        |
| **Differentiation**            | **Medium-high.** The A/B mechanism is the trust instrument for the whole category. Competitors show one output; a category-defining AAW shows **two** and makes switching free.                                                                      |
| **Small prototype**            | Two deterministic variant generators + a pre-rendered A/B toggle + the diff card.                                                                                                                                                                    |
| **Verdict**                    | **Build now.** It is also the **review UI that every other capability needs**.                                                                                                                                                                       |

---

## 6. K-5 — Context-sensitive sound selection

| Field                          | Specification                                                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job-to-be-done**             | _"Pick something for this part that fits what I've already built."_                                                                                                                                                     |
| **Minimum viable interaction** | Cursor in a role slot → the system proposes 3 sounds **for this project state** (key, tempo, energy, what else is playing) with a one-line reason: _"matches the 124 BPM half-time feel and the minor key of the hook"_ |
| **Data required**              | The project's current state (roles, key, tempo, energy profile) + the library index from K-1                                                                                                                            |
| **Audio/model components**     | Embedding retrieval **filtered and re-ranked by project state**: key compatibility, tempo compatibility, role-occupancy, energy match. Deterministic re-ranking over an embedding shortlist.                            |
| **Action APIs**                | `slot.suggestSounds(slotId, count) → SoundSuggestion[]` (R0 — suggestion only)                                                                                                                                          |
| **Quality metric**             | Blinded preference vs the user's own manual pick; J-3 rejection ≤ 40 %                                                                                                                                                  |
| **Latency**                    | ≤ 150 ms (H-1)                                                                                                                                                                                                          |
| **Risk**                       | Low (R0, read-only suggestion)                                                                                                                                                                                          |
| **Differentiation**            | **High.** "The DAK knows my project and offers me _this_ sound" is the feeling of intelligence that a chatbot cannot produce, because it is not a chat — it is a _situated_ choice.                                     |
| **Small prototype**            | A re-ranking function over the K-1 index + a role-aware filter + a one-line reason generator (templated, not generated).                                                                                                |
| **Verdict**                    | **Build now.** Cheap, safe, and the clearest "this is not a chatbot" moment available.                                                                                                                                  |

---

## 7. K-6 — Musical tension planning (deterministic, not a model)

| Field                          | Specification                                                                                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Job-to-be-done**             | _"Help me build tension into the last 4 bars before the drop."_                                                                                                                                                                                                                      |
| **Minimum viable interaction** | Select a region → _"add tension"_ → the system proposes **concrete, musical** moves with numbers: _"density 2.2 → 3.4 events/bar; low-mid energy +1.8 dB; add a 16th-note hat pattern in bars 29–32; keep the kick"_                                                                 |
| **Data required**              | The arrangement's structural facts: section roles, bar counts, per-role event density, dynamic profile, harmonic content                                                                                                                                                             |
| **Audio/model components**     | **Deterministic arithmetic on the project graph**: density, register spread, spectral centroid, dynamic range, harmonic complexity — computed per region and compared across regions. Plus the repo's existing **symbolic prior** library for _which_ moves typically raise tension. |
| **Action APIs**                | `analysis.regionProfile(scope) → RegionProfile`; `arrangement.applyTensionPlan(plan)` (R2)                                                                                                                                                                                           |
| **Quality metric**             | **Constraint satisfaction 100 %**; then a **human pairwise** test: does the variant read as "more tense"? — and if it does not, the feature reports **"tension not increased by these moves"** rather than claiming success                                                          |
| **Latency**                    | ≤ 2 s (H-2)                                                                                                                                                                                                                                                                          |
| **Risk**                       | Low. R2, preview-gated.                                                                                                                                                                                                                                                              |
| **Differentiation**            | **Medium.** The differentiator is the _honesty_: it tells you which musical dimension it changed, and it can say "this does not measurably increase tension". A model-based "tension meter" that always says "yes" is the category's credibility problem.                            |
| **Small prototype**            | `RegionProfile` (density/energy/dynamics/harmonic-complexity per region) + a rule table mapping dimension→move, reusing the symbolic prior library.                                                                                                                                  |
| **Verdict**                    | **Build now — deterministically.** Explicitly _not_ a "tension AI model" (see `AAW_TRAINING_AND_DATA_STRATEGY.md` T-4).                                                                                                                                                              |

---

## 8. K-7 — Rhythm transformation with musical constraint

| Field                          | Specification                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Job-to-be-done**             | _"Make the drums hit harder but keep the groove."_                                                                                                                                                                       |
| **Minimum viable interaction** | Select a drum pattern → choose a transformation (_harder_, _looser_, _swingier_, _gravier_) → preview with a readout of exactly what changed and what was preserved                                                      |
| **Data required**              | Notes + velocities + swing + the beat grid; existing kit presets and the augmented drum dataset already vendored                                                                                                         |
| **Audio/model components**     | Deterministic transformation with constraints: velocity shaping (accent curve), swing re-quantisation, note-order preservation, humanisation within bounds. Optional model: _choosing_ the transformation from a phrase. |
| **Action APIs**                | `clip.transformRhythm(clipId, kind, bounds)` (R2)                                                                                                                                                                        |
| **Quality metric**             | E-1 grid preservation 100 % outside the declared edit; E-3 velocity correlation; blinded preference ≥ 60 %                                                                                                               |
| **Latency**                    | ≤ 5 s preview                                                                                                                                                                                                            |
| **Risk**                       | Low-medium; main risk is "harder" becoming "louder and worse" — the velocity curve, not the peak level, is the thing to shape                                                                                            |
| **Differentiation**            | **Medium.** Low as a standalone feature, but it is the _first_ thing users will try and a strong demonstration that the system understands the difference between _intensity_ and _level_.                               |
| **Small prototype**            | Four deterministic transforms + a diff readout. Days.                                                                                                                                                                    |
| **Verdict**                    | **Build now.**                                                                                                                                                                                                           |

---

## 9. K-8 — Editable generative stems

| Field                          | Specification                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Job-to-be-done**             | _"I need a stem for this section that I can actually edit."_                                                                                                                                                                                                                                                                                                       |
| **Minimum viable interaction** | Request a stem (drums / bass / texture) for a section → it lands **in the arrangement as editable material** (notes/pattern + preset), not as a rendered WAV                                                                                                                                                                                                       |
| **Data required**              | The project's constraints (tempo, key, role space, bars, energy target)                                                                                                                                                                                                                                                                                            |
| **Audio/model components**     | Symbolic generation (pattern-level) + the repo's existing **generative/MRT2 adapter** path (`src/generative/`) for texture layers where notes are not the right representation. The concrete commercially-licensed target is **`ACE-Step 1.5`** (MIT + commercial-use grant; 2.39 B; < 4 GB VRAM; < 10 s on a 3090; LoRA from 8 songs) — _not_ the CC-BY-NC models |
| **Action APIs**                | `generative.proposeStem(context) → StemProposal` (notes + preset + bounds); `arrangement.insertStem(proposal)` (R2)                                                                                                                                                                                                                                                |
| **Quality metric**             | Editability (the stem must be human-editable without re-generation — a structural check); constraint satisfaction 100 %; blinded preference ≥ 60 %                                                                                                                                                                                                                 |
| **Latency**                    | ≤ 20 s (this is the expensive one — generation is minutes on CPU)                                                                                                                                                                                                                                                                                                  |
| **Risk**                       | High: cost, non-determinism, and the "impressive but unusable" failure                                                                                                                                                                                                                                                                                             |
| **Differentiation**            | **High in principle** — generation that lands _editable_ is a real category claim. But it is also the hardest thing on this list and the easiest to get wrong.                                                                                                                                                                                                     |
| **Small prototype**            | **Text-to-MIDI into the arrangement** with a hard constraint set; compare against the repo's existing retrieval-based candidate bank as the baseline.                                                                                                                                                                                                              |
| **Verdict**                    | **Research bet.** Do not build until K-3's deterministic retrieval baseline exists and is measured — otherwise there is nothing to beat. **The target is now concrete and affordable: ACE-Step 1.5 on the assumed 6–16 GB VRAM tier, commercially licensed, with a fine-tune path (T-6/T-8 in `AAW_TRAINING_AND_DATA_STRATEGY.md`).**                              |

---

## 10. K-9 — Energy-aware arrangement

| Field                          | Specification                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Job-to-be-done**             | _"Make the track's energy arc do what I want."_                                                                                                                                      |
| **Minimum viable interaction** | An energy curve is drawn or described ("build, then drop at the bridge") → the system proposes arrangement moves that realise it                                                     |
| **Data required**              | A **human-labelled energy curve** per song — this is the expensive part. Without labels, energy is an unsupervised feature and "the arc the user wanted" does not exist.             |
| **Audio/model components**     | Deterministic per-region energy features (RMS/LUFS-weighted, spectral flux density, onset rate, register spread) + a **learned mapping** from a described arc to an arrangement plan |
| **Action APIs**                | `analysis.energyArc(project) → EnergyProfile`; `arrangement.planToArc(arcSpec)` (R2)                                                                                                 |
| **Quality metric**             | Correlation between the realised arc and the requested arc on the objective features (this is the automatic part); plus a human check that it _feels_ right                          |
| **Latency**                    | ≤ 8 s                                                                                                                                                                                |
| **Risk**                       | Medium; the risk is a _technically correct_ arc that is musically inert                                                                                                              |
| **Differentiation**            | **Medium.** Valuable when done well; a common feature in "AI arrangement" marketing.                                                                                                 |
| **Small prototype**            | Energy features + a manual curve editor + a "realise this curve" planner over existing arrangement moves (no learning).                                                              |
| **Verdict**                    | **Experiment.** Depends on the labelling cost being paid down first.                                                                                                                 |

---

## 11. K-10 — Producer-specific creative assistant

| Field                          | Specification                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job-to-be-done**             | _"It knows how I like things done."_                                                                                                                                                   |
| **Minimum viable interaction** | The system proposes in _your_ idiom — same phrasing conventions, same typical choices, same restraint — and you stop having to specify it each time                                    |
| **Data required**              | **Explicit** preference signals only (A/B choices, starred picks). Never implicit edits. Never raw audio in the record.                                                                |
| **Audio/model components**     | Retrieval over the preference ledger first; a small ranker only if T-2's trigger fires                                                                                                 |
| **Action APIs**                | `preference.record(signal)`; `preference.recall(context) → PreferenceHints` (R0)                                                                                                       |
| **Quality metric**             | T-2's metrics: top-1 agreement ≥ 65 % on held-out explicit preferences; J-2 creativity preserved ≥ 70 %                                                                                |
| **Latency**                    | ≤ 100 ms (retrieval)                                                                                                                                                                   |
| **Risk**                       | **High reputationally**: a system that guesses wrong about taste is worse than one that never claims to know. Requires the consent design in `AAW_SECURITY_AND_REALTIME_SAFETY.md` §5. |
| **Differentiation**            | **High in principle, low in practice today** — because the ledger has no data yet.                                                                                                     |
| **Small prototype**            | The preference ledger + retrieval + a visible "because you chose…" line. No training.                                                                                                  |
| **Verdict**                    | **Later, opt-in.** Build the _capture_ now (it is cheap and irreversible-if-missed); build the _learning_ only when T-2's trigger fires.                                               |

---

## 12. K-11 — Reference-matched mastering moves

| Field                          | Specification                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job-to-be-done**             | _"Make my mix hit like that track — but keep my mix."_                                                                                                                                                                                                  |
| **Minimum viable interaction** | Drop a reference track → the system measures the reference's loudness profile, spectral balance and dynamic behaviour → proposes **specific EQ/movement changes** to _your_ mix, with the delta shown numerically                                       |
| **Data required**              | The reference track (user-supplied, rights-cleared by the user) + your mix + the existing metering (`src/audio-engine/metering.ts`)                                                                                                                     |
| **Audio/model components**     | Deterministic: LUFS/true-peak measurement, spectral band comparison, dynamic-range comparison → a set of **bounded EQ/gain moves** as a diff. A model is not needed for the measurement; it may be needed to pick _which_ differences matter (see T-3). |
| **Action APIs**                | `analysis.compareToReference(mix, reference) → MasteringDiff`; `mix.applyMoves(moves)` (R2, with the mastering chain as the only writable target)                                                                                                       |
| **Quality metric**             | D-1 blinded preference ≥ 60 % vs the original mix; **the artist's mix balance must survive** (measured: relative band balance within ±1.5 dB of the original outside the moved bands)                                                                   |
| **Latency**                    | ≤ 20 s (two renders)                                                                                                                                                                                                                                    |
| **Risk**                       | Medium-high: mastering advice is where "the AI improved my mix" becomes a fight. Scope must be limited to the mastering chain.                                                                                                                          |
| **Differentiation**            | **Medium.** Widely attempted; rarely done with the _measurement shown_. The transparency is the differentiator.                                                                                                                                         |
| **Small prototype**            | `compareToReference` producing a numeric diff, applied to the mastering chain only, with an A/B.                                                                                                                                                        |
| **Verdict**                    | **Experiment.** The measuring half is worth building regardless of the deciding half.                                                                                                                                                                   |

---

## 13. K-12 — Transition and fill generation

| Field                          | Specification                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job-to-be-done**             | _"Give me a fill that fits the energy going into the drop."_                                                                                                                                 |
| **Minimum viable interaction** | Place the cursor at a bar boundary → 3 fill options, each playable in place, each tagged by its musical character (_"rising 16th snare roll"_, _"one-shot crash + reverse"_)                 |
| **Data required**              | The project state (tempo, key, the outgoing and incoming sections' energy) + a curated fill library                                                                                          |
| **Audio/model components**     | **Template library first** (deterministic, curated, tagged) — the differentiator is the _tagging against the project's energy_, not the synthesis. Generation of novel fills is a later bet. |
| **Action APIs**                | `arrangement.proposeFill(atBar, context) → FillCandidate[]` (R0); `arrangement.insertFill(candidate)` (R1)                                                                                   |
| **Quality metric**             | D-2 blinded preference vs the existing library; J-3 rejection ≤ 40 %                                                                                                                         |
| **Latency**                    | ≤ 200 ms (library lookup)                                                                                                                                                                    |
| **Risk**                       | Low                                                                                                                                                                                          |
| **Differentiation**            | **Low as a feature, high as a demo of the concept.** A great demonstration of "context-aware", cheap to build, and it exercises the whole propose→preview→apply loop.                        |
| **Small prototype**            | A tagged fill library + an energy-context matcher.                                                                                                                                           |
| **Verdict**                    | **Build now (template-first).** Use it as the **reference interaction** for the whole AAW loop.                                                                                              |

---

## 14. What KYX should explicitly NOT build

| Rejected concept                              | Why                                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A "mix quality score"                         | Nobody can label it reliably; a proxy becomes a lie. The repo's own taste benchmark has no such label, and adding one would be a fabrication.   |
| Automatic mastering optimisation              | "Optimising" an aesthetic is exactly the objective-substitution failure. Only _constraint matching to a user-supplied reference_ is defensible. |
| A chat assistant as the main entry            | Contradicts the repo's own contract (§4.4) and destroys the attention budget.                                                                   |
| Unconstrained beat generation as the flagship | Generation without a constraint is a demo, not a product; the constraint is the product.                                                        |
| "AI DJ" / auto-mix                            | A different product (streaming), a different market, and a different licence surface.                                                           |
| Learning taste from ordinary edits            | Explicitly forbidden by the repo's own contract, and empirically unreliable.                                                                    |
| A learned world model                         | The most expensive idea with the weakest falsifiable hypothesis; revisit only if E-11 fails.                                                    |

---

## 15. Sequencing recommendation

| Order                    | Items                                                 | Rationale                                                                                                     |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **1 (0–3 months)**       | K-1, K-4, K-12, K-6                                   | All are mostly built, cheap, and each one exercises a different part of the propose→preview→apply→verify loop |
| **2 (3–6 months)**       | K-2, K-5, K-7                                         | The groove-preservation and context-selection capabilities — the core differentiators                         |
| **3 (6–12 months)**      | K-3 (retrieval baseline first), K-11 (measuring half) | Establish the baselines that any generative claim must beat                                                   |
| **4 (12–24 months)**     | K-8, K-9                                              | Research bets, gated on the baselines above                                                                   |
| **5 (only with signal)** | K-10                                                  | Requires the preference ledger to have real data                                                              |
