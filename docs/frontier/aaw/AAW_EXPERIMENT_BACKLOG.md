# AAW_EXPERIMENT_BACKLOG

**Status:** falsifiable experiments that decide the frontier program
**Date:** 2026-10-25
**Companions:** `AAW_EVALUATION_BENCHMARKS.md`, `AAW_TRAINING_AND_DATA_STRATEGY.md`, `AAW_ROADMAP_2026_2029.md`

---

## 0. Rules for this backlog

1. **An experiment without a baseline is not an experiment.** Every entry names its baseline.
2. **An experiment without a kill criterion is not an experiment.** Every entry names the result that
   stops it.
3. **The highest-information experiment comes first**, not the most exciting one.
4. **An experiment that cannot change a decision does not run.** Every entry states what it changes.
5. **Nothing here requires implementation.** These are measurements. Where an experiment needs a
   harness, the harness is itself a small, reusable artifact.

**Effort bands:** **S** ≤ 1 day · **M** ≤ 1 week · **L** ≤ 1 month · **XL** > 1 month (one person).

---

## 1. The discriminating experiments (run these first)

> These four distinguish _competing architectures_, not competing features. They are ranked by
> information gained per hour spent.

### E-03 — Does the official LFM audio path survive a full-length song?

|                       |                                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**          | The community llama.cpp adapter holds 1.3–2.3 % WER from 30 s to 180 s; the official `liquid-audio` path is reported to degrade to 83 % at 120 s and 296 % at 180 s. **Does that reproduce on Windows, on our runtime?**                                       |
| **Hypothesis**        | The degradation is a _runtime_ property (single-pass attention over unbounded audio), not a weight property, and therefore reproduces on every platform. If so, the llama.cpp/GGUF path is **mandatory**, not optional.                                        |
| **Method**            | 10 songs × {30 s, 120 s, 180 s, 240 s} segments, same content, two runtimes: (a) `liquid-audio` PyTorch path, (b) llama.cpp GGUF Q4_0. Measure WER against ground-truth lyrics. Add the **Windows** condition — the published measurement is Linux/CUDA/macOS. |
| **Metric**            | WER and **degeneration rate** (output longer than input) vs segment length, per runtime                                                                                                                                                                        |
| **Baseline**          | The published community numbers (RTF 0.077 CPU Q4_0; WER 2.8 % → 296 %)                                                                                                                                                                                        |
| **Accept**            | Official path degrades (WER > 20 % at 120 s) **and** llama.cpp holds (≤ 5 % at 240 s) on Windows → the GGUF path is mandatory for any song-length feature                                                                                                      |
| **Kill**              | Official path holds ≤ 10 % WER at 240 s → the community finding does not reproduce → the official path becomes an acceptable option and the llama.cpp dependency drops away                                                                                    |
| **Effort / hardware** | **M** · CPU only (16 threads), ~20 GB disk for the model pack                                                                                                                                                                                                  |
| **Changes**           | Whether `LFM2.5-Audio` can be used for _any_ full-length vocal work in ZYVO — and whether ZYVO needs a chunked-transcription architecture at all                                                                                                               |
| **Why first**         | It is the cheapest experiment that can _invalidate_ a whole capability class                                                                                                                                                                                   |

### E-07 — Can any DSP feature separate "more tense" from "less tense"?

|                |                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**   | K-6 promises tension planning. Is "tension" measurable from the audio, or is it a label only a musician can assign?                                                                                                                                                                                                                                                                                                           |
| **Hypothesis** | A **human** can reliably distinguish tense from non-tense variants, but **no** combination of existing DSP/MIR features (spectral flux, onset density, harmonic complexity, dynamic range, register spread, LUFS profile) predicts that judgement above chance.                                                                                                                                                               |
| **Method**     | 20 base regions → 3 variants each (deterministic tension moves, K-6) = 60 pairs. **Blinded pairwise listening** to establish the human label, then fit the best possible feature combination on the labels and measure held-out pairwise accuracy. **PANEL: n = 2** (Daniel + one other) — see D-22. The result is **directional, never release-gating**, and the write-up must say "n = 2, directional only" in the finding. |
| **Metric**     | (a) human pairwise win rate for the "tense" variant; (b) best-feature-set accuracy vs the human label                                                                                                                                                                                                                                                                                                                         |
| **Baseline**   | 50 % (chance)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Accept**     | Human win rate ≥ 70 % **and** feature accuracy ≥ 60 % → tension planning can _report_ a change honestly                                                                                                                                                                                                                                                                                                                       |
| **Kill**       | Human win rate < 60 % (the moves do not actually create tension) **or** feature accuracy < 55 % (tension is not measurable from the audio) → **K-6 ships without a tension claim**, and the feature reports the dimension it changed instead of claiming an emotional outcome                                                                                                                                                 |
| **Effort**     | **M** (rendering) + **M** (listening protocol) · CPU                                                                                                                                                                                                                                                                                                                                                                          |
| **Changes**    | Whether the flagship KYX capability is a _measurement_ or a _set of moves_. This is the difference between a marketing claim and an honest one.                                                                                                                                                                                                                                                                               |
| **Note**       | This experiment's kill criterion is the most likely one to fire, and that is **fine** — it is cheaper than shipping a claim that does not survive a listener.                                                                                                                                                                                                                                                                 |

### E-11 — Does a learned project embedding beat the typed project graph?

|                       |                                                                                                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**          | Alt-4 in the architecture doc: is a learned embedding of the project better than reading the typed graph?                                                                                                                                                               |
| **Hypothesis**        | For the operations that matter (choosing _which_ region/clip to edit), the typed graph plus deterministic features **matches or beats** a learned project embedding, because the relevant signal is structural.                                                         |
| **Method**            | 150 edit-target cases across 20 projects, human-labelled target (the region the user actually edited for a given brief). Baseline: typed-graph retrieval (roles, key, tempo, energy, section map). Challenger: a small encoder over the same project. Split by project. |
| **Metric**            | Top-1 and top-3 target accuracy on the held-out projects                                                                                                                                                                                                                |
| **Baseline**          | Typed-graph retrieval                                                                                                                                                                                                                                                   |
| **Accept**            | The learned embedding wins by **≥ 10 points absolute** → Alt-4 becomes a research bet with a measured justification                                                                                                                                                     |
| **Kill**              | < 5 points → **the typed graph stays**, permanently, and the most expensive idea in the program is closed                                                                                                                                                               |
| **Effort / hardware** | **L** · 8 GB VRAM for the challenger, minutes to train                                                                                                                                                                                                                  |
| **Changes**           | Whether the AAW needs a learned world model at all — the single most expensive architectural decision                                                                                                                                                                   |

### E-01 — English ASR accuracy on **lyrics**, not read speech

|                       |                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**          | `LFM2.5-Audio-1.5B` publishes WER 7.53 avg (read speech, vendor-reported). What does it do on **sung** English, and does it beat `whisper-large-v3-turbo` (7.44 avg, MIT)?                                                                  |
| **Hypothesis**        | Both degrade substantially on singing; neither wins decisively; the deterministic/Whisper path remains the practical default and LFM2.5-Audio is not justified for transcription.                                                           |
| **Method**            | 30 min of licensed English vocal recordings (dry, and through a realistic mix chain), ground-truth lyrics; run Whisper-turbo, Whisper-large-v3, LFM2.5-Audio (GGUF) — on both the **official** and the **llama.cpp** runtimes (E-03 first). |
| **Metric**            | WER on singing vs WER on the same audio read aloud (the delta is the interesting number)                                                                                                                                                    |
| **Baseline**          | Whisper-large-v3-turbo (MIT, `sk`+`cs` support)                                                                                                                                                                                             |
| **Accept**            | LFM2.5-Audio is ≥ 20 % relatively better on singing **and** holds on long audio → it becomes the ZYVO transcription path                                                                                                                    |
| **Kill**              | Within ±10 % of Whisper → **keep Whisper**; the 1.07 GB LFM pack buys nothing that a 0.8 GB MIT model does not, and the $10M licence question never arises                                                                                  |
| **Effort / hardware** | **M** · CPU, ~4 GB disk                                                                                                                                                                                                                     |
| **Changes**           | Whether the audio model is adopted at all                                                                                                                                                                                                   |

---

## 2. The Slovak path

### E-02 — Whisper on sung Slovak

|                |                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**   | What is Whisper's WER on **sung Slovak**, and how does it compare to read Slovak?                                                                                                                             |
| **Hypothesis** | Sung Slovak WER is 2–4× read WER; the model handles standard sung vowels well and fails on consonant clusters, melismas, and breath.                                                                          |
| **Method**     | 20 min of performer-owned Slovak vocal recordings (properly consented), ground-truth lyrics, human double-annotated. Compare `whisper-large-v3-turbo` vs `whisper-large-v3`. Report per-phrase error classes. |
| **Metric**     | WER; error breakdown (homophone, segmentation, diacritic, melisma, noise)                                                                                                                                     |
| **Baseline**   | Read-Slovak WER for the same model                                                                                                                                                                            |
| **Accept**     | WER ≤ 12 % → the ZYVO lyric-alignment feature (Z-5) is buildable with Whisper alone                                                                                                                           |
| **Kill**       | WER > 20 % → Z-5 needs a fine-tune (T-1) before it is worth building; deprioritise                                                                                                                            |
| **Effort**     | **M** · CPU · **requires a consented corpus — start collecting now**                                                                                                                                          |
| **Changes**    | Whether Z-5 is a 1-week feature or a 3-month project                                                                                                                                                          |

### E-13 — Is ACE-Step 1.5 Slovak-capable?

|                |                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**   | ACE-Step 1.5 claims "50+ languages" but does not enumerate them. Does it include Slovak?                                                                                         |
| **Hypothesis** | Probably not, or badly. If it is, a Slovak-capable _generative_ path changes the competitive position materially.                                                                |
| **Method**     | Read the model card's language list and the repo's caption/tokenizer vocabulary; then generate 20 Slovak prompts and have a native speaker score intelligibility and musicality. |
| **Metric**     | Intelligibility + musicality (blinded, native Slovak listeners)                                                                                                                  |
| **Accept**     | ≥ 60 % of prompts produce intelligible Slovak → a Slovak generation capability is a genuine differentiator                                                                       |
| **Kill**       | < 30 % intelligible → the generative path stays English-first and the product's Slovak value is elsewhere                                                                        |
| **Effort**     | **S** for the card inspection, **M** for the listening part · 8–12 GB VRAM for generation                                                                                        |
| **Changes**    | The scope of K-3/K-8 in a Slovak-first product                                                                                                                                   |

---

## 3. The deployment-path experiments

### E-04 — Can a 2.1 GB speech model live in a browser?

|                       |                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**          | Liquid documents running LFM2.5-Audio-1.5B in-browser with WebGPU. Does it work on **Windows Chrome/Edge** and **Safari**, at what first-audio latency, and what memory ceiling?        |
| **Hypothesis**        | It works in Chromium with WebGPU; first-audio latency is 5–20 s after a 2.1 GB download; Safari's WebGPU is weaker and likely out.                                                      |
| **Method**            | The published `onnxruntime-web` WebGPU example with the Q4 decoder + Q4 vocoder; measure download, load, first-audio latency, sustained RTF, and peak memory. Test Chromium and Safari. |
| **Metric**            | First-audio latency; RTF; peak memory; download size                                                                                                                                    |
| **Baseline**          | The browser ONNX intent model already shipped (~6.75 MB) — the _download-budget_ comparison is the real one                                                                             |
| **Accept**            | RTF < 1 in Chromium **and** first-audio < 10 s after download → a browser speech feature is feasible as an **opt-in, explicit download**                                                |
| **Kill**              | RTF > 1 in Chromium, or the download exceeds a user tolerance threshold → the speech model is desktop-only (or not at all)                                                              |
| **Effort / hardware** | **M** · 16 GB RAM, WebGPU-capable GPU                                                                                                                                                   |
| **Changes**           | Whether KYX Web can host a speech model — and therefore whether the product's AI story is browser-only or desktop-only                                                                  |

### E-05 — Can a speech model call a DAW's tools?

|                       |                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**          | `liquid-audio` v1.2.0 documents fine-tuning for **function calling**. After fine-tuning on ~100 DAW commands, can the model emit valid, correctly-scoped calls?              |
| **Hypothesis**        | Function-call _format_ will be learnable (the repo's own SFT result: 25/32 schema passes); correct _argument_ selection will be much weaker.                                 |
| **Method**            | 100–200 consented command utterances (EN + SK) → `ChatMessage` dataset → LoRA fine-tune → evaluate against the deterministic intent parser on the same golden set (Suite A). |
| **Metric**            | Schema validity; **tool-selection accuracy vs the deterministic baseline**; argument exactness                                                                               |
| **Baseline**          | The repo's deterministic intent parser + the existing SFT adapter (75 % exact on val)                                                                                        |
| **Accept**            | The speech path beats the deterministic parser by ≥ 10 points on tool selection **and** adds hands-free value the parser cannot offer                                        |
| **Kill**              | ≤ the deterministic parser → **voice control is not a frontier feature**; a voice _transcription_ of a typed command is enough (and much cheaper)                            |
| **Effort / hardware** | **L** · 8–16 GB VRAM, ~4 GPU-hours                                                                                                                                           |
| **Changes**           | Whether voice is an AAW interface at all, or only a transcription convenience                                                                                                |

---

## 4. The perception and routing experiments

### E-12 — Can `d1-omni-600M` act as a DAW action router?

|                       |                                                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**          | The newest Liquid model (2026-10-05) _listens and decides_: audio+vision in, a discrete action out, 587 M params, GGUF/MLX, CPU-runnable. Is it better than the text router for deciding _what to do_?                  |
| **Hypothesis**        | For **routing** (which capability family), a small audio-aware decision model beats a text router, because it can hear that the user is playing a loop vs editing a parameter. For **argument selection**, it does not. |
| **Method**            | 300 cases: an audio clip + a selection + a short utterance → the expected capability family. Compare: (a) text router (current), (b) `d1-omni-600M`, (c) an audio-feature classifier (deterministic).                   |
| **Metric**            | Routing accuracy; CPU latency per decision                                                                                                                                                                              |
| **Baseline**          | The current deterministic + text router                                                                                                                                                                                 |
| **Accept**            | ≥ 8 points better than the text router at ≤ 100 ms CPU → a new architecture is worth evaluating further                                                                                                                 |
| **Kill**              | Within noise of the text router → the audio-LM route is closed; keep deterministic routing                                                                                                                              |
| **Effort / hardware** | **M** · CPU (GGUF)                                                                                                                                                                                                      |
| **Changes**           | Whether an AAW's "understanding" needs to hear the audio at all — the most interesting architectural question in this backlog                                                                                           |

### E-06 — Embedding retrieval for the project library, measured

|                |                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Question**   | Does embedding v3 (which passes the repo's mood/style pair tests) actually retrieve the _right_ sound for a real prompt?                                                       |
| **Hypothesis** | Recall@5 ≥ 70 % on a 100-prompt human-labelled set; the failure mode is style-vs-mood confusion, not general quality.                                                          |
| **Method**     | 100 realistic prompts ("warm and slightly broken hats", "cold metallic stab") × the factory library; human relevance judgements; report Recall@1/@5 and the confusion pattern. |
| **Metric**     | Recall@k, MRR                                                                                                                                                                  |
| **Baseline**   | Metadata/tag search (the existing path)                                                                                                                                        |
| **Accept**     | Recall@5 ≥ 70 % **and** ≥ 25 points over metadata search → K-1 ships as a headline feature                                                                                     |
| **Kill**       | < 10 points over metadata search → embedding retrieval is not worth its download and inference cost; metadata + filters win                                                    |
| **Effort**     | **S–M** · CPU                                                                                                                                                                  |
| **Changes**    | Whether K-1 is a differentiator or a gimmick — and it is cheap to find out                                                                                                     |

### E-14 — How accurate is the AudioSet tagger that already ships?

|                |                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**   | KYX already classifies every sample with an AudioSet/AST tagger (`src/sample-library/audio-index.ts`) and turns a reference track into intent conditioning (`src/intent/audio-reference.ts`). **How accurate is it?**                                                                                                                     |
| **Hypothesis** | Strong on the drum/bass/perc palette it was chosen for (the AudioSet classes _are_ that palette) and weak on anything textural — so the label-mediated bridge is a good foundation for library search and a bad one for timbral search.                                                                                                   |
| **Method**     | 120 labelled clips (the factory bank plus reference tracks): human label set vs the top-K AudioSet labels, per-class precision@1/@3; then the end-to-end question — does the current query → label → rank path return the asset the user meant? Report the **search** hit rate separately: that is the number the product actually feels. |
| **Metric**     | Per-class precision@1/@3; top-1 hit rate on the library query path                                                                                                                                                                                                                                                                        |
| **Baseline**   | The human label set (ground truth). The shipped path is the **candidate under test**, not the baseline                                                                                                                                                                                                                                    |
| **Accept**     | Top-1 ≥ 80 % on the drum/bass palette → the tagger is a shipped foundation and K-1 can be built on it                                                                                                                                                                                                                                     |
| **Kill**       | Top-1 < 60 % → the tagger cannot carry library search; the label-mediated bridge is dropped and E-06 (audio embeddings) becomes a prerequisite rather than an option                                                                                                                                                                      |
| **Effort**     | **S** · CPU (the model is already local — `npm run audio:fetch`)                                                                                                                                                                                                                                                                          |
| **Changes**    | Whether K-1 (timbral search) is "an AudioSet index plus better queries" (weeks) or "an audio embedding layer" (months) — and whether this program's perception claims are safe to make in public                                                                                                                                          |

### E-08 — Preview-to-commit parity under real edits

|                |                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**   | Does the preview audio equal the committed audio, byte for byte, across the capability set?                                                     |
| **Hypothesis** | Yes for deterministic capabilities; **no** for anything that regenerates audio (the second render differs).                                     |
| **Method**     | For each capability in the registry: preview → commit → compare rendered output hashes and structural diffs; also test the stale-revision path. |
| **Metric**     | % of capabilities with identical preview/commit output                                                                                          |
| **Baseline**   | The contract's requirement ("apply exactly what was auditioned")                                                                                |
| **Accept**     | 100 % — and where a capability cannot achieve it, it is **marked `previewIsExact: false`** and the UI says so                                   |
| **Kill**       | Any capability that silently differs → it is removed from the registry until fixed                                                              |
| **Effort**     | **M** · CPU                                                                                                                                     |
| **Changes**    | The trust foundation of the whole program. Cheap, mechanical, non-negotiable.                                                                   |

---

## 5. The product-value experiments

### E-09 — Do multi-variant A/B proposals help or annoy?

|                |                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Question**   | Does offering 2–3 variants (K-4) produce more accepted work than offering one?                                                              |
| **Hypothesis** | Yes on acceptance rate and time-to-decision, **and** it increases rejection volume (J-3) — the trade-off must be quantified.                |
| **Method**     | 12 users × 5 briefs; single-variant vs multi-variant; instrument decision time, accept/reject, later-undo rate, and post-task satisfaction. |
| **Metric**     | J-1 time saved; J-3 rejection rate; J-6 later-undo rate; satisfaction                                                                       |
| **Baseline**   | Single deterministic proposal (current behaviour)                                                                                           |
| **Accept**     | ≥ 20 % time saved **and** later-undo rate not worse → multi-variant ships                                                                   |
| **Kill**       | Time saved < 10 % **or** rejection rate > 60 % → one proposal plus a "show alternatives" affordance is better                               |
| **Effort**     | **M** · human subjects · consent required                                                                                                   |
| **Changes**    | The default interaction model of the product                                                                                                |

### E-10 — Does the whole AAW loop beat manual editing?

|                |                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Question**   | The red-team question: _"what if tool orchestration is slower and less reliable than manual editing?"_                                                                                           |
| **Hypothesis** | For tasks the feature targets, the assisted path is ≥ 20 % faster in median time and the results are preferred ≥ 60 % of the time; for tasks it does not target, it is **not slower by > 10 %**. |
| **Method**     | 12 users, 5 representative tasks, within-subject counterbalanced design, assisted vs manual. Measure wall-clock, error count, and preference.                                                    |
| **Metric**     | J-1 (time), D-1 (preference), error count, satisfaction                                                                                                                                          |
| **Baseline**   | Manual editing in the same DAW                                                                                                                                                                   |
| **Accept**     | ≥ 20 % median time reduction on targeted tasks **and** ≤ 10 % slowdown on untargeted tasks                                                                                                       |
| **Kill**       | Any task where the assisted path is slower → that capability is dropped, regardless of how good it looks                                                                                         |
| **Effort**     | **M** · human subjects                                                                                                                                                                           |
| **Changes**    | Whether the entire program is worth building. **This is the experiment that decides the product.**                                                                                               |

---

## 6. Experiments deliberately NOT in this backlog

| Idea                                                     | Why not                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Does a big LLM write better briefs than the small one?" | The repo already measures 75 % exact-match on the intent corpus; the binding constraint is not brief quality but proposal validity. Revisit only if Suite A fails                                                                                                                                                                                     |
| "Can we auto-tag our library?"                           | **Already shipped** (corrected 2026-10-26): an AudioSet/AST tagger classifies every factory and user sample (`src/sample-library/audio-index.ts`), and the model is fetched locally by `npm run audio:fetch`. The open question is not _whether_ to tag but whether the tagger is **accurate enough** — and no accuracy measurement exists → **E-14** |
| "Train a better embedding model"                         | Not until E-06 shows the _current_ embedding loses to metadata search. No baseline, no training                                                                                                                                                                                                                                                       |
| "Compare LFM2.5-24B vs 1.2B for planning"                | The 24B model is 24 GB and needs a server; the product is local-first. The comparison is not affordable at this tier                                                                                                                                                                                                                                  |
| "Should the browser bundle the intent ONNX model?"       | Already decided by the bundle budget; not an experiment                                                                                                                                                                                                                                                                                               |

---

## 7. Execution order

| Slot   | Experiment         | Why this slot                                                                |
| ------ | ------------------ | ---------------------------------------------------------------------------- |
| **1**  | **E-03**           | Cheapest experiment that can invalidate a capability class                   |
| **2**  | **E-07**           | Decides whether the flagship capability is a measurement or a claim          |
| **3**  | **E-06**           | Cheap, high-visibility, and likely to ship                                   |
| **4**  | **E-14**           | **S**, the model is already local — measures a capability that already ships |
| **5**  | **E-01**           | Decides the audio model question (and the licence question)                  |
| **6**  | **E-11**           | Closes or opens the most expensive architectural idea                        |
| **7**  | **E-02**           | Needs a consented corpus → start collecting in parallel, run in month 2      |
| **8**  | **E-08**           | Mechanical; run continuously from Wave 0                                     |
| **9**  | **E-12**           | The most interesting architectural question; run when the runtime is stable  |
| **10** | **E-04**           | Decides browser feasibility; needs hardware time                             |
| **11** | **E-09**, **E-10** | Human-subject work; run once there is a feature worth testing                |
| **12** | **E-05**, **E-13** | Expensive; run only if their predecessors pass                               |
