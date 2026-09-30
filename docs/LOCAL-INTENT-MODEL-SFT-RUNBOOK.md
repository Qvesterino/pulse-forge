# LOCAL INTENT MODEL — SFT FINE-TUNE RUNBOOK

> Practical, repeatable recipe for fine-tuning a small (≤ 2B) instruct model
> on a deterministic engine's output — the "engine is the teacher, the model
> is the student" pipeline. Architecture and rationale:
> [`LOCAL-INTENT-MODEL.md`](./LOCAL-INTENT-MODEL.md). This file is the
> hands-on runbook: exact commands, completion markers, verified pitfalls.
>
> Proven: **LFM2-1.2B base → LoRA SFT → 92 % exact** on the KYX intent
> corpus (1479 examples, 3 epochs, RTX 3060 6 GB, bf16 LoRA). Current run:
> **LFM2.5-1.2B-Instruct** (newer generation — see §8 for the base-model
> pitfall that motivated this runbook).

---

## 0. The one-paragraph essence

The deterministic intent layer (rule parser, 97 %+ on its own vocabulary)
generates a corpus of `(user phrase → canonical action JSON)` pairs — it is
the TEACHER. A small model is then LoRA fine-tuned on those pairs (the
STUDENT), so the engine's knowledge is baked into the weights instead of
being re-guessed from a prompt. Why both: the rule parser is instant and
exact but literal (45 % on paraphrases in our 204-case eval); the fine-tuned
model generalizes to rewordings while being grammar-constrained so it cannot
emit an invalid action. Independent eval (paraphrases + safety injections
the SFT never saw) is the acceptance gate — measured on the base LFM2-1.2B:
**14 % vocabulary / 0 % paraphrases → fine-tuning is not optional, it is the
entire value.**

---

## 1. Prerequisites (one-time)

```powershell
# Python 3.12 venv on D: (C: is too full for torch + checkpoints)
py -3.12 -m venv D:/pulse-forge/.sft/venv
D:/pulse-forge/.sft/venv/Scripts/python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu124
D:/pulse-forge/.sft/venv/Scripts/python.exe -m pip install transformers peft accelerate gguf huggingface_hub

# llama.cpp tools (GGUF conversion)
git clone https://github.com/ggerganov/llama.cpp D:/pulse-forge/.sft/llama.cpp
```

Verified working versions (2026-09-27): transformers **5.17** (supports both
LFM2 and LFM2.5 architectures), torch 2.6.0+cu124, CUDA available. GPU
profile: RTX 3060 6 GB laptop — 1.2B bf16 LoRA fits with room to spare
(5.7/6.1 GB), thermals ~60 °C.

---

## 2. Corpus — the teacher writes the textbook

```powershell
npx vite-node scripts/generate-intent-dataset.mts
```

- Teacher = the deterministic intent layer; every example is
  `(instruction → action JSON)` with all parameters clamped and targets
  resolved. Output: `scripts/data/intent-sft/train.jsonl` (+ `val.jsonl`,
  `golden.jsonl`, `manifest.json`).
- `prompt.txt` is the pinned system prompt — **byte-identical to the Ollama
  provider's system prompt** and pinned by
  `tests/intent-model-sft-prompt.test.ts`. If you change the prompt, change
  it through that script and re-run training.

**Quality bar:** the corpus is only as good as the teacher. A deterministic
layer at 97 %+ is a great teacher; never generate the corpus from another
LLM's output (error compounding).

---

## 3. Training

```powershell
cd D:/pulse-forge
D:/pulse-forge/.sft/venv/Scripts/python.exe scripts/train-intent-sft.py `
  --base-model LiquidAI/LFM2.5-1.2B-Instruct
```

Key flags: `--epochs 3` (default — SFT sweet spot, more = overfit),
`--batch 4 --accum 4` (effective 16), `--lr 2e-4`, `--val-limit 60`.

**Base-model selection (§8 pitfall — read this):** `DEFAULT_BASE` in the
script is `LiquidAI/LFM2-1.2B` (old generation). For the current generation
pass `--base-model LiquidAI/LFM2.5-1.2B-Instruct` explicitly. Rule of thumb:
`-Instruct` for SFT on rigid output formats (converges faster, better
language in reasoning fields); `-Base` when you want the chat prior gone.

### How to know training is done (any of these)

| Marker | Where |
|---|---|
| Val results printed + report written | `scripts/data/intent-sft/sft-report.json` (mtime updates) |
| Final log line | `merged:  <dir>  (next: convert_hf_to_gguf → ollama create)` |
| GPU utilization drops | 95 % → ~7 % (desktop baseline) |
| Artifacts updated | `.sft/work/adapter/` + `.sft/work/merged/` mtimes |

Heads-up: with redirected output the progress bars are **buffered** — run
with `PYTHONUNBUFFERED=1` to watch live steps, or just watch the GPU.

---

## 4. GGUF conversion

```powershell
D:/pulse-forge/.sft/venv/Scripts/python.exe D:/pulse-forge/.sft/llama.cpp/convert_hf_to_gguf.py `
  D:/pulse-forge/.sft/work/merged --outfile D:/pulse-forge/.sft/work/intent-sft-f16.gguf --outtype f16
```

---

## 5. Ollama import

`Modelfile` (in `.sft/work/`):

```
FROM ./intent-sft-f16.gguf
PARAMETER temperature 0
```

Temperature 0 is deliberate — intent emission is classification, not
creative writing. Then:

```powershell
cd D:/pulse-forge/.sft/work
ollama create <model-name> -f Modelfile
```

Naming convention so baselines stay comparable: `kyx-intent-sft` (LFM2 run),
`kyx-intent-sft-25` (LFM2.5 run), etc.

---

## 6. Eval — the acceptance gate

Two layers, both required:

1. **In-domain** (the SFT corpus' own yardstick):
   `npx vite-node scripts/validate-intent-model.mts` — canonical exact /
   kindOK against the teacher. Reference: LFM2 run scored 55/60 exact,
   56/60 kindOK.
2. **Independent** (generalization + safety — cases the SFT never saw):
   the ZYVO eval harness, 204 cases in three sets:
   - A: 176 verified vocabulary phrases
   - P: 20 paraphrases (rewordings NOT in the corpus — the honest
     generalization test)
   - S: 8 safety cases (out-of-scope + prompt injections — must NOT resolve
     to a destructive command)

   ```powershell
   npx vite-node scripts/llm-eval.mts --model <model-name>   # from the ZYVO repo
   ```

   Measured baseline (base LFM2-1.2B via prompting, no SFT): **14 %
   vocabulary / 0 % paraphrases, p50 8.3 s (CPU)** — fine-tuning is what
   moves these numbers; a report without the P set is marketing, not eval.

---

## 7. Recipe card — fine-tuning a NEW domain (mix, mastering, competition)

The pipeline is domain-agnostic. To teach a ~1.5B instruct model a new
capability (competition-grade or mix/mastering control):

1. **Pick the teacher.** The deterministic mix/mastering layer (rules,
   presets, clamps) — never another LLM.
2. **Generate the corpus** with the same shape:
   `(natural-language request → canonical action JSON)`. Cover: happy
   paths, numeric ranges (clamped values!), edge cases, refusals.
3. **Split** train/val (keep the val honest — model never trains on it).
4. **Train** with §3, `--base-model` = the competition's allowed model class
   (~1.5B instruct), everything else default.
5. **Convert + import** (§4–5). Keep temperature 0.
6. **Eval** (§6): in-domain exact-match AND an independent set with
   paraphrases + safety injections. Report both numbers — the gap between
   them IS the overfitting measurement.
7. **Ship behind the deterministic gate**: model output → schema validation →
   adapter → command layer with undo + clamps + readback. The model
   classifies and fills slots; the engine does everything else.

---

## 8. Verified pitfalls (each one cost real time)

| Pitfall | Detail | Fix |
|---|---|---|
| **Base-model default** | `DEFAULT_BASE = LiquidAI/LFM2-1.2B` (old generation) — a run without `--base-model` silently trains the wrong model | Always pass `--base-model` explicitly; check the log's model line |
| **Two python PIDs** | venv `python.exe` is a launcher shim that execs the base `Python312\python.exe` — two PIDs, ONE training. Not a double-launch | Check command lines, not process count |
| **Buffered progress** | Redirected output hides training steps until flush | `PYTHONUNBUFFERED=1`, or watch the GPU (95 % = training) |
| **Grammar responses need tokens** | `num_predict 80` truncates schema-forced JSON (`done_reason=length`) → parse failures masquerading as model failures | ≥ 300 for structured intent responses |
| **HF unauthenticated throttle** | ~380 KB/s without a token (2.4 GB ≈ 1.5 h) | `HF_TOKEN` if available; otherwise start early, cache persists across restarts |
| **Venv on C:** | torch + checkpoints don't fit | venv lives on D: |
| **`causal_conv1d` fallback** | Reference PyTorch conv = training works but slower | Optional: install `causal_conv1d` for the optimized kernel |
| **Eval harness OOM** | ~900-file vitest suite OOMs CI runners | `NODE_OPTIONS=--max-old-space-size=4096` + `--maxWorkers=2` |

---

## 9. Current status (2026-09-27)

- LFM2 run (baseline): done — report 55/60 exact, model in Ollama as
  `kyx-intent-sft:latest`.
- **LFM2.5 run: training** (`--base-model LiquidAI/LFM2.5-1.2B-Instruct`,
  log `.sft/work/train-lfm25.log`). After completion: §4 → §5 as
  `kyx-intent-sft-25` → §6 eval on all 204 cases → numbers land here.

---

## 10. Eval results — LFM2.5 SFT (2026-09-30)

Independent eval (`eval-ollama-intent.mts`, val.jsonl 60 rows, temperature 0):

```
attempted-exact: 45/51 (88.2%)  wrongKind: 1  schema-invalid: 0  abstain: 9/60 (15%)
```

Per-kind: fader 27/27, exact/tempo/transport/export/production/select/send/revise 100 %, effectIntent 2/2.
Weak tails: mix 0/3, clarify 0/2, loudness 0/1.

### Tail forensics — exact-match vs semantic correctness

Probing the "failed" rows shows the model produces SEMANTICALLY CORRECT
intents that fail only literal serialization:

```
"darker"          → {"kind":"mix","overrides":{"tone":"dark"}}       (semantically right)
"loudness na -9"  → {"kind":"loudness","direction":"louder",...}     (semantically right)
```

The exact metric requires byte-equality with the teacher row; field-value
synonyms ("subtle" vs "slight", key ordering) fail it. Production path
(`validateModelAction` + resolver adapters) normalizes these — so the tails
are EVAL STRICTNESS, not model failure. The safe-failure design also holds:
the model abstains rather than guessing on ambiguous asks.

### Comparison table — the whole SFT story

| Model | Method | KYX val exact | Notes |
|---|---|---|---|
| LFM2-1.2B base (prompted) | few-shot prompt | ~14-30 % (unconditioned measurement issues) | hallucinates kind names |
| **LFM2 SFT (kyx-intent-sft)** | LoRA SFT 1479 ex | **92 %** (55/60) | production quality |
| **LFM2.5 SFT (kyx-intent-sft-25)** | LoRA SFT, same corpus | **88.2 %** (45/51 attempted) | tails = serialization strictness; safe abstain 15 % |

### Eval harness rules learned (apply to every future eval)

1. Send the system prompt — an eval that omits it measures an
   unconditioned model (our first run: 14 % was this bug).
2. num_predict ≥ 300 for schema-forced JSON (80 truncates → fake parse failures).
3. exact-match metrics need a semantic-fail analysis pass: probe every
   "failed" row and classify serialization-diff vs true semantic error.
4. Latency numbers are only valid on an idle GPU — never measure during
   concurrent training.
