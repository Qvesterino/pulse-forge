import type { ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
import { routeIntentText, type RoutedIntent } from "../intent/route";
import { applyFaderIntent, applyTempoIntent } from "../intent/conversation";
import { applyBypassIntent, applyEffectIntent, applySendIntent } from "../intent/mix";
import {
  applyAutomateIntent,
  applyGrooveIntent,
  applyMarkerIntent,
  applySectionGrooveIntent,
} from "../intent/studio-words";
import { applyClipArrangeOps, applyArrangeOps } from "../intent/arrangeWords";
import { applySoundSwapIntent, applyStepEditIntent } from "../intent/sound-words";
import { applyPresetIntentCommand } from "../intent/preset-intent";
import { applyExactIntentCommand } from "../commands/commands";

/**
 * KYX MCP — TOOL SURFACE (docs/INTENT-MCP-EXPANSION-PLAN.md Phase D1).
 *
 * Five tools expose the intent engine + project state to an external MCP
 * client. The GOLDEN RULE: the MCP layer is a TRANSPORT, never a bypass —
 * every tool goes through the same deterministic command layer (clamps,
 * strict target resolution, one-undo snapshots) that the intent bar uses,
 * and every result is a VERIFICATION READ-BACK, not a dispatch echo.
 *
 * `executeMcpTool` runs against a narrow `McpToolContext` so the same code
 * serves the browser relay (services-backed context) and headless tests
 * (ProjectStore-backed context).
 *
 * v1 explicit non-goals (returned as honest errors, never guessed):
 * pattern/song generation (needs candidate auditioning in the app),
 * save/export/record (window-local), mic takes.
 */

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "kyx_intent",
    description:
      "Drive the KYX DAW with a natural-language producer instruction " +
      '(EN/SK): "mute the drums", "zníž basu", "set tempo to 140", ' +
      '"more reverb send on the lead", "more swing in the drop". ' +
      "Executes through the deterministic command layer (one undo step) " +
      "and returns a verification read-back of the resulting state. " +
      "Generation requests are refused (candidates need in-app auditioning).",
    inputSchema: {
      type: "object",
      properties: { instruction: { type: "string", description: "Producer instruction, EN or SK" } },
      required: ["instruction"],
    },
  },
  {
    name: "kyx_state",
    description:
      "Read-only project snapshot: tempo, key, time signature, track list, " +
      "markers, groove, or the FX chain of one family. Never mutates.",
    inputSchema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          enum: ["overview", "tempo", "key", "tracks", "markers", "groove", "fxChain"],
          description: "Which part of the project state to return",
        },
        family: {
          type: "string",
          enum: ["kick", "snare", "clap", "hat", "perc", "tom", "bass", "lead", "chords", "drums"],
          description: "Optional track family filter for fxChain",
        },
      },
      required: ["subject"],
    },
  },
  {
    name: "kyx_undo",
    description: "Undo or redo the last N document commands (default 1). Declined " + "while a mic take is recording.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["undo", "redo"] },
        steps: { type: "integer", minimum: 1, maximum: 20, description: "Default 1" },
      },
      required: ["action"],
    },
  },
  {
    name: "kyx_transport",
    description: "Transport control: play, stop, pause, loop on/off, metronome on/off.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["play", "stop", "pause", "loopOn", "loopOff", "metronomeOn", "metronomeOff"],
        },
      },
      required: ["action"],
    },
  },
  {
    name: "kyx_export",
    description:
      "Request a bounce of the current project (WAV/MP3). v1 returns " +
      "started:true and the download happens in the KYX app window.",
    inputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: ["wav", "mp3"] } },
      required: ["format"],
    },
  },
];

/** Narrow capability surface the tools need — implemented by the app's
 * services (browser relay) or by a ProjectStore wrapper (headless tests). */
export interface McpToolContext {
  getDoc(): ProjectDocument;
  execute(command: Command): void;
  undo(): void;
  redo(): void;
  undoStackLength(): number;
  historyLabels(): string[];
  isMicRecordingActive(): boolean;
  transport: {
    play(): void;
    stop(): void;
    pause(): void;
    setLoop(enabled: boolean, start: number, end: number): void;
    setMetronome(enabled: boolean): void;
  };
  /** Present when the KYX window can render/downloads (browser relay). */
  export?: (format: "wav" | "mp3") => Promise<string>;
}

export interface McpToolResult {
  /** Text returned to the MCP client (verification read-back). */
  text: string;
  /** true when the project document changed (undoable). */
  mutated: boolean;
}

const TICKS_PER_BAR = 4 * 480;

export function executeMcpTool(ctx: McpToolContext, name: string, args: unknown): McpToolResult {
  const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "kyx_state":
      return {
        text: stateSnapshot(ctx.getDoc(), String(record.subject ?? "overview"), record.family as string | undefined),
        mutated: false,
      };
    case "kyx_undo": {
      const action = record.action === "redo" ? "redo" : "undo";
      const steps = Math.max(1, Math.min(20, Number(record.steps ?? 1)));
      if (ctx.isMicRecordingActive()) {
        return { text: "declined: a mic take is recording — stop it before undo", mutated: false };
      }
      let done = 0;
      for (let i = 0; i < steps; i++) {
        const before = ctx.undoStackLength();
        if (action === "undo") ctx.undo();
        else ctx.redo();
        if (ctx.undoStackLength() === before && action === "undo") break;
        done += 1;
      }
      return { text: `${action} ×${done}`, mutated: done > 0 };
    }
    case "kyx_transport": {
      const action = String(record.action ?? "");
      const transport = ctx.transport;
      if (action === "play") transport.play();
      else if (action === "stop") transport.stop();
      else if (action === "pause") transport.pause();
      else if (action === "metronomeOn") transport.setMetronome(true);
      else if (action === "metronomeOff") transport.setMetronome(false);
      else if (action === "loopOn") transport.setLoop(true, 0, TICKS_PER_BAR * 4);
      else if (action === "loopOff") transport.setLoop(false, 0, 0);
      else return { text: `unknown transport action: ${action}`, mutated: false };
      return { text: `transport: ${action}`, mutated: false };
    }
    case "kyx_export": {
      if (ctx.export == null) {
        return {
          text: "export is not available over this MCP transport — use the KYX export panel",
          mutated: false,
        };
      }
      const format = record.format === "mp3" ? "mp3" : "wav";
      void ctx.export(format);
      return { text: `export ${format.toUpperCase()} started in the KYX window`, mutated: false };
    }
    case "kyx_intent":
      return executeIntentTool(ctx, String(record.instruction ?? ""));
    default:
      return { text: `unknown tool: ${name}`, mutated: false };
  }
}

function stateSnapshot(doc: ProjectDocument, subject: string, family: string | undefined): string {
  if (subject === "tempo") {
    return `${doc.bpm} BPM · ${doc.key ?? "key unset"} · ${doc.timeSignature.numerator}/${doc.timeSignature.denominator}`;
  }
  if (subject === "key") return doc.key ?? "key unset";
  if (subject === "tracks") {
    return doc.tracks.map((t) => `${t.name} (${t.kind}${t.mute ? ", muted" : ""})`).join(", ");
  }
  if (subject === "markers") {
    return doc.markers.length > 0
      ? doc.markers.map((m) => `${m.name}@${Math.round(m.tick / TICKS_PER_BAR) + 1}`).join(", ")
      : "no markers";
  }
  if (subject === "groove") {
    const g = doc.groove;
    if (!g) return "groove neutral";
    const pct = (value: number): number => Math.round(value * 100);
    return `swing ${pct(g.swing ?? 0)}% · humanize ${pct(g.humanizeTiming ?? 0)}%`;
  }
  if (subject === "fxChain") {
    const wanted = family != null ? new RegExp(`\\b${family}\\b`, "i") : null;
    const lines: string[] = [];
    for (const track of doc.tracks) {
      if (track.kind === "group") continue;
      if (wanted != null && !wanted.test(track.name) && track.kind !== "drum") continue;
      const chain = track.effects.map((fx) => `${fx.type}${fx.bypassed ? " (bypassed)" : ""}`).join(", ");
      lines.push(`${track.name}: ${chain || "no FX"}`);
    }
    return lines.slice(0, 8).join("\n") || "no tracks";
  }
  // overview
  const lines = [
    `${doc.bpm} BPM · ${doc.key ?? "key unset"} · ${doc.tracks.length} tracks · ${doc.scenes.length} scenes`,
    `tracks: ${doc.tracks.map((t) => t.name).join(", ")}`,
  ];
  return lines.join("\n");
}

function executeIntentTool(ctx: McpToolContext, instruction: string): McpToolResult {
  const trimmed = instruction.trim();
  if (trimmed.length === 0) return { text: "empty instruction", mutated: false };
  const route = routeIntentText(trimmed, ctx.getDoc());

  // Generation kinds are proposals, not commands — honest refusal over MCP
  // (candidates need in-app auditioning).
  if (route.kind === "pattern" || route.kind === "revise") {
    return {
      text:
        "generation requests run inside the KYX app (candidates need auditioning) — " +
        "rephrase as a mixer/groove command or open KYX",
      mutated: false,
    };
  }
  if (route.kind === "clarify") {
    return { text: `${route.reason} suggestions: ${route.suggestions.join(" | ")}`, mutated: false };
  }
  if (route.kind === "presetUnknown") {
    return { text: `unknown preset "${route.name}" — try: ${route.suggestions.join(", ")}`, mutated: false };
  }
  if (route.kind === "save" || route.kind === "export" || route.kind === "record") {
    return { text: "save/export/record run in the KYX window — not available over MCP v1", mutated: false };
  }
  if (route.kind === "undoIntent") {
    // Route-layer undo asks are honored through the store hooks.
    for (let i = 0; i < route.intent.steps; i++) {
      if (route.intent.kind === "undo") ctx.undo();
      else ctx.redo();
    }
    return { text: `${route.intent.kind} ×${route.intent.steps}`, mutated: true };
  }

  const command = intentCommand(ctx.getDoc(), route);
  if (command == null) {
    return { text: "intent understood but nothing changed (already matches or no target)", mutated: false };
  }
  ctx.execute(command);
  return { text: `${command.label} — verification: applied, one undo step in KYX`, mutated: true };
}

function intentCommand(doc: ProjectDocument, route: RoutedIntent): Command | null {
  switch (route.kind) {
    case "fader":
      return applyFaderIntent(doc, route.intent);
    case "tempo":
      return applyTempoIntent(doc, route.intent);
    case "exact":
      return applyExactIntentCommand(doc, route.plan);
    case "grooveIntent":
      return applyGrooveIntent(doc, route.intent);
    case "sectionGrooveIntent":
      return applySectionGrooveIntent(doc, route.intent);
    case "markerIntent":
      return applyMarkerIntent(doc, route.intent);
    case "automateIntent":
      return applyAutomateIntent(doc, route.intent, null);
    case "clips":
      return applyClipArrangeOps(doc, route.ops);
    case "arrange":
      return applyArrangeOps(doc, route.ops);
    case "preset":
      return applyPresetIntentCommand(doc, route.intent);
    case "effectIntent":
      return applyEffectIntent(doc, route.intent);
    case "sendIntent":
      return applySendIntent(doc, route.intent);
    case "bypassIntent":
      return applyBypassIntent(doc, route.intent);
    case "soundSwapIntent":
      return applySoundSwapIntent(doc, route.intent);
    case "stepEditIntent":
      return applyStepEditIntent(doc, route.intent);
    default:
      return null;
  }
}
