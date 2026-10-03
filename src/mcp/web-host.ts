import { McpBridge, type McpBridgeDeps } from "./bridge";
import { isMicRecordingActive } from "../audio-engine/PcmMicRecorder";
import { quickBounceDownload } from "../export/quick-bounce";
import { mcpRenderSummary } from "../mcp/render-summary";
import { mcpMeterSnapshotFromServices } from "./meters";
import { mcpApplyLoudness, mcpMeasureLoudness } from "./loudness";
// Relay CONFIG lives in the tiny eager module (the IntentPanel reads the
// enabled flag while mounting); the heavy bridge module re-exports it and
// imports it for local use.
import { mcpRelayEnabled, mcpRelayToken, mcpRelayServerUrl } from "./relayConfig";
export { mcpRelayEnabled, setMcpRelayEnabled, mcpRelayToken, setMcpRelayToken, mcpRelayServerUrl } from "./relayConfig";
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

/** The paste-ready MCP client config for a relay URL (IntentPanel config
 * row) — lives here so the lazy consumer needs no second module. */
export function mcpConfigText(serverUrl: string): string {
  return JSON.stringify({ url: mcpHttpEndpoint(serverUrl), headers: { authorization: "Bearer <MCP_TOKEN>" } }, null, 2);
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
    // kyx_diagnose_mix: the interpretation layer — attributed findings + fixes.
    // Lazy: loads with the first diagnose call, not on boot (bundle budget).
    diagnoseMix: (request) => import("../mcp/mix-diagnosis").then((m) => m.mcpDiagnoseMix(services, request)),
  };
}

/** Start the relay bridge now (chip click). Returns the bridge or null when
 * the preconditions fail (no token). */
export function startMcpWebBridge(services: Services): McpBridge | null {
  const token = mcpRelayToken();
  if (token === "") return null;
  // The preset bank rides the same lazy discipline — warm it so the intent
  // route's sync preset parsers read a present bank when agents ask.
  void import("../presets/factory-loader").then((m) => m.warmFactoryPresets());
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
