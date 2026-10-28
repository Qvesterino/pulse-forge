# THE AI OBSERVABILITY AUDIT 👁️

## Can the AI See Enough of the DAW to Act Intelligently, Safely, and Verifiably?

**Repository:** KYX / Pulse Forge — `D:\pulse-forge`
**Branch:** `main` · **Audited commit:** `c8729057` · **Date:** 2026-10-27
**Mode:** evidence-led audit → targeted safe hardening (only where justified)
**Scope:** current repository only. No product assumptions beyond what the code shows.

---

## 0. How to read this document

Every claim carries a confidence marker:

| Marker            | Meaning                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| **Verified**      | I read the cited lines and the behaviour follows from them.                                      |
| **Code-inferred** | The conclusion follows from read code, but a runtime path I did not execute could contradict it. |
| **Hypothesis**    | A plausible reading that needs a run to confirm.                                                 |
| **Unverified**    | Out of scope, not read, or blocked by an environment limit. Stated plainly rather than guessed.  |

Line numbers refer to the audited commit unless a file was in flight. Two files were **actively being edited by a parallel session during the audit** (`src/mcp/tools.ts`, `server/mcp-core.mjs`); their line numbers are therefore a snapshot of 2026-10-27 ~18:00 local and may drift. Symbol names are the durable anchor.

---

## 1. Executive verdict

**KYX has an unusually well-built AI mutation layer and a comparatively thin AI observation layer.** The asymmetry is not "the AI cannot act" — it is "the AI acts correctly but cannot confirm what it did, and cannot see what it is reasoning about."

Three findings dominate:

1. **The mutation receipt proves a document change, never an engine or audio change.** `stage: "applied"` is explicitly a document claim (`src/mcp/tools.ts:3783-3788`). The audio engine separately maintains a queryable "the graph is not whole" fact — `AudioEngine.projectSyncFailure` (`src/audio-engine/AudioEngine.ts:1166`) — which the export path consults but **no MCP tool and no UI component ever reads**. An agent can therefore mutate the document, receive a green receipt, and have no way to learn that the audio graph failed to apply it.

2. **No observation result carries a timestamp, a document revision, or a document identity.** `McpToolResult` (`src/mcp/tools.ts:3814-3865`) has no `timestamp` field, no `revision` field, and no `sessionId`; `docId`/`docName` are assigned **only** when `result.mutated === true` (`src/mcp/tools.ts:5190-5197`). A read-only `kyx_state` result therefore names no document, no point in time, and no version. The only revision on the wire anywhere is `kyx_render_summary`'s track-window path (`src/mcp/render-summary.ts:53-55`).

3. **The AI cannot hear the mix, and the gap is architectural rather than accidental.** Every expensive measurement is a fresh one-off render that is never reused; the model-derived perception layer (Ultina/TSAR instrument classification with a real `confidence` value) is **not reachable from `src/mcp/` at all**; and the `confidence` slot that the analysis contract declares (`src/analysis/contract.ts:78`) is populated `null` by the one analyzer the agent can reach. The agent's "what does this sound like" channel is a base64 WAV blob (`src/mcp/audio-preview.ts:108-112`), not analysis.

Against that, the repo's discipline is real and worth stating plainly:

- **The safety layer is ahead of the observation layer.** Risk classification, a closed error taxonomy, a stale-write guard, a permission lattice, session checkpoints and a local-only audit log all exist, and 68 MCP-contract test files guard them.
- **The guards demonstrably fail when they should.** During this audit, a newly added tool (`kyx_separate`, in-flight in a parallel session) was caught **twice, independently** by `tests/agent-trust.test.ts:47` ("a new tool cannot ship unclassified") and `tests/mcp-receipt-census.test.ts:286` ("a new tool must be classified before it can be trusted"). That is the house rule — a guard that cannot fail is not a guard — demonstrated live rather than asserted.
- **Deliberate boundaries are documented as policy, not left to be discovered by failure.** `capabilitySnapshot` publishes `unavailableByDesign` with `{supported, reason, revisit}` for project switching, audio import and recording (`src/mcp/tools.ts:4341-4359`). This is the single best piece of AI contract design in the repository.

**Bottom line.** The agent can currently _write_ safely and _read_ thinly. The success criterion — observe the right state, reason about its meaning, act with valid preconditions, and independently verify the actual result without guessing — is **not yet met**, because the verification leg stops at the document boundary.

**Maturity headline:** the write side scores **4–5**; the read side scores **2–3**; the verify side scores **2**. See §11.

---

## 2. Evidence base, environment, and what could not be exercised

### 2.1 What was read

| Substrate                                            | Extent                                                                                                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/mcp/tools.ts`                                   | 611 KB / 13 925 lines — `McpToolDef` (253), `MCP_TOOLS` (1661), `McpToolContext` (3567), `McpToolResult` (3814), `McpErrorCode` (3905), `capabilitySnapshot` (4311), `stateSnapshot` (13381), `automationSnapshot` (13352) |
| `src/mcp/` (33 files)                                | Full inventory; `agentTrust.ts`, `permissionLattice.ts`, `scope-guard.ts`, `write-conflict.ts`, `revision.ts`, `verified-mutation.ts`, `attribution.ts`, `intent-readback.ts`, `flags.ts`, `onboarding.ts` read in full    |
| `src/audio-engine/`                                  | `AudioEngine.ts` (project queue + `syncProject` + `projectSyncFailure`), `metering.ts`, `meteringRig.ts`, `metering-types.ts`, `masterChain.ts`, `PcmMicRecorder.ts`, `PcmMicRecorderGroup.ts`                             |
| `src/analysis/`                                      | `contract.ts`, `mixDoctor.ts`, `ultinaAnalysisClient.ts`, `ultinaAnalysisWorker.ts`                                                                                                                                        |
| `src/store/ProjectStore.ts`, `src/commands/types.ts` | Revision counter, apply/undo/redo path                                                                                                                                                                                     |
| `src/ui/`                                            | 142 top-level `.tsx` components; `DockChrome.tsx` (14 dock panels)                                                                                                                                                         |
| Transports                                           | `src/mcp/{bridge,web-host,desktop-host,headless-host}.ts`, `server/mcp-core.mjs`, `desktop/mcp-tool-defs.cjs`                                                                                                              |

### 2.2 Measurements taken (scripts in `%TEMP%`, never in the repo tree)

| Measurement         | Method                                                                                     | Result                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Tool inventory      | `scripts/audit-mcp-observation.mjs` — TypeScript compiler API over the `MCP_TOOLS` literal | **39 tools** at `c8729057`; 26 with `outputSchema`; **13 without**                                    |
| Risk table          | Same parser over `TOOL_RISK` in `agentTrust.ts`                                            | 39 entries: read 3 / runtime 8 / destructive 7 / mutate 21 — **closed, no unclassified tool**         |
| Undeclared inputs   | Same parser, over `tools.ts` + the three guard modules                                     | **9** behaviour-changing inputs read off the call arguments that no tool schema declares (§6.2)       |
| Cross-surface drift | Name-set diff over `src/mcp/tools.ts`, `server/mcp-core.mjs`, `desktop/mcp-tool-defs.cjs`  | **All three carry the identical names** — no name-level drift; the mirrors are _generated_ (§16.1 Q1) |
| Test surface        | Filesystem count                                                                           | 68 MCP-contract spec files; 1301 non-e2e spec files total                                             |

> **Counts are measured at the audited commit `c8729057`: 39 tools.** A parallel session was adding a 40th (`kyx_separate`) during the audit; in that tree the same instrument reports 40 tools, 26 with a schema, 14 without, and `kyx_separate` unclassified — which the two existing taxonomy guards caught on their own (§2.3). Where a number differs between the baseline and that in-flight tree, this report gives the **baseline** number and names the difference.

### 2.3 Tests actually run

| Run                                                                         | Command                                                                                                                                                             | Result                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Shared worktree (has a parallel session's WIP)                              | `npx vitest run tests/{agent-trust,permission-lattice,mcp-verified-mutation,mcp-error-codes,mcp-receipt-census,mcp-state-mixer,mcp-ops-coverage,mcp-tools}.test.ts` | **280 passed / 282**; 2 failed |
| Isolated worktree at `c8729057` (a detached checkout of the audited commit) | `npx vitest run tests/{agent-trust,mcp-receipt-census,mcp-ops-coverage}.test.ts`                                                                                    | **65/65 passed**               |
| The audit's own guard, shared tree                                          | `npx vitest run tests/audit-observation-contract.test.ts`                                                                                                           | **8/8 passed**                 |
| The audit's own guard, isolated baseline                                    | same, with `KYX_OBSERVATION_ROOT` pointed at `c8729057`                                                                                                             | **8/8 passed**                 |

The two shared-tree failures are **not defects in the committed baseline**. Both are the in-flight `kyx_separate` tool missing its `TOOL_RISK` entry and its receipt-census entry — exactly what those two guards exist to catch. The isolated run at the audited commit proves the baseline is green. **Verified.**

_Reproducing the isolated run:_ `git worktree add --detach <path> c8729057`, then a `node_modules` junction into the main checkout, then the same vitest invocation. The temporary worktree was removed after the audit; the claim is about the **commit**, not about a directory that still exists.

### 2.4 The guard was proven capable of failing

A guard that cannot fail is not a guard. Three independent proofs, in increasing strength:

1. **The existing taxonomy guards fired, unprompted**, on the in-flight `kyx_separate` tool — `tests/agent-trust.test.ts:47` ("a new tool cannot ship unclassified") and `tests/mcp-receipt-census.test.ts:286` ("a new tool must be classified before it can be trusted"). Two suites, one condition, independently caught.
2. **The audit's own ratchet was run against a synthetic probe tree** (`output/obs-probe`, since deleted) containing a deliberately undeclared read `record.__probeUndeclared`. The instrument reported it, alongside `force`, `scope` and `projectRevision` — proving the detector is live rather than vacuous.
3. **The ratchet's comparison was unit-tested on a synthetic set** (`tests/audit-observation-contract.test.ts`, "the ratchet CAN fail") — a new undeclared input is caught, and a known list that grows stale is caught too.

### 2.5 What could NOT be exercised

- **No dev server / no live browser.** The box was saturated by parallel sessions; a Vite dev server on port 5271 timed out and was killed. All audio-path claims are therefore **Code-inferred from source**, not measured in a running app.
- **No `npm run build`** — `public/` holds 336 tracked artefacts that `prebuild` rewrites; running it in a shared tree would have created cross-session churn. Bundle budgets were not re-verified.
- **`npm run typecheck`** — not run for this audit (the audit changes no TypeScript). The tree carries 6 pre-existing errors from parallel sessions, all in peer-owned files (`schema.ts`, `contract-timeline`, `param-range-coherence`, e2e).
- **The transports were not line-audited end to end.** `server/mcp-core.mjs` (244 KB) and `desktop/mcp-tool-defs.cjs` were read only where it matters: the tool-definition region, the `tools/list` path, the `tools/call` path, and the relay. The question they were opened to answer — _do they re-implement handlers?_ — is **answered** (§16.1 Q1, OBS-15): they carry generated definitions and relay execution. The rest of those 244 KB (the hub, the session registry, the rate limiter) was not audited for this report.
- **`src/analysis/contract.ts` confidence semantics** — the field exists and is populated `null` on the MCP path; the _intent_ of the authors is Code-inferred.

---

## 3. System and state-flow map

### 3.1 The mutation path, end to end

```
   AGENT CALL
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ executeMcpTool (tools.ts:4711) → executeMcpToolCore (4770)          │
│                                                                      │
│  1. agentId validation          4718-4727                           │
│  2. requestId / idempotency     4728-4767   ← replay + `current`    │
│  3. PERMISSION LATTICE          4799-4824   ← consent + revision    │
│  4. instance-index check        4843-4860                           │
│  5. dry-run sandbox             4868-4910                           │
│  6. replay → `current` diff     4911-4957                           │
│  7. session checkpoint          4958-4981   ← first mutation only   │
│  8. per-call deadline / abort   5015-5021                           │
│  9. STALE-WRITE GUARD           5025-5070   ← base+ops vs current   │
│ 10. SCOPE GUARD                 5077-5082   ← allow/protect paths   │
│ 11. verifiedMutation()          5139-5147   ← document witness      │
│ 12. clamp disclosure            5154-5157                           │
│ 13. stage/risk/docId normalisation 5180-5198                       │
│ 14. audit entry                 5217-5230                           │
└──────────────────────────────────────────────────────────────────────┘
       │  ctx.execute(command) — MUST be inline (3570-3587, guarded)
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ COMMAND LAYER — src/commands/*                                      │
│   every mutation flows through a command; ops carry the paths       │
│   they write; base carries the doc they were computed against        │
└──────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ ProjectStore (src/store/ProjectStore.ts)                             │
│   apply / undo / redo → afterMutation() (600-608) → revision_++ (284)│
│   the store REPLACES the document object (368) — never mutates in place│
└──────────────────────────────────────────────────────────────────────┘
       │
       ├──► UI          React subscribers re-render (store is the truth)
       │
       ├──► ENGINE      AudioEngine.setProject(doc) (1189)              │
       │                   this.doc = doc  ← SYNCHRONOUS                │
       │                   graph sync DEFERRED via projectPromise      │
       │                     └─ syncProject(doc) (2070)                │
       │                     └─ on failure: lastProjectSyncFailure     │
       │                                  (1236-1239)  ⚠ NOT MCP-READ │
       │                   whenProjectSettled() (1177)  ← settle ack   │
       │                                                             │
       ├──► PERSISTENCE save-lifecycle + autosave-debouncer            │
       │                   debounced; exposes saved/dirty/saving/error │
       │                                                             │
       └──► TOOL RESULT McpToolResult (3814) — text, data, stage,     │
                          risk, errorCode, docId/docName (mutated only)│
```

**The critical structural observation.** Steps 1–14 and the document half of step 15 are _inside_ the MCP call. The engine half is **outside** it — deferred through `projectPromise`, coalesced to a 1-slot queue where "only the latest pending doc matters" (`AudioEngine.ts:1190-1196`). The result envelope has no stage member for "engine-synced"; the stage enum is `read | runtime | applied | persisted | rendered | delivered | dry-run | replayed | noop` (`tools.ts:3787-3788`). **`applied` is therefore a promise about the document, not a fact about the audio.**

**The propagation seam is one function.** `src/services.ts:1292-1335` — `store.onDocChanged = (doc) => { … }` — is the _only_ place the document reaches the engine. Its ordering is fixed and verified:

```
revision++ → saveStatus="dirty" → emit() [React re-renders] → onDocChanged
           → engine.setProject(doc) → transport.setBarTicks/setBpm
           → generativeRuntime.refreshAll() [fire-and-forget] → saveDebouncer.arm()
```

**React re-renders before the audio engine is told.** `emit()` (`ProjectStore.ts:610-612`) fires before `onDocChanged` runs, so a UI panel can paint a value the graph has not adopted. For a human that is a frame; for an agent that reads state right after a write, it is a window in which the document and the graph disagree — and no read exposes which one it saw.

**The engine's acknowledgement has exactly one consumer.** `src/rendering/renderer.ts:634-635`:

```ts
await engine.whenProjectSettled();
assertProjectGraphBuilt(engine.projectSyncFailure);
```

That is the offline renderer refusing to render a half-built graph. **The live path never awaits `whenProjectSettled()`, and no MCP tool ever consults `projectSyncFailure`.** The mechanism to close OBS-01 exists and is used — by exactly one caller, on the export path only.

**"Applied" ≠ "was ever audible".** Re-entrant `setProject` calls **drop queued documents** (`AudioEngine.ts:1190-1196`, `:1221-1224`): two mutations in one tick mean only the newest state ever reaches the graph. The intermediate state is invisible to every observer, and no stage records it. Similarly, `generativeRuntime.refreshAll()` is awaited by nobody and only `console.warn`s on failure (`src/services.ts:1327`) — a generative refresh can fail while the document mutation is reported as `applied`.

### 3.2 The read path

```
   AGENT CALL → kyx_state / kyx_meter / kyx_render_summary / …
       │
       ├── kyx_state ─► stateSnapshot(doc, subject, family, labels)  [13381]
       │                 └─ returns a FORMATTED TEXT STRING
       │                 └─ structured twin ONLY for subject:"mixer"   [5328]
       │
       ├── kyx_meter ─► ctx.meters() → AnalyserNode time-domain read   [main thread]
       │                 └─ 12 ms TTL cache, NO revision, NO timestamp
       │
       └── kyx_render_summary ─► renderProject → analyze →  ✔ revision + freshness
```

### 3.3 Multiple sources of truth (identified)

| #   | Source of truth                                             | Owner                                                 | Notes                                                                                                                                               |
| --- | ----------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `ProjectDocument`                                           | `src/project-model/schema.ts` (`SCHEMA_VERSION = 38`) | The document. Everything else derives from it.                                                                                                      |
| S2  | `ProjectStore.revision_`                                    | `src/store/ProjectStore.ts:78`                        | Monotonic; bumped only in `afterMutation()` (600-608). **Not exposed on any read tool**, and **never persisted** — it restarts at 0 after a reload. |
| S3  | `AudioEngine.doc`                                           | `src/audio-engine/AudioEngine.ts:1189`                | A **reference**, assigned synchronously, graph sync deferred.                                                                                       |
| S4  | `AudioEngine.lastProjectSyncFailure`                        | `AudioEngine.ts:1157`                                 | The engine's own "graph is not whole" fact. Read by the export path; **read by no MCP tool, no UI component**.                                      |
| S5  | `MasterMeterSnapshot` (live meter)                          | `src/audio-engine/metering-types.ts:15-28`            | 12 ms TTL, no revision, no timestamp, no transport state.                                                                                           |
| S6  | `agentTrust` audit log                                      | `src/mcp/agentTrust.ts:286-292`                       | localStorage, ≤200 entries, per-window module state, user-tamperable. **Not reachable by the model.**                                               |
| S7  | `doc.updatedAt` / store `lastSavedAt` / library `updatedAt` | three different notions of "when did this save"       | Independently flagged by `STATE_DIVERGENCE_HUNTER_REPORT.md` F-15.                                                                                  |
| S8  | `master-assistant` measurement snapshot                     | `src/mcp/tools.ts:12909-12918`                        | Built from the live meter, with `hfShare`/`lowEndShare` hardcoded `null` (12950-12951).                                                             |

### 3.4 Asynchronous boundaries and race windows

| Window            | Reality                                                                                                                           | Consequence for an agent                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Engine graph sync | `setProject` assigns `this.doc` synchronously; graph sync deferred via `projectPromise`, coalescing re-entrant pushes (1190-1196) | The document can be ahead of the audio by a sub-frame. No stage says so.                                           |
| Worklet refresh   | `queueWorkletRefresh` → deferred FX rebuild; a mid-sync throw leaves chains half-built and is only `console.error`'d (1058-1061)  | The agent cannot distinguish "FX still loading" from "FX failed".                                                  |
| Meter cache       | 12 ms TTL keyed on wall-clock only (`meteringRig.ts:264-268`)                                                                     | Two reads 12 ms apart around an edit may describe different states, identically shaped.                            |
| Render analysis   | `projectRevision` captured before the first `await`, `revisionAfterRender` after (`render-summary.ts:201-247`)                    | The only freshness signal in the system, and only on one path.                                                     |
| Persistence       | Autosave is debounced                                                                                                             | The agent can mutate and the document can be lost on a crash; no read exposes "pending edits".                     |
| Collab (Yjs)      | `storeRevision` returns `null` for a Yjs-backed store (`src/mcp/revision.ts:11-13`)                                               | `freshness` degrades to `"unknown"` and the `STALE_REVISION` rule is **skipped, not faked** — good — but silently. |

### 3.5 Session and project identity

- A project is identified by `doc.id`; the audit log records `docId` + `docName` (`agentTrust.ts:252-253`).
- An agent session is `s<base36 ts>-<counter>` (`agentTrust.ts:406`), bounded by document change, agent change, or 15 min idle (`AGENT_SESSION_IDLE_MS = 15 * 60 * 1000`, `:237`).
- `sessionId` exists internally (`prepared.sessionId`, `tools.ts:4976`) but **no MCP result carries it** — the agent cannot correlate its own calls.
- The session checkpoint is one clone per session, requested _before_ the first mutation (`:380-385`, `:4906-4929`); its failure is **swallowed** (`catch { /* checkpointing is safety netting, never a gate on the call */ }`, `:4926-4928`).
- **Project switching is not exposed to MCP by design** (`unavailableByDesign.projectOpen`, `tools.ts:4342-4347`) — correct, because switching rebuilds services. But a read in flight during a switch is not invalidated; there is no project-id precondition on reads. The hosts _are_ re-armed on a services swap (`src/ui/App.tsx:404-434`, with the cleanup that fixed a double-listener bug), but rebinding is **not** cancellation: a call already inside `executeMcpToolCore` continues against the old `ctx` and the old document.

### 3.6 The command envelope carries no identity

`src/commands/types.ts:5-61` — the `Command` interface is deliberately minimal:

| Field                        | Line       | Purpose                                                    |
| ---------------------------- | ---------- | ---------------------------------------------------------- |
| `type` / `label` / `detail`  | 6 / 7 / 14 | What happened, in human terms                              |
| `clamps?`                    | 26         | The values the domain had to change — the clamp disclosure |
| `execute(doc)` / `undo(doc)` | 27 / 28    | Forward and inverse                                        |
| `base?`                      | 39         | The document the write was computed against                |
| `ops?`                       | 44         | The paths the write claims to touch                        |
| `applyToYDoc?(yMap)`         | 51         | The collaboration fast path                                |
| `coalesceKey?`               | 60         | Gesture grouping                                           |

**There is no session id, no project id, no version, no timestamp and no actor marker on the command.** Attribution exists only as a **label prefix** (`[agentId] `, `src/mcp/attribution.ts:37-46`) — display data, not a queryable identity. This is the root of OBS-05: the envelope has nowhere to put "which revision did I observe", so it does not.

Two consequences worth naming:

- **Undo is functional, not snapshot-based.** `src/commands/core.ts:69-70` — `undo` applies the _inverse patch to whatever document is current_. That is the correct design for a shared timeline (an async dispatch cannot silently revert a concurrent edit), but it also means the undo stack and the redo stack are the only history, and redo is a different kind of history that the tool layer cannot see (§OBS-10).
- **The document handed out is live, and freezing it is dev-only.** `getDoc()` returns the live object (`ProjectStore.ts:277`); `deepFreeze` runs only under `isDev()` (`core.ts:20-22`, `:41`). In production a hand-written command that mutates the document in place silently corrupts **the very `base` the stale-write guard trusts**.

### 3.7 Persistence

| Concern            | Reality                                                                                                                                                                                         | Consequence for the agent                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Save state machine | `"saved" \| "dirty" \| "saving" \| "error"` (`ProjectStore.ts:29`); the collab store adds `"syncing"` (`YDocStore.ts:38`)                                                                       | `kyx_save` reports the state **after** awaiting the flush (`src/mcp/save-now.ts:9-32`) — a durable receipt, not an optimistic one            |
| ⚠ schema mismatch  | The MCP save result type advertises `"syncing"`, which the **local** store's union does not contain                                                                                             | The tool boundary advertises a state the local project can never report; an agent may write a state machine that expects it and never see it |
| Autosave           | `debounceMs: 800`, `maxDeferMs: 5000`, `maxArms: 50` (`src/services.ts:1287-1289`) — two independent ceilings, so a sustained gesture still lands                                               | Every intermediate state inside a burst is dropped; only the final document is written                                                       |
| ⚠ `cancel()`       | Clears the pending timer and resets the burst counters — **no flush** (`src/persistence/autosave-debouncer.ts:52`)                                                                              | After a cancel the last edit is durable only via the pagehide guard, an explicit `kyx_save`, or the visibility-hidden flush                  |
| Durable identity   | `ProjectDocument.id` is the IndexedDB key; `createdAt`/`updatedAt` are the only time markers; the project + "most recent" pointer are written in one transaction (`ProjectRepository.ts:52-60`) | ✅ atomic                                                                                                                                    |
| ⚠ Revision         | **No revision or sequence is persisted.** The in-memory `revision_` restarts at 0 on reload                                                                                                     | A `projectRevision` declared before a reload compares against a meaningless number — the compare-and-set token has no cross-session meaning  |
| Unload guards      | `pagehide` + `beforeunload`, idempotent per target (`src/persistence/save-lifecycle.ts:74-133`), but **best-effort**                                                                            | "saved" is only trustworthy when `kyx_save` returned `ok: true`                                                                              |

---

## 4. Four-layer visibility matrix

Legend: **A** human-visible · **B** internal truth · **C** AI-readable · **D** AI-writable.
✅ full · ◐ partial · ❌ absent · ⛔ deliberate, documented.

| Entity / operation                                        | A — human-visible                                           | B — internal truth                                                | C — AI-readable                                                                                 | D — AI-writable                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Project (identity, name, BPM, key, meter)**             | ✅ Project Browser, transport bar                           | ✅ `ProjectDocument`, `doc.id`                                    | ◐ `kyx_state overview/tempo/key`; **no doc id on read results**                                 | ◐ `kyx_music setTempo/setKey`; ⛔ project open/switch                     |
| **Project library (other projects)**                      | ✅ Project Browser                                          | ✅ IndexedDB repos                                                | ✅ `kyx_state subject:"projects"` (needs `ctx.listProjects`)                                    | ⛔ open/switch by design                                                  |
| **Tracks (gain, pan, mute, solo, kind, instrument)**      | ✅ Mixer panel                                              | ✅ `doc.tracks[]`                                                 | ✅ `kyx_state tracks` + `mixer` (structured twin)                                               | ✅ `kyx_tracks setGain/setPan/setMute/setSolo/add*/remove/duplicate/move` |
| **Track FX chain (type, bypass, order)**                  | ✅ DEV panel                                                | ✅ `track.effects[]`                                              | ◐ `kyx_state fxChain` returns type + bypassed **but no parameter values**                       | ✅ `kyx_fx more/less/remove/bypass/enable/reorder`                        |
| **Effect parameters (freq, Q, gain)**                     | ✅ Plugin UI                                                | ✅ `fx.params[]`                                                  | ◐ `kyx_plugin_param op:list` returns targets/params; ⛔ **no unified "read EQ band" view**      | ✅ `kyx_plugin_param op:set`, `kyx_master` inserts                        |
| **Send routing / returns / groups**                       | ✅ Mixer sends                                              | ✅ `doc.returns[]`, `track.sends`                                 | ✅ `kyx_state sends` + `mixer`                                                                  | ✅ `kyx_routing` 8 ops                                                    |
| **Arrangement clips (position, length)**                  | ✅ ARR timeline                                             | ✅ `doc.arrangement.clips[]`                                      | ◐ `kyx_clips op:list`; ⛔ **no clip-gain or effective-gain read**                               | ✅ `kyx_clips add/move/resize/split/duplicate/delete` (destructive)       |
| **Scenes / sections**                                     | ✅ Scene lane                                               | ✅ `doc.scenes[]`                                                 | ✅ `kyx_state scenes`                                                                           | ✅ `kyx_sections` 7 ops; `kyx_arrange`; `kyx_song`                        |
| **Pattern + step grid**                                   | ✅ Sequencer                                                | ✅ `doc.patterns[]`                                               | ✅ `kyx_state pattern` (grid + mean velocity); `kyx_pattern op:list`                            | ✅ `kyx_steps`, `kyx_pattern op:select`                                   |
| **Melodic notes**                                         | ✅ Piano roll                                               | ✅ `pattern.notes[trackId]`                                       | ✅ `kyx_notes op:list` with `offset`/`limit` pagination                                         | ✅ `kyx_notes` 11 ops                                                     |
| **Markers**                                               | ✅ Marker lane                                              | ✅ `doc.markers[]`                                                | ✅ `kyx_markers op:list` (structured)                                                           | ✅ `kyx_markers` add/remove/rename                                        |
| **Transport (play, pause, loop, metronome, playhead)**    | ✅ Transport bar                                            | ✅ `Transport` model                                              | ✅ `kyx_transport op:state` + `kyx_state`                                                       | ✅ `kyx_transport` 10 actions                                             |
| **Recording / arming / input device**                     | ✅ Record button, device picker, input gain, mic monitoring | ✅ `PcmMicRecorder`, `PcmMicRecorderGroup`, `sessionStateSurface` | ◐ only via a `POLICY_REFUSED` side-effect; ⛔ no state read                                     | ⛔ **by design** (`unavailableByDesign.recording`)                        |
| **Automation lanes (targets, points, ranges)**            | ✅ MOD panel                                                | ✅ `doc.automation[]`                                             | ✅ `kyx_state automation` + `kyx_automation op:listTargets`                                     | ✅ `kyx_automation` 7 ops                                                 |
| **Effective (post-automation) parameter value at time T** | ✅ visual (fader moves)                                     | ✅ the automation bridge                                          | ❌ **no read resolves a lane at a tick**                                                        | —                                                                         |
| **Master chain / loudness trim**                          | ✅ MASTER panel                                             | ✅ `doc.master`                                                   | ✅ `kyx_state mixer` master block                                                               | ✅ `kyx_master` 11 ops                                                    |
| **Meters (peak, RMS, LUFS, clipping)**                    | ✅ Master + track meters                                    | ✅ `meteringRig`                                                  | ✅ `kyx_meter scope:master/tracks/fx/all`                                                       | —                                                                         |
| **Per-track true-peak vs sample-peak**                    | ✅ (meter shows sample peak)                                | ✅ two different quantities                                       | ◐ `kyx_meter` exposes both, **without labelling which is which**                                | —                                                                         |
| **Loudness (integrated LUFS)**                            | ✅ MASTER panel                                             | ✅ `kweighting.ts` (BS.1770-4)                                    | ◐ `kyx_loudness op:measure`; ⚠ the **live** meter may be an approximation and does not say so   | ✅ `kyx_loudness op:match`                                                |
| **Mix diagnosis (findings, attributions)**                | ✅ (post-render panel)                                      | ✅ `mixDoctor.ts`                                                 | ✅ `kyx_diagnose_mix`                                                                           | ✅ `kyx_mix_idea apply`                                                   |
| **Frequency spectrum / FFT curve**                        | ✅ Spectrum + Spectrogram panels                            | ✅ `spectrogram.ts`                                               | ❌ **no FFT curve reaches MCP**; only 7 band shares                                             | —                                                                         |
| **Pitch / note content of the rendered mix**              | ✅ (piano roll is the document)                             | ✅ `pitch-tracker.ts`                                             | ❌ not reachable from `src/mcp/`                                                                | —                                                                         |
| **Onset / transient structure**                           | ✅ Slice Lab                                                | ✅ `transients.ts`                                                | ❌ not reachable from `src/mcp/`                                                                | —                                                                         |
| **Model-derived perception (Ultina/TSAR)**                | ✅ Ultina panel                                             | ✅ `ultinaAnalysisClient.ts`                                      | ❌ **not reachable from `src/mcp/`**                                                            | —                                                                         |
| **Undo / redo history**                                   | ✅ (undo button + labels)                                   | ✅ undo stack + labels                                            | ◐ `kyx_state subject:"history"` gives **labels only**                                           | ✅ `kyx_undo` (⚠ global LIFO, not per-agent)                              |
| **Save state (dirty/saved/saving/error)**                 | ✅ status bar                                               | ✅ `save-lifecycle`                                               | ◐ `kyx_save` reports `saveStatus` **after** saving; ⛔ no "is it dirty?" read                   | ✅ `kyx_save save/saveAs`                                                 |
| **Render / export jobs**                                  | ✅ Job Center                                               | ✅ job registry                                                   | ◐ `kyx_render_summary`; ⛔ **no cooperative cancellation** (`unavailableByDesign.cancellation`) | ✅ `kyx_export`                                                           |
| **Agent permissions / session / audit log**               | ✅ AI History panel, trust report                           | ✅ `agentTrust.ts`                                                | ❌ **the model cannot read its own audit log or session**                                       | —                                                                         |
| **Engine graph health**                                   | ❌                                                          | ✅ `AudioEngine.projectSyncFailure`                               | ❌ **not exposed anywhere**                                                                     | —                                                                         |

### 4.1 Where the map is thin

Three rows are ◐ where they should be ✅, and two are ❌ where the substrate exists:

1. **Effect parameter read** — the AI can set an EQ band but has no single call that answers "what is the frequency, Q, gain, and bypass of band 2 right now?"
2. **Effective parameter value** — the AI can list automation lanes and their points but cannot ask "what is the gain at bar 9?". This is the exact example in the audit brief, and it is **unanswerable**.
3. **Recording state** — deliberately unwritable, but also unreadable except as a side effect of a refusal.
4. **Engine graph health** — the engine knows; nobody is told.
5. **Model-derived perception** — the richest perception code in the repo is unreachable from the agent surface.

---

## 5. Read / write / verify parity matrix

Per the brief: _command accepted_, _state mutated_, _engine updated_, and _audible effect confirmed_ are four distinct claims. The current surface collapses the first two and has no vocabulary for the last two.

| #   | Action                                                         | Preconditions readable?                  | Current state readable?                                           | Mutation supported?                       | Result observable?                    | Undo / rollback? | Risk     | Notes                                                                                                                           |
| --- | -------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------- | ------------------------------------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Change clip gain, read effective gain after automation**     | ◐ clip list exists                       | ❌ **no clip-gain read; no effective-value read**                 | ✅ `kyx_clips` (`gain`)                   | ◐ receipt text                        | ✅ 1 undo step   | Medium   | **Broken parity.** Write without a read-back of the same quantity.                                                              |
| 2   | **Set EQ band, inspect freq/Q/gain/bypass/chain**              | ◐ `kyx_state fxChain` (type+bypass only) | ◐ `kyx_plugin_param op:list` (scattered)                          | ✅ `kyx_plugin_param op:set`              | ◐ `changes[]` + readback slot         | ✅               | Medium   | Bypass and chain are readable; **parameters are not in one place**.                                                             |
| 3   | **Move clip, verify position, overlap, snap outcome**          | ✅                                       | ◐ `kyx_clips op:list` gives position                              | ✅ `kyx_clips op:move`                    | ◐ prose text                          | ✅               | Medium   | **Snap outcome is not reported** — the agent cannot tell a snapped move from an unsnapped one.                                  |
| 4   | **Create bus, verify graph connectivity and signal path**      | ✅                                       | ✅ `kyx_state sends` + `mixer`                                    | ✅ `kyx_routing createGroup/createReturn` | ✅ structured `routes/groups/returns` | ✅               | Low      | **Best parity row in the matrix.**                                                                                              |
| 5   | **Arm recording, verify input readiness and transport state**  | ✅ (UI)                                  | ◐ only via refusal                                                | ⛔ **by design**                          | ⛔                                    | n/a              | n/a      | Deliberate. The agent is told it is unsupported (`unavailableByDesign.recording`).                                              |
| 6   | **Apply AI edits, inspect receipt and undo availability**      | ✅                                       | ✅ `kyx_state history` (labels)                                   | ✅                                        | ✅ `stage`, `status`, `readback[]`    | ✅ `kyx_undo`    | Low      | **Strong.** `verifiedMutation` genuinely corrects a false "one undo step" claim (`verified-mutation.ts:139-147`).               |
| 7   | **Change tempo, read back**                                    | ✅                                       | ✅ `kyx_state tempo`                                              | ✅ `kyx_music setTempo`                   | ✅                                    | ✅               | Low      | Strong.                                                                                                                         |
| 8   | **Set track gain, read back**                                  | ✅                                       | ✅ `kyx_state tracks` (gain linear + dB)                          | ✅ `kyx_tracks setGain`                   | ✅ prose                              | ✅               | Low      | Strong.                                                                                                                         |
| 9   | **Add automation point, verify lane**                          | ✅                                       | ✅ `kyx_state automation`                                         | ✅ `kyx_automation addPoint/addRamp`      | ✅ `undoSteps` + readback             | ✅               | Low      | Strong. ⚠ `status:"verification-needed"` when the ramp read-back mismatches (`tools.ts:8941`).                                  |
| 10  | **Set a parameter, verify it is not overridden by automation** | ◐ lanes are listed                       | ❌ **no resolution at a tick**                                    | ✅                                        | ❌                                    | ✅               | **High** | The agent can set a value it will never hear, and cannot tell.                                                                  |
| 11  | **Export, verify the file**                                    | ✅                                       | ✅ `kyx_save`/`kyx_export` report `stage:"persisted"/"delivered"` | ✅                                        | ✅                                    | n/a              | Medium   | ⛔ **no cooperative cancellation** — a long export cannot be aborted over MCP.                                                  |
| 12  | **Undo after a multi-step plan**                               | ✅                                       | ✅ history labels                                                 | ✅ `kyx_undo`                             | ◐ `revertedLabels`, `partialFailure`  | ✅               | **High** | ⚠ Undo is **global LIFO**, not per-agent; `allowForeign:true` waives the prompt (`attribution.ts:19-21`, `tools.ts:5356-5369`). |

**Parity summary.** 7 of 12 rows are strong. Three are weak (#1, #3, #10) and share one root cause: **there is no read that answers the same question the write just changed.** Two are deliberately closed (#5 and partly #11) and correctly documented as such.

---

## 6. Observation contract quality assessment

Assessed against the ten dimensions in the brief.

### 6.1 Discoverability and semantic naming — **good**

Tool names are semantic and domain-shaped (`kyx_tracks`, `kyx_automation`, `kyx_render_summary`), not CRUD-generic. The risk table (`agentTrust.ts:50-94`) is a single classification source, and `tests/agent-trust.test.ts` pins it closed. `onboarding.ts` publishes a 39-tool index plus a bilingual (EN/SK) intent vocabulary as MCP resources `kyx://playbook` and `kyx://vocab` (`tools.ts:7997-8012`), pinned against the live parsers by `tests/mcp-onboarding.test.ts`.

⚠ The playbook says "39-tool index" — **correct at the audited commit** (39 tools). It drifts the moment a tool is added, which is exactly what the in-flight `kyx_separate` does. **Minor, Code-inferred.**

### 6.2 Input parameters, filtering, pagination, scope — **good, with two holes**

Excellent where it exists: `kyx_notes op:list` validates `offset` (0..1 000 000) and `limit` (1..40), returns `nextOffset`, and states "notes 12–40 of 63" (`tools.ts:6710-6745`). `kyx_state` has a `family` filter with write-side family resolution (`familyTrackFilter`, `tools.ts:13342-13349`) so a "kick" ask sees the drum track's chain.

Two holes:

- **Nine behaviour-changing inputs are declared in no tool's schema.** The runtime augmentation adds only `requestId`, `agentId`, `dryRun` (`tools.ts:3490-3507`), yet these materially change behaviour:

| Parameter                                                                     | Read at                        | Effect                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `force`                                                                       | `tools.ts:4728`, `:4780`       | **Bypasses the stale-write guard and the scope guard together** (`write-conflict.ts:54`, `scope-guard.ts:158`) |
| `projectRevision`                                                             | `permissionLattice.ts:175-178` | Triggers the `STALE_REVISION` refusal                                                                          |
| `scope`                                                                       | `scope-guard.ts:234-245`       | Enables path confinement                                                                                       |
| `kyx_export.autofix`                                                          | `tools.ts:7399`                | **Mutates the document** via `setMasterConfig` (7400-7405)                                                     |
| `kyx_batch.atomic`                                                            | `tools.ts:10776`               | Flips between partial-commit and `PARTIAL_FAILURE`                                                             |
| `targetHfShare` / `targetLowEndShare` / `targetCrestDb` / `targetCorrelation` | `tools.ts:12868-12871`         | Master-iterate targets                                                                                         |

That is **nine** parameters. The number is not a guess — `scripts/audit-mcp-observation.mjs` measures it by walking the AST of `tools.ts` and the three guard modules, reading every property fetched off the call arguments, and subtracting every property any tool declares:

```bash
node scripts/audit-mcp-observation.mjs
```

The measurement has two subtleties worth recording, because both would have produced a wrong number:

- **A `record` is not always the call arguments.** `record` is also a persisted checkpoint record (`tools.ts:8519`) and a meter snapshot (`tools.ts:11186`). Counting those yields false positives; the instrument therefore only counts a `record.X` read inside a function that binds `record` to the arguments.
- **A name collision hides a real gap.** Three tools declare a tool-local `scope` (`kyx_meter`, `kyx_render_summary`, `kyx_diagnose_mix`). The ENVELOPE `scope` — the path-confinement declaration — is a different concept, read by `scope-guard.ts`. A naive "declared anywhere" filter excuses it and the gap disappears. The instrument separates the envelope contract from the tool contract for exactly this reason.

An agent reading the schema cannot discover any of the nine. `kyx_export.autofix` is the worst case: the trust layer knows it is a mutation (`agentTrust.ts:164` classifies `autofix:true` as `"mutate"`) but the schema does not say so.

### 6.3 Response shape, schema stability, units, types, precision, timestamps — **mixed**

- **26 of 39 tools declare an `outputSchema`.** The 13 that do not: `kyx_intent`, `kyx_state`, `kyx_export`, `kyx_generate`, `kyx_fx`, `kyx_tracks`, `kyx_pattern`, `kyx_automation`, `kyx_clips`, `kyx_checkpoint`, `kyx_song`, `kyx_unsuno`, `kyx_master`.
- **The most-read tool is among them.** `kyx_state` — the agent's primary read — has **no output schema**, and returns a **formatted text string** for 16 of its 17 subjects. Only `subject:"mixer"` gets a machine-readable twin (`tools.ts:5328` → `mixerSnapshotData`, `:4279-4303`).
- **No result carries a timestamp.** `McpToolResult` (3814-3865) has no such field. The only time values anywhere on the surface are `lastSavedAt` inside `kyx_save`'s data and `project.updatedAt` in the project listing.
- **Units are inconsistent by tool.** `kyx_state tracks` prints gain as **linear + dB** (`0.90 (−0.9 dB)`, `tools.ts:13400`); `kyx_state mixer` prints **dB only** (`−0.9 dB`, `:13435`); `mixerSnapshotData` prints **dB, rounded to 0.1** (`:4280`); `kyx_state sends` prints send levels as **0–1 decimals** (`:13510`). An agent comparing a track gain from `tracks` against one from `mixer` is comparing two precisions and two unit framings.
- **The truncation is honest** — `… and 14 more strip(s)` (`tools.ts:13462`), `… and 8 more track(s)` (`:13487`). Good practice, rare in agent surfaces.

### 6.4 Stable entity IDs versus display names and indexes — **good**

The surface consistently exposes ids: `id=<trackId>` in `tracks` (`:13398`), `id=` in `sends` (`:13502`), `(id=<clipId>)` in `mixer` (`:13447`), `noteId`, `markerId`, `laneId`, `fxId`, `returnId`. `kyx_notes` prefers stable note ids but keeps indices compatible (`:6690-6703`). `kyx_tracks` errors quote the available ids so the agent can recover (`tools.ts:6553`). This is above the norm.

### 6.5 Explicit unknown / unavailable / stale / permission-denied states — **the strongest dimension**

This is where KYX is genuinely ahead:

- **A closed 14-code error taxonomy** (`tools.ts:3905-3919`) with one shaped constructor `mcpError()` (`:3926`) that a test enforces to be exhaustive (`tests/mcp-error-codes.test.ts` — "GATE: every error result is constructed through mcpError — no un-coded literals", verified green in this audit).
- **`unavailableByDesign`** — `{supported, reason, revisit}` for project open, audio import, recording, and cancellation (`tools.ts:4341-4359`). The agent is told what is withheld, why, and what would change the answer.
- **`UNAVAILABLE_ON_TRANSPORT`** when a hook is absent (`tools.ts:5304-5307`).
- **Explicit freshness** on the render path: `freshness: "current" | "stale" | "unknown"` (`render-summary.ts:55`, `:242-247`).
- **Explicit caveats** with codes `frozen-playback-uses-project-tempo | freshness-unknown | source-window-approximate` (`src/analysis/contract.ts:50-52`).
- **Explicit "not-measured"** delivery checks (`src/mastering/profiles.ts:310-313`, `:351-355`).
- **`PARTIAL_FAILURE`** with a `status:"partial"` payload across groove, batch, automation, music, sections, notes, plugin params, steps.

**But the taxonomy itself has a defect:** the doc comment at `tools.ts:3877` says "Eight codes", the prose enumerates ten, and the union has **fourteen** — `REQUEST_ID_CONFLICT`, `INVALID_REQUEST_ID`, `CONFIRMATION_REQUIRED` and `RESOURCE_LIMIT` are undocumented. Verified by reading `tools.ts:3877-3919`.

### 6.6 Snapshot consistency and project/session/version identifiers — **weak**

- `docId`/`docName` are attached **only when `result.mutated === true`** (`tools.ts:5190-5197`). A read result names no document.
- No result carries the revision, despite `ctx.getRevision` existing (`tools.ts:3644`).
- No result carries the session id, despite `prepared.sessionId` existing internally (`tools.ts:4976`).
- **Consequence:** an agent holding two read results cannot tell whether they describe the same document state. The one read that _is_ versioned (`kyx_render_summary` track-window) is versioned for the render, not for the state that produced the request.

### 6.7 Update frequency, event delivery, subscriptions, polling costs — **partial**

There is **no push/subscribe channel** to the agent — only polling. Costs:

| Read                      | Cost          | Notes                                                                                                                   |
| ------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `kyx_state`               | cheap         | Pure document walk. The `mixer` subject warms the factory preset bank first (`:5287-5289`) — a chunk load on first use. |
| `kyx_meter`               | cheap         | Main-thread `AnalyserNode` read; 12 ms TTL cache.                                                                       |
| `kyx_render_summary`      | **expensive** | Full offline render of the scope.                                                                                       |
| `kyx_diagnose_mix`        | **expensive** | Master render **plus** a per-track stem render (`mix-diagnosis.ts:450`, `:464-465`).                                    |
| `kyx_audio_preview`       | **expensive** | Full render, up to 3 MB of WAV.                                                                                         |
| `kyx_loudness op:measure` | **expensive** | Renders, then measures.                                                                                                 |
| `kyx_mix_idea preview`    | **expensive** | Renders twice — before and after (`mix-preview.ts:181-183`).                                                            |

**No render is ever reused.** "Compare the mix before and after my change" costs two full renders, and the same render never serves two tools. This is a Phase-6 efficiency finding with a real cost, and it is also a Phase-4 freshness risk: nothing caches, so nothing can go stale — but nothing is cheap either.

### 6.8 Error taxonomy, partial results, timeouts, cancellation, retry — **good, with two holes**

- Per-call deadline/abort (`tools.ts:5015-5021`); `CANCELLED` code; long-running tools enumerated in `LONG_RUNNING_AGENT_TOOLS` (`agentTrust.ts:218-228`) and surfaced in the Job Center.
- ⛔ **No cooperative cancellation** — documented (`unavailableByDesign.cancellation`, `tools.ts:4360-4364`).
- ✅ Idempotency via `requestId` with a ledger, a `REQUEST_ID_CONFLICT` code, and a `current` diff on replay (`McpCurrentState.moved` / `.changed[]`, `tools.ts:3868-3873`, `:3939-3948`). **This is the best retry semantics in the surface.**
- **Hole 1 — `kyx_unsuno` and `kyx_separate` return failures with no `isError` and no `errorCode`** (`tools.ts:12371-12465`, `:12348-12359`). Every other refusal path goes through `mcpError`. A failed separation is indistinguishable from a successful read without parsing prose. _(Both are in-flight peer files — `kyx_separate` is a parallel session's new tool.)_
- **Hole 2 — two error vocabularies for one event.** The audit log records `"SCOPE_VIOLATION"` and `"THREW"` (`tools.ts:5095`), neither of which is in the closed `McpErrorCode` set; the caller-visible refusal for that same scope violation is `POLICY_REFUSED` (`:5116`). An agent branching on codes cannot distinguish a scope refusal from a destructive-lock refusal.

### 6.9 Information density and token efficiency — **mixed**

Good: family filters, `limit`/`offset` pagination, honest truncation counts, `kyx_state` subjects that let the agent drill down instead of dumping the whole project, and `kyx://project/{overview,pattern,mix,arrangement,history}` resources for a cheap overview before deep queries.

Poor: the primary read returns **prose**, not fields. The agent must parse `kick: 8 steps [1 0 0 1 …] vel≈0.72` or `id=tr-3, instrument, gain 0.90 (−0.9 dB)` out of a formatted line. That is token-expensive _and_ fragile — a formatter change silently breaks parsing, with no schema to catch it.

### 6.10 Security, authorization, redaction, auditability — **strong**

- Risk classes, a permission lattice (`auto | confirm | forbid`) over four risk classes, gated by a **user-granted standing consent** (`pf:mcp-allow-mutations`, `flags.ts:30`, `:55-70`) with the host hook winning over the persisted flag (`permissionLattice.ts:193-196`).
- "External" means any agent id ≠ `"local"` (`permissionLattice.ts:92-94`).
- **Data minimisation is real:** the audit log stores only a **bounded scalar summary** of arguments — primitives and array lengths, each capped, total capped (`agentTrust.ts:355-370`). A `kyx_notes` call carrying hundreds of notes does not write hundreds of notes to storage. The log is localStorage-only, ≤200 entries, best-effort (`agentTrust.ts:232-233`, `:325-331`).
- `kyx_state subject:"model-misses"` is explicitly local-only and never telemetered (`tools.ts:13570-13574`).
- ✅ **`kyx_separate`'s neural tier is refused on the agent surface** — "the neural tier is not an agent surface (it downloads an 80 MB model)" (`tools.ts:12331`). Correct least-privilege call.

**The hole is authorisation scope, not data handling.** The consent gate covers only `mutate`/`destructive` (`permissionLattice.ts:152`). `runtime`-class tools — `kyx_export`, `kyx_save`, `kyx_publish_gallery`, `kyx_audio_preview`, `kyx_transport` — are decided **`auto`** even when `allowExternalMutations: false`. **An external agent can therefore publish to the public gallery and write export files with mutation consent OFF.** See OBS-03.

---

## 7. State freshness and divergence findings

### 7.1 The three freshness regimes

| Regime             | Mechanism                                                                                | Carries revision?                        | Carries timestamp?                              | Honest about its own limits?          |
| ------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------- | ------------------------------------- |
| **Live meter**     | 12 ms TTL, wall-clock keyed (`meteringRig.ts:264-268`)                                   | ❌                                       | ❌ (`metering-types.ts:15-28` has no timestamp) | ❌                                    |
| **Render-backed**  | revision captured before the first `await`, compared after (`render-summary.ts:201-247`) | ✅ **but only on the track-window path** | ❌                                              | ✅ `freshness: current/stale/unknown` |
| **Contract-level** | caveat codes (`contract.ts:50-52`, `:129-134`)                                           | ✅ `producedAtRevision`                  | ❌                                              | ✅                                    |

**Finding.** The freshness machinery exists and works — but it is attached to **one** path of forty tools. Everything else is unversioned.

### 7.2 Two silent measurement-quality hazards

1. **The live LUFS number may be an approximation, and does not say so.** `meteringRig.ts:280-283` uses the exact BS.1770 K-weighted worklet when loaded, and otherwise falls back to `lufsFromChannels` — _"Approximate BS.1770 loudness from a stereo window (K-weighting is omitted for the lightweight live path)"_ (`src/audio-engine/metering.ts:36-37`). `kyx_meter` returns `lufsIntegrated` from that snapshot without reporting which branch produced it. **The same field name carries two different quantities.**

2. **Track peak and master peak are different quantities.** The master path uses a 4× oversampled true peak (`meteringRig.ts:279`; `metering.ts:621` `truePeakOversampled`), while per-track peak/RMS is a sample peak computed over `analyser.fftSize` samples (`src/mcp/meters.ts:44-56`). Comparing a track `peakDb` to the master `truePeakDb` compares an intersample peak to a sample peak. **Verified.**

### 7.3 Optimistic updates and asynchronous engine acknowledgements

The UI optimistically updates: `previewTrackGain` writes the fader live during a drag, using the same `audible ? gain : 0` logic as the commit path so a muted channel is not un-muted audibly (`AudioEngine.ts:3784-3793`). That is a _correct_ optimistic update — the preview matches the commit semantics.

The **agent** has no equivalent. Its write path is: command → document → receipt. The graph sync happens afterwards, deferred, and can fail. **There is no `stage` for "the engine rejected it".** `stage: "applied"` is honest about what it claims (`tools.ts:3783-3788`) — the problem is that the _next_ claim, "it is live", has no representation at all.

### 7.4 Invalidation after undo / redo / load / delete / reorder

| Event               | Invalidation behaviour                                                                                | Evidence                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Undo/redo           | Document replaced; `afterMutation()` bumps the revision                                               | `ProjectStore.ts:600-608`                          |
| Project switch      | `metering.syncProjectId` resets meter history; `warpManager.syncProjectId` clears stretch/warp caches | `meteringRig.ts:143-146`; `warpManager.ts:179-185` |
| Project switch      | `missedAssets` cleared — stale ids belong to the project that missed them                             | `AudioEngine.ts:1201-1206`                         |
| Engine sync failure | `lastProjectSyncFailure` cleared on the next successful sync                                          | `AudioEngine.ts:1211`                              |
| Collab (Yjs)        | **no revision counter** → freshness degrades to `"unknown"`, staleness rule skipped                   | `revision.ts:11-13`                                |

**Sound.** The engine's project-swap invalidation is careful and correct. The weakness is only that the **agent cannot see any of it**.

### 7.5 Compare-and-set, precondition tokens, event ordering, idempotency

- **Idempotency: strong.** `requestId` → ledger → replay returns the original result plus `current` (`McpCurrentState`), which reports _which written fields actually moved since the original call_ (`tools.ts:3939-3948`). This is a genuinely well-designed replay contract.
- **Stale-write guard: real.** The command carries `base` (the doc it was computed against) and `ops` (the paths it writes); `detectWriteConflict` compares the two and **refuses** the write (`write-conflict.ts:138-152`, `:53-66`), surfacing `WRITE_CONFLICT` with `path`, `expected`, `actual` (`tools.ts:5039-5046`). Nothing is written and no undo step is created.
- **Declared-revision precondition: weak.** `STALE_REVISION` requires _both_ numbers to be present and unequal (`permissionLattice.ts:139-150`); the declared value comes from an envelope key (`projectRevision`) that is in no tool's schema; no general read exposes the live revision; and on a Yjs store the revision is `null`, so the rule is skipped rather than faked.
- **Event ordering:** commands are applied inline through `ctx.execute`, guarded against deferred application (`tools.ts:3570-3587`, enforced by `tests/mcp-host-inline-execute.test.ts`). Good.

### 7.6 Race windows

| Race                                         | Window                                 | Containment                                                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Track deleted between read and write         | Between the agent's read and its apply | ✅ `WRITE_CONFLICT` if the path is in `ops`; ⚠ **a hand-written command with no `base`/`ops` bypasses all three guards** (`tools.ts:4970-4989`)                                                                   |
| Automation overrides a manual set            | Permanent                              | ❌ **no read resolves the effective value** — the agent cannot detect the override                                                                                                                                |
| Undo during a multi-step plan                | Between plan steps                     | ⚠ Undo is global LIFO; `allowForeign:true` waives the prompt (`tools.ts:5356-5369`). The agent can undo a human's work.                                                                                           |
| Engine rejects but UI optimistically updates | Sub-frame                              | ✅ correctly handled for the UI; ❌ invisible for the agent                                                                                                                                                       |
| Project switch mid-read                      | During an in-flight call               | ⚠ No project-id precondition on reads. `unavailableByDesign.projectOpen` prevents _initiating_ a switch, but a human can still switch.                                                                            |
| Analysis cache refers to an older render     | —                                      | ✅ **No analysis cache exists.** Every Ultina call spawns a fresh worker, terminated on settle (`ultinaAnalysisClient.ts:63`, `:108`). Staleness is impossible because reuse is impossible — but so is cheapness. |

---

## 8. Musical and audio observability

### 8.1 What the AI can measure today

| Layer                            | Examples                                                                                                                                                        | Reachable by the agent?              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Raw signal**                   | `AnalyserNode` time-domain data (`meters.ts:47-48`), rendered `Float32Array` PCM                                                                                | ✅ but **without unit metadata**     |
| **DSP metrics**                  | peak, RMS, crest, headroom, DC, clipped-sample count, 7 band shares, correlation (`mixDoctor.ts:25-33`, `:272-379`); BS.1770-4 gated LUFS (`kweighting.ts:378`) | ✅                                   |
| **Model-derived interpretation** | Ultina/TSAR instrument classification with `confidence` 0..1; tonal suggestions with `reasonCode`                                                               | ❌ **not reachable from `src/mcp/`** |
| **Subjective judgement**         | human blind A/B trials with an anti-haste filter (`BLIND_AB_HASTE_MS = 1500`, `blind-ab.ts:129`) and a "NOT legal clearance" disclaimer (`tools.ts:3251-3254`)  | ✅ (by recording a human's answer)   |

### 8.2 The findings that matter musically

1. **No frequency spectrum reaches the agent.** `getFloatFrequencyData` appears in exactly four files — `spectrogram.ts`, `qvesterProfileBus.ts`, `SpectrumAnalyzer.tsx`, `Spectrogram.tsx` — **none in `src/mcp/`**. The closest the agent gets is 7 aggregated band shares. "Is the lead masked by the bass?" is not answerable.
2. **No pitch content of the rendered mix.** `pitch-tracker.ts` exists; its importers are UI and intent only. The agent can read the _document's_ notes but cannot hear whether the render matches them.
3. **No onset/transient structure.** `transients.ts` is imported by browser-checks, bpm-detect, groove-extract and SliceLab — not by MCP. "Does the kick's attack survive?" is not answerable.
4. **No masking / interaction measurement.** `sectionMixDoctor.ts` computes 60–120 Hz masking and transient contrast; its consumers are `ReferenceMapPanel.tsx` and tests. **Not an agent surface.**
5. **No per-time-range measurement except one narrow window.** `kyx_render_summary` track-window is capped at 64 bars (`render-summary.ts:172`) and **renders the whole timeline then slices** (`:259`). "How loud is bar 33?" costs a full render; "how does the chorus differ from the verse?" has no surface at all.
6. **The mastering planner never receives spectral balance.** `tools.ts:12950-12951` passes `hfShare: null, lowEndShare: null` into `planReferenceMastering` — the two spectral quantities it accepts are never supplied from the live path.
7. **`kyx_mix_idea` reasons about the document, not the sound.** `planMixIdea(doc, idea, target)` (`mix-idea.ts:117`) takes a document and a text idea; **there is no render, no analyser, no meter call anywhere in the file.** This is the sharpest instance of the brief's question in the codebase: an agent can express "the mix feels muddy" and get a document-driven plan that is not conditioned on any measurement of the mix.
8. **The agent's "what does this sound like" channel is raw bytes.** `audio-preview.ts:108-112` returns base64 WAV with `bars`/`durationSec`/`sampleRate`/`byteLength`/`mimeType` — perfect for a multimodal model, useless as analysis.

### 8.3 The confidence field that is always empty

`src/analysis/contract.ts:78` declares `confidence: number | null`. The one MCP-reachable analyzer — `kyx-mix-health` (`render-summary.ts:174-179`) — defines **no `confidence` function**, so every `kyx_render_summary` track-window result reports `confidence: null`. The model-derived path that _does_ populate confidence (instrument classification, `effects/ultina-core/analysis/instrumentClassifier.ts:212-217`) is unreachable from the agent surface.

**So the agent can never ask "how sure are you?" about anything it measures.** The honest substitute is the caveat system (`freshness-unknown`, `source-window-approximate`, `frozen-playback-uses-project-tempo`) and the `not-measured` delivery checks — both good, both about _availability_ rather than _confidence_.

### 8.4 The claim the audit must not make

**A meter reading does not prove a mix is better.** KYX is careful about this in places — `kyx_blind_ab` exists precisely because a measurement cannot adjudicate taste, and it records a _human_ answer with a documented disclaimer. That discipline is a genuine asset and should be preserved in any proposal to "improve" observability: **adding analysis surfaces must not be sold as adding judgement.**

---

## 9. Context packaging and token efficiency

### 9.1 What the brief asks for, scored

| Requirement                                     | Present?      | Evidence                                                                                                                                                              |
| ----------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A concise project overview before deep queries  | ✅            | `kyx://project/overview` resource (`tools.ts:7960`); `kyx_state subject:"overview"`                                                                                   |
| Selective drill-down                            | ✅            | 17 `kyx_state` subjects; `family` filter; `kyx_notes` offset/limit; `kyx_render_summary` scope                                                                        |
| Diffs since a prior state version               | ◐ **partial** | `McpCurrentState.changed[]` exists but only on **idempotent replay** of the same `requestId` — not a general "diff since revision N"                                  |
| Clear truncation / pagination                   | ✅            | `nextOffset` on notes; "… and N more" on mixer/fxChain/sends                                                                                                          |
| Cheap metadata vs expensive analysis separation | ✅            | `kyx_state`/`kyx_meter` cheap; `kyx_render_summary`/`kyx_diagnose_mix`/`kyx_audio_preview` expensive; `LONG_RUNNING_AGENT_TOOLS` names them (`agentTrust.ts:218-228`) |
| Source provenance                               | ◐             | Only the render path (`render-summary.ts:133-142`: signal stage, window in ticks→samples→seconds, algorithm name+version, caveats). Everywhere else: none.            |
| Permission boundaries                           | ✅            | `unavailableByDesign` + `UNAVAILABLE_ON_TRANSPORT` + the risk table                                                                                                   |

### 9.2 The recommended tiered strategy — and what it costs today

The brief asks for **summary → scoped inspection → detailed analysis → targeted verification**. KYX has three of the four tiers, badly connected:

| Tier                     | Today                                                         | Cost                      | Gap                                                         |
| ------------------------ | ------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------- |
| 1. Summary               | `kyx://project/overview`, `kyx_state overview`                | cheap                     | ⚠ prose, no schema                                          |
| 2. Scoped inspection     | `kyx_state` subjects, `kyx_notes`, `kyx_clips`, `kyx_routing` | cheap                     | ⚠ prose; no stable ids in some subjects                     |
| 3. Detailed analysis     | `kyx_render_summary`, `kyx_diagnose_mix`, `kyx_loudness`      | **full render each time** | ❌ no reuse; no tier-3 → tier-4 bridge                      |
| 4. Targeted verification | `kyx_meter`                                                   | cheap                     | ⚠ no revision, no timestamp, no "which measurement is this" |

**The missing connective tissue is a version token.** If every read carried the revision it observed, the agent could say "read the mix at revision 412, measured at revision 412" and a later "measure at revision 419" would be self-evidently different. Today, `freshness` exists on exactly one path.

---

## 10. Failure and adversarial scenarios

Each scenario is scored against the code. **No destructive scenario was run against a user project** — the read-only analysis and the test suites are the evidence; the reproduction recipes use fixtures and the headless host.

| #   | Scenario                                                             | Current behaviour                                                                                                                                                                                                       | Verdict                                                                                                                 |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tool reads state during active recording**                         | `kyx_undo` and the intent path refuse with `POLICY_REFUSED` (`tools.ts:5407-5408`, `:14067-14068`)                                                                                                                      | ⚠ **partial** — the refusal leaks the fact, but there is no state read                                                  |
| 2   | **Track deleted between observation and action**                     | `UNKNOWN_TARGET` when the id resolves to nothing                                                                                                                                                                        | ✅ **handled**                                                                                                          |
| 3   | **Automation overrides a manually set parameter**                    | Nothing detects it — no read resolves the effective value                                                                                                                                                               | ❌ **unhandled**                                                                                                        |
| 4   | **Undo occurs while a multi-step AI plan executes**                  | Undo is global LIFO; `allowForeign:true` waives the prompt (`tools.ts:5356-5369`); redo is unattributable — `labelsRevertedBy` returns `[]` because "redo history lives beyond the undo stack" (`attribution.ts:64-67`) | ❌ **unsafe**                                                                                                           |
| 5   | **Engine rejects a parameter value but UI optimistically updates**   | The UI preview matches commit semantics (`AudioEngine.ts:3784-3793`); the engine records the failure; **the agent is never told**                                                                                       | ⚠ **partial**                                                                                                           |
| 6   | **Media asset missing or not decoded**                               | `missedAssets` is tracked per project (`AudioEngine.ts:1201-1206`)                                                                                                                                                      | ◐ **engine knows, agent does not**                                                                                      |
| 7   | **Two operations race to edit the same clip**                        | `WRITE_CONFLICT` refuses the stale write with `path`/`expected`/`actual` (`write-conflict.ts:138-152`)                                                                                                                  | ✅ **handled** — unless the command has no `base`/`ops`                                                                 |
| 8   | **Project switches while an observation request is in flight**       | Project switching is not an MCP capability by design; a human switch is not blocked                                                                                                                                     | ◐ **design boundary, real race**                                                                                        |
| 9   | **Audio analysis cache refers to an older render**                   | There is no analysis cache — every call is fresh                                                                                                                                                                        | ✅ **structurally impossible** (at a compute cost)                                                                      |
| 10  | **Tool returns partial data or times out**                           | `PARTIAL_FAILURE` + `status:"partial"`; per-call deadline; `CANCELLED`                                                                                                                                                  | ✅ **handled**                                                                                                          |
| 11  | **Permission changes during an operation**                           | The lattice is checked pre-dispatch (`:4747-4772`); the destructive D4 lock is a separate per-site gate                                                                                                                 | ◐ **pre-dispatch only**                                                                                                 |
| 12  | **Large project exceeds response-size limits**                       | Honest truncation on mixer/fxChain/sends; `limit` capped at 40 for notes; `RESOURCE_LIMIT` code exists                                                                                                                  | ✅ **handled**                                                                                                          |
| 13  | **The headless host is evaluated instead of the shipped transports** | `src/mcp/headless-host.ts:38-43` defaults **`allowMutations` ON** — deliberately, because it is not network-exposed                                                                                                     | ⚠ **an eval run in CI proves nothing about the shipped consent gate.** The web relay and desktop stdio gate by default. |

**Net:** 5 handled, 4 partial, 2 unsafe, 1 structurally avoided, 1 measured-elsewhere. The two unsafe ones (#3 automation override, #4 undo-during-plan) are both about the agent's **belief about state**, not about a crash — which is exactly the class the brief calls "silent wrong action".

---

## 11. Maturity scorecard (0–5)

Definitions: 0 absent · 1 fragmentary · 2 basic reads · 3 useful scoped observations · 4 consistent and verifiable · 5 robust closed-loop, versioned, tested behaviour.

| Category                                        | Score | Evidence for the score                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Project / arrangement visibility**            | **3** | 17 `kyx_state` subjects, stable ids, family filters, 8 MCP resources. Held back from 4 by: prose-only output for 16/17 subjects, no schema, no doc id on reads, no clip-gain read.                                                                                                                                             |
| **Timeline and selection visibility**           | **3** | `kyx_clips`, `kyx_notes` with real pagination, `kyx_markers`, `kyx_sections`, `kyx_state scenes`. Held back by: no snap outcome, no selection concept at all — the agent has no way to know what the user has selected.                                                                                                        |
| **Mixer / routing / effects visibility**        | **4** | The best-observed domain. `kyx_state mixer` has a **structured twin** (`mixerSnapshotData`), `kyx_state sends` gives the full routing map, `kyx_routing` has 8 ops with structured read-back. Held back by: inconsistent units/precision across subjects, and effect **parameter** values not present in the chain view.       |
| **Automation visibility**                       | **3** | Lanes, targets, point values, ranges, scene curves (`automationSnapshot`, `tools.ts:13352-13379`), honest truncation at 8 points. Held back by: **no effective-value resolution at a tick** — the single most consequential gap.                                                                                               |
| **Audio signal and analysis visibility**        | **2** | Basic DSP metrics and loudness exist and are reachable. But: no spectrum, no pitch, no transients, no masking, no confidence, model layer unreachable, every measurement is a fresh full render.                                                                                                                               |
| **Recording and transport visibility**          | **3** | Transport is well covered (`kyx_transport` 10 actions, structured output). Recording is **deliberately closed** and correctly documented — but its _state_ is not readable, which is why the score is 3, not 5.                                                                                                                |
| **State freshness and consistency**             | **2** | The machinery exists (revision counter, stale-write guard, idempotency + `current` diff, freshness on one path) but is **attached to almost nothing**. No read result carries a revision or timestamp.                                                                                                                         |
| **Read / write / verify parity**                | **2** | Writes are strong and receipted. Verification stops at the document boundary: no engine stage, no audible stage, and three write/read pairs with no matching read.                                                                                                                                                             |
| **Permissions and privacy**                     | **4** | Risk table, permission lattice, user-granted consent, least-privilege design, data minimisation in the audit log, `unavailableByDesign` policy records, neural tier refused. Held back by: `runtime` tools bypass the external-consent gate (OBS-03) and `force` disables two independent guards at once (OBS-04).             |
| **Failure reporting and observability testing** | **4** | Closed 14-code taxonomy with an enforced constructor, 68 MCP-contract spec files, `PARTIAL_FAILURE` discipline, `not-measured` states, live proof that the taxonomy guards fail when they should. Held back by: two tools return errors without `isError`/`errorCode`, and the audit log records codes outside the closed set. |

### 11.1 Critical blockers (reported separately — not averaged away)

| #      | Blocker                                                                                                                                                                                                                                 | Why it is a blocker, not a gap                                                                                                                                                                                                                                                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** | **The engine's "graph is not whole" fact is unreachable from every agent surface.** `AudioEngine.projectSyncFailure` (`AudioEngine.ts:1166`) is a public getter; the export path consults it; no MCP tool and no UI component reads it. | The agent's receipt says `applied` — a **document** claim — while the audio graph may be half-built. The agent cannot distinguish "my change is live" from "my change is in the document but the graph rejected it". This is the exact failure mode the brief names: _"never collapse these into one success claim."_ |
| **B2** | **The agent cannot resolve the effective value of an automated parameter.**                                                                                                                                                             | The agent can set a gain that automation then overrides, and has no read that would reveal the override. It will confidently report a change that has no audible effect.                                                                                                                                              |
| **B3** | **Undo is global LIFO and `allowForeign: true` waives the human prompt.**                                                                                                                                                               | An agent can revert the user's own work, and a redo receipt says only `redo ×2` (`attribution.ts:64-67`). The user's work is not recoverable by attribution.                                                                                                                                                          |
| **B4** | **Nine behaviour-changing inputs are invisible in the schemas, one of which (`kyx_export.autofix`) mutates the document.**                                                                                                              | The agent cannot discover `force`, `scope`, `projectRevision`, `autofix`, `atomic`, or four master-iterate targets from the contract it is given. `autofix` is a mutation the schema does not declare.                                                                                                                |

---

## 12. Top 15 gaps

Severity: **Critical** / **High** / **Medium** / **Low**. Status: `Open` (needs work) · `Proposal` (architectural) · `By-design` (documented, intentional) · `Fixed` (applied in this audit).

| ID     | Title                                                                            | Severity     | Confidence | Status |
| ------ | -------------------------------------------------------------------------------- | ------------ | ---------- | ------ |
| OBS-01 | The engine's graph-sync failure is invisible to every agent surface              | **Critical** | Verified   | Open   |
| OBS-02 | No read resolves the effective (post-automation) parameter value                 | **Critical** | Verified   | Open   |
| OBS-03 | `runtime`-class tools bypass the external-agent consent gate                     | **High**     | Verified   | Open   |
| OBS-04 | `force: true` disables the stale-write guard and the scope guard together        | **High**     | Verified   | Open   |
| OBS-05 | No observation result carries a revision, a timestamp, or a document identity    | **High**     | Verified   | Open   |
| OBS-06 | Nine behaviour-changing inputs are declared in no tool's schema                  | **High**     | Verified   | Open   |
| OBS-07 | The post-write scope verifier `verifyScope` is never called                      | **High**     | Verified   | Open   |
| OBS-08 | Scope confinement is opt-in; an undeclared scope means unconstrained             | **High**     | Verified   | Open   |
| OBS-09 | The declared-revision precondition is opt-in and unsatisfiable                   | **High**     | Verified   | Open   |
| OBS-10 | Undo is global LIFO; redo is unattributable; `allowForeign` waives the prompt    | **High**     | Verified   | Open   |
| OBS-11 | Hand-written commands bypass all three write guards                              | **High**     | Verified   | Open   |
| OBS-12 | The live LUFS number may be an approximation and does not say which              | **Medium**   | Verified   | Open   |
| OBS-13 | Track peak (sample) and master peak (intersample) are one field each, unlabelled | **Medium**   | Verified   | Open   |
| OBS-14 | `kyx_state` returns prose for 16 of 17 subjects; only `mixer` is structured      | **Medium**   | Verified   | Open   |
| OBS-15 | The generated MCP mirrors are on the critical path of execution                  | **Low**      | Verified   | Open   |

---

## 13. Target architecture (proposal — no code changed for this)

The architecture below is a **proposal**. Nothing in §13 was implemented; the brief requires a documented safety gate first, and the only changes made in this audit are the ones in §15.

### 13.1 One observation contract, four carriers

```
                 ┌─────────────────────────────────────────────┐
                 │  Every MCP result carries an OBSERVATION     │
                 │  HEADER — the same fields, always:            │
                 │                                              │
                 │   observedAt      ISO-8601 timestamp          │
                 │   projectId       which document              │
                 │   revision        the document's version      │
                 │   sessionId       which agent session         │
                 │   scope           what was read/written       │
                 │   freshness       current | stale | unknown   │
                 │   confidence      number | null, with reason   │
                 │   truncated       { by, total, shown }        │
                 └─────────────────────────────────────────────┘
```

Seven fields. Every tool. This is the smallest change that converts the surface from "a pile of prose" into "a set of observations an agent can reason about", and it is **backwards-compatible** — additive fields on `McpToolResult` (`tools.ts:3814-3865`), plus a `McpObservationHeader` in `data`.

### 13.2 Four distinct success stages, never collapsed

| Stage           | Meaning                                 | Source of truth       | How the agent obtains it                                                                                |
| --------------- | --------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
| `accepted`      | the command was understood and admitted | command layer         | the receipt itself                                                                                      |
| `applied`       | the **document** changed                | `ProjectStore`        | `verifiedMutation` (already exists)                                                                     |
| `engine-synced` | the **audio graph** accepted the change | `AudioEngine`         | `whenProjectSettled()` + `projectSyncFailure` — **both already exist** (`AudioEngine.ts:1177`, `:1166`) |
| `audible`       | the change is measurable in the signal  | a measurement surface | `kyx_render_summary` / `kyx_meter` — the agent's choice, at a known cost                                |

Today the enum is `read | runtime | applied | persisted | rendered | delivered | dry-run | replayed | noop` (`tools.ts:3787-3788`). Adding `engine-synced` is an **additive** change to a string union, and the getter it needs is already public.

### 13.3 Reads that answer the write

The missing read primitives, in priority order:

1. **`kyx_state subject:"effective"`** — resolve any parameter (track gain, plugin param, master) at a given tick, through automation, with the owning lane and the manual value alongside. This closes OBS-02 and the brief's own example.
2. **`kyx_state subject:"effects"`** — one call returning the full chain **with parameter values, units and ranges**, so the brief's EQ example becomes one read.
3. **`kyx_state subject:"recording"`** — armed tracks, punch range, take mode, input device. Read-only, cheap, and it makes the `POLICY_REFUSED` side effect unnecessary as the only signal.
4. **`kyx_clips op:list` should carry `gain`, `mute`, `offset` and the **snap outcome** of the last move.**

### 13.4 One declared surface for the envelope

`force`, `scope`, `projectRevision` should become **declared, documented parameters** — on every tool that honours them, or on a single envelope-level schema. An agent that cannot see `force` cannot use it responsibly; an agent that can see it can at least be asked to justify it.

### 13.5 Trust that grows with evidence

The lattice is a binary risk × consent decision (`permissionLattice.ts:136-168`). The per-agent state is only `{sessionId, calls, mutations, checkpointName}` (`agentTrust.ts:262-275`). A graduated model — read-only sessions, then scoped writes, then broader writes, earned by verified (not merely reported) outcomes — is the natural extension of what already exists. **This is a design change, not a fix, and it needs explicit approval.**

---

## 14. 30 / 60 / 90-day roadmap

### Days 0–30 — close the blind spots that can mislead (no architectural change)

| #   | Item                                                                                                                                           | Gap                                | Effort                                                                                   | Approval                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | Expose `AudioEngine.projectSyncFailure` and `whenProjectSettled()` through the MCP context; add `stage:"engine-synced"` to the completion enum | OBS-01 / B1                        | **small** — both getters are public; one context field, one stage member                 | not required                               |
| 2   | Add `observedAt`, `projectId`, `revision` to every `McpToolResult`                                                                             | OBS-05                             | **small** — additive; `ctx.getRevision` already exists (`tools.ts:3644`)                 | not required                               |
| 3   | Attach `docId`/`docName` to read-only results too                                                                                              | OBS-05                             | **trivial** — move the assignment out of the `mutated === true` branch (`tools.ts:5190`) | not required                               |
| 4   | Declare `force`, `scope`, `projectRevision`, `kyx_export.autofix`, `kyx_batch.atomic` and the four master-iterate targets in their schemas     | OBS-06                             | **small** — schema-only, no behaviour change                                             | not required                               |
| 5   | Split `force` into two flags (`forceStaleWrite`, `forceScope`)                                                                                 | OBS-04                             | **small**                                                                                | **recommended** — changes a safety default |
| 6   | Route `kyx_unsuno` / `kyx_separate` refusals through `mcpError`                                                                                | §6.8 hole 1                        | **trivial**                                                                              | not required                               |
| 7   | Document the four undocumented error codes; fix "Eight codes" → "Fourteen"                                                                     | §6.5                               | **trivial**                                                                              | not required                               |
| 8   | Route the `SCOPE_VIOLATION` / `THREW` audit codes into the closed set (or document them as a separate field)                                   | §6.8 hole 2                        | **small**                                                                                | not required                               |
| 9   | Add `kyx_meter` fields `lufsSource: "kweighted"                                                                                                | "approximate"`and`peakKind: "true" | "sample"`                                                                                | OBS-12 / OBS-13                            | **small** | not required |
| 10  | Generate the playbook's tool index from `MCP_TOOLS` instead of writing it by hand                                                              | §6.1                               | **small**                                                                                | not required                               |

### Days 31–60 — make reads answer writes

| #   | Item                                                                                       | Gap         | Effort                                                                        |
| --- | ------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------- |
| 11  | `kyx_state subject:"effective"` — resolve a parameter at a tick through automation         | OBS-02 / B2 | **medium** — needs the automation bridge's resolution logic exposed read-only |
| 12  | `kyx_state subject:"effects"` — chain **with** parameter values, units and ranges          | §4.1        | **medium**                                                                    |
| 13  | `kyx_state subject:"recording"` — armed tracks, punch, take mode, device                   | §4.1        | **small–medium**                                                              |
| 14  | `kyx_clips op:list` — carry `gain`, `mute`, `offset`, and the last move's **snap outcome** | §5 #1/#3    | **small**                                                                     |
| 15  | Wire `verifyScope` into the executor as a **post-write** check                             | OBS-07      | **medium** — the function exists and is tested; it is simply not called       |
| 16  | Make scope confinement **default-deny** for external agents, with an explicit opt-out      | OBS-08      | **medium** — a default change, needs approval                                 |
| 17  | Give `kyx_render_summary` a revision + freshness on **all** scopes, not only track-window  | §7.1        | **small**                                                                     |
| 18  | A read-side diff: `kyx_state subject:"diff" {fromRevision, toRevision}`                    | §9.1        | **medium**                                                                    |

### Days 61–90 — depth, reuse, and the musical layer

| #   | Item                                                                                                                                               | Gap         | Effort                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| 19  | **Render reuse cache** keyed by (projectId, revision, scope) — one render serves meter, render-summary and diagnose-mix                            | §6.7        | **medium** — needs a correctness story (the cache key must include the revision, or it becomes OBS-09's stale-data bug) |
| 20  | Expose a **coarse spectrum** (the existing 7-band shares plus a per-track band set) to the agent                                                   | §8.2 #1     | **medium**                                                                                                              |
| 21  | Populate `confidence` on the `kyx-mix-health` analyzer, with a documented derivation                                                               | §8.3        | **medium** — a calibration decision, not a code trick                                                                   |
| 22  | Route the Ultina model analysis to the agent surface **as read-only, on an explicitly authorised hook**                                            | §8.1        | **large** — needs an authorisation decision (model download, compute budget)                                            |
| 23  | Per-agent undo isolation, or at minimum: refuse `allowForeign:true` for external agents, and attribute redo                                        | OBS-10 / B3 | **medium–large** — a real design change                                                                                 |
| 24  | Close the hand-written-command guard gap: either require `base`/`ops` on every mutating command, or maintain a reviewed exemption list with a test | OBS-11      | **medium**                                                                                                              |
| 25  | `kyx_batch` should declare `atomic` and honour it as a single undo transaction                                                                     | OBS-06      | **small**                                                                                                               |
| 26  | A graduated trust model with per-agent capability narrowing                                                                                        | §13.5       | **large** — needs explicit approval                                                                                     |

---

## 15. Implemented low-risk fixes, tests, and rollback notes

**None.** This audit changed **no production code**, by design: the brief says _"Do not modify code until the observability map and risk assessment are complete"_, and the map and risk assessment are this document.

What _was_ produced, and it is in the repository:

| Artefact                                       | What it is                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_OBSERVABILITY_AUDIT_REPORT.md` (this file) | The audit                                                                                                                                                                                                                                                     |
| `scripts/audit-mcp-observation.mjs`            | The measurement instrument: parses the `MCP_TOOLS` literal with the TypeScript compiler API and prints the per-tool contract table, the risk distribution, the tools with no output schema, and the behaviour-changing inputs that no schema declares (§15.1) |
| `tests/audit-observation-contract.test.ts`     | The **ratchet** that pins both gap classes so they cannot grow unnoticed (§15.2)                                                                                                                                                                              |

> A third artefact was planned — a cross-surface name-set diff for OBS-15 — and was **dropped as redundant**: `npm run verify:mcp-mirrors` and `tests/mcp-mirror-sync.test.ts` already do that job, better, and are already in `verify:all`. Writing a second drift detector for a drift that is already gated would have been noise.

### 15.1 The instrument

`scripts/audit-mcp-observation.mjs` prints, for every tool: name, definition line, declared input properties, required inputs, enum values per input, whether an `outputSchema` exists and what it declares — plus the risk distribution, the tools without an output schema, and the undeclared behaviour-changing inputs. It is **read-only** and needs no dev server.

```bash
node scripts/audit-mcp-observation.mjs                 # the human table
node scripts/audit-mcp-observation.mjs --json          # machine-readable
node scripts/audit-mcp-observation.mjs --root <path>   # audit another checkout
```

It parses with the TypeScript compiler API rather than regex, because shorthand properties, computed keys and element access are invisible to a regex — and two of the nine undeclared inputs (`scope`, `projectRevision`) are read as `envelope["scope"]` and `envelope["projectRevision"]`. A regex instrument would have reported **seven** and missed both.

### 15.2 The ratchet

`tests/audit-observation-contract.test.ts` pins two gap classes:

1. the set of tools that declare **no** `outputSchema` (13 at the audited commit);
2. the set of behaviour-changing inputs the MCP layer reads but **no** tool schema declares (9 at the audited commit).

It is a **ratchet, not a lint rule**. The tree already violates both, so a "must be empty" rule would be red from the first day and would train everyone to ignore it. Instead the known gaps are listed in the spec, and the spec fails when the list would **grow** — the direction that matters. A gap that gets closed is reported too, so the list cannot rot silently.

**Rollback:** all three artefacts are additive — delete the script and the one spec file; nothing else changes.

**Why the guard is trustworthy:** a guard that cannot fail is not a guard. Three independent proofs are recorded in §2.4 — the two existing taxonomy guards fired unprompted on an in-flight tool, the instrument was run against a synthetic probe tree carrying a deliberately undeclared read and reported it, and the ratchet's comparison was unit-tested on a synthetic set.

### 15.3 What was NOT run, and why

| Not run                                  | Why                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run build`                          | `public/` holds 336 tracked artefacts that `prebuild` rewrites; running it in a shared tree would churn other sessions' files.                                                                                                       |
| `npm run typecheck`                      | The audit changes no TypeScript. The tree carries 6 pre-existing errors in peer-owned files.                                                                                                                                         |
| Browser / live audio verification        | The box was saturated by parallel sessions; a dev server timed out. Audio-path claims are Code-inferred from source, never measured in a running app.                                                                                |
| `server/mcp-core.mjs` handler-body audit | The file is 244 KB; only its **tool-definition region** and the relay path were read. The question "do the mirrors re-implement handlers?" is now **answered** (§16.1 Q1): they carry generated _definitions_ and relay _execution_. |
| The full 1301-spec suite                 | The audit's subject is the MCP contract surface; 8 targeted suites (282 tests) were run instead.                                                                                                                                     |

---

## 16. Open questions and approval-required changes

### 16.1 Questions for the owner

1. ~~**`server/mcp-core.mjs` and `desktop/mcp-tool-defs.cjs` — do they re-implement tool handlers?**~~ **ANSWERED — no.** The tool catalogue exists three times on disk, but the two transport copies are **generated** by `scripts/generate-mcp-mirrors.mts` from `src/mcp/tools.ts` and gated by `npm run verify:mcp-mirrors` + `tests/mcp-mirror-sync.test.ts` (verified passing, 4/4). They carry _definitions_ and relay _execution_; there is exactly one implementation (`executeMcpTool`, `tools.ts:4711`). The residual issue is that the mirror sits on the **critical path** — `tools/call` validates the name against it — so it is a release-order rule, not a design flaw. See OBS-15.
2. **Should recording become AI-readable (not AI-writable)?** The current boundary is documented and defensible ("a take is unrecoverable live audio, not a document edit"). A **read-only** `kyx_state subject:"recording"` would not change that boundary — it would only tell the agent _why_ its calls are being refused. **Recommendation: yes, read-only.**
3. **Should `force` remain a single flag?** It currently disables two independent guarantees. **Recommendation: split it.**
4. **Is the agent's undo supposed to be able to touch the user's work?** Today it can, with `allowForeign: true`, and a redo receipt names nothing. **Recommendation: no for external agents.** This is a behaviour change and needs a decision.
5. **Should the model's perception layer (Ultina) ever be an agent surface?** It is the richest analysis in the repository and is currently unreachable. **Recommendation: not without an explicit authorisation and a compute-budget decision.**

### 16.2 Changes that need explicit approval before implementation

| #   | Change                                                      | Why it needs approval                                                                           |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A1  | Default-deny scope confinement for external agents          | Changes the default safety posture                                                              |
| A2  | Splitting `force` into two flags                            | Changes a documented escape hatch                                                               |
| A3  | Refusing `allowForeign:true` for external agents            | Changes undo semantics                                                                          |
| A4  | A graduated trust model with per-agent capability narrowing | A new authorisation concept                                                                     |
| A5  | Exposing Ultina/TSAR to the agent surface                   | Model download + compute budget + privacy scope                                                 |
| A6  | A render-reuse cache                                        | A cache is a staleness risk; it must be keyed by revision or it becomes a new divergence source |
| A7  | Adding `engine-synced` / `audible` to the public stage enum | A **public contract change** for external MCP clients — additive, but clients switch on `stage` |

### 16.3 Deliberate non-findings

Things that look like gaps but are **not**:

- **Recording being unwritable** — documented policy, correctly reasoned.
- **Project switching being unavailable** — the human owns the Project Browser; correct.
- **The neural separation tier being refused** — least privilege, correct.
- **Undo being global** — _partly_ correct: the DAW has one timeline, and per-agent undo is a large design change. The **redo attribution** half is not a design choice, it is a gap.
- **The absence of an analysis cache** — not a staleness bug; a compute cost.
- **The tool catalogue existing three times on disk** — the two transport copies are **generated** (`scripts/generate-mcp-mirrors.mts`) and gated (`npm run verify:mcp-mirrors`, `tests/mcp-mirror-sync.test.ts`, verified 4/4 green). There is one implementation. See OBS-15 for the residual release-order risk.
- **`kyx_separate` missing from the risk table** — in-flight peer work, caught by the existing guards exactly as designed. It is reported here as evidence that the taxonomy closure works, not as a defect.

---

## Appendix A — the full tool surface

**39 tools** at `c8729057` · risk distribution **read 3 / runtime 8 / destructive 7 / mutate 21** · 26 with an output schema · 13 without.

> A parallel session was adding a 40th tool (`kyx_separate`) during the audit. It is listed below with its **in-flight** status rather than silently counted — it is the tool both existing taxonomy guards caught unclassified.

| Tool                   | Risk             | Schema | Read-back slot | Primary evidence anchor                                             |
| ---------------------- | ---------------- | ------ | -------------- | ------------------------------------------------------------------- |
| `kyx_state`            | read             | ❌     | ✅             | `tools.ts:1685`; 17 subjects; `stateSnapshot` `:13381`              |
| `kyx_meter`            | read             | ✅     | —              | `tools.ts:2553`; `meters.ts`                                        |
| `kyx_catalog`          | read             | ✅     | —              | `tools.ts:2427`; `catalogSnapshot` `:10886`                         |
| `kyx_transport`        | runtime          | ✅     | —              | `tools.ts:1786`; `dispatchTransport`                                |
| `kyx_save`             | runtime          | ✅     | —              | `tools.ts:1728`; `ctx.saveNow()` `:5383`                            |
| `kyx_export`           | runtime          | ❌     | ✅             | `tools.ts:1858`; ⚠ undeclared `autofix` `:7399`                     |
| `kyx_audio_preview`    | runtime          | ✅     | —              | `tools.ts:1885`; `audio-preview.ts:84`                              |
| `kyx_publish_gallery`  | runtime          | ✅     | —              | `tools.ts:2903`; ⚠ external side effect                             |
| `kyx_render_summary`   | runtime          | ✅     | —              | `tools.ts:2927`; `render-summary.ts:71`; **only freshness carrier** |
| `kyx_diagnose_mix`     | runtime          | ✅     | —              | `tools.ts:2965`; `mix-diagnosis.ts:160`                             |
| `kyx_blind_ab`         | runtime          | ✅     | —              | `tools.ts:3434`; `blind-ab.ts:75`                                   |
| `kyx_tracks`           | destructive      | ❌     | ✅             | `tools.ts:2129`; 12 ops                                             |
| `kyx_fx`               | destructive      | ❌     | ✅             | `tools.ts:1992`; 6 actions                                          |
| `kyx_clips`            | destructive      | ❌     | ✅             | `tools.ts:2648`; 34 ops                                             |
| `kyx_takes`            | destructive      | ✅     | —              | `tools.ts:3411`; 3 ops                                              |
| `kyx_master`           | destructive      | ❌     | ✅             | `tools.ts:3315`; 11 ops                                             |
| `kyx_notes`            | destructive      | ✅     | —              | `tools.ts:2286`; 11 ops                                             |
| `kyx_sections`         | destructive      | ✅     | —              | `tools.ts:2058`; 7 ops                                              |
| `kyx_intent`           | mutate           | ❌     | ✅             | `tools.ts:1663`; `executeIntentTool` `:13967`                       |
| `kyx_undo`             | mutate           | ✅     | —              | `tools.ts:1768`; `ctx.undo()` `:5392`                               |
| `kyx_generate`         | mutate           | ❌     | ✅             | `tools.ts:1906`                                                     |
| `kyx_groove`           | mutate           | ✅     | —              | `tools.ts:1962`; `status:"partial"` `:5623`                         |
| `kyx_markers`          | mutate           | ✅     | —              | `tools.ts:2106`; 4 ops                                              |
| `kyx_pattern`          | mutate           | ❌     | ✅             | `tools.ts:2202`; 2 ops                                              |
| `kyx_steps`            | mutate           | ✅     | —              | `tools.ts:2219`; 7 ops                                              |
| `kyx_music`            | mutate           | ✅     | —              | `tools.ts:2376`; 5 ops                                              |
| `kyx_plugin_param`     | mutate           | ✅     | —              | `tools.ts:2454`; 2 ops                                              |
| `kyx_instrument_param` | mutate           | ✅     | —              | `tools.ts:2518`; 2 ops                                              |
| `kyx_automation`       | mutate           | ❌     | ✅             | `tools.ts:2573`; 7 ops                                              |
| `kyx_batch`            | mutate           | ✅     | —              | `tools.ts:2807`; ⚠ undeclared `atomic` `:10776`                     |
| `kyx_loudness`         | mutate           | ✅     | —              | `tools.ts:2840`; measure is `runtime` per-op                        |
| `kyx_import_sfz`       | mutate           | ✅     | —              | `tools.ts:2869`                                                     |
| `kyx_mix_idea`         | mutate           | ✅     | —              | `tools.ts:2990`; ⚠ document-only                                    |
| `kyx_checkpoint`       | mutate           | ❌     | ✅             | `tools.ts:3027`; 5 ops                                              |
| `kyx_mix`              | mutate           | ✅     | —              | `tools.ts:3044`                                                     |
| `kyx_arrange`          | mutate           | ✅     | —              | `tools.ts:3089`                                                     |
| `kyx_song`             | mutate           | ❌     | ✅             | `tools.ts:3131`                                                     |
| `kyx_routing`          | mutate           | ✅     | —              | `tools.ts:3182`; 8 ops                                              |
| `kyx_unsuno`           | mutate           | ❌     | ✅             | `tools.ts:3240`; ⚠ errors lack `errorCode`                          |
| `kyx_separate`         | mutate (default) | ❌     | —              | `tools.ts:3279`; ⚠ not in `TOOL_RISK`; in-flight peer work          |
| `kyx_blind_ab`         | runtime          | ✅     | —              | see above                                                           |

**MCP resources (8):** `kyx://project/{overview,pattern,mix,arrangement,history}`, `kyx://session/capabilities`, `kyx://playbook`, `kyx://vocab`.

---

## Appendix B — the full finding template, applied

Each finding below uses the required template. Fields not applicable are marked `—` rather than omitted.

---

### OBS-01 — The engine's graph-sync failure is invisible to every agent surface

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | Critical                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Evidence**        | `src/audio-engine/AudioEngine.ts:1157` (`private lastProjectSyncFailure`), `:1166` (public getter `projectSyncFailure`), `:1177` (`whenProjectSettled()`), `:1236-1239` (set on failure), `:1211` (cleared on the next successful sync). `src/mcp/tools.ts:3787-3788` — the completion-stage enum has no engine member. A repo-wide grep for `projectSyncFailure` finds the engine, one script, one test, and the docs — **no `src/mcp/` and no `src/ui/` consumer**. |
| **Reproduction**    | 1. Force `AudioEngine.syncProject` to throw during a `setProject` body (e.g. an effect whose worklet is unavailable). 2. Observe `engine.projectSyncFailure` is non-null. 3. Observe that no MCP tool result carries it: the mutation returns `stage:"applied"`, and `kyx_state` reports the document — which _did_ change. The agent has no way to learn the graph is broken.                                                                                        |
| **Root cause**      | The engine sync was designed as an **export-safety** fact ("a half-built graph must never end in 'exported'") and was never given an **agent-observability** surface. The MCP completion-stage vocabulary predates the engine's failure fact.                                                                                                                                                                                                                         |
| **AI consequence**  | The agent's receipt is green while the audio graph may be half-built. It will report "done" for a change that is not audible. It has no read that would reveal this.                                                                                                                                                                                                                                                                                                  |
| **Proposed fix**    | Add `engineSync` to `McpToolContext` (an optional hook returning `{ ok: boolean; message?: string; at?: number }`), expose `projectSyncFailure` through it, and add `stage:"engine-synced"` to `McpCompletionStage`. **Both engine members are already public** — this is a wiring change, not a new mechanism.                                                                                                                                                       |
| **Acceptance test** | A spec that forces a project-sync failure, calls a mutating tool, and asserts the result carries `stage:"engine-synced"` **and** the failure message — plus a negative control: with no failure, the stage is `engine-synced` and the message is absent.                                                                                                                                                                                                              |

---

### OBS-02 — No read resolves the effective (post-automation) parameter value

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | Critical                                                                                                                                                                                                                                                                                                                                                                                                |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                                                                                                                |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Evidence**        | `src/mcp/tools.ts:13352-13379` (`automationSnapshot`) — lists lanes, targets, point counts, the parameter's `min..max` range, and the point values; **no resolution at a tick**. `:13318-13326` (`automationTargetLabel`) — a label only. `src/mcp/automation.ts` (the command layer) owns lane mutation; `src/audio-engine/automationBridge.ts` owns runtime resolution. No MCP tool calls the bridge. |
| **Reproduction**    | 1. Add an automation lane on track gain with one point at bar 1 = 0.2 and one at bar 9 = 1.0. 2. `kyx_tracks op:setGain` sets the track gain to 0.8. 3. Ask "what is the gain at bar 9?" — `kyx_state tracks` returns `0.80` (the **manual** value); `kyx_state automation` returns the lane and its points; **neither** returns `1.0`, the value that will actually be heard.                          |
| **Root cause**      | Automation is modelled as **data** (lanes + points) and exposed as data; the **evaluation** of that data lives in the engine bridge and was never exposed as a read.                                                                                                                                                                                                                                    |
| **AI consequence**  | The agent can set a parameter that automation immediately overrides, and will confidently report a change with no audible effect. It cannot distinguish "my write was effective" from "my write was overwritten".                                                                                                                                                                                       |
| **Proposed fix**    | A new `kyx_state subject:"effective"` that takes `{target, tick}` and returns the **resolved** value plus `{owner: "automation"                                                                                                                                                                                                                                                                         | "manual", laneId?, manualValue, resolvedValue}`. The resolution logic already exists in `src/audio-engine/automationBridge.ts` and must be **extracted into a pure function** so both the bridge and the read can use it (the bridge must remain the only _writer_). |
| **Acceptance test** | A spec that builds the lane above, then asserts `effective(gain, bar 9) === 1.0` with `owner === "automation"`, `effective(gain, bar 1) === 0.2`, and — after removing the lane — `effective(gain, bar 9) === 0.8` with `owner === "manual"`. **Negative control:** a resolver that returns the manual value must fail the first two assertions.                                                        |

---

### OBS-03 — `runtime`-class tools bypass the external-agent consent gate

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**        | High                                                                                                                                                                                                                                                                                                                                                                                 |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                                                                                             |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                                                                                 |
| **Evidence**        | `src/mcp/permissionLattice.ts:152` — the external-consent check applies to `mutate`/`destructive` only. `src/mcp/agentTrust.ts:56-63` — `kyx_transport`, `kyx_save`, `kyx_export`, `kyx_audio_preview`, `kyx_publish_gallery`, `kyx_render_summary`, `kyx_diagnose_mix`, `kyx_blind_ab` are `runtime`. `src/mcp/tools.ts:7583` — `kyx_publish_gallery` calls `ctx.shareToGallery()`. |
| **Reproduction**    | With `allowExternalMutations: false` and `agentId: "some-external-agent"`, call `kyx_publish_gallery`. The lattice returns `auto` (risk is `runtime`, not `mutate`/`destructive`), so the call proceeds to the **public gallery**.                                                                                                                                                   |
| **Root cause**      | The consent gate was modelled as "may this agent change the document?", and the `runtime` class was introduced for non-document side effects without extending the gate to cover them.                                                                                                                                                                                               |
| **AI consequence**  | An external agent can publish user work to a **public** URL and write export files to disk with mutation consent explicitly OFF. This is a data-exposure path that the permission model implies is closed.                                                                                                                                                                           |
| **Proposed fix**    | Extend the consent check to cover `runtime` side effects that leave the machine (`kyx_publish_gallery`, `kyx_export`, `kyx_save`) — at minimum gate publishing behind an explicit, separate consent flag. Cheapest correct form: a distinct `allowExternalSideEffects` alongside `allowExternalMutations`, defaulting to `false`.                                                    |
| **Acceptance test** | A spec that calls `kyx_publish_gallery` with `agentId ≠ "local"` and `allowExternalMutations: false`, asserting `POLICY_REFUSED`; plus the negative control that the same call with the side-effect consent granted succeeds.                                                                                                                                                        |

---

### OBS-04 — `force: true` disables the stale-write guard and the scope guard together

| Field               | Value                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | High                                                                                                                                                                                                                                                                                                                               |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                                           |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                               |
| **Evidence**        | `src/mcp/tools.ts:4728` (the `force` envelope flag) and `:5014-5018` — the same `forceWrite` is passed to **both** `guardStaleWrites` and `guardScopedWrites`. `src/mcp/write-conflict.ts:54` — the stale-write guard returns the command untouched when forced. `src/mcp/scope-guard.ts:158` — the scope guard skips when forced. |
| **Reproduction**    | Send a call with `force: true` and a `scope` declaration. Both guards are skipped: a stale field is overwritten **and** a protected path is written, in one call, with no distinction in the result.                                                                                                                               |
| **Root cause**      | One boolean was reused for two independent guarantees. The two guards have different failure modes: one is about _staleness_, the other about _containment_.                                                                                                                                                                       |
| **AI consequence**  | The agent has a single undocumented escape hatch that silently turns off both concurrency safety and path confinement. An agent that learns it (from another agent, or from a transcript) can overwrite anything without a stale-write check.                                                                                      |
| **Proposed fix**    | Split into `forceStaleWrite` and `forceScope`, declare both in the envelope schema, and have the receipt state which guarantee was waived. **This changes a documented escape hatch and needs approval.**                                                                                                                          |
| **Acceptance test** | A spec asserting that `forceStaleWrite` permits a stale overwrite but still raises a scope violation, and that `forceScope` permits a protected-path write but still raises `WRITE_CONFLICT`.                                                                                                                                      |

---

### OBS-05 — No observation result carries a revision, a timestamp, or a document identity

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**        | High                                                                                                                                                                                                                                                                                                                                                                                       |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                                                                                                   |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                                                                                       |
| **Evidence**        | `src/mcp/tools.ts:3814-3865` (`McpToolResult`) — no `timestamp`, no `revision`, no `sessionId`. `:5190-5197` — `docId`/`docName` are assigned **only** inside `if (result.mutated === true)`. `:3644` — `ctx.getRevision` exists. `:4976` — `prepared.sessionId` exists internally. `src/mcp/render-summary.ts:53-55` — the only revision on the wire, and only for the track-window path. |
| **Reproduction**    | Call `kyx_state subject:"overview"` twice with a mutation in between. Both results have no timestamp, no revision, and no `docId`. There is no way to tell whether they describe the same document state, and no way to correlate them with any other observation.                                                                                                                         |
| **Root cause**      | The result envelope was designed for _command outcomes_ ("what happened, did it mutate, can it be undone"), not for _observations_ ("what state did you see, and when"). The two are different shapes and the envelope only carries the first.                                                                                                                                             |
| **AI consequence**  | The agent cannot reason about freshness, cannot detect that a cached belief is stale, cannot correlate a measurement with the document state that produced it, and cannot prove in a report which document version it was reasoning about.                                                                                                                                                 |
| **Proposed fix**    | Add an observation header to every result: `observedAt`, `projectId`, `revision`, `sessionId`, `freshness`, `confidence`, `truncated`. All additive. `ctx.getRevision` and `prepared.sessionId` already exist; `ProjectStore.getRevision` already counts (`ProjectStore.ts:284`).                                                                                                          |
| **Acceptance test** | A spec asserting every tool result carries `observedAt` (a parseable ISO timestamp), `projectId` matching the current document, and a `revision` that increments across a mutation — including for **read-only** tools.                                                                                                                                                                    |

---

### OBS-06 — Nine behaviour-changing inputs are declared in no tool's schema

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Evidence**        | The runtime augmentation adds only `requestId`, `agentId`, `dryRun` (`src/mcp/tools.ts:3490-3507`). Undeclared but behaviour-changing: `force` (`:4780`), `projectRevision` (`src/mcp/permissionLattice.ts:175-178`), `scope` (`src/mcp/scope-guard.ts:234-245`), `kyx_export.autofix` (`:7399` → `setMasterConfig` at `:7400-7405`), `kyx_batch.atomic` (`:10792`), and `targetHfShare`/`targetLowEndShare`/`targetCrestDb`/`targetCorrelation` (`:12882`). **Nine in total — measured, not counted by hand**, by `scripts/audit-mcp-observation.mjs`. |
| **Reproduction**    | Read `kyx_export`'s `inputSchema` — it declares `format`, `sampleRate`, `bitDepth`, `stems`. Pass `autofix: true`. The document is mutated by a `setMasterConfig` command, and the trust layer classifies it as `mutate` (`src/mcp/agentTrust.ts:164`) — but the schema the agent read never mentioned it.                                                                                                                                                                                                                                              |
| **Root cause**      | Envelope parameters were added to the _runtime_ contract without being added to the _declared_ contract, and some tool-local parameters were implemented directly against the raw `record` object.                                                                                                                                                                                                                                                                                                                                                      |
| **AI consequence**  | The agent cannot discover the levers it has. It cannot use `scope` or `projectRevision` because it cannot find them; and it can be surprised by `autofix`, which is a mutation it was never told about.                                                                                                                                                                                                                                                                                                                                                 |
| **Proposed fix**    | Declare all seven. For the envelope parameters, a single shared envelope schema referenced by every tool's `inputSchema` is the cleanest form; for tool-local parameters, add them to that tool's `properties` with a description. **Schema-only; no behaviour change.**                                                                                                                                                                                                                                                                                |
| **Acceptance test** | A mechanical spec: for each tool, the set of `record.X` reads in its handler must be a subset of `Object.keys(inputSchema.properties)`. The new `tests/audit-observation-contract.test.ts` (§15.2) implements exactly this and is expected to fail on the current tree.                                                                                                                                                                                                                                                                                 |

---

### OBS-07 — The post-write scope verifier `verifyScope` is never called

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | High                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Evidence**        | `src/mcp/scope-guard.ts:175-214` defines `verifyScope(base, after, ops, scope)` — a **post-write** check comparing the document before and after against the declared `protect` paths. A repo-wide grep finds its only call sites in `tests/permission-lattice.test.ts:362,370`. `src/mcp/tools.ts:5014-5018` calls `guardScopedWrites` only. Corroborated by the repository's own audit: `docs/audits/2026-10-27-intent-to-sound/INTENT_TO_SOUND_AUDIT.md:805`. |
| **Reproduction**    | Declare a scope with `protect: [["name"]]`. Issue a command whose declared `ops` say it touches only `["gain"]` but which in fact also changes the project name. `guardScopedWrites` — which only inspects the _declared_ `ops` — lets it through. `verifyScope`, which would compare the actual before/after documents, is never invoked.                                                                                                                       |
| **Root cause**      | The guard has two halves — a **pre-write** check against declared intent, and a **post-write** check against observed reality. Only the first was wired. The second was written, tested, and then not called.                                                                                                                                                                                                                                                    |
| **AI consequence**  | A command whose declared operations understate what it actually writes escapes scope confinement entirely. The containment guarantee is only as strong as the honesty of the `ops` list.                                                                                                                                                                                                                                                                         |
| **Proposed fix**    | Call `verifyScope` after `ctx.execute` in the executor, compare against the declared `protect` paths, and convert a violation into `POLICY_REFUSED` with a dedicated detail field. **The function exists and is tested — this is a wiring change.**                                                                                                                                                                                                              |
| **Acceptance test** | The existing `tests/permission-lattice.test.ts:362` case, promoted to run **through the executor** (not the function directly): issue a scope-protected call whose actual write exceeds its declared `ops`, and assert `POLICY_REFUSED`.                                                                                                                                                                                                                         |

---

### OBS-08 — Scope confinement is opt-in; an undeclared scope means unconstrained

| Field               | Value                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | High                                                                                                                                                                                                                                                                                                                   |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                               |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                   |
| **Evidence**        | `src/mcp/scope-guard.ts:234-245` — `readScopeDeclaration` returns `null` for an envelope with no `scope`. `:152` — a `null` scope makes `guardScopedWrites` return the context untouched. `:107-112` — an absent or empty `allow` is UNRESTRICTED. `:53-56` — `protect` is honoured even when `allow` is unrestricted. |
| **Reproduction**    | Make an MCP call with no `scope` key. Every write path is allowed. The `scope` declaration is the _only_ confinement mechanism, and it is supplied by the caller.                                                                                                                                                      |
| **Root cause**      | Confinement was modelled as a **caller capability** (the caller declares what it will touch) rather than a **policy the host imposes** (the host says what the agent may touch).                                                                                                                                       |
| **AI consequence**  | The AI is only as contained as its own good behaviour. A mistake, a hallucination, or a prompt injection has no containment — the `scope` declaration will simply be absent.                                                                                                                                           |
| **Proposed fix**    | For **external** agents, invert the default: an absent scope means an **empty allow-list** (nothing may be written) unless the host supplies one. `protect` paths should come from the **host**, not the caller. **A default change — needs approval.**                                                                |
| **Acceptance test** | A spec asserting that an external-agent call with no `scope` is refused, while a `local` agent with no `scope` still succeeds (the human path is unchanged).                                                                                                                                                           |

---

### OBS-09 — The declared-revision precondition is opt-in and hard to satisfy

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | High                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Evidence**        | `src/mcp/permissionLattice.ts:139-150` — `STALE_REVISION` requires **both** `declaredRevision` and `currentRevision` to be numbers and to differ; `:170-178` — the declared value comes from the envelope key `projectRevision`. `src/mcp/revision.ts:11-13` — `storeRevision` returns `null` when the store has no `getRevision` (the Yjs store). `src/mcp/render-summary.ts:53-55` — the only place the live revision is exposed. |
| **Reproduction**    | Call any mutating tool without `projectRevision`. The staleness rule is skipped entirely. With it, the caller must have obtained the revision from somewhere — and the only read that carries one is `kyx_render_summary`'s track-window path, which is a **rendering** tool, not a state read.                                                                                                                                     |
| **Root cause**      | A precondition mechanism was built without the **observation** that would let a caller satisfy it. The compare-and-set is sound; the read side of the handshake was never added.                                                                                                                                                                                                                                                    |
| **AI consequence**  | Optimistic concurrency is opt-in and practically unusable: the agent has no cheap way to learn the current revision, so it never declares one, so the guard never fires. The `WRITE_CONFLICT` guard still protects **field-level** staleness — which is the real protection — but the document-level precondition is decorative.                                                                                                    |
| **Proposed fix**    | Publish the revision on every read (OBS-05's header). Once `revision` is on every result, the agent can echo it, and the precondition becomes usable at zero extra cost.                                                                                                                                                                                                                                                            |
| **Acceptance test** | A spec: read the revision from a `kyx_state` result, mutate elsewhere, then write with the stale `projectRevision` — asserting `STALE_REVISION`. Negative control: the same write with the fresh revision succeeds.                                                                                                                                                                                                                 |

---

### OBS-10 — Undo is global LIFO; redo is unattributable; `allowForeign` waives the prompt

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | High                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Evidence**        | `src/mcp/attribution.ts:19-21` — per-agent undo isolation is explicitly deferred. `src/mcp/attribution.ts:64-67` — `labelsRevertedBy` returns `[]` for redo because "redo history lives beyond the undo stack — the context cannot see it". `src/mcp/tools.ts:5356-5369` — the foreign-undo prompt can be waived with `allowForeign: true`. `src/mcp/tools.ts:5390-5401` — the redo receipt carries no names. |
| **Reproduction**    | 1. The human makes a change. 2. The agent makes a change. 3. `kyx_undo action:"undo"` — the agent's undo reverts the **human's** work, because the stack is global LIFO. With `allowForeign: true`, no prompt is required. 4. `kyx_undo action:"redo"` — the receipt says `redo ×1` and names nothing, so neither the agent nor the human can tell what was restored.                                         |
| **Root cause**      | The undo stack is a single global history (correct for a DAW), and the agent was given **write access to it** without a per-agent boundary or an attribution channel for redo.                                                                                                                                                                                                                                |
| **AI consequence**  | The agent can destroy the user's work and report a successful undo. The redo receipt is unverifiable. The user cannot tell what happened afterwards.                                                                                                                                                                                                                                                          |
| **Proposed fix**    | Two parts. (a) **Near-term:** refuse `allowForeign: true` for **external** agents, and make the undo receipt always name what it reverted — including the redo path, which requires the host to expose redo labels the way it exposes undo labels. (b) **Long-term:** a per-agent undo journal layered over the global stack. **Part (a) changes behaviour and needs approval.**                              |
| **Acceptance test** | A spec: a human change followed by an agent undo is refused for an external agent without explicit consent; and a redo receipt names the restored labels.                                                                                                                                                                                                                                                     |

---

### OBS-11 — Hand-written commands bypass all three write guards

| Field               | Value                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | High                                                                                                                                                                                                                                                                                                                                                    |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                                                                |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                                                    |
| **Evidence**        | `src/mcp/tools.ts:4970-4989` — commands with no `base`/`ops` are recorded as **coverage violations**, not refused. `src/mcp/tools.ts:4633-4643` — the sanctioned exemption list: `kyx_tracks:rename`, `kyx_notes:add`, `kyx_pattern:select`. `src/mcp/scope-guard.ts:35-41`, `:114-118`, `:182-185` — a command without `base`/`ops` is not verifiable. |
| **Reproduction**    | Issue `kyx_tracks op:"rename"`. The command carries no `base`/`ops`, so the stale-write guard has nothing to compare, the scope guard has nothing to check, and the written-path record is empty. The mutation lands with no staleness protection and no confinement.                                                                                   |
| **Root cause**      | The guards are keyed on the command's **self-declared** intent. A command that does not declare intent cannot be guarded, and the current design treats that as a _coverage note_ rather than a _refusal_.                                                                                                                                              |
| **AI consequence**  | For the exempt operations the agent writes blind: no stale check, no scope check, no record of which paths it wrote. Three operations today; any new hand-written command joins the list by default.                                                                                                                                                    |
| **Proposed fix**    | Require `base`/`ops` on every mutating command, and refuse (not note) a mutating call whose command lacks them — except for the reviewed exemption list, which should be pinned by a test that fails when it grows. `tests/mcp-ops-coverage.test.ts` already exists and is the natural home for that test.                                              |
| **Acceptance test** | A spec asserting that a mutating call whose command lacks `base`/`ops` is refused, and that the exemption list is exactly the three reviewed entries — with a negative control proving the guard fires on a synthetic undeclared command.                                                                                                               |

---

### OBS-12 — The live LUFS number may be an approximation and does not say which

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Evidence**        | `src/audio-engine/meteringRig.ts:280-283` — the K-weighted worklet is used when loaded, otherwise a fallback. `src/audio-engine/metering.ts:36-38` — _"Approximate BS.1770 loudness from a stereo window (K-weighting is omitted for the lightweight live path)"_. `src/mcp/tools.ts:3521-3537` (`McpMeterSnapshot`) — `lufsIntegrated` is reported with no source flag. `:12918` — the master-assistant reads `master.lufsIntegrated` as if it were exact. |
| **Reproduction**    | Read `kyx_meter scope:"master"` with the `kwmeter` worklet unloaded and again with it loaded. Both return `lufsIntegrated`; the field does not say which computation produced it. The offline measurement (`src/audio-engine/kweighting.ts:378`, BS.1770-4) is a **third** quantity under the same conceptual name.                                                                                                                                         |
| **Root cause**      | One field name covers two different measurements, and the snapshot type has no room to distinguish them.                                                                                                                                                                                                                                                                                                                                                    |
| **AI consequence**  | The agent may compare a live approximate LUFS against an offline exact LUFS and draw a conclusion from the difference — or plan a mastering action from an approximation.                                                                                                                                                                                                                                                                                   |
| **Proposed fix**    | Add `lufsSource: "kweighted"                                                                                                                                                                                                                                                                                                                                                                                                                                | "approximate"`to the meter snapshot and to`kyx_meter`'s output schema. Cheap, additive, honest. |
| **Acceptance test** | A spec that reads the meter with and without the worklet and asserts the `lufsSource` field differs accordingly.                                                                                                                                                                                                                                                                                                                                            |

---

### OBS-13 — Track peak and master peak are different quantities under one field name

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | Medium                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Evidence**        | `src/audio-engine/meteringRig.ts:279`, `:290` and `src/audio-engine/metering.ts:621` (`truePeakOversampled`) — the master path reports a **4× oversampled** true peak. `src/mcp/meters.ts:44-56` — the per-track path computes peak/RMS over `analyser.fftSize` samples, i.e. a **sample** peak. `src/mcp/tools.ts:3521-3537` — the snapshot exposes `master.truePeakDb` and `tracks[].peakDb` with no labelling. |
| **Reproduction**    | Read `kyx_meter scope:"all"`. Compare `master.truePeakDb` with `tracks[].peakDb` — they are intersample and sample peaks respectively. A track that reads −0.1 dB can genuinely exceed the master's reported true peak.                                                                                                                                                                                           |
| **Root cause**      | Two metering implementations with different accuracy, surfaced through one snapshot with different field names but no semantics.                                                                                                                                                                                                                                                                                  |
| **AI consequence**  | The agent computes "the track is louder than the master" and reports a contradiction that is an artefact of the measurement, not the mix.                                                                                                                                                                                                                                                                         |
| **Proposed fix**    | Either label them (`peakKind: "true"                                                                                                                                                                                                                                                                                                                                                                              | "sample"` on both paths) or compute track true peaks with the same oversampling. Labelling is the cheap, correct first step. |
| **Acceptance test** | A spec asserting the meter snapshot carries the peak-kind label on both master and track entries.                                                                                                                                                                                                                                                                                                                 |

---

### OBS-14 — `kyx_state` returns prose for 16 of its 17 subjects

| Field               | Value                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | Medium                                                                                                                                                                                                                                                                                                                                                  |
| **Confidence**      | Verified                                                                                                                                                                                                                                                                                                                                                |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                                                    |
| **Evidence**        | `src/mcp/tools.ts:5291-5330` — the `kyx_state` case; `:5325` calls `stateSnapshot(...)`, which returns a `string` (`:13381-13390`); `:5328` attaches a structured twin **only** for `subject:"mixer"` via `mixerSnapshotData` (`:4279-4303`). `kyx_state` has **no** `outputSchema` (measured: 26 of 39 tools have one; `kyx_state` is not among them). |
| **Reproduction**    | Call `kyx_state subject:"tracks"` and parse `kick (id=tr-1, drum, gain 0.90 (−0.9 dB), pan 0.00)`. The gain's unit is linear with a parenthetical dB; `mixer` reports the same track as `gain −0.9 dB`; `sends` reports levels as 0–1 decimals. Three formats for one board.                                                                            |
| **Root cause**      | `stateSnapshot` was written as a human-readable formatter for the model's convenience. The structured twin was added later for one subject and never generalised.                                                                                                                                                                                       |
| **AI consequence**  | The agent parses strings. A formatter change silently breaks parsing with no schema to catch it. It also burns tokens on prose and cannot reliably compare two reads.                                                                                                                                                                                   |
| **Proposed fix**    | Give `stateSnapshot` a structured sibling — one function per subject returning a typed object — and keep the text as the `text` channel. This is the single change that would move most of the read side from score 3 to score 4.                                                                                                                       |
| **Acceptance test** | A spec asserting that every `kyx_state` subject returns a `data` payload matching a declared `outputSchema`, plus a guard that fails when a new subject is added without one.                                                                                                                                                                           |

---

### OBS-15 — The generated MCP mirrors sit on the critical path of execution

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | Low                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Confidence**      | **Verified**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Status**          | Open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Evidence**        | `scripts/generate-mcp-mirrors.mts:4-6` names the three files and marks `src/mcp/tools.ts` as the **source of truth**; `:23` imports `MCP_TOOLS`/`MCP_RESOURCES` from it; `:35` rewrites only the definitions region of `desktop/mcp-tool-defs.cjs` and `server/mcp-core.mjs`; `:54-70` is the `--check` drift gate, wired as `npm run verify:mcp-mirrors` (`package.json:188-189`). `tests/mcp-mirror-sync.test.ts` pins the mirrors against the TS source (tools + resources, order-sensitive) and pins every registered tool name to a dispatcher case. `server/mcp-core.mjs:172` holds `MCP_TOOL_DEFS`; `:6795-6801` — `tools/call` validates the name against that local copy and then **relays** via `hub.callTool`. `desktop/mcp-server.cjs:188-193` does the same and forwards to the bridge. Execution therefore has exactly one implementation — `src/mcp/tools.ts:4711` `executeMcpTool`, with `executeMcpToolAsync` a **const alias** at `:14167`. |
| **Reproduction**    | The duplication is **generated, not hand-maintained** — no implementation drift is possible. But the mirror is not merely the advertisement surface: `tools/call` **validates the tool name against the mirror before relaying**, so a stale mirror produces a server that _refuses a tool the runtime implements_. Concretely: change a tool's name in `src/mcp/tools.ts`, call the tool, and observe the relay rejecting it until `npm run gen:mcp-mirrors` is run. The gate catches this before it lands — `npm run verify:mcp-mirrors` exits 1 on drift, and `verify:all` runs it.                                                                                                                                                                                                                                                                                                                                                                        |
| **Root cause**      | Not a bug — a **build-time discipline**. The catalogue exists three times on disk because two transports need it without importing TypeScript. The generator plus the vitest gate is the mechanism that keeps the three copies equal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **AI consequence**  | Low. The agent-facing surface cannot silently diverge from the runtime: the definitions are generated, the drift is gated, and `tests/mcp-mirror-sync.test.ts` was **verified passing (4/4)** during this audit. The residual risk is a **release-order** risk — a deploy that ships a changed `src/mcp/tools.ts` without its regenerated mirrors would advertise and accept a different catalogue than the app implements.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Proposed fix**    | No code change needed. The permanent guard already exists: `npm run verify:mcp-mirrors` in `verify:all`, plus `tests/mcp-mirror-sync.test.ts`. The only worthwhile addition is to make the release order explicit — the mirrors must be regenerated in the same commit as a tool-surface change. The generator already says so in its header; the remaining work is a process rule, not a code change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Acceptance test** | Already exists — `tests/mcp-mirror-sync.test.ts` (4 tests, verified green). One addition worth making: the mirror gate should also run in **CI**, not only in `verify:all`, so a change that skips `npm run gen:mcp-mirrors` fails the build rather than the release.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## Appendix C — the observation contract, as it should look

A worked example of the §13.1 header on a real tool — `kyx_tracks op:"setGain"` — showing what the agent would gain:

```
BEFORE   text:  "kick: gain 0.60 (−4.4 dB)"
         data:  { status: "applied", trackId: "tr-1", gain: 0.6 }
         ❌ which document? which version? which session? when? what else changed?

AFTER    text:  "kick: gain 0.60 (−4.4 dB)"
         data:  {
                  status: "applied",
                  stage: "engine-synced",          ← the graph accepted it
                  trackId: "tr-1",
                  gain: 0.6,
                  observedAt: "2026-10-27T18:14:23.104Z",
                  projectId: "pf-8f3c…",
                  revision: 412,
                  sessionId: "s1b2c3-7",
                  freshness: "current",
                  confidence: null,
                  truncated: null,
                  changed: [{ path: ["tracks","tr-1","gain"], was: 0.9, now: 0.6 }]
                }
         ✅ a fact an agent can reason about, correlate, and re-check.
```

---

_Audit performed 2026-10-27 against `c8729057`. The write side of KYX's AI surface is well built and well guarded; the read side is thin, the verify side stops at the document boundary, and the musical layer is essentially unreachable. The highest-value next step is not a redesign — it is wiring three already-public facts (`projectSyncFailure`, `whenProjectSettled()`, `getRevision`) into the result envelope, and adding one read that resolves a parameter through automation._
