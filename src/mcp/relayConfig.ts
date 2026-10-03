import { collabParamsFromSearch, defaultServerUrl } from "../collab/collabShared";

/**
 * MCP relay CONFIG (localStorage flags + URL resolution) — deliberately
 * separate from the web-host bridge so boot-path consumers (the IntentPanel
 * reads `mcpRelayEnabled()` while mounting) can stay eager without dragging
 * the 31-tool surface into the studio boot chunk. The bridge module
 * re-exports these for its own consumers.
 */

const ENABLED_KEY = "pf:mcp-relay-enabled";
const TOKEN_KEY = "pf:mcp-relay-token";

function readFlag(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeFlag(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode — the flag stays session-scoped off */
  }
}

export function mcpRelayEnabled(): boolean {
  return readFlag(ENABLED_KEY) === "1";
}

export function setMcpRelayEnabled(on: boolean): void {
  writeFlag(ENABLED_KEY, on ? "1" : null);
}

export function mcpRelayToken(): string {
  return readFlag(TOKEN_KEY);
}

export function setMcpRelayToken(token: string): void {
  writeFlag(TOKEN_KEY, token.trim() === "" ? null : token.trim());
}

/** The MCP relay rides the ACTIVE collab server: the ?server= override when
 * present (already allow-listed by collabParamsFromSearch), else the default. */
export function mcpRelayServerUrl(search: string = typeof location !== "undefined" ? location.search : ""): string {
  return collabParamsFromSearch(search)?.serverUrl ?? defaultServerUrl();
}
