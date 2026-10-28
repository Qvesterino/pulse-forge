# Selected-section review benchmark v1

**Status:** prepared, not preregistered or run
**Purpose:** measure whether the read-only single-agent workflow produces more useful, better-grounded production notes than a manual review. This protocol does not evaluate audio preference and does not authorize a reviewer agent or project edits.

## Comparison

Compare two conditions on the same frozen task packet:

1. **Manual:** a producer reviews the packet and writes up to three findings.
2. **Single agent:** one agent receives the same packet and the same three-finding contract.

Do not add a reviewer-agent condition in v1. Consider it only after a baseline variance estimate and a separate preregistration. The two conditions must use the same task brief, protected elements, evidence IDs, project revision, and selected tick range. A changed snapshot invalidates the pair.

## Task packet

Build a small, local-only fixture set across arrangement transitions, kick/bass interaction, and vocal placement. Each fixture records:

- A fixture ID and SHA-256 digest of the frozen project document.
- The project revision and MusicalContextSnapshot v1 digest.
- The selected start/end ticks, task goal, and protected elements.
- The exact evidence packet available to both conditions, including its coverage and freshness.
- A deterministic render receipt when the task requests audio-derived evidence.

Keep projects, rendered audio, full notes, and identity mappings outside Git. Store only anonymized IDs and approved aggregate results in the repository. Any provider that receives project data needs separate consent recorded before preregistration; audio and lyrics require their own consent.

Before preparing scored fixtures, run `npm run musical-context:smoke`. It checks the MusicalContext v1 parser and snapshot builder without rendering audio. It does not exercise the MCP transport, and a pass is not evidence of musical accuracy or listening quality.

## Budget and procedure

Before collecting results, fill the study template with the fixture digests, a shared wall-clock cap per task, agent token/provider caps, rater count, planned sample size, and the minimum useful rating difference. Estimate the rating variance in a pilot first; then preregister the final sample size and thresholds before the scored run.

For every fixture, run both conditions against the frozen packet. The agent may call read-only KYX tools and may not mutate the project. Record elapsed time, token/provider use where available, tool calls, renders, refusals, stale stops, and any attempted or landed mutation. Automated checks verify evidence references, target/range references, budget compliance, and zero document changes.

Assign each result a random blind ID. A rater who did not conduct the run scores the anonymized notes in randomized order without seeing the condition or model identity. Use 1–5 scores for evidence grounding, musical relevance, respect for protected elements, and actionability. Count unsupported claims separately; a high style or confidence score cannot compensate for an unsupported claim.

## Audio outcome

This first phase evaluates notes only. It cannot establish that a suggested mix change sounds better. A later audio phase must render approved variants from the same frozen project, level-match them with KYX's shared helper, randomize side assignment, hide the source mapping until ratings are recorded, and collect listener preference separately from ABX discrimination. Do not substitute `kyx_blind_ab`'s ABX correctness score for preference: it measures whether a listener can distinguish A from B.

## Report and stop rules

Report per-condition score distributions and paired differences with uncertainty intervals, unsupported-claim counts, constraint violations, stale stops, mutation count, time, tokens, provider cost, render count, and failures. Keep musical ratings separate from deterministic tool checks.

Do not claim a winner if the preregistration is incomplete, the paired evidence digests differ, a condition exceeds its budget, a rater is unblinded, or the sample is underpowered. Stop a task on stale context, missing route/automation evidence, timeout, malformed evidence references, or any mutation. If results are neutral or uncertain, retain the single-agent workflow and improve evidence before considering more agents.
