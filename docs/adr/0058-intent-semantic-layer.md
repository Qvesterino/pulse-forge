# ADR 0058 — Intent is a semantic layer: one registry, one plan, one mutation boundary

Date: 2026-10-21 · Status: Accepted (steps 1–3 shipped) · Scope: intent engine, UI IntentPanel, MCP `kyx_intent`, parameter calibration, prior-adjustment memory

## Context

Intent is the DAW's primary interface: the producer says what they want, and
the engine must resolve a target, a direction, a magnitude and a unit, then
execute through the command layer and verify the result. The engine grew by
accretion: fader vocabulary in `conversation.ts`, effect vocabulary in `mix.ts`,
parameter roles in `param-intent.ts`, bounds and taper in `effects/definitions.ts`,
measurement choice in `param-readback.ts`, and ledger invalidation in every UI
and MCP call site. Each layer worked; the seams did not.

Three failures were measured, not hypothetical:

- **Wrong target**: “much faster compressor attack on the drums” changed the
  **tempo**; “lower filter cutoff on the lead” moved the **lead fader**. The
  param parser ran after fader/tempo.
- **Wrong magnitude**: “really slightly quieter” resolved to level 6 (×0.70)
  because the intensifier won the distance scan; “even less reverb on the bass”
  moved the bass fader because the fader ran before the effect parser.
- **Stale memory**: “half that adjustment” could point at a move that an undo,
  a project switch or an unrelated mutation had already superseded, because
  six call sites each remembered to clear the ledger.

The corpus has grown large enough to make these regressions cheap to catch, but
only if the knowledge has one home and the contracts are executable.

## Decision

### 1. One parameter registry, derived views

`src/intent/semantics/param-registry.ts` is the declarative source for
role → effect × knob, direction vocabulary, calibration domain, audibility
metric and evidence status. The parser's `PARAM_ROLES` table, the capability
matrix and the corpus examples are **derived** from it. The `ParamDef` remains
the owner of bounds/taper/unit; the matrix reads it and does not duplicate it.

`primary: EFFECT_KNOB[effect] === paramId` marks knobs the effect layer already
owns (“more reverb” = `reverb.mix`); the param parser deliberately skips them,
and the matrix reports `exposedBy: "effect"` rather than pretending the param
layer handles everything.

### 2. One mutation boundary, exhaustive by type

`src/intent/apply-boundary.ts` classifies **every** `RoutedIntent["kind"]` as
`fader | effect | param | other | none`. The UI calls `noteAppliedRoute` once in
its `finally` (only when the document identity changed); MCP calls it once after
`ctx.execute`. Undo/redo and non-intent mutations have explicit entry points.
Adding a route kind is a compile error until its ledger effect is declared.
Only the boundary may import the recorder; a source test enforces it.

### 3. One precedence contract

`src/intent/route-precedence.ts` names the stages and the order. The router
still executes a manual chain (a big-bang rewrite is not justified), but the
contract is pinned by:

- a corpus of ambiguous winners,
- a source-order guard for the bug-prone pairs (param < fader/tempo, compound <
  exact, exact < fader, descriptive < param, clarification < pattern),
- a completeness test that every route kind appears in the table.

### 4. One dry-runnable plan built from the execution path

`src/intent/command-for-route.ts` is the single route → canonical command map
(shared by MCP and the plan). `src/intent/semantics/intent-plan.ts` builds the
same command, runs it against the document **value** (commands are snapshots)
and describes the diff: target, parameter, current, proposed, clamped value,
domain, add/remove, warnings. The UI shows the plan while typing, before
execution; the same function can back an MCP dry-run.

The plan is deliberately not a second calculator. A preview that recomputes a
delta can disagree with execution; a plan that executes the command on a value
cannot.

## Consequences

- Adding a parameter family is one registry entry; parser, matrix, corpus and
  readback metric follow. The corpus runs **from** the matrix.
- A new route kind cannot silently skip ledger invalidation or precedence
  classification.
- The UI can explain a fader/effect/exact ask before it lands, not only a named
  knob.
- No schema, persistence or dependency change. The ledger remains session-only
  and fader-only; effect/param prior references still decline honestly.
- The plan does not cover lanes that need app services (generation, loudness
  measure/trim, mix-profile audition). `executable: false` states that; it is
  not a silent fallback.
- The precedence table documents the chain but does not drive it yet. The
  source-order guard is intentionally a text guard; the next refactor can replace
  the chain with stage functions and keep the corpus.

## Alternatives considered

- **Rewrite the router as a stage table now.** Rejected: 1 800+ intent tests
  pin behavior, and the contract can be established without a risky rewrite.
- **A separate preview calculator per family.** Rejected: it would drift from
  execution; the plan must be derived from the command.
- **Record every operation in the ledger.** Rejected for this slice: a fader
  factor is the one measured number that can be replayed and halved without a
  second vocabulary. Effect/param replay needs its own measured record.
- **Numeric confidence scores.** Rejected: there is no calibrated model behind
  them. The plan states ambiguity, clamps and warnings instead.

## References

- `src/intent/semantics/param-registry.ts`, `src/intent/semantics/intent-plan.ts`
- `src/intent/apply-boundary.ts`, `src/intent/route-precedence.ts`,
  `src/intent/command-for-route.ts`
- `tests/param-intent.test.ts`, `tests/param-readback.test.ts`,
  `tests/intent-router-corpus.test.ts`, `tests/intent-conversation-memory.test.ts`,
  `tests/ui/IntentPanel.test.tsx`
