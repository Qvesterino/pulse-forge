import { McpBridge, type McpBridgeDeps } from "./bridge";
import { isMicRecordingActive } from "../audio-engine/PcmMicRecorder";
import { collabParamsFromSearch, defaultServerUrl } from "../collab/collabShared";
import { quickBounceDownload } from "../export/quick-bounce";
import { mcpRenderSummary } from "../mcp/render-summary";
import { mcpMeterSnapshotFromServices } from "./meters";
import { mcpApplyLoudness, mcpMeasureLoudness } from "./loudness";
import type { Services } from "../services";

/**
 * KYX MCP — WEB HOST (the enable/wiring half of the web transport,
 * docs/INTENT-MCP-EXPANSION-PLAN.md Phase D3).
 *
 * The collab server hosts POST /mcp (JSON-RPC for the external MCP client,
 * Bearer MCP_TOKEN) and WS /mcp-relay?token=<MCP_TOKEN> (the connected KYX
 * window). THIS module is the user-facing half: the ⚡ chip starts/stops an
 * {@link McpBridge} against the ACTIVE collab server (?server= override
 * through the shared `isAllowedServerUrl` gate, else the default relay),
 * persisting the opt-in + token so a reload re-arms it. OFF by default and
 * inert without a token — the relay socket cannot even authenticate without
 * the operator's MCP_TOKEN.
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

/** Append the relay path — pure so tests can pin the encoding. */
export function buildRelayUrl(serverUrl: string, token: string): string {
  const base = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
  return `${base}/mcp-relay?token=${encodeURIComponent(token)}`;
}

/** The streamable-HTTP endpoint an external MCP client points at (the same
 * server, http(s) scheme instead of the relay's ws(s)). */
export function mcpHttpEndpoint(serverUrl: string): string {
  const base = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
  return base.replace(/^ws:/, "http:").replace(/^wss:/, "https:") + "/mcp";
}

/** The MCP relay rides the ACTIVE collab server: the ?server= override when
 * present (already allow-listed by collabParamsFromSearch), else the default. */
export function mcpRelayServerUrl(search: string = typeof location !== "undefined" ? location.search : ""): string {
  return collabParamsFromSearch(search)?.serverUrl ?? defaultServerUrl();
}

let activeBridge: McpBridge | null = null;

/** Live relay state for the chip (false when never started). */
export function mcpWebBridgeConnected(): boolean {
  return activeBridge?.connected ?? false;
}

function depsFromServices(services: Services): McpBridgeDeps {
  return {
    getDoc: () => services.store.getDoc(),
    execute: (command) => services.store.execute(command),
    undo: () => services.store.undo(),
    redo: () => services.store.redo(),
    undoStackLength: () => services.store.undoStackLength,
    historyLabels: () => services.store.history.map((entry) => entry.label),
    isMicRecordingActive,
    transport: services.transport,
    // kyx_meter reads the LIVE engine (null when no audio context is up).
    meters: () => mcpMeterSnapshotFromServices(services),
    beginUndoFrame: (label) => services.store.beginUndoFrame(label),
    endUndoFrame: () => services.store.endUndoFrame(),
    measureLoudness: () => mcpMeasureLoudness(services),
    applyLoudness: (input) => mcpApplyLoudness(services, input),
    // kyx_export rides the SAME render + encode + download pipeline as the
    // in-app "export wav/mp3" intent (the download lands in the KYX window).
    export: (request) => quickBounceDownload(services.store.getDoc(), services.bank, request),
    // kyx_publish_gallery: encode the LIVE project into a gallery share code
    // and POST it with agent provenance (the feed shows the robot badge).
    shareToGallery: async ({ title, author, tags, agent }) => {
      const { encodeProjectForGallery, publishBeat } = await import("../gallery/galleryApi");
      const item = await publishBeat({
        title,
        author,
        tags,
        code: encodeProjectForGallery(services.store.getDoc()),
        origin: "agent",
        agent,
      });
      return { id: item.id };
    },
    // kyx_render_summary: the offline render + BS.1770 evidence pass.
    renderSummary: (request) => mcpRenderSummary(services, request),
  };
}

/** Start the relay bridge now (chip click). Returns the bridge or null when
 * the preconditions fail (no token). */
export function startMcpWebBridge(services: Services): McpBridge | null {
  const token = mcpRelayToken();
  if (token === "") return null;
  stopMcpWebBridge();
  activeBridge = new McpBridge(depsFromServices(services), buildRelayUrl(mcpRelayServerUrl(), token));
  activeBridge.start();
  return activeBridge;
}

export function stopMcpWebBridge(): void {
  activeBridge?.stop();
  activeBridge = null;
}

/** Boot-time re-arm: only starts when the user's persisted opt-in + token
 * are both present. Returns the stop function for the App effect contract. */
export function startMcpWebBridgeIfEnabled(services: Services): () => void {
  if (!mcpRelayEnabled() || mcpRelayToken() === "") return () => {};
  startMcpWebBridge(services);
  return () => stopMcpWebBridge();
}
