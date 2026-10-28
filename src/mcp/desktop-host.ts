import { executeMcpToolAsync, type McpToolContext, type McpToolResult } from "./tools";
import { withAgentAttribution } from "./attribution";
import { mcpAllowDestructive, mcpAllowMutations } from "./flags";
import { storeRevision } from "./revision";
import { isMicRecordingActive } from "../audio-engine/PcmMicRecorder";
import { quickBounceDownload } from "../export/quick-bounce";
import { decodeAudioData } from "../services/audio-decode";
import { mcpFxMetersFromServices, mcpMeterSnapshotFromServices } from "./meters";
import { mcpApplyLoudness, mcpMeasureLoudness } from "./loudness";
import { mcpRenderSummary } from "./render-summary";
import { mcpRenderAudioPreview } from "./audio-preview";
import { loadUserSampleMono } from "./sample-mono";
import { separateStemsForAgent } from "./stem-separate";
import { flushServicesSave, listSavedProjects, saveProjectAsCopy } from "./save-now";
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
  /** Resolve a forwarded call with the full machine-readable tool result. */
  answer: (payload: { id: string; result: McpToolResult }) => Promise<void>;
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
    executeAgentCommand: (command, frameToken) => services.store.executeAgentCommand(command, frameToken),
    beginOwnedUndoFrame: (label) => services.store.beginOwnedUndoFrame(label),
    endOwnedUndoFrame: (token) => services.store.endOwnedUndoFrame(token),
    undo: () => services.store.undo(),
    redo: () => services.store.redo(),
    undoStackLength: () => services.store.undoStackLength,
    historyLabels: () => services.store.history.map((entry) => entry.label),
    // ADR 0065: the document revision, so an agent's declared plan revision
    // can be checked against the live document.
    getRevision: () => storeRevision(services.store),
    isMicRecordingActive,
    transport: services.transport,
    // kyx_meter reads the LIVE engine (null when no audio context is up).
    meters: () => mcpMeterSnapshotFromServices(services),
    fxMeters: () => mcpFxMetersFromServices(services),
    // THE AI's EARS (closed-loop iterate): renders the current doc → stereo
    // PCM for the measurement pipeline. Same render path as mcpRenderSummary.
    renderMix: async (signal) => {
      const d = services.store.getDoc();
      const { renderProject } = await import("../rendering/renderer");
      const mode = d.arrangement.clips.length > 0 ? "song" : "pattern";
      const buffer = await renderProject(d, services.bank, {
        mode,
        sampleRate: 44100,
        tailSeconds: 0.6,
        signal,
      });
      const channels: Float32Array[] = [];
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        channels.push(new Float32Array(buffer.getChannelData(ch)));
      }
      return { channels, sampleRate: buffer.sampleRate };
    },
    beginUndoFrame: (label) => services.store.beginUndoFrame(label),
    endUndoFrame: () => services.store.endUndoFrame(),
    measureLoudness: (signal) => mcpMeasureLoudness(services, signal),
    applyLoudness: (input, signal) => mcpApplyLoudness(services, input, signal),
    // kyx_export rides the same render + encode + download pipeline as the
    // in-app export intent (download lands in the focused KYX window).
    export: (request) => quickBounceDownload(services.store.getDoc(), services.bank, request),
    // AS-013: the pure-document formats serialize and download directly —
    // same paths the ExportPanel MIDI/JSON buttons ride, lazy-imported so
    // the boot path never pays for the MIDI writer.
    exportDocument: async (kind) => {
      const doc = services.store.getDoc();
      if (kind === "json") {
        const { exportProject } = await import("../export/project-io");
        const sizeBytes = JSON.stringify(doc).length;
        exportProject(doc);
        return { report: `JSON project export started (${doc.name}.kyx)`, sizeBytes };
      }
      const { arrangementToMidi, patternToMidi, downloadMidi } = await import("../midi/midiProject");
      const hasSongArrangement = doc.arrangement.clips.length > 0 || (doc.arrangement.midiClips?.length ?? 0) > 0;
      const bytes = hasSongArrangement ? arrangementToMidi(doc) : patternToMidi(doc, doc.activePatternId);
      downloadMidi(bytes, `${doc.name}-${hasSongArrangement ? "song" : "pattern"}`);
      return {
        report: hasSongArrangement
          ? "Song arrangement MIDI export started"
          : `Pattern MIDI export started (${doc.name})`,
        sizeBytes: bytes.byteLength,
      };
    },
    audioPreview: (request, signal) => mcpRenderAudioPreview(services, request, signal),
    // kyx_import_sfz: base64 SFZ + WAVs → user library + sampler mapping
    // (the same importSfzLibrary core the web relay uses).
    importSamples: async (input) => {
      const { importSfzLibrary } = await import("../sample-library/sfz-import");
      try {
        const result = await importSfzLibrary(input, {
          bank: services.bank,
          userSamples: services.userSamples,
          decode: (bytes) => decodeAudioData(bytes),
          getDoc: () => services.store.getDoc(),
          execute: (command) => services.store.execute(command),
        });
        return {
          ok: true as const,
          report: {
            trackId: result.trackId,
            fallbackSampleId: result.fallbackSampleId,
            layers: result.layers.length,
            imported: result.imported,
            missing: result.missing,
            skipped: result.skipped,
          },
        };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    },
    // kyx_unsuno transcribe: the live user-sample bank (decoded) or the
    // repository fallback, mixed to mono for the transcription lanes.
    loadSampleMono: (sampleId) => loadUserSampleMono(services, sampleId),
    separateStems: (input) => separateStemsForAgent(services, input.sourceId, input),
    // kyx_save: force the autosave pipeline and report the durable result.
    saveNow: () => flushServicesSave(services),
    listProjects: () => listSavedProjects(services),
    saveAsProject: (name) => saveProjectAsCopy(services, name),
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
    renderSummary: (request, signal) => mcpRenderSummary(services, request, signal),
    // kyx_diagnose_mix: the interpretation layer — attributed findings + fixes.
    // Lazy: loads with the first diagnose call, not on boot (bundle budget).
    diagnoseMix: (request, signal) =>
      import("./mix-diagnosis").then((m) => m.mcpDiagnoseMix(services, request, signal)),
    mixPreview: (request, signal) => import("./mix-preview").then((m) => m.previewMixIdea(services, request, signal)),
    allowDestructive: mcpAllowDestructive,
    // ADR 0065: the standing consent for an EXTERNAL agent to mutate.
    allowMutations: mcpAllowMutations,
  };
}

/**
 * Bind the window to main's MCP relay. No-op (returns a noop unbind) in the
 * browser — the web transport uses the /mcp-relay WebSocket instead.
 */
export function startMcpDesktopHost(services: Services): () => void {
  const api = getDesktopMcpApi();
  if (!api) return () => {};
  // The preset bank rides the same lazy discipline — warm it so the intent
  // route's sync preset parsers read a present bank when agents ask.
  void import("../presets/factory-loader").then((m) => m.warmFactoryPresets());
  // every mutation executed for external stdio clients is attributed
  const ctx = withAgentAttribution(mcpToolContextFromServices(services), "desktop-stdio");
  return api.onCall((call) => {
    void (async () => {
      try {
        const result = await executeMcpToolAsync(ctx, String(call?.name ?? ""), call?.args ?? {});
        await api.answer({
          id: String(call?.id ?? ""),
          result,
        });
      } catch (error) {
        await api.answer({
          id: String(call?.id ?? ""),
          result: {
            text: error instanceof Error ? error.message : String(error),
            mutated: false,
            isError: true,
          },
        });
      }
    })();
  });
}
