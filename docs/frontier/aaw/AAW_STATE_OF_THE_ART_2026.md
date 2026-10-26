# AAW_STATE_OF_THE_ART_2026

**Status:** evidence-backed landscape of what exists, what is plausible, and what is merely imagined
**Date:** 2026-10-25 · **Research cutoff:** 2026-10-25
**Companions:** `AAW_AUDIO_MODEL_LANDSCAPE.md`, `AAW_COMPETITIVE_CAPABILITY_MAP.md`, `AAW_REFERENCE_ARCHITECTURE.md`

---

## 0. Method and honesty statement

**What this document is built from.**

| Source                             | Type                                     | How it was obtained                                                                                 |
| ---------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| KYX source tree (`D:\pulse-forge`) | **direct code inspection**               | read-only sweep of `src/`, `server/`, `public/models/`, `scripts/data/`, with `path:line` citations |
| Model landscape                    | **primary sources**                      | Hugging Face model cards + API metadata, official vendor docs, licence texts, arXiv                 |
| Library licences                   | **primary sources**                      | GitHub repo metadata, HF card front-matter                                                          |
| ZYVO tree (`D:\VocalForge_DAW`)    | **direct code inspection**               | see §7                                                                                              |
| Competitive map                    | **vendor documentation + release notes** | see `AAW_COMPETITIVE_CAPABILITY_MAP.md`                                                             |

**What was NOT done — stated plainly.** No build was run, no test suite was executed, no dev server
was started, no model was downloaded or executed, **no listening evaluation was performed**, and no
runtime trace of the MCP surface was observed. "SHIPS" in this document means _implemented and
reachable in source_ — it does **not** mean observed working, and it does **not** mean good.
Where a claim comes only from a markdown file, it is marked **(doc claim)**.

**Evidence grades:** **A** primary/official · **B** independent measurement · **C** secondary ·
**U** unverified.

---

## 1. The verified substrate — KYX already owns half of an AAW

This is the single most important correction to the framing of this whole program. KYX is **not**
a DAW that needs AI bolted on. It already owns the substrate that most AAW proposals assume must be
invented.

| Substrate                                                                    | Verdict                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Every mutation is a reversible `Command` over a plain document**           | **SHIPS**                         | `src/commands/types.ts:3-14` (`execute(doc)` / `undo(doc)`); `src/commands/commands.ts:12-30` (barrel over 49 command modules); `src/store/ProjectStore.ts:265-270`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Undo/redo: frame-grouped, coalescing, capped**                             | **SHIPS**                         | `src/store/ProjectStore.ts:28` (in-memory `undoStack`), `:269-270` (cap **256**), `:69` (`HISTORY_LIMIT = 64`), `:318`/`:333` (`beginUndoFrame`/`endUndoFrame`), `:225-237` (same-key coalescing)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **A 39-tool MCP agent surface with typed risk classes**                      | **SHIPS**                         | `src/mcp/tools.ts:1597` (`MCP_TOOLS`, 39 entries, lines 1597–3205); `docs/mcp-manifest.json` (39 tools, identical names); `src/mcp/agentTrust.ts:30` (`ToolRisk = read\|runtime\|mutate\|destructive`)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Risk breakdown**                                                           | **SHIPS**                         | from `docs/mcp-manifest.json`: **read 3 · runtime 8 · mutate 21 · destructive 7**; per-`op` risk is re-derived at call time (`src/mcp/agentTrust.ts:120-187`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **A real dry-run sandbox** (not a description)                               | **SHIPS**                         | `src/mcp/tools.ts:4162-4204` (`dryRunContext`: a throwaway document chain + throwaway undo/redo); `:4093-4124` (`dryRunPolicyRefusal` — batch nesting, runtime-only ops, `kyx_blind_ab record/reset`, `kyx_import_sfz`, `kyx_checkpoint`, `kyx_mix_idea preview` all refuse dry-run)                                                                                                                                                                                                                                                                                                                                                    |
| **Honest read-back + typed errors + local audit log**                        | **SHIPS**                         | `src/mcp/tools.ts:3498-3537` (`McpToolResult`: `text` read-back, `mutated`, `stage`, `risk`, `data`, `dryRun`, `replayed`), `:3561-3572` (closed 10-code error set); `src/mcp/agentTrust.ts:231-259` (`pf:agent-audit-v1`, bounded local log)                                                                                                                                                                                                                                                                                                                                                                                           |
| **Idempotent calls + a user-granted destructive kill switch**                | **SHIPS**                         | `src/mcp/tools.ts:4227-4240` (`requestId` replay); `src/mcp/flags.ts:9-17` (`pf:mcp-allow-destructive`, **default OFF**), checks at `src/mcp/tools.ts:5289, 7684, 8045, 8277, 8504, 8690, 8722, 9366`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Live/offline render parity — one engine class**                            | **SHIPS**                         | `src/rendering/renderer.ts:516` (`new OfflineAudioContext`), `:525` (`new AudioEngine()` — _the same class_), `:528` (`engine.useContext(ctx)`), `:523` (`ensureWorkletsForDoc`), `:534` (`unfreezeDoc`), `:559` (`bypassMasterChainForOfflineRender`)                                                                                                                                                                                                                                                                                                                                                                                  |
| **Preview without touching the live graph**                                  | **SHIPS**                         | `src/mcp/mix-preview.ts:33-48` (before/after docs held in a session lane); `src/rendering/stems.ts:9-50` (`buildStemProject` → a _derived_ document); `src/mcp/mix-diagnosis.ts:30-33` ("Pure read — never mutates")                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **A hard real-time boundary**                                                | **SHIPS (by exhaustive absence)** | **51** `extends AudioWorkletProcessor` classes across **50** files in `src/audio-worklets/`; grep for `fetch(`/`XMLHttpRequest`/`WebSocket` over `src/audio-worklets/**` **and** `src/audio-engine/**` → **no matches**; `src/audio-worklets/rt-monitor-node.ts:1-24` (xrun + heartbeat probe)                                                                                                                                                                                                                                                                                                                                          |
| **Typed, agent-visible effect metadata**                                     | **SHIPS**                         | `src/effects/types.ts:3-48` (`ParamDef`: id/label/min/max/default/unit/description/kind/step/taper/options/deprecated/aliasOf), `:269-275` (`EffectDefinition`); `src/effects/registry.ts:3936-3993` (**57** effects) exposed via `kyx_catalog subject:effect` (`src/effects/types.ts:11-16`)                                                                                                                                                                                                                                                                                                                                           |
| **Parameter ranges enforced twice** (not just in the UI)                     | **SHIPS**                         | `src/effects/definitions.ts:331-343` (`clampEffectParam`); `src/commands/effectParams.ts:101-105`; `src/audio-engine/AudioEngine.ts:19,73-82,398`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Versioned project schema + real migrations + future-version rejection**    | **SHIPS**                         | `src/project-model/schema.ts:68` (`SCHEMA_VERSION = 38`), `:3552-3554` (`migrateProject`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Musical time as integers**                                                 | **SHIPS**                         | `src/project-model/types.ts:1` (`PPQ = 480`); `src/rendering/renderer.ts:504-505`; `src/rendering/tempoMap.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **A traversable project graph**                                              | **SHIPS**                         | `src/project-model/types.ts:730` (Scene), `:795` (Marker), `:816` (ArrangementClip), `:872` (ArrangementTransition), `:978` (ClipGroup), `:999` (Arrangement), `:1024` (AutomationLane); `src/project-model/targets.ts:202-254` (legal automation targets)                                                                                                                                                                                                                                                                                                                                                                              |
| **A deterministic-first intent pipeline**                                    | **SHIPS**                         | `src/intent/route.ts:382-410` (`RoutedIntent`), `src/intent/pipeline.ts:75-133`, `src/intent/providers/local.ts:1-18` (deterministic generator + feature ranking + symbolic prior + personal bias), `src/intent/candidate-bank.ts`                                                                                                                                                                                                                                                                                                                                                                                                      |
| **A typed, dry-run-backed intent plan**                                      | **SHIPS**                         | `src/intent/semantics/intent-plan.ts:66-78` — `{ routeKind, summary, steps, warnings, mutates, executable, commandLabel?, after: ProjectDocument }`; the resulting document is explicitly **not** passed to the store by that module                                                                                                                                                                                                                                                                                                                                                                                                    |
| **A measured gate that keeps the model second**                              | **SHIPS**                         | `src/intent/model-route-gate.ts:144-165` — rule 1 deterministic wins; rule 2 a description never mutates; rule 3 read-only passes, generation does not; rule 4 a model mutation must be `executable && mutates`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **A local ONNX slot-filler in a Web Worker**                                 | **SHIPS**                         | `public/models/intent-model-v1.manifest.json` (`model.bytes = 2,601,522`, hash-pinned); `public/models/intent-model-report.json` (`architecture = "multi-head slot-filling MLP (BoW trunk + closed-class heads)"`, `headCount = 59`, `vocabSize = 6144`, `trainRows = 2244`, `valRows = 374`, `goldenRows = 77`, `valHeadAccuracyMean = 0.9949`, `gatePassed = true`); `src/intent/model-worker.ts:184-198` (onnxruntime-web), `:175-178` (refuses a grammar-drifted artifact), `:239-241` (defensive `event.data` shape check)                                                                                                         |
| **A local LLM path on loopback**                                             | **SHIPS**                         | `src/intent/model-ollama.ts:61-64` (`http://127.0.0.1:11434`, `kyx-intent-v33-q8`), `:37-41` (measured 2026-10-09 on 298 val rows: **220/240 = 91.7 %** attempted-exact, **3** wrong-kind, **58/298** abstains, VRAM 1.71 GB); reports in `scripts/data/intent-sft/lfm-eval-v33-q8-2026-10-09.json`                                                                                                                                                                                                                                                                                                                                     |
| **Deterministic DSP perception: tempo, key, transients, sections, loudness** | **SHIPS**                         | `src/audio-engine/transients.ts:22` (energy-flux + adaptive threshold); `src/audio-engine/bpm-detect.ts:1-17` (impulse-train autocorrelation, 70–180 fold, confidence gate 1.15 at `:32`); `src/ai/audio-tempo-key.ts:4-12` (multi-band flux + harmonically-enhanced autocorrelation), `:132` (`estimateKey` — chroma + Krumhansl, with **measured evidence floors**: concentration ≥ 2, correlation ≥ 0.6); `src/reference/structure.ts:73,167` (energy curve → sections); `src/audio-engine/kweighting.ts:3-14,24,377` (ITU-R BS.1770-4 K-weighting, shared offline **and** in the worklet `src/audio-worklets/kwmeter-processor.js`) |
| **Measure-before-claim tooling**                                             | **SHIPS**                         | `src/mcp/mix-diagnosis.ts:13-33` (offline render → per-strip LUFS/peak/crest); `src/mcp/blind-ab.ts:33-52` (level-matched blind A/B + binomial verdict); `src/mcp/master-ab.ts:30-36` (mastering parameter snapshots)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **A local, opt-in preference-learning loop**                                 | **SHIPS**                         | `src/intent/preference-ledger.ts:61` (`pf:producer-dna-preferences`), `:188-204` (bounded 512 kB), `:594-599` (`isPreferenceLearningEnabled` — local, pausable, **"Feedback is never inferred from USE"**); `src/intent/preference-evaluation.ts:16-60` (chronological holdout, personal vs global accuracy + lift); `src/persistence/PersonalModelRepository.ts:27-62` (★-trained personal ONNX weights keyed by base-model hash)                                                                                                                                                                                                      |
| **A vendored, gated source-separation model**                                | **SHIPS (gated)**                 | `public/models/stem/manifest.json` (`stemModelVersion = stem-htdemucs.fp32graph.v1`, `gatePassed = true`, stems vocals/drums/bass/other, "WebGPU REQUIRED"); artifact on disk `public/models/stem/htdemucs_fp32graph.onnx` (**312,105,581 B**); gate `src/analysis/stem-model/gate.ts:60` (flag default **OFF**), client `src/analysis/stem-model/client.ts:130`                                                                                                                                                                                                                                                                        |
| **Snapshot isolation + agent checkpoints**                                   | **SHIPS**                         | `src/persistence/SnapshotRepository.ts:14-28` (full-doc snapshots, **20** per project, auto-snapshot ≥ **12 h** apart); `src/persistence/McpCheckpointRepository.ts` (agent checkpoints in their own IDB store)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **A token-gated MCP transport, opt-in by default**                           | **SHIPS**                         | `server/mcp-core.mjs:7-10` (`POST /mcp` Bearer-token JSON-RPC; `WS /mcp-relay?token=`), `:12-17` (**no `MCP_TOKEN` ⇒ refuse everything**), `:45-53` ("the MCP layer is a transport, never a bypass")                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Debounced autosave + unload flush**                                        | **SHIPS**                         | `src/persistence/autosave-debouncer.ts:26-46` (800 ms debounce + bounded-defer ceiling); `src/persistence/save-lifecycle.ts:27-39` (`pagehide`/`beforeunload`/`visibilitychange`)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 1.1 The honest counter-reading

Read the table above and the obvious conclusion is: _the hard parts of an AAW are already solved in
KYX, and the missing part is perception — as the **agent** sees it._ That is correct, and it is the
most important architectural finding in this program. It also means the frontier program should
**not** be a rewrite. It should be **three things**:

1. **A perception layer that can talk about sound** — the product has one (a classical DSP layer
   plus an AudioSet tagger, §2 G-A); what is absent is the agent's access to it.
2. **A permission lattice that matches the risk model** (currently: only the 7 destructive tools are
   gated).
3. **A planner that walks the project graph** (currently: routes are per-clause).

Everything else — undo, transactions, preview, verification, receipts, real-time boundaries —
exists and must simply be _used correctly by the new layers_.

---

## 2. The four structural gaps (re-checked 2026-10-26 — one absence claim was false)

### G-A — There is no audio _understanding_. (Corrected: tagging ships; the embedding space does not.)

> **CORRECTION (2026-10-26) — this gap was published as a _verified absence_, and that absence claim
> was false.** The original text said: _"no `embedAudio` / `audioEmbedding` / music-tagging /
> audio-LLM path exists in `src/`. The only transformer in the codebase is a text sentence
> encoder."_ **KYX does ship an audio transformer.** The audit searched for the wrong tokens
> (`embedAudio`, `audioEmbedding`) instead of `audio-classification` / `ast-finetuned-audioset`.

**What actually ships** — an **Audio Spectrogram Transformer fine-tuned on AudioSet (527 classes)**
running through transformers.js in a worker, offline-first (`env.allowRemoteModels = false`):

| Layer              | Evidence                                                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model + worker     | `src/ai/audio/audio-worker.ts:19` (`Xenova/ast-finetuned-audioset-10-10-0.4593`), `:21` (top-K 8), `:30` (no CDN fallback), `:32` (dtype q8)                                                                                      |
| Client + flag      | `src/ai/audio/audio-client.ts:13-20` (`pf:audio-tag`, default **on**), `:106` (`audioTagAvailable` — probes the manifest, latches only a definitive 404), `:124` (`classifyAudio` — degrades to `null`, never throws into the UI) |
| Library            | `src/sample-library/audio-index.ts:3,9-16,116,224` — every factory **and** user sample is classified; text queries ("tmavý 808") rank by AudioSet labels + the asset name                                                         |
| Reference → intent | `src/intent/audio-reference.ts:104-126` — a reference track becomes labels → genre/style/tempo/key → a **reference-informed conditioning vector**                                                                                 |
| UI surface         | `src/ui/intent/AudioRefChip.tsx` (the 🎧 chip), `src/ui/IntentPanel.tsx:102`                                                                                                                                                      |
| Artifact           | **fetched, never committed** (`.gitignore`: `public/models/audio/`; `scripts/fetch-audio-model.mjs:16`); present in this tree at **88,679 KB**, SHA-256 digests in `public/models/audio/manifest.json`                            |
| Tests              | `tests/sample-audio-index.test.ts`, `tests/audio-reference.test.ts`, `tests/ai-worker-client-error-listener.test.ts`                                                                                                              |

Also present: **Demucs stem separation** (`public/models/stem/*.onnx`, 4 variants, never committed;
manifest committed; gate default **OFF** — S-65).

**What is genuinely still absent — and this is the gap that actually binds:**

1. **No audio embedding space.** The audio→text bridge is _label-mediated_: AST labels plus DSP
   features are rendered into a text string and embedded by the **text** encoder
   (MiniLM → PCA → 16 dims, `src/ai/symbolic/prior-features-v3.ts:32`). Nothing embeds the audio
   itself — so there is no CLAP-style audio↔text alignment and no timbral similarity retrieval.
2. **No audio-LLM.** Nothing reasons over audio in language.
3. **No measured accuracy for the tagger.** S-70's `RECOMMEND-ON` A/B is about the **text**
   embedding v3, **not** the tagger. There is no evaluation of AST accuracy in the repo → **E-14**.

Alongside it exists a **well-built classical DSP perception layer**: energy-flux transients,
impulse-train autocorrelation tempo, Goertzel chroma + Krumhansl key with honest evidence floors,
RMS-energy section segmentation, BS.1770-4 loudness, STFT/spectral flux.

**Why this is still the binding constraint — but for a sharper reason.** KYX _does_ perceive now,
and the perception is **not exposed to the agent**: `src/mcp/` carries no reference to the tagger at
all. The MCP surface still answers in numbers and bytes. `kyx_render_summary` and
`kyx_diagnose_mix` return LUFS, peak and crest per strip; `kyx_audio_preview` returns **base64 WAV
bytes** (`src/mcp/tools.ts:6568-6580`; `src/mcp/audio-preview.ts:7-22` — ≤ 4 bars, 22.05 kHz,
≤ 3 MB). The agent can read the document and receive rendered audio — but the audio arrives as
**bytes and numbers, never as a semantic description**. The product hears; the agent does not.
That is the real gap, and it is a **surface** gap, not a **model** gap — which is exactly why it is
cheap to close.

**The frontier implication.** The perception layer is where the whole category question lives —
and the landscape says it must be **deterministic DSP/MIR plus embeddings**, not a frontier
audio-LLM (see `AAW_AUDIO_MODEL_LANDSCAPE.md` §3.1: Audio Flamingo is NVIDIA-noncommercial, MERT /
Music2Latent / MusicGen / YuE2 are CC-BY-NC-4.0, and Qwen3-Omni is 35 B / server-class).

### G-B — Twenty-one mutating tools execute without consent.

Only the **7 destructive** tools require the user's `pf:mcp-allow-destructive` flag
(`src/mcp/flags.ts:9-17`). The **21 `mutate`** tools run unconsented
(`src/mcp/agentTrust.ts:190-193`).

The mitigations are real (checkpoint, audit log, undo frame, read-back), but they are
**recovery** mechanisms, not **consent** mechanisms. A model that misinterprets "make it tenser" and
calls a mutating tool can change the user's project, and the user's only recourse is to notice and
undo.

**This is the single largest trust gap in the product**, and it is exactly the gap the permission
lattice in `AAW_AI_CONTROL_CONTRACTS.md` §4 closes. The current risk taxonomy is _already_ the
right taxonomy (`read|runtime|mutate|destructive`) — it simply is not wired to a consent decision.

### G-C — Mutations are grouped, not transactional.

`kyx_batch` opens one undo frame and **stops on the first failure**
(`src/mcp/tools.ts:9466-9472`, `:5872`). There is no rollback of already-applied steps. The repo's
own audit says so explicitly: _"Do not label MCP batch 'atomic'"_
(`docs/audits/2026-10-25-next-generation-capability-review/NEXT_GENERATION_CAPABILITY_REVIEW_REPORT.md:358`).

For an agent that proposes a 4-step plan, "step 1 and 2 applied, step 3 failed, step 4 skipped" is
a materially worse outcome than "nothing happened".

### G-D — Undo does not survive a reload; there is no rate limit.

- **Undo is process memory only:** `src/store/ProjectStore.ts:28` (`private undoStack: Command[] = []`).
  A reload loses history back to the last snapshot (20 per project, 12 h cadence).
- **The MCP relay has no request-rate limiting.** A grep for `rateLimit|rate_limit|429|throttle`
  over `server/mcp-core.mjs` and `src/mcp/` returns only unrelated hits. Idempotency
  (`requestId` replay) and per-feature caps exist, but there is no global limiter.

### G-E — Effect metadata lacks what an agent needs to reason safely

`ParamDef` has ranges, units, tapers and descriptions (`src/effects/types.ts:3-48`) — genuinely good
— but **there is no per-parameter version, no declared side effect, no latency or real-time-safety
flag, and no "this knob moves the whole mix" marker** (`src/effects/types.ts:269-275`;
`src/effects/definitions.ts:3042`). An agent cannot currently answer "is this parameter safe to
change while playing?" or "does this plugin write to the file system?".

**This is cheap to fix and it is the prerequisite for everything in Wave 0** of the roadmap.

### G-F — There is no planner that walks the project graph

Intent routes are **per-clause** (`src/intent/route.ts:382-410`). `kyx_song` and `kyx_mix` are
hand-built mega-commands, not a general planner that traverses tracks → scenes → clips →
automation → markers and proposes a coherent, scoped arrangement
(`src/project-model/types.ts:730-1024` is the traversal surface; nothing walks it).

---

## 3. The model frontier, in one page (detail in `AAW_AUDIO_MODEL_LANDSCAPE.md`)

| Question                            | Verified answer                                                                                                                                                                                                                            | Grade |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| Does "LFM 2.5 Audio 1.5B" exist?    | **Yes** — `LiquidAI/LFM2.5-Audio-1.5B`, HF repo created 2025-12-18, `audio-to-audio`, 1,470,308,496 params, 32,768 ctx, **English only**, LFM Open License v1.0                                                                            | **A** |
| Is it an accuracy leader?           | **No** — VoiceBench **54.92** vs Qwen2.5-Omni-3B **63.57**; ASR WER **7.53** vs Whisper-large-V3 **7.44**. Its advantage is _shape_: 1.5 B, llama.cpp CPU path, ONNX/WebGPU path, first-party fine-tune recipe, one model for ASR+TTS+chat | **A** |
| Is it a music model?                | **No.** Speech benchmarks only; no music task in the card                                                                                                                                                                                  | **A** |
| Does it speak Slovak?               | **No.** English (+ a separate JP checkpoint). Slovak/Czech audio models are essentially absent                                                                                                                                             | **A** |
| Does it survive long audio?         | **The official path does not**: community measurement reports WER 2.8 % → 83 % → **296 %** at 30/120/180 s, while the llama.cpp adapter holds 1.3–2.3 %. A song is 2–5 minutes                                                             | **B** |
| What is the CPU cost?               | **RTF 0.077** (16-thread x86-64, Q4_0) — faster than real time, no GPU                                                                                                                                                                     | **B** |
| What is the licence risk?           | **🔴 Commercial use is unlicensed above $10M annual revenue of the using legal entity** — and this applies to the **model KYX already ships**                                                                                              | **A** |
| Can music generation be commercial? | **Yes — ACE-Step 1.5** (MIT + explicit commercial-use grant, 2.39 B, < 4 GB VRAM, < 10 s/song on a 3090, LoRA from 8 songs). MusicGen/AudioGen/YuE2/MMAudio/MERT/Music2Latent are **CC-BY-NC-4.0**; Audio Flamingo is NVIDIA-noncommercial | **A** |
| Is MIR usable commercially?         | Yes — but **Essentia is AGPL-3.0 and aubio GPL-3.0**. They need an IPC boundary, not a link                                                                                                                                                | **A** |
| Is there an audio _decision_ model? | `LiquidAI/d1-omni-600M` (2026-10-05): audio+vision in, **no output tokens**, GGUF/MLX, 16 K ctx — structurally the closest thing to a DAW action router, and 19 days old                                                                   | **A** |

---

## 4. The capability horizon — 2026 plausible vs 2027–29 bet vs unjustified

The brief asks for this split explicitly. It is the most valuable table in the program, because it
prevents the program from spending its credibility on the third column.

### Tier 1 — Plausible and buildable in 2026 (evidence-backed)

| Capability                                                                 | Why it is in this tier                                                                                                                                      | Which product |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Typed, scoped, reversible agent edits                                      | The substrate **already ships** (§1) — this is a _wiring_ problem                                                                                           | both          |
| Consent-gated mutating tools                                               | The risk taxonomy **already exists** (`read\|runtime\|mutate\|destructive`)                                                                                 | both          |
| Offline preview + verified commit                                          | Live/offline parity **already ships**; the missing piece is the scope diff                                                                                  | both          |
| Deterministic perception over the existing DSP set                         | Transients/tempo/key/sections/loudness **already ship**; needs caching and a typed artifact format                                                          | both          |
| Timbral retrieval over the library                                         | Embeddings are the one **commercially licensed** usable class (CLAP Apache-2.0); the repo already has an embedding pipeline and a `RECOMMEND-ON` A/B report | KYX           |
| Objective vocal coaching (pitch/timing vs a target)                        | Pure DSP + alignment; no model needed                                                                                                                       | ZYVO          |
| Off-device ASR for Slovak lyrics                                           | Whisper large-v3 (Apache-2.0) / turbo (MIT), both verified `sk`+`cs`                                                                                        | ZYVO          |
| Commercially-licensed local generation as a _constrained_ variation source | ACE-Step 1.5, MIT, < 4 GB VRAM                                                                                                                              | KYX           |

### Tier 2 — Research bets for 2027–2029 (plausible, unproven)

| Capability                                                          | The bet                                                                 | The blocker                                                          | What would prove it |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------- |
| Learned perception of musical affect ("tension")                    | A small regressor over audio features can predict a human tension label | Nobody can label "tension" reliably; no feature set found that works | E-07                |
| A learned project representation replacing the typed graph          | An encoder beats graph traversal for edit-target selection              | The graph is already exact; the learned version is a proxy           | E-11                |
| Audio-aware routing (the model _hears_ which action family applies) | `d1-omni-600M`-class models route better than text routers              | 19 days old, English audio, LFM licence cap                          | E-12                |
| On-device speech control of the DAW                                 | A speech model emits valid, correctly-scoped tool calls                 | Voice→arg quality is much weaker than voice→format                   | E-05                |
| Voice adaptation for a specific performer                           | Fine-tuning preserves identity while improving intelligibility          | Identity loss is the killer metric, and it is binary                 | T-5                 |
| Learned preference modelling                                        | Explicit signals predict choices better than retrieval                  | Signals are sparse; "keeping the default" dominates                  | T-2                 |

### Tier 3 — Speculative or technically unjustified (do not build; do not market)

| Concept                                              | Why it is unjustified **today**                                                                                                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A frontier audio-LLM as the perception layer         | The strongest ones are **non-commercial** (NVIDIA OneWay, CC-BY-NC-4.0) or **server-class** (35 B). There is no open, commercially usable, music-understanding model at any size that fits a 6–16 GB tier |
| A "mix quality score"                                | Nobody can label it reliably. A proxy becomes a lie — and the repo has no such label to build on                                                                                                          |
| Automatic live scene changes on a musical prediction | The deterministic arrangement already knows the structure; the model's marginal value is small and its downside on stage is large                                                                         |
| Real-time inference in the audio path                | Violates the invariant that is already verified to hold (`src/audio-worklets/**` has zero network calls)                                                                                                  |
| Learned taste from ordinary edits                    | The repo already forbids it in code: `src/intent/preference-ledger.ts:594-599` — _"Feedback is never inferred from USE"_                                                                                  |
| An agent that writes project state directly          | The command layer already makes this unnecessary and unsafe (no atomicity, no scope check)                                                                                                                |
| A learned "world model" as a second source of truth  | The project document _is_ the structured musical world (schema v38, 480 PPQ)                                                                                                                              |
| Human-graded A/B as a training set without opt-in    | The repo's own contract forbids it; and A/B choices are not ground truth for audio quality                                                                                                                |

---

## 5. Multi-agent and decision architectures — an honest assessment

The brief asks specifically whether planner/executor/verifier roles are worth it, and how that
compares to a simpler single-agent baseline.

| Architecture                                     | Verdict                                                      | Reasoning                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single agent + tools (today's shape)**         | **Keep as the baseline**                                     | KYX already runs it: deterministic routing → optional model → typed plan → command gateway → read-back. It is fast, auditable and already measured                                                                                                                                                               |
| **Planner → executor → verifier (3 roles)**      | **Reject as an architecture; adopt the _verification_ half** | The executor is already the command gateway, and the verifier is already `kyx_render_summary` + `kyx_diagnose_mix` + the read-back. What is missing is a **scope-diff verifier**, not a third agent role. Adding a planner agent on top of a deterministic router is coordination overhead with no measured gain |
| **Specialised musical agents (per-role agents)** | **Reject**                                                   | Each role agent would need the same project graph, the same permissions and the same undo semantics. That is three implementations of the same contract, and a single-team of one cannot maintain it                                                                                                             |
| **Critic / reranker model**                      | **Possible, later, narrow**                                  | A reranker over _candidate plans_ is cheap and measurable (Suite A). A critic over _the whole session_ is not                                                                                                                                                                                                    |
| **Model routing (small local vs large cloud)**   | **Adopt the pattern; not the cloud yet**                     | Routing between a local 1.2 B and a cloud frontier model is architecturally correct (versioned provider interface, `AAW_AUDIO_MODEL_LANDSCAPE.md` §6) but the cloud tier has no measured justification yet                                                                                                       |
| **Deterministic policy engine for permissions**  | **Adopt — this is the key one**                              | The permission lattice _is_ a deterministic policy engine (`AAW_AI_CONTROL_CONTRACTS.md` §4). It is not an agent, it is a rule table, and it must not be model-driven                                                                                                                                            |

**Coordination overhead, stated plainly.** Every extra agent role multiplies the failure surface:
each role can mis-read the same state, each handoff is a place where intent is lost, and each role
needs its own prompt, its own evaluation, and its own failure taxonomy. The measured facts from
this repo make the case cleanly:

- The deterministic path resolves "the vast majority of real asks" _before_ any model runs
  (`docs/LOCAL-INTENT-MODEL.md:127-129` — the "pre-filter (biggest win)" — **(doc claim)**;
  `src/intent/model-route-gate.ts:144-165` (verified: deterministic wins first)).
- The model's measured contribution is **220/240 = 91.7 % attempted-exact on the _routed_ subset,
  with 58/298 abstains** (`src/intent/model-ollama.ts:37-41`).
- The repo's own negative result — a creative-task LoRA that **passed 25/32 schema checks but
  produced 0 of 24 expected creative proposals** (`scripts/data/creative-task-sft/README.md`) —
  is a measured warning that _adding an agent role does not add capability_.

**Conclusion:** the AAW's intelligence should come from **contract quality, perception and
verification**, not from more agents. The correct architecture has **one** decision point (the
typed planner) and **two** hard gates (the permission lattice and the verifier).

---

## 6. New research tracks this program adds (justified by evidence, not by taste)

The brief allows new tracks only when justified. Five qualify:

| #       | Track                                    | Justification                                                                                                                                                                                                                                                                                                                                                                                                              | Why it is not one of A–H                                                                                                                                           |
| ------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **N-1** | **Licence & supply-chain survivability** | The pinned model carries a **revenue-triggered** licence cliff; the strongest open audio models are **non-commercial**; Essentia/aubio are **copyleft**; `Step-Audio-EditX` has **no licence tag**; several cards are gated (401)                                                                                                                                                                                          | Licensing is not a capability track, but on the evidence it is **more binding than capability** for a commercial DAW. It belongs in the program, not in a footnote |
| **N-2** | **Runtime-path survivability**           | The audio model's official path degenerates on song-length audio (WER 296 %) while a community adapter holds 1.3–2.3 %                                                                                                                                                                                                                                                                                                     | The risk is in the _runtime_, not the weights. A "which runtime do we support" track with its own gate is new and necessary                                        |
| **N-3** | **Provenance-grade measurement**         | The repo's own artifacts show the hazard: a code comment says the intent model is "6.69 MiB" while the manifest and the file say **2,601,522 B ≈ 2.48 MiB** (`src/intent/model-loader.ts:29-30` vs `public/models/intent-model-v1.manifest.json`); `docs/STEM-SEPARATION-PLAN.md` is a **doc claim** where the manifest is the fact; `docs/LOCAL-INTENT-MODEL.md:113-114` names **LFM2** while the roadmap pins **LFM2.5** | In an AAW whose claims rest on measurements, the _provenance_ of every number is a first-class concern — and this repo already shows where it leaks                |
| **N-4** | **Attention economics**                  | Every proposal consumes the user's attention; the contract's own rules ("make rejection cheap", "ask one concise question") are attention budgets, not UI preferences                                                                                                                                                                                                                                                      | Not in A–H, and it is the difference between a feature that helps and a feature that annoys                                                                        |
| **N-5** | **Cross-product state reconciliation**   | `.kyxzyvo` transfer carries tempo, structure, markers, master and stems — but **not MIDI/patterns/notes**, so a KYX beat arrives in ZYVO as a **flattened render**. A shared AI control plane needs a shared _musical_ substrate                                                                                                                                                                                           | Not a capability track; it is the precondition for any cross-product AAW feature                                                                                   |

---

## 7. ZYVO — the vocal product's verified state

> Filled from the ZYVO repository audit (`D:\VocalForge_DAW`, commit `a6166f25` + dirty tree).
> Same honesty rules as §1: _SHIPS_ means implemented and reachable in source. **No build was run,
> no test was executed, no listening evaluation was performed, and the live-mode reachability
> question in H4 was not settled at runtime.**

### 7.1 What ZYVO owns — and it is a lot

| Substrate                                                                                                                                                             | Verdict                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **283 typed commands** in a Command Core with a registry                                                                                                              | **SHIPS**                         | `packages/command-core/src/index.ts:1011-1290` (274 `registry.register`) + `packages/command-core/src/commands/createAgentProposal.ts:388-408` (9) = **283**; pinned array in `packages/command-core/tests/registryAudit.test.ts:16-378`                                                                                                                                                                                                                                                                                                                                                         |
| **Snapshot undo, FIFO, depth 200**                                                                                                                                    | **SHIPS**                         | `packages/command-core/src/undo.ts:2958` (`maxSize ?? 200`), `:2757` (`UndoEntry`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Pre/post validation + an audit log**                                                                                                                                | **SHIPS**                         | `packages/command-core/src/registry.ts` (validation), `packages/agent-runtime/src/agentAuditLogger.ts:21-148` (8 log kinds: query / MCP-tool / intent / command / rejection / clarification / rate-limited / proactive)                                                                                                                                                                                                                                                                                                                                                                          |
| **61 MCP tools; 43 advertise `readOnlyHint`, 18 do not**                                                                                                              | **SHIPS**                         | `apps/vocalforge-daw/electron/generalMcpServer.ts:106` (catalog), `:115-136` (`GENERAL_MCP_NON_READONLY_TOOLS`), `:192-215` (annotation derivation); `generalMcpCatalog.generated.ts:19-82` (61 names)                                                                                                                                                                                                                                                                                                                                                                                           |
| **🔒 External MCP is **draft-only** — acceptance is a UI click**                                                                                                      | **SHIPS (mandatory)**             | `apps/vocalforge-daw/src/agentVoiceManager.ts:5671-5679` — autonomy is **not** forwarded across the stdio boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **A live-show MCP attach core: loopback-only, bearer token, constant-time compare, rate-limited, read-only + proposal _delivery_ into the performer's approval card** | **SHIPS**                         | `apps/vocalforge-daw/electron/liveShowMcpAttachCore.ts:11-19` (posture), `:242-269` (validate → deliver → 202/409), `:284-317` (shape + evidence citation)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **A fail-closed show preflight**                                                                                                                                      | **SHIPS**                         | `packages/project-format/src/liveShowAssessment.ts:34-40` (`FATAL_NATIVE_PLAN_BLOCKERS`: `PLAN_NOT_PLAYABLE`, `NO_AUDIBLE_SOURCES`, `INVALID_DURATION`, `INVALID_SAMPLE_RATE`, `MISSING_MEDIA`); re-validated per setlist entry in `liveShowMcpAttachCore.ts:248-267`                                                                                                                                                                                                                                                                                                                            |
| **A live/rehearsal/gig state machine with health supervision**                                                                                                        | **SHIPS**                         | `apps/vocalforge-daw/src/liveShowWorkflow.ts:3,44-45` (`idle\|rehearsal\|gig`); `packages/vocal-model/src/liveShowSupervisor.ts:78-81,136-138,245-262` (audio / recording / controller health)                                                                                                                                                                                                                                                                                                                                                                                                   |
| **A clean real-time boundary**                                                                                                                                        | **SHIPS**                         | `packages/audio-engine/src/dspChainWorklet.ts:412-444` (allocation-free `process`, reused scratch `:600-603`), `:535-539,570-572,589-591` (every throw caught — _"A throwing parameter setter must never break the audio path"_), `:218-222` (preallocated `processBlockOptions`), `:441-442` (automation on the audio clock); `packages/native-audio-engine/src/vst3_host.h:177-182` (_"Called from the audio render thread"_); `packages/native-audio-engine/src/parakeet_runtime.cc:216,1339-1347` — **Parakeet runs on its own thread with its own `IAudioClient`, not in the DAW callback** |
| **The AI→audio crossing is rate-limited and failure-isolated** (a _good_ finding)                                                                                     | **SHIPS**                         | `packages/audio-engine/src/dspChainWorklet.ts:549-593` — the "DIRECTOR" capture bridge posts out of the realtime realm at ≈10 Hz with transferable `ArrayBuffer`s; every failure swallowed; `AGENT_CAPTURE_INTERVAL_SEC` is the envelope                                                                                                                                                                                                                                                                                                                                                         |
| **Objective vocal analysis: pitch/intonation, timing confidence, loudness, clipping, spectral balance**                                                               | **SHIPS (DSP heuristics)**        | `packages/vocal-align-map/src/pitchContour.ts:51-90` (autocorrelation + cepstrum fallback, 40 ms frame / 10 ms hop, 65–800 Hz); `packages/analysis-pipeline/src/takeScoring.ts:83-157`; `packages/analysis-pipeline/src/vocalPcmAnalysis.ts:337-339` (_"never be called by an audio callback"_)                                                                                                                                                                                                                                                                                                  |
| **62 genre reference blueprints** (heuristic parameter targets, **not** learned)                                                                                      | **SHIPS (as data)**               | `packages/analysis-pipeline/src/referenceBlueprintData.ts` + `packages/analysis-pipeline/data/reference-blueprints/*.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **A mic capture-loss watchdog (1 s) that finalizes a dead capture instead of leaving the transport stuck**                                                            | **SHIPS**                         | `apps/vocalforge-daw/src/recordingManager.ts:80-81,494-506`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **A `.kyxzyvo` transfer on both sides**                                                                                                                               | **SHIPS**                         | KYX: `src/export/zyvo-transfer.ts:121,238-296` (manifest), wired at `src/ui/ExportPanel.tsx:1024`. ZYVO: `packages/project-format/src/kyxTransfer.ts:140-253` (unpack), `:358-393` (tempo / tempoMap / sections / markers), `:420-483` (stems), `:486-493` (MIDI)                                                                                                                                                                                                                                                                                                                                |
| **Real ONNX models in the tree**                                                                                                                                      | **SHIPS but tiny and procedural** | `plugins/rosa/models/rosa/click-head-v1.onnx` (**658 B**), `erb-mask-v2.onnx` (**17,499 B**) — real MatMul→Add→Tanh→Sigmoid MLPs, but trained only on procedural in-repo fixtures (`plugins/rosa/models/README.md`) and **not wired into the shipped realtime path**                                                                                                                                                                                                                                                                                                                             |

### 7.2 The gaps — and several are more severe than KYX's

1. **H4 — the in-app agent can change live channel state with no live-show guard.**
   `packages/agent-runtime/src/audioTools/toolExecution.ts:1141-1179`: in autonomy mode `"command"`,
   a proposal whose children are all in `SAFE_AUTO_APPLY_COMMANDS`
   (`packages/agent-runtime/src/audioTools/authorization.ts:85-106` → `SetChannelGain`, `SetChannelPan`, `SetClipGain`, `SetClipFade`,
   `SetSendLevel`, `SetTempoMap`, `SetAutomationTrackEnabled`) is **accepted immediately**, budget-capped
   (default 10/run, `:1099,1106-1108`), through the same `AcceptProposal` dispatch the UI button uses.
   A grep of `apps/vocalforge-daw/src` for `liveShowActive|activeRunMode` returns **only** `liveShow*`
   files — **no agent-path check for rehearsal/gig mode**. _Caveat, stated honestly:_ the audit did
   **not** prove that the Live window's modality makes this unreachable; that is a **runtime check
   that has not been done**.
   _Update 2026-10-26 (measured, then wired):_ the branch was measured **unreachable in the app** —
   the `autoApplyProposal` dep never reached the host the app actually uses — so the hazard was
   **latent, not live**. It was then **wired on purpose** (T1), with a show lock already in front of
   it; the lock is now a **constructor rule** and the auto-apply does fire. See
   `AAW_DECISION_LOG.md` D-15 and `AAW_SECURITY_AND_REALTIME_SAFETY.md` H4.
2. **H5 — a contract-truth defect — FIXED after the read.** _As read on 2026-10-25:_
   `packages/command-core/src/registry.ts` still asserted that
   _"the transport MAY apply in command mode"_. The enforced behaviour was the **opposite**:
   `agentVoiceManager.ts:5671-5679` deliberately does not forward autonomy, and the MCP server header
   states the transport is draft-only. `AI_CONTROL_COMPLETENESS_AUDIT_REPORT.md:69` claims F-07 is
   _"Fixed"_ — the server header, `docs/MASTERING_MCP.md` and the manifest were updated; **this
   comment was not**. A stale comment that contradicts the enforced contract is a live hazard: it
   tells the next engineer that a dangerous path is sanctioned.
   _Update, measured 2026-10-25 22:07 (commit `ab0076c2`):_ the comment was **corrected**, and the
   policy now lives in one place — `packages/command-core/src/authorization.ts:112-115`, where the
   in-app surface and the external MCP surface have separate grants and the autonomy grant does not
   cross the boundary. The hazard recorded here is no longer in the code; the finding is kept because
   a defect that was fixed _after_ a read is exactly the kind of thing an audit must re-check rather
   than assume.
3. **H3 — pitch correction adds 83–167 ms.** `docs/LATENCY_AUDIT_2026-09-25.md:16`: Vocallab NIRA
   emits a TD-PSOLA trail of `L = ceil(sr·5/60)+2` = **4002 samples (83 ms)**; ×2 ≈ **167 ms** with
   the ±24 st two-stage chain. For a stage vocal this is the difference between "on the beat" and
   "late".
4. **H12 — the default WASAPI buffer is 100 ms**, not the 20–50 ms the status doc advertises
   (`packages/native-audio-engine/src/wasapi_player.cc:262`, `REFTIMES_PER_SEC / 10`); the 20–50 ms
   figure corresponds only to the `IAudioClient3` small-period path.
5. **No musical time as an addressable position.** _"Trim at bar 3"_ / _"move to bar 5"_ are **not
   expressible**. For an AI that must reason about form, this is fatal — and it is the single
   highest-value missing primitive in ZYVO.
6. **Vocal-specific measurement that is only _partly_ there.** _Corrected 2026-10-26:_ the original
   claim ("no vibrato rate/extent, no breathiness, no stage-noise floor estimate") was **false**.
   ZYVO **does** ship vibrato rate and extent, breath candidates and a per-take noise floor:
   `extractVibrato()` (`packages/analysis-pipeline/src/performanceGenome.ts:185`, `meanRateHz` `:227`,
   `meanExtentCents` `:229`, built `:464`), breath candidates (`:466-502`), all returned by
   `extractPerformanceVector` (`:557`) and wired into the app through
   `apps/vocalforge-daw/src/performanceVectorManager.ts:20,125`; the noise floor is `noiseFloorDb`
   (`packages/analysis-pipeline/src/cleanupAnalysis.ts:53,113,169`); the vibrato path is tested
   (`packages/analysis-pipeline/tests/performanceGenome.test.ts:86-93` — rate **and** extent on a
   synthetic FM tone). **Still absent:** jitter/shimmer, HNR, intelligibility and per-take spectral
   tilt. The existing contour rate (40 ms frame) is adequate to _draw_ a contour and **not**
   adequate for per-block live control.
7. **No measured accuracy anywhere.** No ground-truth benchmark for pitch accuracy, onset accuracy,
   key/tempo detection, or the reference-blueprint adaptations. Rosa's ONNX heads are trained on
   procedural fixtures only, and **no accuracy figure exists in the repo**.
8. **Coaching exists — but not the coaching an AAW needs.** _Corrected 2026-10-26:_ the original
   claim ("coaching is absent; there is no `*coach*` file anywhere in `apps/` or `packages/`") was
   **false**: a filename token cannot reveal a feature. ZYVO ships a **Vocal Coach** — an intonation
   report and card (`apps/vocalforge-daw/src/intonationReport.ts:2,115`,
   `apps/vocalforge-daw/src/intonationReportCard.ts:2,54`), a live pitch-trace buffer
   (`apps/vocalforge-daw/src/controller.ts:7580`) and per-gig coach notes
   (`apps/vocalforge-daw/src/liveShowGigReport.ts:181,449,571-573`). What does **not** exist is
   **phrase-aware, target-relative coaching**: a coach that compares a take against an _intentional_
   target rather than against a tonal centre.
9. **No audio pre-image of a pending proposal.** `RecordProposalRenderReceipt` stores _status_, not
   audio — an AI-assisted live workflow cannot _hear_ a proposal before accepting it.
10. **No general modulation matrix.** `modRoutes` exist **only** for Morph
    (`packages/audio-engine/src/dsp/dspChainRunner.ts:249-252`). A singer-as-modulator architecture
    needs a first-class modulation matrix with follower/pitch sources and per-route limits.
11. **H7 — a wake-word stub that still ships.** `binding.gyp:6` defaults `"HAS_PARAKEET%": 1`, but
    `packages/native-audio-engine/src/wake_word.cc:35-48` has the entire Sherpa-ONNX keyword spotter
    commented out under `TODO`, and `captureLoop` (`:160-174`) is an empty `while` + 32 ms sleep.
    A "native wake word" build exists and does nothing.
12. **H6 — a second capture client on the same microphone.** `parakeet_runtime.cc:1339-1347` opens its
    **own** `IAudioClient` on the mic with a 5 s buffer to absorb decode stalls. The inference is
    real and off the audio thread, but the risk is **device contention and CPU competition during a
    show**, not a deadline miss.
13. **Undo does not survive a reload, and there is no agent-writable undo tool.**
14. **No real-time safety envelope.** The only guard is an _allowlist of command types_
    (`packages/agent-runtime/src/audioTools/authorization.ts:85-106`) — a coarse proxy. There is no gain-ride limit, no blackout window
    around a downbeat, no confidence floor tied to audible consequences.

### 7.3 The status document, re-verified (6 of 10 claims confirmed)

`plans/ZYVO_CURRENT_STATE.md` was checked claim by claim, with counts recomputed by replicating the
repo's own counting logic rather than trusting the doc.

| Claim                               | Doc                                 | Measured                                | Verdict                                                  |
| ----------------------------------- | ----------------------------------- | --------------------------------------- | -------------------------------------------------------- |
| Registered command types            | 283                                 | **283**                                 | ✅                                                       |
| Agent/MCP tools                     | 61                                  | **61**                                  | ✅                                                       |
| Model-proposable intents            | 47                                  | **47**                                  | ✅                                                       |
| SoloFlow voice/text intents         | 142                                 | **142**                                 | ✅                                                       |
| Workspace packages                  | 23                                  | **23**                                  | ✅                                                       |
| Command handler files               | 246                                 | **246**                                 | ✅                                                       |
| Undo depth                          | 200                                 | **200**                                 | ✅                                                       |
| KYX transfer library size (3 files) | 39 985 B                            | **68 609 B**                            | ❌ the doc quotes one file's size and labels it as three |
| Source files / LOC                  | 1 997 / 510 581 / 103 296 / 667 200 | **2 001 / 511 117 / 103 682 / 668 187** | ❌ tree drift                                            |
| WASAPI shared-mode latency          | 20–50 ms                            | **100 ms** default                      | ❌                                                       |

**Additional discrepancies:** the doc says _"16 first-party pluginov"_ while `plugins/` holds **17**
directories (and omits `agentic-vocal`, which has 114 TS files, a native core and a VST3 — not a
stub); it says _"17 built-in efektov"_ while `packages/audio-engine/src/dsp/dspRegistry.ts:101-137`
registers **37** DSP effects; it frames ASIO as opt-in behind `--HAS_ASIO=1` while `binding.gyp:3`
defaults it to **1** and the Steinberg SDK is **vendored** (`vendor/asio/`, 48 files);
`AI_CONTROL_COMPLETENESS_AUDIT_REPORT.md:16` says **282** command types where the code has **283**;
and `NEXT_GENERATION_CAPABILITY_REVIEW_REPORT.md:223` ("no envelope-follower source") is **stale** —
the lead-vocal envelope follower is implemented and wired
(`packages/audio-engine/src/dsp/leadEnvelopeStore.ts`, consumed at `packages/audio-engine/src/dsp/dspChainRunner.ts:775` and
`mixdown.ts:2035-2041`).

`MCP_AI_CONTROL_MATRIX.md:61` still says _"24 tools"_ while the code has **61** — the matrix is an
archived Revízia 3 (2026-10-04) and is stale relative to code.

### 7.4 The cross-product asymmetry worth acting on

> **ZYVO's external-MCP consent model is stronger than KYX's.**
> ZYVO: external MCP is **draft-only**, autonomy is not forwarded, and acceptance is a UI click
> (`agentVoiceManager.ts:5671-5679`). KYX: **21 of 39** tools mutate with **no per-call approval**
> (only the 7 destructive ones are gated by `pf:mcp-allow-destructive`).

The frontier program's first act should therefore be to **port ZYVO's consent posture to KYX**
rather than to invent a new lattice — and the permission lattice in
`AAW_AI_CONTROL_CONTRACTS.md` §4 is the generalisation of what ZYVO already does well. This is the
clearest concrete example of the shared control plane paying for itself: **one product's better
practice becomes the other's default.**

---

## 8. What this document does not claim

- It does not claim any feature **sounds good**. It claims what exists, is deterministic, is
  measured, and is wired.
- It does not claim the **Ollama** or **ONNX** numbers were re-measured here; they are read from the
  repo's own reports and code-embedded measurements.
- It does not claim `kyx_render_summary` / `kyx_diagnose_mix` are _accurate_ on real mixes — only
  that the code paths exist.
- It does not claim the absence of audio embeddings is a bug. It is a **fact about today**, and the
  landscape says closing it requires either a non-commercial model, a server-class model, or
  embeddings — not a small open music-understanding model.
- **Correction (2026-10-26):** an earlier version of this document claimed a _verified absence_ of
  audio tagging in KYX. That claim was **false** — the repo ships an AudioSet/AST tagger (see §2
  G-A). The audio-**embedding** absence above stands; the tagging absence does not.
- It does not claim the MCP transport works end-to-end over HTTP; that was not exercised.
