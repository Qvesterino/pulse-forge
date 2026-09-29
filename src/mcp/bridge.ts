import type { ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
import { executeMcpTool, type McpToolContext } from "./tools";

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
  export?: (format: "wav" | "mp3") => Promise<string>;
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

    const ctx: McpToolContext = {
      getDoc: () => this.deps.getDoc(),
      execute: (command) => this.deps.execute(command),
      undo: () => this.deps.undo(),
      redo: () => this.deps.redo(),
      undoStackLength: () => this.deps.undoStackLength(),
      historyLabels: () => this.deps.historyLabels(),
      isMicRecordingActive: () => this.deps.isMicRecordingActive(),
      transport: this.deps.transport,
      export: this.deps.export,
    };
    const result = executeMcpTool(ctx, record.tool, record.args ?? {});
    this.socket?.send(JSON.stringify({ type: "mcp-result", id: record.id, result }));
  }
}
