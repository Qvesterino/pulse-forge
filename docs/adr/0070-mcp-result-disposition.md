# ADR 0070 — A result that changed nothing says what it is

Date: 2026-10-27 · Status: Accepted (shipped) · Scope: MCP surface, R-02 verification gate

## Context

The audit (F-05, `STATE_DIVERGENCE_HUNTER_REPORT.md`) measured a hole in the new R-02 gate
(`src/mcp/verified-mutation.ts`): the gate starts with

```ts
if (result.mutated !== true || result.isError === true) return result;
```

so it can correct a **false success** but it cannot correct a **missing error signal** — a refusal
is by construction `mutated: false`, and the gate returns before it ever looks. The report measured
**one** handler (`executeAutomationTool`) whose refusals came back as prose with no `isError`, and
prescribed: route them through the existing `mcpError(code, text)` constructor, and add a meta-test.

**Re-measured against the tree of 2026-10-27, the population is six times larger than the report
found.** An AST scan of every `return` in `src/mcp/tools.ts` (not a regex — the TypeScript compiler
API, so a shorthand property or a computed text is seen, not guessed):

| measure                                                                           | count       |
| --------------------------------------------------------------------------------- | ----------- |
| results that changed no document and declared **neither** `isError` nor a `stage` | **191**     |
| …spread over                                                                      | 25 handlers |
| refusals among them (typed through `mcpError`)                                    | 78          |
| legitimate no-ops / non-document facts among them                                 | 96          |
| results whose `mutated` is a **variable** (invisible to a static scan)            | 22          |

Two things made this worse than "the automation handler is untyped":

1. **The dispatch guessed.** When a result carried no `stage`, the dispatch inferred one from the
   **tool name** (`src/mcp/tools.ts`: `result.mutated === true ? "applied" : RUNTIME_STAGE_TOOLS.has(name) ? "runtime" : "read"`).
   A refusal that declined to speak was therefore handed to the agent **as a successful read** — not
   merely untyped, but actively mislabelled.
2. **The existing gate could not see it.** `tests/mcp-error-codes.test.ts` counts `isError: true`
   **literals** and requires each to carry an `errorCode`. A refusal that is not an error at all is
   invisible to that count — F-05 is the missing complementary half of a gate that already exists.

One more hole surfaced while measuring: `kyx_mix_idea` returned `isError: apply` — a **dynamic**
flag. When `apply` was true the result was an error **without an `errorCode`**, escaping the existing
gate a second way.

## Decision

**A result that did not change the document declares its disposition.** One rule, three shapes:

| shape         | envelope                                                             | meaning                                  |
| ------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| **refusal**   | `isError: true` + `errorCode` (from the closed taxonomy)             | the call did not happen; fix the call    |
| **no-op**     | `stage: "noop"`                                                      | it ran, and nothing changed              |
| **side fact** | `stage: "read" / "runtime" / "persisted" / "rendered" / "delivered"` | it ran, and produced a non-document fact |

A result that declares **none** of these is an untyped refusal — and it must not reach an agent
looking like a success.

### 1. The handlers declare it (the migration)

Every one of the 191 sites was migrated: 78 refusals now go through the existing `mcpError(code,
text)` constructor with a code from the closed `McpErrorCode` set; 96 results carry an explicit
`stage`; the 22 dynamic ones carry a stage **expression** (`mutated ? "applied" : "noop"`), because
their outcome is only known at runtime. Two cases were corrected by hand rather than mechanically:

- `kyx_mix_idea` — a rejected plan is now `mcpError("EXECUTION_FAILED", …)` when the caller asked to
  apply it, and a `stage: "dry-run"` proposal when it did not. The dynamic `isError: apply` is gone.
- `kyx_automation` — the duplicate-point branch (`stage: "noop"`) and the **failure** branch (the
  command ran and the point is not in the lane) used to carry the **same text**, so a failure read as
  a duplicate. The failure branch is now `mcpError("EXECUTION_FAILED", …)` with its own text.

### 2. The dispatch is the perimeter

After the handler returns, a result that changed no document and declares no disposition is named as
what it is — a failure with a code, not a read:

```ts
if (result.isError !== true && result.mutated === false && result.stage == null && documentMutation) {
  result = mcpError("EXECUTION_FAILED", result.text, result.data !== undefined ? { data: result.data } : undefined);
}
```

The handler's own `data` rides along: a refusal that lost the handler's read-back would be a second,
quieter divergence.

### 3. The source is the gate

`tests/mcp-refusal-taxonomy.test.ts` scans every `src/mcp/*.ts` file with the TypeScript compiler
API and fails when a result that changed no document declares neither `isError` nor a `stage`. It
also asserts that every `mcpError(…)` call uses a code from the closed taxonomy. The gate is the
complementary half of `tests/mcp-error-codes.test.ts`: that one counts the errors, this one counts
the **non-errors that failed to declare themselves**.

## Consequences

- **The receipt vocabulary follows the envelope.** `normalizeReceiptResult` derives `data.status`
  and `data.stage` from `result.stage`, so a declared disposition also reaches the structured
  content. That is the point — the receipt and the envelope can no longer disagree — but it means a
  receipt's stage is only as good as the handler's declaration. Where the repository already pins a
  receipt stage (`kyx_checkpoint` save → `"read"`, pinned in `tests/mcp-ai-control-hardening`), the
  declaration follows the pin: a checkpoint is session state, not a document change.
- **The texts did not change.** Every refusal still explains itself in prose; the code is added
  **beside** the reason, never instead of it. The taxonomy stays closed — no new code was invented,
  the existing eleven cover every migrated refusal.
- **The R-02 gate is unchanged in what it corrects.** It still corrects false successes; it now
  also carries an explicit disposition (`stage: result.stage ?? "noop"`) when it rewrites a result.
- **This is a behaviour change on the wire.** A refusal that used to arrive as
  `{ mutated: false }` now arrives as `{ isError: true, errorCode: "…" }`. That is the fix — but a
  client that treated "no `isError`" as success will now see a failure, which is the point of the
  change and the reason it is called out here.

## Alternatives rejected

- **Let the dispatch guess the disposition from the tool name (status quo).** Rejected: it is what
  mislabelled 191 refusals as reads, and it cannot distinguish a refusal from a no-op at all.
- **Add a generic `UNCLASSIFIED_REFUSAL` code and convert every untyped result at the boundary.**
  Rejected: it would hide the reason the agent needs (a stale id and a missing capability need
  different recoveries), and it would have converted legitimate no-ops into errors.
- **Change `execute` to return a revision and compare revisions (the F-26 repair).** Not this ADR —
  that is a different seam (S-1 gap 4) and it does not make a refusal visible.
