# DAW AGENT CONTROL ROADMAP — KYX

**Audit date:** 2026-10-13 · **Target:** KYX (`pulse-forge`) · **Revision:** `31cc20ad`
**Status:** P0-A, P0-B, P0-C, **P1-A**, **P1-B**, P1-C, **P1-D (S-scope; UNKNOWN resolved)**, P1-E, **P2-A (parity sweep)** and **P2-B** **IMPLEMENTED + VERIFIED 2026-10-13** — see `IMPL-2026-10-13-P0-P1.md` in this directory for changed files, test evidence and residual risks. All other items remain proposals.

Complexity is expressed as **relative size** (S / M / L), not calendar time — this audit has no basis for time estimates and inventing them would be false precision.

---

## Dependency graph

```
P0-A  Narrow the fail-open catch-all ──┐
P0-B  Widen export vocabulary ─────────┼──► P1-A  Document-derived target resolution
P0-C  Regression tests (P0-A/B) ───────┘         │
                                                ├──► P2-A  MCP parity sweep
                                                └──► P2-B  Intent capability parity
P1-B  Idempotency contract ─────────────────────► P2-C  Multi-step safeguards
P1-C  Persistence integration test ─────────────► P3-A  Unattended autonomy
P1-D  Session isolation (desktop + web)
```

P0-A must land before anything else: every other intent-layer fix is unverifiable while an unrecognized verb can regenerate the arrangement.

---

## P0 — Data integrity and unsafe mutation

### P0-A · Make the unrecognized-verb path fail closed 🔴

**Goal:** an unrecognized verb must never reach the generative pipeline by default.

**Prerequisites:** none — this is the root fix.

**Modules:** `src/ui/IntentPanel.tsx` (catch-all at `:4468`), `src/intent/model-fallback-policy.ts` (`isCreativeBriefRoute`).

**Minimal scope:** require positive creative-brief signal before `generate(source)` in the terminal `else`. Preserve the current behaviour for genuine briefs; make everything else fall to `clarify`.

**Acceptance criteria:**

- `routeIntentText("export the current mix")` does not yield a route that reaches `generate()`.
- Existing generation briefs still route to generation (regression: full intent suite green).
- The clarify chip offers executable suggestions rather than a dead end.

**Regression tests:** table-driven over ~15 phrasings that must NOT generate (`export …`, `bounce …`, `fade …`, `delete …`, `mute …`).

**Complexity:** S.

---

### P0-B · Widen the export vocabulary 🔴

**Goal:** natural export phrasing reaches the export pipeline.

**Prerequisites:** P0-A (so a widened-but-still-missing phrasing fails safe rather than generating).

**Modules:** `src/intent/exact.ts` (`parseExportIntent`, `:558-564`).

**Minimal scope:** accept `mix|master|stem(s)` as the object noun; allow trailing clauses (`"export the current mix as mp3"`) by anchoring on the verb + format rather than the whole string.

**Acceptance criteria:** all five probe phrasings route to `kind:"export"` with the correct format; `"export wav"` behaviour unchanged.

**Regression tests:** executed-probe assertions from this audit, retained as a permanent suite.

**Complexity:** S.

---

### P0-C · Fade verb → `updateAudioClip` bridge 🔴

**Goal:** "fade the selected clip over its final bar" performs a fade.

**Prerequisites:** P0-A.

**Modules:** `src/intent/exact.ts` (new `fade` op), `src/commands/intentRouting.ts` (applier), `src/intent/model-schema.ts:177` (clip vocabulary).

**Minimal scope:** add a fade op targeting `selectedClipId`; resolve "final bar" against clip duration and the tempo map; reuse the existing clamp invariant (`audioClips.ts:454-457`).

**Acceptance criteria:** the phrase sets `fadeOut` on the selected clip within one undo step; clamp invariant holds; multi-select degrades to clarify rather than guessing.

**Complexity:** M.

---

## P1 — Canonical contracts, postconditions, persistence

### P1-A · Document-derived target resolution 🟠 · **IMPLEMENTED 2026-10-13** (vocal + live track names; model enum + Ollama doc-context deferred to the retrain round — evidence in `IMPL-2026-10-13-P0-P1.md`)

**Goal:** close the vocabulary gap at its root instead of by enumeration.

**Prerequisites:** P0-A.

**Modules:** `src/intent/exact.ts` (`TARGET_RES`, `ExactTarget`), `src/intent/model-ollama.ts` (use the `doc` already passed at `:191`), `src/intent/model-schema.ts`.

**Minimal scope:** resolve targets against live track names + `MixTarget` clip bindings before falling back to the closed enum; send project context to the local model instead of discarding it.

**Acceptance criteria:** `vocal` and arbitrary user track names resolve; adding a track named e.g. "FX Return Bus" makes it addressable without a code change.

**Complexity:** M.

---

### P1-B · Idempotency contract 🟠 · **IMPLEMENTED 2026-10-13** (`requestId` ledger at the `executeMcpTool` chokepoint; evidence in `IMPL-2026-10-13-P0-P1.md`)

**Goal:** retries cannot double-apply relative operations.

**Prerequisites:** none (independent).

**Modules:** `src/mcp/tools.ts` (`McpToolContext`, dispatcher), `src/commands/intentRouting.ts`.

**Minimal scope:** optional caller-supplied `requestId` on mutating tools, backed by a bounded recent-request ledger (id → undo index / result). A repeat returns the original outcome rather than re-executing. Define semantics for `kyx_batch` partial commits.

**Acceptance criteria:** the same `requestId` twice applies exactly once; the second call reports the original result; the ledger is bounded and evicted deterministically.

**Complexity:** M. **This is the single biggest blocker to unattended agent autonomy.**

---

### P1-C · Persistence + engine-projection integration test 🟠

**Goal:** cover the hop where a silent persistence failure would live.

**Prerequisites:** none.

**Modules:** new `tests/mcp-persistence.test.ts`.

**Minimal scope:** bind a real `ProjectStore` to a stub `onDocChanged` and an in-memory repository; assert (a) engine projection receives the new doc, (b) flush completes, (c) reload yields mutated state. Covers `services.ts:1065-1097`, currently executed by no MCP test.

**Acceptance criteria:** a command that mutates the doc but fails to persist fails the test.

**Complexity:** S. High leverage per unit of work.

---

### P1-D · Session isolation for the MCP bridge 🟠 · **UNKNOWN RESOLVED + S-SCOPE IMPLEMENTED 2026-10-13** (relay shares the single-session model; result-level document attribution landed; wire-level session ownership in a parallel wave — evidence in `IMPL-2026-10-13-P0-P1.md`)

**Goal:** concurrent agents cannot interleave on one document without trace.

**What the UNKNOWN turned out to be.** The web relay **is** single-session: `createMcpHub`
held one boolean and `server/collab-server.mjs` one `mcpRelaySocket`; desktop is separately
single-window by architecture. That answer was not a design preference — it was a **P1
defect**: a second window silently stole the relay, and because the hub accepted
`mcp-result` frames from _any_ socket, the displaced window's answers could resolve the live
window's tool calls. An agent's edit could land in a different project and report success.

**Repair (wire-level ownership).** Each relay connection carries an identity; the hub honours
a result only from the current session and ignores a displaced window's close. The server
moves ownership explicitly and closes the loser with code 4409 + a reason; the browser bridge
treats that close as terminal (no reconnect flap) and reports it through `onDisplaced`.
Evidence, falsification per guard, and residual risk: **`P1D-RELAY-SESSION-OWNERSHIP.md`** in
this directory. Locked by `tests/mcp-relay-session-ownership.test.ts` (9 specs, real server +
real sockets, every guard falsified).

**Still open:** true multi-session routing (an agent cannot address two projects at once) and
rendering `onDisplaced` in the settings chip.

**Acceptance criteria:** the result of any mutation states which document/window it touched
(result-level attribution — landed); a displaced window is inert at the hub rather than merely
closed later (landed).

**Complexity:** S for attribution surfacing, L for true isolation.

---

### P1-E · Close the mirror-gate hole 🟡

**Goal:** no tool can ship as a definition with no handler.

**Prerequisites:** none — one test.

**Modules:** `tests/mcp-mirror-sync.test.ts`.

**Minimal scope:** assert every `MCP_TOOLS` name has a `case` in the dispatcher. Currently clean (auditor verified 37/37), but unguarded.

**Complexity:** S.

---

## P2 — Parity and multi-step safeguards

### P2-A · MCP capability parity sweep · **IMPLEMENTED 2026-10-13** (per-capability table in `DAW_COMMAND_SURFACE_MATRIX.md` §3-P2-A: 30 FULL / 14 PARTIAL / 8 UI-ONLY / 4 MISSING; automation read-only row corrected; GAP-15 stale) — prereqs P0-A/P1-A both landed

Reconcile the 46 VERIFIED commands in `DAW_COMMAND_SURFACE_MATRIX.md` against the 37 MCP tools; publish a per-capability UI/Intent/MCP reachability table. Close `kyx_intent`'s natural-language gaps via P1-A. **Prereq:** P0-A, P1-A. **Complexity:** M.

### P2-B · Typed error contract · **IMPLEMENTED 2026-10-13** (eight-code closed set + mcpError gate; SERVER_INSTRUCTIONS legend deferred to the next mirror touch — evidence in `IMPL-2026-10-13-P0-P1.md`)

Add stable error codes to `McpToolResult` (`tools.ts:1675-1688`) so agents branch on codes instead of substrings. **Prereq:** none. **Complexity:** M.

### P2-C · Multi-step execution safeguards

Atomic-or-explicit semantics for `kyx_batch` (currently partial-commit by design, `tools.ts:4711-4712`); dry-run/preview mode across mutating tools. **Prereq:** P1-B. **Complexity:** M.

### P2-D · Add the genuinely missing capabilities

Time signature command (GAP-12), automation read/write modes (GAP-13), save-as (GAP-14), slip UI caller (GAP-15). Each is small; they are listed for completeness, not urgency. **Complexity:** S each.

---

## P3 — Advanced autonomy and diagnostics

### P3-A · Unattended agent operation

Only safe once P1-B (idempotency) and P1-D (isolation) land. Includes retry policy, cancellation propagation, and stale-selection detection. **Complexity:** L.

### P3-H · Headless evaluation

Headless is currently **zero-capability by design** (`desktop/mcp-host-manager.cjs:225,233`). If CI-driven agent evaluation is wanted, that is a new capability with its own ADR — not a bug fix. **Complexity:** L.

### P3-D · Versioned action schema

Add a version field + migration hook to `MODEL_ACTIONS` (`model-schema.ts:252-383`). **Complexity:** S.

---

## Explicitly not recommended

- **Do not rewrite the command spine.** `snapshot()` inverse-patch undo with dev-time self-verification (`core.ts:34-66`) is the strongest asset in the codebase.
- **Do not merge KYX and ZYVO implementations.** They are separate products (`D:\VocalForge_DAW` is a distinct monorepo); share _contracts_, not code.
- **Do not weaken the D4 destructive gate** (`flags.ts:9-17`) or the token/rate-limit controls (`mcp-bridge-server.cjs:154`, `:27-42`). They are working and tested.
- **Do not introduce LLM inference, network, or filesystem work into any audio callback.** Verified absent today across all 41 processors; keep it that way.

---

## Recommended first package

**P0-A + P0-B + P0-C**, shipped together with their regression tests.

Small, surgical, and closes both CRITICAL findings without touching the command spine. Every intent-layer fix after this is unverifiable while an unrecognized verb can regenerate the arrangement.

**IMPLEMENTED 2026-10-13** (together with P1-C and P1-E) — evidence in `IMPL-2026-10-13-P0-P1.md`.
