import { ProjectStore } from "../store/ProjectStore";
import { withAgentAttribution, type McpAgentId } from "./attribution";
import { executeMcpTool, type McpToolContext, type McpToolResult } from "./tools";
import type { ProjectDocument } from "../project-model/types";

/**
 * HEADLESS MCP HOST — ADR 0046, option B (test-only implementation).
 *
 * A `McpToolContext` bound to an in-memory `ProjectStore` over a fixture
 * document, so agent evaluation runs in CI at milliseconds per call. The
 * tools keep their REAL logic: the same dispatcher, validation, capability
 * refusals, error codes, idempotency, dry-run and attribution as the bound
 * surfaces. NO product surface imports this module — it exists for tests
 * and future evaluation harnesses; the shipping app is untouched.
 *
 * Capability hooks (meters/export/audioPreview/importSamples) are
 * deliberately NOT provided: those tools refuse with
 * UNAVAILABLE_ON_TRANSPORT exactly as they do for a suspended browser —
 * and the acceptance suite pins those refusals too, so nobody "fixes"
 * them here instead of honoring the contract.
 *
 * Transport is a RECORDING stub: actions are logged, never played. There
 * is no clock and no audio in headless — the log exists so an evaluation
 * can assert "the agent asked to play", which is a different, honest
 * statement than pretending sound happened.
 */

export interface HeadlessHostOptions {
  /** The fixture document the store boots with (required — no hidden defaults). */
  document: ProjectDocument;
  /** Attribution surface label; defaults to "headless" (history prefixes + result lines). */
  agentId?: McpAgentId;
  /** D4 destructive gate (default off — the live contract). */
  allowDestructive?: boolean;
  /**
   * ADR 0065: standing consent for an external agent to apply mutating calls.
   *
   * DEFAULT **ON** — and that is deliberate. The headless host is an
   * IN-PROCESS HARNESS (`docs/AGENT-KIT.md` lists it under "tests, tooling";
   * ADR 0046 made it the evaluation workhorse), not a network surface: nothing
   * reaches it from outside the process. The two SHIPPED external transports —
   * the web relay and the desktop stdio server — gate by default, and that is
   * where the consent matters.
   *
   * The `agentId` here stays "headless" for ATTRIBUTION (the audit prefix),
   * which is a different concern from trust: this harness is where the trust
   * gate is exercised, not where it is spent.
   */
  allowMutations?: boolean;
}

export interface HeadlessTransportEvent {
  action: "play" | "stop" | "pause" | "setLoop" | "setMetronome";
  args: Array<number | boolean>;
}

export interface HeadlessHost {
  /** The bound tool context — pass to executeMcpTool or use {@link HeadlessHost.call}. */
  ctx: McpToolContext;
  /** The real store: doc inspection, undo/redo, onDocChanged wiring for persistence tests. */
  store: ProjectStore;
  /** Recorded transport actions (headless has no clock — actions, not sound). */
  transportLog: HeadlessTransportEvent[];
  /** Convenience: executeMcpTool through the bound context. */
  call(name: string, args?: unknown): Promise<McpToolResult>;
}

export function createHeadlessMcpHost(options: HeadlessHostOptions): HeadlessHost {
  const store = new ProjectStore(options.document);
  const transportLog: HeadlessTransportEvent[] = [];

  const transport: McpToolContext["transport"] = {
    play: () => {
      transportLog.push({ action: "play", args: [] });
    },
    stop: () => {
      transportLog.push({ action: "stop", args: [] });
    },
    pause: () => {
      transportLog.push({ action: "pause", args: [] });
    },
    setLoop: (enabled, start, end) => {
      transportLog.push({ action: "setLoop", args: [enabled, start, end] });
    },
    setMetronome: (enabled) => {
      transportLog.push({ action: "setMetronome", args: [enabled] });
    },
  };

  const base: McpToolContext = {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    executeAgentCommand: (command, frameToken) => store.executeAgentCommand(command, frameToken),
    beginOwnedUndoFrame: (label) => store.beginOwnedUndoFrame(label),
    endOwnedUndoFrame: (token) => store.endOwnedUndoFrame(token),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    // ADR 0065: the document revision (the headless store is a real store).
    getRevision: () => store.getRevision(),
    isMicRecordingActive: () => false,
    transport,
    // Preserve legacy human-frame hooks for callers that exercise them; MCP
    // batches use the owned token hooks above.
    beginUndoFrame: (label) => {
      store.beginUndoFrame(label);
    },
    endUndoFrame: () => {
      store.endUndoFrame();
    },
    ...(options.allowDestructive ? { allowDestructive: () => options.allowDestructive === true } : {}),
    // ADR 0065: the standing consent for an external agent to mutate. This
    // harness defaults to ON (see the option's doc comment); pass
    // `allowMutations: false` to exercise the refusal path.
    allowMutations: () => options.allowMutations !== false,
  };

  const agentId: McpAgentId = options.agentId ?? "headless";
  const ctx: McpToolContext = agentId === "local" ? base : withAgentAttribution(base, agentId);

  return {
    ctx,
    store,
    transportLog,
    call: (name, args) => executeMcpTool(ctx, name, args),
  };
}
