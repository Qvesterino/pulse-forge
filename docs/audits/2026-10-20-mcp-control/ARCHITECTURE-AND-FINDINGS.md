# KYX MCP Control Audit: Architecture and Findings

**Audit date:** 2026-10-20
**Scope:** KYX / Pulse Forge source tree at the audited working-tree revision. This is an evidence snapshot; the repository had unrelated dirty files during the audit.
**Method:** read-only source and test inspection before implementation changes.

## Architecture map

KYX is both an MCP server and an MCP client-like relay endpoint. The desktop server is stdio → authenticated loopback HTTP → the live Electron renderer. The web host uses an HTTP `/mcp` endpoint and a WebSocket relay to the owning browser window. Both call the same renderer executor and its 37-tool catalog. There is no production headless DAW host: the live ProjectStore, UI and AudioEngine belong to an open app window.

```mermaid
flowchart LR
  C[MCP client]
  subgraph Desktop[KYX desktop]
    S[desktop/mcp-server.cjs
stdio JSON-RPC]
    B[desktop/mcp-bridge-server.cjs
loopback HTTP + token]
    H[desktop/mcp-host-manager.cjs
IPC broker]
    R[Electron renderer
src/mcp/desktop-host.ts]
  end
  subgraph Web[KYX web relay]
    W[server/mcp-core.mjs
POST /mcp]
    WS[WebSocket relay
/mcp-relay]
    WH[src/mcp/web-host.ts]
  end
  X[src/mcp/tools.ts
executeMcpTool → dispatch]
  D[ProjectStore / command layer
undo + event propagation]
  A[AudioEngine / Transport / UI]
  P[autosave + IndexedDB]
  C --> S --> B --> H --> R --> X
  C --> W --> WS --> WH --> X
  X --> D --> A
  D --> P
```

### Source trace

| Boundary                         | Evidence                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop transport and lifecycle  | `desktop/mcp-server.cjs`; `desktop/mcp-bridge-server.cjs`; `desktop/mcp-host-manager.cjs`; `src/mcp/desktop-host.ts`. Host manager binds loopback, issues a random bearer token, and brokers calls to the renderer. Bridge limits request body/rate and uses constant-time token comparison.                                                                                      |
| Web transport and ownership      | `server/mcp-core.mjs`; `server/collab-server.mjs`; `src/mcp/web-host.ts`; `src/mcp/relayConfig.ts`. HTTP calls are token-gated; the WebSocket relay is associated with one owning window. `?server=` continues through `isAllowedServerUrl`.                                                                                                                                      |
| Shared tool contract             | `src/mcp/tools.ts` defines 37 tools, JSON input schemas, annotations and `executeMcpTool`; `desktop/mcp-tool-defs.cjs` and `server/mcp-core.mjs` are generated mirrors. `tests/mcp-mirror-sync.test.ts` guards drift.                                                                                                                                                             |
| Canonical state and command path | `src/mcp/desktop-host.ts` and `src/mcp/web-host.ts` bind the executor to the live `services.store`, transport, undo/redo, meters and selected host services. Document edits dispatch the existing serializable commands through the store.                                                                                                                                        |
| Audio/realtime boundary          | MCP dispatch is invoked from renderer event/IPC handlers, not from AudioWorklet callbacks. Offline preview/render calls remain bounded host operations. The web/desktop host requires the normal app window and its audio/document services.                                                                                                                                      |
| Persistence                      | Document writes flow through ProjectStore and existing autosave/persistence. `kyx_checkpoint` uses a separate checkpoint repository; it is not a project command or project save-as operation.                                                                                                                                                                                    |
| Test evidence                    | `tests/mcp-tools.test.ts`, `mcp-p2d-ops.test.ts`, `mcp-p2-parity-ops.test.ts`, `mcp-edit-parity.test.ts`, `mcp-real-store-undo.test.ts`, `mcp-persistence.test.ts`, `mcp-checkpoint-persistence.test.ts`, `mcp-idempotency.test.ts`, `mcp-error-codes.test.ts`, `mcp-batch-dryrun.test.ts`, `desktop-mcp.test.ts`, `mcp-core.test.ts`, and `mcp-relay-session-ownership.test.ts`. |

## Ranked verified findings

### P1 — `dryRun:true` is not side-effect free for three tool paths

`executeMcpTool` sandboxes `ctx.execute`, which correctly handles normal document commands, but its denylist only names transport, export, gallery publishing and audio preview (`src/mcp/tools.ts:2206-2212`). `kyx_import_sfz` calls `ctx.importSamples` directly; the live host implementation saves user samples and executes the velocity-layer command (`src/mcp/tools.ts:3595-3609`, `src/mcp/desktop-host.ts:105-118`, `src/sample-library/sfz-import.ts:233-299`). `kyx_checkpoint` save/delete persist or delete checkpoint repository rows outside `ctx.execute` (`src/mcp/tools.ts:3434-3464`, `4295-4463`). `kyx_mix_idea` with `preview:true` reaches `previewMixIdea`, which arms the live preview lane (`src/mcp/tools.ts:3821-3848`, `src/mcp/mix-preview.ts:167-181`). These operations can produce external or live UI state while the wrapper returns `dryRun:true` and `mutated:false`.

**Impact/reproduction:** call each named tool with `dryRun:true`; SFZ import can write sample records and document state, checkpoint save/delete changes the separate repository, and mix preview can arm a lane. The current dry-run test suite covers document command sandboxing but not these external side effects. **Remediation:** fail closed for SFZ import, checkpoint save/delete, and live mix preview when dry-run is requested. Check this policy before idempotency replay so a previous result cannot turn a refused dry-run into an apparent success.

### P1 — Desktop renderer bridge drops structured results

`McpToolResult` carries `data`, `errorCode`, `replayed`, document attribution and dry-run state (`src/mcp/tools.ts:1848-1868`). At the audit baseline, `startMcpDesktopHost` serialized only `text`, `mutated`, `isError` and `audio` into `api.answer` (`src/mcp/desktop-host.ts:154-171`). The stdio bridge relies on `result.data` to produce MCP `structuredContent` and returns an error when a successful tool with a declared output schema lacks it (`desktop/mcp-bridge-server.cjs:291-316`). The baseline catalog declared output schemas for seven tools. Thus desktop calls could execute correctly but be surfaced to clients as a structured-output failure; web and desktop behavior diverged. **Status:** the complete typed result now passes through renderer IPC, and host/transport regression tests cover structured results.

### P1 — An idempotency key can replay a different request

The ledger is keyed only by `requestId`; entries store document ID and result but no tool name or canonical argument signature (`src/mcp/tools.ts:2183-2190`, `2302-2330`, `2450-2464`). A second call in the same document using the same key returns the old result before dispatch, even if it names a different tool or arguments. Existing coverage verifies same-operation replay and project scoping, but not key collision across distinct requests (`tests/mcp-idempotency.test.ts`). **Impact/reproduction:** use a successful mutating `requestId`, then reuse it for a different edit on the same project; the second edit is silently skipped and the old success is returned. **Remediation:** bind ledger entries to a canonical request signature and return a typed conflict error for mismatched reuse; preserve same-operation replay.

### P2 — `kyx_state` supports automation reads that its schema rejects

The `kyx_state` input enum omits `automation` (`src/mcp/tools.ts:319-357`), while dispatch and snapshot formatting implement that subject (`src/mcp/tools.ts:2536`, `6757-6780`, `6923-6924`) and error guidance tells clients to call `kyx_state subject:automation` (`src/mcp/tools.ts:903`, `4606`). A schema-validating MCP client cannot make a supported automation query. **Remediation:** add the missing enum member and pin discovery/dispatch parity in a test.

### P2 — Persistent checkpoint actions and UI preview are outside document undo

Checkpoint save/delete and mix-preview arming are intentional host-level state, not ProjectStore commands; they do not inherit normal command undo/persistence semantics. Document these controls as external side effects and keep them explicitly excluded from dry-run. Checkpoint restore remains a document command and is undoable.

### P2 — Output contracts are uneven

At the audit baseline, all 37 tools had input schemas and descriptions, but only seven declared `outputSchema`; many results were text-first. Failure messages carry internal error codes in the common result, but transports do not expose all fields consistently. Machine-readable results and precondition/version expectations therefore remained PARTIAL even where the state change was covered.

## Post-audit hardening status

- **Dry-run side effects:** `executeMcpToolCore` now refuses SFZ import, checkpoint save/delete, and live mix preview before entering the sandbox or consulting a replay. `kyx_batch` recursively preflights its direct calls and refuses the same non-sandboxable effects; tests cover both direct and batched checkpoint writes.
- **Desktop result envelope:** the renderer host now forwards the complete `McpToolResult`, including structured data, replay status, error code, document attribution and dry-run status. The bridge and web relay put stable error codes in MCP text content so clients can see them.
- **Request idempotency:** request IDs are bound to a canonical tool/argument signature and agent identity. Reusing a key for different work returns `REQUEST_ID_CONFLICT`; overlapping identical calls serialize and replay. Partially failed calls that committed work replay the original partial result. The cache remains in-memory per host process, bounded to 256 entries; a restart or eviction removes retry protection. The corrected eviction regression verifies that the newest cache entry survives.
- **Automation discovery:** `automation` is now present in the `kyx_state` subject schema and in the desktop/web tool mirrors.
- **SFZ import read-back:** `kyx_import_sfz` now declares a strict output schema containing the imported track/sample IDs and bounded counts, without paths or media bytes. Unavailable and invalid requests return typed errors. Unit and web-relay tests cover the result; `npm run verify:mcp-mirrors` passes.
- **Undo read-back:** `kyx_undo` exposes the normalized action, requested/completed counts, bounded reverted labels and optional partial-failure text as structured output. Undo during microphone recording returns `POLICY_REFUSED`. Unit and web-relay tests cover the result.
- **Blind A/B read-back and bounds:** `kyx_blind_ab` returns structured results for plan, record, verdict, empty-lane and reset operations. Session writes are idempotent under `requestId`; `dryRun` refuses record/reset; reset requires `confirm:true`; lane names and in-memory lane/trial counts have explicit caps. Web and desktop transports preserve the declared result shape.
- **Mix-idea plan and preview read-back:** `kyx_mix_idea` publishes structured plan/apply/rejection results and a compact measured preview result. Preview output omits the frozen before/after project documents and executable command. Idea and target inputs have explicit length limits; web and desktop relay tests cover structured plan output.
- **Genre-mix read-back and validation:** `kyx_mix` returns structured applied, neutral and already-matched results, with a decision count and profile summary. Runtime rejects mistyped overrides, out-of-range energy and oversized mood before mutation; existing single-command undo behavior remains covered.
- **Arrangement read-back and validation:** `kyx_arrange` returns IDs/counts for the scenes, clips and cue markers found in the committed project, with one-based section starts and actual clip lengths. Invalid energy/length inputs fail before commands are built; one undo and entity parity remain covered.
- **Take workflow read-back:** `kyx_takes` lists stable group/take IDs and per-take clip counts without returning every clip ID. Activation and deletion verify the committed project state, expose typed outcomes and undo-step counts, and deletion checks that other take clips and group pruning match the expected result. Direct tests cover no-ops, invalid identifiers, destructive refusal and undo; web and desktop tests cover structured transport output.
- **Routing group undo parity:** `createGroupTrack` accepts an optional name in the canonical command; `kyx_routing createGroup` no longer commits creation and rename as separate history entries. The handler verifies one new group and returns its committed ID/name and undo count; tests prove one undo removes it and redo restores it.
- **Routing read-back and retry safety:** `kyx_routing` now declares a strict output schema for route/group/return inventories and every operation result. Mutations verify committed read-back; repeated route, send and return-gain writes report no-op status without adding undo entries. Ambiguous names and malformed/bounded inputs fail explicitly. Web and desktop relay tests pin structuredContent and schema discovery.
- **Marker inventory and exact targeting:** `kyx_markers` now lists stable marker IDs/positions, supports exact marker IDs for rename/removal and keeps nearest-bar matching as a compatibility fallback. Writes verify committed state; same-name rename is a no-op. Invalid ops and fractional bars fail before mutation. Web and desktop transport tests cover the structured result and schema discovery.
- **Section inventory and exact edits:** `kyx_sections` lists stable scene IDs and committed position/length/intensity, accepts scene ID, exact name, 1-based index, or an unambiguous role, and verifies add/remove/duplicate/reorder/resize/intensity outcomes. Same-value size/intensity edits and boundary reorders return explicit no-op statuses; removal remains behind the destructive-operation gate. Web and desktop tests pin structured results and schema discovery.
- **Musical-state validation and read-back:** `kyx_music` rejects fractional BPM/meter/step/semitone values, limits pattern length to the command-layer 128-step ceiling, validates keys against the supported enum, and returns committed state. `transposeAll` reports fully shifted, missing and MIDI-boundary-clamped notes as structured counts; unpitched or empty targets fail or no-op explicitly.
- **Note transpose atomicity:** `kyx_notes transpose` folds canonical `moveNote` command results into one snapshot command, validates integer semitone shifts, verifies committed pitches and reports boundary clamps honestly. Real-`ProjectStore` tests prove a successful or partial multi-note shift is exactly one undo step and one undo restores all changed notes; a fully clamped shift adds no history.
- **Note quantize target safety:** an MCP family/track-targeted quantize previously called canonical whole-pattern commands and could shift notes on unrelated tracks. The canonical quantize commands now accept an optional target track ID; `kyx_notes` supplies its resolved exact ID, while existing UI callers omit it and retain whole-pattern behavior. MCP tests reproduce the cross-track regression and cover scale/grid isolation, repeat no-op, one-step undo, exact track targeting, and invalid selectors/keys.
- **Note tool output and stable targeting:** `kyx_notes` publishes a strict output schema; list pages are capped at 40 and include stable note IDs plus authoritative ticks and derived beats. Move/delete/velocity accept note IDs while preserving index compatibility. Every successful operation returns committed read-back, with real-store tests for note-ID editing and undo and web/desktop tests for structuredContent.
- **Drum step edit validation and read-back:** `kyx_steps` uses the project model's actual 128-step ceiling; malformed mixed step arrays and invalid velocities fail before mutation. Pad fan-out and changed-cell output are bounded, repeated writes that would leave state unchanged add no undo step, and successful edits return exact committed cell values/probabilities plus per-pad hit counts. Real-store tests cover atomic rejection, no-op history and undo; web and desktop tests cover structuredContent.
- **Groove target and result contract:** `kyx_groove` rejects malformed directions and percentages, resolves a unique section role or requires exact `sectionId`, and extends the canonical section-groove intent with stable scene targeting. It verifies committed global swing/humanize values or exact changed per-step microtiming cells; repeating an absolute global setting is a semantic no-op with no undo entry.
- **Still partial:** twenty-two tools publish output schemas; the other 15 remain text-first. Web transport still exposes error codes through text rather than the full internal result envelope. Checkpoint save/delete and preview remain external/UI state outside ProjectStore undo by design.
- **Mirror gate:** the current `npm run verify:mcp-mirrors` check passes; generated desktop and web catalogs match `src/mcp/tools.ts`.

## Security and runtime limits

- Desktop MCP is opt-in and loopback/token scoped; the server does not expose an arbitrary filesystem tool or shell execution tool.
- Web relay access requires its configured token. Relay URL overrides use the existing host allowlist.
- SFZ sample import is an explicit base64 operation with its own decoded-size cap; gallery publishing deliberately sends project/share data to a network service.
- Runtime transport calls require the live app/owning renderer. No production headless server or project lifecycle API is exposed.
- The project supports undo/redo for ordinary MCP-originated document commands. Project switch serialization/stale edit behavior is governed by the relay’s single-window ownership model; broader concurrent multi-window conflict handling is not verified here.

## Audit limits

This is a source and test audit, not a packaged-app run. No external MCP client was attached, no audio hardware route was exercised, and the full Vitest suite was not run at this stage. The findings above are supported by source path traces and existing tests, not claims of end-to-end packaged acceptance.

Verification update: the full suite before blind A/B hardening passed 12,672 tests, skipped 129 and had one in-flight `plugin-audit-measurement.test.ts` failure against concurrently modified plugin-audit source. Blind A/B hardening passed 182 focused MCP tests and 19 desktop HTTP/stdio tests. The mix-idea increment passed 166/166 tests across the MCP tools, web relay, desktop HTTP/stdio and mirror-sync suites. The genre-mix increment passed 55/55 tests across producer moves, web relay, desktop HTTP/stdio and mirror-sync. The arrangement increment passed 58/58 across the same transport and producer surfaces. The take-management increment passed 174/174 tests across MCP tools, web relay, desktop HTTP and mirror-sync. The routing undo-parity increment passed 147/147 tests across `groupTracks.test.ts` and `mcp-tools.test.ts`. The structured-routing increment passed 176/176 MCP tool, relay, desktop and mirror tests; the marker increment passed 180/180; and the section increment passed 185/185 MCP tool, web relay, desktop HTTP and mirror-sync tests; note/quantize and MCP control suites passed 231/231, including canonical command, web, desktop and mirror tests; the agent-map gate passed 4/4 (235/235 combined). The latest `npm run typecheck`, mirror verification, changed-file Prettier and `git diff --check` pass. The most recent full `npm run test:expectations` run before the marker increment completed 1,139 files: 12,702 passed, 129 skipped, 1 todo, no failures, and the suite ledger ratchet held. The repository-wide `format:check` still fails on five unrelated files.

Step-grid verification update: the step, note/quantize, MCP tool, web/desktop transport, mirror and agent-map suites passed 238/238; the independent bridge bucket tests passed 3/3 (241/241 combined). `npm run typecheck`, `npm run verify:mcp-mirrors`, changed-file Prettier and `git diff --check` pass.

Transport verification update: bounded integer seek/loop controls, exact scene-ID launch, partial seek detection and structured transport read-back passed the MCP, web relay and desktop HTTP tests. The integrated step/transport/MCP/mirror/agent-map run passed 242/242; bridge bucket isolation passed 3/3 (245/245 combined).

Groove verification update: the integrated groove/step/transport/MCP/relay/mirror/agent-map/bridge suite passed 249/249; typecheck, generated MCP mirror verification, changed-file Prettier and `git diff --check` passed.
