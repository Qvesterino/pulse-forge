import type { ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
import {
  executeMcpToolAsync,
  type McpExportRequest,
  type McpFxMeterSnapshot,
  type McpMeterSnapshot,
  type McpToolContext,
} from "./tools";
import { mcpAllowDestructive, mcpAllowMutations } from "./flags";
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

/**
 * Close code the relay server sends to a window that lost ownership of the
 * single executor session to a newer one (`server/collab-server.mjs`,
 * `MCP_RELAY_DISPLACED_CODE`). Application-defined range 4000-4999.
 */
export const MCP_RELAY_DISPLACED_CODE = 4409;

/** Minimal shape of the close event this bridge reads. */
interface RelayCloseEvent {
  code?: number;
  reason?: string;
}

export interface McpBridgeDeps {
  getDoc(): ProjectDocument;
  execute(command: Command): void;
  executeAgentCommand?: NonNullable<McpToolContext["executeAgentCommand"]>;
  beginOwnedUndoFrame?: NonNullable<McpToolContext["beginOwnedUndoFrame"]>;
  endOwnedUndoFrame?: NonNullable<McpToolContext["endOwnedUndoFrame"]>;
  undo(): void;
  redo(): void;
  undoStackLength(): number;
  historyLabels(): string[];
  /** ADR 0065: the current document revision (absent → the permission
   * lattice skips the staleness rule rather than inventing a revision). */
  getRevision?(): number | null;
  isMicRecordingActive(): boolean;
  transport: McpToolContext["transport"];
  /** Another KYX window took the relay: this window is no longer the executor. */
  onDisplaced?: (reason: string) => void;
  export?: (request: McpExportRequest) => Promise<string>;
  exportDocument?: NonNullable<McpToolContext["exportDocument"]>;
  audioPreview?: NonNullable<McpToolContext["audioPreview"]>;
  meters?: () => McpMeterSnapshot | null;
  fxMeters?: () => McpFxMeterSnapshot | null;
  beginUndoFrame?: (label?: string) => void;
  endUndoFrame?: () => void;
  measureLoudness?: NonNullable<McpToolContext["measureLoudness"]>;
  applyLoudness?: NonNullable<McpToolContext["applyLoudness"]>;
  shareToGallery?: NonNullable<McpToolContext["shareToGallery"]>;
  renderSummary?: NonNullable<McpToolContext["renderSummary"]>;
  verifyEdit?: NonNullable<McpToolContext["verifyEdit"]>;
  diagnoseMix?: NonNullable<McpToolContext["diagnoseMix"]>;
  mixPreview?: NonNullable<McpToolContext["mixPreview"]>;
  importSamples?: NonNullable<McpToolContext["importSamples"]>;
  loadSampleMono?: NonNullable<McpToolContext["loadSampleMono"]>;
  separateStems?: NonNullable<McpToolContext["separateStems"]>;
  saveNow?: NonNullable<McpToolContext["saveNow"]>;
  listProjects?: NonNullable<McpToolContext["listProjects"]>;
  saveAsProject?: NonNullable<McpToolContext["saveAsProject"]>;
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
    this.socket.onclose = (event?: RelayCloseEvent) => {
      this.socket = null;
      if (this.stopped) return;
      // Displacement is a DECISION, not a fault. Reconnecting would hand the
      // relay straight back and two live windows would flap ownership (and
      // tool calls would land in whichever document won the last race). Stop
      // here and say so — the user re-enables MCP in the window they mean.
      if (event?.code === MCP_RELAY_DISPLACED_CODE) {
        this.stopped = true;
        this.deps.onDisplaced?.(event.reason || "another KYX window owns the MCP relay");
        return;
      }
      this.scheduleReconnect();
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
        executeAgentCommand: this.deps.executeAgentCommand,
        beginOwnedUndoFrame: this.deps.beginOwnedUndoFrame,
        endOwnedUndoFrame: this.deps.endOwnedUndoFrame,
        undo: () => this.deps.undo(),
        redo: () => this.deps.redo(),
        undoStackLength: () => this.deps.undoStackLength(),
        historyLabels: () => this.deps.historyLabels(),
        getRevision: this.deps.getRevision != null ? () => this.deps.getRevision!() : undefined,
        isMicRecordingActive: () => this.deps.isMicRecordingActive(),
        transport: this.deps.transport,
        export: this.deps.export,
        exportDocument: this.deps.exportDocument,
        audioPreview: this.deps.audioPreview,
        meters: this.deps.meters,
        fxMeters: this.deps.fxMeters,
        beginUndoFrame: this.deps.beginUndoFrame,
        endUndoFrame: this.deps.endUndoFrame,
        measureLoudness: this.deps.measureLoudness,
        applyLoudness: this.deps.applyLoudness,
        shareToGallery: this.deps.shareToGallery,
        renderSummary: this.deps.renderSummary,
        verifyEdit: this.deps.verifyEdit,
        diagnoseMix: this.deps.diagnoseMix,
        mixPreview: this.deps.mixPreview,
        importSamples: this.deps.importSamples,
        loadSampleMono: this.deps.loadSampleMono,
        separateStems: this.deps.separateStems,
        saveNow: this.deps.saveNow,
        listProjects: this.deps.listProjects,
        saveAsProject: this.deps.saveAsProject,
        allowDestructive: mcpAllowDestructive,
        // ADR 0065: the standing consent for an EXTERNAL agent to mutate.
        allowMutations: mcpAllowMutations,
      },
      "web-relay",
    );
    // A throwing tool must still ANSWER — without this catch the relay would
    // never receive an mcp-result and the server-side call would hang until
    // its timeout (15 s for normal calls, extended to 60 s for render and
    // generation tools; desktop applies the same per-tool policy). The async executor
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
