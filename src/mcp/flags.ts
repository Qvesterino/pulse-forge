/**
 * KYX MCP — USER FLAG (docs/INTENT-MCP-EXPANSION-PLAN.md §D4).
 *
 * Destructive MCP ops (removing tracks/sections/FX instances) are locked
 * behind this persisted user flag — default OFF, flipped in the MCP chip.
 * The tool layer reads it live on every call, so flipping takes effect
 * immediately without rebinding the host.
 */
const FLAG = "pf:mcp-allow-destructive";

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
