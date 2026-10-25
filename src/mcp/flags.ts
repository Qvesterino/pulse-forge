/**
 * KYX MCP — USER FLAGS (docs/INTENT-MCP-EXPANSION-PLAN.md §D4, ADR 0065).
 *
 * Destructive MCP ops (removing tracks/sections/FX instances) are locked
 * behind this persisted user flag — default OFF, flipped in the MCP chip.
 * The tool layer reads it live on every call, so flipping takes effect
 * immediately without rebinding the host.
 *
 * EXTERNAL MUTATION CONSENT (ADR 0065) — the second flag.
 *
 * The audit that produced the frontier program found that of the 39 MCP
 * tools, 21 are `mutate` and only the 7 `destructive` ones were gated. An
 * agent arriving over a transport could therefore rewrite the user's
 * project with no consent of any kind. This flag is the standing consent
 * that closes that gap:
 *
 *   OFF (default) — an external agent may READ, may run runtime tools, and
 *                    may not change the document. Its mutating calls are
 *                    refused with a reason the user can act on.
 *   ON            — the user has said yes to agent-driven edits. The call
 *                    still goes through the stale-write guard, the scope
 *                    guard, the audit log and the undo frame.
 *
 * The flag is deliberately a STANDING consent, not a per-call prompt: the
 * per-call approval UI does not exist in KYX yet (ZYVO's does). It is
 * strictly stronger than the old behaviour and strictly weaker than a
 * per-call approval — that gap is recorded, not hidden.
 */
const FLAG = "pf:mcp-allow-destructive";
const MUTATIONS_FLAG = "pf:mcp-allow-mutations";

export function mcpAllowDestructive(): boolean {
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

export function setMcpAllowDestructive(on: boolean): void {
  try {
    if (on) localStorage.setItem(FLAG, "1");
    else localStorage.removeItem(FLAG);
  } catch {
    /* private mode — flag stays session-off */
  }
}

/**
 * Standing consent for EXTERNAL agents (web relay, desktop stdio, QMR) to
 * apply mutating calls. The human working the app is NOT gated by this —
 * their edits carry no agent id, and the in-app intent flow already
 * previews and applies through their own hands.
 */
export function mcpAllowMutations(): boolean {
  try {
    return localStorage.getItem(MUTATIONS_FLAG) === "1";
  } catch {
    return false;
  }
}

export function setMcpAllowMutations(on: boolean): void {
  try {
    if (on) localStorage.setItem(MUTATIONS_FLAG, "1");
    else localStorage.removeItem(MUTATIONS_FLAG);
  } catch {
    /* private mode — flag stays session-off */
  }
}
