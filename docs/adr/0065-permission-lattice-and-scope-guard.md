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

1. A write whose **declared revision** the document has left behind is **forbidden**. This is
   checked _before_ consent, because consent given for one document is not consent for another.
2. An **external** agent's mutating or destructive call **confirms** unless the user granted
   standing consent.
3. Everything else is **auto** — `read` and `runtime` do not change the document.

### The D4 destructive lock is NOT a lattice rule — and why

The first draft of this ADR put "a locked destructive call is forbidden" at the top of the table. It
was **removed during implementation**, and the removal is recorded here rather than quietly edited
away.

The destructive lock already exists, and it is **better** where it is: at each destructive _site_
inside the tool, as `ctx.allowDestructive?.() !== true`. Three properties made the central copy
actively worse:

- **It is per-operation, not per-tool.** `effectiveRisk()` classifies a whole TOOL, so a tool that
  also has a safe operation (add a marker, remove a marker) is not wholly destructive. A central
  gate refused the safe operation too.
- **It runs after the tool validates its arguments.** A central gate fired first, so a malformed
  request came back as `POLICY_REFUSED` instead of `INVALID_ARGUMENTS` — a malformed request
  stopped being reported as malformed.
- **It carries the auto-checkpoint side effect** and the pinned refusal sentence that the MCP
  panel quotes.

Measured, not assumed: the central rule broke **64 tests** across the MCP suite. The lattice now
owns only what only it can own — the external-transport consent and the revision check.

### The consent is read from the CONTEXT, not from `localStorage`

The first implementation read `pf:mcp-allow-mutations` straight out of `localStorage`. That was
**wrong**, and the suite said so: the pre-existing destructive gate is **context-injected**
(`ctx.allowDestructive?.()`), and hosts and tests override it. A lattice reading the persisted flag
behind the context's back creates **two sources of truth for one consent** — and refused calls the
host had explicitly unlocked.

The consent is now read from the context (`ctx.allowMutations?.()`), with the persisted flag as the
**fallback** when the context does not answer. `tests/permission-lattice.test.ts` pins both
directions: the context can grant what the flag refuses, and the flag applies when the context is
silent.

### Attribution is not trust

`agentId` is an **audit label** ("who did this"), and the lattice needs a **trust answer** ("may
this change the document without asking?"). The two coincide on the shipped surfaces but not in
the harness:

- The **web relay** (`bridge.ts`, agentId `web-relay`) and the **desktop stdio server**
  (`desktop-host.ts`, agentId `desktop-stdio`) are network-reachable → **gated by default**.
- The **headless host** (`headless-host.ts`) is an **in-process harness** — `docs/AGENT-KIT.md`
  lists it under "tests, tooling", and ADR 0046 made it the evaluation workhorse. Nothing reaches
  it from outside the process, so its `allowMutations` **defaults to on** and a test opts out with
  `allowMutations: false` to exercise the refusal path. Gating it as "external" would have made
  the harness unable to evaluate the thing it exists to evaluate.
- The **human in the app** (the intent bar, the panels) carries **no** agent id → never gated.

### The consent has a switch, or it is unreachable

A standing flag with no UI is a flag nobody can set, and an external client that can never change
the project is a relay that does nothing. The MCP chip therefore carries a second switch next to
the existing `MAZANIE` toggle:

- `🔒 ZMENY` / `🔓 ZMENY` — "an external agent may change this project".

It is a **separate** switch from `MAZANIE` on purpose: an external client may legitimately be
connected to **read** the project (an analysis agent, a monitor) without being allowed to rewrite
it. Both are read live, so flipping one takes effect immediately.

`decidePermission()` is pure: same inputs, same decision, always. That is what makes the whole
trust table testable without a store, a DOM, or a model.

### 2. The transport split — the one decision that matters

An agent arriving over a **transport** is **not** the person sitting in the app. So:

- **`local`** (the human in the UI, or a test): mutating calls stay `auto`. The in-app intent flow
  already previews and applies through the human's own hands.
- **external** (`web-relay`, `desktop-stdio`, `qmr`): mutating calls need the user's standing
  consent, **OFF by default** (`pf:mcp-allow-mutations`, read live on every call — flipping it takes
  effect immediately). The headless host is deliberately **not** in this list — see "Attribution is
  not trust" above.

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

- 21 mutating tools stop being able to rewrite a project without consent, on the two surfaces that
  are reachable from outside the app (the web relay, the desktop stdio server).
- The consent is **reachable**: the MCP chip carries the `🔒 ZMENY` / `🔓 ZMENY` switch. A standing
  flag with no UI would have made the whole guarantee hollow.
- Every decision is auditable: the refusal is returned as a typed error (`POLICY_REFUSED`,
  `CONFIRMATION_REQUIRED`) and written to the agent audit log with its reason.
- The scope guard composes with F-25 instead of replacing it: _was the field I write about to
  change under me?_ and _am I allowed to write it at all?_ are different questions.
- The revision counter is the substrate every future "your plan is stale" claim stands on.

**Honest gaps — recorded, not hidden.**

1. **A standing consent is weaker than a per-call approval.** ZYVO's external surface asks every
   time; KYX asks once, via a switch. The per-call approval UI does not exist in KYX yet. This is
   the strongest available improvement over the old behaviour and it is still not the best one.
2. **The revision is in memory.** It resets on reload. Documented as an open decision, not
   pretended away.
3. **The scope guard can only judge commands that carry `ops`.** A hand-written command is not
   verifiable, and the guard says so.
4. **The post-write verifier is a primitive, not yet a product surface.** `verifyScope()` exists and
   is tested; wiring it into the result read-back is the next increment.
5. **The lattice does not enforce the D4 destructive lock.** That lock stays in the tool layer,
   where it is per-operation and runs after argument validation. The consequence is that a future
   destructive tool that forgets the per-site check would not be caught by the lattice. The registry
   metadata (P-3) is what would close that.

## Alternatives considered and rejected

| Alternative                                                    | Why rejected                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A per-call approval UI** (ZYVO-style)                        | The right end state — but it needs a proposal surface KYX does not have. The standing consent is the reachable version of it; the ADR records the gap rather than pretending it is closed.                                                                                                                  |
| **A second risk taxonomy** for the lattice                     | The codebase already publishes `ToolRisk` through the MCP-standard annotations. Two vocabularies = two truths, and an agent would have to learn which one a tool used.                                                                                                                                      |
| **A revision field inside the project document** (schema bump) | Semantically cleaner and persistent. Rejected _for now_ because it is a schema migration with a far bigger blast radius than an in-memory counter, and the proposal that would use it does not survive a reload either. Revisit when plans become persisted (ADR 0065's sibling decision on storing plans). |
| **Refusing every external mutation outright**                  | It would break every agent client with no product value and no safety gain over the standing consent — the destructive class was already refused.                                                                                                                                                           |
| **Implementing the lattice as a model prompt**                 | A model must never decide permissions. The lattice is a rule table precisely so that no model can raise its own autonomy.                                                                                                                                                                                   |

## Verification

- `tests/permission-lattice.test.ts` — **35 tests**: the decision table (including "a stale
  revision is refused _before_ consent is considered"), the transport split, the revision
  counter's movement rules (a no-op command must not bump it; undo must), the scope guard's
  three verdicts, and two write-path tests that pin the two boundaries this ADR got wrong the
  first time — the lattice does not pre-empt the tool's own destructive gate, and an external
  agent without consent is refused with `CONFIRMATION_REQUIRED`.
- `npx vitest run tests/mcp tests/agent-trust.test.ts tests/koren-catalog.test.ts` — **632 passed,
  3 failed**. None of the three is this ADR's:
  - `mcp-edit-parity` asserts a refusal sentence that a parallel session changed in commit
    `0ffa24f4` — the mismatch is in the **committed** tree, before this work;
  - `mcp-relay-session-ownership` trips a parallel session's `server/mcp-core.mjs` output-schema
    work;
  - `agent-trust`'s "audits reads without starting a session" is a **full-suite ordering flake** —
    the file passes **15/15** on its own, and in isolation with `-t`.

  **Before** this ADR's design was corrected, the same run failed **64** tests.

- `npx tsc --noEmit` — the only two errors in the whole tree are in `tests/struna/engine.test.ts`
  (a parallel session's file). **Zero** errors in any file this ADR touches.
- The lattice is wired at `executeMcpToolCore` (`src/mcp/tools.ts`), the scope guard wraps the
  stale-write guard at the dispatch, and the revision is exposed on every live MCP context
  (browser relay, desktop stdio, QMR, headless).
- `tests/mcp-web-host.test.ts` — the relay round-trip still works **with** the consent granted, and
  a new test pins that **without** it the relay may not change the project.
- `src/ui/IntentPanel.tsx` — the MCP chip carries the `🔒 ZMENY` / `🔓 ZMENY` switch, so the
  standing consent is reachable by a user and not only by a persisted flag.

**Not verified here:** no end-to-end run against a live relay with a real external client was
performed, and no per-call approval UI exists to test. The standing-consent path is covered by unit
tests and by the audit entry it writes.
