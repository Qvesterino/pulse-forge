import { executeMcpToolAsync, type McpToolContext } from "../mcp/tools";
import { mcpToolContextFromServices } from "../mcp/desktop-host";
import { withAgentAttribution } from "../mcp/attribution";
import type { Services } from "../services";

/**
 * QMR BRIDGE — KYX as a QMR organ (Qvester Studio's ecosystem command
 * layer). KYX is registered in the QMR knowledge graph (appId
 * "pulse_forge", mounted, route); THIS module gives the QMR side something
 * to hold onto:
 *
 *   - the capability MANIFEST (handoffOut PRIMARY = Audio Canvas via the
 *     existing send_beat_to_audio_canvas packet; import/export formats;
 *     customCommands mapped to REAL kyx_* MCP tools),
 *   - a discoverable runtime contract `window.qvesterQmr` with
 *     `executeCommand(type, args)` that routes `kyx.<tool>` commands
 *     through executeMcpToolAsync — the SAME deterministic command layer,
 *     one-undo semantics and verification read-backs the MCP transports
 *     use. The QMR intelligence layer gets the guarantees for free,
 *   - `requestHandoff()` — opens the existing Audio Canvas send flow.
 *
 * Zero Qvester-repo edits: the shell can adopt the manifest (or surface
 * its own chip over the /pulse-forge route) at its own pace; until then
 * the contract is live and testable from the console.
 */

export const QMR_APP_ID = "pulse_forge";
export const QMR_BRIDGE_VERSION = "1.0.0";

/** AppCapabilityManifest-shaped data (mirrors packages/qmr-hud
 * capability-manifest buildManifest output — kept structural so the
 * Qvester side can adopt it verbatim). */
export const QMR_KYX_MANIFEST = {
  appId: QMR_APP_ID,
  appName: "KYX — Pulse Forge",
  appIcon: "PF",
  supports: {
    newProject: true,
    save: true,
    saveAs: true,
    load: true,
    duplicate: false,
    recover: true,
    undo: true,
    redo: true,
    settings: true,
    fullscreen: false,
  },
  importFormats: ["wav", "mp3", "midi", "kyx-share-code"],
  exportFormats: ["wav", "mp3", "stems", "kyx-share-code"],
  // PRIMARY handoff — the packet-verified H53 edge: rendered beat + up to
  // 6 role-bound stems travel via the shared IndexedDB pointer, Audio
  // Canvas runs its own deterministic analysis on OUR audio.
  handoffOut: [
    {
      targetApp: "audio_canvas",
      targetAppName: "Audio Canvas (Atoma Visualizer)",
      intent: "send_beat_to_audio_canvas",
      description:
        "Send the rendered beat (WAV + per-role stems, bpm/key/camelot hints) to Audio Canvas for deterministic analysis and beat-reactive visuals.",
      primary: true,
    },
  ],
  handoffIn: [],
  insights: { performance: false, complexity: false, compatibility: false },
  // Custom commands map 1:1 onto the KYX MCP tool surface — the QMR side
  // sees friendly actions, the execution is the validated command layer.
  customCommands: [
    {
      type: "kyx.state",
      label: "Project state",
      description: "Read the project snapshot (tempo, tracks, patterns, scenes).",
      icon: "📋",
    },
    {
      type: "kyx.song",
      label: "Build a song",
      description: "Generate the genre song form with patterns, arrangement and mix in one gesture.",
      icon: "🎵",
    },
    {
      type: "kyx.mix",
      label: "Apply genre mix",
      description: "Apply the measured genre mix profile (tone/punch/pump) in one undo.",
      icon: "🎚️",
    },
    {
      type: "kyx.arrange",
      label: "Lay out song form",
      description: "Lay out scenes + clips + markers from the genre form.",
      icon: "🧱",
    },
    { type: "kyx.transport", label: "Transport", description: "Play/stop/pause/loop/metronome.", icon: "⏯️" },
    { type: "kyx.undo", label: "Undo", description: "Undo the last document command.", icon: "↩️" },
  ],
  assistantPrompts: [
    "Postav mi techno song a zmixuj ho na -14 LUFS",
    "Build me a 44-bar drill track with a saturated drum bus",
    "What does the current project look like?",
  ],
  appCapabilities: [
    "Browser DAW: composition, mixing, arrangement",
    "26 MCP tools over the deterministic command layer",
    "Genre song forms + measured mix profiles",
    "Beat + stems handoff to Audio Canvas",
  ],
} as const;

/** `kyx.<tool>` type → MCP tool name. Only the MCP surface is reachable —
 * QMR adds a friendly face, never a bypass. */
function qmrTypeToTool(type: string): string | null {
  if (!type.startsWith("kyx.")) return null;
  const tool = `kyx_${type.slice(4)}`;
  return /^kyx_[a-z_]+$/.test(tool) ? tool : null;
}

export interface QmrRuntimeContract {
  appId: string;
  version: string;
  manifest: typeof QMR_KYX_MANIFEST;
  /** Execute a `kyx.<tool>` command through the MCP tool layer. */
  executeCommand(
    type: string,
    args?: Record<string, unknown>,
  ): Promise<{ text: string; mutated: boolean; isError?: boolean }>;
  /** Mounted-ecosystem only: render + persist the Audio Canvas handoff, resolve its URL. */
  requestHandoff(): Promise<{ url: string } | { error: string }>;
  listCommands(): Array<{ type: string; label: string }>;
}

export function startQmrBridge(services: Services): () => void {
  const ctx: McpToolContext = withAgentAttribution(mcpToolContextFromServices(services), "qmr");
  const runtime: QmrRuntimeContract = {
    appId: QMR_APP_ID,
    version: QMR_BRIDGE_VERSION,
    manifest: QMR_KYX_MANIFEST,
    async executeCommand(type, args = {}) {
      const tool = qmrTypeToTool(type);
      if (tool == null) {
        return {
          text: `unknown QMR command "${type}" — kyx.<tool> expected (see listCommands)`,
          mutated: false,
          isError: true,
        };
      }
      return executeMcpToolAsync(ctx, tool, args);
    },
    async requestHandoff() {
      // The handoff sender drags the render/stems/wav cluster — load it
      // only when a handoff is actually requested. isMountedInEcosystem
      // rides the same dynamic import: a static line here once pulled the
      // whole sender cluster back into the eager boot graph (boot-graph
      // gate catches exactly that).
      const { buildAudioCanvasHandoffUrl, isMountedInEcosystem, prepareBeatHandoff } = await import("./qvesterHandoff");
      if (!isMountedInEcosystem()) {
        return {
          error:
            "KYX is not mounted in the Qvester shell (standalone deployment) — the handoff medium is same-origin only",
        };
      }
      const result = await prepareBeatHandoff(ctx.getDoc(), services.bank, {
        mode: "song",
        sampleRate: 44100,
      });
      return { url: buildAudioCanvasHandoffUrl(result.packet) };
    },
    listCommands() {
      return QMR_KYX_MANIFEST.customCommands.map((command) => ({ type: command.type, label: command.label }));
    },
  };
  (window as unknown as { qvesterQmr?: QmrRuntimeContract }).qvesterQmr = runtime;
  return () => {
    const current = (window as unknown as { qvesterQmr?: QmrRuntimeContract }).qvesterQmr;
    if (current === runtime) delete (window as unknown as { qvesterQmr?: QmrRuntimeContract }).qvesterQmr;
  };
}
