import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { listenForCommands } from "@qvester/qmr-hud/command-bus.ts";
import type { McpToolContext } from "../mcp/tools";
import { QMR_KYX_MANIFEST } from "../interop/qmrBridge";
import type { Services } from "../services";

/**
 * QMR CHIP MOUNT — the REAL Qvester QMR HUD chip, mounted in KYX exactly
 * the way every monorepo app does it (lazy chunk, error boundary,
 * Suspense), with the KYX capability manifest passed as a prop override
 * and the command bus wired to the MCP tool layer:
 *
 *   QMR panel click ("kyx.song", "edit.undo", …)
 *     → qmr:command host-bus event
 *     → THIS component's handler
 *     → executeMcpToolAsync (deterministic command layer, one undo,
 *       verification read-backs, D4 lock)
 *     → qmr:command-response ack
 *
 * The package ships TS source resolved via vite aliases (see
 * vite.config.ts) — never bundled into the entry chunk: the chip trigger
 * is a small lazy chunk and the full panel loads only after an explicit
 * user action (chip click / Ctrl+K).
 */

const QmrMiniChipMount = lazy(() =>
  import("@qvester/qmr-hud/qmr-mini-chip-mount.tsx").then((module) => ({
    default: module.QmrMiniChipMount as ComponentType<{
      appId?: string;
      surfaceId?: string;
      manifest?: unknown;
    }>,
  })),
);

class QmrErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  override state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) return null; // the lab/app stays usable without the HUD
    return this.props.children;
  }
}

/** Command-type → MCP tool routing (host-bus handler core). Exported for
 * tests — the same mapping the live listener uses. */
export function qmrCommandToToolCall(type: string): { tool: string; args?: Record<string, unknown> } | null {
  if (type === "edit.undo") return { tool: "kyx_undo", args: { action: "undo" } };
  if (type === "edit.redo") return { tool: "kyx_undo", args: { action: "redo" } };
  if (type.startsWith("kyx.")) {
    const tool = `kyx_${type.slice(4)}`;
    if (!/^kyx_[a-z_]+$/.test(tool)) return null;
    return { tool };
  }
  return null;
}

export function createQmrCommandHandler(ctx: McpToolContext): (command: {
  type: string;
  [key: string]: unknown;
}) => Promise<{
  ok: boolean;
  unsupported?: boolean;
  message?: string;
}> {
  return async (command) => {
    const call = qmrCommandToToolCall(command.type);
    if (call == null) return { ok: false, unsupported: true };
    // The MCP surface loads on first QMR command — the chip renders eager,
    // the 31-tool execution layer does not (bundle-boot diet).
    const { executeMcpToolAsync } = await import("../mcp/tools");
    try {
      const result = await executeMcpToolAsync(ctx, call.tool, { ...(call.args ?? {}), ...command });
      return { ok: result.isError !== true, message: result.text.slice(0, 240) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
}

export function QmrChipMount({ services }: { services: Services }): ReactNode {
  // QMR-driven mutations are attributed so the shared undo history stays legible
  const [ctx, setCtx] = useState<McpToolContext | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([import("../mcp/desktop-host"), import("../mcp/attribution")]).then(([host, attribution]) => {
      if (!cancelled) setCtx(attribution.withAgentAttribution(host.mcpToolContextFromServices(services), "qmr"));
    });
    return () => {
      cancelled = true;
    };
  }, [services]);
  useEffect(() => {
    if (!ctx) return;
    // Host side of the QMR command bus: the panel dispatches, we execute
    // through the MCP layer and ack with the outcome.
    return listenForCommands("pulse_forge", createQmrCommandHandler(ctx));
    // ctx reads through services live; a services swap remounts this effect.
  }, [ctx]);

  return (
    <QmrErrorBoundary>
      <Suspense fallback={null}>
        <QmrMiniChipMount appId="pulse_forge" surfaceId="main" manifest={QMR_KYX_MANIFEST} />
      </Suspense>
    </QmrErrorBoundary>
  );
}
