# Creative-task SFT bootstrap

This corpus trains only the versioned `CreativeTaskOutputV1` proposal contract. It is not an action-intent corpus, a beat-generation dataset, or evidence of musical quality.

Current contents are deliberately marked `synthetic: true`, `humanReviewed: false`, and `eligibleForModelPromotion: false` in `manifest.json`. They provide a small SK/EN format-and-extraction bootstrap across proposal, clarification, and abstention. They are not representative enough to claim real-producer understanding or to ship/promote a model.

The creative held-out set at `../creative-task-v1-golden.jsonl` is never read as a training source. The generator checks exact prompt/ID overlap and family overlap, as well as a family-disjoint train/validation split. The system prompt is sourced from the same runtime provider function rather than copied by hand.

```powershell
npm run creative-task:sft-data       # regenerate from checked-in authored scenarios
npm run creative-task:sft-validate   # verify deterministic bytes, hashes, schema, splits and leakage
```

The separate trainer does not inherit the action model's base model or report. It requires an explicit model ID/path, pinned model revision, `--allow-synthetic-bootstrap`, CUDA, and at least 4 GiB free VRAM. Missing model files are **not downloaded by default**; `--allow-model-download` is a separate explicit opt-in. It saves only a LoRA adapter and an experimental report under the caller-selected output directory; there is no automatic merge, Ollama import, runtime registration, or promotion.

**Pilot status (2026-10-02):** one isolated run trained the pinned `LiquidAI/LFM2.5-1.2B-Instruct` snapshot for three epochs on the 32-row synthetic train split with downloads disabled. The adapter's 32-row validation result is in `bootstrap-evaluation-2026-10-02-v2.json`; the complete paired base-vs-adapter score is in `base-vs-adapter-2026-10-02.json`; per-case, prompt-free failure codes are in `base-vs-adapter-diagnostics-2026-10-02.json`. The adapter passed 25/32 schema/context checks, but all 24 expected creative proposals failed to produce an accepted proposal (17 abstentions; 7 rejected proposals), while its four exact matches were out-of-scope abstentions. It is not promotion-eligible and must not be routed in the UI. These are synthetic interpretation metrics, not human usefulness or musical-quality results.

The local SFT weight snapshot was available for that pinned run and `modelDownloadAllowed` is false in its report. That historical result replaces the earlier setup note that said only tokenizer/config files were cached and training had not started. Do not download another model or start another synthetic-only training run as a substitute for the human-review gate.

```powershell
npm run creative-task:sft-train -- `
  --base-model <explicit-model-id-or-local-snapshot> `
  --base-revision <pinned-commit-or-local> `
  --out-dir D:/pulse-forge/.sft/creative/experiment-01 `
  --allow-synthetic-bootstrap
```

Do not use the bootstrap report as a release gate. The local human-review format, rubric and read-only validator are documented in `docs/CREATIVE-TASK-HUMAN-EVALUATION.md`; real examples must stay under the Git-ignored `.sft/creative-human-review/` directory and must never be added to this synthetic corpus. The validator does not export or train reviewed data; a separate consent-preserving training path and blinded listening study are still required.
