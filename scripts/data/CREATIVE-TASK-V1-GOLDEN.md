# Creative task v1 held-out set

`creative-task-v1-golden.jsonl` is a small, manually curated **synthetic seed set** for evaluating structured brief interpretation. It is not a sample of real user traffic, not a music-quality benchmark, and not evidence that a model understands producers.

- Keep every row in the `held-out` split. Do not copy these prompts or targets into a training corpus; create training examples from separate prompt families.
- `family` groups related wording/translation so later data splits can keep paraphrases together.
- The expected output is a field-level interpretation target. Preference strings and clarification examples need human review before any release claim.
- Hard-field compliance, soft-preference extraction, clarification decisions and unresolved fields are reported separately. The evaluator does not score whether generated music sounds good.
- Real-creator prompts may be added only after explicit consent and privacy review; do not ingest project audio, vocals, lyrics or raw transcripts by default.

Given provider predictions as JSONL rows of `{ "id": "<golden id>", "output": <CreativeTaskOutputV1> }`, run:

```powershell
npx vite-node scripts/evaluate-creative-task.mts --predictions path/to/predictions.jsonl
```

The report pins SHA-256 hashes of both input files. Thresholds are intentionally not set from this synthetic seed set; define release gates only after establishing deterministic baseline coverage and a reviewed, representative holdout.
