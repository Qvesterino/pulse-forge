# AAW frontier — supporting evidence and verification tooling

This directory is **not** one of the program's fifteen deliverables (those are in `../aaw/`). It
holds the evidence base behind them and the scripts that let a reader **re-check** the program's
claims instead of taking them on trust.

## The evidence base

| File                          | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                        | Size (measured 2026-10-26)                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `COMPETITIVE_EVIDENCE.md`     | The market evidence: sections (a) traditional DAWs, (b) AI-native generators, (c) vocal-specific AI, (d) open-source audio-AI, (e) agentic / control-plane surfaces, (f) table stakes vs genuinely rare, (g) the grade legend, (h) **what could not be verified** — 20 numbered entries, the method limitations that could have produced false negatives (including the shared GitHub API budget), and an explicit not-claimed list. | 197 lines · 105 matrix rows                                   |
| `MODEL_LANDSCAPE_EVIDENCE.md` | The model evidence: §0 the mandatory verification of the LFM 2.5 Audio candidate, §1–§7 roles A–G, §8 the comparison table, §9 cross-cutting findings, §10 **what could NOT be verified**, §11 the source index.                                                                                                                                                                                                                     | 461 lines · 143 URL mentions · §10: 18 rows · §11: 29 entries |

Both files record **what was searched**, not only what was found — an absence claim is only as good
as the query that produced it.

## The verification tooling

Run all three from the repository root. Each exits **0** when it is satisfied and **1** when it is
not, so they work as CI gates.

| Script                  | What it proves                                                                                                                                                                                | Current state (2026-10-26)                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `verify-citations.mjs`  | Every `file:line` citation in the fifteen deliverables **resolves against both repositories**: the file exists, the line range is inside it, and the cited range contains the expected token. | **263 citations · 0 problems · exit 0**               |
| `audit-path-shapes.mjs` | Every cited path has a **possible shape**: no repeated directory segment, and the file is on disk. This catches corruption the verifier's resolution could otherwise hide.                    | **271 path-shaped citations · 0 impossible · exit 0** |
| `score-model.mjs`       | The §2 scoring of the roadmap is **reproducible**: the same nine criteria, the same weights, the same four weightings, the same ranks.                                                        | **exit 0 · reproduces roadmap §2.2 row for row**      |

```bash
node docs/frontier/_research/verify-citations.mjs
node docs/frontier/_research/audit-path-shapes.mjs
node docs/frontier/_research/score-model.mjs
```

`repair-citations.mjs` holds the **measured** replacement table behind the citation repairs. It is
idempotent (a second run reports `0 replacements`) and it refuses to run when merely imported, so
it cannot rewrite the documents as a side effect of a measurement.

## Why two scripts and not one

`verify-citations.mjs` resolves a citation; `audit-path-shapes.mjs` checks its **shape**. They
were split because one defect hid inside the other: the verifier used to fall back to a _basename_
match when a path did not resolve, so `src/project-model/src/project-model/schema.ts` — a path that
cannot exist — "resolved" to `src/project-model/schema.ts` and passed. A citation that names a
path must now resolve **as that path**; only a bare filename may fall back, because a bare
filename is not a path claim.

## The rule these tools enforce

> An absence claim is worth exactly what its search token proves.

The program has now been wrong three times in the same way, and each time the search token — not
the feature — was the culprit:

1. `embedAudio` / `audioEmbedding` instead of `audio-classification` / `ast-finetuned-audioset` →
   the false claim that KYX has no audio tagging. KYX ships an AudioSet tagger.
2. `jitter` / `shimmer` instead of `vibrato` / `meanExtentCents` / `noiseFloorDb` → the false claim
   that ZYVO has no vocal-specific measurement. ZYVO ships vibrato rate and extent, breath
   candidates and a per-take noise floor.
3. `*coach*` (a filename glob) instead of `Vocal Coach` / `intonationReport` / `coachNotes` → the
   false claim that ZYVO has no coaching. ZYVO ships a Vocal Coach.

Each correction is stated **in the text** of the affected document, not silently edited. The
corrections and the residual evidence gaps are recorded in `../aaw/AAW_DECISION_LOG.md` (EG-13,
EG-14) and `../aaw/AAW_SOURCE_LEDGER.md` (S-58, S-87, S-99).
