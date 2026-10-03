import type { ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
import { executeMcpToolAsync, type McpExportRequest, type McpMeterSnapshot, type McpToolContext } from "./tools";
import { mcpAllowDestructive } from "./flags";
import { withAgentAttribution } from "./attribution";

/**
 * KYX MCP — BROWSER-SIDE RELAY BRIDGE (the execution half of the MCP
 * server, docs/INTENT-MCP-EXPANSION-PLAN.md Phase D3).
 *
 * When the user enables MCP (settings chip), the KYX window connects to the
 * collab server's `/mcp-relay` WebSocket with the server-issued token. The
 * server forwards each MCP `tools/call` here; this bridge executes it
 * through `executeMcpTool` (deterministic command layer + verification
 * read-back) and posts the result back. The relay socket is SEPARATE from
 * the y-websocket collab connection — MCP traffic never touches the
 * document sync protocol.
 *
 * Lifecycle: `start()` is user-initiated (opt-in), `stop()` releases the
 * socket. Auto-reconnect is bounded (3 attempts, 5 s apart) so a dead
 * server cannot churn the network forever.
 */

export interface McpBridgeDeps {
  getDoc(): ProjectDocument;
  execute(command: Command): void;
  undo(): void;
  redo(): void;
  undoStackLength(): number;
  historyLabels(): string[];
  isMicRecordingActive(): boolean;
  transport: McpToolContext["transport"];
  export?: (request: McpExportRequest) => Promise<string>;
  meters?: () => McpMeterSnapshot | null;
  beginUndoFrame?: (label?: string) => void;
  endUndoFrame?: () => void;
  measureLoudness?: () => Promise<{ integrated: number; measured: boolean }>;
  applyLoudness?: NonNullable<McpToolContext["applyLoudness"]>;
  shareToGallery?: NonNullable<McpToolContext["shareToGallery"]>;
  renderSummary?: NonNullable<McpToolContext["renderSummary"]>;
  diagnoseMix?: NonNullable<McpToolContext["diagnoseMix"]>;
}

export class McpBridge {
  private socket: WebSocket | null = null;
  private reconnects = 0;
  private stopped = true;
  private readonly deps: McpBridgeDeps;
  private readonly url: string;

  constructor(deps: McpBridgeDeps, url: string) {
    this.deps = deps;
    this.url = url;
  }

  get connected(): boolean {
    return this.socket != null && this.socket.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (!this.stopped && this.connected) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }

  private open(): void {
    try {
      this.socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket.onopen = () => {
      this.reconnects = 0;
      this.socket?.send(JSON.stringify({ type: "mcp-hello" }));
    };
    this.socket.onmessage = (event) => {
      void this.handleRelayMessage(event);
    };
    this.socket.onclose = () => {
      this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    };
    this.socket.onerror = () => {
      /* close handler owns reconnection */
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnects >= 3) return;
    this.reconnects += 1;
    setTimeout(() => {
      if (!this.stopped) this.open();
    }, 5000 * this.reconnects);
  }

  private async handleRelayMessage(event: MessageEvent): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message == null || typeof message !== "object") return;
    const record = message as { type?: string; id?: number; tool?: string; args?: unknown };
    if (record.type !== "mcp-call" || typeof record.id !== "number" || typeof record.tool !== "string") return;

    // every mutation executed for web-relay clients is attributed
    const ctx: McpToolContext = withAgentAttribution(
      {
        getDoc: () => this.deps.getDoc(),
        execute: (command) => this.deps.execute(command),
        undo: () => this.deps.undo(),
        redo: () => this.deps.redo(),
        undoStackLength: () => this.deps.undoStackLength(),
        historyLabels: () => this.deps.historyLabels(),
        isMicRecordingActive: () => this.deps.isMicRecordingActive(),
        transport: this.deps.transport,
        export: this.deps.export,
        meters: this.deps.meters,
        beginUndoFrame: this.deps.beginUndoFrame,
        endUndoFrame: this.deps.endUndoFrame,
        measureLoudness: this.deps.measureLoudness,
        applyLoudness: this.deps.applyLoudness,
        shareToGallery: this.deps.shareToGallery,
        renderSummary: this.deps.renderSummary,
        diagnoseMix: this.deps.diagnoseMix,
        allowDestructive: mcpAllowDestructive,
      },
      "web-relay",
    );
    // A throwing tool must still ANSWER — without this catch the relay would
    // never receive an mcp-result and the server-side call would hang until
    // its 15 s timeout (desktop host has the same guard). The async executor
    // additionally awaits kyx_export and returns the completion report.
    let result;
    try {
      result = await executeMcpToolAsync(ctx, record.tool, record.args ?? {});
    } catch (error) {
      result = {
        text: `tool crashed: ${error instanceof Error ? error.message : String(error)}`,
        mutated: false,
        isError: true,
      };
    }
    this.socket?.send(JSON.stringify({ type: "mcp-result", id: record.id, result }));
  }
}
