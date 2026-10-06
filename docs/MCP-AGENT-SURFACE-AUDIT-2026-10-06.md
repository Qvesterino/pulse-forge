# MCP AGENT-SURFACE AUDIT — 2026-10-06

**Scope:** all 36 KYX MCP tools as agent-driven attack/capability surface —
destructive-op gating, size caps, auth, error containment. The agents really
drive the DAW now (relay + desktop stdio + SDK clients), and the surface grew
organically (35 → 36 tools in two weeks).

## The destructive gate (D4)

`pf:mcp-allow-destructive` — persisted localStorage flag, **default OFF**,
read live on every call (`mcpAllowDestructive()` in flags.ts). The refusal
message tells the agent exactly what to tell the user ("locked — the user
must allow them in the KYX MCP chip (undoable edits still work)").

**Gated (with auto-checkpoint `auto-before-<tool>` where marked):**

| Tool       | Op         | Auto-checkpoint                          |
| ---------- | ---------- | ---------------------------------------- |
| kyx_tracks | remove     | ✓                                        |
| kyx_fx     | remove     | — (per-instance, one undo)               |
| kyx_clips  | delete     | — (one undo)                             |
| kyx_takes  | deleteTake | — (refuses the ACTIVE comp)              |
| kyx_master | remove     | ✓                                        |
| kyx_notes  | delete     | ✓ — **was UNGATED, fixed in this audit** |

**By-design ungated (documented decisions):**

- `kyx_checkpoint op:restore` — the documented recovery path the playbook
  teaches agents to use; one undo step returns to the pre-restore state, and
  restoring is how an agent UNDOES its own damage. Gating it would remove
  the safety rope. The diff preview (op:diff) keeps it informed.
- `kyx_checkpoint op:delete` — removes an agent-owned checkpoint (bounded
  store of 8); no user content touched.

**Fixed: `kyx_notes op:delete` shipped without the gate.** Every other
removal refuses until the user flips the chip — note delete was the
loophole that deletes a part one call at a time. Now gated with the
auto-checkpoint helper; pinned in tests/mcp-notes-music.test.ts (refusal
text + allowed path).

## Size caps

| Surface        | Cap                                                                                                                                                                                                                    | Where             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| kyx_batch      | 10 calls, same ctx (allowDestructive propagates)                                                                                                                                                                       | tools.ts          |
| Checkpoints    | 8 in-memory, oldest evicted                                                                                                                                                                                            | tools.ts          |
| Relay messages | 8 MB (`maxMessageBytes`)                                                                                                                                                                                               | collab-server.mjs |
| kyx_import_sfz | 256 MB decoded                                                                                                                                                                                                         | sfz-import.ts     |
| kyx_import_sfz | **NEW: pre-decode estimate (base64 chars × 3/4)** — the desktop stdio transport is unbounded, so a hugely oversized request used to allocate its full decoded size before the exact cap threw; now a clean early error | sfz-import.ts     |
| Share codes    | 2 M chars / 8 M decompressed                                                                                                                                                                                           | shareCode.ts      |
| Gallery POST   | server rate limits (429), same publishBeat path as the UI                                                                                                                                                              | collab-server.mjs |

## Auth & transport

- Relay requires a configured token — without one the server MCP surface is
  disabled (`mcp-core.mjs`: "no token configured → server disabled").
- The `?server=` override path goes through `isAllowedServerUrl`
  (collabShared.ts) — the AGENTS.md security invariant is intact for the MCP
  relay config.
- Desktop stdio is local-trust (user's own machine, authenticated session).
- Downloaded exports use `sanitizeFilename(doc.name)` (quick-bounce.ts).

## Verified clean

- Error containment: a throwing tool answers `mcp-result` with
  `isError: true` (pinned), timeouts 15/60 s per tool class.
- The deterministic intent layer answers before the model fallback; mining
  logs feed the corpus, never the other way.
- Playbook ROT GUARD caught kyx_master undocumented — playbook updated
  (finish-tools line) inside the 8000-char compactness budget; mirrors
  regenerated.
- Stale count pins fixed: mcp-core + desktop-mcp 35 → 36 tools with
  kyx_master in MCP_TOOLS order (the kyx_master landing had missed them —
  the same "pins follow features" disease drift:check now gates for
  artifacts).

## Method note

36 tools × read-only/mutating/destructive/network/file classification,
dispatch mapped from the `case "kyx_*"` switch + helper executors; every
removal op grepped and cross-checked against the 6 gate sites; byte paths
(sfz/atob, export, gallery) traced for caps and filename handling.
