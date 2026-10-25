# ADR 0065 — The permission lattice decides, and the scope guard keeps the write inside it

Date: 2026-10-25 · Status: Accepted (shipped) · Scope: MCP trust layer, project store, agent control surface

## Context

The AAW frontier program (`docs/frontier/aaw/`, 2026-10-25) audited both products in source and
found the trust gap in numbers rather than in theory:

- KYX exposes **39 MCP tools**: **3 read · 8 runtime · 21 mutate · 7 destructive**.
- Only the **7 destructive** ones were gated, behind one standing user flag
  (`pf:mcp-allow-destructive`, default OFF).
- The other **21 mutating tools ran with no consent of any kind**. The mitigations around them —
  a session checkpoint, an audit log, an undo frame, a read-back — are **recovery** mechanisms,
  not **consent** mechanisms.

The root cause is one sentence long: **the trust layer classifies but never decides.**
`effectiveRisk()` answers "how dangerous is this call?" and then nothing acts on the answer.

Two neighbouring pieces of work made the fix cheap:

- **F-25 (`src/mcp/write-conflict.ts`)** already solved the _stale write_ problem — per field, using
  the command's own `base` (the document it was computed against) and `ops` (the paths it writes).
- **ZYVO** already learned the transport lesson the hard way: its external MCP surface is
  **draft-only**, autonomy is not forwarded across the stdio boundary, and acceptance is a UI click.

And one piece of work made it _possible_: **the document carried no revision counter.** F-25's own
commit message says so — _"the document has no revision counter and no conflict signal."_ A
permission lattice that can say "your plan was computed against a document that no longer exists"
needs a revision to compare against.

## Decision

### 1. A permission lattice — a pure, total, ordered decision function

`src/mcp/permissionLattice.ts`. Three decisions, one vocabulary:

```
auto     — apply it
confirm  — the user must say yes
forbid   — do not apply it, and say why
```

The risk vocabulary is **reused, not reinvented**: `ToolRisk` (`read | runtime | mutate |
destructive`) already ships in `src/mcp/agentTrust.ts` and already feeds the MCP-standard
`annotations` block. A second taxonomy would be a second truth.

The rules, in order:

1. A locked destructive call is **forbidden** — never merely prompted.
2. A write whose **declared revision** the document has left behind is **forbidden**. This is
   checked _before_ consent, because consent given for one document is not consent for another.
3. An **external** agent's mutating call **confirms** unless the user granted standing consent.
4. Everything else is **auto** — `read` and `runtime` do not change the document.

`decidePermission()` is pure: same inputs, same decision, always. That is what makes the whole
trust table testable without a store, a DOM, or a model.

### 2. The transport split — the one decision that matters

An agent arriving over a transport (`web-relay`, `desktop-stdio`, `qmr`, `headless`) is **not** the
person sitting in the app. So:

- **`local`** (the human in the UI, or a test): mutating calls stay `auto`. The in-app intent flow
  already previews and applies through the human's own hands.
- **external**: mutating calls need the user's standing consent, **OFF by default**
  (`pf:mcp-allow-mutations`, read live on every call — flipping it takes effect immediately).

This is KYX adopting ZYVO's posture. It is strictly stronger than the old behaviour: 21 tools that
could rewrite a project unasked now cannot.

### 3. A document revision — counted where the document changes

`ProjectStore` gains `revision_`, exposed as `getRevision()`. It moves in **one place**:
`afterMutation()`, the single choke point every applied change passes through (apply, undo, redo,
history jump). A command that changes nothing (`applied === this.doc_`) returns before that point
and therefore **does not** bump the revision.

The revision is **in memory** by design and says so: a proposal does not survive a reload either, so
a counter that reset with the process cannot create a false "fresh" claim. `McpToolContext.getRevision`
is **optional** — a transport that cannot report one gets `null`, and the lattice then **skips** the
staleness rule rather than inventing a revision.

### 4. A scope guard — checked at the moment the write lands

`src/mcp/scope-guard.ts`. A caller may declare, in the call envelope, what the write may touch
(`scope.allow`) and what it must not touch (`scope.protect`).

The guard checks the command's **own words** — its `ops` — at the same instant the stale-write
guard does, because that is the only place where the document the write would land on is known
exactly. It refuses two things **before** anything is written: a path outside the allowed scope,
and a protected path.

`verifyScope()` is the after-the-fact half: it compares `base → after` and can catch a protected
path that changed _indirectly_, which the pre-write check cannot see. It reports `verifiable: false`
when the command carries no paths — a hand-written `execute`/`undo` pair has no `ops`, and saying
so honestly is better than passing silently.

### 5. Dry-runs are exempt

A dry-run mutates nothing. It is **how** an agent asks "what would this do?" — so the refusal
belongs to the write, not to the preview. A dry-run therefore passes the lattice and reaches the
sandbox; the real call is the one that needs consent.

## Consequences

**Good.**

- 21 mutating tools stop being able to rewrite a project without consent.
- Every decision is auditable: the refusal is returned as a typed error (`POLICY_REFUSED`,
  `CONFIRMATION_REQUIRED`) and written to the agent audit log with its reason.
- The scope guard composes with F-25 instead of replacing it: _was the field I write about to
  change under me?_ and _am I allowed to write it at all?_ are different questions.
- The revision counter is the substrate every future "your plan is stale" claim stands on.

**Honest gaps — recorded, not hidden.**

1. **A standing consent is weaker than a per-call approval.** ZYVO's external surface asks every
   time; KYX asks once, via a flag. The per-call approval UI does not exist in KYX yet. This is
   the strongest available improvement over the old behaviour and it is still not the best one.
2. **The revision is in memory.** It resets on reload. Documented as an open decision, not
   pretended away.
3. **The scope guard can only judge commands that carry `ops`.** A hand-written command is not
   verifiable, and the guard says so.
4. **The post-write verifier is a primitive, not yet a product surface.** `verifyScope()` exists and
   is tested; wiring it into the result read-back is the next increment.

## Alternatives considered and rejected

| Alternative                                                    | Why rejected                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A per-call approval UI** (ZYVO-style)                        | The right end state — but it needs a proposal surface KYX does not have. The standing consent is the reachable version of it; the ADR records the gap rather than pretending it is closed.                                                                                                                  |
| **A second risk taxonomy** for the lattice                     | The codebase already publishes `ToolRisk` through the MCP-standard annotations. Two vocabularies = two truths, and an agent would have to learn which one a tool used.                                                                                                                                      |
| **A revision field inside the project document** (schema bump) | Semantically cleaner and persistent. Rejected _for now_ because it is a schema migration with a far bigger blast radius than an in-memory counter, and the proposal that would use it does not survive a reload either. Revisit when plans become persisted (ADR 0065's sibling decision on storing plans). |
| **Refusing every external mutation outright**                  | It would break every agent client with no product value and no safety gain over the standing consent — the destructive class was already refused.                                                                                                                                                           |
| **Implementing the lattice as a model prompt**                 | A model must never decide permissions. The lattice is a rule table precisely so that no model can raise its own autonomy.                                                                                                                                                                                   |

## Verification

- `tests/permission-lattice.test.ts` — **29 tests**: the decision table (including "a stale
  revision is refused _before_ consent is considered"), the transport split, the revision
  counter's movement rules (a no-op command must not bump it; undo must), and the scope guard's
  three verdicts.
- `npx tsc --noEmit` — clean for every file this ADR touches.
- The lattice is wired at `executeMcpToolCore` (`src/mcp/tools.ts`), the scope guard wraps the
  stale-write guard at the dispatch, and the revision is exposed on every live MCP context
  (browser relay, desktop stdio, QMR, headless).

**Not verified here:** no end-to-end run against a live relay with a real external client was
performed, and no per-call approval UI exists to test. The standing-consent path is covered by unit
tests and by the audit entry it writes.
