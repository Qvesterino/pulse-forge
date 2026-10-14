# P1-D — MCP RELAY SESSION OWNERSHIP (finding + repair)

**Date:** 2026-10-13 · **Repo:** KYX (`D:\pulse-forge`) · **Class:** P1 (wrong target, no trace)
**Status:** defect REPRODUCED → FIXED → VERIFIED (9/9 specs, each falsified against the pre-fix behaviour)

P1-D was filed as _"first resolve the UNKNOWN — does the web relay share the single-session
model?"_. The UNKNOWN is now resolved, and the answer was not a design preference but a
**reproducible data-integrity defect**.

---

## 1. What the UNKNOWN actually was

The relay is single-session **by construction**, and it was single-session **by accident**:

| Layer   | Before                                      | Evidence                                 |
| ------- | ------------------------------------------- | ---------------------------------------- |
| Hub     | one boolean `sessionConnected`              | `server/mcp-core.mjs:2111` (pre-fix)     |
| Server  | one `mcpRelaySocket` variable               | `server/collab-server.mjs:898` (pre-fix) |
| Desktop | separate loopback bridge, own single window | `desktop/mcp-host-manager.cjs`           |

## 2. The defect

Two KYX windows, both opted into MCP with the same `MCP_TOKEN`:

1. Window A connects to `/mcp-relay`. `mcpRelaySocket = A`, `connectSession()`.
2. Window B connects. `mcpRelaySocket = B` — **silently**. Nothing tells A.
3. The server forwards each `tools/call` to B, but **A is still connected** and still
   answers: `handleSessionMessage` accepted `mcp-result` frames from _any_ socket.
4. A call can therefore be executed against **A's project document** while the agent
   believes it is holding **B's** — and the call resolves **successfully**.

That is the Phase 3 failure the audit exists to close: _a change that reports success
while missing its real target._ Nothing in the result identified which window executed it.

**Reproduction** (the reduced form is spec 1 of the suite):

```
hub.connectSession("window-A");
const call = hub.callTool("kyx_state", {});      // pending, id 1
hub.connectSession("window-B");                  // silent takeover
hub.handleSessionMessage(result(1, "mutated A"), "window-A");  // → was ACCEPTED
```

## 3. The repair

Minimal, reversible, three files, no change to the tool surface or the command spine.

- **`server/mcp-core.mjs`** — the hub now names the session that owns the relay.
  `connectSession(id)` / `disconnectSession(id)` / `handleSessionMessage(msg, id)`, plus a
  `sessionId()` accessor. A result is honoured **only** from the current session; a
  displaced window's close cannot tear down the session that replaced it. Both parameters
  **default**, so the desktop bridge and every existing suite keep the old signature —
  one dialect, not two.
- **`server/collab-server.mjs`** — each relay connection gets an identity
  (`relay-<seq>`). Ownership still moves last-writer-wins (an in-flight session is not torn
  down under an agent mid-export), but it moves **in the open**: the displaced window is
  closed with `4409` + a reason, and the pre-existing `mcpRelaySocket === conn` guard means
  the loser's close event cannot disconnect the winner.
- **`src/mcp/bridge.ts`** — the browser reads that close code. A takeover is a _decision_,
  not a network fault: reconnecting would hand the relay back and two live windows would
  flap ownership. The bridge stops, calls the new optional `onDisplaced(reason)`, and says so.

### Deliberately NOT done

- No multi-session architecture. That is the L-sized half of P1-D and still open; this is
  the S-sized half (correct routing + an honest close), and it closes the _silent_ variant.
- No change to auth, tokens, rate limits, the D4 destructive gate, or the tool surface.
- The desktop bridge is untouched — it already had a single window by architecture.

---

## 4. Evidence

`tests/mcp-relay-session-ownership.test.ts` — 9 specs.

| Spec                                                  | Proves                                               |
| ----------------------------------------------------- | ---------------------------------------------------- |
| displaced answer cannot resolve the live call         | the defect itself, reduced                           |
| displaced **close** cannot tear down the winner       | the fix does not trade one race for another          |
| owner close still rejects in-flight calls             | unchanged contract                                   |
| single-window host works with no ids                  | desktop/back-compat                                  |
| second window takes the relay; first closed with 4409 | real server, real `ws` sockets                       |
| `tools/call` reaches the OWNER and is answered        | routing follows ownership, end to end                |
| unauthorized handshake still refused                  | the fix did not widen auth                           |
| displacement close STOPS the bridge + reports         | browser side, no reconnect storm                     |
| CONTROL: an ordinary close still reconnects           | the guard discriminates rather than blanket-stopping |

### Falsification (each guard, individually)

Every guard was disabled and the suite re-run, so no spec is credited with a defect it does
not catch:

| Guard disabled             | Observed failure                                                     |
| -------------------------- | -------------------------------------------------------------------- |
| hub identity check         | `expected true to be false` — A's answer was accepted                |
| server `displaced.close()` | both server specs: `relay socket never emitted "close"`              |
| bridge displacement check  | `expected […] to have a length of 1 but got 2` — the reconnect storm |

Source restored from backup and hash-verified before the green run.

### Commands run

```
npx vitest run tests/mcp-relay-session-ownership.test.ts   → 9/9
npx vitest run tests/mcp-relay-session-ownership.test.ts tests/mcp-core.test.ts \
                 tests/mcp-sdk-client.test.ts tests/mcp-web-host.test.ts \
                 tests/mcp-idempotency.test.ts                → 47/47
npm run typecheck                                          → exit 0
npx prettier --check <changed files>                        → clean
```

### Two harness traps worth recording

Both cost real time and neither is a product bug:

1. **`ws` emits `close` as `(code, reason)` — two positional arguments.** A handler taking
   only the first returns the bare code, which then reads as "the close arrived but had no
   code". That is how a _passing-looking_ displacement check can assert nothing.
2. **`server.close()` waits on live WebSocket clients forever.** Teardown must terminate
   `wss.clients` and close `wss` first, or the failure surfaces as an unrelated hook timeout.

---

## 5. Residual risk / what is still open

- **Same window, two projects** is still single-session: one executor, one document. True
  per-session routing (L) is not implemented — an agent still cannot address two projects at once.
- **`onDisplaced` has no UI yet.** The bridge reports the reason through the callback; no
  panel renders it yet, so the displaced window's chip currently just shows "disconnected".
  Surfacing it in the MCP settings chip is the obvious next slice.
- The `mcp-hello` frame the bridge sends on open is still ignored by the server (dead
  protocol frame) — harmless today, but it is not the handshake it looks like.
