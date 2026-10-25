# Model Landscape Evidence — AI-Assisted Audio Workstation

**Compiled:** 2026-10-25 (Central European Summer Time)
**Research cutoff:** 2026-10-25 — every time-sensitive claim below is timestamped with the date observed and the source URL.
**Compiled by:** research analyst (delegated task), for the KYX / Pulse Forge frontier report.

## How to read this document

- **Every factual row carries a URL.** I fetched primary sources directly: Hugging Face model cards (`/raw/main/README.md`), HF API metadata (`/api/models/<id>`), GitHub repo API, arXiv abstract pages, vendor blogs.
- **Dates.** Unless a model card or vendor post states a release date explicitly, I report the **Hugging Face repository `createdAt` timestamp from the HF API**, labelled as such. That is a repository-creation timestamp, not necessarily the vendor-announced release date. Where a vendor states a date in prose, I quote it and attribute it.
- **Vendor vs independent.** Benchmark numbers inside a vendor's own model card are labelled **vendor-reported**. I found no independent third-party re-evaluation of most of these checkpoints; where that is the case I say so explicitly.
- **Licensing is treated as a first-class finding**, because for a commercial DAW it is often more binding than model quality.
- **"NOT VERIFIED"** means I could not confirm the claim from a primary source in this session. I do not guess.

### Evidence grades

| Grade | Meaning                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------- |
| **A** | Official primary source: model card, repo README/LICENSE, arXiv abstract, vendor documentation.                  |
| **B** | Reputable secondary or independent evaluation (third-party benchmark, peer-reviewed paper, independent bench).   |
| **C** | Secondary report without primary confirmation (press/blog aggregation, metadata inference, partial page access). |
| **U** | Unverified — could not confirm from any source reached in this session.                                          |

### Replacement-cost rubric (used in the dossiers)

| Cost       | Definition                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| **Low**    | Permissive license, weights widely mirrored, no unique capability, or a trivially trainable equivalent exists.  |
| **Medium** | Permissive license but large training cost, single-vendor dependency, or no drop-in equivalent.                 |
| **High**   | Unique capability _and_ restrictive license _and/or_ no equivalent exists — losing it breaks a product surface. |

---

## 0. MANDATORY VERIFICATION — "LFM 2.5 Audio 1.5B"

### 0.1 Verdict

**The candidate exists as described. Verdict: (i) exists as described.**

`LiquidAI/LFM2.5-Audio-1.5B` is a real, public, open-weight model. The plan's name is correct and matches the real repo id. It is **audio-in / audio-out**, so it is _not_ a substitute for the text-only LFM2.5 that KYX already runs.

| Property          | Value                                                                                                                                                                                                     | Source (observed 2026-10-25)                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Exact repo id     | `LiquidAI/LFM2.5-Audio-1.5B`                                                                                                                                                                              | https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B                        |
| HF repo created   | **2025-12-18** (last modified 2026-03-30)                                                                                                                                                                 | https://huggingface.co/api/models/LiquidAI/LFM2.5-Audio-1.5B             |
| Org               | Liquid AI                                                                                                                                                                                                 | same                                                                     |
| Parameters        | **1.5B total** (model card: "Parameters (LM only) — 1.2B"); HF safetensors total = 1,470,308,496                                                                                                          | https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B/raw/main/README.md     |
| Architecture      | Pretrained LFM2.5 backbone + **FastConformer audio encoder (115M, from `nvidia/canary-180m-flash`)** + RQ-transformer discrete tokens + **Mimi-compatible audio detokenizer (8 codebooks)**               | same                                                                     |
| Context           | **32,768 tokens** (model card)                                                                                                                                                                            | same                                                                     |
| Audio I/O         | **Yes — audio-to-audio.** Output 24 kHz                                                                                                                                                                   | same                                                                     |
| Languages         | **English only** (model card: "Supported languages: English")                                                                                                                                             | same                                                                     |
| License           | **LFM Open License v1.0** (`license_name: lfm1.0`, HF tag `license:other`)                                                                                                                                | https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B/raw/main/LICENSE       |
| Inference stack   | `liquid-audio` pip package; **llama.cpp-compatible GGUFs**; **ONNX** build                                                                                                                                | README + https://github.com/Liquid4All/liquid-audio                      |
| Fine-tuning       | **Yes** — `liquid-audio` v1.2.0 ships data-prep tools + a lightweight trainer; supports interleaved **and** sequential modes; documented for ASR, TTS, function calling, end-to-end speech-to-speech chat | https://github.com/Liquid4All/liquid-audio (README "Finetuning" section) |
| Vendor benchmarks | **VoiceBench (audio input) Overall 54.92**; **ASR WER average 7.53** across AMI / Earnings22 / GigaSpeech / LibriSpeech-clean / LibriSpeech-other / SPGISpeech / TED-LIUM / VoxPopuli                     | model card                                                               |
| Grade             | **A**                                                                                                                                                                                                     | —                                                                        |

Vendor-reported benchmark table as published on the model card (observed 2026-10-25), reproduced verbatim because the comparison set matters:

| Model             | Size | VoiceBench Overall | ASR WER avg |
| ----------------- | ---- | ------------------ | ----------- |
| LFM2.5-Audio-1.5B | 1.5B | **54.92**          | **7.53**    |
| LFM2-Audio-1.5B   | 1.5B | 52.77              | 9.38        |
| Moshi             | 7B   | 29.51              | —           |
| Qwen2.5-Omni-3B   | 5B   | 63.57              | 7.90        |
| Whisper-large-V3  | 1.5B | — (ASR only)       | 7.44        |

**Read this honestly:** LFM2.5-Audio-1.5B is _not_ the accuracy leader — Qwen2.5-Omni-3B beats it on VoiceBench and Whisper-large-v3 edges it on WER. Its claimed advantage is **footprint and latency** (1.5B vs 5B vs 7B, with a llama.cpp CPU path and a fine-tuning recipe), not raw quality. The numbers are **vendor-reported**; I found no independent re-evaluation.

### 0.2 Is there a "1.5B" LFM variant?

**Yes — two, both audio:**

| Repo id                      | HF repo created | Pipeline       | Params        | License                                 |
| ---------------------------- | --------------- | -------------- | ------------- | --------------------------------------- |
| `LiquidAI/LFM2-Audio-1.5B`   | 2025-08-28      | audio-to-audio | 1,470,308,496 | LFM Open License v1.0 (`license:other`) |
| `LiquidAI/LFM2.5-Audio-1.5B` | 2025-12-18      | audio-to-audio | 1,470,308,496 | LFM Open License v1.0 (`license:other`) |

Source: https://huggingface.co/api/models?author=LiquidAI (observed 2026-10-25).
The only "1.5B" Liquid naming in the family is on the **audio** models; the LFM2.5 text models are sized 230M / 350M / 1.2B / 2.6B / 8B-A1B / 24B-A2B.

Related: `LiquidAI/LFM2.5-Audio-1.5B-JP` (Japanese variant, HF repo created **2026-05-26**, `audio-to-audio`, same LFM license) — https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B-JP. Its GGUF sibling `LiquidAI/LFM2.5-Audio-1.5B-JP-GGUF` was created 2026-05-27 and is the **most-downloaded Liquid audio artefact** observed (258,120 downloads/month vs 217,881 for the English GGUF) — strong evidence that Japanese users actually run this model on CPU. Relevant if KYX ever needs a non-English local speech path, though neither is Slovak/Czech.

### 0.3 Does Liquid AI publish audio- or speech-capable models?

**Yes — a full audio line, plus a multimodal decision-model line.**

| Repo id                                | Created    | Role                                                                        | Params      | License  |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------- | ----------- | -------- |
| `LiquidAI/LFM2-Audio-1.5B`             | 2025-08-28 | Audio-LM (S2S)                                                              | 1.47B       | LFM v1.0 |
| `LiquidAI/LFM2.5-Audio-1.5B`           | 2025-12-18 | Audio-LM (S2S)                                                              | 1.47B       | LFM v1.0 |
| `LiquidAI/LFM2.5-Audio-1.5B-GGUF`      | 2026-01-06 | llama.cpp build                                                             | —           | LFM v1.0 |
| `LiquidAI/LFM2.5-Audio-1.5B-GGUF-LEAP` | 2026-01-05 | llama.cpp build                                                             | —           | LFM v1.0 |
| `LiquidAI/LFM2.5-Audio-1.5B-ONNX`      | 2026-01-26 | ONNX Runtime build                                                          | —           | LFM v1.0 |
| `LiquidAI/LFM2.5-Audio-1.5B-JP`        | 2026-05-26 | Audio-LM (Japanese)                                                         | 1.47B       | LFM v1.0 |
| `LiquidAI/d1-omni-600M`                | 2026-10-05 | **Audio+vision decision model** (no output tokens; emits a discrete action) | 587,161,089 | LFM v1.0 |

Source: https://huggingface.co/api/models?author=LiquidAI (observed 2026-10-25).

`d1-omni-600M` deserves a second look for a DAW: its HF tags include `audio` and `vision`, it has a **16,384-token context**, it **emits no output tokens** (it scores/classifies rather than generates), and it is available as GGUF and MLX — i.e. it is CPU-runnable. It is the closest thing Liquid ships to a "small model that listens and decides", which is structurally the same shape as a DAW action router. Caveat from its own card: its **audio** training data is English, and its text-language tags include Polish and Russian but **no Slovak or Czech**.
Source: https://huggingface.co/LiquidAI/d1-omni-600M (observed 2026-10-25). Grade **A**.

### 0.4 What IS the LFM2.5 family?

The flagship LFM2.5 model is **TEXT-ONLY**. Verified directly from the vendor's own model card.

| Repo id                         | HF repo created | Params                                                  | Context              | Pipeline           | License               |
| ------------------------------- | --------------- | ------------------------------------------------------- | -------------------- | ------------------ | --------------------- |
| `LiquidAI/LFM2.5-1.2B-Instruct` | 2026-01-06      | **1,170,340,608** (card: "Number of parameters: 1.17B") | 32,768 tokens (card) | text-generation    | LFM Open License v1.0 |
| `LiquidAI/LFM2.5-1.2B-Base`     | 2026-01-05      | 1,170,340,608                                           | —                    | text-generation    | LFM v1.0              |
| `LiquidAI/LFM2.5-1.2B-Thinking` | 2026-01-20      | 1,170,340,608                                           | —                    | text-generation    | LFM v1.0              |
| `LiquidAI/LFM2.5-1.2B-JP`       | 2026-01-04      | 1,170,340,608                                           | —                    | text-generation    | LFM v1.0              |
| `LiquidAI/LFM2.5-350M`          | 2026-03-31      | 354,483,968                                             | —                    | text-generation    | LFM v1.0              |
| `LiquidAI/LFM2.5-230M`          | 2026-06-24      | 229,693,184                                             | —                    | text-generation    | LFM v1.0              |
| `LiquidAI/LFM2.5-2.6B`          | 2026-07-28      | 2,697,198,592                                           | —                    | text-generation    | LFM v1.0              |
| `LiquidAI/LFM2.5-8B-A1B`        | 2026-05-28      | 8,467,856,832                                           | —                    | text-generation    | LFM v1.0              |
| `LiquidAI/LFM2.5-24B-A2B`       | 2026-10-12      | 23,971,585,280                                          | —                    | text-generation    | LFM v1.0              |
| `LiquidAI/LFM2.5-VL-1.6B`       | 2026-01-05      | 1,596,625,904                                           | —                    | image-text-to-text | LFM v1.0              |
| `LiquidAI/LFM2.5-VL-450M`       | 2026-04-08      | 448,718,848                                             | —                    | image-text-to-text | LFM v1.0              |

Sources: https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct/raw/main/README.md and https://huggingface.co/api/models?author=LiquidAI (observed 2026-10-25). Grade **A**.

> **Discrepancy worth flagging (observed 2026-10-25):** the model card states "**Context length: 32,768 tokens**", while the repo's own `config.json` declares `"max_position_embeddings": 128000`. Use the card's 32,768 as the conservative figure.
> Source: https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct/raw/main/config.json

Also worth flagging: `LiquidAI/LFM2.5-Audio-1.5B`'s model card says the backbone is "a pretrained **LFM2.5** model", but the HF metadata for that repo declares `base_model: LiquidAI/LFM2-1.2B`. Both are on the same page pair; treat "LFM2 vs LFM2.5 backbone" as an unresolved wording discrepancy. Grade **A** for both observations, **U** for which is intended.

### 0.5 Is the flagship LFM2.5 model TEXT-ONLY?

**Yes.** Verbatim from Liquid AI's own model card (observed 2026-10-25):

> "LFM2.5-1.2B-Instruct is a general-purpose **text-only** model with the following features:"

- Number of parameters: **1.17B**
- Context length: **32,768 tokens**
- Languages: **English, Arabic, Chinese, French, German, Japanese, Korean, Spanish**
- Fast edge inference: **239 tok/s decode on AMD CPU, 82 tok/s on mobile NPU. Runs under 1GB of memory** with day-one support for **llama.cpp, MLX, and vLLM** (vendor claim)
- Tool use: writes **Pythonic function calls** between `<|tool_call_start|>` / `<|tool_call_end|>`; JSON function calls can be requested via the system prompt
- Fine-tuning recipes (documented, with links): **SFT with LoRA via Unsloth**, **SFT with LoRA via TRL**, **DPO with LoRA via TRL**; also CPT / GRPO mentioned in the roadmap table
- Optional **DSpark** speculative-decoding drafter (`LiquidAI/LFM2.5-1.2B-Instruct-DSpark`, 295,725,953 params) for "~2.1x faster decoding in SGLang and ~2.5x on Apple silicon via Metal with exactly the same outputs" (vendor claim)

Source: https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct/raw/main/README.md — Grade **A**.

**Multilingual note:** the LFM2.5-1.2B-Instruct language list **does not include Slovak or Czech**. Language coverage stops at en/ar/zh/fr/de/ja/ko/es. For a Slovak-speaking user base this is a real limitation to state plainly, and the repo's own approach (deterministic pre-filter + constrained decoding, per `docs/LOCAL-INTENT-MODEL.md` §3) is the correct mitigation.

### 0.6 Does the KYX repo's characterization match Liquid's documentation?

**Yes — the characterization matches, with one naming inconsistency to fix.**

| Repo statement                                                                 | Location                                                                                                     | Verdict                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uses `LiquidAI/LFM2.5-1.2B-Instruct`                                           | `docs/IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md:614` (snapshot `0f604ada3f766f9f257460c4c9f0b5d6f69d431b`) | **Confirmed.** The pinned revision resolves on HF to `LiquidAI/LFM2.5-1.2B-Instruct`, repo created 2026-01-06. Verified via `https://huggingface.co/api/models/LiquidAI/LFM2.5-1.2B-Instruct/revision/0f604ada3f766f9f257460c4c9f0b5d6f69d431b` (observed 2026-10-25). Grade **A**. |
| Characterized as a **TEXT-only** intent-to-plan model                          | `docs/LOCAL-INTENT-MODEL.md` (whole doc)                                                                     | **Matches Liquid's documentation.** Liquid's card says "text-only" explicitly. Grade **A**.                                                                                                                                                                                         |
| Runs via **Ollama** as the desktop path                                        | `docs/LOCAL-INTENT-MODEL.md:108-123`                                                                         | **Consistent.** `https://ollama.com/library/lfm2.5` exists (observed 2026-10-25) and is an official LiquidAI Ollama library entry. Grade **A**.                                                                                                                                     |
| Default Ollama model string is `hf.co/LiquidAI/LFM2-1.2B-GGUF:Q4_K_M` (730 MB) | `docs/LOCAL-INTENT-MODEL.md:113-114`                                                                         | **⚠ Naming inconsistency.** The repo's own documented default is **LFM2**-1.2B (no ".5"), while the doc heading and the roadmap name **LFM2.5**-1.2B. Both exist. Worth pinning one explicitly. Grade **A** (both model ids verified present on HF).                                |

**Additional check:** `https://ollama.com/library/lfm2.5-audio` returned **404** on 2026-10-25 — the LFM2.5 audio model is **not** in Ollama's library. Its CPU path is the `llama.cpp`-compatible GGUF (`LiquidAI/LFM2.5-Audio-1.5B-GGUF`) plus the `liquid-audio` package. If KYX wants local speech via Ollama, that model is **not** available there today.

### 0.7 🔴 The licensing finding that matters most for KYX

**The LFM Open License v1.0 caps commercial use at entities with under $10,000,000 in annual revenue.**

Verbatim from `LiquidAI/LFM2.5-1.2B-Instruct/raw/main/LICENSE` (observed 2026-10-25):

> **"Threshold" shall mean annual revenue of 10 million United States dollars ($10,000,000) or more.**
> **5(a)** The rights granted under this License for Commercial Use are conditioned upon You or Your Legal Entity not exceeding the Threshold.
> **5(b)** Any Commercial Use of the Work or a Derivative Work by a Legal Entity that exceeds the Threshold is not licensed under this Agreement.
> **5(c)** The Threshold shall not apply to a Qualified Non-Profit Organization's use of the Work or a Derivative Work for Non-Commercial or Research Purposes.

Other terms that matter:

- Grant of copyright licence is **perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable**, and includes the right to "reproduce, prepare Derivative Works of, publicly display, publicly perform, **sublicense, and distribute** the Work" — subject to the Section 5 cap.
- **Redistribution conditions:** give recipients a copy of the licence; retain copyright/patent/trademark/attribution notices in source form; if a NOTICE file exists, include a readable copy.
- **Patent grant** is included but **terminates automatically** for any contributor whose patent claims are licensed to a third party on terms that permit licensing to You.
- **Termination:** the licence terminates automatically and immediately on breach, requiring you to cease use and delete copies.

**Practical read for KYX:** shipping a KYX build that bundles `LFM2.5-1.2B-Instruct` (or the audio model) is fine while KYX's legal entity is under $10M annual revenue, and **not fine once it is not**. This is a _revenue-triggered_ licence cliff, not an attribution-only licence. For a product intended to scale, it is a material constraint on the current intent-model choice and worth an explicit ADR. Grade **A**.

> Note: `LiquidAI/LFM2.5-1.2B-Instruct-smoltalk-LoRA` (HF repo created 2026-01-19) carries the `apache-2.0` tag — but that is an **adapter**, not the base weights, and the base weights remain LFM v1.0. The adapter's permissiveness does not change the base model's terms.

---

## 1. Role A — Audio understanding / audio-language models

_(models that ingest audio and reason about it)_

### A1. LiquidAI/LFM2.5-Audio-1.5B — the on-device audio LM

Full dossier in §0.1. Summary of the remaining fields not covered there:

- **Streaming:** Yes, two documented modes. **Interleaved** (fixed text/audio token interleave; minimises time-to-first-audio and tokens generated — designed for real-time speech-to-speech on resource-constrained devices) and **sequential** (model decides when to switch modality via special tokens — suited to ASR and TTS). Source: https://github.com/Liquid4All/liquid-audio (README, observed 2026-10-25). Grade **A**.
- **VRAM/RAM:** No numeric VRAM figure is published for the audio model (unlike the text model, which claims "<1GB of memory"). The GGUF/llama.cpp path is the CPU story. **NOT VERIFIED** for an exact footprint figure. Reasonable estimate from the 1.47B bf16 safetensors total ≈ **~3 GB at bf16**, ~1 GB at Q4 — **estimated, not measured**.
- **Latency:** "Designed with low latency and real time conversation in mind" — vendor prose, **no numeric latency published**. **NOT VERIFIED** for a millisecond figure.
- **Fine-tuning:** supported via `liquid-audio` v1.2.0 (`examples/preprocess_*.py` + `examples/train.py`, `ChatMessage` interface). Documented tasks: ASR, TTS, function calling, end-to-end speech-to-speech chat. A TTS fine-tune walkthrough uses the Jenny TTS Dataset. Grade **A**.
- **Cost:** open weights, no hosting cost; the `liquid-audio` package is pip-installable.
- **Music-domain reliability:** **no music-specific benchmark published** on the card. The benchmarks are speech-centric (VoiceBench, ASR WER). This model is a **speech** model, not a music-understanding model. Grade **A** for the absence.
- **Replacement cost if it vanished tomorrow: HIGH.** It is the only 1.5B-class open audio-LM with (a) a llama.cpp CPU path, (b) an ONNX build, and (c) a first-party fine-tuning recipe. Losing it removes KYX's only realistic on-device speech feature.
- **Source:** https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B — Grade **A**.

### A2. Qwen/Qwen3-Omni-30B-A3B-Instruct — the accuracy leader, and the heavy one

- **Repo:** `Qwen/Qwen3-Omni-30B-A3B-Instruct`, Alibaba Qwen. **HF repo created 2025-09-20** (last modified 2025-09-22). https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct
- **Params:** **35,259,818,545** total (30B dense + 3B activated, MoE). https://huggingface.co/api/models/Qwen/Qwen3-Omni-30B-A3B-Instruct
- **License:** card front-matter reads `license: other` but `license_name: apache-2.0`. **Apache-2.0**, permissively — commercially usable. Grade **A**.
- **Modalities:** text, image, **audio**, video in; **text and natural speech out**. HF pipeline tag `any-to-any`. **Real-time streaming responses in both text and natural speech.**
- **Languages:** speech **input** — en, zh, ko, ja, de, ru, it, fr, es, pt, ms, nl, id, tr, vi, Cantonese, ar, ur. Speech **output** — en, zh, fr, de, ru, it, es, pt, ja, ko. **No Slovak, no Czech.** Grade **A**.
- **Benchmarks (vendor):** "Reaches SOTA on 22 of 36 audio/video benchmarks and open-source SOTA on 32 of 36; ASR, audio understanding, and voice conversation performance is comparable to Gemini 2.5 Pro." **Vendor-reported.**
- **Footprint:** **~35 GB of weights at bf16.** The card states that calling `model.disable_talker()` saves **about 10 GB** of GPU memory, at the cost of audio output. That is the single most important line for KYX: _thinker-only_ Qwen3-Omni is ~25 GB and still far too large for a consumer DAW.
- **Inference stack:** HF Transformers (with FlashAttention 2 recommended), **vLLM** (thinker only in `vllm serve`; `limit_mm_per_prompt` for image/video/audio pre-allocation), SGLang.
- **Fine-tuning:** yes — the card documents a downstream fine-tune recipe for the **Captioner** variant (`Qwen/Qwen3-Omni-30B-A3B-Captioner`, a downstream audio fine-grained caption model fine-tuned from the Instruct model), with a cookbook notebook.
- **Companion model:** `Qwen/Qwen3-Omni-30B-A3B-Captioner` — HF repo created **2025-09-15**, **31,719,205,488** params, `any-to-any`. Described as "a general-purpose, highly detailed, **low-hallucination** audio captioning model". **This is the most interesting Qwen artefact for a DAW**: audio → detailed structured text description.
- **Replacement cost: HIGH** (MoE, 35B, single vendor, but Apache-2.0 and fully open — the _capability_ is replaceable, the _footprint_ is not).
- Grade **A**.

### A3. moonshotai/Kimi-Audio-7B-Instruct — MIT-licensed audio understanding + generation

- **Repo:** `moonshotai/Kimi-Audio-7B-Instruct`, Moonshot AI. **HF repo created 2025-04-25**. https://huggingface.co/moonshotai/Kimi-Audio-7B-Instruct
- **Params:** **9,766,336,640**. **License: MIT** — the strongest commercial license in the audio-LM class. Card also notes the code is "based and modified from Qwen 2.5-7B" (Apache-2.0 parts) with the rest MIT.
- **Modalities:** audio in, text and/or speech out. HF pipeline tag `text-to-speech`.
- **Tasks (vendor):** ASR, audio question answering (AQA), audio captioning (AAC), speech emotion recognition (SER), sound event/scene classification (SEC/ASC), end-to-end speech conversation.
- **Benchmarks:** "Achieves SOTA results on numerous audio benchmarks" with a technical report PDF — **the card asserts SOTA but does not print the table**; the numbers live in the PDF. I did **not** open the PDF, so the specific figures are **NOT VERIFIED**. Grade **C** for the SOTA claim, **A** for the licence and modality facts.
- **Languages:** en, zh. **No Slovak/Czech.**
- **Replacement cost: MEDIUM.** MIT licence + 10B size = too heavy for consumer hardware but permissively usable.

### A4. nvidia/audio-flamingo-3-hf — best-documented open audio-understanding reasoning model, but non-commercial

- **Repo:** `nvidia/audio-flamingo-3-hf`, NVIDIA. **HF repo created 2025-10-24.** Params **8,267,215,360**. Pipeline `audio-text-to-text`. https://huggingface.co/nvidia/audio-flamingo-3-hf
- **License:** **NVIDIA OneWay Noncommercial License** (card links `static/NVIDIA_OneWay_Noncommercial_License.docx`). Card also notes portions of dataset generation are subject to the **Qwen Research License** and **OpenAI's Terms of Use**. **Not commercially usable.** Grade **A**.
- **Benchmarks (vendor):** "setting new benchmarks on over 20 public audio understanding and reasoning tasks." The card's evaluation section names **SoundDescs** and **AudioCaps** among the compared benchmarks. **Vendor-reported.**
- **Successor:** `nvidia/audio-flamingo-next-hf`, **HF repo created 2026-04-05**, same 8.27B scale, `audio-text-to-text`, `license:other`. https://huggingface.co/nvidia/audio-flamingo-next-hf
- **Replacement cost: MEDIUM-HIGH** for research use, **N/A** for a commercial product (licence excludes it).

### A5. microsoft/Phi-4-multimodal-instruct — MIT, and it speaks Czech

- **Repo:** `microsoft/Phi-4-multimodal-instruct`, Microsoft. **HF repo created 2025-02-24** (last modified 2025-12-10). Params **5,574,460,384**. Pipeline `automatic-speech-recognition` (it does ASR). https://huggingface.co/microsoft/Phi-4-multimodal-instruct
- **License: MIT** — fully commercial-friendly, no revenue cap.
- **Slovak/Czech: Czech (`cs`) is an explicitly supported language.** Slovak (`sk`) is **not** in its language list. This is one of only two entries in this landscape with verified Central-European coverage. Grade **A**.
- **Replacement cost: MEDIUM** (MIT + 5.6B, heavy but permissively licensed).

### A6. google/gemma-3n-E2B-it — audio in, Gemma licence

- **Repo:** `google/gemma-3n-E2B-it`, Google DeepMind. **HF repo created 2025-06-12**. Params **5,439,438,272**. Pipeline `image-text-to-text` (handles audio as an input modality). **Gated: `manual`** approval required. https://huggingface.co/google/gemma-3n-E2B-it
- **License: `gemma`** — the Gemma Terms of Use, which carry use restrictions (prohibited-use policy, distribution conditions) beyond a standard OSI licence. Commercial use is permitted subject to those terms, but it is **not** Apache/MIT. Grade **A**.
- **Replacement cost: MEDIUM.**

### A7. Qwen/Qwen2-Audio-7B-Instruct — the older, cleaner Apache-licensed option

- **Repo:** `Qwen/Qwen2-Audio-7B-Instruct`. **HF repo created 2024-07-31**. Pipeline `audio-text-to-text`. **License: apache-2.0** (the `license:other` tag was not present — a genuinely permissive Apache-2.0). https://huggingface.co/Qwen/Qwen2-Audio-7B-Instruct
- **Replacement cost: LOW-MEDIUM** — permissive, small-ish (7B), but superseded by Qwen3-Omni.

---

## 2. Role B — Speech recognition / transcription / vocal activity & phonetic alignment

### B1. openai/whisper-large-v3 — the only large ASR model with verified **Slovak** support

- **Repo:** `openai/whisper-large-v3`. **HF repo created 2023-11-07** (last modified 2024-08-12). Params **1,543,490,560**. Pipeline `automatic-speech-recognition`. **License: apache-2.0.** https://huggingface.co/openai/whisper-large-v3
- **Slovak/Czech: YES — both `sk` and `cs` are in the repo's language tags.** This is the strongest verified Central-European ASR evidence in the landscape. Grade **A**.
- **Card claims:** "The large-v3 model shows improved performance over a wide variety of languages, showing **10% to 20% reduction of errors**" (vendor claim). Optimal chunk length 30 seconds; batching via `batch_size`.
- **Replacement cost: LOW.** Apache-2.0, 3.5M monthly downloads, massive ecosystem (transformers.js, whisper.cpp, ONNX, CoreML, faster-whisper). Loss is survivable.

### B2. openai/whisper-large-v3-turbo — MIT + 4× faster

- **Repo:** `openai/whisper-large-v3-turbo`. **HF repo created 2024-10-01**. Params **809,323,904** (HF safetensors total). Pipeline `automatic-speech-recognition`. **License: mit.** https://huggingface.co/openai/whisper-large-v3-turbo
- **Slovak/Czech:** `sk` and `cs` present in the language tags. Grade **A**.
- **Replacement cost: LOW.**

### B3. distil-whisper/distil-large-v3 — MIT, half the size

- **Repo:** `distil-whisper/distil-large-v3`. **HF repo created 2024-03-21**. Params **756,405,760**. **License: mit.** https://huggingface.co/distil-whisper/distil-large-v3
- **Replacement cost: LOW.**

### B4. nvidia/canary-180m-flash — tiny, CC-BY, and already inside LFM2.5-Audio

- **Repo:** `nvidia/canary-180m-flash`. **HF repo created 2025-03-11**. **License: cc-by-4.0.** https://huggingface.co/nvidia/canary-180m-flash
- **This is the encoder checkpoint inside `LFM2.5-Audio-1.5B`** (the card names it explicitly), so it is the cheapest ASR-quality-per-megabyte option in the landscape.
- **Replacement cost: LOW-MEDIUM** — it is embedded in another model, so losing the standalone repo is survivable.

### B5. nvidia/parakeet-tdt-0.6b-v2 — English-only, very fast

- **Repo:** `nvidia/parakeet-tdt-0.6b-v2`. **HF repo created 2025-04-15** (last modified 2026-06-29). ~601M class. **License: cc-by-4.0.** Pipeline `automatic-speech-recognition`. https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2
- **English only** — no Central-European coverage. Grade **A**.
- **Replacement cost: LOW.**

> **Gap:** the only verified Slovak/Czech ASR coverage in this whole landscape is **Whisper large-v3 / large-v3-turbo** (both Apache-2.0/MIT). LFM2.5-Audio, Kimi-Audio, Qwen3-Omni, Phi-4, and the NVIDIA stack are all English- or Western-European-centred. For a Slovak/Czech user base, Whisper large-v3 is the pragmatic transcription anchor. Grade **A**.

---

## 3. Role C — Music information retrieval, audio embeddings, tagging, similarity search

### C1. laion/clap-htsat-fused — zero-shot audio tagging and text↔audio similarity

- **Repo:** `laion/clap-htsat-fused`, LAION. **HF repo created 2023-02-16**. Params **153,558,316**. Pipeline `audio-classification`. **License: apache-2.0.** **7,104,330 downloads/month** — the most-downloaded audio understanding model observed. https://huggingface.co/laion/clap-htsat-fused
- **Role:** CLAP aligns an audio embedding with a text embedding in one space, which is exactly what a DAW needs for **"find me the guitar loop that sounds like a dusty tape delay"** or auto-tagging a user sample.
- **Replacement cost: LOW** — Apache-2.0, tiny, heavily mirrored.

### C2. m-a-p/MERT-v1-95M — self-supervised music representations (non-commercial)

- **Repo:** `m-a-p/MERT-v1-95M`. **HF repo created 2023-03-17**. ~95M params. **License: cc-by-nc-4.0 — NOT commercially usable.** https://huggingface.co/m-a-p/MERT-v1-95M
- **Role:** self-supervised music understanding embeddings (MERT-v1, 95M).
- **Replacement cost: LOW** for commercial use — precisely because it is unusable, there is no commercial dependency.

### C3. SonyCSLParis/music2latent — timbre/interval similarity embeddings (non-commercial)

- **Repo:** `SonyCSLParis/music2latent`. **HF repo created 2024-08-12.** **License: cc-by-nc-4.0 — NOT commercially usable.** https://huggingface.co/SonyCSLParis/music2latent
- **Role:** projects audio into a latent space supporting similarity by **timbre and interval**, with GPU memory management controls (per its tutorial notebook). Directly aimed at "match this sound".
- **Replacement cost: LOW** commercially (excluded), but the _capability_ has no permissive open equivalent — a genuine gap.

### C4. facebook/encodec_32khz — the audio tokenizer

- **Repo:** `facebook/encodec_32khz`. **HF repo created 2023-06-15**. Params **58,990,022**. Pipeline `feature-extraction`. **License tag empty on the HF repo; the surrounding project `facebookresearch/audiocraft` is MIT.** https://huggingface.co/facebook/encodec_32khz and https://github.com/facebookresearch/audiocraft
- **Role:** neural audio codec — the token interface between "analysis" and "generation" (also reused by LFM2.5-Audio's Mimi-compatible detokenizer path, which is CC-BY-4.0 from Kyutai).
- **Replacement cost: LOW** — MIT, tiny, and the codec is already vendored in multiple projects.

### C5. LiquidAI/LFM2.5-Embedding-350M and LFM2.5-ColBERT-350M — text-side retrieval, not audio

- `LiquidAI/LFM2.5-Embedding-350M` — **HF repo created 2026-05-05**, 354,483,968 params, pipeline `sentence-similarity`, library `sentence-transformers`. https://huggingface.co/LiquidAI/LFM2.5-Embedding-350M
- `LiquidAI/LFM2.5-ColBERT-350M` — **HF repo created 2026-05-20**, 353,322,752 params, pipeline `sentence-similarity`, library **PyLate** (late-interaction). GGUF sibling created 2026-06-16. https://huggingface.co/LiquidAI/LFM2.5-ColBERT-350M
- **These are TEXT embeddings/rerankers, not audio.** They are relevant to KYX as the "search the project, samples, presets and chat history" layer — the role a DAW needs for a natural-language sample browser — but they cannot embed audio.
- **Replacement cost: MEDIUM** (LFM v1.0 revenue cap applies).

---

## 4. Role D — Beat / tempo / pitch / key / harmony / onset / structure analysis, and the DSP/MIR libraries

**Honest framing:** in this role the state of the art in 2026 is _not_ a frontier neural model. It is a set of well-maintained classical DSP/MIR libraries plus a handful of small task-specific neural checkpoints. The neural audio-LM wave has **not** replaced deterministic analysis for beat/tempo/key, and for a real-time DAW it should not — a deterministic extractor is faster, cheaper and more predictable than an LLM.

### D1. MTG/essentia — the reference MIR library (⚠ AGPL-3.0)

- **Repo:** `MTG/essentia` (the project moved from the `essentia` org to `MTG`; the old path 404s). **AGPL-3.0** — the GitHub API reports `spdx_id: AGPL-3.0` and the README carries an "AGPL v3" badge. **Last pushed 2026-10-22** — actively maintained. **3,781 stars.** https://github.com/MTG/essentia
- **Scope (from its README):** "an open-source C++ library for audio analysis and audio-based music information retrieval released under the **Affero GPLv3** license … a large set of spectral, temporal, tonal and high-level music descriptors", with Python bindings, predefined extractors, and a **Vamp plugin for Sonic Visualiser**. The README explicitly says the functionality is "easily expandable and allows the development of **large-scale industrial applications**".
- **🔴 The AGPL-3.0 point is the decisive fact.** AGPL §13 extends the copyleft obligation to _network interaction_. A commercial DAW that links Essentia into a server-side or desktop-app service and lets users interact with it remotely triggers source-disclosure obligations for the combined work. The library's own README inviting "large-scale industrial applications" does **not** override the licence. **Plan for a separate-process / IPC boundary, or do not link it.**
- **Model weights:** the companion `MTG/essentia-models` repo exists but its last push is **2025-09-15** and GitHub reports `license: NOASSERTION`; the README is a one-line stub ("Machine learning models intended for testing Essentia"). **Per-model commercial terms: NOT VERIFIED.** Treat Essentia's ML models as unclear-licence until confirmed per model.
- **Replacement cost: MEDIUM.** Technically the best-documented extractor set; the licence, not the code, is the obstacle.

### D2. librosa/librosa — the Python default (ISC)

- **Repo:** `librosa/librosa`. **License: ISC** (permissive). **Last pushed 2026-10-06** — actively maintained. **8,710 stars**, 50 open issues. Description: "Python library for audio and music analysis". https://github.com/librosa/librosa
- **Replacement cost: LOW.** ISC + ubiquitous.

### D3. CPJKU/madmom — beat / downbeat / onset neural predictors (BSD-2-Clause)

- **Repo:** `CPJKU/madmom` (the org is `CPJKU`; the assumed `madmom/madmom` path 404s). **Last pushed 2026-03-20** — maintained, though much more slowly than Essentia/librosa. **1,729 stars.** https://github.com/CPJKU/madmom
- **License:** GitHub reports `NOASSERTION`, but the repo's `LICENSE` file is a verbatim **BSD 2-Clause** text ("Redistribution and use in source and binary forms, with or without modification, are permitted… 1. Redistributions of source code must retain the above copyright notice… 2. Redistributions in binary form must reproduce…"). **BSD-2-Clause — permissive, commercial-friendly.** Grade **A** (read the LICENSE file directly).
- **Role:** RNN-based beat tracking, downbeat tracking, onset detection and transcription — the mature deep-learning MIR stack, still relevant. Pre-trained models live in the separate `CPJKU/madmom_models` repo (last pushed **2022-03-22** — stale).
- **Replacement cost: LOW-MEDIUM.**

### D4. aubio/aubio — C library for onset/beat/pitch (GPL-3.0)

- **Repo:** `aubio/aubio`. **License: GPL-3.0.** **Last pushed 2026-04-10.** **3,774 stars**, **160 open issues** (the highest issue backlog of the libraries surveyed). https://github.com/aubio/aubio
- **🔴 GPL-3.0 is copyleft.** Linking aubio into a proprietary desktop app is a distribution obligation (not network-copyleft like AGPL, but still a hard constraint on a closed-source product).
- **Replacement cost: LOW** functionally, but licensing makes it awkward in a proprietary app.

### D5. spotify/basic-pitch — audio → MIDI transcription (Apache-2.0)

- **Repo:** `spotify/basic-pitch`. **License: Apache-2.0.** **Last pushed 2025-11-13.** **5,968 stars**, 65 open issues. Description: "A lightweight yet powerful audio-to-MIDI converter with pitch bend detection". https://github.com/spotify/basic-pitch
- **Ecosystem:** third-party ports exist for ONNX and GGUF — `AEmotionStudio/basic-pitch-onnx-models` (Apache-2.0, 2026-04-26), `cstr/basic-pitch-GGUF` (Apache-2.0, GGUF library, 2026-08-30), `litert-community/Basic-Pitch-LiteRT` (Apache-2.0, 2026-07-02). **The GGUF/ONNX/LiteRT ports are the ones relevant to KYX's browser + desktop targets.**
- **Role:** note → MIDI pitch transcription; this is the bridge from recorded audio into a piano-roll. Directly usable in a DAW's "record audio → propose MIDI" flow.
- **Replacement cost: LOW.**

### D6. sonic-visualiser/sonic-annotator + sonic-visualiser (GPL-2.0)

- `sonic-visualiser/sonic-visualiser` — **GPL-2.0**, last pushed **2026-10-18**, 908 stars. "Visualisation, analysis, and annotation of music audio recordings". https://github.com/sonicvisualiser/sonic-visualiser
- `sonic-visualiser/sonic-annotator` — **GPL-2.0**, last pushed **2025-05-28**, 50 stars. "Batch tool for feature extraction and annotation of audio files using **Vamp plugins**". https://github.com/sonic-visualiser/sonic-annotator
- **The Vamp plugin ecosystem is the underused asset here:** it is the de-facto standard for audio feature plugins, and Essentia ships a Vamp plugin. A KYX-side Vamp-compatible plugin surface would plug directly into Sonic Visualiser, Sonic Annotator, and Essentia.
- **Replacement cost: LOW** — but GPL-2.0 again constrains linking.

### D7. Other role-D models worth noting (verified existence, details partial)

- `Qwen/Qwen3-VL-Reranker-2B` — **HF repo created 2026-01-07**, **Apache-2.0**, pipeline `text-ranking`. A genuine small reranker, but **vision/text, not audio**. https://huggingface.co/Qwen/Qwen3-VL-Reranker-2B
- `LiquidAI/LFM2.5-Encoder-350M-Prompt-Router` — **HF repo created 2026-07-13**, 355,008,768 params, pipeline `text-classification`. A **routing** classifier — structurally the right shape for a DAW that must decide "is this request a transport command, a mix operation, or a chat question?" https://huggingface.co/LiquidAI/LFM2.5-Encoder-350M-Prompt-Router
- Also in that family: `LiquidAI/LFM2.5-Encoder-350M-Spellchecker` (2026-07-04), `LiquidAI/LFM2.5-Encoder-350M-Policy-Linter` (2026-07-11), `LiquidAI/LFM2.5-Encoder-350M-PII-Detector` (2026-06-12), `LiquidAI/LFM2.5-Encoder-350M` (2026-07-27), `LiquidAI/LFM2.5-Encoder-230M` (2026-07-27), `LiquidAI/LFM2.5-Encoder-350M-Diffusion` (2026-07-10).

> **Honest gap:** I found **no** permissively-licensed, modern, single-purpose neural checkpoint for beat tracking, key detection, or chord recognition that competes with Essentia/aubio/madmom. The credible 2026 options for role D remain the classical libraries. Grade **A** for that observation (based on the HF search sweep performed 2026-10-25, which returned no credible hit for "beat tracking", "tempo", or "key detection" as model repos).

---

## 5. Role E — Music/audio generation and editing

### E1. ACE-Step 1.5 — the strongest commercial-licence story in music generation

- **Repos:** `ACE-Step/Ace-Step1.5` (turbo, **HF repo created 2026-01-23**), `ACE-Step/acestep-v15-base`, `ACE-Step/acestep-v15-sft` (**2026-01-23**), `ACE-Step/acestep-v15-xl-base` / `-xl-sft` / `-xl-turbo` (**2026-04-02**). Params: `acestep-v15-sft` = **2,393,872,518**; `acestep-v15-xl-base` = **4,987,310,726**. https://huggingface.co/ACE-Step/Ace-Step1.5
- **License: MIT** — and, unusually, the model card makes the _output_ rights explicit: "**Commercial-Ready:** Unlike many models trained on ambiguous datasets, ACE-Step v1.5 is designed for creators. You can strictly use the generated music for **commercial purposes**." It states the training data is "a massive, legally compliant dataset consisting of: Licensed Data … Royalty-Free / No-Copyright Data … Synthetic Data". Grade **A** (vendor claim about data provenance, which I cannot independently audit).
- **Architecture:** hybrid. An **LM planner** (from Qwen3) turns a query into a song blueprint — metadata, lyrics, captions via chain-of-thought — which drives a **Diffusion Transformer (DiT)**. LM variants: `acestep-5Hz-lm-0.6B` (from Qwen3-0.6B), `-1.7B` (Qwen3-1.7B), `-4B` (Qwen3-4B), with pre-training + SFT + RL and CoT metadata, query rewrite and audio understanding.
- **Capabilities:** text2music, cover, repaint, extract, lego, complete — i.e. **inpainting/editing** is in the same model, plus "vocal-to-BGM conversion".
- **Latency (vendor):** "under **2 seconds** per full song on an **A100** and under **10 seconds** on an **RTX 3090**"; "0.5s to 10s on A100 depending on think mode & diffusion steps". Duration **10 seconds to 10 minutes (600s)**.
- **Footprint (vendor):** "runs locally with **less than 4GB of VRAM**"; the XL (4B) series needs "≥12GB VRAM (with offload + quantization) or ≥20GB (without offload)", with "~9GB VRAM for weights (vs ~4.7GB for 2B)". **CPU-only execution is supported** ("CUDA GPU recommended (also supports MPS / ROCm / Intel XPU / CPU)"), with install guides for AMD/ROCm, Intel GPU and CPU.
- **Fine-tuning:** **LoRA training is a first-class documented feature** — "users can train a LoRA from just a few songs to capture their own style"; the repo's feature table states "**LoRA Training | One-click annotation & training in Gradio. 8 songs, 1 hour on 3090 (12GB VRAM)**". Grade **A**.
- **Languages:** **50+ languages** (prompt adherence) — the card does **not** enumerate them, so **Slovak/Czech status: NOT VERIFIED**.
- **Repo:** `ace-step/ACE-Step-1.5` (GitHub). Related: `ace-step/ACE-Step` (Apache-2.0, last pushed 2026-02-15, 4,984 stars, 156 open issues). The project is co-led by **ACE Studio and StepFun**. Tech report: https://arxiv.org/abs/2602.00744
- **Replacement cost: MEDIUM.** MIT + LoRA + commercial-use grant + CPU path makes it the most adoptable option; but a full re-train is not cheap.

### E2. m-a-p/YuE2-3B — strong quality, non-commercial

- **Repo:** `m-a-p/YuE2-3B`. **HF repo created 2026-09-09** (last modified 2026-10-06). Params **3,630,684,224**. Pipeline `text-to-audio`. **License: cc-by-nc-4.0 — NOT commercially usable.** https://huggingface.co/m-a-p/YuE2-3B
- Companion: `m-a-p/YuE2-Vae` (same collection).
- The earlier **YuE-s1-7B-anneal-en-cot** (`m-a-p/YuE-s1-7B-anneal-en-cot`, **HF repo created 2025-01-26**, params **6,224,613,376**, **license: apache-2.0**) is the Apache-licensed predecessor — still permissively licensed but superseded.
- **Replacement cost: LOW commercially** (NC excludes it) — but this is the classic trap: the best-sounding open music generator is often the one you may not ship.

### E3. ASLP-lab/DiffRhythm — full-song generation and editing (Apache-2.0, with a metadata conflict)

- **Repo:** `ASLP-lab/DiffRhythm-base`. **HF repo created 2025-03-02**. **License: apache-2.0.** https://huggingface.co/ASLP-lab/DiffRhythm-base
- **⚠ Metadata conflict worth flagging:** the card's front-matter reads `license: apache-2.0` **and** `license_name: stable-audio-community` (with `license_link: LICENSE`) — the latter looks like copy-paste from a Stable Audio card. The card **body** states: "**DiffRhythm (code and DiT weights) is released under the Apache License 2.0.** This open-source license allows you to freely use, modify, and distribute the model, as long as you include the appropriate copyright notice and disclaimer." **Trust the body + the `LICENSE` file, not the front-matter `license_name`.** Grade **A** for the conflict itself; the Apache-2.0 conclusion is grade **A** (body text) but should be re-confirmed against the LICENSE file before shipping.
- Related repos: `ASLP-lab/DiffRhythm-full`, `ASLP-lab/DiffRhythm2`.
- **Replacement cost: LOW-MEDIUM.**

### E4. stabilityai/SAME-L and stable-audio-3 — commercial licence, gated

- `stabilityai/SAME-L` — **HF repo created 2026-05-17** (last modified 2026-10-06). Params **852,127,457**. **`license_name: stable-audio-community`**, card links https://stability.ai/license and says "For commercial use, please refer to https://stability.ai/license". **Language: English.** Training data: "~19,500 hours of licensed production audio from AudioSparx which includes a 66/25/9% mix of music, sound effects, and instrument stems." https://huggingface.co/stabilityai/SAME-L
- `stabilityai/stable-audio-3-medium` — **HF repo created 2026-05-17** (last modified 2026-10-06). Params **2,305,495,793**. Pipeline `text-to-audio`. `license:other`. **`gated: auto`** — the README returned **401 Unauthorized** to me on 2026-10-25, so I could not read its card. Grade **C** for its card contents, **A** for its API metadata (created date, param count, gating).
- **SAME = "Sesame"?** The card content I read does not name Sesame CSM. `facebook/sam-e` returned **401** (gated/renamed). **The relationship between Sesame's CSM and Stability's SAME is NOT VERIFIED.** Do not assume the Sesame CSM checkpoint is open; it is not publicly downloadable here.
- **Replacement cost: MEDIUM-HIGH** (gated, Stability Community Licence, tied to Stability's commercial terms).

### E5. Qwen/Qwen3-TTS-12Hz — Apache-2.0 streaming TTS with 97 ms latency

- **Repos:** `Qwen/Qwen3-TTS-12Hz-1.7B-Base` (**HF repo created 2026-01-21**; params **1,928,677,440**), `-1.7B-CustomVoice`, `-1.7B-VoiceDesign`, `-0.6B-Base`, `-0.6B-CustomVoice`. All **license: apache-2.0**. **3.0M monthly downloads** for the 1.7B-Base — the most-downloaded audio model in this survey outside Whisper/CLAP/Kokoro. https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base
- **Architecture/streaming:** "Dual-Track hybrid streaming generation architecture… a single model supports both streaming and non-streaming generation. It can output the first audio packet **immediately after a single character is input**, with end-to-end synthesis latency as low as **97ms**" (vendor claim).
- **Languages: 10** — Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian. **No Slovak/Czech.**
- **Fine-tuning:** the **Base** variant "can be used for fine-tuning (FT) other models"; CustomVoice/VoiceDesign are instruct-driven; Base does 3-second rapid voice cloning from user audio.
- **Replacement cost: LOW-MEDIUM** — Apache-2.0, small, very widely used.

### E6. Other generation/editing candidates (verified existence)

- `stepfun-ai/Step-Audio-Chat` — **HF repo created 2025-02-13**, **license: apache-2.0**, pipeline `audio-text-to-text`, params **131,946,590,208** (the full Step-Audio stack). https://huggingface.co/stepfun-ai/Step-Audio-Chat
- `stepfun-ai/Step-Audio-EditX` — **HF repo created 2025-10-29**, params **3,529,706,496**, pipeline blank, **no license tag on the repo** → licence **NOT VERIFIED**; treat as unusable until confirmed. https://huggingface.co/stepfun-ai/Step-Audio-EditX
- `hexgrad/Kokoro-82M` — **HF repo created 2024-12-26**, **license: apache-2.0**, pipeline `text-to-speech`, **10.3M monthly downloads**. Tiny, fast, very widely deployed. https://huggingface.co/hexgrad/Kokoro-82M
- `coqui/XTTS-v2` — **HF repo created 2023-10-31**, `license:other` (the Coqui Public Model License), **6.1M monthly downloads**. The CPML is **non-commercial**; I did not read the licence body, so the exact terms are **NOT VERIFIED** beyond the `other` tag. https://huggingface.co/coqui/XTTS-v2
- `facebook/musicgen-medium` — **HF repo created 2023-06-08**, **license: cc-by-nc-4.0 — NOT commercially usable**, ~1.5B, pipeline `text-to-audio`, 1.9M monthly downloads. The family (`facebook/musicgen-melody`, `-large`, `facebook/audiogen-medium` created 2023-07-26, also CC-BY-NC-4.0) is **legacy and non-commercial**. https://huggingface.co/facebook/musicgen-medium
- `hkchengrex/MMAudio` — **HF repo created 2024-12-10**, **license: cc-by-nc-4.0 — NOT commercially usable**, video→audio joint generation. https://huggingface.co/hkchengrex/MMAudio
- `facebookresearch/audiocraft` — the Python library behind MusicGen/AudioGen/EnCodec. **License: MIT.** **Last pushed 2026-03-03** — still maintained. **23,758 stars, 401 open issues.** https://github.com/facebookresearch/audiocraft

### E7. Moises — commercial, licensed, no open weights found

- https://moises.ai/ fetched successfully (2026-10-25); it is a **commercial stem-separation and stem-processing product**. `https://moises.ai/developers` returned **404**. I found **no public open-weight Moises checkpoint**. Grade **U** for any open-weight claim; the commercial service itself is grade **A** for existence. **Not a candidate for a local-first DAW unless a commercial agreement is reached.**

---

## 6. Role F — Small task-specific intent / decision / ranking models

### F1. LiquidAI/d1-omni-600M — listens and decides, emits no tokens

- **Repo:** `LiquidAI/d1-omni-600M`. **HF repo created 2026-10-05** (last modified 2026-10-07). Params **587,161,089**. Pipeline `image-text-to-text`. HF tags include `audio`, `vision`, `multimodal`. **`license:other` = LFM Open License v1.0.** https://huggingface.co/LiquidAI/d1-omni-600M
- **Why it matters:** it is a **decision model**, not a generator — "no output tokens", a **16,384-token context**, and it scores/selects rather than emitting free text. Its `base_model` is `LiquidAI/LFM2.5-Encoder-350M`. Available as **GGUF** (`LiquidAI/d1-omni-600M-GGUF`, 2026-10-06) and **MLX** (`-MLX-8bit`, 2026-10-12).
- **Language caveat:** text-language tags include `pl` and `ru`; the card states its **audio** training data is **English**. **Slovak/Czech: unknown for audio; not claimed.**
- **Replacement cost: MEDIUM-HIGH** — very new (3 weeks old at time of writing), single-vendor, restrictive licence.

### F2. LiquidAI/d1-3B — the larger decision model

- **Repo:** `LiquidAI/d1-3B`. **HF repo created 2026-10-05**. Params **3,123,483,888**. Pipeline `image-text-to-text`. Same LFM v1.0 licence. Variants: `d1-3B-w8a8` (2026-10-07), `d1-3B-GGUF` (2026-10-06), `d1-3B-MLX-fp16` / `-MLX-8bit` / `-MLX-4bit` (2026-10-12). https://huggingface.co/LiquidAI/d1-3B

### F3. LiquidAI/LFM2.5-ColBERT-350M — a small late-interaction reranker

- **HF repo created 2026-05-20**, 353,322,752 params, library **PyLate**, pipeline `sentence-similarity`. GGUF sibling 2026-06-16. Text-only. Grade **A**.
- **Replacement cost: LOW-MEDIUM.**

### F4. LiquidAI/LFM2.5-Encoder-350M-Prompt-Router — a tiny intent router

- **HF repo created 2026-07-13**, 355,008,768 params, pipeline `text-classification`. A classifier over prompts — the exact shape needed to route "this request is a transport command / a mix op / a chat question" before any LLM runs. Grade **A**.

### F5. Qwen/Qwen3-VL-Reranker-2B

- **HF repo created 2026-01-07**, **Apache-2.0**, pipeline `text-ranking`. Vision+text reranker. Grade **A**.

### F6. KYX's existing choice, for reference

`LiquidAI/LFM2.5-1.2B-Instruct` is doing role F/G today in KYX (`docs/LOCAL-INTENT-MODEL.md`). See §0.6 for the verification and the **$10M revenue-cap exposure**.

---

## 7. Role G — Multimodal planners and coding-capable tool users

### G1. LiquidAI/LFM2.5-1.2B-Instruct — the DAW's tool user

Full facts in §0.5. The parts that matter for role G:

- **Tool use is a documented, first-class feature**: tools declared as a JSON object in the system prompt (or via `tokenizer.apply_chat_template()`), the model emits **Pythonic function calls** inside `<|tool_call_start|>`…`<|tool_call_end|>`, and the result is returned as a `tool` role. Liquid's own guide: https://docs.liquid.ai/lfm/key-concepts/tool-use
- **The repo's GBNF/JSON-schema constrained-decoding design (§3 of `docs/LOCAL-INTENT-MODEL.md`) is the correct pattern** for this model class — Liquid's own card documents the JSON-output override ("You can override this behavior by asking the model to output JSON function calls in the system prompt").
- **Runtimes:** llama.cpp (GGUF), **ONNX Runtime** (`LiquidAI/LFM2.5-1.2B-Instruct-ONNX`, 2026-01-04), **MLX** (Apple Silicon, 4/5/6/8-bit + bf16), **vLLM**, **SGLang**, plus the **DSpark** speculative drafter.
- **Replacement cost: HIGH for KYX specifically** — it is the pinned, fine-tuned centre of the product, and the LFM licence cap means a future switch is a licensed migration, not just a weight swap.

### G2. LiquidAI/LFM2.5-24B-A2B — the newest flagship text model

- **HF repo created 2026-10-12**, params **23,971,585,280** (MoE, 2B active). Pipeline `text-generation`. GGUF (2026-10-09, 180,531 downloads/mo), FP8, MLX 5/8-bit + bf16, ONNX, DSpark drafter (327,707,521 params, 2026-10-19). **LFM v1.0 licence.** https://huggingface.co/LiquidAI/LFM2.5-24B-A2B
- **Note the cadence:** the LFM2.5 line moved 1.2B (2026-01) → 350M (2026-03) → 230M (2026-06) → 2.6B (2026-07) → 8B-A1B (2026-05) → 24B-A2B (2026-10). **The family is still moving fast**; pin revisions.
- **Replacement cost: MEDIUM** (permissive-by-threshold, but the threshold).

### G3. ACE-Step's internal LM planner

`acestep-5Hz-lm-0.6B / -1.7B / -4B` (from Qwen3) act as "omni-capable planner[s]" that turn a user query into a song blueprint with CoT metadata, lyrics and captions. This is a **proven pattern for using a small LM as a music-domain planner**, and the 0.6B variant is small enough for a laptop. Whether the weights are separately published with the MIT licence: **NOT VERIFIED** (the model-zoo table links to a collection, not per-checkpoint ids).

### G4. Qwen3-Omni as a DAW planner

`Qwen/Qwen3-Omni-30B-A3B-Instruct` (Apache-2.0, thinker + talker, real-time streaming) is the strongest open candidate for "a multimodal planner that can look at a spectrogram/screenshot and drive a DAW" — but at ~35 GB it is a **server-side** component, not a local one. `Qwen/Qwen3-Omni-30B-A3B-Thinking` (text output only, thinker-only) is the variant that could serve a reasoning loop.

---

## 8. Comparison table

| #   | Model                                        | Role                  | Params       | License                                                                  | Audio I/O                                                      | Fine-tune                         | Local footprint                                 | Latency                                             | Grade                       |
| --- | -------------------------------------------- | --------------------- | ------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------- | ----------------------------------------------- | --------------------------------------------------- | --------------------------- |
| 1   | `LiquidAI/LFM2.5-Audio-1.5B`                 | A audio-LM            | 1.47B        | **LFM v1.0 — commercial capped at <$10M revenue**                        | **Yes** (audio→audio, 24 kHz)                                  | Yes (liquid-audio v1.2.0 trainer) | ~3 GB bf16 (est.); GGUF + ONNX paths            | real-time s2s claimed, **no number published**      | **A**                       |
| 2   | `LiquidAI/LFM2-Audio-1.5B`                   | A audio-LM            | 1.47B        | LFM v1.0 (cap)                                                           | Yes                                                            | Yes                               | same as #1                                      | —                                                   | **A**                       |
| 3   | `LiquidAI/LFM2.5-Audio-1.5B-JP`              | A audio-LM (JP)       | 1.47B        | LFM v1.0 (cap)                                                           | Yes                                                            | not verified                      | GGUF, 258k dl/mo                                | —                                                   | **A**                       |
| 4   | `LiquidAI/d1-omni-600M`                      | F decision (+A)       | 587M         | LFM v1.0 (cap)                                                           | **Yes** (audio+vision in, **no output tokens**)                | not verified                      | GGUF + MLX                                      | —                                                   | **A**                       |
| 5   | `LiquidAI/LFM2.5-1.2B-Instruct`              | G tool user / planner | 1.17B        | LFM v1.0 (cap)                                                           | **No — text only**                                             | LoRA: Unsloth, TRL SFT, TRL DPO   | **<1 GB** (vendor)                              | **239 tok/s** AMD CPU, 82 tok/s mobile NPU (vendor) | **A**                       |
| 6   | `LiquidAI/LFM2.5-24B-A2B`                    | G planner             | 23.97B (A2B) | LFM v1.0 (cap)                                                           | No                                                             | yes (LFM stack)                   | server-class                                    | —                                                   | **A**                       |
| 7   | `LiquidAI/LFM2.5-ColBERT-350M`               | F reranker            | 353M         | LFM v1.0 (cap)                                                           | No (text)                                                      | no                                | small                                           | —                                                   | **A**                       |
| 8   | `LiquidAI/LFM2.5-Encoder-350M-Prompt-Router` | F intent router       | 355M         | LFM v1.0 (cap)                                                           | No (text)                                                      | no                                | small                                           | —                                                   | **A**                       |
| 9   | `Qwen/Qwen3-Omni-30B-A3B-Instruct`           | A/G omni              | 35.26B (A3B) | **Apache-2.0**                                                           | **Yes** — text+image+audio+video in, **speech out**, streaming | yes (Captioner recipe)            | ~35 GB bf16; **−10 GB** with `disable_talker()` | real-time streaming (vendor)                        | **A**                       |
| 10  | `Qwen/Qwen3-Omni-30B-A3B-Captioner`          | A audio captioning    | 31.72B       | Apache-2.0                                                               | audio→text                                                     | yes (it _is_ a fine-tune)         | ~32 GB                                          | —                                                   | **A**                       |
| 11  | `Qwen/Qwen3-TTS-12Hz-1.7B-Base`              | B/E TTS + clone       | 1.93B        | **Apache-2.0**                                                           | text→audio                                                     | **Yes** (Base is the FT target)   | ~4 GB                                           | **97 ms** E2E (vendor)                              | **A**                       |
| 12  | `Qwen/Qwen2-Audio-7B-Instruct`               | A audio-LM            | 7B           | **Apache-2.0**                                                           | audio→text                                                     | yes                               | ~14 GB                                          | —                                                   | **A**                       |
| 13  | `moonshotai/Kimi-Audio-7B-Instruct`          | A audio-LM            | 9.77B        | **MIT**                                                                  | audio→text+speech                                              | partial                           | ~20 GB                                          | —                                                   | **A** (SOTA claim **C**)    |
| 14  | `nvidia/audio-flamingo-3-hf`                 | A reasoning           | 8.27B        | **NVIDIA OneWay Noncommercial**                                          | audio→text                                                     | no                                | ~17 GB                                          | —                                                   | **A**                       |
| 15  | `nvidia/audio-flamingo-next-hf`              | A reasoning           | 8.27B        | NVIDIA Noncommercial                                                     | audio→text                                                     | no                                | ~17 GB                                          | —                                                   | **A**                       |
| 16  | `microsoft/Phi-4-multimodal-instruct`        | A/B                   | 5.57B        | **MIT**                                                                  | audio→text (**cs supported**)                                  | yes                               | ~11 GB                                          | —                                                   | **A**                       |
| 17  | `google/gemma-3n-E2B-it`                     | A                     | 5.44B        | **Gemma Terms** (gated)                                                  | audio→text                                                     | yes                               | ~11 GB                                          | —                                                   | **A**                       |
| 18  | `openai/whisper-large-v3`                    | B ASR                 | 1.54B        | **Apache-2.0**                                                           | audio→text (**sk + cs**)                                       | no                                | ~3 GB                                           | 30 s optimal chunk                                  | **A**                       |
| 19  | `openai/whisper-large-v3-turbo`              | B ASR                 | 809M         | **MIT**                                                                  | audio→text (**sk + cs**)                                       | no                                | ~1.6 GB                                         | 4× turbo (vendor)                                   | **A**                       |
| 20  | `distil-whisper/distil-large-v3`             | B ASR                 | 756M         | **MIT**                                                                  | audio→text                                                     | no                                | ~1.5 GB                                         | —                                                   | **A**                       |
| 21  | `nvidia/canary-180m-flash`                   | B ASR encoder         | 206M         | **CC-BY-4.0**                                                            | audio→text (en/de/es/fr)                                       | no                                | ~0.4 GB                                         | —                                                   | **A**                       |
| 22  | `nvidia/parakeet-tdt-0.6b-v2`                | B ASR                 | 601M         | **CC-BY-4.0**                                                            | audio→text (en only)                                           | no                                | ~1.2 GB                                         | —                                                   | **A**                       |
| 23  | `laion/clap-htsat-fused`                     | C embeddings/tagging  | 154M         | **Apache-2.0**                                                           | audio↔text                                                     | no                                | ~0.6 GB                                         | —                                                   | **A**                       |
| 24  | `m-a-p/MERT-v1-95M`                          | C music embeddings    | 95M          | **CC-BY-NC-4.0**                                                         | audio→emb                                                      | yes                               | ~0.4 GB                                         | —                                                   | **A**                       |
| 25  | `SonyCSLParis/music2latent`                  | C timbre/interval sim | n/a          | **CC-BY-NC-4.0**                                                         | audio→emb                                                      | n/a                               | small                                           | —                                                   | **A**                       |
| 26  | `facebook/encodec_32khz`                     | C/E codec             | 59M          | MIT (audiocraft)                                                         | audio↔tokens                                                   | no                                | ~0.24 GB                                        | —                                                   | **A**                       |
| 27  | `ACE-Step/Ace-Step1.5` (+ v15-sft/base)      | E text2music + edit   | 2.39B (sft)  | **MIT + explicit commercial-use grant**                                  | text→audio                                                     | **LoRA** (8 songs/1 h @ 3090)     | **<4 GB VRAM** (vendor); CPU/MPS/ROCm/XPU       | **<2 s** A100, **<10 s** RTX 3090 (vendor)          | **A**                       |
| 28  | `ACE-Step/acestep-v15-xl-base`               | E text2music (XL)     | 4.99B        | MIT                                                                      | text→audio                                                     | LoRA                              | **≥12 GB** VRAM (offload), ≥20 GB recommended   | —                                                   | **A**                       |
| 29  | `m-a-p/YuE2-3B`                              | E text2music          | 3.63B        | **CC-BY-NC-4.0**                                                         | text→audio                                                     | —                                 | —                                               | —                                                   | **A**                       |
| 30  | `ASLP-lab/DiffRhythm-base`                   | E text2music + edit   | n/a          | **Apache-2.0** (⚠ front-matter says `stable-audio-community` — conflict) | text→audio                                                     | —                                 | —                                               | —                                                   | **A** (conflict flagged)    |
| 31  | `stabilityai/SAME-L`                         | E text2audio          | 852M         | **Stability AI Community Licence**                                       | text→audio                                                     | —                                 | —                                               | —                                                   | **A**                       |
| 32  | `stabilityai/stable-audio-3-medium`          | E text2audio          | 2.31B        | `license:other`, **gated**                                               | text→audio                                                     | —                                 | —                                               | —                                                   | **C** (401 on card)         |
| 33  | `stepfun-ai/Step-Audio-Chat`                 | A/E                   | 131.9B stack | **Apache-2.0**                                                           | audio↔text                                                     | —                                 | server-class                                    | —                                                   | **A**                       |
| 34  | `stepfun-ai/Step-Audio-EditX`                | E editing             | 3.53B        | **no license tag — NOT VERIFIED**                                        | audio→audio edit                                               | —                                 | —                                               | —                                                   | **U**                       |
| 35  | `hexgrad/Kokoro-82M`                         | E TTS                 | 82M          | **Apache-2.0**                                                           | text→audio                                                     | —                                 | ~0.3 GB                                         | —                                                   | **A**                       |
| 36  | `coqui/XTTS-v2`                              | E voice clone         | n/a          | `license:other` (CPML — **non-commercial**, body NOT VERIFIED)           | text→audio                                                     | —                                 | —                                               | —                                                   | **A** (tag) / **U** (terms) |
| 37  | `facebook/musicgen-medium`                   | E legacy              | ~1.5B        | **CC-BY-NC-4.0**                                                         | text→audio                                                     | —                                 | ~3 GB                                           | —                                                   | **A**                       |
| 38  | `hkchengrex/MMAudio`                         | E video→audio         | n/a          | **CC-BY-NC-4.0**                                                         | video→audio                                                    | —                                 | —                                               | —                                                   | **A**                       |
| 39  | `MTG/essentia`                               | **D** MIR library     | —            | **AGPL-3.0** ⚠                                                           | DSP analysis                                                   | —                                 | native C++                                      | real-time-capable                                   | **A**                       |
| 40  | `librosa/librosa`                            | **D** MIR library     | —            | **ISC**                                                                  | DSP analysis                                                   | —                                 | Python                                          | —                                                   | **A**                       |
| 41  | `CPJKU/madmom`                               | **D** beat/onset RNN  | —            | **BSD-2-Clause**                                                         | audio→beat/onset                                               | —                                 | Python                                          | —                                                   | **A**                       |
| 42  | `aubio/aubio`                                | **D** MIR library     | —            | **GPL-3.0** ⚠                                                            | DSP analysis                                                   | —                                 | C                                               | —                                                   | **A**                       |
| 43  | `spotify/basic-pitch`                        | **D** audio→MIDI      | —            | **Apache-2.0**                                                           | audio→MIDI                                                     | —                                 | ONNX/GGUF ports exist                           | —                                                   | **A**                       |
| 44  | `sonic-visualiser/sonic-annotator`           | **D** batch features  | —            | **GPL-2.0**                                                              | batch extraction                                               | —                                 | Python + Vamp                                   | —                                                   | **A**                       |
| 45  | `facebookresearch/audiocraft`                | E/C library           | —            | **MIT**                                                                  | codec + gen                                                    | —                                 | Python                                          | —                                                   | **A**                       |

_Rows are ordered by role grouping (A→G, then D libraries, then E libraries). "Params" for libraries is n/a. "Footprint" and "Latency" marked "vendor" are vendor-reported, not independently measured._

---

## 9. Cross-cutting findings for the frontier report

1. **The single most consequential finding is a licence, not a model.** The LFM Open License v1.0's **$10M annual-revenue threshold** (§0.7) means KYX's _currently pinned_ intent model becomes unusable commercially at a defined business milestone. This is exactly the kind of thing a frontier report should surface early. An Apache-2.0/MIT alternative with Slovak/Czech support exists (Whisper large-v3 for ASR; Phi-4-multimodal for understanding) and should be evaluated as the intent backbone before the threshold is hit.

2. **The best open music generators are non-commercial.** MusicGen, AudioGen, MERT, Music2Latent, MMAudio and YuE2 are all **CC-BY-NC-4.0**. The one model with an explicit _commercial-use grant_ on generated output is **ACE-Step 1.5 (MIT)**. For a commercial DAW this is the pivotal filter, and it is worth stating in the report in exactly these terms.

3. **Non-commercial licences are pervasive in the _understanding_ class too**, not just generation: NVIDIA Audio Flamingo (OneWay Noncommercial) and Music2Latent / MERT. The "fully open" audio-LM wave is largely not commercially usable.

4. **Slovak/Czech coverage is thin and concentrated.** Verified: **Whisper large-v3 and large-v3-turbo** (`sk` + `cs`), **Phi-4-multimodal** (`cs` only). Unverified/unknown: LFM2.5-Audio (English only), LFM2.5-Instruct (no sk/cs), Qwen3-Omni (no sk/cs), Qwen3-TTS (10 languages, no sk/cs), Kimi-Audio (en/zh), ACE-Step (50+ languages, **not enumerated**), d1-omni-600M (English audio). **Recommend an explicit Slovak/Czech evaluation of Whisper large-v3 as the transcription anchor** rather than assuming any frontier model covers it.

5. **Local-first realism tiers** (my estimate, clearly marked as estimation):
   - **Fits a laptop today:** Whisper large-v3-turbo (MIT, 809M), Kokoro-82M (Apache-2.0), Qwen3-TTS-12Hz-0.6B (Apache-2.0), LFM2.5-1.2B-Instruct (LFM, <1 GB vendor), basic-pitch (Apache-2.0, ONNX/GGUF ports exist), CLAP (Apache-2.0), LFM2.5-Audio-1.5B (GGUF/ONNX, but LFM cap).
   - **Needs a desktop GPU (8–12 GB):** Qwen3-TTS-12Hz-1.7B, ACE-Step 1.5 (vendor: <4 GB VRAM), LFM2.5-Audio-1.5B bf16.
   - **Server-only (>20 GB):** Qwen3-Omni-30B-A3B, Kimi-Audio-7B, Audio Flamingo 3, d1-3B, LFM2.5-24B-A2B.

6. **Fine-tuning is the differentiator for KYX, and it is unevenly available.** Documented recipes exist for: LFM2.5-1.2B-Instruct (Unsloth/TRL LoRA SFT+DPO), liquid-audio (ASR/TTS/function-calling/s2s chat), Qwen3-TTS-12Hz **Base** (explicitly "can be used for fine-tuning"), ACE-Step 1.5 (LoRA from 8 songs), MERT (self-supervised, but NC). **No fine-tuning recipe found for Audio Flamingo (non-commercial anyway), Kimi-Audio, or Phi-4-multimodal in this session.**

7. **Role D has no new frontier model, and that is the correct answer.** Beat/tempo/key/onset remain deterministic-DSP territory (Essentia, librosa, aubio, madmom). Two of the four best ones are **copyleft** (AGPL-3.0, GPL-3.0) — the practical recommendation is a **separate-process/IPC boundary** for Essentia or aubio rather than linking, with the GPL/AGPL code shipped as an unmodified binary or as a separate service.

8. **The `d1` decision-model line (d1-3B, d1-omni-600M, released 2026-10-05) is the newest and most KYX-shaped thing in the landscape** — small models that _listen/see and decide_ rather than generate, with GGUF/MLX builds and a 16k context. For a DAW that must turn an audio clip or a screen into an action, that is the right architecture. It is **19 days old** at time of writing and its licence carries the same $10M cap.

---

## 10. What I could NOT verify (explicit gaps)

| Item                                                   | Status                      | Why                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Liquid AI's **announced** release date for LFM2.5      | **NOT VERIFIED**            | `https://www.liquid.ai/blog/introducing-lfm2-5-the-next-generation-of-on-device-ai` is JavaScript-rendered; my fetches returned no date-bearing markup. All LFM2.5 dates here are **HF repo `createdAt`** timestamps.               |
| Exact VRAM / RAM footprint of `LFM2.5-Audio-1.5B`      | **NOT VERIFIED**            | No numeric figure published. The ~3 GB figure in the table is an **estimate** from the 1.47B bf16 safetensors total.                                                                                                                |
| Numeric latency for `LFM2.5-Audio-1.5B`                | **NOT VERIFIED**            | Card states "low latency and real time" in prose only.                                                                                                                                                                              |
| `stabilityai/stable-audio-3-medium` card contents      | **NOT VERIFIED**            | README returned **401 Unauthorized** (gated repo). API metadata only.                                                                                                                                                               |
| `openai/jukebox`                                       | **NOT VERIFIED**            | API returned **401** (gated). No facts claimed beyond its existence.                                                                                                                                                                |
| `ACE-Step/acestep-v15-turbo`                           | **NOT VERIFIED**            | API returned **401**. Only the `Ace-Step1.5` / `-sft` / `-xl-base` variants were readable.                                                                                                                                          |
| `stepfun-ai/Step-Audio-EditX` licence                  | **NOT VERIFIED**            | No `license:*` tag on the repo.                                                                                                                                                                                                     |
| `coqui/XTTS-v2` exact licence terms                    | **NOT VERIFIED**            | `license:other` tag observed; the CPML body was not read.                                                                                                                                                                           |
| Essentia **model** (not library) licences              | **NOT VERIFIED**            | `MTG/essentia-models` README is a one-line stub; GitHub reports `NOASSERTION`; last push 2025-09-15.                                                                                                                                |
| Kimi-Audio's specific benchmark numbers                | **NOT VERIFIED**            | The card asserts SOTA but the table is in a linked PDF I did not open.                                                                                                                                                              |
| Sesame CSM → Stability SAME relationship               | **NOT VERIFIED**            | `facebook/sam-e` → 401; the SAME-L card I read does not mention Sesame.                                                                                                                                                             |
| ACE-Step's "50+ languages" — is Slovak/Czech included? | **NOT VERIFIED**            | The languages are **not enumerated** on the card.                                                                                                                                                                                   |
| `LiquidAI/LFM2.5-Audio-1.5B` backbone: LFM2 vs LFM2.5  | **NOT VERIFIED (conflict)** | Card text says LFM2.5; HF `base_model` tag says `LiquidAI/LFM2-1.2B`.                                                                                                                                                               |
| Moises developer/API/SDK offering                      | **NOT VERIFIED**            | `moises.ai/developers` → 404; homepage is JS-heavy with no extractable API/pricing text.                                                                                                                                            |
| Independent (non-vendor) evals of any model here       | **NOT FOUND**               | All benchmark figures quoted are **vendor-reported** from model cards.                                                                                                                                                              |
| "Qwen3.5-Omni"                                         | **NOT FOUND on HF**         | An arXiv "Qwen3.5-Omni Technical Report" surfaced in search, but **no `Qwen/Qwen3.5-Omni-*` HF repo exists** as of 2026-10-25; HF searches for "Qwen3.5-Omni" returned only unrelated community fine-tunes. Do not plan against it. |

**Method note on search:** no first-party `web_search` tool was available in this session, so discovery used the DuckDuckGo HTML endpoint (`https://html.duckduckgo.com/html/?q=…`) plus direct Hugging Face API queries (`/api/models?author=…&search=…`) and the GitHub REST API. **GitHub API usage was kept deliberately low (~14 requests) to respect the shared 60 req/h unauthenticated budget** described in `AGENTS.md`.

---

## 11. Source index (all observed 2026-10-25)

**Liquid AI / LFM**

- https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B · [README](https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B/raw/main/README.md) · [LICENSE](https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B/raw/main/LICENSE)
- https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct · [README](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct/raw/main/README.md) · [LICENSE](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct/raw/main/LICENSE) · [config.json](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct/raw/main/config.json)
- https://huggingface.co/LiquidAI/LFM2-Audio-1.5B · https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B-JP
- https://huggingface.co/LiquidAI/d1-omni-600M · https://huggingface.co/LiquidAI/d1-3B
- https://huggingface.co/LiquidAI/LFM2.5-24B-A2B · https://huggingface.co/LiquidAI/LFM2.5-ColBERT-350M · https://huggingface.co/LiquidAI/LFM2.5-Encoder-350M-Prompt-Router
- https://github.com/Liquid4All/liquid-audio · https://docs.liquid.ai/lfm/key-concepts/tool-use
- https://arxiv.org/abs/2511.23404 (LFM2 Technical Report, submitted 28 Nov 2025)
- https://huggingface.co/api/models?author=LiquidAI (family roster)

**Qwen**

- https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct · https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Thinking · https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Captioner
- https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base · https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice · https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign · https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base · https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
- https://huggingface.co/Qwen/Qwen2-Audio-7B-Instruct · https://huggingface.co/Qwen/Qwen3-VL-Reranker-2B

**Other models**

- https://huggingface.co/moonshotai/Kimi-Audio-7B-Instruct · https://huggingface.co/nvidia/audio-flamingo-3-hf · https://huggingface.co/nvidia/audio-flamingo-next-hf
- https://huggingface.co/microsoft/Phi-4-multimodal-instruct · https://huggingface.co/google/gemma-3n-E2B-it
- https://huggingface.co/openai/whisper-large-v3 · https://huggingface.co/openai/whisper-large-v3-turbo · https://huggingface.co/distil-whisper/distil-large-v3
- https://huggingface.co/nvidia/canary-180m-flash · https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2
- https://huggingface.co/laion/clap-htsat-fused · https://huggingface.co/m-a-p/MERT-v1-95M · https://huggingface.co/SonyCSLParis/music2latent · https://huggingface.co/facebook/encodec_32khz
- https://huggingface.co/ACE-Step/Ace-Step1.5 · https://huggingface.co/ACE-Step/acestep-v15-base · https://huggingface.co/ACE-Step/acestep-v15-sft · https://huggingface.co/ACE-Step/acestep-v15-xl-base
- https://huggingface.co/m-a-p/YuE2-3B · https://huggingface.co/m-a-p/YuE-s1-7B-anneal-en-cot · https://huggingface.co/ASLP-lab/DiffRhythm-base
- https://huggingface.co/stabilityai/SAME-L · https://huggingface.co/stabilityai/stable-audio-3-medium
- https://huggingface.co/stepfun-ai/Step-Audio-Chat · https://huggingface.co/stepfun-ai/Step-Audio-EditX
- https://huggingface.co/hexgrad/Kokoro-82M · https://huggingface.co/coqui/XTTS-v2 · https://huggingface.co/facebook/musicgen-medium · https://huggingface.co/facebook/audiogen-medium · https://huggingface.co/hkchengrex/MMAudio
- https://moises.ai/

**DSP/MIR libraries**

- https://github.com/MTG/essentia · https://github.com/MTG/essentia-models
- https://github.com/librosa/librosa · https://github.com/CPJKU/madmom · https://github.com/CPJKU/madmom_models
- https://github.com/aubio/aubio · https://github.com/spotify/basic-pitch
- https://github.com/sonicvisualiser/sonic-visualiser · https://github.com/sonicvisualiser/sonic-annotator · https://github.com/sonicvisualiser/tony
- https://github.com/facebookresearch/audiocraft · https://github.com/ace-step/ACE-Step · https://github.com/ace-step/ACE-Step-1.5

**KYX repo (read-only reference, not modified)**

- `docs/LOCAL-INTENT-MODEL.md` (lines 100–139 read) — Ollama provider, default model string `hf.co/LiquidAI/LFM2-1.2B-GGUF:Q4_K_M` (730 MB), GBNF constrained decoding
- `docs/IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md:614` — pinned `LiquidAI/LFM2.5-1.2B-Instruct` snapshot `0f604ada3f766f9f257460c4c9f0b5d6f69d431b`
