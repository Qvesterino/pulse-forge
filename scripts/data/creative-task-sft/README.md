# Creative-task SFT bootstrap

This corpus trains only the versioned `CreativeTaskOutputV1` proposal contract. It is not an action-intent corpus, a beat-generation dataset, or evidence of musical quality.

Current contents are deliberately marked `synthetic: true`, `humanReviewed: false`, and `eligibleForModelPromotion: false` in `manifest.json`. They provide a small SK/EN format-and-extraction bootstrap across proposal, clarification, and abstention. They are not representative enough to claim real-producer understanding or to ship/promote a model.

The creative held-out set at `../creative-task-v1-golden.jsonl` is never read as a training source. The generator checks exact prompt/ID overlap and family overlap, as well as a family-disjoint train/validation split. The system prompt is sourced from the same runtime provider function rather than copied by hand.

```powershell
npm run creative-task:sft-data       # regenerate from checked-in authored scenarios
npm run creative-task:sft-validate   # verify deterministic bytes, hashes, schema, splits and leakage
```

The separate trainer does not inherit the action model's base model or report. It requires an explicit model ID/path, pinned model revision, `--allow-synthetic-bootstrap`, CUDA, and at least 4 GiB free VRAM. Missing model files are **not downloaded by default**; `--allow-model-download` is a separate explicit opt-in. It saves only a LoRA adapter and an experimental report under the caller-selected output directory; there is no automatic merge, Ollama import, runtime registration, or promotion.

The current local Hugging Face cache has the LFM2.5 tokenizer/config but not its weight shards. No model download or training run has been started; do not enable downloads without checking disk/network constraints and the training-data gate.

```powershell
npm run creative-task:sft-train -- `
  --base-model <explicit-model-id-or-local-snapshot> `
  --base-revision <pinned-commit-or-local> `
  --out-dir D:/pulse-forge/.sft/creative/experiment-01 `
  --allow-synthetic-bootstrap
```

Do not use the bootstrap report as a release gate. A release candidate requires consented, human-reviewed SK/EN data and a separate blind-listening evaluation; keep those examples out of this synthetic set and the model's training split.
