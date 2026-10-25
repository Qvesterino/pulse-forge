# AAW_AUDIO_MODEL_LANDSCAPE

**Status:** verified landscape of candidate models for an AI-Assisted Audio Workstation (AAW)
**Research cutoff:** 2026-10-25 (all time-sensitive claims timestamped)
**Scope:** models and DSP/MIR techniques by _capability role_, not by hype
**Companion docs:** `AAW_STATE_OF_THE_ART_2026.md`, `AAW_COMPETITIVE_CAPABILITY_MAP.md`, `AAW_SOURCE_LEDGER.md`

---

## 0. Method, and what was NOT done

**What was done.** Primary sources were fetched directly: Hugging Face model metadata APIs
(`/api/models/...?blobs=true`), the official Liquid AI documentation (`.md` pages), the Liquid4All
`liquid-audio` repository README, the Liquid Open License text, and Liquid's LFM2.5 launch blog.
Where no primary source existed, a secondary report is used and graded **C**; where a community
measurement exists it is graded **B**; where nothing could be confirmed, the cell reads **U**.

**What was NOT done — stated plainly.** No model was downloaded, no benchmark was re-run locally, no
listening test was performed, and no inference was executed on this machine. Every number below is
someone else's measurement, with the source and its date attached. Where a number matters to a
decision, it is an _experiment to run_, not a fact to trust (see `AAW_EXPERIMENT_BACKLOG.md`).

**Evidence grades**

| Grade | Meaning                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------- |
| **A** | Official primary source: model card, official docs, official repo, license text, vendor release post |
| **B** | Independent or community measurement, reproducible, with method stated                               |
| **C** | Secondary report or press coverage of a primary claim I did not read at source                       |
| **U** | Unverified — could not be confirmed, or no source states it                                          |

---

## 1. THE CANDIDATE: "LFM 2.5 Audio 1.5B"

The project plan proposes a candidate described as _LFM 2.5 Audio 1.5B_. **That candidate exists,
is public, and is downloadable today.** It is also **not** what its name suggests to a DAW engineer.

### 1.1 Identity — verified

| Property                | Value                                                               | Source               |
| ----------------------- | ------------------------------------------------------------------- | -------------------- |
| Official name           | `LFM2.5-Audio-1.5B`                                                 | HF API, 2026-10-25   |
| Publisher               | Liquid AI, Inc. (MIT CSAIL spinout)                                 | HF org page          |
| Canonical repo          | `LiquidAI/LFM2.5-Audio-1.5B`                                        | HF API               |
| Repo SHA                | `c362a0625dfe45aa588dce5f0ada28a7e5707628`                          | HF API               |
| Created / last modified | 2025-12-18 / 2026-03-30                                             | HF API               |
| Architecture            | `Lfm2AudioForConditionalGeneration`                                 | HF `config.json`     |
| Pipeline tag            | `audio-to-audio`                                                    | HF API               |
| Library                 | `liquid-audio` (pip)                                                | HF API / repo README |
| Base model              | `LiquidAI/LFM2-1.2B` (finetune)                                     | HF API               |
| Language coverage       | **English only** (a separate JP checkpoint exists)                  | HF card data, docs   |
| Adoption signal         | 6,762 downloads (30 d) / 21,093 all-time; 472 likes                 | HF API               |
| Paper                   | arXiv **2511.23404**, "LFM2 Technical Report", published 2025-11-28 | HF card              |

**Verdict on the brief's phrasing:** the candidate is real, but the exact public name is
`LFM2.5-Audio-1.5B` (no space), and it is **a speech-to-speech model — ASR, TTS, and interleaved
voice chat — not a music-understanding model and not a DAW planner.** Treating it as the latter would
be the single most expensive mistake available to this program.

### 1.2 Parameter breakdown — exact

| Component                           | Size                             | Note                                                                                                                                                |
| ----------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language model (LFM2.5 backbone)    | 1.2 B                            | 16 layers (10 LIV conv + 6 GQA), per Liquid's architecture description (grade **C**)                                                                |
| Audio encoder                       | 115 M                            | FastConformer, derived from NVIDIA `canary-180m-flash` (**Apache-2.0** code, **CC-BY-4.0** checkpoint)                                              |
| RQ-transformer + Mimi detokenizer   | ~185 M (derived)                 | The card names the components but does not break them down; ~185 M is the remainder of the published total after the 1.2 B LM and the 115 M encoder |
| **Total (HF safetensors metadata)** | **1,470,308,496**                | `BF16: 1,470,308,488`, `I64: 8`                                                                                                                     |
| Context length                      | 32,768 tokens                    | Card: "Context: 32,768"                                                                                                                             |
| Vocab                               | 65,536 (text) / 2049 × 8 (audio) | Card                                                                                                                                                |
| Precision                           | bfloat16                         | Card                                                                                                                                                |

> The "1.5B" in the name is the rounded total. The safetensors metadata says **1.470 B**. A report
> that says "1.5B" is not wrong; a report that says "1.2B" for this checkpoint **is**.

### 1.3 Audio I/O — verified from the official ONNX card

| Property            | Value                                                                              |
| ------------------- | ---------------------------------------------------------------------------------- |
| ASR input           | 16 kHz waveform → 128-bin log-mel, FFT 512, hop 160, window 400, pre-emphasis 0.97 |
| TTS/audio output    | 24 kHz waveform                                                                    |
| Codec               | Mimi, 8 codebooks × 2049 tokens (2048 = end-of-audio)                              |
| Frame rate          | 80 ms per audio frame (24 kHz, hop 320, 6× upsampling)                             |
| Autoregressive cost | 8 Depthformer calls per audio frame                                                |

_(All four rows: `LiquidAI/LFM2.5-Audio-1.5B-ONNX` README, fetched 2026-10-25, grade **A**.)_

**Consequence for a DAW:** a 3-minute song at 24 kHz is ~67,500 frames; at 8 Depthformer calls per
frame that is ~540,000 neural calls _per generation pass_. This is a **generation** cost, not an
analysis cost, but it bounds how fast any "regenerate this vocal line" feature can be, and it is why
the vocoder is a separate deployable component rather than an afterthought.

### 1.4 License — LFM Open License v1.0 (verified against the license text)

The license is **Apache-2.0-shaped with one commercial condition**, and it is friendlier than it
first looks for an independent developer:

| Question                   | Answer                                                                                            | Clause       |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ------------ |
| Commercial use             | **Free if the using legal entity's annual revenue is under USD 10,000,000**                       | §5(a)        |
| Above the threshold        | Commercial use is _not licensed_; separate commercial licence via `sales@liquid.ai`               | §5(b)        |
| Modification / fine-tuning | **Yes** — and the threshold also applies to derivatives                                           | §2, §5       |
| Copyleft on derivatives    | **None.** You may licence your fine-tune under your own terms, including proprietary              | §4           |
| Nonprofit / research       | Threshold does **not** apply to a Qualified Non-Profit for non-commercial or research use         | §5(c)        |
| Redistribution duties      | Ship the licence, retain copyright/NOTICE, mark modified files                                    | §3           |
| Termination                | **Automatic and immediate** on any breach — not only on the revenue clause                        | §11          |
| Downstream customers       | A customer's own revenue governs _their_ commercial use; a ≥$10M customer needs their own licence | Vendor guide |
| Liability                  | "In no event…" — no warranty, no liability, incl. for indirect damages                            | §10          |

_(License text: `LiquidAI/LFM2.5-Audio-1.5B/raw/…/LICENSE`; guide: `docs.liquid.ai/lfm/help/model-license`, both 2026-10-25, grade **A**.)_

**Read for KYX/ZYVO:** a sub-$10M independent studio is inside the free tier, forever, including
commercial redistribution of the weights and of fine-tunes. The three obligations that actually bite
are (a) ship the licence text with any redistribution, (b) mark modified files, (c) the **automatic
termination** clause — a compliance failure ends the licence instantly, so the licence file must be
vendored with the downloader, not fetched at runtime.

> #### 🔴 The finding that matters more than any benchmark: this is a **revenue-triggered licence cliff**
>
> §5(a) conditions the commercial-use grant on the **using legal entity not exceeding $10,000,000
> annual revenue**, and §5(b) states that commercial use by an entity above the Threshold "**is not
> licensed**". This is not an attribution obligation — it is a **cliff at a business milestone**.
>
> **It applies to the model KYX already pins.** The repo's intent model is
> `LiquidAI/LFM2.5-1.2B-Instruct` under the same LFM Open License v1.0. The day the product's legal
> entity crosses $10M annual revenue, the _shipped, bundled_ intent model is not legally usable —
> and because it is the pinned, fine-tuned centre of the product, replacing it is a **licensed
> migration, not a weight swap**.
>
> A permissively-licensed alternative that covers the same role already exists and is verified
> above: **Whisper large-v3 (Apache-2.0)** for ASR and **Phi-4-multimodal (MIT)** for understanding.
> The correct response is **not** to panic — it is to decide now, while the decision is cheap:
> which model is the _intent backbone_, and is the fallback path Apache/MIT-licensed? See
> `AAW_DECISION_LOG.md` **D-02** and `AAW_ROADMAP_2026_2029.md` Wave 0.
>
> Note also: the adapter `LFM2.5-1.2B-Instruct-smoltalk-LoRA` carries an `apache-2.0` tag — but it
> is an **adapter**, not the base weights. An adapter's permissiveness does not change the base
> model's terms.

**Replacement cost if Liquid vanished:** the weights are MIT-free-licensed (LFM 1.0) and mirrored on
the Hub, but the _pipeline_ (audio encoder lineage, detokenizer, training recipe, data-prep tooling)
would not survive a clean-room rebuild quickly. Mitigation: versioned adapter + pinned artefacts
(§6) — the model is a swappable implementor of an interface, never the interface itself.

### 1.5 Deployment artifacts — exact sizes, measured from the Hub

| Artifact                | Repo                                                                                       | Key files (bytes)                                                                                                                                                       | Total download                    |
| ----------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Safetensors (reference) | `LiquidAI/LFM2.5-Audio-1.5B`                                                               | `model.safetensors` 2,940,723,992 + `audio_detokenizer/model.safetensors` 314,137,512 + tokenizer 384,644,900                                                           | **~3.64 GB** (repo `usedStorage`) |
| **GGUF / llama.cpp**    | `LiquidAI/LFM2.5-Audio-1.5B-GGUF`                                                          | `…-Q4_0.gguf` 695,750,880 + `mmproj-…-Q4_0` 219,511,136 + `vocoder-…-Q4_0` 108,986,560 + `tokenizer-…-Q4_0` 50,546,112                                                  | **~1.07 GB** (Q4_0 set)           |
| GGUF F16                | same                                                                                       | 2,343,325,920 + 458,806,624 + 387,159,232 + 142,699,392                                                                                                                 | ~3.33 GB                          |
| **ONNX / WebGPU**       | `LiquidAI/LFM2.5-Audio-1.5B-ONNX`                                                          | `decoder_q4` 1,217,650,688 + `audio_encoder_q4` 139,110,400 + `vocoder_depthformer_q4` 187,166,720 + `audio_detokenizer_q4` 56,481,416 + `embed_tokens.bin` 536,870,912 | **~2.14 GB** (Q4 set)             |
| ONNX FP16               | same                                                                                       | `decoder_fp16` 2,134,741,952 + encoder 239,864,320 + depthformer 236,019,712 + detokenizer 89,952,772                                                                   | ~2.70 GB                          |
| MLX (Apple)             | `mlx-community/LFM2.5-Audio-1.5B-8bit`                                                     | —                                                                                                                                                                       | **U** (not measured here)         |
| Hosted LEAP             | `LiquidAI/LFM2.5-Audio-1.5B-GGUF-LEAP`                                                     | —                                                                                                                                                                       | cloud endpoint, pricing **U**     |
| JP checkpoints          | `…-JP`, `…-JP-GGUF` (created 2026-05-26/27; GGUF last modified 2026-09-11, 258k downloads) | —                                                                                                                                                                       | Japanese only                     |

_(All byte counts: Hugging Face `/api/models/...?blobs=true`, 2026-10-25, grade **A**.)_

**Browser reality check.** Liquid's own docs state the audio models can "Run ASR and TTS and
interleaved conversations **entirely in-browser** using LFM2.5-Audio-1.5B with **WebGPU**
acceleration" (grade **A**), and the ONNX card ships a working `onnxruntime-web` WebGPU example with
Q4 decoder + Q4 vocoder, plus transformers.js Spaces using it. So a **browser-resident speech model
is a demonstrated fact, not a wish** — but the payload is ~2.1 GB, which is 2,000× KYX's 1,070 KB
entry budget. It therefore cannot be a boot-path dependency; it can only be an **explicit,
user-initiated, cached download** — the same pattern KYX already uses for its ONNX intent model
(`pf:intent-model`, ~6.75 MB). The gap between 6.75 MB and 2.1 GB is the real engineering problem.

### 1.6 Measured performance — what exists, and what it does not

> #### ⚠ AUDIT CORRECTION (2026-10-25, second pass) — stated explicitly
>
> An earlier draft of this section asserted that **the publisher had not published ASR accuracy**
> for the English checkpoint, and listed that as evidence gap G-1. **That assertion was wrong.**
> The model card's raw README **does** carry a VoiceBench table and an ASR WER table, reproduced
> verbatim below (fetched 2026-10-25 from
> `huggingface.co/LiquidAI/LFM2.5-Audio-1.5B/raw/main/README.md`). The gap G-1 is therefore
> **closed as "published, vendor-reported, no independent re-evaluation found"** — not "unpublished".
>
> The correction is not cosmetic: the numbers **change the recommendation**. The model is _not_ the
> accuracy leader in its class, and the reason to choose it is engineering shape, not quality.

**(a) Vendor-published benchmarks — VoiceBench (audio input) and ASR WER**

| Model                         | Size  | VoiceBench Overall ↑ | ASR WER avg ↓ |
| ----------------------------- | ----- | -------------------- | ------------- |
| **LFM2.5-Audio-1.5B**         | 1.5 B | **54.92**            | **7.53**      |
| LFM2-Audio-1.5B (predecessor) | 1.5 B | 52.77                | 9.38          |
| Qwen2.5-Omni-3B               | 5 B   | **63.57**            | 7.90          |
| Whisper-large-V3              | 1.5 B | — (ASR only)         | **7.44**      |
| Moshi                         | 7 B   | 29.51                | —             |
| Mini-Omni2                    | 0.6 B | 33.49                | —             |

_(Source: model card raw README, 2026-10-25 — grade **A** for existence. **All figures are
vendor-reported**; no independent re-evaluation was found. Per-dataset WER, LFM2.5-Audio vs
Whisper-large-V3: AMI 15.63/15.95 · Earnings22 14.56/**11.29** · GigaSpeech 10.47/10.02 ·
LibriSpeech-clean **1.95**/2.01 · LibriSpeech-other 4.30/**3.91** · SPGISpeech **2.76**/2.94 ·
TED-LIUM **3.47**/3.86 · VoxPopuli **7.13**/9.54.)_

**Read this honestly — it changes the recommendation.** The model is **not** the accuracy leader:
`Qwen2.5-Omni-3B` beats it on VoiceBench (63.57 vs 54.92) at 3.3× the parameters, and
`Whisper-large-V3` edges it on average WER (7.44 vs 7.53) at the _same_ size and with _no_ speech
decoder to carry. On read speech the two are within ~1 point on 7 of 8 corpora — a statistical tie
that says nothing about singing. What LFM2.5-Audio buys is **shape**: 1.5 B parameters, a
llama.cpp CPU path, an ONNX/WebGPU path, a first-party fine-tuning recipe, and **one** model doing
ASR + TTS + interleaved voice chat instead of three. That is a genuine on-device advantage — an
**engineering** advantage, not an **accuracy** advantage, and this report does not conflate them.

**(b) TTS quality — vendor-reported (Liquid blog "Introducing LFM2.5", 2026-01-05, grade A-for-existence / B-for-comparability):**

| Model                              | STOI ↑   | UTMOS ↑  | DNSMOS p.838 ↑ | DNSMOS p.808 ↑ |
| ---------------------------------- | -------- | -------- | -------------- | -------------- |
| **LFM2.5 detokenizer, INT4 (QAT)** | **0.89** | **3.53** | **3.09**       | **3.66**       |
| LFM2 (Mimi), FP32                  | 0.89     | 3.65     | 3.12           | 3.68           |
| LFM2 (Mimi), INT4                  | 0.87     | 3.11     | 2.98           | 3.62           |

Read honestly: the INT4 LFM2.5 detokenizer is **statistically indistinguishable from the FP32
predecessor on speech quality** and is **8× faster on a mobile CPU**. That is a _TTS_ claim. It says
nothing about transcription accuracy, and nothing about music.

**(c) ASR real-time factor — community-measured** (llama.cpp community adapter PR `0xShug0/audio.cpp#758`,
grade **B**; 200 LibriSpeech test-clean + 200 CommonVoice 8.0 ja utterances, model loaded):

| Backend                            | EN F16   | JP F32 | EN Q4_0   |
| ---------------------------------- | -------- | ------ | --------- |
| CUDA, NVIDIA A10                   | 0.027    | 0.037  | **0.017** |
| Metal, Apple M3 Ultra              | 0.034    | 0.042  | 0.021     |
| **CPU, Linux x86-64 (16 threads)** | **0.11** | 0.14   | **0.077** |
| CPU, Apple M3 Ultra                | 0.10     | 0.17   | 0.059     |

RTF < 1 means faster than real time. **CPU-only ASR at RTF 0.077 on a 16-thread x86-64 box is the
single most decision-relevant number in this document**: a ZYVO user on an ordinary desktop machine
can transcribe a vocal take offline, faster than playback, with no GPU and no network. Memory ≈
package size (≈1.07 GB at Q4_0).

**(d) The limitation that decides the architecture — long audio degrades catastrophically in the
official path** (same PR, grade **B**):

| Setup                                              | 30 s          | 120 s         | 180 s         |
| -------------------------------------------------- | ------------- | ------------- | ------------- |
| Official `liquid-audio` single pass, EN F16 (CUDA) | 2.8 % WER     | **83 %**      | **296 %**     |
| llama.cpp community adapter, EN F16 (CUDA)         | 1.3–2.3 % WER | 1.3–2.3 % WER | 1.3–2.3 % WER |

A WER of 296 % means the transcript is longer than the input — the model is degenerating, not merely
degrading. **A song is 2–5 minutes.** Any DAW that feeds a full song into the official single-pass
ASR path gets garbage; the same input through the llama.cpp adapter stays flat. This single finding
reorders the roadmap: _the runtime, not the weights, is the risk_. It also means a "singing takes a
90-second phrase" scope is safe while "transcribe the whole track" is not, until the adapter path is
proven on the target runtime.

**(e) ASR accuracy, Japanese (secondary — grade C; the primary JP release page should be read
before this number is quoted to anyone else):**

| Dataset                 | LFM2.5-Audio-1.5B-JP | Whisper-large-v3 | Note                                     |
| ----------------------- | -------------------- | ---------------- | ---------------------------------------- |
| CommonVoice 8 (ja)      | **4.42 CER**         | 8.5              | LFM better                               |
| JSUT Basic 5000         | 8.07                 | **7.1**          | Whisper better                           |
| ReazonSpeech (held-out) | 24.24                | —                | Worse than `reazonspeech-nemo-v2` (11.2) |

The pattern — _wins on conversational read speech, loses on domain-shifted and noisy speech_ — is
the classic small-ASR-model profile and is the reason §4 demands a **domain-specific** measurement
before this model is trusted on lyrics, room tone, or a live stage.

### 1.7 Fine-tuning support — verified

`liquid-audio` **v1.2.0** ships data-preparation tools and a lightweight trainer; fine-tuning is
supported in **both interleaved and sequential** generation modes, and the vendor states the supported
task set explicitly: _"from ASR and TTS to function calling and end-to-end speech-to-speech chat"_
(README + `liquid-audio` release notes, grade **A**). The documented path is:

```
raw rows → list[ChatMessage]  →  LFM2AudioChatMapper  →  LFM2DataLoader  →  train
```

`ChatMessage` supports `TextSegment`, `AudioSegment`, and `InterleavedSegment`. A worked example
fine-tunes on the Jenny TTS dataset. **This is the only "foundation-model fine-tuning" path in the
entire landscape that is both vendor-supported and cheap enough for an independent developer** — it is
the first candidate to reach for if a measurable baseline failure demands it.

### 1.8 What the candidate is NOT

| It is not                   | Evidence                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A music-understanding model | Card data: `language: [en]`, `pipeline_tag: audio-to-audio`, tasks = ASR/TTS/voice chat. No music, MIR, tagging, or audio-embedding task appears in the card, the docs page, or the README                                                                                                                                  |
| A Slovak or Czech model     | Docs: "Supported Language: English"; a separate JP checkpoint exists; no Slovak/Czech anywhere (grade **A** for EN/JA, **U**→ effectively absent for SK)                                                                                                                                                                    |
| A DAW planner               | No project model, no command schema, no tool protocol; its chat template accepts a tool list, but the tools would have to be invented by us                                                                                                                                                                                 |
| Benchmarked                 | The HF repo carries **no `eval-results`** metadata and the model page shows no benchmark table; the official docs page for LFM2.5-Audio-1.5B shows **no ASR accuracy table** (only TTS-quality metrics in the blog) — **the ASR accuracy of the English checkpoint is therefore unverified by its publisher** (grade **U**) |
| Small                       | 1.47 B params, ~1.07 GB at Q4_0, ~2.1 GB ONNX Q4                                                                                                                                                                                                                                                                            |

---

## 2. The model KYX/ZYVO actually use today (text, not audio)

| Property           | `LiquidAI/LFM2.5-1.2B-Instruct`                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Repo / SHA         | `LiquidAI/LFM2.5-1.2B-Instruct` / `0f604ada3f766f9f257460c4c9f0b5d6f69d431b`                          |
| Created / modified | 2026-01-06 / 2026-08-24                                                                               |
| Parameters         | **1,170,340,608** (BF16), 2.34 GB safetensors                                                         |
| Pipeline           | `text-generation`, library `transformers`                                                             |
| Languages          | en, ar, zh, fr, de, ja, ko, es — **no Slovak** (grade **A**)                                          |
| License            | LFM Open License v1.0 (same $10M threshold)                                                           |
| Adoption           | 113,772 downloads (30 d); carries `eval-results` metadata — benchmarked, unlike the audio sibling     |
| Tool calling       | Chat template renders `<tool_call>` blocks — tool use is a first-class template feature (grade **A**) |

**This is the model the KYX repo already pins** (`LiquidAI/LFM2.5-1.2B-Instruct`, snapshot
`0f604ada…`, loaded through Ollama as the action-only intent→plan provider). The repo's own
characterisation — _a text model, optional, desktop-side, behind a gate_ — is **correct** and matches
Liquid's own documentation ("LFM2.5-1.2B-Instruct is a general-purpose **text-only** model").
The brief's "LFM 2.5 Audio 1.5B" is a _different, newer, audio-capable_ sibling that the repo does
not currently integrate.

> **Two operational facts the repo should resolve (surfaced by this audit, not yet acted on):**
>
> 1. **Licence.** This model carries the same LFM Open License v1.0 and therefore the same $10M
>    revenue cliff as the audio model. See the box in §1.4 and `AAW_DECISION_LOG.md` D-02.
> 2. **A naming inconsistency between two docs.** `docs/LOCAL-INTENT-MODEL.md:113-114` documents the
>    Ollama default as `hf.co/LiquidAI/LFM2-**1.2B**-GGUF:Q4_K_M` (the **LFM2** checkpoint, 730 MB)
>    while the roadmap and the SFT base pin **LFM2.5**-1.2B-Instruct. Both checkpoints exist; the
>    desktop default and the training base therefore point at _different base models_, and the
>    documented smoke test on the LFM2 base reports **schema-legal 8/8 but expected-kind 3/8** —
>    the base model guessing, which is exactly what the SFT fine-tune fixes. This is a decision to
>    make deliberately, not a typo to silently patch: see `AAW_DECISION_LOG.md` D-03.

**Vendor-reported performance for the text model** (model card, grade **A**): **239 tok/s decode on
AMD CPU, 82 tok/s on mobile NPU, under 1 GB of memory**; tool use is documented as a first-class
feature (tools declared as a JSON object in the system prompt, model emits **Pythonic function
calls** between `<|tool_call_start|>` / `<|tool_call_end|>`); documented fine-tuning recipes are
**LoRA SFT via Unsloth and TRL, and DPO via TRL**. Runtimes: llama.cpp (GGUF), **ONNX Runtime**,
**MLX**, vLLM, SGLang. The repo's own design — _deterministic pre-filter → constrained JSON/GBNF
decoding → validated output_ — is precisely the documented pattern for this model class.

**Consequence:** the repo's text-model characterisation is not stale; it is _accurate_. What changes
the plan is that an audio sibling now exists, with CPU-only real-time ASR measured at RTF 0.077.

---

## 3. Landscape by capability role

Only rows with a located source are listed. `U` marks capability that could not be confirmed.

### 3.1 A — Audio understanding / audio-language models

| Model / system                        | Role                                                                        | Params        | License                         | Audio I/O                          | Fine-tune                    | Local footprint                                                       | Evidence                 |
| ------------------------------------- | --------------------------------------------------------------------------- | ------------- | ------------------------------- | ---------------------------------- | ---------------------------- | --------------------------------------------------------------------- | ------------------------ |
| `LiquidAI/LFM2.5-Audio-1.5B`          | speech-to-speech: ASR, TTS, interleaved chat                                | 1.47 B        | LFM 1.0 (<$10M commercial)      | in 16 kHz / out 24 kHz             | **Yes** (v1.2.0, both modes) | 1.07 GB Q4_0 / 2.14 GB ONNX Q4                                        | **A**                    |
| `LiquidAI/LFM2.5-Audio-1.5B-JP`       | same, Japanese                                                              | 1.47 B        | LFM 1.0                         | same                               | not verified                 | GGUF — **258 k downloads/mo** (most-downloaded Liquid audio artefact) | **A**                    |
| `LiquidAI/LFM2-Audio-1.5B`            | predecessor — **deprecated**                                                | 1.47 B        | LFM 1.0                         | same                               | yes                          | same                                                                  | **A**                    |
| **`LiquidAI/d1-omni-600M`**           | **audio+vision _decision_ model — emits an action, no output tokens**       | 587 M         | LFM 1.0                         | audio+vision in, **no tokens out** | not verified                 | GGUF + MLX, 16 K ctx                                                  | **A**                    |
| `Qwen/Qwen3-Omni-30B-A3B-Instruct`    | omni: text/image/audio/video in, speech out, streaming                      | 35.26 B (A3B) | **Apache-2.0**                  | yes                                | yes (Captioner recipe)       | ~35 GB bf16 (−10 GB with `disable_talker()`)                          | **A**                    |
| `Qwen/Qwen3-Omni-30B-A3B-Captioner`   | **audio → detailed structured text** ("low-hallucination" audio captioning) | 31.72 B       | **Apache-2.0**                  | audio→text                         | _is_ a fine-tune             | ~32 GB                                                                | **A**                    |
| `moonshotai/Kimi-Audio-7B-Instruct`   | audio understanding + generation (ASR, AQA, SER, SEC)                       | 9.77 B        | **MIT**                         | audio→text/speech                  | partial                      | ~20 GB                                                                | **A** (SOTA claim **C**) |
| `nvidia/audio-flamingo-3-hf`          | audio _reasoning_                                                           | 8.27 B        | **NVIDIA OneWay Noncommercial** | audio→text                         | no                           | ~17 GB                                                                | **A**                    |
| `microsoft/Phi-4-multimodal-instruct` | speech+vision LM                                                            | 5.57 B        | **MIT**                         | audio→text (**`cs` supported**)    | yes                          | ~11 GB                                                                | **A**                    |
| `google/gemma-3n-E2B-it`              | on-device audio understanding                                               | 5.44 B        | Gemma Terms (gated)             | audio→text                         | yes                          | ~11 GB                                                                | **A**                    |
| `m-a-p/MERT-v1-95M`                   | music embeddings (self-supervised)                                          | 95 M          | **CC-BY-NC-4.0**                | audio→emb                          | yes                          | ~0.4 GB                                                               | **A**                    |
| `SonyCSLParis/music2latent`           | timbre / interval similarity                                                | small         | **CC-BY-NC-4.0**                | audio→emb                          | n/a                          | small                                                                 | **A**                    |
| `laion/clap-htsat-fused`              | text↔audio embeddings                                                       | 154 M         | **Apache-2.0**                  | audio↔text                         | no                           | ~0.6 GB                                                               | **A**                    |
| `stepfun-ai/Step-Audio-Chat`          | audio↔text                                                                  | 131.9 B stack | **Apache-2.0**                  | audio↔text                         | —                            | server-class                                                          | **A**                    |
| `stepfun-ai/Step-Audio-EditX`         | audio editing                                                               | 3.53 B        | **no licence tag — U**          | audio→audio                        | —                            | —                                                                     | **U**                    |

**Honest statement:** for _music_ understanding, this landscape is thin, and **the licensing is the
binding constraint, not the capability**. Three independent findings:

1. **The strongest open audio-understanding models are not commercially usable.**
   `audio-flamingo-3` is under the **NVIDIA OneWay Noncommercial** licence; `MERT` and
   `music2latent` are **CC-BY-NC-4.0**. The "fully open audio-LM wave" is largely not usable in a
   commercial DAW.
2. **The commercially usable ones are either huge or not really music models.** `Qwen3-Omni`
   (Apache-2.0) is 35 B / ~35 GB — server class. `LFM2.5-Audio` is 1.47 B but **English speech**.
   `Phi-4-multimodal` (MIT, 5.57 B) covers `cs` but not `sk`.
3. **The one architecture that matches an AAW's needs is 19 days old.**
   `d1-omni-600M` (2026-10-05) _listens and decides_ rather than generates — audio+vision in, a
   discrete action out, no output tokens, GGUF/MLX, CPU-runnable. Structurally this is exactly a
   DAW action router. It is also LFM-licensed (same cap) and its audio training data is English.
   **Treat it as a research lead to measure, not a dependency.**

**Consequence:** the perception layer of an AAW cannot be delegated to a frontier audio-LLM in 2026. It must be **deterministic DSP/MIR plus embeddings**, with a learned audio model treated as
an experiment to be measured against that baseline.

### 3.2 B — Speech recognition / transcription / vocal activity & phonetic alignment

| Model                           | Slovak                                     | Params            | License    | Notes                                                            | Evidence                                |
| ------------------------------- | ------------------------------------------ | ----------------- | ---------- | ---------------------------------------------------------------- | --------------------------------------- |
| `openai/whisper-large-v3-turbo` | **Yes** (`sk` in the 99-language tag list) | 808,878,080 (F16) | **MIT**    | 5.8 M downloads; the only verified Slovak-capable ASR found here | **A** (HF API, 2026-10-25)              |
| `openai/whisper-large-v3`       | Yes                                        | ~1.55 B           | MIT        | reference quality                                                | **A** (base model id in turbo metadata) |
| `LiquidAI/LFM2.5-Audio-1.5B`    | **No** (en + ja)                           | 1.47 B            | LFM 1.0    | RTF 0.077 CPU Q4_0; degrades on long audio in official path      | **A** / **B**                           |
| Silero VAD                      | n/a                                        | small             | MIT-family | utterance segmentation                                           | **U** (not verified here)               |
| faster-whisper / whisper.cpp    | n/a                                        | wrapper           | MIT        | CTranslate2 and GGUF runtimes; the practical CPU path            | **U**                                   |

**Slovak conclusion:** Whisper is the only _verified_ Slovak-capable transcription path in this
document. LFM2.5-Audio is English/Japanese only. If ZYVO must understand Slovak lyrics, whisper-
family models remain the baseline, and LFM2.5-Audio can at most be evaluated as an English-only
offload — or fine-tuned (its trainer supports ASR fine-tuning) if a Slovak fine-tune is ever
justified by a measured failure.

### 3.3 C — MIR, audio embeddings, tagging, similarity

| Item                                                               | Status                         | Notes                                                                    | Evidence |
| ------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------ | -------- |
| Essentia (Spotify)                                                 | MIR toolbox                    | classical DSP/MIR, BSD-style                                             | **U**    |
| librosa / madmom / aubio                                           | MIR Python libs                | classical                                                                | **U**    |
| CLAP (LAION)                                                       | zero-shot audio↔text embedding | enables "timbral search by intent" without training                      | **U**    |
| MusiXmatch / MXM feature datasets                                  | MIR ground truth               | licensing varies                                                         | **U**    |
| Song structure segmentation (e.g. Beat-Transformer-style)          | structure                      | research, no production-grade OSS confirmed                              | **U**    |
| Source separation (Demucs, BS-RoFormer/UVR5, Spleeter, Open-Unmix) | stem extraction                | **essential caveat: separation artefacts corrupt downstream perception** | **U**    |

### 3.4 D — Beat / pitch / harmony / onset / structure — the deterministic baseline

The pragmatic, defensible foundation for AAW perception is **classical DSP/MIR**, not a learned
audio-LLM: autocorrelation/onset-envelope beat tracking, YIN/pYIN F0 and voicing, chroma + template
key/chord estimation, spectral flux, LUFS/R128 loudness, MFCC timbre, and self-similarity matrix
structure segmentation. Each is deterministic, millisecond-cheap, CPU-only, explainable, and has
no licence cliff. **For this repository the relevant question is not "which model?" but "which of
these already exist in `src/audio-engine/`?" — answered by the KYX repo audit, not by this
document.** What this document contributes: the _rule_ that any perception output must be
**reproducible and timestampable**, so an agent's claim can be checked against the audio.

### 3.4.1 The MIR library licence landscape — and a copyleft decision that must be made now

| Library         | Repo                               | Licence        | Notes                                                                                                                             |
| --------------- | ---------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Essentia        | `MTG/essentia`                     | **AGPL-3.0** ⚠ | The reference MIR toolbox; **strong copyleft**. Linking it into a proprietary DAW is a licensing decision, not an engineering one |
| aubio           | `aubio/aubio`                      | **GPL-3.0** ⚠  | Onset/beat/pitch in C; **strong copyleft**                                                                                        |
| madmom          | `CPJKU/madmom`                     | BSD-2-Clause   | RNN beat/onset tracking; permissive                                                                                               |
| librosa         | `librosa/librosa`                  | ISC            | Permissive; Python                                                                                                                |
| basic-pitch     | `spotify/basic-pitch`              | Apache-2.0     | audio→MIDI; ONNX/GGUF ports exist — **the most browser-friendly bridge from audio to notes**                                      |
| sonic-annotator | `sonic-visualiser/sonic-annotator` | GPL-2.0 ⚠      | Batch feature extraction; **copyleft**                                                                                            |

**Recommendation (needs an ADR, not a guess):** any AGPL/GPL MIR component must run behind a
**separate-process / IPC boundary** — shipped as an unmodified binary or a sidecar service — rather
than linked into the product. This is the standard remedy for strong copyleft in a proprietary
application, and it costs one process rather than a rewrite. Note that the _model_ licences shipped
by Essentia are separately graded **U** (`NOASSERTION`, stale README) and must be confirmed before
any of them are redistributed.

### 3.5 E — Generation / editing

**The commercial-licence filter is decisive here, and it is stricter than the capability filter.**

| Model                 | Repo                                          | Params       | Licence                                                           | Commercial use in a DAW?                              | Local viability                                                                                                          | Evidence                    |
| --------------------- | --------------------------------------------- | ------------ | ----------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| **ACE-Step 1.5**      | `ACE-Step/Ace-Step1.5` (+ `-sft`, `-base`)    | 2.39 B (sft) | **MIT + explicit commercial-use grant on generated output**       | ✅ **Yes — the only verified option**                 | **< 4 GB VRAM**; **< 2 s**/song on A100, **< 10 s** on RTX 3090; CPU/MPS/ROCm/XPU; **LoRA from 8 songs / 1 h on a 3090** | **A**                       |
| ACE-Step v15 XL base  | `ACE-Step/acestep-v15-xl-base`                | 4.99 B       | MIT                                                               | ✅                                                    | ≥ 12 GB VRAM with offload, ≥ 20 GB recommended                                                                           | **A**                       |
| YuE2                  | `m-a-p/YuE2-3B`                               | 3.63 B       | **CC-BY-NC-4.0**                                                  | ❌                                                    | —                                                                                                                        | **A**                       |
| DiffRhythm            | `ASLP-lab/DiffRhythm-base`                    | —            | **Apache-2.0** _front-matter conflict_ (`stable-audio-community`) | ⚠ unresolved                                          | —                                                                                                                        | **A** (conflict flagged)    |
| MusicGen / AudioGen   | `facebook/musicgen-medium`, `audiogen-medium` | ~1.5 B       | **CC-BY-NC-4.0**                                                  | ❌                                                    | ~3 GB                                                                                                                    | **A**                       |
| MMAudio               | `hkchengrex/MMAudio`                          | —            | **CC-BY-NC-4.0**                                                  | ❌                                                    | video→audio                                                                                                              | **A**                       |
| Audio Flamingo 3      | `nvidia/audio-flamingo-3-hf`                  | 8.27 B       | **NVIDIA OneWay Noncommercial**                                   | ❌                                                    | —                                                                                                                        | **A**                       |
| SAME-L                | `stabilityai/SAME-L`                          | 852 M        | Stability AI Community Licence                                    | ⚠ non-permissive                                      | —                                                                                                                        | **A**                       |
| Stable Audio 3 medium | `stabilityai/stable-audio-3-medium`           | 2.31 B       | `license: other`, **gated**                                       | ⚠                                                     | —                                                                                                                        | **C** (card 401)            |
| Kokoro TTS            | `hexgrad/Kokoro-82M`                          | 82 M         | **Apache-2.0**                                                    | ✅                                                    | ~0.3 GB                                                                                                                  | **A**                       |
| XTTS-v2 voice clone   | `coqui/XTTS-v2`                               | —            | `license: other` (CPML — **non-commercial**; body not read)       | ❌ / **U**                                            | —                                                                                                                        | **A** (tag) / **U** (terms) |
| Step-Audio-EditX      | `stepfun-ai/Step-Audio-EditX`                 | 3.53 B       | **no licence tag — U**                                            | ❌ until confirmed                                    | —                                                                                                                        | **U**                       |
| Suno / Udio (closed)  | commercial generators                         | —            | proprietary                                                       | ⚠ **output licensing is the blocker, not capability** | API only                                                                                                                 | see competitive map         |
| `d1-omni-600M`        | Liquid AI                                     | 587 M        | LFM 1.0                                                           | ✅ below $10M                                         | GGUF/MLX, CPU                                                                                                            | **A**                       |

**The one-line conclusion that changes a roadmap:** _the best open music generators are
non-commercial, and the one commercially licensed generator is small, fast, and LoRA-able._ That is
**good news** for a solo developer — it means a generation feature is affordable on the assumed
6–16 GB VRAM tier and legally usable. It also means the generation bet should target
**ACE-Step 1.5** (MIT, < 4 GB VRAM, < 10 s on a 3090) and not the larger, more famous models —
which are unusable commercially anyway.

### 3.6 F — Small task-specific models

| Item                                     | Role                                 | Notes                                                                                                             | Evidence     |
| ---------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------ |
| KYX browser ONNX intent model            | slot-filling / intent classification | ~6.75 MB multi-head ONNX; **already shipped in-repo**; its `valHeadAccuracyMean` is _not_ a musical-quality score | repo (audit) |
| KYX LFM SFT (`kyx-intent-v30-q8`)        | LoRA-tuned intent→plan               | Ollama, Q8_0, ~1.16 GB; pinned eval reports in `scripts/data/intent-sft/`                                         | repo (audit) |
| Silero VAD, small classifiers, rerankers | utility                              | cheap, replaceable                                                                                                | **U**        |

### 3.7 G — Multimodal planners / tool users

| Model                                        | Role                     | Context           | Tool use       | Evidence                                                   |
| -------------------------------------------- | ------------------------ | ----------------- | -------------- | ---------------------------------------------------------- |
| `LiquidAI/LFM2.5-1.2B-Instruct`              | local intent→plan        | 32K (LFM2 family) | yes (template) | **A**                                                      |
| Larger frontier LLMs (vendor-hosted)         | planning, code, critique | large             | yes            | **U** (deliberately out of scope for a local-first budget) |
| Local coding models (Qwen-Coder-class, etc.) | tool user                | 32K+              | yes            | **U**                                                      |

**Design consequence:** for an AAW, the _planner_ is the component most likely to be swapped
vendor-to-vendor. Therefore the planner's output contract (§6) must be a **narrow typed language**,
not prose — so that a weaker local model and a stronger cloud model are interchangeable, and a
weaker local model can be _refused_ safely.

---

## 4. Where a model is required, and where it is not

| Task class                                                 | Correct tool                                                                       | Why a model is unnecessary / insufficient                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Loudness, clipping, phase correlation, LUFS                | deterministic DSP                                                                  | exact, cheap, verifiable                                                              |
| Onset/beat tracking, F0, chord estimation                  | DSP/MIR                                                                            | deterministic, debuggable; models add error without audibility benefit                |
| "Does this take sound worse than the last one?"            | **no model** — A/B + user choice                                                   | the ground truth is the user, not a metric                                            |
| "Which of these 4 takes has the best intonation?"          | rule/scoring + user                                                                | subjective; model adds false confidence                                               |
| "Make the chorus feel like the intro"                      | **grammar + retrieval + render-verification**                                      | musical relations are structural, not perceptual-and-fuzzy                            |
| "Find a sound that sounds like 'warm and slightly broken'" | **audio embeddings (CLAP-class) + retrieval**                                      | zero-shot text↔audio alignment is exactly what embeddings do; training is unjustified |
| "Turn this phrase into a tight loop"                       | DSP + explicit algorithm                                                           | deterministic result is better than a generated approximation                         |
| "Transcribe this take"                                     | ASR model                                                                          | genuinely learned; verified competitors exist (Whisper MIT, LFM2.5-Audio LFM 1.0)     |
| "Understand that the second chorus needs more tension"     | **hybrid**: embeddings/analysis for evidence + LLM for phrasing + user for meaning | no single model does this today at any price                                          |
| "Judge whether the mix is good"                            | **no model — refuse**                                                              | this is where AI products overclaim                                                   |

---

## 5. Deployment architectures (evaluated, not assumed)

### A. Local-first (primary)

| Tier                           | Hardware                                       | Stack                                                                                                                                                                                                    | Fits?                                                                                               |
| ------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Development tier (assumed)** | 6–16 GB VRAM, 64 GB RAM, 1 dev + coding agents | Whisper-turbo (CT2/ONNX, CPU int8) for Slovak ASR; LFM2.5-Audio Q4_0 (llama.cpp) for English ASR/voice-chat experiments; LFM2.5-1.2B-Instruct (Ollama, Q8) for intent→plan; ONNX intent model in browser | **Yes**, comfortably: ~1.1 GB ASR + ~1.2 GB LLM + ~6.75 MB browser model; CPU-only ASR at RTF 0.077 |
| **Aspirational tier**          | 24–48 GB VRAM, 128 GB RAM, team                | + local music-generation stack (ACE-Step-class), larger audio LLM, larger rerankers                                                                                                                      | **Conditional** on §7 experiments; not a prerequisite for the foundation                            |
| **Browser-resident**           | user's WebGPU device                           | LFM2.5-Audio-1.5B-ONNX Q4 (~2.14 GB) for ASR/TTS                                                                                                                                                         | **Feasible but heavy**: user-initiated download only, never boot path                               |

### B. Hybrid

Local perception + local planner, **opt-in cloud** for (a) heavy generation, (b) a stronger critic
model on large diffs, (c) red-team review of a proposed plan before commit. Cloud must be
**degradable**: with the network off, the product must still be a complete DAW. The repo's existing
position (`docs/AI-PRODUCER-CONTRACT.md`: "Browser users can create, edit, save, play and export
with the existing deterministic tools") is the correct invariant and must not be weakened.

### C. Cloud-assisted only

Rejected as the default: it violates the product's local-first premise, creates per-minute cost
against a small-team budget, and puts user audio behind a network boundary. Cloud is an **optional
accelerator**, never the source of truth.

---

## 6. The model-provider interface (sketch — full contract in `AAW_AI_CONTROL_CONTRACTS.md`)

Every model sits behind a versioned adapter. The product never learns a vendor's vocabulary.

```ts
// provider contract — a model is an implementor, never a dependency
interface AudioModelProvider {
  readonly id: string; // "lfm2.5-audio-1.5b" | "whisper-large-v3-turbo" | …
  readonly version: string; // pinned artifact revision, e.g. sha256
  readonly capabilities: readonly ("asr" | "tts" | "speech-to-speech" | "audio-embedding" | "plan" | "rank")[];
  readonly languages: readonly string[]; // ["en"] — Slovak ABSENT for LFM audio
  readonly maxInputSeconds: number; // 0 = unbounded (see §1.6c — LFM must be chunked)
  readonly realtimeFactor: number | null; // measured, not guessed

  transcribe(req: { audio: AudioBuffer; language?: string }): Promise<Transcript>;
  embed?(req: { audio: AudioBuffer }): Promise<Float32Array>;
}

// The product asks a ROLE, not a MODEL.
interface ModelRouter {
  resolve(role: "asr" | "plan" | "critic" | "embed"): ProviderSpec;
}
```

**Rules this interface enforces (and why they are non-negotiable):**

1. `maxInputSeconds` is a first-class field because the LFM official path is _known_ to fail on
   > 120 s audio (§1.6c). A provider that cannot state its limit is not admissible.
2. `realtimeFactor` is measured, not assumed; a provider without a measured RTF is `null` and is
   refused by any latency-gated feature.
3. `languages` is explicit, so a Slovak request can never be silently routed to an English-only
   model — a failure mode that would otherwise surface as garbage transcripts.
4. `version` pins the artifact digest, so "the model changed" is a detectable event, not a mystery.

---

## 7. Where training is justified — and where it is not

The decision tree (full version in `AAW_TRAINING_AND_DATA_STRATEGY.md`):

```
Is the failure reproducible and measured?            ── no → fix the baseline, not the model
   │yes
Is it a *labeling* failure (wrong target), not a
*capability* failure?                                ── yes → fix labels / retrieval / prompts
   │no
Does a deterministic algorithm exist that a competent
engineer could write in < 2 weeks?                    ── yes → write it; a model is a liability here
   │no
Does an existing open model fail on a held-out slice
with a *publishable* margin?                         ── no → stop; the model is good enough
   │yes
Is the task narrow, high-value, and stable?           ── no → prefer retrieval + user preference
   │yes
└─→ Small ranker / classifier / LoRA on top of an existing model.
    Fine-tuning a foundation model is justified ONLY here.
    Training from scratch is justified ONLY with extraordinary cause (a unique dataset
    nobody else has + a published baseline failure).
```

**Applied to the landscape above:**

| Task                                                | Baseline first                                                                                | Model needed?                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Slovak lyric/phrase transcription                   | Whisper-turbo (MIT, verified)                                                                 | **No** — unless a measured domain failure (Singing/slang/noisy room) shows a gap                                                    |
| English voice control of ZYVO                       | deterministic intent parser (repo already has one)                                            | **Possibly** — LFM2.5-Audio interleaved mode is a candidate _only_ if voice control beats the existing parser on the measured suite |
| Intent → typed plan                                 | existing deterministic parser + symbolic providers + ONNX slot-filler + LFM SFT (all in-repo) | **No new training** — the repo already runs this ladder                                                                             |
| Timbral search by intent                            | CLAP-class zero-shot embeddings + retrieval over the existing library                         | **No**                                                                                                                              |
| "Does the chorus have more tension than the intro?" | structural comparison of the project graph + rendered features                                | **No** — this is arithmetic on structure                                                                                            |
| Live vocal coaching                                 | pitch/timing extraction (DSP) + user-set targets                                              | **No** — a model would add latency and false confidence                                                                             |
| Per-user "taste"                                    | explicit A/B preference capture + retrieval                                                   | **No** — and _user actions are not ground truth_                                                                                    |

**Net conclusion: the number of tasks in this program that justify _any_ training is currently zero,
and the number that justify _a foundation-model fine-tune_ is at most one (English speech-control
under a measured failure).** Every other proposal in this program should be met first with
determinism, retrieval, or an experiment.

---

## 8. Evidence gaps this document leaves open

| #    | Gap                                                                                                                                                                                                                                | Why it matters                                                               | Where it is closed                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| G-1  | ~~English ASR accuracy unpublished~~ → **RESOLVED (second pass): the card publishes VoiceBench 54.92 and ASR WER avg 7.53.** Remaining gap: **no independent re-evaluation** of any figure, and **nothing measured on sung audio** | determines whether it beats Whisper on lyrics at all                         | closed for read speech; Experiment **E-01/E-02** for singing  |
| G-2  | Slovak ASR quality of Whisper-turbo **on sung Slovak** (not read speech)                                                                                                                                                           | the real domain is singing; read-speech CER does not transfer                | Experiment **E-02**                                           |
| G-3  | Long-audio degradation in the **official `liquid-audio` path** on our target runtimes (Windows!)                                                                                                                                   | the community measurement was Linux/CUDA/Mac                                 | Experiment **E-03**                                           |
| G-4  | WebGPU ONNX path in a real browser on Windows + Safari, incl. memory ceiling and first-audio latency                                                                                                                               | decides whether KYX Web can host a speech model at all                       | Experiment **E-04**                                           |
| G-5  | Whether a fine-tuned LFM2.5-Audio can do _function calling_ into a DAW reliably                                                                                                                                                    | the only path to an agentic voice interface                                  | Experiment **E-05**                                           |
| G-6  | **Music-understanding open models: none commercially usable.** Audio Flamingo = NVIDIA Noncommercial; MERT/Music2Latent/MusicGen/YuE2 = CC-BY-NC-4.0; Qwen3-Omni = 35 B server-class                                               | the perception layer cannot be delegated to a frontier audio-LLM in 2026     | `AAW_STATE_OF_THE_ART_2026.md`; deterministic baseline stands |
| G-7  | LFM Open License threshold applies per legal entity — confirm the entity structure KYX/ZYVO will use                                                                                                                               | a licensing mistake is not recoverable later                                 | Legal review, before any distribution                         |
| G-8  | MLX/LEAP/hosted pricing for the audio model                                                                                                                                                                                        | cost of the cloud-assisted tier                                              | Cost model in `AAW_ROADMAP_2026_2029.md`                      |
| G-9  | **🔴 The revenue cliff on the _already-pinned_ intent model** — the fix (an Apache/MIT intent backbone) is cheap today and expensive after $10M                                                                                    | the single most consequential finding in this document                       | `AAW_DECISION_LOG.md` **D-02**; Roadmap Wave 0                |
| G-10 | **Copyleft in the MIR stack** — Essentia AGPL-3.0, aubio GPL-3.0, sonic-annotator GPL-2.0                                                                                                                                          | linking them into a proprietary DAW is a legal decision, not a technical one | `AAW_DECISION_LOG.md` **D-05**                                |
| G-11 | `d1-omni-600M` (2026-10-05) — an audio/vision **decision** model: the most DAW-shaped architecture in the landscape, and 19 days old                                                                                               | if it works, it changes the perception/action split                          | Experiment **E-12**                                           |
| G-12 | ACE-Step 1.5's "50+ languages" is **not enumerated** — is Slovak included?                                                                                                                                                         | a Slovak-capable _generative_ path would be a differentiator                 | Experiment **E-13**                                           |

---

## 9. Bottom line

1. **The candidate is real, public, and materially better than the brief assumed — as a speech
   model.** `LiquidAI/LFM2.5-Audio-1.5B`: 1.47 B params, 32K context, English (+ a separate JP
   checkpoint), LFM Open License v1.0 with a $10M commercial threshold that an independent
   developer sits comfortably under, official fine-tuning support in `liquid-audio` v1.2.0,
   llama.cpp GGUF at ~1.07 GB, ONNX/WebGPU at ~2.14 GB, and **CPU-only ASR measured at RTF 0.077**.
2. **It is not a music model, not a Slovak model, and not a planner.** It cannot perceive groove,
   phrasing, arrangement, or mix balance, and it cannot speak Slovak. Using it for those jobs
   would be a category error, not merely a capability gap.
3. **It is not the accuracy leader — and this correction is load-bearing.** The model card publishes
   VoiceBench **54.92** and ASR WER avg **7.53**; `Qwen2.5-Omni-3B` scores **63.57** on VoiceBench
   and `Whisper-large-V3` edges it at **7.44** WER. What LFM2.5-Audio buys is **shape**: 1.5 B
   parameters, a llama.cpp CPU path, an ONNX/WebGPU path, a first-party fine-tuning recipe, and one
   model for ASR + TTS + voice chat. Choose it for engineering reasons, never for accuracy claims.
4. **Its single most dangerous property is known and documented: the official path degenerates on
   audio longer than ~2 minutes** (WER 2.8 % → 83 % → 296 %), which is exactly the length of a song.
   The community llama.cpp adapter holds 1.3–2.3 % across the same range. **The runtime is the risk,
   not the weights** — which is why E-03 outranks every feature idea in this program.
5. **Slovak stays on Whisper** (MIT for turbo, Apache-2.0 for large-v3; verified `sk` + `cs`
   support). LFM2.5-Audio can be an English-only offload, or a fine-tune candidate if a measured
   failure justifies it.
6. **🔴 The most consequential finding in this document is a licence, not a model.** The LFM Open
   License v1.0 conditions commercial use on the legal entity staying under **$10M annual revenue**
   — and that applies to the **model KYX already ships and pins**
   (`LiquidAI/LFM2.5-1.2B-Instruct`). The remedy is cheap today (decide the intent backbone while
   the decision is cheap) and expensive after the cliff (`AAW_DECISION_LOG.md` D-02).
7. **The commercially-usable generation path exists and it is small.** `ACE-Step 1.5` is **MIT with
   an explicit commercial-use grant**, **< 4 GB VRAM**, **< 10 s** per song on a 3090, and
   LoRA-able from 8 songs. Meanwhile MusicGen, AudioGen, YuE2, MMAudio, MERT and Music2Latent are
   **CC-BY-NC-4.0** and Audio Flamingo is **NVIDIA Noncommercial** — i.e. the famous open music
   models are largely unusable in a commercial DAW. Also note that Essentia is **AGPL-3.0** and
   aubio **GPL-3.0**: any MIR dependency must sit behind an IPC boundary (D-05).
8. **Nothing here justifies training a model.** Every capability this program needs at the
   foundation level is reachable with deterministic DSP/MIR, retrieval, embeddings, and the models
   already pinned in the repo. Training is justified only by a _measured, held-out_ baseline
   failure — and at the time of writing, no such failure has been measured.
