# AGENT KIT — how an agent works with KYX

> The entry document for building an agent (or an MCP client) against this DAW.
> The machine-readable companion is `docs/mcp-manifest.json`, generated from the
> live tool surface; `tests/agent-kit.test.ts` fails if the two disagree, so
> this document cannot drift away from what the app actually offers.
>
> Related: `docs/MCP-AGENT-SURFACE-AUDIT-2026-10-06.md` (the security audit),
> `docs/AGENTIC-DAW-PLAN.md` (product direction), `src/mcp/agentTrust.ts`
> (the enforcement).

## 1. What an agent is allowed to do, and who enforces it

Every tool carries a risk class and MCP-standard annotations:

| Risk          | Meaning                                                                                                                            | Annotation                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `read`        | observes only (state, meters, catalog)                                                                                             | `readOnlyHint: true`                             |
| `runtime`     | drives runtime/network/file state, never the document (transport, export, audio preview, gallery publish, render/diagnose reports) | not read-only, not destructive                   |
| `mutate`      | changes the document through the command layer                                                                                     | `destructiveHint: false`                         |
| `destructive` | CONTAINS removals (tracks, effects, clips, takes, master chain…)                                                                   | `destructiveHint: true` — clients should confirm |

The app enforces the classes, not the agent's goodwill:

- **A pre-session checkpoint is taken before the first mutating call of a
  session** (`agent-session-<time>`), so "revert everything this agent just did"
  is one action in the Activity Center.
- **Every call is audited** (tool, risk, whether the document mutated, error
  code, duration, a bounded argument summary) in a local log the user can read
  and export — and the Trust Report includes it.
- **Destructive operations are gated** by a user-held flag; the gate is in the
  app, and a refusal is a normal, well-formed error — not a crash.
- **Dry runs** (`dryRun: true`) execute the tool's FULL logic against a sandbox
  document and report exactly which commands _would_ apply. They are refused
  for `runtime` tools, because a dry-run cannot un-play a note.

## 2. The workflow that works

1. **Read first.** `kyx_state` (and `kyx_catalog`, `kyx_meter`) tell you what
   the project is before you touch it.
2. **Preview.** For any document change, send `dryRun: true` and read the
   "would apply N command(s): …" line. That is the same command set a real run
   commits, so it is a faithful preview.
3. **Apply small.** One intent per call beats one giant batch: the undo stack,
   the audit log and the checkpoint all stay legible.
4. **Ask before removals.** `destructiveHint: true` means confirm with the user
   first; if they say no, propose an alternative instead.
5. **Verify.** `kyx_state` after applying, or `kyx_checkpoint {op:"diff"}`.
   For an EFFECT change, read the insert's own telemetry:
   `kyx_meter {"scope":"fx"}` returns every inserted effect with what its
   wrapper exposes — KOREŇ reports f0, clarity, "+x dB harmonics", the key
   scaler and the hint flag; dynamics report their gain-reduction stages; a
   bypassed or degraded insert honestly says "no telemetry" instead of zeros.
   That is the closed loop: apply → read → decide.
6. **Persist before you finish.** `mutated: true` means the DOCUMENT changed;
   it does not mean the project was saved. Call `kyx_save` and require
   `stage: "persisted"` (and `ok: true`) before ending a session that must
   survive a reload. A result's `stage` is the truth: `applied` < `persisted`
   < `rendered`; `delivered` is reserved for a verified download receipt.

### Worked example A — read-only survey (safe everywhere)

```
kyx_state {"subject":"summary"}                  → docId, name, bpm, tracks
kyx_catalog {"kind":"effects"}                   → what the project can use
kyx_meter {"target":"master"}                    → current levels (no mutation)
```

### Worked example B — a checkpointed, previewed change

```
kyx_intent  {"prompt":"dark drill at 145","dryRun":true}
  → "would apply 3 command(s): …"          (nothing touched)
kyx_intent  {"prompt":"dark drill at 145"}
  → mutated on document "<name>" (id <docId>)
kyx_checkpoint {"op":"list"}
  → includes agent-session-<time>          (the pre-session safety net)
```

If the user dislikes it: **Activity Center → REVERT SESSION** restores the
project to before the session's first change, as one undoable step.

### Worked example C — control a flagship instrument by exact track ID

```text
kyx_catalog {"subject":"instruments"}
  → registered instrument kinds, including kopa and tsar
kyx_catalog {"subject":"instrument","instrument":"kopa"}
  → KOPA's public parameters, native ranges, units, steps and choices
kyx_tracks {"op":"addInstrument","instrument":"kopa"}
kyx_state {"subject":"tracks"}
  → retrieve the new track's exact id
kyx_instrument_param {"op":"list","trackId":"<track-id>"}
kyx_instrument_param {"op":"set","trackId":"<track-id>","param":"<catalog-id>","value":<native-value>}
  → committed read-back; one undo step when the value changed
```

The same flow works for TSAR. Read the parameter catalog first and send an
absolute native value. A successful state edit does not prove that the agent
heard or auditioned the patch.

### Worked example D — a destructive request, handled properly

```
kyx_takes {"op":"deleteTake","takeId":"…"}       → POLICY_REFUSED while the
                                                     destructive flag is off
```

Do not retry in a loop and do not try to route around the gate: tell the user
what you want to remove and why, and let them enable it. The refusal message is
the honest answer.

## 3. Identity, idempotency, attribution

- **Idempotency:** every envelope accepts `requestId`; a repeat with the same id
  is a replay (`replayed: true`) and executes nothing twice. Use it for any
  call that may be retried.
- **Attribution:** mutating results state the document (`name` + `id`) they ran
  against, and the audit records the agent identity per call.
- **Sessions:** a session is a run of mutating calls by one agent; it ends on a
  revert, on a project change, or after 15 minutes of silence.

## 4. Connecting

| Transport       | Where                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| Desktop (stdio) | `desktop/mcp-host-manager.cjs`; tool defs in `desktop/mcp-tool-defs.cjs` |
| Web relay       | `server/mcp-core.mjs` (`/api/mcp`); tool defs are generated mirrors      |
| In-process      | `createHeadlessMcpHost()` in `src/mcp/headless-host.ts` (tests, tooling) |

The tool definitions in the mirrors are GENERATED from `src/mcp/tools.ts` by
`npm run gen:mcp-mirrors` — never hand-edit them. The agent manifest is
generated by `npm run gen:agent-kit`.

## 5. What this kit does not promise

- Nothing about a specific model's behaviour; the rules above are enforced by
  the app regardless of who is calling.
- No network path: the audit log, checkpoints and the Trust Report are local to
  the user's machine, by design.
- No forward compatibility of tool arguments beyond the published schemas; use
  `docs/mcp-manifest.json` and the tool schemas as the contract.
