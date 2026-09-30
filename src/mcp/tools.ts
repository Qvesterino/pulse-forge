import type { ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
import { routeIntentText, type RoutedIntent } from "../intent/route";
import { applyFaderIntent, applyTempoIntent } from "../intent/conversation";
import {
  applyBypassIntent,
  applyEffectIntent,
  applySendIntent,
  bypassReadback,
  effectReadback,
  EFFECT_KNOB,
} from "../intent/mix";
import { applyCompoundIntent } from "../intent/compound";
import { productionReadback } from "../intent/production";
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
import type { DrumTrack, InstrumentKind, Track, AutomationTarget, AutomationLane } from "../project-model/types";
import { applyPresetIntentCommand } from "../intent/preset-intent";
import {
  addAutomationLane,
  addAutomationPoint,
  addMarker,
  applyExactIntentCommand,
  applyGenerationResultCommand,
  applyProductionIntentCommand,
  createDrumTrack,
  createInstrumentTrack,
  deleteAutomationPoint,
  deleteTrack,
  removeAutomationLane,
  removeMarker,
  setActivePattern,
  setEffectParam,
  setStepMeta,
  setStepVelocityCommand,
  setTrackParams,
  snapshot,
} from "../commands/commands";
import { isAutomationTargetValid, targetParamDef } from "../project-model/targets";
import { clampEffectParam, EFFECT_META, type EffectDefinitionMeta } from "../effects/definitions";
import { INSTRUMENT_DEFS } from "../instruments/registry";

/**
 * KYX MCP — TOOL SURFACE (docs/INTENT-MCP-EXPANSION-PLAN.md Phase D).
 *
 * Sixteen tools expose the intent engine + project state to an external MCP
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
 * pattern/song proposal flows that need in-app auditioning (revise,
 * loudness/mix loops, section production), save/record, mic takes.
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
      "scenes, the send routing map (returns + per-track send levels), the " +
      "undo history, or the FX chain of one family. Never mutates.",
    inputSchema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          enum: [
            "overview",
            "tempo",
            "key",
            "tracks",
            "markers",
            "groove",
            "fxChain",
            "sends",
            "pattern",
            "scenes",
            "history",
          ],
          description: "Which part of the project state to return",
        },
        family: {
          type: "string",
          enum: ["kick", "snare", "clap", "hat", "perc", "tom", "bass", "lead", "chords", "drums"],
          description: "Optional track family filter for fxChain and sends",
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
    description:
      "Transport control AND reads: play, stop, pause, loop on/off, " +
      "metronome on/off — or seek to a 1-based bar (optional beat), set the " +
      "loop region in bars (loopRegion), or state: a read-only read-back of " +
      "the playhead position (bar/beat/tick), playing state, loop region and " +
      "metronome. Position is 4/4-based (1920 ticks per bar, 480 per beat).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "play",
            "stop",
            "pause",
            "loopOn",
            "loopOff",
            "metronomeOn",
            "metronomeOff",
            "seek",
            "loopRegion",
            "state",
          ],
        },
        bar: { type: "integer", minimum: 1, description: "For seek — 1-based destination bar" },
        beat: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "For seek — 1-based beat within the bar (default 1)",
        },
        startBar: { type: "integer", minimum: 1, description: "For loopRegion — first looped bar (1-based)" },
        endBar: {
          type: "integer",
          minimum: 2,
          description: "For loopRegion — last looped bar (inclusive; must be > startBar)",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "kyx_export",
    description:
      "Request a bounce of the current project (WAV/MP3). The render + " +
      "download run in the KYX app window; the tool reports that the bounce " +
      "started (completion is not verifiable over MCP v1).",
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
      "Structured effect operation on a track family or ONE exact track: " +
      "more/less turn the effect's PRIMARY knob (percent = relative step " +
      "size), remove deletes instances (destructive-gated), bypass/enable " +
      "flag instances without deleting them. Effect types are the " +
      "knob-mapped subset — eq and other no-knob effects are refused; use " +
      "kyx_plugin_param for their parameters.",
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
          ],
        },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Track family target — required unless trackId is given",
        },
        trackId: {
          type: "string",
          description: "Exact track id (from kyx_state tracks) — overrides family when present",
        },
        action: { type: "string", enum: ["more", "less", "remove", "bypass", "enable"] },
        percent: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Relative step size for more/less, as % of the knob's range (default: fixed calibrated step)",
        },
      },
      required: ["effect", "action"],
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
      "existing one by family or by exact trackId (group tracks are not " +
      "addressable here). Removing the last track is declined.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["addDrum", "addInstrument", "remove", "rename"] },
        family: {
          type: "string",
          enum: ["drums", "bass", "lead", "chords", "kick", "snare", "clap", "hat", "perc", "tom"],
          description: "For remove/rename: which family to touch — ignored when trackId is given",
        },
        trackId: {
          type: "string",
          description: "Exact track id (from kyx_state tracks) — overrides family for remove/rename",
        },
        instrument: {
          type: "string",
          enum: ["analog", "bass", "808", "keys", "pluck", "acid", "reese", "brass", "flute", "sampler"],
          description: "For addInstrument — the full kind catalog is in kyx_catalog subject:instruments",
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
  {
    name: "kyx_catalog",
    description:
      "Discovery — what the DAW can do, machine-readable: list every effect " +
      "type with its category and primary knob, the FULL parameter table of " +
      "one effect (id, label, min, max, default, unit, kind, taper), or the " +
      "instrument kind catalog. Read-only; use it before kyx_plugin_param " +
      "instead of guessing ranges.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", enum: ["effects", "effect", "instruments"] },
        effect: {
          type: "string",
          description: "Effect type for subject:effect (e.g. reverb, eq, compressor) — see subject:effects",
        },
      },
      required: ["subject"],
    },
  },
  {
    name: "kyx_plugin_param",
    description:
      "Precise plugin control on inserted FX instances: set ONE parameter to " +
      "an absolute NATIVE value (clamped to the registry range; see " +
      "kyx_catalog subject:effect for min/max/default/unit) or list the " +
      "current values of every parameter on the targeted tracks' chains. " +
      "Targets a trackId or a family; instance picks 1-based among same-type " +
      "instances (default 1). Missing instances are reported honestly — " +
      "nothing is auto-inserted (use kyx_fx more for that).",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "set"] },
        trackId: { type: "string", description: "Exact track id — overrides family when present" },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Track family target — required unless trackId is given",
        },
        effect: {
          type: "string",
          description: "Effect type (e.g. reverb, eq) — required for set, filters list when given; see kyx_catalog",
        },
        instance: {
          type: "integer",
          minimum: 1,
          description: "1-based index among same-type instances in chain order (default 1)",
        },
        param: { type: "string", description: "Parameter id for set (e.g. mix, decay, freq) — see kyx_catalog" },
        value: {
          type: "number",
          description: "Absolute NATIVE value for set (NOT normalized 0..1 unless the param's range is 0..1)",
        },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_meter",
    description:
      "Live audio meters — the AI's ears: master true peak, RMS, LUFS " +
      "(momentary/short-term/integrated), stereo correlation, clip flags, " +
      "plus per-track peak/RMS. Read-only snapshot of the RUNNING engine; " +
      "honestly refused when no engine/audio context is live. LUFS-I needs " +
      "a few seconds of playback to stabilize.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["master", "tracks", "all"], description: "Default all" },
      },
      required: [],
    },
  },
  {
    name: "kyx_automation",
    description:
      "Automation lanes on the project timeline: add a point (lane is " +
      "created on demand — one undo step for both), delete the point nearest " +
      "a bar, clear a lane, or remove a lane (clear/remove are " +
      "destructive-gated). Targets: trackId or family + param — 'gain' or " +
      "'pan' for track lanes, or effect+param for FX-parameter lanes (see " +
      "kyx_catalog for ranges). Values are NATIVE (gain 0..1.5, pan -1..1, " +
      "fx params per their registry range); out-of-range values are clamped. " +
      "Read the lanes first via kyx_state subject:automation.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["addPoint", "deletePoint", "clearLane", "removeLane"] },
        trackId: { type: "string", description: "Exact track id — overrides family when present" },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Track family target — required unless trackId is given",
        },
        param: {
          type: "string",
          description: "'gain' or 'pan' when no effect is given; the effect's paramId when effect is given",
        },
        effect: {
          type: "string",
          description: "Effect type for fxParam lanes — resolves to the track's 1-based instance (default 1)",
        },
        instance: { type: "integer", minimum: 1, description: "1-based same-type instance index (default 1)" },
        bar: {
          type: "integer",
          minimum: 1,
          description: "1-based bar — position for addPoint, anchor for deletePoint",
        },
        beat: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "Optional 1-based beat within the bar (default 1)",
        },
        value: { type: "number", description: "NATIVE value for addPoint (clamped into the target's range)" },
      },
      required: ["op"],
    },
  },
];

/** Live metering snapshot the kyx_meter tool reads (present only when the
 * host has a running engine — headless contexts honestly refuse). */
export interface McpMeterSnapshot {
  master: {
    truePeakDb: number;
    rmsDb: number;
    lufsMomentary: number;
    lufsShortTerm: number;
    lufsIntegrated: number;
    correlation: number;
    clipping: boolean;
  };
  tracks: Array<{ id: string; name: string; peakDb: number; rmsDb: number; clipping: boolean }>;
}

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
    /** Current loop bounds (ticks) — present on the live transport; used to
     * PRESERVE the user's loop range when MCP only toggles loop on. */
    loopStart?: number;
    loopEnd?: number;
    /** Live transport reads (kyx_transport state / verification read-backs):
     * position in ticks, playing/paused flags, loop + metronome state, and
     * an absolute seek. Absent on bare test fakes — reads degrade honestly. */
    position?: number;
    playing?: boolean;
    paused?: boolean;
    loopEnabled?: boolean;
    metronome?: boolean;
    seek?: (tick: number) => void;
  };
  /** Present when the KYX window can render/downloads (browser relay). */
  export?: (format: "wav" | "mp3") => Promise<string>;
  /** Present when a live engine can be metered (kyx_meter). Null/absent →
   * the tool refuses honestly instead of inventing numbers. */
  meters?: () => McpMeterSnapshot | null;
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
  /** Explicit failure marker — honored by the transports so a caught error
   * never masquerades as a successful call (e.g. relay crash guard). */
  isError?: boolean;
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

/** Shared transport dispatch (kyx_transport + intent-routed transport
 * asks). loopOn PRESERVES the user's loop range when the live transport
 * exposes it — same contract as the in-app intent bar; only a project with
 * no loop falls back to the first 4 bars. Every read-back ends with the
 * resulting transport STATE so the caller can verify the landing. */
function dispatchTransport(ctx: McpToolContext, action: string): McpToolResult {
  const transport = ctx.transport;
  if (action === "play") transport.play();
  else if (action === "stop") transport.stop();
  else if (action === "pause") transport.pause();
  else if (action === "metronomeOn") transport.setMetronome(true);
  else if (action === "metronomeOff") transport.setMetronome(false);
  else if (action === "loopOn") {
    const currentStart = transport.loopStart ?? 0;
    const currentEnd = transport.loopEnd ?? 0;
    const end = currentEnd > currentStart ? currentEnd : currentStart + TICKS_PER_BAR * 4;
    transport.setLoop(true, currentStart, end);
  } else if (action === "loopOff") transport.setLoop(false, 0, 0);
  else return { text: `unknown transport action: ${action}`, mutated: false };
  return { text: `transport: ${action} · ${describeTransport(transport)}`, mutated: false };
}

/** Human/AI-readable transport state line; every optional read degrades to
 * an honest "unknown" when the host's transport lacks the accessor. */
function describeTransport(transport: McpToolContext["transport"]): string {
  const parts: string[] = [];
  if (typeof transport.position === "number" && Number.isFinite(transport.position)) {
    const tick = Math.max(0, Math.round(transport.position));
    const bar = Math.floor(tick / TICKS_PER_BAR) + 1;
    const beat = Math.floor((tick % TICKS_PER_BAR) / (TICKS_PER_BAR / 4)) + 1;
    parts.push(`position bar ${bar} beat ${beat} (tick ${tick})`);
  } else {
    parts.push("position unknown");
  }
  if (typeof transport.playing === "boolean") {
    parts.push(transport.playing ? "playing" : transport.paused === true ? "paused" : "stopped");
  }
  if (typeof transport.loopEnabled === "boolean") {
    if (transport.loopEnabled && typeof transport.loopStart === "number" && typeof transport.loopEnd === "number") {
      // Transport semantics: loopEnd 0 (or <= start) = "to the end of the
      // current content" — report it as such instead of a bogus bar number.
      const region =
        transport.loopEnd > transport.loopStart
          ? `bars ${Math.floor(transport.loopStart / TICKS_PER_BAR) + 1}–${Math.ceil(transport.loopEnd / TICKS_PER_BAR)}`
          : "to end of content";
      parts.push(`loop on (${region})`);
    } else {
      parts.push("loop off");
    }
  }
  if (typeof transport.metronome === "boolean") parts.push(transport.metronome ? "metronome on" : "metronome off");
  return parts.join(" · ");
}

/** kyx_transport seek — absolute position by 1-based bar (+ optional beat). */
function transportSeek(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  const transport = ctx.transport;
  if (transport.seek == null) {
    return { text: "seek is not available over this MCP transport (no seek-capable transport bound)", mutated: false };
  }
  const rawBar = Number(record.bar);
  if (!Number.isFinite(rawBar) || Math.round(rawBar) < 1) {
    return { text: 'seek needs a 1-based bar (e.g. { action: "seek", bar: 5 })', mutated: false };
  }
  const bar = Math.round(rawBar);
  const rawBeat = typeof record.beat === "number" ? record.beat : 1;
  const beat = Math.min(4, Math.max(1, Math.round(Number.isFinite(rawBeat) ? rawBeat : 1)));
  const tick = (bar - 1) * TICKS_PER_BAR + (beat - 1) * (TICKS_PER_BAR / 4);
  // Method CALL on the transport object — extracting `transport.seek` into a
  // local would drop `this` and crash the real Transport (unbound playing_).
  transport.seek(tick);
  return {
    text: `seek → bar ${bar}${beat > 1 ? ` beat ${beat}` : ""} (tick ${tick}) · ${describeTransport(ctx.transport)}`,
    mutated: false,
  };
}

/** kyx_transport loopRegion — set the loop by 1-based inclusive bars. */
function transportLoopRegion(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  const startBar = Math.round(Number(record.startBar));
  const endBar = Math.round(Number(record.endBar));
  if (!Number.isFinite(startBar) || !Number.isFinite(endBar) || startBar < 1 || endBar <= startBar) {
    return {
      text: 'loopRegion needs { startBar >= 1, endBar > startBar } (1-based, inclusive) — e.g. { action: "loopRegion", startBar: 5, endBar: 9 }',
      mutated: false,
    };
  }
  const startTick = (startBar - 1) * TICKS_PER_BAR;
  const endTick = endBar * TICKS_PER_BAR;
  ctx.transport.setLoop(true, startTick, endTick);
  return {
    text: `loop region: bars ${startBar}–${endBar} (ticks ${startTick}..${endTick}) · ${describeTransport(ctx.transport)}`,
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
        // A real undo/redo always moves the undo stack (undo pops it, redo
        // pushes it); an unchanged length means the stack ran out — stop
        // counting so the read-back never reports steps that did not happen.
        if (ctx.undoStackLength() === before) break;
        done += 1;
      }
      return { text: `${action} ×${done}`, mutated: done > 0 };
    }
    case "kyx_transport": {
      const action = String(record.action ?? "");
      if (action === "seek") return transportSeek(ctx, record);
      if (action === "loopRegion") return transportLoopRegion(ctx, record);
      if (action === "state") return { text: describeTransport(ctx.transport), mutated: false };
      return dispatchTransport(ctx, action);
    }
    case "kyx_export": {
      if (ctx.export == null) {
        return {
          text: "export is not available over this MCP transport — use the KYX export panel",
          mutated: false,
        };
      }
      const format = record.format === "mp3" ? "mp3" : "wav";
      void ctx.export(format).catch(() => {});
      return {
        text:
          `export ${format.toUpperCase()} started in the KYX window (render + download run there; ` +
          "completion is reported in the app, not verifiable over MCP v1)",
        mutated: false,
      };
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
      const action = String(record.action ?? "");
      const effect = String(record.effect ?? "");
      const targets = explicitTargets(record);
      if (typeof targets === "string") return { text: targets, mutated: false };
      if (action === "remove" && ctx.allowDestructive?.() !== true) return destructiveRefusal();
      // eq (and any knob-less effect) has no single "primary knob" — never
      // pretend: point at kyx_plugin_param instead of throwing deep inside
      // the applier (the pre-audit schema advertised eq here although every
      // such call failed).
      if (!(effect in EFFECT_KNOB)) {
        return {
          text:
            `fx op failed: "${effect}" has no single primary knob for more/less — ` +
            `list its parameters with kyx_catalog subject:effect, then set them via kyx_plugin_param`,
          mutated: false,
        };
      }
      try {
        const before = ctx.getDoc();
        // bypass/enable flip the BYPASS FLAG (never delete the instance);
        // more/less turn the primary knob; remove deletes (D4-gated).
        if (action === "bypass" || action === "enable") {
          const bypassed = action === "bypass";
          const command = applyBypassIntent(ctx.getDoc(), {
            effectType: effect,
            target: targets[0],
            bypassed,
          } as unknown as Parameters<typeof applyBypassIntent>[1]);
          ctx.execute(command);
          const readback = bypassReadback(ctx.getDoc(), {
            effectType: effect,
            target: targets[0],
            bypassed,
          } as Parameters<typeof applyBypassIntent>[1]);
          return { text: `${command.label}${readback ? ` — ${readback}` : ""} (one undo step)`, mutated: true };
        }
        const intent = {
          effectType: effect,
          targets,
          direction: action === "remove" ? "remove" : action,
          amount: "medium",
          ...(typeof record.percent === "number" ? { percent: record.percent } : {}),
          detected: ["MCP"],
        } as unknown as Parameters<typeof applyEffectIntent>[1];
        const command = applyEffectIntent(ctx.getDoc(), intent);
        ctx.execute(command);
        // Wave-8 verification: report the knob's ACTUAL landing value read
        // from the post-execution document (clamps included).
        const readback = effectReadback(before, ctx.getDoc(), intent);
        return { text: `${command.label}${readback ? ` — ${readback}` : ""} (one undo step)`, mutated: true };
      } catch (error) {
        // The intent appliers throw on no-target / no-change — over MCP that
        // must surface as an honest failure result, never a relay hang.
        return {
          text: `fx op failed: ${error instanceof Error ? error.message : String(error)}`,
          mutated: false,
        };
      }
    }
    case "kyx_sections": {
      if (String(record.op ?? "") === "remove" && ctx.allowDestructive?.() !== true) return destructiveRefusal();
      try {
        const command = sectionCommand(record, ctx.getDoc());
        if (!command) return { text: "section op not resolvable — check the role exists", mutated: false };
        ctx.execute(command);
        return { text: `${command.label} (one undo step)`, mutated: true };
      } catch (error) {
        // Arrange primitives throw on invariant violations (e.g. a resize
        // that would overlap the neighbouring clip) — honest failure over
        // MCP, never a thrown crash into the relay.
        return {
          text: `section op failed: ${error instanceof Error ? error.message : String(error)}`,
          mutated: false,
        };
      }
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
        const ids = explicitTrackIds(ctx.getDoc(), record);
        if (typeof ids === "string") return { text: ids, mutated: false };
        if (ids.length === 0)
          return { text: `no track matches family "${String(record.family ?? "")}"`, mutated: false };
        ctx.execute(setTrackParams(ctx.getDoc(), ids[0], { name }));
        return { text: `renamed to "${name}"`, mutated: true };
      }
      if (op === "remove") {
        if (ctx.allowDestructive?.() !== true) return destructiveRefusal();
        const ids = explicitTrackIds(ctx.getDoc(), record);
        if (typeof ids === "string") return { text: ids, mutated: false };
        if (ids.length === 0)
          return { text: `no track matches family "${String(record.family ?? "")}"`, mutated: false };
        if (ctx.getDoc().tracks.length - ids.length < 1) {
          return { text: "declined: cannot remove the last track", mutated: false };
        }
        // ONE snapshot for the whole removal — N separate deleteTrack
        // commands would leave N undo steps for a single MCP call.
        let next = ctx.getDoc();
        for (const id of ids) next = deleteTrack(next, id).execute(next);
        const label =
          typeof record.trackId === "string" && record.trackId.trim() !== ""
            ? `id ${record.trackId.trim()}`
            : String(record.family ?? "");
        ctx.execute(snapshot("mcpRemoveTracks", `MCP: remove tracks (${label}) ×${ids.length}`, ctx.getDoc(), next));
        return { text: `removed ${ids.length} track(s) (${label}) — one undo step`, mutated: true };
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
    case "kyx_catalog":
      return catalogSnapshot(record);
    case "kyx_plugin_param":
      return executePluginParamTool(ctx, record);
    case "kyx_automation":
      return executeAutomationTool(ctx, record);
    case "kyx_meter": {
      if (ctx.meters == null) {
        return {
          text: "metering is not available over this MCP transport (no live engine bound) — start KYX with an audio context",
          mutated: false,
        };
      }
      const snapshotMeters = ctx.meters();
      if (snapshotMeters == null) {
        return { text: "engine is not running (no audio context) — nothing to meter yet", mutated: false };
      }
      const scope = String(record.scope ?? "all");
      const db = (value: number): string => (Number.isFinite(value) ? `${value.toFixed(1)} dBFS` : "-inf");
      const lines: string[] = [];
      if (scope !== "tracks") {
        const m = snapshotMeters.master;
        lines.push(
          `master: truePeak ${db(m.truePeakDb)} · RMS ${db(m.rmsDb)} · LUFS-M ${m.lufsMomentary.toFixed(1)} / S ${m.lufsShortTerm.toFixed(1)} / I ${m.lufsIntegrated.toFixed(1)} · corr ${m.correlation.toFixed(2)}${m.clipping ? " · ⚠ CLIPPING (true peak ≥ 0 dBFS)" : ""}`,
        );
      }
      if (scope !== "master") {
        for (const track of snapshotMeters.tracks) {
          lines.push(
            `${track.name} (id=${track.id}): peak ${db(track.peakDb)} · RMS ${db(track.rmsDb)}${track.clipping ? " · ⚠ CLIPPING" : ""}`,
          );
        }
        if (snapshotMeters.tracks.length === 0) lines.push("no track meters live");
      }
      return { text: lines.join("\n"), mutated: false };
    }
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

/** Target resolution for writes that accept either an exact trackId or a
 * family: trackId wins when present (and must exist), else the family must
 * be non-empty. Returns an error string for the caller to surface. */
function explicitTargets(record: Record<string, unknown>): string[] | string {
  const trackId = typeof record.trackId === "string" ? record.trackId.trim() : "";
  if (trackId !== "") return [trackId];
  const family = typeof record.family === "string" ? record.family.trim() : "";
  if (family !== "") return [family];
  return "no target — pass trackId (from kyx_state tracks) or family";
}

/** Track ids for kyx_tracks remove/rename: exact trackId (single, group
 * tracks excluded — their lifecycle is not MCP-addressable) or family. */
function explicitTrackIds(doc: ProjectDocument, record: Record<string, unknown>): string[] | string {
  const trackId = typeof record.trackId === "string" ? record.trackId.trim() : "";
  if (trackId !== "") {
    const track = doc.tracks.find((t) => t.id === trackId);
    if (track == null) return `no track with id "${trackId}" — list ids via kyx_state subject:tracks`;
    if (track.kind === "group") return "group tracks are not addressable by kyx_tracks — remove/rename members instead";
    return [track.id];
  }
  const family = typeof record.family === "string" ? record.family.trim() : "";
  if (family === "") return "no target — pass trackId (from kyx_state tracks) or family";
  return tracksInFamily(doc, family);
}

/** kyx_automation — structured automation-lane edits over the SAME target
 * validation the engine rides (isAutomationTargetValid / clampTargetValue
 * inside the commands). Lane create-on-demand folds into ONE snapshot. */
function executeAutomationTool(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  const op = String(record.op ?? "");
  const doc = ctx.getDoc();
  const target = resolveAutomationTarget(doc, record);
  if (typeof target === "string") return { text: target, mutated: false };
  if (!isAutomationTargetValid(doc, target)) {
    return {
      text: "invalid automation target — check the track/effect/param exists (kyx_catalog, kyx_state fxChain)",
      mutated: false,
    };
  }
  const lane = automationLaneForTarget(doc, target);

  if (op === "addPoint") {
    const position = positionFromRecord(record);
    if (typeof position === "string") return { text: position, mutated: false };
    if (record.value == null || !Number.isFinite(Number(record.value))) {
      const def = targetParamDef(doc, target);
      return {
        text: `addPoint needs a finite NATIVE value${def ? ` (${target.paramId ?? target.kind}: ${def.min}..${def.max}, default ${def.default})` : ""}`,
        mutated: false,
      };
    }
    // ONE snapshot for lane-create + point (a fresh lane alone would leave
    // the caller two undo steps for one call).
    let next = doc;
    let laneId = lane?.id;
    if (!laneId) {
      const laneCommand = addAutomationLane(next, target);
      next = laneCommand.execute(next);
      laneId = next.automation[next.automation.length - 1].id;
    }
    const value = Number(record.value);
    next = addAutomationPoint(next, laneId, position, value).execute(next);
    const landedLane = next.automation.find((candidate) => candidate.id === laneId);
    // Last match wins: the engine samples the most recent point at a tick.
    const landed = landedLane?.points.filter((point) => point.tick === position).pop();
    if (!landed || landedLane == null) {
      return { text: "automation point did not land (already present with this value?)", mutated: false };
    }
    const pointCount = landedLane.points.length;
    const def = targetParamDef(doc, target);
    const clampNote = landed.value !== value ? ` — clamped into ${def ? `${def.min}..${def.max}` : "range"}` : "";
    ctx.execute(
      snapshot(
        "mcpAutomation",
        `MCP: automation ${automationTargetLabel(doc, target)} @ ${barBeat(position)}`,
        doc,
        next,
      ),
    );
    return {
      text: `${automationTargetLabel(doc, target)}: point ${barBeat(landed.tick)}=${Math.round(landed.value * 1e4) / 1e4}${clampNote} — lane ${pointCount} pt(s), one undo step`,
      mutated: true,
    };
  }

  if (op === "deletePoint") {
    if (!lane)
      return {
        text: `no automation lane for ${automationTargetLabel(doc, target)} — nothing to delete`,
        mutated: false,
      };
    if (lane.points.length === 0) return { text: "the lane has no points", mutated: false };
    const position = positionFromRecord(record);
    if (typeof position === "string") return { text: position, mutated: false };
    // Nearest point within one bar window (same etiquette as kyx_markers).
    let bestIndex = -1;
    let bestDistance = TICKS_PER_BAR;
    lane.points.forEach((point, index) => {
      const distance = Math.abs(point.tick - position);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex === -1) {
      return {
        text: `no automation point within a bar of ${barBeat(position)} — read the lane via kyx_state subject:automation`,
        mutated: false,
      };
    }
    const removed = lane.points[bestIndex];
    ctx.execute(deleteAutomationPoint(doc, lane.id, bestIndex));
    return {
      text: `${automationTargetLabel(doc, target)}: removed point ${barBeat(removed!.tick)}=${Math.round(removed!.value * 1e4) / 1e4} — one undo step`,
      mutated: true,
    };
  }

  if (op === "clearLane" || op === "removeLane") {
    if (ctx.allowDestructive?.() !== true) return destructiveRefusal();
    if (!lane) return { text: `no automation lane for ${automationTargetLabel(doc, target)}`, mutated: false };
    if (op === "removeLane") {
      ctx.execute(removeAutomationLane(doc, lane.id));
      return { text: `removed automation lane ${automationTargetLabel(doc, target)} — one undo step`, mutated: true };
    }
    if (lane.points.length === 0) return { text: "the lane already has no points", mutated: false };
    const cleared = lane.points.length;
    const next = {
      ...doc,
      automation: doc.automation.map((candidate) =>
        candidate.id === lane.id ? { ...candidate, points: [] } : candidate,
      ),
    };
    ctx.execute(
      snapshot("mcpAutomationClear", `MCP: clear automation ${automationTargetLabel(doc, target)}`, doc, next),
    );
    return {
      text: `cleared ${cleared} point(s) from ${automationTargetLabel(doc, target)} — one undo step`,
      mutated: true,
    };
  }

  return { text: `unknown op: ${op} (addPoint | deletePoint | clearLane | removeLane)`, mutated: false };
}

/** Resolve the tool's target fields into an AutomationTarget. Returns an
 * error string for the caller to surface. */
function resolveAutomationTarget(doc: ProjectDocument, record: Record<string, unknown>): AutomationTarget | string {
  const trackId = typeof record.trackId === "string" ? record.trackId.trim() : "";
  const family = typeof record.family === "string" ? record.family.trim() : "";
  let ownerId: string;
  if (trackId !== "") {
    ownerId = trackId;
  } else if (family !== "") {
    const ids = tracksInFamily(doc, family);
    if (ids.length === 0) return `no track matches family "${family}"`;
    ownerId = ids[0];
  } else {
    return "no target — pass trackId (from kyx_state tracks) or family";
  }
  if (!doc.tracks.some((t) => t.id === ownerId) && !doc.returns.some((r) => r.id === ownerId)) {
    return `no track or return with id "${ownerId}" — list ids via kyx_state subject:tracks`;
  }
  const param = typeof record.param === "string" ? record.param.trim() : "";
  const effect = typeof record.effect === "string" ? record.effect.trim() : "";
  if (effect !== "") {
    const track = doc.tracks.find((t) => t.id === ownerId);
    if (!track) return "fxParam automation needs a TRACK target (returns cannot host effect lanes here)";
    const instanceWanted = Math.max(1, Math.round(Number(record.instance ?? 1)));
    const instances = track.effects.filter((fx) => fx.type === effect);
    if (instances.length === 0) return `${track.name}: no ${effect} instance (insert via kyx_fx more first)`;
    if (instances.length < instanceWanted) {
      return `${track.name}: ${effect} instance #${instanceWanted} does not exist (chain has ${instances.length})`;
    }
    const fx = instances[instanceWanted - 1];
    if (param === "") return "fxParam automation needs param (the effect's paramId — see kyx_catalog subject:effect)";
    return { kind: "fxParam", trackId: track.id, fxId: fx.id, paramId: param };
  }
  if (param === "gain") return { kind: "trackGain", trackId: ownerId };
  if (param === "pan") return { kind: "trackPan", trackId: ownerId };
  return "param must be 'gain' or 'pan' — or pass effect+param for an FX-parameter lane";
}

/** 4-field target equality — the same key addAutomationLane dedupes on. */
function automationLaneForTarget(doc: ProjectDocument, target: AutomationTarget): AutomationLane | undefined {
  return doc.automation.find(
    (lane) =>
      lane.target.kind === target.kind &&
      lane.target.trackId === target.trackId &&
      lane.target.fxId === target.fxId &&
      lane.target.paramId === target.paramId,
  );
}

/** bar (+ optional beat) → absolute tick; error string on bad input. */
function positionFromRecord(record: Record<string, unknown>): number | string {
  const rawBar = Number(record.bar);
  if (!Number.isFinite(rawBar) || Math.round(rawBar) < 1) return "a 1-based bar is required (e.g. bar: 5)";
  const bar = Math.round(rawBar);
  const rawBeat = typeof record.beat === "number" && Number.isFinite(record.beat) ? record.beat : 1;
  const beat = Math.min(4, Math.max(1, Math.round(rawBeat)));
  return (bar - 1) * TICKS_PER_BAR + (beat - 1) * (TICKS_PER_BAR / 4);
}

/** kyx_catalog — machine-readable discovery over the registries. */
function catalogSnapshot(record: Record<string, unknown>): McpToolResult {
  const subject = String(record.subject ?? "effects");
  if (subject === "instruments") {
    const lines = Object.values(INSTRUMENT_DEFS).map(
      (def) => `${def.kind} — ${def.name} (${def.params.length} params)`,
    );
    return { text: `${lines.length} instrument kinds:\n${lines.join("\n")}`, mutated: false };
  }
  if (subject === "effect") {
    const type = String(record.effect ?? "").trim();
    const meta = (EFFECT_META as Record<string, EffectDefinitionMeta | undefined>)[type];
    if (meta == null) {
      const known = Object.keys(EFFECT_META).slice(0, 12).join(", ");
      return {
        text: `unknown effect "${type}" — see kyx_catalog subject:effects (first kinds: ${known}, …)`,
        mutated: false,
      };
    }
    const knob = EFFECT_KNOB[type as keyof typeof EFFECT_KNOB];
    const lines = [
      `${meta.type} — ${meta.name} (${meta.category})`,
      knob
        ? `primary knob (kyx_fx more/less): ${knob}`
        : "no single primary knob — set parameters via kyx_plugin_param",
      "parameters (native units; kyx_plugin_param set clamps into these ranges):",
      ...meta.params.map((param) => {
        const extras = [
          param.unit != null ? `unit ${param.unit}` : null,
          param.kind != null ? param.kind : null,
          param.step != null ? `step ${param.step}` : null,
          param.taper != null ? `${param.taper} taper` : null,
          param.options != null ? `options: ${param.options.map((o) => `${o.value}=${o.label}`).join("|")}` : null,
        ].filter(Boolean);
        return `  ${param.id} "${param.label}": ${param.min} .. ${param.max}, default ${param.default}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
      }),
    ];
    return { text: lines.join("\n"), mutated: false };
  }
  // effects list
  const lines = Object.values(EFFECT_META).map((meta) => {
    const knob = EFFECT_KNOB[meta.type];
    return `${meta.type} — ${meta.name} (${meta.category})${knob ? ` [knob: ${knob}]` : " [no single knob]"}`;
  });
  return {
    text:
      `${lines.length} effect types (kyx_fx more/less accepts the [knob] subset; ` +
      "kyx_plugin_param sets ANY parameter of an inserted instance; " +
      "details: kyx_catalog subject:effect + effect <type>):\n" +
      lines.join("\n"),
    mutated: false,
  };
}

/** kyx_plugin_param — precise per-instance parameter control over the
 * registry ranges (clampEffectParam), one undo snapshot per call. */
function executePluginParamTool(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  const op = String(record.op ?? "list");
  const doc = ctx.getDoc();
  const effect = String(record.effect ?? "").trim();
  const meta = effect !== "" ? (EFFECT_META as Record<string, EffectDefinitionMeta | undefined>)[effect] : undefined;
  if (effect !== "" && meta == null) {
    return {
      text: `unknown effect "${effect}" — see kyx_catalog subject:effects`,
      mutated: false,
    };
  }

  const trackId = typeof record.trackId === "string" ? record.trackId.trim() : "";
  const family = typeof record.family === "string" ? record.family.trim() : "";
  let targets: Track[];
  if (trackId !== "") {
    const track = doc.tracks.find((t) => t.id === trackId);
    if (track == null)
      return { text: `no track with id "${trackId}" — list ids via kyx_state subject:tracks`, mutated: false };
    targets = [track];
  } else if (family !== "") {
    targets = tracksInFamily(doc, family)
      .map((id) => doc.tracks.find((t) => t.id === id))
      .filter((t): t is Track => t != null);
    if (targets.length === 0) return { text: `no track matches family "${family}"`, mutated: false };
  } else {
    return { text: "no target — pass trackId (from kyx_state tracks) or family", mutated: false };
  }

  if (op === "list") {
    const lines: string[] = [];
    for (const track of targets) {
      const instances = track.effects.filter((fx) => effect === "" || fx.type === effect);
      if (instances.length === 0) {
        if (effect !== "") lines.push(`${track.name}: no ${effect} instance in the chain`);
        else if (track.effects.length === 0) lines.push(`${track.name}: no FX`);
        continue;
      }
      for (const fx of instances) {
        const fxMeta = (EFFECT_META as Record<string, EffectDefinitionMeta | undefined>)[fx.type];
        const params = fxMeta?.params ?? [];
        const values = params.map((param) => {
          const current = fx.params[param.id] ?? param.default;
          return `${param.id}=${current} (${param.min}..${param.max}${param.unit ? ` ${param.unit}` : ""}, def ${param.default})`;
        });
        lines.push(
          `${track.name}: ${fx.type}#${instances.indexOf(fx) + 1}${fx.bypassed ? " [bypassed]" : ""} ${values.join(", ") || "(no numeric params)"}`,
        );
      }
    }
    if (lines.length === 0) return { text: "no FX instances match the target", mutated: false };
    if (lines.length > 40)
      return {
        text: `${lines.slice(0, 40).join("\n")}\n… and ${lines.length - 40} more instance line(s)`,
        mutated: false,
      };
    return { text: lines.join("\n"), mutated: false };
  }

  if (op === "set") {
    if (meta == null)
      return { text: "set needs an effect type — pass effect (see kyx_catalog subject:effects)", mutated: false };
    const paramId = String(record.param ?? "").trim();
    const paramDef = meta.params.find((p) => p.id === paramId);
    if (paramDef == null) {
      return {
        text: `unknown param "${paramId}" on ${effect} — parameters: ${meta.params.map((p) => p.id).join(", ")}`,
        mutated: false,
      };
    }
    const rawValue = Number(record.value);
    if (record.value == null || !Number.isFinite(rawValue)) {
      return {
        text: `set needs a finite number in NATIVE units (${paramId}: ${paramDef.min}..${paramDef.max}${paramDef.unit ? ` ${paramDef.unit}` : ""}, default ${paramDef.default})`,
        mutated: false,
      };
    }
    const instanceWanted = Math.max(1, Math.round(Number(record.instance ?? 1)));
    const clamped = clampEffectParam(effect as keyof typeof EFFECT_META, paramId, rawValue);
    let next = doc;
    const parts: string[] = [];
    let touched = 0;
    for (const track of targets) {
      const instances = track.effects.filter((fx) => fx.type === effect);
      if (instances.length === 0) {
        parts.push(`${track.name}: no ${effect} instance (insert via kyx_fx more first)`);
        continue;
      }
      if (instances.length < instanceWanted) {
        parts.push(
          `${track.name}: ${effect} instance #${instanceWanted} does not exist (chain has ${instances.length})`,
        );
        continue;
      }
      const fx = instances[instanceWanted - 1];
      const prev = fx.params[paramId] ?? paramDef.default;
      next = setEffectParam(next, track.id, fx.id, paramId, clamped).execute(next);
      touched += 1;
      const tidy = (value: number): number => Math.round(value * 1e4) / 1e4; // kill float noise in the read-back
      const clampedNote = clamped !== rawValue ? ` — clamped to ${paramDef.min}..${paramDef.max}` : "";
      parts.push(`${track.name}: ${paramId} ${tidy(prev)} → ${tidy(clamped)}${clampedNote}`);
    }
    if (touched === 0) {
      return { text: `nothing changed — ${parts.join("; ")}`, mutated: false };
    }
    ctx.execute(snapshot("mcpPluginParam", `MCP: ${effect}.${paramId} on ${touched} track(s)`, doc, next));
    return { text: `${parts.join("; ")} — one undo step`, mutated: true };
  }

  return { text: `unknown op: ${op} (list | set)`, mutated: false };
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

/** Track or return display name for an automation target owner. */
function ownerNameOf(doc: ProjectDocument, trackId: string): string {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (track) return track.name;
  return doc.returns.find((r) => r.id === trackId)?.name ?? trackId;
}

/** tick → "bar.beat" (4/4, 1920 ticks per bar). */
function barBeat(tick: number): string {
  const bar = Math.floor(tick / TICKS_PER_BAR) + 1;
  const beat = Math.floor((tick % TICKS_PER_BAR) / (TICKS_PER_BAR / 4)) + 1;
  return `${bar}.${beat}`;
}

/** Human label for an automation target (mirrors automation.ts laneLabel). */
function automationTargetLabel(doc: ProjectDocument, target: AutomationTarget): string {
  const owner = ownerNameOf(doc, target.trackId);
  if (target.kind === "trackGain") return `${owner} · Volume`;
  if (target.kind === "trackPan") return `${owner} · Pan`;
  if (target.kind === "fxParam") {
    const owner = doc.tracks.find((t) => t.id === target.trackId) ?? doc.returns.find((r) => r.id === target.trackId);
    const fx = owner?.effects.find((effect) => effect.id === target.fxId);
    return `${owner} · ${fx?.type ?? "fx"} · ${target.paramId}`;
  }
  return `${owner} · ${target.paramId}`;
}

/** Format an automation lane's points: all when ≤ 8, else head + range summary. */
function formatAutomationPoints(points: Array<{ tick: number; value: number }>): string {
  const tidy = (value: number): number => Math.round(value * 1e4) / 1e4;
  if (points.length === 0) return "no points";
  const rendered = points.map((point) => `${barBeat(point.tick)}=${tidy(point.value)}`);
  if (rendered.length <= 8) return rendered.join(", ");
  const values = points.map((point) => point.value);
  return `${rendered.slice(0, 4).join(", ")} … +${points.length - 4} more (values ${Math.min(...values)}..${Math.max(...values)})`;
}

/** kyx_state subject:automation — the lanes map + scene-curve summary. */
function automationSnapshot(doc: ProjectDocument, family: string | undefined): string {
  const wanted = family != null ? new RegExp(`\\b${family}\\b`, "i") : null;
  const lines: string[] = [];
  const lanes = doc.automation.filter((lane) => {
    if (wanted == null) return true;
    const owner = doc.tracks.find((t) => t.id === lane.target.trackId);
    return owner != null && (wanted.test(owner.name) || owner.kind === "drum");
  });
  if (lanes.length === 0) {
    lines.push(wanted != null ? `no automation lanes match family "${family}"` : "no automation lanes");
  }
  lanes.forEach((lane, index) => {
    const def = targetParamDef(doc, lane.target);
    const range = def ? `, range ${def.min}..${def.max}` : "";
    lines.push(
      `${index + 1}. ${automationTargetLabel(doc, lane.target)} (lane ${lane.id}) — ${lane.points.length} pt${lane.points.length === 1 ? "" : "s"}${range}: ${formatAutomationPoints(lane.points)}`,
    );
  });
  if (doc.sceneAutomation.length > 0) {
    const sceneName = (sceneId: string): string => doc.scenes.find((scene) => scene.id === sceneId)?.name ?? sceneId;
    const curves = doc.sceneAutomation
      .map(
        (curve) =>
          `${sceneName(curve.sceneId)} · ${automationTargetLabel(doc, curve.target)} (${curve.points.length}pt)`,
      )
      .join(", ");
    lines.push(
      `scene automation: ${doc.sceneAutomation.length} curve(s) — ${curves} (points are ticks relative to each scene's start)`,
    );
  }
  return lines.join("\n");
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
    // IDs + mixer values included so an AI that can SET gain/pan/mute/solo —
    // or address one exact track — can also READ them back; write-only
    // faders and family-only addressing would make it operate blind.
    return (
      doc.tracks
        .map((t) => {
          const bits: string[] = [`id=${t.id}`, t.kind];
          if (t.kind === "instrument") bits.push(`inst=${t.instrument}`);
          bits.push(`gain ${t.gain.toFixed(2)} (${(20 * Math.log10(Math.max(t.gain, 1e-4))).toFixed(1)} dB)`);
          bits.push(`pan ${t.pan.toFixed(2)}`);
          if (t.mute) bits.push("muted");
          if (t.solo) bits.push("solo");
          return `${t.name} (${bits.join(", ")})`;
        })
        .join("\n") || "no tracks"
    );
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
    // Silent truncation would hand the AI an incomplete map of the mix —
    // say how much was cut instead.
    if (lines.length > 8) return `${lines.slice(0, 8).join("\n")}\n… and ${lines.length - 8} more track(s)`;
    return lines.join("\n") || "no tracks";
  }
  if (subject === "sends") {
    // The full send routing map: the return buses (with their faders) and
    // every track's send level into each — the read half of the NL send
    // intents, so a "more reverb send" loop can VERIFY its landing.
    const lines: string[] = [];
    if (doc.returns.length === 0) {
      return "returns: none (no send buses exist — the NL send intents would refuse too)";
    }
    lines.push(
      `returns: ${doc.returns
        .map(
          (ret) =>
            `${ret.name} (id=${ret.id}, gain ${ret.gain.toFixed(2)}, fx: ${ret.effects.map((fx) => fx.type).join(", ") || "none"})`,
        )
        .join(" · ")}`,
    );
    const wanted = family != null ? new RegExp(`\\b${family}\\b`, "i") : null;
    const level = (value: number): number => Math.round(value * 1000) / 1000;
    for (const track of doc.tracks) {
      if (wanted != null && !wanted.test(track.name) && track.kind !== "drum") continue;
      const levels = doc.returns.map((ret) => `${ret.name} ${level(track.sends?.[ret.id] ?? 0)}`);
      lines.push(`${track.name} (id=${track.id}): ${levels.join(" · ")}`);
    }
    if (wanted == null && lines.length > 9) {
      return `${lines.slice(0, 9).join("\n")}\n… and ${lines.length - 9} more track(s) (filter with family)`;
    }
    return lines.join("\n");
  }
  if (subject === "automation") {
    return automationSnapshot(doc, family);
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

/** D4 gate, intent edition: natural-language phrasing must not bypass the
 * destructive-op consent flag. Mirrors the structured tools (tracks/sections
 * remove) — track removal (exact), scene removal (arrange), clip deletion,
 * FX-instance removal (effect) and the compound clauses carrying them. */
function routeIsDestructive(route: RoutedIntent): boolean {
  switch (route.kind) {
    case "exact":
      return route.plan.ops.some((op) => op.kind === "removeTrack");
    case "arrange":
      return route.ops.some((op) => op.op === "remove");
    case "clips":
      return route.ops.some((op) => op.op === "deleteClip");
    case "effectIntent":
      return route.intent.direction === "remove";
    case "compound":
      return route.parts.some(
        (part) =>
          (part.kind === "effect" && part.intent.direction === "remove") ||
          (part.kind === "exact" && part.plan.ops.some((op) => op.kind === "removeTrack")),
      );
    default:
      return false;
  }
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
  if (route.kind === "transport") {
    // Bare transport words ("stop", "loop on") — same dispatch as the
    // structured tool, including loop-range preservation.
    return dispatchTransport(ctx, route.action);
  }
  if (route.kind === "queryIntent") {
    // Read-only questions answered from the live doc — never a mutation.
    const q = route.intent;
    if (q.subject === "lastAction") {
      const labels = ctx.historyLabels();
      return {
        text: labels.length > 0 ? `last action: ${labels[labels.length - 1]}` : "no actions yet",
        mutated: false,
      };
    }
    const subject =
      q.subject === "tempo" ||
      q.subject === "key" ||
      q.subject === "tracks" ||
      q.subject === "markers" ||
      q.subject === "groove"
        ? q.subject
        : "fxChain";
    return {
      text: stateSnapshot(ctx.getDoc(), subject, "target" in q ? String(q.target) : undefined, () =>
        ctx.historyLabels(),
      ),
      mutated: false,
    };
  }
  if (route.kind === "undoIntent") {
    // Session control through the store hooks — the SAME guards as the
    // structured kyx_undo (mic pin + honest step counting).
    if (route.intent.kind === "undo" && ctx.isMicRecordingActive()) {
      return { text: "declined: a mic take is recording — stop it before undo", mutated: false };
    }
    let done = 0;
    for (let i = 0; i < route.intent.steps; i++) {
      const before = ctx.undoStackLength();
      if (route.intent.kind === "undo") ctx.undo();
      else ctx.redo();
      if (ctx.undoStackLength() === before) break;
      done += 1;
    }
    return { text: `${route.intent.kind} ×${done}`, mutated: done > 0 };
  }
  if (routeIsDestructive(route) && ctx.allowDestructive?.() !== true) return destructiveRefusal();

  // Route kinds whose executors need window-local state (audition players,
  // loudness render loop, mix brief/reference patches) or are UI state —
  // refuse HONESTLY instead of pretending nothing changed.
  if (
    route.kind === "loudness" ||
    route.kind === "mix" ||
    route.kind === "sectionProduction" ||
    route.kind === "sectionFlow" ||
    route.kind === "complaintIntent" ||
    route.kind === "select"
  ) {
    return {
      text: `"${route.kind}" requests run inside the KYX app (they need in-app auditioning/rendering) — not available over MCP v1`,
      mutated: false,
    };
  }

  try {
    const before = ctx.getDoc();
    const command = intentCommand(before, route);
    if (command == null) {
      return { text: "intent understood but nothing changed (already matches or no target)", mutated: false };
    }
    ctx.execute(command);
    const extra = route.kind === "production" ? ` — ${productionReadback(before, ctx.getDoc(), route.intent)}` : "";
    return { text: `${command.label}${extra} — verification: applied, one undo step in KYX`, mutated: true };
  } catch (error) {
    // The intent appliers throw on no-target / already-matches — surface as
    // an honest failure instead of letting it kill the relay round-trip.
    return { text: `intent failed: ${error instanceof Error ? error.message : String(error)}`, mutated: false };
  }
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
    case "compound":
      return applyCompoundIntent(doc, route.parts);
    case "production":
      return applyProductionIntentCommand(doc, route.intent);
    default:
      return null;
  }
}
