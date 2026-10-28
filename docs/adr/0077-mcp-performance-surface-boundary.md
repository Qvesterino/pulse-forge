# ADR 0077 — MCP Performance-Surface Boundary (macros and Live Sets)

Date: 2026-10-28
Status: ACCEPTED
Supersedes: none
Related: ADR 0065 (permission lattice and scope guard), 0046 (headless MCP host), AS-015 in `docs/audits/2026-10-26-ai-action-space/AI-ACTION-SPACE-AUDIT.md`

## Context

The action-space audit found the live-performance surface — Live Sets (the 4×16 pad loop launcher), performance macros, pad launches, QWERTY jam, Link/MTC/PCM — entirely human-only. It split the surface by risk:

- **R1 (reversible document edits):** Live-Set CRUD, launch options, pad _assignments_, macro values/names. These are plain `ProjectDocument` mutations that already ride the command layer with undo (`src/commands/liveSets.ts`, `setMacroValue`/`renameMacro` in `src/commands/automation.ts`). An agent preparing a performance layout (build a set, name pads, wire a macro) needs exactly these.
- **R4 (live-critical realtime):** launching pads, toggling loops mid-performance, jam input, Link/MTC/PCM, and any gesture that changes what the audience hears NOW. The audit's standing rule: an AI path may affect realtime output only through the document (`engine.setProject`) or the already-sanctioned bar-quantized `launchScene`.

## Decision

1. **One home:** a single `kyx_performance` MCP tool owns the performance DOCUMENT surface: Live-Set list/create/duplicate/rename/select/options/pad-assign/clear and macro list/set/rename. Every op is a command through `ctx.execute` — one undo step, receipts with read-back, the standard gate chain (lattice, audit, idempotency, stale-write, dry-run, checkpoints).
2. **Deletion is destructive:** `deleteSet` rides the D4 gate with the auto-before checkpoint (the same parity standard every other removal follows since AS-004).
3. **The R4 boundary is a POLICY RECORD, not an omission:** the tool's description, the capability block's `unavailableByDesign`, and this ADR all state that pad LAUNCH, loop toggling and jam input are human-only. There is deliberately NO launch/trigger op on this tool. Making realtime performance agent-accessible would require a NEW ADR with an explicit authorization story (who consents, what the audience hears while an agent decides, how a stuck pad loop is stopped) — it is not a schema field away.
4. **Macro writes keep their collab sync:** `setMacroValue`/`renameMacro` are hand-written commands with `applyToYDoc` (live macro moves stream to collaborators). They stay hand-written; the ops are recorded on the AS-008 ops-coverage exemption list (`kyx_performance:setMacro`, `kyx_performance:renameMacro`) rather than being wrapped in snapshots, which would drop the y-doc bridge.

## Consequences

- An agent can PREPARE a live set end-to-end (create, name, options, pad assignments, macro moves) and verify it via read-backs; a human performs it. Preparation and performance are different jobs — this boundary encodes that split.
- The audit's parity gap for the performance-document half closes (~9 human actions become agent-executable, R1); the realtime half is now DECLARED human-only instead of silently missing (the honest-L0 rule).
- `selectLiveSet` only moves the `activeLiveSetId` pointer; nothing sounds until a human launches a pad — R1 by evidence, not by assumption.
- 32-set project cap and the 0–15 slot validation live in the commands, so the MCP surface cannot exceed what the UI can create.

## Verification

- `tests/mcp-performance.test.ts` — CRUD + macro set/rename with undo, deleteSet D4-gated WITH checkpoint, honest refusals (unknown set, bad slot, missing buffer), list read-backs.
- Seam `mcp-performance-surface` in `tests/seam-manifest.json`.
- Mirrors regenerated (`npm run gen:mcp-mirrors`).
