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
import { generateLocalResult } from "../intent/pipeline";
import { normalizeIntent } from "../intent/normalize";
import { resolveSceneTarget } from "../intent/arrangeWords";
import { inferPadRole } from "../ai/pad-roles";
import type { DrumTrack, InstrumentKind } from "../project-model/types";
import { applyPresetIntentCommand } from "../intent/preset-intent";
import {
  addMarker,
  applyExactIntentCommand,
  applyGenerationResultCommand,
  createDrumTrack,
  createInstrumentTrack,
  deleteTrack,
  removeMarker,
  setActivePattern,
  setStepMeta,
  setStepVelocityCommand,
  setTrackParams,
  snapshot,
} from "../commands/commands";

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
      "markers, groove, the ACTIVE pattern's step grid, the arrangement " +
      "scenes, the undo history, or the FX chain of one family. Never mutates.",
    inputSchema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          enum: ["overview", "tempo", "key", "tracks", "markers", "groove", "fxChain", "pattern", "scenes", "history"],
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
  {
    name: "kyx_generate",
    description:
      "Generate a new pattern from an intent spec (deterministic engine, " +
      "one undo step). Returns the pattern name and resolved BPM.",
    inputSchema: {
      type: "object",
      properties: {
        genre: {
          type: "string",
          enum: [
            "house",
            "techno",
            "trap",
            "ambient",
            "drill",
            "phonk",
            "jersey",
            "dnb",
            "ukg",
            "amapiano",
            "postrock",
            "drone",
            "chiptune",
            "eurodance",
            "latin",
          ],
        },
        seed: { type: "string", description: "Deterministic seed (same seed = same pattern)" },
        energy: { type: "number", minimum: 0, maximum: 1 },
        density: { type: "number", minimum: 0, maximum: 1 },
        bpm: { type: "integer", minimum: 40, maximum: 220 },
        bars: {
          type: "integer",
          minimum: 1,
          maximum: 16,
          description: "Pattern length in bars (16 steps per bar; default engine choice)",
        },
        replaceMode: {
          type: "string",
          enum: ["new", "replace"],
          description: "replace = overwrite the active pattern in place (default: add a new pattern)",
        },
        roles: {
          type: "array",
          items: { type: "string", enum: ["drums", "bass", "chords", "lead"] },
          description: "Which roles the pattern plays (default all)",
        },
      },
      required: ["genre"],
    },
  },
  {
    name: "kyx_groove",
    description:
      "Groove/swing control. Global (no section) adjusts project swing; " +
      "section-scoped bakes microtiming into that section's pattern.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["more", "less", "tighter", "set"] },
        section: {
          type: "string",
          enum: ["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro", "fill"],
          description: "Omit = global groove",
        },
        percent: { type: "integer", minimum: 0, maximum: 100, description: "Only for direction 'set'" },
      },
      required: ["direction"],
    },
  },
  {
    name: "kyx_fx",
    description:
      "Structured effect operation on a track family: more/less turn the " +
      "primary knob, remove deletes instances, bypass/enable flags them.",
    inputSchema: {
      type: "object",
      properties: {
        effect: {
          type: "string",
          enum: [
            "reverb",
            "delay",
            "saturation",
            "distortion",
            "chorus",
            "flanger",
            "phaser",
            "tremolo",
            "bitcrusher",
            "compressor",
            "pump",
            "eq",
          ],
        },
        family: { type: "string", enum: ["drums", "bass", "chords", "lead", "vocal"] },
        action: { type: "string", enum: ["more", "less", "remove", "bypass", "enable"] },
      },
      required: ["effect", "family", "action"],
    },
  },
  {
    name: "kyx_sections",
    description:
      "Arrangement operations: add/remove/duplicate/reorder/resize named " +
      "sections (intro/build/chorus/verse/bridge/drop/break/outro/fill).",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "remove", "duplicate", "reorder", "resize"] },
        role: {
          type: "string",
          enum: ["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro", "fill"],
        },
        bars: { type: "integer", minimum: 1, maximum: 64, description: "For resize" },
      },
      required: ["op", "role"],
    },
  },
  {
    name: "kyx_markers",
    description: "Add a cue marker at a bar, or remove the marker nearest a bar.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "remove"] },
        bar: { type: "integer", minimum: 1, description: "1-based bar" },
        name: { type: "string", description: "Optional marker name" },
      },
      required: ["op", "bar"],
    },
  },
  {
    name: "kyx_tracks",
    description:
      "Track CRUD: add a drum or instrument track, remove/rename an " +
      "existing one by family. Removing the last track is declined.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["addDrum", "addInstrument", "remove", "rename"] },
        family: {
          type: "string",
          enum: ["drums", "bass", "lead", "chords", "kick", "snare", "clap", "hat", "perc", "tom"],
          description: "For remove/rename: which family to touch",
        },
        instrument: {
          type: "string",
          enum: ["analog", "bass", "808", "keys", "pluck", "acid", "reese", "brass", "flute", "sampler"],
          description: "For addInstrument",
        },
        name: { type: "string", description: "New name for rename" },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_pattern",
    description:
      "List the project's patterns or switch the ACTIVE pattern (step edits " +
      "and generation act on the active one). Select by 1-based index or name.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "select"] },
        pattern: {
          type: "string",
          description: "1-based index or pattern name (for select)",
        },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_steps",
    description:
      "Structured step-grid edit on the ACTIVE pattern's drum pads (16 steps " +
      "per bar, 1-based indexes across the whole pattern). add sets velocity, " +
      "remove clears, toggle flips, ghost places a soft probabilistic hit, " +
      "clearPad empties the whole family. Returns a verification read-back " +
      "with the family's before → after step counts.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "remove", "toggle", "ghost", "clearPad"] },
        family: { type: "string", enum: ["kick", "snare", "clap", "hat", "perc", "tom"] },
        steps: {
          type: "array",
          items: { type: "integer", minimum: 1, maximum: 256 },
          description: "1-based 16th-step indexes within the pattern (16 per bar). Not used by clearPad.",
        },
        velocity: { type: "number", minimum: 0.05, maximum: 1, description: "For add (default 0.8)" },
      },
      required: ["op", "family"],
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
  /**
   * D4 escalation: destructive MCP ops (removing tracks/sections/FX) run
   * ONLY while the user's allow flag is on. Absent/false → honest refusal.
   */
  allowDestructive?: () => boolean;
}

export interface McpToolResult {
  /** Text returned to the MCP client (verification read-back). */
  text: string;
  /** true when the project document changed (undoable). */
  mutated: boolean;
}

const TICKS_PER_BAR = 4 * 480;

/** D4 escalation gate — every destructive op routes through this refusal. */
function destructiveRefusal(): McpToolResult {
  return {
    text:
      "declined: destructive MCP ops are locked — the user must allow them " +
      "in the KYX MCP chip (undoable edits still work)",
    mutated: false,
  };
}

export function executeMcpTool(ctx: McpToolContext, name: string, args: unknown): McpToolResult {
  const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "kyx_state":
      return {
        text: stateSnapshot(
          ctx.getDoc(),
          String(record.subject ?? "overview"),
          record.family as string | undefined,
          () => ctx.historyLabels(),
        ),
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
    case "kyx_generate": {
      const bars = typeof record.bars === "number" ? Math.max(1, Math.min(16, Math.round(record.bars))) : undefined;
      const spec = normalizeIntent({
        genre: typeof record.genre === "string" ? record.genre : undefined,
        seed: typeof record.seed === "string" ? record.seed : undefined,
        energy: typeof record.energy === "number" ? record.energy : undefined,
        density: typeof record.density === "number" ? record.density : undefined,
        bpmRange: typeof record.bpm === "number" ? [Number(record.bpm), Number(record.bpm)] : undefined,
        ...(bars != null ? { length: bars * 16 } : {}),
        ...(record.replaceMode === "replace" ? { replaceMode: "replace" as const } : {}),
        roles: Array.isArray(record.roles) ? record.roles : undefined,
      });
      const result = generateLocalResult(ctx.getDoc(), spec, "apply");
      if (!result.proposal) {
        return {
          text: `generation rejected: ${result.diagnostics.errors[0] ?? "unknown"}`,
          mutated: false,
        };
      }
      ctx.execute(applyGenerationResultCommand(ctx.getDoc(), result));
      const pattern = result.proposal.pattern;
      const stepBars = Math.max(1, Math.round(pattern.stepCount / 16));
      return {
        text: `generated "${pattern.name}" — ${pattern.stepCount} steps (~${stepBars} bar) · project ${ctx.getDoc().bpm} BPM (one undo step in KYX)`,
        mutated: true,
      };
    }
    case "kyx_groove": {
      const direction = String(record.direction ?? "");
      const section = typeof record.section === "string" ? record.section : undefined;
      const percent = typeof record.percent === "number" ? record.percent : undefined;
      if (section == null) {
        const command = applyGrooveIntent(
          ctx.getDoc(),
          direction === "set"
            ? { direction: "set", percent: percent ?? 50 }
            : direction === "tighter"
              ? { direction: "tighter" }
              : { direction: direction === "less" ? "swingDown" : "swingUp" },
        );
        if (!command) return { text: "groove already neutral", mutated: false };
        ctx.execute(command);
        return { text: command.label, mutated: true };
      }
      const scoped = applySectionGrooveIntent(ctx.getDoc(), sectionGrooveFrom(direction, percent, section));
      if (!scoped) return { text: `no pattern for the "${section}" section`, mutated: false };
      ctx.execute(scoped);
      return { text: scoped.label, mutated: true };
    }
    case "kyx_fx": {
      const command = applyEffectIntent(ctx.getDoc(), {
        effectType: record.effect,
        targets: [record.family],
        direction:
          record.action === "remove" || record.action === "bypass"
            ? "remove"
            : record.action === "enable"
              ? "more"
              : record.action,
        ...(typeof record.percent === "number" ? { percent: record.percent } : {}),
        detected: ["MCP"],
      } as unknown as Parameters<typeof applyEffectIntent>[1]);
      ctx.execute(command);
      return { text: command.label, mutated: true };
    }
    case "kyx_sections": {
      if (String(record.op ?? "") === "remove" && ctx.allowDestructive?.() !== true) return destructiveRefusal();
      const command = sectionCommand(record, ctx.getDoc());
      if (!command) return { text: "section op not resolvable — check the role exists", mutated: false };
      ctx.execute(command);
      return { text: command.label, mutated: true };
    }
    case "kyx_markers": {
      const op = String(record.op ?? "add");
      const bar = Math.max(1, Number(record.bar ?? 1));
      const tick = (bar - 1) * TICKS_PER_BAR;
      if (op === "add") {
        const name = typeof record.name === "string" && record.name.trim() !== "" ? record.name.trim() : undefined;
        const command = addMarker(ctx.getDoc(), { tick, name });
        ctx.execute(command);
        return { text: `marker at bar ${bar}`, mutated: true };
      }
      const nearest = ctx.getDoc().markers.find((marker) => Math.abs(marker.tick - tick) < TICKS_PER_BAR);
      if (nearest == null) return { text: `no marker near bar ${bar}`, mutated: false };
      ctx.execute(removeMarker(ctx.getDoc(), nearest.id));
      return { text: `marker "${nearest.name}" removed`, mutated: true };
    }
    case "kyx_tracks": {
      const op = String(record.op ?? "");
      if (op === "addDrum") {
        const command = createDrumTrack(ctx.getDoc());
        ctx.execute(command);
        return { text: command.label, mutated: true };
      }
      if (op === "addInstrument") {
        const kind = (typeof record.instrument === "string" ? record.instrument : "analog") as InstrumentKind;
        const command = createInstrumentTrack(ctx.getDoc(), kind);
        ctx.execute(command);
        return { text: command.label, mutated: true };
      }
      if (op === "rename") {
        const name = typeof record.name === "string" ? record.name.trim().slice(0, 40) : "";
        const family = String(record.family ?? "");
        const ids = tracksInFamily(ctx.getDoc(), family);
        if (ids.length === 0) return { text: `no track matches family "${family}"`, mutated: false };
        ctx.execute(setTrackParams(ctx.getDoc(), ids[0], { name }));
        return { text: `renamed to "${name}"`, mutated: true };
      }
      if (op === "remove") {
        if (ctx.allowDestructive?.() !== true) return destructiveRefusal();
        const family = String(record.family ?? "");
        const ids = tracksInFamily(ctx.getDoc(), family);
        if (ids.length === 0) return { text: `no track matches family "${family}"`, mutated: false };
        if (ctx.getDoc().tracks.length - ids.length < 1) {
          return { text: "declined: cannot remove the last track", mutated: false };
        }
        for (const id of ids) ctx.execute(deleteTrack(ctx.getDoc(), id));
        return { text: `removed ${ids.length} track(s) (${family})`, mutated: true };
      }
      return { text: `unknown track op: ${op}`, mutated: false };
    }
    case "kyx_pattern": {
      const op = String(record.op ?? "list");
      if (op === "list") {
        const activeId = ctx.getDoc().activePatternId;
        const list = ctx
          .getDoc()
          .patterns.map((pattern, index) => {
            const bars = Math.max(1, Math.round(pattern.stepCount / 16));
            const active = pattern.id === activeId ? " · ACTIVE" : "";
            return `${index + 1}. "${pattern.name}" (${bars} bar${bars > 1 ? "s" : ""})${active}`;
          })
          .join("\n");
        return { text: list || "no patterns", mutated: false };
      }
      // select — by 1-based index or case-insensitive name
      const wanted = String(record.pattern ?? "").trim();
      const patterns = ctx.getDoc().patterns;
      const byIndex = /^\d+$/.test(wanted) ? patterns[Number(wanted) - 1] : undefined;
      const target = byIndex ?? patterns.find((pattern) => pattern.name.toLowerCase() === wanted.toLowerCase());
      if (!target) {
        return {
          text: `no pattern "${wanted}" — use kyx_pattern op:list (have: ${patterns.map((p) => p.name).join(", ") || "none"})`,
          mutated: false,
        };
      }
      if (target.id === ctx.getDoc().activePatternId) {
        return { text: `"${target.name}" is already the active pattern`, mutated: false };
      }
      ctx.execute(setActivePattern(ctx.getDoc(), target.id));
      const bars = Math.max(1, Math.round(target.stepCount / 16));
      return {
        text: `active pattern: "${target.name}" (${bars} bar${bars > 1 ? "s" : ""}) — step edits and generation act on it now`,
        mutated: true,
      };
    }
    case "kyx_steps":
      return executeStepsTool(ctx, record);
    default:
      return { text: `unknown tool: ${name}`, mutated: false };
  }
}

/** Strict family -> track ids for MCP ops: name/kind match only, groups and
 * non-matching families return empty (the caller reports honestly). */
function tracksInFamily(doc: ProjectDocument, family: string): string[] {
  if (family === "drums") return doc.tracks.filter((t) => t.kind === "drum").map((t) => t.id);
  const wanted = new RegExp("\\b" + family + "\\b", "i");
  return doc.tracks
    .filter((t) => {
      if (t.kind === "group") return false;
      if (wanted.test(t.name)) return true;
      if (t.kind !== "instrument") return false;
      if (family === "bass") return ["bass", "808", "logdrum"].includes(t.instrument);
      if (family === "lead") return ["lead", "pluck", "spectral"].includes(t.instrument);
      if (family === "chords") return t.instrument === "keys" || /chord|pad/i.test(t.name);
      return false;
    })
    .map((t) => t.id);
}

/** Section op -> arrange command via the role resolver. */
function sectionCommand(record: Record<string, unknown>, doc: ProjectDocument): Command | null {
  const op = String(record.op ?? "");
  const role = String(record.role ?? "drop");
  const bars = Math.max(1, Math.min(64, Number(record.bars ?? 4)));
  const scene = resolveSceneTarget(doc, role, [role as never]);
  switch (op) {
    case "add":
      return applyArrangeOps(doc, [{ op: "addRole", role: role as never, beforeSceneId: null }]);
    case "remove":
      if (!scene) return null;
      return applyArrangeOps(doc, [{ op: "remove", sceneId: scene.id, role: scene.role ?? null, name: scene.name }]);
    case "duplicate":
      if (!scene) return null;
      return applyArrangeOps(doc, [{ op: "duplicate", sceneId: scene.id, role: scene.role ?? null, name: scene.name }]);
    case "reorder":
      if (!scene) return null;
      return applyArrangeOps(doc, [{ op: "reorder", sceneId: scene.id, dir: "later" }]);
    case "resize":
      if (!scene) return null;
      return applyArrangeOps(doc, [
        { op: "resize", sceneId: scene.id, role: scene.role ?? null, name: scene.name, bars },
      ]);
    default:
      return null;
  }
}

/** Scoped groove part builder for the kyx_groove tool. */
function sectionGrooveFrom(direction: string, percent: number | undefined, section: string) {
  if (direction === "set") return { role: section, direction: "set" as const, swingPercent: percent ?? 50 };
  if (direction === "tighter") return { role: section, direction: "tighter" as const };
  return { role: section, direction: direction === "less" ? ("swingDown" as const) : ("swingUp" as const) };
}

function stateSnapshot(
  doc: ProjectDocument,
  subject: string,
  family: string | undefined,
  historyLabels: () => string[],
): string {
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
  if (subject === "pattern") {
    const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
    if (!pattern) return "no active pattern";
    const bars = Math.max(1, Math.round(pattern.stepCount / 16));
    const families = ["kick", "snare", "clap", "hat", "perc", "tom"] as const;
    const drums = doc.tracks.filter((track): track is DrumTrack => track.kind === "drum");
    const lines = [`active: "${pattern.name}" — ${bars} bar${bars > 1 ? "s" : ""}, ${pattern.stepCount} steps`];
    for (const family of families) {
      const pads: Array<{ id: string }> = [];
      for (const track of drums) {
        track.pads.forEach((pad, index) => {
          if (inferPadRole(pad.name, index) === family) pads.push({ id: pad.id });
        });
      }
      const velocities = pads.flatMap((pad) => pattern.rows[pad.id] ?? []).filter((v) => v > 0);
      if (velocities.length === 0) continue;
      const mean = velocities.reduce((sum, v) => sum + v, 0) / velocities.length;
      const grid = pads
        .map((pad) =>
          (pattern.rows[pad.id] ?? [])
            .map((v, i) => (v > 0 ? (i + 1).toString() : ""))
            .filter(Boolean)
            .join(" "),
        )
        .filter(Boolean)
        .join(" | ");
      lines.push(`${family}: ${velocities.length} steps [${grid}] vel≈${mean.toFixed(2)}`);
    }
    return lines.join("\n");
  }
  if (subject === "scenes") {
    if (doc.scenes.length === 0) return "no scenes (empty arrangement)";
    const barsOf = (sceneId: string): number => {
      const clips = doc.arrangement.clips.filter((clip) => clip.sceneId === sceneId);
      if (clips.length === 0) return 0;
      return (
        Math.max(...clips.map((clip) => clip.startBar + clip.lengthBars)) -
        Math.min(...clips.map((clip) => clip.startBar))
      );
    };
    return doc.scenes
      .map((scene, index) => {
        const role = scene.role ?? "—";
        const bars = barsOf(scene.id);
        return `${index + 1}. "${scene.name}" ${role}${bars > 0 ? ` ${bars}bar` : ""} intensity ${Math.round(scene.intensity * 100)}%`;
      })
      .join("\n");
  }
  if (subject === "history") {
    const labels = historyLabels();
    if (labels.length === 0) return "undo history empty";
    return labels
      .slice(-12)
      .map((label, index, list) => `${list.length - index}. ${label}`)
      .join("\n");
  }
  // overview
  const active = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
  const lines = [
    `${doc.bpm} BPM · ${doc.key ?? "key unset"} · ${doc.tracks.length} tracks · ${doc.scenes.length} scenes · ${doc.patterns.length} patterns`,
    `tracks: ${doc.tracks.map((t) => t.name).join(", ")}`,
    `active pattern: "${active?.name ?? "none"}"${active ? ` (${Math.max(1, Math.round(active.stepCount / 16))} bar)` : ""}`,
    `scenes: ${doc.scenes.map((s) => `${s.name}${s.role ? `(${s.role})` : ""}`).join(", ") || "none"}`,
  ];
  return lines.join("\n");
}

/** kyx_steps — structured 16th-grid edit on the active pattern's drum pads.
 * Family → pads via the same role inference the fader/step intents use;
 * the whole call folds into ONE snapshot (one undo step). */
function executeStepsTool(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  const doc = ctx.getDoc();
  const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
  if (!pattern) return { text: "no active pattern", mutated: false };
  const op = String(record.op ?? "");
  const family = String(record.family ?? "");
  if (!["kick", "snare", "clap", "hat", "perc", "tom"].includes(family)) {
    return { text: `unknown pad family "${family}"`, mutated: false };
  }
  const drums = doc.tracks.filter((track): track is DrumTrack => track.kind === "drum");
  if (drums.length === 0) return { text: "no drum tracks in the project", mutated: false };

  const targets: Array<{ padId: string; name: string }> = [];
  for (const track of drums) {
    track.pads.forEach((pad, index) => {
      if (inferPadRole(pad.name, index) === family) targets.push({ padId: pad.id, name: pad.name });
    });
  }
  if (targets.length === 0) return { text: `no pad matches family "${family}"`, mutated: false };

  const stepCount = pattern.stepCount;
  const requested = Array.isArray(record.steps)
    ? [...new Set(record.steps.map((step) => Math.round(Number(step))))].filter(
        (step) => Number.isFinite(step) && step >= 1 && step <= stepCount,
      )
    : [];
  if (op !== "clearPad" && requested.length === 0) {
    return {
      text: `no valid steps — pattern "${pattern.name}" has ${stepCount} steps (1-based, 16 per bar)`,
      mutated: false,
    };
  }
  const velocity = typeof record.velocity === "number" && record.velocity > 0 ? Math.min(1, record.velocity) : 0.8;

  const familySteps = (source: ProjectDocument): number => {
    const sourcePattern = source.patterns.find((candidate) => candidate.id === doc.activePatternId);
    if (!sourcePattern) return 0;
    return targets.reduce(
      (sum, target) => sum + (sourcePattern.rows[target.padId]?.filter((v) => v > 0).length ?? 0),
      0,
    );
  };
  const before = familySteps(doc);

  let next = doc;
  const touched: number[] = [];
  const rowAt = (source: ProjectDocument, padId: string, index: number): number =>
    source.patterns.find((candidate) => candidate.id === doc.activePatternId)?.rows[padId]?.[index] ?? 0;
  for (const step of op === "clearPad" ? [] : requested) {
    const index = step - 1;
    for (const target of targets) {
      const current = rowAt(next, target.padId, index);
      let write: number | null = null;
      if (op === "add") write = velocity;
      else if (op === "remove") write = current > 0 ? 0 : null;
      else if (op === "toggle") write = current > 0 ? 0 : velocity;
      else if (op === "ghost") write = current > 0 ? null : 0.35;
      if (write == null) continue;
      next = setStepVelocityCommand(next, target.padId, index, write).execute(next);
      if (op === "ghost") next = setStepMeta(next, pattern.id, target.padId, index, { probability: 0.5 }).execute(next);
      if (!touched.includes(index)) touched.push(index);
    }
  }
  if (op === "clearPad") {
    for (const target of targets) {
      for (let index = 0; index < stepCount; index++) {
        if (rowAt(next, target.padId, index) > 0) {
          next = setStepVelocityCommand(next, target.padId, index, 0).execute(next);
          touched.push(index);
        }
      }
    }
  }
  if (touched.length === 0) {
    return { text: `nothing changed (${op} on ${family}: steps already match)`, mutated: false };
  }
  const after = familySteps(next);
  const bars = Math.max(1, Math.round(stepCount / 16));
  const command = snapshot("mcpSteps", `MCP steps: ${op} ${family} ×${touched.length}`, doc, next);
  ctx.execute(command);
  const touchedText =
    touched.length <= 12
      ? touched
          .sort((a, b) => a - b)
          .map((step) => String(step))
          .join(", ")
      : `${touched.length} steps`;
  return {
    text: `${family} ${op}: ${before} → ${after} steps (touched: ${touchedText}) · pattern "${pattern.name}" (${bars} bar${bars > 1 ? "s" : ""}) · one undo step`,
    mutated: true,
  };
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
