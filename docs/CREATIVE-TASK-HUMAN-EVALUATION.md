# Creative-task human review protocol

This protocol prepares a **local, consented, human-reviewed** interpretation set for `creative-task-v1`. It is not a music-quality rubric and it does not authorize model promotion by itself. The existing synthetic SFT corpus remains isolated; real-creator data must never be copied into it.

## Privacy and consent gate

- Collect only the short text brief and the minimum labels needed to judge its interpretation. Do not ingest project files, audio, vocals, lyrics, full conversation transcripts, account names, email addresses, or track/project IDs.
- Obtain explicit, recorded consent for the exact intended use before the brief enters the review corpus. Training and evaluation consent are separate: `train` rows require `model-training`; `validation` and `held-out` rows require `evaluation` only.
- Review and redact the brief for personal or confidential details before annotation. `privacyReviewed` and `promptRedacted` are human attestations; the validator cannot detect every identifying detail or prove that consent was legally sufficient.
- Keep the consent receipt and the mapping needed to honor withdrawal outside the repository. The row contains only the receipt SHA-256, a random case key, and pseudonymous reviewer keys. Do not put the receipt, participant identity, or mapping in Git.
- Store input only under `.sft/creative-human-review/`, which is Git-ignored. Validation is local and read-only; it prints aggregate counts and the corpus hash, never examples. It does not upload, train, or promote a model.
- If consent is withdrawn, use the private receipt mapping to remove the case from source and derived splits, rerun reports, and invalidate adapters/checkpoints trained from it. Keep no raw prompt in telemetry or application logs.

## Annotation procedure

1. Two annotators independently read the consented, redacted brief without seeing model output, the other annotator's label, or a preferred candidate. They each select a `CreativeTaskOutputV1` and confidence (`high`, `medium`, `low`).
2. A third, distinct adjudicator reviews both labels. Use `consensus` only when the two structured outputs are identical; otherwise use `adjudicated` and one or more controlled reason codes. Do not write free-text rationales, chain-of-thought, or identifying notes into the JSONL.
3. The adjudicated output is the only target that a later trainer may consume. It must pass both the public output schema and current request-context safety checks. The intake validator rejects a label that changes parser-visible hard facts or violates preserve/prohibited roles.
4. If the deterministic parser materially misreads the brief, do not force an unsafe gold label through this contract. Mark the adjudication reason `parser-disagreement`, hold the case out of the current training/evaluation corpus, and fix the evidence/confidence contract first. This is a real capability gap, not an annotation disagreement to conceal.

## Decision rubric

- **`proposal`**: enough grounded information exists to make a useful, bounded proposal. Include every clearly stated hard fact and explicit preference that the current output contract can represent. Preserve and prohibited roles must be exact. Never invent tempo, key, length, energy, density, or complexity to make an answer look complete.
- **`clarify`**: a missing critical detail or unresolved conflict could materially change the result. Ask one short, answerable question about that detail. Do not smuggle a guess into `suggestions` while asking.
- **`abstain`**: the request is outside instrumental music/production interpretation or cannot be handled safely by this task contract. An underspecified but in-scope creative brief normally calls for `clarify`, not automatic abstention.
- **Unknowns**: use `unknownFields` for material information not established by the brief. Do not treat a genre stereotype or the annotator's personal taste as evidence.
- **Preferences vs. hard facts**: a soft preference may guide a proposal but cannot override an explicit requirement, protected role, project availability, or a later user correction.

Confidence guidance:

- `high`: intent and scope are direct; independent annotators should normally agree.
- `medium`: wording is colloquial or indirect, but the intended musical constraint is reasonably stable.
- `low`: multiple materially different readings remain; prefer `clarify` or `abstain` over a speculative proposal.

These labels assess interpretation only. Whether the resulting beat sounds good requires a separate blinded listening study with the actual generated candidates, a deterministic baseline, representative producers/genres, and no model identity shown during rating.

## Split and release discipline

- `family` is a scenario/paraphrase group, never a creator identity. Keep every translation, follow-up, and paraphrase from one scenario in exactly one split.
- Keep train, validation, and held-out families disjoint. The validator also rejects any family or normalized prompt already reserved by the synthetic held-out golden set.
- `train` rows carry training consent only. `validation` and `held-out` rows carry evaluation consent only; never move them into training after seeing model results.
- The validator checks format, independent reviewers, adjudication, consent metadata, split leakage, schema, and request safety. A passing report is **not** proof of representative sampling, consent authenticity, useful music, or a passing release gate.
- Pre-register evaluation questions and release thresholds after measuring the deterministic baseline. Report hard-field compliance, preserve/avoid safety, preference extraction, proposal/clarify/abstain decision quality, language, and blinded musical quality separately.

## Local row format

The JSONL format is enforced by `scripts/creative-task-human-corpus.ts`; unknown fields are rejected to prevent accidental storage of names, raw rationale, or extra source material.

```json
{
  "version": 1,
  "id": "case-0123456789abcdef0123456789abcdef",
  "family": "vocalist-dark-trap-hook",
  "split": "train",
  "language": "sk",
  "operation": "generate",
  "prompt": "<consented, redacted brief; replace this placeholder locally>",
  "consent": {
    "affirmative": true,
    "purposes": ["model-training"],
    "privacyReviewed": true,
    "promptRedacted": true,
    "includesAudio": false,
    "includesLyrics": false,
    "receiptSha256": "<64 lowercase hex characters>",
    "recordedAt": "2026-10-02T12:00:00Z"
  },
  "annotations": [
    { "reviewerKey": "reviewer-alpha", "confidence": "high", "output": { "...": "CreativeTaskOutputV1" } },
    { "reviewerKey": "reviewer-beta", "confidence": "medium", "output": { "...": "CreativeTaskOutputV1" } }
  ],
  "adjudication": {
    "reviewerKey": "reviewer-gamma",
    "resolution": "adjudicated",
    "reasonCodes": ["style-ambiguity"],
    "output": { "...": "adjudicated CreativeTaskOutputV1" }
  }
}
```

The placeholder is documentation only and is intentionally not a valid training example. The receipt hash must refer to a privately retained consent record; it does not replace that record.

## Validate locally

Create the ignored directory and place the reviewed JSONL there, then run:

```powershell
New-Item -ItemType Directory -Force .sft/creative-human-review
npm run creative-task:human-review-validate -- --input .sft/creative-human-review/reviewed.jsonl
```

The command prints only corpus/file hashes and row/family/language counts. It does not create a report file.

## Compile an isolated training input

Compilation is a separate, explicit operation. It copies only `train` and `validation` rows into a new directory under the ignored `.sft/creative-human-review/derived/` tree; `held-out` rows and their prompts/labels are omitted. Each exported row retains its split, pseudonymous case/family keys, consent purpose, consent receipt hash, and timestamp. The manifest pins source hashes and remains `eligibleForModelPromotion: false`.

```powershell
npm run creative-task:human-training-compile -- `
  --input .sft/creative-human-review/reviewed.jsonl `
  --name reviewed-run-01 `
  --confirm-training-consent
```

The compiler refuses inputs outside the private root and refuses to overwrite an existing run. It prints only the relative private output path, hashes, and counts—not examples. Training is a separate, explicit GPU operation; use a pinned model revision, keep the adapter/report under the private derived directory, and do not enable model downloads implicitly:

```powershell
npm run creative-task:sft-train -- `
  --human-reviewed-corpus-dir .sft/creative-human-review/derived/reviewed-run-01 `
  --allow-human-reviewed-training `
  --base-model <explicit-model-id-or-local-path> `
  --base-revision <pinned-revision-or-local> `
  --out-dir .sft/creative-human-review/derived/reviewed-run-01/adapter-run-01
```

The trainer verifies per-split consent purpose, row and source hashes, family separation, request safety and held-out exclusion before loading a model. It requires CUDA and explicit consent acknowledgements, never trains on `validation` or `held-out`, and does not register or promote the adapter. No real human corpus is currently present; do not run this recipe against synthetic examples.

The synthetic-only bootstrap trainer still accepts only the checked-in synthetic corpus. The explicit compiler/trainer path above is the only path for reviewed human data and it keeps the held-out split out of training artifacts.
