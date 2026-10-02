# Creative task v1 held-out set

`creative-task-v1-golden.jsonl` is a small, manually curated **synthetic seed set** for evaluating structured brief interpretation. It is not a sample of real user traffic, not a music-quality benchmark, and not evidence that a model understands producers.

- Keep every row in the `held-out` split. Do not copy these prompts or targets into a training corpus; create training examples from separate prompt families.
- `family` groups related wording/translation so later data splits can keep paraphrases together.
- The expected output is a field-level interpretation target. Preference strings and clarification examples need human review before any release claim.
- Hard-field compliance, soft-preference extraction, clarification decisions and unresolved fields are reported separately. The evaluator does not score whether generated music sounds good.
- Real-creator prompts may be added only after explicit consent and privacy review; do not ingest project audio, vocals, lyrics or raw transcripts by default.
- For two-reviewer annotation, adjudication, local-only storage and the read-only human-corpus validator, follow [`docs/CREATIVE-TASK-HUMAN-EVALUATION.md`](../../docs/CREATIVE-TASK-HUMAN-EVALUATION.md). The existing set remains synthetic and held out.

Given provider predictions as JSONL rows of `{ "id": "<golden id>", "output": <CreativeTaskOutputV1> }`, run:

```powershell
npx vite-node scripts/evaluate-creative-task.mts --predictions path/to/predictions.jsonl
```

To run the current synthetic set through a specific local Ollama model and produce both pinned predictions and an evaluation report:

```bash
npx vite-node scripts/evaluate-creative-task-ollama.mts --model kyx-intent-v30-q8 --predictions-out scripts/data/creative-task-v1-predictions.jsonl --report-out scripts/data/creative-task-v1-report.json
```

This runner is an explicit evaluation tool, not a default runtime registration. It records the exact Ollama model digest, prompt/evaluator/source hashes, provider failures and task metrics. The output remains a synthetic prompt-set baseline; it is not human-rated musical quality and cannot alone authorize release.

The 2026-10-02 `kyx-intent-v30-q8:latest` snapshot is diagnostic only: 2 Ollama completions were produced and both failed schema validation (`invalid-suggestion`, `invalid-shape`); the circuit breaker short-circuited the remaining 19 cases. The report therefore has 2 invalid predictions and 19 missing predictions, not a completed 21-example accuracy measurement. See `creative-task-v1-report.json` and the hashed prediction JSONL.

The report pins SHA-256 hashes of both input files. Thresholds are intentionally not set from this synthetic seed set; define release gates only after establishing deterministic baseline coverage and a reviewed, representative holdout.
