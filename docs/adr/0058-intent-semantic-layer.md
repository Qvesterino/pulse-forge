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

## Follow-up (2026-10-21): physical calibration and the canonical contract

The first P2 pass calibrated every plugin parameter as a fraction of its range.
That is wrong for wide physical controls: `compressor.threshold` spans 60 dB, so
"much" (0.32 of range) became **19.2 dB**; attack became ~12× and cutoff ~9×.
The host's `relativeParam` already used family-specific physical steps.

Decision:

- `src/intent/semantics/calibration.ts` owns the family ladder:
  dB `0.25/0.5/0.75/1.5/2.5/4`, time and frequency proportional, Q relative,
  percent/normalized points. Degree 7 targets the declared bound. The fader and
  effect-knob anchors were shifted so a named "much" (level 5) is stronger than
  the unqualified enum default (level 4).
- `src/intent/semantics/degree-contract.ts` is the canonical word→level table.
  The 2026-10-21 alignment moved `much` 6→5, `noticeably` 5→4 and
  `quite/pretty` 5→4 to match the host contract; KYX-only words are marked as
  extensions. `npm run intent:degree-parity` compares 36 shared words against
  the VocalForge checkout and currently reports **0 divergences**.
- `plugins/mastering-suite/src/contracts/macroIntent.ts` (VocalForge) is the
  first cross-repo consumer: a bounded macro plan over the existing reversible
  `applyMasteringSuiteMacros` chain. The parser stays in the host; the plugin
  exports the contract.
- `relativeParam` moved into `@vocalforge/param-calibration` (VocalForge
  workspace package). SoloFlow Command, Agent Runtime and Agentic Vocal consume
  that one package; KYX keeps its TypeScript twin and
  `npm run intent:calibration-parity` asserts the six family ladders are
  identical (currently 0 divergences).
- Agentic Vocal now has a model-facing `adjust_parameter {parameterId,
direction, degree}` tool. `ToolSpec.resolve` receives the running
  `ToolContext.currentParams`, so relative moves compose within one plan; a
  per-action `moduleFor` applies the existing module-exclusion rule to the
  target parameter; discrete controls and values outside the agent-safe range
  are refused. The shared calibration also gained a `normalized` family for
  0..1 controls and a camel-case Q match (`eq.band1Q`), both found by this
  integration.
- The natural-language parser still lives in the host; the plugin tool is
  intentionally model-facing and the deterministic parser calls the same
  shared package.

## Deterministic tuning (2026-10-22)

- **Scoreboard.** `tests/intent-router-corpus.test.ts` now scores 276 cases
  across every param family × seven levels × both directions, fader/effect
  levels, exact operations and a negative/safety corpus. Current report:
  route/target/direction/degree/plan/safety **100 %**, 0 failures. The printed
  `INTENT_SCOREBOARD` JSON is the diffable report.
- **One target registry.** `src/intent/semantics/target-registry.ts` owns the
  family/pad/scene aliases; `conversation.ts` and `mix.ts` derive their tables
  from it. Layer-specific spellings (fader "hats" = pad, mix "hats" = drum
  family) are explicit properties, not divergent copies.
- **Quantity parser.** `src/intent/semantics/quantity.ts` distinguishes
  destinations (`to −9 dB`), movements (`by 2 dB`), factors (`half`, `twice`)
  and step counts (`one step further`); a bare number without a unit is not a
  quantity. It is wired into exact gain (explicit dB movement/destination that
  the gain regexes do not own) and into param as relative dB/percent and as a
  `scale` mode (`half the decay` = current × 0.5).
- **Ledger coverage.** `adjustment-ledger.ts` records a measured fader
  factor, effect step fraction or param range fraction. `prior-adjustment.ts`
  resolves “half that adjustment”, “a little less than last time”, “do the same
  on <target>” and “one step further” for all three.
- **Ordinal targeting.** `trackOrdinalFromText` (target registry) and
  `targetTrackIds` (target resolution) give effect/param the same “track two”
  capability as the fader: parsers carry an optional `trackOrdinal`, appliers,
  read-backs and plans resolve it through the same helper, and the ledger
  records the resolved track ids so a follow-up reuse stays on that track.
  Family and ordinal targeting cannot silently diverge.
- **Model gate.** `src/intent/model-route-gate.ts` is the final authority: a
  specific deterministic route outranks the model, a description cannot become
  a mutation, and a model mutation must produce an executable, actually-changing
  `IntentPlan`. Both the UI fallback and MCP `kyx_intent` call it.

These are audible behavior changes: "much" is now a level-5 move, the fader and
knob curves moved at levels 5/6, and plugin parameters use physical steps. The
unit tests pin ordering, bounds and exact family steps; a human listening pass
is still required before calling the magnitudes final.

## Reliability surfaces (2026-10-23)

- **MCP dry-run.** `kyx_intent { instruction, dry_run: true }` returns the
  resolved route, `IntentPlan` steps, clamps and warnings without executing or
  consulting the model. The mirrors are regenerated from `src/mcp/tools.ts`.
- **Support matrix.** `src/intent/semantics/support-matrix.ts` classifies every
  route kind into generation/editing/mastering and derives parameter rows from
  `buildCapabilityMatrix()`. A new route kind is a compile-time error until its
  domain is stated; a family that is not in the registry cannot appear.
- **Long-tail corpus.** The router corpus now includes editing/mastering asks
  that must not fall into pattern generation, generation briefs that must, and
  negative/unsupported references that must never mutate. It is curated from
  documented product phrases, not telemetry (no telemetry exists in this repo).
- **Mastering verification.** `src/intent/mastering-verification.ts` snapshots
  LUFS, crest, low-end share and stereo correlation from the same Mix Doctor
  report, and the loudness verify loop records before/after plus a verification
  line. This measures what changed beyond loudness; a human A/B is still the
  final gate for tonal quality.
- **Section-relative references.** “same as the chorus”, “quieter than the
  drop” name a time range while the mix layer addresses whole tracks. They
  decline with `scene-reference` instead of silently changing the whole song;
  the support matrix marks them `clarify-only`.

## Consequences

- Adding a parameter family is one registry entry; parser, matrix, corpus and
  readback metric follow. The corpus runs **from** the matrix.
- A new route kind cannot silently skip ledger invalidation or precedence
  classification.
- The UI can explain a fader/effect/exact ask before it lands, not only a named
  knob.
- No schema or persistence change. The ledger is session-only and now records
  fader, effect and param relative moves; an ordinal track target remains a
  fader-only capability.
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
- `src/intent/semantics/target-registry.ts`, `src/intent/semantics/target-resolution.ts`,
  `src/intent/semantics/quantity.ts`, `src/intent/semantics/support-matrix.ts`
- `src/intent/mastering-verification.ts`
- `src/intent/apply-boundary.ts`, `src/intent/route-precedence.ts`,
  `src/intent/command-for-route.ts`, `src/intent/model-route-gate.ts`
- `tests/param-intent.test.ts`, `tests/param-readback.test.ts`,
  `tests/intent-router-corpus.test.ts`, `tests/intent-conversation-memory.test.ts`,
  `tests/ui/IntentPanel.test.tsx`
- `scripts/check-intent-degree-parity.mjs`, `scripts/check-intent-calibration-parity.mjs`
- VocalForge: `packages/param-calibration`, `plugins/agentic-vocal/src/agent/toolRegistry.ts`,
  `plugins/agentic-vocal/tests/tools.test.ts`
