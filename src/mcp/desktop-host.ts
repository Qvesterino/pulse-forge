import { executeMcpTool, type McpToolContext } from "./tools";
import { mcpAllowDestructive } from "./flags";
import { isMicRecordingActive } from "../audio-engine/PcmMicRecorder";
import { quickBounceDownload } from "../export/quick-bounce";
import type { Services } from "../services";

/**
 * KYX MCP — DESKTOP HOST (the renderer half of the desktop stdio transport,
 * docs/INTENT-MCP-EXPANSION-PLAN.md Phase D2).
 *
 * Electron main owns the opt-in loopback bridge + stdio forwarder
 * (desktop/mcp-host-manager.cjs). When an external MCP client calls a tool,
 * main relays it to the focused window over the `kyx:mcp:call` IPC; THIS
 * module binds that event to `executeMcpTool` — the exact same deterministic
 * command layer + verification read-back the browser relay uses — and
 * answers over `kyx:mcp:answer`. The MCP layer is a transport, never a
 * bypass: no document mutation happens outside the command layer.
 */

/** Status shape returned by main's McpHostManager (desktop/mcp-host-manager.cjs). */
export type McpDesktopStatus = Awaited<ReturnType<DesktopMcpApi["status"]>>;

/** Structural mirror of the `mcp` namespace exposed by desktop/preload.cjs. */
export interface DesktopMcpApi {
  status: () => Promise<{
    enabled: boolean;
    running: boolean;
    bridgeUrl: string | null;
    token: string | null;
    clientConfig: { command: string; args: string[]; env: Record<string, string> } | null;
  }>;
  enable: () => Promise<unknown>;
  disable: () => Promise<unknown>;
  /** Subscribe to forwarded tool calls; returns an unsubscribe function. */
  onCall: (listener: (call: { id: string; name: string; args?: unknown }) => void) => () => void;
  /** Resolve a forwarded call: { id, result: { text, mutated, isError? } }. */
  answer: (payload: { id: string; result: { text: string; mutated?: boolean; isError?: boolean } }) => Promise<void>;
}

/** The `kyxDesktop.mcp` API when running under the desktop shell, else null. */
export function getDesktopMcpApi(): DesktopMcpApi | null {
  const desktop = (window as { kyxDesktop?: { isDesktop?: boolean; mcp?: DesktopMcpApi } }).kyxDesktop;
  return desktop?.isDesktop === true && desktop.mcp ? desktop.mcp : null;
}

/** Build the tool context from the app services (same shape as the browser relay). */
export function mcpToolContextFromServices(services: Services): McpToolContext {
  return {
    getDoc: () => services.store.getDoc(),
    execute: (command) => services.store.execute(command),
    undo: () => services.store.undo(),
    redo: () => services.store.redo(),
    undoStackLength: () => services.store.undoStackLength,
    historyLabels: () => services.store.history.map((entry) => entry.label),
    isMicRecordingActive,
    transport: services.transport,
    // kyx_export rides the same render + encode + download pipeline as the
    // in-app export intent (download lands in the focused KYX window).
    export: (format) => quickBounceDownload(services.store.getDoc(), services.bank, format),
    allowDestructive: mcpAllowDestructive,
  };
}

/**
 * Bind the window to main's MCP relay. No-op (returns a noop unbind) in the
 * browser — the web transport uses the /mcp-relay WebSocket instead.
 */
export function startMcpDesktopHost(services: Services): () => void {
  const api = getDesktopMcpApi();
  if (!api) return () => {};
  const ctx = mcpToolContextFromServices(services);
  return api.onCall((call) => {
    void (async () => {
      try {
        const result = executeMcpTool(ctx, String(call?.name ?? ""), call?.args ?? {});
        await api.answer({ id: String(call?.id ?? ""), result: { text: result.text, mutated: result.mutated } });
      } catch (error) {
        await api.answer({
          id: String(call?.id ?? ""),
          result: { text: error instanceof Error ? error.message : String(error), isError: true },
        });
      }
    })();
  });
}
