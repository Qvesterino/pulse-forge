# LOCAL INTENT MODEL — SFT FINE-TUNE RUNBOOK

> Practical, repeatable recipe for fine-tuning a small (≤ 2B) instruct model
> on a deterministic engine's output — the "engine is the teacher, the model
> is the student" pipeline. Architecture and rationale:
> [`LOCAL-INTENT-MODEL.md`](./LOCAL-INTENT-MODEL.md). This file is the
> hands-on runbook: exact commands, completion markers, verified pitfalls.
>
> **Historical runbook; current release status is in
> `docs/LOCAL-INTENT-MODEL.md` and
> `docs/IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md`.** §11 below holds the
> authoritative pinned scorecard: four models on the full **298-row** val,
> one evaluator revision, each warmed before measuring, every row backed by a
> machine-readable report in `scripts/data/intent-sft/lfm-eval-*.json`.
> Current production default is **`kyx-intent-v33-q8`** (220/240 = 91,67 %,
> wrongKind 3) per commit `81e94af5`. Earlier numbers in this file — 92 %,
> 88,2 %, 92,5 %, 95,6 %, the 294- and 272-row denominators, and the
> "abstain 0,7 %" claim — are **superseded and not reproducible**; see §11 for
> what replaced them. Re-run the exact model artifact against a
> candidate-disjoint holdout before claiming generalization or producer
> quality.

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

| Marker                               | Where                                                        |
| ------------------------------------ | ------------------------------------------------------------ |
| Val results printed + report written | `scripts/data/intent-sft/sft-report.json` (mtime updates)    |
| Final log line                       | `merged:  <dir>  (next: convert_hf_to_gguf → ollama create)` |
| GPU utilization drops                | 95 % → ~7 % (desktop baseline)                               |
| Artifacts updated                    | `.sft/work/adapter/` + `.sft/work/merged/` mtimes            |

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

| Pitfall                           | Detail                                                                                                                        | Fix                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Base-model default**            | `DEFAULT_BASE = LiquidAI/LFM2-1.2B` (old generation) — a run without `--base-model` silently trains the wrong model           | Always pass `--base-model` explicitly; check the log's model line              |
| **Two python PIDs**               | venv `python.exe` is a launcher shim that execs the base `Python312\python.exe` — two PIDs, ONE training. Not a double-launch | Check command lines, not process count                                         |
| **Buffered progress**             | Redirected output hides training steps until flush                                                                            | `PYTHONUNBUFFERED=1`, or watch the GPU (95 % = training)                       |
| **Grammar responses need tokens** | `num_predict 80` truncates schema-forced JSON (`done_reason=length`) → parse failures masquerading as model failures          | ≥ 300 for structured intent responses                                          |
| **HF unauthenticated throttle**   | ~380 KB/s without a token (2.4 GB ≈ 1.5 h)                                                                                    | `HF_TOKEN` if available; otherwise start early, cache persists across restarts |
| **Venv on C:**                    | torch + checkpoints don't fit                                                                                                 | venv lives on D:                                                               |
| **`causal_conv1d` fallback**      | Reference PyTorch conv = training works but slower                                                                            | Optional: install `causal_conv1d` for the optimized kernel                     |
| **Eval harness OOM**              | ~900-file vitest suite OOMs CI runners                                                                                        | `NODE_OPTIONS=--max-old-space-size=4096` + `--maxWorkers=2`                    |

---

## 9. Historical status note (2026-09-27; superseded)

- LFM2 run (baseline): historical report 55/60 exact, model in Ollama as
  `kyx-intent-sft:latest`.
- LFM2.5 training and conversion were subsequently completed; the committed
  report and later runtime-eval snapshots are in §10. Do not interpret this
  dated status as a currently running training job or as proof of a shippable
  self-contained KYX Studio model.

---

## 10. Historical eval snapshots — LFM2.5 SFT (2026-09-30)

These are checkpoint-specific historical measurements, not the pinned
release baseline. This snapshot's runtime evaluator (45/51 attempted-exact,
51 rows) and the trainer's own quick-val are different metrics on different
denominators. The trainer score quoted in earlier revisions of this file
(34/60) does not match any committed `sft-report.json` — the v31 report
recorded 26/60 and the v32 report 58/60 — so treat it as a transcription
error, not a measurement. Current generation figures are in the comparison
table below.
The repository currently lacks a single machine-readable report that binds
both to one exact GGUF/model hash, tokenizer, quantization, dataset hashes
and evaluator revision.

Independent eval (`eval-ollama-intent.mts`, val.jsonl 60 rows, temperature 0):

```
attempted-exact: 45/51 (88.2%)  wrongKind: 1  schema-invalid: 0  abstain: 9/60 (15%)
```

Per-kind: fader 27/27, exact/tempo/transport/export/production/select/send/revise 100 %, effectIntent 2/2.
Weak tails: mix 0/3, clarify 0/2, loudness 0/1.

### Tail forensics — exact-match vs semantic correctness

Probing some "failed" rows showed semantically plausible intents that fail
literal serialization:

```
"darker"          → {"kind":"mix","overrides":{"tone":"dark"}}       (semantically right)
"loudness na -9"  → {"kind":"loudness","direction":"louder",...}     (semantically right)
```

The exact metric requires byte-equality with the teacher row; field-value
synonyms ("subtle" vs "slight", key ordering) fail it. Some mismatches may
be normalized by `validateModelAction` and resolver adapters, but this does
not prove all misses are harmless. Every miss needs an output diff and
classification as serialization-only, semantic error, wrong-kind,
abstention or schema failure. The 1 wrong-kind in this snapshot remains a
real failure signal even though many ambiguous asks abstained.

### Comparison table — the whole SFT story

**Only rows marked 298-row are directly comparable.** They were measured on
the identical `val.jsonl` (sha256 `5b33d956…`, manifest v4) with one evaluator
revision. Rows measured on 60-, 51- or 294-row samples are **not** comparable
to them, and the 294/272-row figures belong to an older 1761/294 corpus that is
no longer the val split. The authoritative current set is §11.

| Model                              | Method                              | Score                        | Denominator  | Notes                                                                      |
| ---------------------------------- | ----------------------------------- | ---------------------------- | ------------ | -------------------------------------------------------------------------- |
| LFM2-1.2B base (prompted)          | few-shot prompt                     | ~14-30 %                     | 204 cases    | unconditioned measurement issues; hallucinates kind names                  |
| **LFM2 SFT (kyx-intent-sft)**      | Historical LoRA run, 1,479 examples | **92 %** (55/60)             | 60 rows      | Old evaluator/checkpoint; NOT comparable to any 298-row row                |
| LFM2.5 SFT (kyx-intent-sft-25)     | Historical LoRA run, 779 examples   | **88.2 %** (45/51 attempted) | 51 rows      | Separate runtime eval; older checkpoint                                    |
| LFM2.5 SFT (kyx-intent-v30-q8)     | Quantized, ex-default               | **89,58 %** (215/240)        | **298 rows** | wrongKind 7, abstain 19,5 %; measured WORST of four; superseded as default |
| LFM2.5 SFT (kyx-intent-v31)        | F16                                 | 91,25 % (219/240)            | **298 rows** | wrongKind 6, abstain 19,5 %                                                |
| LFM2.5 SFT (kyx-intent-v33)        | F16                                 | 91,63 % (219/239)            | **298 rows** | wrongKind 3, abstain 19,8 %                                                |
| **LFM2.5 SFT (kyx-intent-v33-q8)** | Q8_0, **CURRENT DEFAULT**           | **91,67 %** (220/240)        | **298 rows** | wrongKind **3**, abstain 19,5 %; `effectIntent` wrongKind 6 → 0            |

**Reading the table honestly:** the old `NO FLIP` verdict and its stated
reason — that v30-q8 had "the best abstention profile by two orders of
magnitude" — do not survive measurement. All four models abstain ~19,5 %;
abstention was never a differentiator, and v30-q8 is in fact the weakest of
the four. The default moved to `kyx-intent-v33-q8` (commit `81e94af5`), which
wins on every metric at the same VRAM and disk footprint.

Per-kind tail: `preset` is **0/4 in all four models** — no recipe moved it,
and the cause is confirmed experimental rather than inferred: the model applies
the compound envelope to a standalone preset and emits the full catalogue blob.
`loudness` sits at 0/8 on v33 because `direction` is right and the numeric
`targetDb` slot is simply absent — slot loss, not a serialization convention.
`detected` is already stripped from the comparison, so those misses are not
engine-filled-field artifacts. More rows of the same shape will not fix
either; see §11 for the curriculum.

### Eval harness rules learned (apply to every future eval)

1. Send the system prompt — an eval that omits it measures an
   unconditioned model (our first run: 14 % was this bug).
2. `num_predict ≥ 300` for schema-forced JSON (80 truncates → fake parse
   failures). **Production shipped at 256, below this threshold** — that
   truncated two semantically CORRECT intents into unparseable JSON and
   presented them as model failures. Production now sends
   `num_predict: 384` with `temperature: 0` (`src/intent/model-ollama.ts`).
3. exact-match metrics need a semantic-fail analysis pass: probe every
   "failed" row and classify serialization-diff vs true semantic error.
4. Latency numbers are only valid on an idle GPU — never measure during
   concurrent training.
5. **Warm the model before measuring.** The first `generate` call pays the
   VRAM load and can abort inside the 45 s timeout. Cold runs read ~2 points
   lower and the aborted rows are a load artifact, not a model defect.
6. **Await `warmFactoryPresets()` before the first row.** Without it the run
   dies on row 1 of 298 with "factory preset bank not warmed" — and
   `--limit 60` sails past, so the subset run looks healthy while the full
   run cannot start at all.
7. **Always measure the full val.** `--limit 60` both flatters the model and
   can miss the 4 `preset` rows entirely, hiding a 0/4 family.
8. **The eval must WRITE its report.** Every number below comes from a
   machine-pinned JSON with the ollama digest, SHA-256 of train/val/golden/
   prompt/manifest and the evaluator source hashes. Earlier revisions printed
   only to stdout, so every documented figure was hand-transcribed — which is
   the mechanical reason the corpus grew three mutually contradictory
   "pinned" scorecards. `--no-report` skips the write, `--report <path>`
   redirects it.

---

## 11. PINNED scorecard — 298-row val, one instrument (2026-10-09)

Four models, one corpus (`val.jsonl` sha256 `5b33d956…`, manifest v4 =
1790 train / 298 val / 74 golden), one evaluator revision, each warmed before
measuring. Reproducible from `scripts/data/intent-sft/lfm-eval-*.json`.

**`attempted-exact` is divided by `attempted` (≈240), NOT by `rows` (298).**
Abstained rows leave the denominator, so the rate and the abstain column must
always be read together.

| model                   | quant | attempted-exact | rate        | wrongKind | abstain          |
| ----------------------- | ----- | --------------- | ----------- | --------- | ---------------- |
| `kyx-intent-v30-q8`     | Q8_0  | 215/240         | 89,58 %     | 7         | 58/298 (19,46 %) |
| `kyx-intent-v31`        | F16   | 219/240         | 91,25 %     | 6         | 58/298 (19,46 %) |
| `kyx-intent-v33`        | F16   | 219/239         | 91,63 %     | 3         | 59/298 (19,80 %) |
| **`kyx-intent-v33-q8`** | Q8_0  | **220/240**     | **91,67 %** | **3**     | 58/298 (19,46 %) |

**`kyx-intent-v33-q8` is the production default** (`81e94af5`), at the same
VRAM and disk footprint as the v30-q8 it replaced — the only reason v30-q8 had
been chosen originally.

### Per-kind delta that justified the flip (v30-q8 → v33-q8)

| kind           | v30-q8             | v33-q8                 | delta               |
| -------------- | ------------------ | ---------------------- | ------------------- |
| `effectIntent` | 19/26, wrongKind 6 | **24/26, wrongKind 0** | **the win**         |
| `exact`        | 65/66              | 67/67                  | +2                  |
| `compound`     | 7/7                | 6/7, wrongKind 1       | **regression**      |
| `loudness`     | 1/8                | 0/8, wrongKind 1       | **regression**      |
| `production`   | 11/11              | 10/11                  | **regression**      |
| `mix`          | 9/12, wrongKind 1  | 10/11, wrongKind 1     | attempted 12 → 11   |
| `preset`       | 0/4                | 0/4                    | **0/4 in all four** |
| abstain        | 19,5 %             | 19,5 %                 | flat                |

### Curriculum for the next generation

1. **`preset` 0/4 in every model measured.** The model applies the compound
   envelope to a standalone preset request and emits the full catalogue blob
   (`intent` + `instrument/genre/mood/tags/params`) where the teacher emits
   `{preset:{id,name}, target, matchedBy}`. Confirmed across four checkpoints,
   so this is the corpus shape, not a single bad run.
2. **`loudness` 0/8.** `direction` correct, numeric `targetDb` slot absent,
   `detected` receives a hallucinated `"AI"` sentinel that occurs **zero
   times** in train/val/golden. `detected` is stripped from the comparison, so
   the counted miss is `targetDb` itself — slot loss at 1.2B, not a convention.
3. **v33's regressions are the price of the `effectIntent` win.** `compound`
   6/7 and `production` 10/11 now absorb rows v33 moved out of
   `effectIntent`. Count it as a trade, not a clean gain.

### Numbers that must not be cited again

- **92,5 % / abstain 0,7 %** (`INTENT-MINING`, commit `957ed711`) — not
  reproducible; real v30-q8 is 89,58 % / 19,46 %.
- **95,6 % / wrongKind 0 / abstain 1 z 272** (`CURRENT-STATE`) — not
  reproducible. Two independent full-val runs of v30-q8 returned identical
  metrics, so this is instrument determinism rather than documentation drift.
- **"best abstention profile by two orders of magnitude"** — dead; all four
  models abstain ~19,5 %.
- **274/295 = 92,88 %, abstain 3/298** (`lfm-runtime-evaluation-2026-10-02.json`)
  — v31's weights are provably the same file (sha256 `19628fcd…`) and the val
  split is byte-identical (`5b33d956…` in both reports), yet today's v31
  measures 219/240 with abstain 58/298. Same weights, same data, different
  number ⇒ the delta lives in the **instrument or the abstention definition**.
  **1,01 % is not a citable property of v31.**
- **294- and 272-row denominators** — those belong to the older 1761/294
  corpus. The current val is **298**.
