# ADR 0031 — Blind online comparison of global and personal ranking

Date: 2026-10-07 · Status: Accepted · Scope: Producer DNA pilot protocol

## Context

Ordinary A/B feedback teaches a preference, but it does not isolate whether the
personal selector beats the global selector. Showing the ranked candidate bank
before a choice can also reveal which take each selector favored. A pilot needs
to compare both policies on the same generated candidates, hide their identity,
and preserve the scores that were available before the user chose.

## Decision

1. The user explicitly arms the next pattern generation before it starts. The
   current bank stays an ordinary visible result; only the next fresh bank can
   enter the pilot.
2. Candidate selection is restricted to one shared bank and one global
   selector version. Both selectors must have a unique top candidate, and
   their top choices must be different. No hidden candidate is rendered and no
   extra generation is run.
3. Side assignment uses crypto.getRandomValues. If secure random assignment
   is unavailable, or the score winners are tied, the app records no pilot
   observation and returns the bank to its ordinary view.
4. Before the choice, the ranked bank, candidate indices, source labels,
   selector scores and optional preference-reason picker stay hidden. After a
   response, the source labels remain hidden until a new generation replaces
   that bank. A, B, neither and both retain their existing meanings.
5. A pilot observation is tagged
   study: "producer-dna-blind-pilot" in the local preference ledger. It keeps
   the exact global and personal scores, selector version, feature vectors and
   rendered-audio summaries already allowed by the ledger. Raw audio and
   prompts are not added. The user's directional response remains ordinary
   local training evidence.
6. The evaluator reports pilot-only captured-score accuracy and paired lift,
   overall and by task, on its existing chronological session/lineage/candidate
   holdout. It also reports original global-side assignment, displayed-side
   responses, and whether a directional response favored the global or personal
   pick. Pilot rows with neither or both are not directional accuracy labels.
   The report measures ranking among the shared generated bank; it does not
   claim that the candidate generator itself improved.
7. Pilot observations remain local and are included in the user's ordinary
   Producer DNA export, import and delete controls. No telemetry or remote
   submission is introduced.

## Consequences

- A pilot choice directly compares the user's preference with the two saved
  selector scores, so the evaluator can measure the deployed online decision
  without reconstructing it from later feedback.
- Randomization and hiding prevent the UI from naming the source before the
  user responds. They do not establish population-level proof on their own.
- The opt-in comparison UI is implementable without a project schema
  migration. The ledger's optional study tag is backward-compatible with
  existing preference records.
- A real-user pilot, adequate independent sessions, grouped uncertainty and a
  positive held-out result are still required before making a quality claim or
  widening personal search.
