import type { ProjectDocument } from "../project-model/types";
import { isForeignWork, labelsRevertedBy } from "./attribution";
import { setMasterConfig } from "../commands/master";
import { hasMatchEqReference, referenceLoudnessTrim } from "../intent/match-eq";
import { topIntentMisses } from "../intent/failure-log";
import { planBlindPairGains, recordBlindAbTrial, resetBlindAbTrials, summarizeBlindAb } from "./blind-ab";
import type { Command } from "../commands/types";
import { routeIntentText, type RoutedIntent } from "../intent/route";
import { isCreativeBriefRoute } from "../intent/model-fallback-policy";
import { applyFaderIntent, applyTempoIntent } from "../intent/conversation";
import {
  applyBypassIntent,
  applyEffectIntent,
  applySendIntent,
  applyMixIntent,
  bypassReadback,
  effectReadback,
  EFFECT_KNOB,
  planMixProfile,
  type MixOverrides,
} from "../intent/mix";
import type { SongSectionSpec } from "../intent/song";
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
import { MCP_PLAYBOOK_TEXT, MCP_VOCAB_TEXT } from "./onboarding";
import { normalizeIntent } from "../intent/normalize";
import { resolveSceneTarget } from "../intent/arrangeWords";
import { inferPadRole } from "../ai/pad-roles";
import type { DrumTrack, InstrumentKind, Scene, Track, AutomationTarget, AutomationLane } from "../project-model/types";
import { getIntentModelProvider, tryModelRoute } from "../intent/model-resolver";
import { logIntentMiningEvent } from "../intent/failure-log";
import { formatRenderSummary } from "./render-summary";
import {
  applyPresetIntentCommand,
  FAMILY_INSTRUMENTS as PRESET_FAMILY_INSTRUMENTS,
  presetReadback,
  resolvePresetByName,
  type PresetTargetFamily,
} from "../intent/preset-intent";
import { FACTORY_PRESETS } from "../presets/factory";
import {
  addAutomationLane,
  addAutomationPoint,
  addToGroup,
  addNote,
  createGroupTrack,
  createReturnTrack,
  addMarker,
  addArrangementClip,
  applyExactIntentCommand,
  applyGenerationResultCommand,
  applyProductionIntentCommand,
  createDrumTrack,
  createInstrumentTrack,
  createScene,
  deleteArrangementClip,
  deleteAutomationPoint,
  deleteNote,
  deleteTrack,
  moveAutomationPoint,
  moveEffect,
  moveEffectToIndex,
  moveNote,
  deleteAudioClip,
  duplicateArrangementClip,
  moveArrangementClip,
  moveAudioClip,
  quantizePatternToGrid,
  quantizePatternToScale,
  removeAutomationLane,
  removeEffect,
  removeFromGroup,
  removeMarker,
  renameMarker,
  resizeArrangementClip,
  setActiveAudioTake,
  setNoteVelocity,
  setReturnGain,
  setActivePattern,
  setSceneIntensity,
  setSceneRole,
  setTrackSend,
  setEffectParam,
  setStepMeta,
  setStepVelocityCommand,
  setTrackParams,
  snapshot,
  toggleEffectBypass,
  splitAudioClipAtTick,
  updateAudioClip,
} from "../commands/commands";
import { isAutomationTargetValid, targetParamDef } from "../project-model/targets";
import { clampEffectParam, EFFECT_META, type EffectDefinitionMeta } from "../effects/definitions";
import { INSTRUMENT_DEFS } from "../instruments/registry";
import type { McpAudioContent, McpAudioPreviewArtifact } from "./audio-preview";

/**
 * KYX MCP — TOOL SURFACE (docs/INTENT-MCP-EXPANSION-PLAN.md Phase D).
 *
 * The tool surface exposes the intent engine + project state to an external
 * MCP client. The GOLDEN RULE: the MCP layer is a TRANSPORT, never a bypass —
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

/** JSON Schema (2020-12 subset) for a tool's structured result. */
export interface McpOutputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  /** true = extra keys allowed (structuredContent may carry more than declared). */
  additionalProperties?: boolean;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /**
   * MCP 2025-06-18+ `outputSchema`: declares the shape of `structuredContent`.
   * When set, every successful execution MUST return matching `data`; both
   * wire transports expose it as `structuredContent` and flag contract misses.
   */
  outputSchema?: McpOutputSchema;
}

/** kyx_meter - the live meter snapshot. */
const OUTPUT_METER: McpOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    master: { type: "object" },
    tracks: { type: "array", items: { type: "object" } },
  },
  required: ["master", "tracks"],
};
/** kyx_audio_preview - metadata twin (audio travels as a content block). */
const OUTPUT_AUDIO_PREVIEW: McpOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    bars: { type: "number" },
    durationSec: { type: "number" },
    sampleRate: { type: "number" },
    byteLength: { type: "number" },
    mimeType: { type: "string" },
  },
  required: ["bars", "durationSec", "sampleRate", "byteLength", "mimeType"],
};
/** kyx_loudness - measure (integratedLufs) or loop (before/after/trim). */
const OUTPUT_LOUDNESS: McpOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    integratedLufs: { type: "number" },
    measuredBefore: { type: "number" },
    measuredAfter: { type: ["number", "null"] },
    trimDb: { type: "number" },
    targetLufs: { type: "number" },
  },
};
/** kyx_render_summary - per-strip offline render evidence. */
const OUTPUT_RENDER_SUMMARY: McpOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    scope: { type: "string", enum: ["master", "tracks", "all"] },
    strips: { type: "array", items: { type: "object" } },
    master: { type: ["object", "null"] },
    referenceLufs: { type: "number" },
  },
  required: ["scope", "strips", "referenceLufs"],
};
/** kyx_diagnose_mix - attributed findings + suggested actions. */
const OUTPUT_DIAGNOSE_MIX: McpOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    scope: { type: "string" },
    referenceLufs: { type: "number" },
    master: { type: ["object", "null"] },
    strips: { type: "array", items: { type: "object" } },
    findings: { type: "array", items: { type: "object" } },
    attributions: { type: "array", items: { type: "string" } },
    suggestedActions: { type: "array", items: { type: "string" } },
  },
  required: ["scope", "strips", "findings", "suggestedActions"],
};
/** kyx_batch - per-call results + counts. */
const OUTPUT_BATCH: McpOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    results: { type: "array", items: { type: "object" } },
    mutations: { type: "number" },
    failures: { type: "number" },
    singleUndo: { type: "boolean" },
  },
  required: ["results", "mutations", "failures", "singleUndo"],
};
/** kyx_publish_gallery - the created gallery id + provenance. */
const OUTPUT_PUBLISH: McpOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    galleryId: { type: "string" },
    origin: { type: "string" },
    agent: { type: "string" },
  },
  required: ["galleryId", "origin", "agent"],
};
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
            "mixer",
            "sends",
            "pattern",
            "scenes",
            "history",
            "reference",
            "model-misses",
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
        allowForeign: {
          type: "boolean",
          description:
            "Attributed agents only: consent to revert work made by OTHERS (another agent or the human). Refused without it when the top of history is foreign work.",
        },
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
            "launchScene",
            "state",
          ],
        },
        bar: { type: "integer", minimum: 1, description: "For seek — 1-based destination bar" },
        scene: { type: "string", description: 'launchScene — scene NAME or ROLE (e.g. "drop", "chorus")' },
        index: {
          type: "integer",
          minimum: 1,
          description: "launchScene — 1-based index as kyx_state scenes lists them (alternative to scene)",
        },
        play: { type: "boolean", description: "launchScene — start playback after the jump (default true)" },
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
      "Bounce the current project: full mix (WAV 16/24/32-bit, MP3 320) or a STEMS zip " +
      "(stems: all | drums | bass | music — stem projects bypass the master chain, same as " +
      "the ExportPanel stem flow). sampleRate selects the render rate. The render runs in " +
      "the KYX window and the tool AWAITS it — the result carries the completion report " +
      "(duration, size). Render/generation calls get an extended 60 s MCP window; exceptionally " +
      "long jobs may still time out, while the download lands in the app.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["wav", "mp3"] },
        sampleRate: { type: "number", enum: [44100, 48000, 96000], description: "Render sample rate (default 44100)" },
        bitDepth: { type: "number", enum: [16, 24, 32], description: "WAV bit depth (default 16; ignored for mp3)" },
        stems: {
          type: "string",
          enum: ["all", "drums", "bass", "music"],
          description: "Render stem groups into one zip instead of the full mix",
        },
      },
      required: ["format"],
    },
  },
  {
    name: "kyx_audio_preview",
    description:
      "Audition the opening of the CURRENT project without changing it or " +
      "downloading a file. Returns a short stereo WAV as standard MCP audio " +
      "content so compatible agents can listen before suggesting or applying " +
      "edits. Defaults to 2 bars; previews are capped at 4 bars. This is a " +
      "quick listening pass, not a full-quality export.",
    inputSchema: {
      type: "object",
      properties: {
        bars: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "Opening bars to render (default 2, maximum 4)",
        },
      },
    },
    outputSchema: OUTPUT_AUDIO_PREVIEW,
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
      "flag them, reorder moves ONE instance through the chain (direction " +
      "or position). instance scopes remove/bypass/enable/reorder to the " +
      "Nth same-type instance. Effect types are the knob-mapped subset for " +
      "more/less — eq and other no-knob effects are refused there; use " +
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
        action: { type: "string", enum: ["more", "less", "remove", "bypass", "enable", "reorder"] },
        percent: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Relative step size for more/less, as % of the knob's range (default: fixed calibrated step)",
          instance: {
            type: "integer",
            minimum: 1,
            description:
              "1-based same-type instance — scopes remove/bypass/enable/reorder to ONE instance (default: all instances of the type)",
          },
          direction: {
            type: "string",
            enum: ["earlier", "later"],
            description: "For reorder — move the instance one slot toward the input (earlier) or output (later)",
          },
          position: { type: "integer", minimum: 1, description: "For reorder — 1-based final slot in the chain" },
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
        op: { type: "string", enum: ["add", "remove", "duplicate", "reorder", "resize", "intensity"] },
        intensity: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "op=intensity — target scene intensity 0..1",
        },
        scene: { type: "string", description: "op=intensity — scene name or role (also: index)" },
        index: {
          type: "integer",
          minimum: 1,
          description: "op=intensity — 1-based scene index (alternative to scene)",
        },
        value: { type: "number", minimum: 0, maximum: 1, description: "op=intensity — the target intensity 0..1" },
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
        op: { type: "string", enum: ["add", "remove", "rename"] },
        bar: { type: "integer", minimum: 1, description: "1-based bar" },
        name: { type: "string", description: "Optional marker name" },
      },
      required: ["op", "bar"],
    },
  },
  {
    name: "kyx_tracks",
    description:
      "Track CRUD + absolute mixer setters: add a drum or instrument " +
      "track, remove/rename by family or exact trackId (group tracks are " +
      "not addressable here — removing the last track is declined), or set " +
      "mixer values with verify-by-read: setGain (absolute gainDb −60..+3.5 " +
      "or linear gain 0..1.5), setPan (−1..1), setMute/setSolo (value " +
      "boolean). set* ops apply to every track the family resolves to.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "addDrum",
            "addInstrument",
            "loadPreset",
            "listPresets",
            "remove",
            "rename",
            "setGain",
            "setPan",
            "setMute",
            "setSolo",
          ],
        },
        presetName: {
          type: "string",
          description: 'loadPreset — factory preset name, fuzzy-matched (e.g. "Warm Sub")',
        },
        query: {
          type: "string",
          description: "listPresets — optional name/instrument filter",
        },
        family: {
          type: "string",
          enum: ["drums", "bass", "lead", "chords", "kick", "snare", "clap", "hat", "perc", "tom"],
          description: "Which family to touch — ignored when trackId is given",
        },
        trackId: {
          type: "string",
          description: "Exact track id (from kyx_state tracks) — overrides family",
        },
        instrument: {
          type: "string",
          enum: ["analog", "bass", "808", "keys", "pluck", "acid", "reese", "brass", "flute", "sampler"],
          description: "For addInstrument — the full kind catalog is in kyx_catalog subject:instruments",
        },
        name: { type: "string", description: "New name for rename" },
        gainDb: { type: "number", minimum: -60, maximum: 3.5, description: "For setGain — absolute fader value in dB" },
        gain: { type: "number", minimum: 0, maximum: 1.5, description: "For setGain — linear alternative to gainDb" },
        pan: { type: "number", minimum: -1, maximum: 1, description: "For setPan — −1 left, 0 center, 1 right" },
        value: { type: "boolean", description: "For setMute/setSolo — true = on" },
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
    name: "kyx_notes",
    description:
      "Melodic COMPOSITION on the active pattern (the melodic half kyx_steps " +
      "does not cover): list/add/move/delete notes, set velocity, quantize to " +
      "grid or key, transpose a family's whole line. Notes are addressed by " +
      "INDEX into the list response — call {op:'list'} first, indices are " +
      "positions in it. Every op is one undo step through the audited command " +
      "layer (pitch/velocity clamps, pattern-bounds fit).",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "add", "move", "delete", "setVelocity", "quantize", "transpose"],
        },
        family: {
          type: "string",
          enum: ["bass", "lead", "chords"],
          description: "Target melodic family (first matching track edits; default bass). Read-back names the track.",
        },
        pitch: { type: "integer", minimum: 0, maximum: 127, description: "MIDI pitch (add; move absolute)" },
        noteName: { type: "string", description: 'Alternative to pitch: "C3", "F#4", "Bb2" (add)' },
        index: { type: "integer", minimum: 0, description: "Position in the list response (move/delete/setVelocity)" },
        startBeat: {
          type: "number",
          minimum: 0,
          description: "Start in beats from pattern start (add; move absolute)",
        },
        durationBeats: { type: "number", minimum: 0.05, description: "Note length in beats (add, default 0.5)" },
        velocity: { type: "number", minimum: 0, maximum: 1, description: "add (default 0.8) / setVelocity" },
        pitchDelta: { type: "integer", minimum: -127, maximum: 127, description: "move relative semitones" },
        grid: {
          type: "string",
          enum: ["1/4", "1/8", "1/16", "1/32", "1/8T", "1/16T"],
          description: "quantize target grid",
        },
        key: { type: "string", description: 'quantize target scale, e.g. "C Major", "A Minor"' },
        semitones: { type: "integer", minimum: -127, maximum: 127, description: "transpose shift (non-zero)" },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_music",
    description:
      "Structured MUSICAL STATE: set tempo, set musical key, change the active " +
      "pattern's length, or transpose all melodic content. One op = ONE undo " +
      "step through the exact-intent executor (same clamps as the text layer).",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["setTempo", "setKey", "setPatternLength", "transposeAll"] },
        bpm: { type: "integer", minimum: 20, maximum: 300, description: "setTempo" },
        key: { type: "string", description: 'setKey — e.g. "C Major", "F# Minor", "Bb Minor"' },
        steps: { type: "integer", minimum: 16, maximum: 256, description: "setPatternLength (16 per bar)" },
        semitones: { type: "integer", minimum: -127, maximum: 127, description: "transposeAll shift (non-zero)" },
        target: { type: "string", description: 'transposeAll scope: track family or "all" (default all)' },
      },
      required: ["op"],
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
    outputSchema: OUTPUT_METER,
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
        op: { type: "string", enum: ["addPoint", "movePoint", "deletePoint", "clearLane", "removeLane"] },
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
          description: "1-based bar — position for addPoint, anchor for movePoint/deletePoint",
        },
        newBar: { type: "integer", minimum: 1, description: "For movePoint — 1-based destination bar" },
        newBeat: { type: "integer", minimum: 1, maximum: 4, description: "For movePoint — 1-based destination beat" },
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
  {
    name: "kyx_clips",
    description:
      "Arrangement AND audio clips: list scene clips (with ids + an audio " +
      "summary), audioList the track-lane waveforms in detail, or edit — " +
      "scene ops move/resize/duplicate/delete target the clip COVERING an " +
      "anchor bar (delete D4-gated); audio ops audioMove/audioSplit/" +
      "audioUpdate (gain, fadeIn, fadeOut, reverse, loop)/audioDelete (D4) " +
      "address a track (trackId or family) + the anchor bar its clip " +
      "covers. Values are native (gain linear, fades in seconds).",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "list",
            "move",
            "resize",
            "duplicate",
            "delete",
            "audioList",
            "audioMove",
            "audioSplit",
            "audioUpdate",
            "audioDelete",
          ],
        },
        bar: { type: "integer", minimum: 1, description: "1-based anchor bar — the clip covering it is the target" },
        toBar: { type: "integer", minimum: 1, description: "For move/audioMove — 1-based destination start bar" },
        bars: { type: "integer", minimum: 1, maximum: 64, description: "For resize — new length in bars" },
        trackId: { type: "string", description: "For audio ops — exact track id" },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "For audio ops — family alternative to trackId",
        },
        gain: { type: "number", minimum: 0, maximum: 2, description: "For audioUpdate — linear clip gain" },
        fadeIn: { type: "number", minimum: 0, description: "For audioUpdate — fade-in seconds" },
        fadeOut: { type: "number", minimum: 0, description: "For audioUpdate — fade-out seconds" },
        reverse: { type: "boolean", description: "For audioUpdate — play the clip backwards" },
        loop: { type: "boolean", description: "For audioUpdate — loop the trimmed content over the clip length" },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_batch",
    description:
      "Run up to 10 tool calls in ONE submitted batch: calls: [{tool, args}…" +
      "]. When the host supports undo frames, every mutation folds into a " +
      "SINGLE undo entry (the result reports which contract applied); each " +
      "call still returns its own read-back, and per-call failures never " +
      "abort the batch. Async tools (kyx_export, kyx_loudness) and nested " +
      "batches are refused — run those standalone.",
    inputSchema: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              tool: {
                type: "string",
                description: "One of the kyx_* tool names (not kyx_batch/kyx_export/kyx_loudness)",
              },
              args: { type: "object", description: "The tool's arguments object" },
            },
            required: ["tool"],
          },
        },
      },
      required: ["calls"],
    },
    outputSchema: OUTPUT_BATCH,
  },
  {
    name: "kyx_loudness",
    description:
      "Loudness loop (render-backed BS.1770): measure reports the CURRENT " +
      "mix's integrated LUFS read-only; match runs measure→trim→verify " +
      "toward an explicit targetDb (e.g. −14 for streaming) or a ±nudge in " +
      "the given direction, landing the trim on the master config in one " +
      "undo step. Runs in the KYX window; honestly refused where no render " +
      "context is bound.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["measure", "match"] },
        targetDb: {
          type: "number",
          minimum: -24,
          maximum: -6,
          description: "For match — explicit LUFS target (default: −14 ±nudge)",
        },
        direction: {
          type: "string",
          enum: ["louder", "quieter"],
          description: "For match without targetDb — nudge direction (default louder)",
        },
      },
      required: ["op"],
    },
    outputSchema: OUTPUT_LOUDNESS,
  },
  {
    name: "kyx_import_sfz",
    description:
      "Import the user's SFZ instrument library: an .sfz file plus its WAV " +
      "samples arrive as base64; KYX builds a multisample sampler mapping " +
      "(keyzones, velocity windows, per-sample roots from pitch_keycenter) " +
      "and applies it to a sampler track as ONE undoable step. The samples " +
      "persist in the user's library and play immediately. Send the whole " +
      "instrument in one call (decoded payload up to ~256 MB). Requires a " +
      "live KYX session with a sampler track (create one via the UI, or use " +
      "an existing sampler track id from kyx_state).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Instrument display name, e.g. 'My Cello'" },
        sfzBase64: { type: "string", description: "The .sfz file content, base64" },
        trackId: { type: "string", description: "Target sampler track id (from kyx_state tracks)" },
        samples: {
          type: "array",
          description: "The WAV files the SFZ references (16/24-bit PCM stereo or mono)",
          items: {
            type: "object",
            properties: {
              fileName: { type: "string", description: "File name EXACTLY as the SFZ sample= paths reference it" },
              base64: { type: "string", description: "WAV bytes, base64" },
            },
            required: ["fileName", "base64"],
          },
        },
      },
      required: ["name", "sfzBase64", "trackId", "samples"],
    },
  },
  {
    name: "kyx_publish_gallery",
    description:
      "Publish the CURRENT KYX project to the public beat gallery as " +
      "AGENT-MADE (shows with the robot badge + your agent name in the " +
      "feed). The beat is a share-code entry: instant embed player, no " +
      "audio upload. Call when the user asks to share/publish/showcase the " +
      "beat you built together. Requires a live KYX session (web/desktop); " +
      "standalone servers refuse honestly.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Beat title for the gallery card (max 64 chars)" },
        author: { type: "string", description: "Credit line (default: 'KYX agent')" },
        tags: { type: "array", items: { type: "string" }, description: "Up to 6 free-form tags" },
        agent: {
          type: "string",
          description: "Your agent display name, e.g. 'Claude (MCP)' (default: 'unknown agent')",
        },
      },
      required: ["title"],
    },
    outputSchema: OUTPUT_PUBLISH,
  },
  {
    name: "kyx_render_summary",
    description:
      "THE AGENT'S EARS — offline-render the current project and report per-strip " +
      "evidence: integrated LUFS (BS.1770-4), peak dBFS, crest factor " +
      "(peak−RMS = punchiness) and duration, plus the master vs the −14 " +
      "streaming reference and relative deltas against the loudest strip. " +
      "Use before/after mix moves so decisions cite numbers, not vibes. " +
      "Slow (N+1 offline renders); render-bound transports only.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all", "tracks", "master"],
          description: "all = strips + master (default); tracks/master limit the pass",
        },
      },
    },
    outputSchema: OUTPUT_RENDER_SUMMARY,
  },
  {
    name: "kyx_diagnose_mix",
    description:
      "THE AGENT'S EARS v2 — a MIX DIAGNOSIS, not just numbers: offline-renders " +
      "the master and every strip, runs mix-health analysis (band shares, " +
      "clipping, crest collapse, stereo correlation, BS.1770 loudness) and " +
      "returns attributed findings (who owns the low end, which strip is " +
      "buried, which is over-compressed, sub collision) each mapped to a fix " +
      "you can call (kyx_tracks setGain, kyx_fx more/less, kyx_loudness " +
      "match). Apply the suggested moves, re-run this tool, compare — the " +
      "full diagnose→fix→verify loop. Slower than kyx_render_summary " +
      "(N+1 renders + analysis); render-bound transports only.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all", "master", "tracks"],
          description:
            "all = master + per-strip attribution (default); master = master findings only (1 render); tracks = strips only, master render skipped (N renders — the fast verify loop after a strip-level fix)",
        },
      },
    },
    outputSchema: OUTPUT_DIAGNOSE_MIX,
  },
  {
    name: "kyx_checkpoint",
    description:
      "Named project checkpoints for agent experiments: save the current " +
      "state, list checkpoints with how many steps have passed since each, " +
      "restore one (ONE undo step back to the pre-restore state), or delete. " +
      "Session-scoped (last 8 kept); destructive ops auto-save " +
      "auto-before-<tool> checkpoints when allowed.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["save", "list", "diff", "restore", "delete"] },
        name: { type: "string", description: "Checkpoint name (required for diff/restore/delete)" },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_mix",
    description:
      "PRODUCER MOVE - apply the measured genre mix profile in ONE undo " +
      "step: tone tilt, punch, sidechain pump and space decisions derived " +
      "from the genre/mood, refined by explicit overrides. Returns the " +
      "decision summary as the read-back.",
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
        mood: { type: "string", description: "Optional mood (dark, chill, warm, aggressive...)" },
        energy: { type: "number", minimum: 0, maximum: 1 },
        tone: { type: "string", enum: ["dark", "bright", "warm", "cold"] },
        reverb: { type: "string", enum: ["more", "less", "huge"] },
        punch: { type: "string", enum: ["more", "less"] },
        pump: { type: "string", enum: ["on", "off"] },
      },
      required: ["genre"],
    },
  },
  {
    name: "kyx_arrange",
    description:
      "PRODUCER MOVE - lay out the genre song form as scenes + clips + " +
      "cue markers (intro/build/drop/... with per-section intensity) in ONE " +
      "undo step. Refused when the arrangement already has clips: use " +
      "kyx_sections/kyx_clips for surgical edits on an existing arrangement.",
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
        energy: { type: "number", minimum: 0, maximum: 1 },
        length: {
          type: "string",
          enum: ["short", "standard", "radio", "extended", "epic"],
          description: "Scales the form core cycles (default: genre standard)",
        },
      },
      required: ["genre"],
    },
  },
  {
    name: "kyx_song",
    description:
      "PRODUCER MOVE, MEGA - build the WHOLE track in one call: generate " +
      "the genre song form (patterns per section), lay out scenes + clips " +
      "+ markers, and apply the measured mix profile - all folded into ONE " +
      "undo step. Optional loudness target adds a render-backed trim as a " +
      "second undo step (needs the render context). Slow: full generation, " +
      "uses the extended 60 s MCP call window.",
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
        mood: { type: "string", description: "Optional mood (dark, chill, warm, aggressive...)" },
        energy: { type: "number", minimum: 0, maximum: 1 },
        length: {
          type: "string",
          enum: ["short", "standard", "radio", "extended", "epic"],
          description: "Scales the form core cycles (default: genre standard)",
        },
        mix: {
          type: "boolean",
          description: "Apply the measured mix profile after the song lands (default true)",
        },
        loudness: {
          type: "number",
          description: "Target integrated LUFS - adds a render-backed loudness trim (second undo step)",
        },
      },
      required: ["genre"],
    },
  },
  {
    name: "kyx_routing",
    description:
      "The group routing graph AND send buses: list every track's destination (its " +
      "group or master) with a structured envelope, create a group bus, route " +
      "tracks into it (addToGroup) or back to master (removeFromGroup). The " +
      "model is FLAT — one group per track, no group-into-group — so routing " +
      "cycles are impossible by construction. setSend/setReturnGain/ " +
      "createReturn cover the send-bus mixer.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "createGroup", "addToGroup", "removeFromGroup", "setSend", "setReturnGain", "createReturn"],
        },
        trackId: { type: "string", description: "Exact track id — overrides family when present" },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Family alternative to trackId (applies to every resolved track)",
        },
        groupId: { type: "string", description: "For addToGroup — the group track id (op:list)" },
        groupName: { type: "string", description: "For addToGroup — group name alternative to groupId" },
        name: {
          type: "string",
          description: "For createGroup/createReturn — optional name (default: Group N / Return N)",
        },
        returnId: { type: "string", description: "For setSend/setReturnGain — the return bus id (op:list)" },
        returnName: { type: "string", description: "Return bus name alternative to returnId" },
        level: {
          type: "number",
          minimum: 0,
          maximum: 1.5,
          description: "For setSend — linear send level (1.0 = unity)",
        },
        gain: { type: "number", minimum: 0, maximum: 1.5, description: "For setReturnGain — linear return fader" },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_takes",
    description:
      "Take groups (comp workflow): list every group with its track, the " +
      "ACTIVE take and the alternatives (clips per take), or activate a " +
      "take — the comp pick that decides which alternative is heard. " +
      "Reversible (one undo step); the domain validates the take has clips. " +
      "deleteTake (destructive-gated) removes every clip of one take.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "activate", "deleteTake"] },
        groupId: { type: "string", description: "For activate/deleteTake — the take group id (op:list)" },
        takeId: { type: "string", description: "The take id to activate or delete" },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_blind_ab",
    description:
      "Blind A/B listening loop: derive symmetric LUFS level-matching gains " +
      "for two mix variants (so neither side is privileged), record the " +
      "human listener's forced-choice trials, and get the two-sided binomial " +
      "verdict (chance 0.5) over the accumulated evidence. The agent plans " +
      "and counts; the human listens.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["plan", "record", "verdict", "reset"] },
        lufsA: { type: "number", description: "For plan — measured integrated LUFS of variant A" },
        lufsB: { type: "number", description: "For plan — measured integrated LUFS of variant B" },
        lane: { type: "string", description: "Trial lane name (record/verdict), e.g. 'tilt-vs-flat'" },
        xWas: { type: "string", enum: ["A", "B"], description: "For record — which side was X" },
        answer: { type: "string", enum: ["A", "B"], description: "For record — what the listener answered" },
        reactionMs: { type: "integer", description: "For record — milliseconds from first playback" },
      },
      required: ["op"],
    },
  },
];

/** The kyx_export request: full-mix bounce or a stems zip, with render options. */
export interface McpExportRequest {
  format: "wav" | "mp3";
  sampleRate?: number;
  bitDepth?: 16 | 24 | 32;
  stems?: "all" | "drums" | "bass" | "music";
}

export type McpAudioPreviewRequest = { bars: number };

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
  export?: (
    request: McpExportRequest,
  ) => Promise<
    string | { report: string; health: unknown; fix: { tiltDb: number; masterGain: number; label: string } | null }
  >;
  /** Render a short, attached audio preview for listening MCP clients. */
  audioPreview?: (request: McpAudioPreviewRequest) => Promise<McpAudioPreviewArtifact>;
  /** C6 attribution: which automation surface drives this context (absent
   * for the human working the UI directly / headless tests). */
  agentId?: string;
  /** Present when a live engine can be metered (kyx_meter). Null/absent →
   * the tool refuses honestly instead of inventing numbers. */
  meters?: () => McpMeterSnapshot | null;
  /**
   * D4 escalation: destructive MCP ops (removing tracks/sections/FX) run
   * ONLY while the user's allow flag is on. Absent/false → honest refusal.
   */
  allowDestructive?: () => boolean;
  /**
   * Sample import capability (kyx_import_sfz): present when a live session
   * can decode + persist WAVs into the user library and apply the multisample
   * mapping to a sampler track. Absent → honest refusal (headless servers).
   */
  importSamples?: (input: {
    name: string;
    sfzBase64: string;
    trackId: string;
    samples: Array<{ fileName: string; base64: string }>;
  }) => Promise<
    | {
        ok: true;
        report: {
          trackId: string;
          fallbackSampleId: string;
          layers: number;
          imported: number;
          missing: Array<{ sample: string; fileName: string }>;
          skipped: Array<{ sample: string; reason: string }>;
        };
      }
    | { ok: false; error: string }
  >;
  /**
   * P2 transaction support (kyx_batch): fold every mutation executed between
   * begin and end into ONE undo entry. Absent → batch still runs, but each
   * call is its own undo step (the result reports which contract applied).
   */
  beginUndoFrame?: (label?: string) => void;
  endUndoFrame?: () => void;
  /**
   * P2 loudness loop hooks (kyx_loudness). measure reads the CURRENT mix's
   * integrated LUFS (render-backed); apply runs the measure→trim→verify
   * loop toward an explicit target (or a ±nudge) and returns the
   * UNEXECUTED command so the mutation still flows through ctx.execute.
   * Absent → honest refusal (headless contexts).
   */
  measureLoudness?: () => Promise<{ integrated: number; measured: boolean }>;
  applyLoudness?: (input: { targetDb?: number; direction: "louder" | "quieter" }) => Promise<
    | {
        ok: true;
        command: Command;
        report: { measuredBefore: number; measuredAfter: number | null; trim: number; target: number };
      }
    | { ok: false; error: string }
  >;
  /**
   * AGENT-MADE gallery publishing (kyx_publish_gallery). The HOST encodes
   * the current project into a gallery share code and POSTs it with
   * origin:"agent" — the tool only validates input and reports back.
   * Absent → honest refusal (standalone/headless servers cannot publish).
   */
  shareToGallery?: (input: { title: string; author: string; tags: string[]; agent: string }) => Promise<{ id: string }>;
  /**
   * THE AGENT'S EARS (kyx_render_summary): offline-render the project and
   * report per-strip evidence (LUFS/peak/crest/duration) + the master vs
   * the streaming reference. Absent → honest refusal (headless contexts).
   */
  renderSummary?: (request: {
    scope?: "master" | "tracks" | "all";
  }) => Promise<import("./render-summary").RenderSummaryData>;

  /**
   * THE AGENT'S EARS v2 (kyx_diagnose_mix): offline-render master + strips,
   * run mix-health analysis, return attributed findings with callable fix
   * suggestions. Absent → honest refusal (headless contexts), same as
   * renderSummary.
   */
  diagnoseMix?: (request: {
    scope?: "master" | "tracks" | "all";
  }) => Promise<import("./mix-diagnosis").MixDiagnosisData>;
}

export interface McpToolResult {
  /** Text returned to the MCP client (verification read-back). */
  text: string;
  /** true when the project document changed (undoable). */
  mutated: boolean;
  /** Explicit failure marker — honored by the transports so a caught error
   * never masquerades as a successful call (e.g. relay crash guard). */
  isError?: boolean;
  /** Optional machine-readable envelope alongside the text — structured
   * results for programmatic agents (P2). JSON-serializable or absent. */
  data?: unknown;
  /** Optional standard MCP audio attachment (base64 encoded). */
  audio?: McpAudioContent;
}

const TICKS_PER_BAR = 4 * 480;

/** D4 escalation gate — every destructive op routes through this refusal. */
function destructiveRefusal(): McpToolResult {
  return {
    text:
      "declined: destructive MCP ops are locked — the user must allow them " +
      "in the KYX MCP chip (undoable edits still work)",
    mutated: false,
    isError: true,
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
/** LIVE PERFORMANCE — resolve a scene the way kyx_state scenes lists it:
 * 1-based index, exact/lowercase name, or role ("drop", "chorus", …).
 * Returns the scene or an honest refusal string. */
function resolveMcpScene(doc: ProjectDocument, record: Record<string, unknown>): Scene | string {
  if (doc.scenes.length === 0) return "no scenes in the arrangement";
  if (typeof record.sceneId === "string" && record.sceneId.trim() !== "") {
    const byId = doc.scenes.find((candidate) => candidate.id === record.sceneId);
    if (byId) return byId;
  }
  if (typeof record.index === "number" && Number.isFinite(record.index)) {
    const scene = doc.scenes[Math.floor(record.index) - 1];
    if (scene) return scene;
    return `no scene at index ${record.index} — scenes are 1..${doc.scenes.length} (kyx_state {subject:'scenes'})`;
  }
  const label = typeof record.scene === "string" ? record.scene.trim().toLowerCase() : "";
  if (label !== "") {
    const byName = doc.scenes.find((candidate) => candidate.name.toLowerCase() === label);
    if (byName) return byName;
    const byRole = doc.scenes.find((candidate) => candidate.role != null && (candidate.role as string) === label);
    if (byRole) return byRole;
    const loose = doc.scenes.find(
      (candidate) => candidate.name.toLowerCase().includes(label) || (candidate.role as string | null) === label,
    );
    if (loose) return loose;
    return `no scene matches "${record.scene}" — kyx_state {subject:'scenes'} lists them`;
  }
  return "needs scene (name or role) or index (1-based, as kyx_state scenes lists them)";
}

/** Launch a scene live: seek the transport to the scene's earliest clip and
 * (by default) play. Transport = runtime state, not document state — like
 * seek, this never enters the undo stack. */
function transportLaunchScene(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  const transport = ctx.transport;
  if (transport.seek == null) {
    return {
      text: "scene launch is not available over this MCP transport (no seek-capable transport bound)",
      mutated: false,
    };
  }
  const scene = resolveMcpScene(ctx.getDoc(), record);
  if (typeof scene === "string") return { text: scene, mutated: false };
  const clips = ctx
    .getDoc()
    .arrangement.clips.filter((clip) => clip.sceneId === scene.id)
    .sort((a, b) => a.startBar - b.startBar);
  const startBar = clips[0]?.startBar ?? null;
  if (startBar === null) {
    return { text: `scene "${scene.name}" has no arrangement clip to launch`, mutated: false };
  }
  // Method CALL — extracting seek into a local would drop `this` and crash
  // the real Transport (same unbound-playing_ lesson as transportSeek).
  transport.seek(startBar * TICKS_PER_BAR);
  const play = record.play !== false;
  if (play) transport.play();
  return {
    text: `launched "${scene.name}"${scene.role ? ` (${scene.role})` : ""} at bar ${startBar + 1}${play ? " — playing" : " (transport stopped)"} · intensity ${Math.round(scene.intensity * 100)}%`,
    mutated: false,
    data: { sceneId: scene.id, name: scene.name, role: scene.role ?? null, startBar, playing: play },
  };
}

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

// ── kyx_notes helpers — pitch naming for agents (say "C3", read "C3") ───────

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** "C3" / "F#4" / "Bb2" (ASCII b only) → MIDI 0..127, or null. */
function noteNameToMidi(name: string): number | null {
  const match = /^([A-Ga-g])([#b]?)(-?\d{1,2})$/.exec(name.trim());
  if (!match) return null;
  const base = NOTE_NAMES.findIndex((n) => n.toLowerCase() === match[1].toLowerCase());
  if (base < 0) return null;
  const semis = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  const octave = Number(match[3]);
  const midi = (octave + 1) * 12 + base + semis;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/** MIDI 0..127 → "C3" form (C-1 = 0). */
function midiToNoteName(midi: number): string {
  const clamped = Math.max(0, Math.min(127, Math.round(midi)));
  return `${NOTE_NAMES[clamped % 12]}${Math.floor(clamped / 12) - 1}`;
}

/** Accepts pitch (number 0..127) or noteName; null when neither is usable. */
function resolvePitch(pitch: unknown, noteName: unknown): number | null {
  if (typeof pitch === "number" && Number.isFinite(pitch) && pitch >= 0 && pitch <= 127) {
    return Math.round(pitch);
  }
  if (typeof noteName === "string") {
    const midi = noteNameToMidi(noteName);
    if (midi !== null) return midi;
  }
  return null;
}

// ── kyx_state mixer view — the structured twin of the "mixer" snapshot ──────

function mixerSnapshotData(doc: ProjectDocument): Record<string, unknown> {
  const db1 = (gain: number): number => Math.round(20 * Math.log10(Math.max(gain, 1e-4)) * 10) / 10;
  return {
    master: doc.master
      ? {
          gainDb: db1(doc.master.masterGain),
          ...(doc.master.loudnessTrimDb !== undefined ? { loudnessTrimDb: doc.master.loudnessTrimDb } : {}),
        }
      : null,
    returns: doc.returns.map((ret) => ({ id: ret.id, name: ret.name, gainDb: db1(ret.gain) })),
    tracks: (doc.tracks.filter((t) => t.kind !== "group") as ProjectDocument["tracks"]).map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      ...(t.kind === "instrument" ? { instrument: t.instrument, presetId: t.presetId ?? null } : {}),
      gainDb: db1(t.gain),
      pan: Math.round(t.pan * 100) / 100,
      mute: t.mute,
      solo: t.solo,
      ...((t.kind === "drum" || t.kind === "instrument") && t.groupId ? { groupId: t.groupId } : {}),
      effects: t.effects.map((fx) => ({ type: fx.type, bypassed: fx.bypassed === true })),
      sends: Object.fromEntries(doc.returns.map((ret) => [ret.id, Math.round((t.sends?.[ret.id] ?? 0) * 1000) / 1000])),
    })),
  };
}

export async function executeMcpTool(ctx: McpToolContext, name: string, args: unknown): Promise<McpToolResult> {
  // THE INTENT MODEL SERVES MCP TOO — the deterministic layer answers
  // first; exactly the asks it cannot execute (generation asks, parser
  // declines) fall to the registered local model, the same fallback point
  // the IntentPanel uses. Registration self-heals (a panel-less session
  // warms the bridge on first ask). Every hit/miss/clarify feeds the
  // failure-mining log — agent asks grow the next corpus round.
  if (name === "kyx_intent") {
    const instruction = String(
      (args != null && typeof args === "object" ? (args as Record<string, unknown>).instruction : "") ?? "",
    );
    const trimmed = instruction.trim();
    if (trimmed !== "") {
      const deterministic = routeIntentText(trimmed, ctx.getDoc());
      if (
        !isCreativeBriefRoute(trimmed, deterministic) &&
        (deterministic.kind === "pattern" || deterministic.kind === "clarify")
      ) {
        if (getIntentModelProvider() == null) {
          const ollama = await import("../intent/model-ollama");
          await ollama.ensureOllamaIntentProvider().catch(() => null);
        }
        const modelRoute = await tryModelRoute(trimmed, ctx.getDoc(), deterministic);
        if (modelRoute != null) {
          logIntentMiningEvent({ prompt: trimmed, outcome: "model-hit", routeKind: modelRoute.kind });
          const result = executeRoutedIntent(ctx, modelRoute);
          return { ...result, text: `🤖 local model — ${result.text}` };
        }
        if (deterministic.kind === "clarify") {
          logIntentMiningEvent({ prompt: trimmed, outcome: "clarify", reason: deterministic.reason });
        } else {
          logIntentMiningEvent({ prompt: trimmed, outcome: "model-miss" });
        }
      }
    }
    // no model hit — fall through to the deterministic intent case below
  }
  const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "kyx_state": {
      const subject = String(record.subject ?? "overview");
      const text = stateSnapshot(ctx.getDoc(), subject, record.family as string | undefined, () => ctx.historyLabels());
      // the MIXER view rides with a machine-readable twin: the same board as
      // structured rows, so a mixing agent can diff numbers without parsing
      if (subject === "mixer") return { text, mutated: false, data: mixerSnapshotData(ctx.getDoc()) };
      return { text, mutated: false };
    }
    case "kyx_undo": {
      const action = record.action === "redo" ? "redo" : "undo";
      const steps = Math.max(1, Math.min(20, Number(record.steps ?? 1)));
      if (ctx.isMicRecordingActive()) {
        return { text: "declined: a mic take is recording — stop it before undo", mutated: false };
      }
      // C6 attribution: name what this undo/redo reverts and flag when an
      // agent reverts work that was not its own (another agent's prefix, or
      // the human's unlabeled edits). Global LIFO stays the truth — this
      // makes the interleaving legible instead of hidden.
      const reverted = labelsRevertedBy(ctx, action, steps);
      // C6.2-light guard: an ATTRIBUTED agent must consent before undoing
      // foreign work (another agent's prefix, or the human's unlabeled
      // edits). Human/local contexts revert freely — that is their normal
      // mode. The consent is one explicit argument, not a remembered flag.
      if (
        action === "undo" &&
        ctx.agentId != null &&
        !record.allowForeign &&
        reverted.length > 0 &&
        reverted.some((label) => isForeignWork(label, ctx.agentId))
      ) {
        const top = reverted[0];
        return {
          text:
            `declined: the top of history is foreign work (${top}) — ` +
            "pass allowForeign: true to revert it anyway (the human may have made these edits)",
          mutated: false,
          isError: true,
        };
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
      let text = `${action} ×${done}`;
      if (done > 0 && reverted.length > 0) {
        const shown = reverted
          .slice(0, done)
          .map((label) => `"${label}"`)
          .join(", ");
        text += ` — reverts: ${shown}`;
      }
      if (done > 0 && action === "undo" && record.allowForeign) {
        text += " (foreign work reverted by explicit consent)";
      }
      return { text, mutated: done > 0 };
    }
    case "kyx_transport": {
      const action = String(record.action ?? "");
      if (action === "seek") return transportSeek(ctx, record);
      if (action === "launchScene") return transportLaunchScene(ctx, record);
      if (action === "loopRegion") return transportLoopRegion(ctx, record);
      if (action === "state") {
        const t = ctx.transport;
        const position =
          typeof t.position === "number" && Number.isFinite(t.position) ? Math.max(0, Math.round(t.position)) : null;
        const data = {
          positionTick: position,
          bar: position != null ? Math.floor(position / TICKS_PER_BAR) + 1 : null,
          beat: position != null ? Math.floor((position % TICKS_PER_BAR) / (TICKS_PER_BAR / 4)) + 1 : null,
          playing: typeof t.playing === "boolean" ? t.playing : null,
          paused: typeof t.paused === "boolean" ? t.paused : null,
          loop: {
            enabled: typeof t.loopEnabled === "boolean" ? t.loopEnabled : null,
            startBar:
              t.loopEnabled && typeof t.loopStart === "number" ? Math.floor(t.loopStart / TICKS_PER_BAR) + 1 : null,
            endBar:
              t.loopEnabled && typeof t.loopEnd === "number" && t.loopEnd > (t.loopStart ?? 0)
                ? Math.ceil(t.loopEnd / TICKS_PER_BAR)
                : null,
          },
          metronome: typeof t.metronome === "boolean" ? t.metronome : null,
        };
        return { text: describeTransport(t), mutated: false, data };
      }
      return dispatchTransport(ctx, action);
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
      if (action === "reorder") {
        // Per-instance chain reorder: direction moves ±1, position is the
        // 1-based final slot. Uses the domain's moveEffect/moveEffectToIndex.
        const reorderIndex = Math.max(1, Math.round(Number(record.instance ?? 1)));
        const direction = record.direction === "earlier" ? -1 : record.direction === "later" ? 1 : 0;
        const position = typeof record.position === "number" ? Math.round(record.position) : null;
        if (direction === 0 && position == null) {
          return { text: "reorder needs direction (earlier | later) or position (1-based final slot)", mutated: false };
        }
        try {
          const before = ctx.getDoc();
          const targetIds = targets.length === 1 ? tracksInFamily(before, targets[0]) : targets;
          let next = before;
          const parts: string[] = [];
          let moved = 0;
          for (const targetId of targetIds) {
            const track = next.tracks.find((t) => t.id === targetId);
            if (!track) {
              parts.push(`${targetId}: no such track`);
              continue;
            }
            const instances = track.effects.filter((fx) => fx.type === effect);
            if (instances.length === 0) {
              parts.push(`${track.name}: no ${effect} instance`);
              continue;
            }
            if (instances.length < reorderIndex) {
              parts.push(
                `${track.name}: ${effect} instance #${reorderIndex} does not exist (chain has ${instances.length})`,
              );
              continue;
            }
            const fx = instances[reorderIndex - 1];
            const movedFxId = fx.id;
            if (position != null) {
              next = moveEffectToIndex(next, track.id, movedFxId, position - 1).execute(next);
            } else {
              next = moveEffect(next, track.id, movedFxId, direction as -1 | 1).execute(next);
            }
            moved += 1;
            const chain = next.tracks
              .find((t) => t.id === track.id)!
              .effects.map((f, index) => `${index + 1}.${f.type}${f.id === movedFxId ? "*" : ""}`)
              .join(" ");
            parts.push(`${track.name}: ${chain}`);
          }
          if (moved === 0) {
            return { text: `reorder failed — ${parts.join("; ")}`, mutated: false, isError: true };
          }
          ctx.execute(snapshot("mcpFxReorder", `MCP: reorder ${effect}#${reorderIndex}`, before, next));
          return { text: `reorder ${effect}#${reorderIndex}: ${parts.join("; ")} — one undo step`, mutated: true };
        } catch (error) {
          return {
            text: `fx op failed: ${error instanceof Error ? error.message : String(error)}`,
            mutated: false,
            isError: true,
          };
        }
      }
      const perInstance = record.instance != null && action !== "more" && action !== "less";
      const instanceWanted = Math.max(1, Math.round(Number(record.instance ?? 1)));
      if (action === "remove" && ctx.allowDestructive?.() !== true) return destructiveRefusal();
      // eq (and any knob-less effect) has no single "primary knob" — never
      // pretend: point at kyx_plugin_param instead of throwing deep inside
      // the applier. remove/bypass/reorder do NOT need a knob.
      if (!perInstance && action !== "remove" && !(effect in EFFECT_KNOB)) {
        return {
          text:
            `fx op failed: "${effect}" has no single primary knob for more/less — ` +
            `list its parameters with kyx_catalog subject:effect, then set them via kyx_plugin_param`,
          mutated: false,
        };
      }
      if (perInstance) {
        // Instance-scoped remove/bypass/enable: the Nth same-type instance
        // per targeted track, folded into ONE undo snapshot.
        try {
          const before = ctx.getDoc();
          const targetIds = targets.length === 1 ? tracksInFamily(before, targets[0]) : targets;
          let next = before;
          const parts: string[] = [];
          let touched = 0;
          for (const targetId of targetIds) {
            const track = before.tracks.find((t) => t.id === targetId);
            if (!track) {
              parts.push(`${targetId}: no such track`);
              continue;
            }
            const instances = track.effects.filter((fx) => fx.type === effect);
            if (instances.length === 0) {
              parts.push(`${track.name}: no ${effect} instance`);
              continue;
            }
            if (instances.length < instanceWanted) {
              parts.push(
                `${track.name}: ${effect} instance #${instanceWanted} does not exist (chain has ${instances.length})`,
              );
              continue;
            }
            const fx = instances[instanceWanted - 1];
            if (action === "remove") {
              next = removeEffect(next, track.id, fx.id).execute(next);
              parts.push(`${track.name}: removed ${effect}#${instanceWanted}`);
              touched += 1;
            } else {
              const bypassed = action === "bypass";
              if (fx.bypassed === bypassed) {
                parts.push(
                  `${track.name}: ${effect}#${instanceWanted} already ${action === "bypass" ? "bypassed" : "enabled"}`,
                );
                continue;
              }
              next = toggleEffectBypass(next, track.id, fx.id).execute(next);
              parts.push(`${track.name}: ${effect}#${instanceWanted} ${bypassed ? "bypassed" : "enabled"}`);
              touched += 1;
            }
          }
          if (touched === 0) {
            return { text: `nothing changed — ${parts.join("; ")}`, mutated: false };
          }
          ctx.execute(snapshot("mcpFxInstance", `MCP: ${action} ${effect}#${instanceWanted}`, before, next));
          return { text: `${parts.join("; ")} — one undo step`, mutated: true };
        } catch (error) {
          return {
            text: `fx op failed: ${error instanceof Error ? error.message : String(error)}`,
            mutated: false,
            isError: true,
          };
        }
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
          isError: true,
        };
      }
    }
    case "kyx_sections": {
      if (String(record.op ?? "") === "remove" && !destructiveAllowedWithCheckpoint(ctx, "kyx_sections"))
        return destructiveRefusal();
      if (String(record.op ?? "") === "intensity") {
        // LIVE intensity ride on one scene — a document mutation (scene
        // automation), so it IS undoable, one snapshot per call.
        const scene = resolveMcpScene(ctx.getDoc(), record);
        if (typeof scene === "string") return { text: scene, mutated: false };
        const value = typeof record.value === "number" ? record.value : NaN;
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          return { text: "intensity needs value 0..1 (e.g. 0.85 for the drop)", mutated: false };
        }
        ctx.execute(setSceneIntensity(ctx.getDoc(), scene.id, value));
        return {
          text: `scene "${scene.name}" intensity → ${Math.round(value * 100)}% (one undo step)`,
          mutated: true,
        };
      }
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
          isError: true,
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
      if (op === "rename") {
        const name = typeof record.name === "string" ? record.name.trim().slice(0, 40) : "";
        if (name === "") return { text: "rename needs a name (bar anchors the nearest match)", mutated: false };
        const previous = nearest.name;
        ctx.execute(renameMarker(ctx.getDoc(), nearest.id, name));
        return { text: `renamed marker "${previous}" → "${name}" — one undo step`, mutated: true };
      }
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
      if (op === "loadPreset") {
        // FACTORY PRESET onto a family — the same resolve + folds-over-every-
        // track path the text layer uses ("load the Warm Sub preset on the
        // bass"), one undo snapshot, per-track verification read-back.
        const presetName = typeof record.presetName === "string" ? record.presetName.trim() : "";
        if (presetName === "") return { text: "loadPreset needs presetName", mutated: false };
        const family = (typeof record.family === "string" ? record.family : "bass") as PresetTargetFamily;
        // resolvePresetByName expects a PRE-normalized want (deaccent + lowercase) —
        // passing the raw name made every ask miss and fall to suggestions
        const want = presetName.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/s+/g, " ").trim().toLowerCase();
        const resolved = resolvePresetByName(presetName, want, family);
        if (!resolved.ok) {
          return {
            text: `unknown preset "${presetName}" for ${family} — did you mean: ${resolved.suggestions.join(", ")}? (kyx_tracks {op:"listPresets", family} lists the factory bank)`,
            mutated: false,
          };
        }
        try {
          ctx.execute(applyPresetIntentCommand(ctx.getDoc(), resolved.intent));
          const after = ctx.getDoc();
          const appliedTrack = after.tracks.find(
            (t) => t.kind === "instrument" && t.presetId === resolved.intent.preset.id,
          );
          return {
            text: `preset "${resolved.intent.preset.name}" applied to ${family} — ${presetReadback(after, resolved.intent)}`,
            mutated: true,
            data: {
              presetId: resolved.intent.preset.id,
              matchedBy: resolved.intent.matchedBy,
              trackId: appliedTrack?.id ?? null,
            },
          };
        } catch (error) {
          return {
            text: `preset failed: ${error instanceof Error ? error.message : String(error)}`,
            mutated: false,
            isError: true,
          };
        }
      }
      if (op === "listPresets") {
        // Discovery for loadPreset — factory names that FIT the family's
        // instruments first, then the rest (capped for a readable tool call).
        const family = (typeof record.family === "string" ? record.family : "bass") as PresetTargetFamily;
        const query = typeof record.query === "string" ? record.query.toLowerCase() : "";
        const fitting: string[] = [];
        const rest: string[] = [];
        for (const preset of FACTORY_PRESETS) {
          const line = `${preset.name} (${preset.instrument})`;
          const fits = PRESET_FAMILY_INSTRUMENTS[family]?.has(preset.instrument) ?? false;
          if (query !== "" && !line.toLowerCase().includes(query)) continue;
          (fits ? fitting : rest).push(line);
        }
        const shown = [...fitting, ...rest].slice(0, 25);
        return {
          text: `${FACTORY_PRESETS.length} factory presets; for ${family}${query !== "" ? ` matching "${query}"` : ""}: ${shown.join("; ")}${fitting.length + rest.length > 25 ? " …" : ""}`,
          mutated: false,
          data: { family, fitting: fitting.length, total: FACTORY_PRESETS.length },
        };
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
        if (!destructiveAllowedWithCheckpoint(ctx, "kyx_tracks")) return destructiveRefusal();
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
      if (op === "setGain" || op === "setPan" || op === "setMute" || op === "setSolo") {
        // Structured absolute mixer setters — the read-back reports every
        // landed value so the AI can verify the fader really moved.
        const ids = explicitTrackIds(ctx.getDoc(), record);
        if (typeof ids === "string") return { text: ids, mutated: false };
        if (ids.length === 0)
          return { text: `no track matches family "${String(record.family ?? "")}"`, mutated: false };
        const before = ctx.getDoc();
        let next = before;
        const parts: string[] = [];
        if (op === "setGain") {
          const dbValue = typeof record.gainDb === "number" ? record.gainDb : undefined;
          const linearValue = typeof record.gain === "number" ? record.gain : undefined;
          if (dbValue === undefined && linearValue === undefined) {
            return { text: "setGain needs gainDb (−60..+3.5, absolute) or gain (linear 0..1.5)", mutated: false };
          }
          let linear: number;
          if (dbValue !== undefined) {
            if (!Number.isFinite(dbValue)) return { text: "gainDb must be a finite number of dB", mutated: false };
            const clampedDb = Math.min(3.5, Math.max(-60, dbValue));
            linear = Math.min(1.5, Math.max(0, 10 ** (clampedDb / 20)));
          } else {
            if (!Number.isFinite(linearValue!))
              return { text: "gain must be a finite linear value (0..1.5)", mutated: false };
            linear = Math.min(1.5, Math.max(0, linearValue!));
          }
          for (const id of ids) next = setTrackParams(next, id, { gain: linear }).execute(next);
          for (const id of ids) {
            const track = next.tracks.find((t) => t.id === id)!;
            parts.push(
              `${track.name}: gain ${track.gain.toFixed(3)} (${(20 * Math.log10(Math.max(track.gain, 1e-4))).toFixed(1)} dB)`,
            );
          }
        } else if (op === "setPan") {
          const pan = Number(record.pan);
          if (!Number.isFinite(pan))
            return { text: "setPan needs pan in −1..1 (−1 left, 0 center, 1 right)", mutated: false };
          const clamped = Math.min(1, Math.max(-1, pan));
          for (const id of ids) next = setTrackParams(next, id, { pan: clamped }).execute(next);
          for (const id of ids) {
            const track = next.tracks.find((t) => t.id === id)!;
            const side = track.pan < -0.001 ? "L" : track.pan > 0.001 ? "R" : "C";
            parts.push(`${track.name}: pan ${track.pan.toFixed(2)} (${side})`);
          }
        } else {
          const value = record.value === true;
          const prop = op === "setMute" ? ("mute" as const) : ("solo" as const);
          for (const id of ids) next = setTrackParams(next, id, { [prop]: value }).execute(next);
          for (const id of ids) {
            const track = next.tracks.find((t) => t.id === id)!;
            parts.push(`${track.name}: ${prop} ${track[prop] ? "on" : "off"}`);
          }
        }
        if (next === before) {
          return { text: `nothing changed — ${parts.join("; ") || "values already match"}`, mutated: false };
        }
        ctx.execute(snapshot("mcpMixer", `MCP: ${op} on ${ids.length} track(s)`, before, next));
        return { text: `${parts.join("; ")}${ids.length > 1 ? " (one undo step)" : ""}`, mutated: true };
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
    case "kyx_clips":
      return executeClipsTool(ctx, record);
    case "kyx_routing":
      return executeRoutingTool(ctx, record);
    case "kyx_takes":
      return executeTakesTool(ctx, record);
    case "kyx_batch":
      return executeBatchTool(ctx, record);
    case "kyx_meter": {
      if (ctx.meters == null) {
        return {
          text: "metering is not available over this MCP transport (no live engine bound) — start KYX with an audio context",
          mutated: false,
          isError: true,
        };
      }
      const snapshotMeters = ctx.meters();
      if (snapshotMeters == null) {
        return {
          text: "engine is not running (no audio context) — nothing to meter yet",
          mutated: false,
          isError: true,
        };
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
      return { text: lines.join("\n"), mutated: false, data: snapshotMeters };
    }
    case "kyx_mix":
      return executeMixTool(ctx, record);
    case "kyx_notes": {
      // MELODIC COMPOSITION — the half of the DAW kyx_steps does not cover.
      // Notes are addressed by INDEX into the kyx_notes list response (stable
      // within a call; list again after edits). One op = one undo step via
      // the audited command layer (clamps, pattern-bounds fit included).
      const record = args as Record<string, unknown>;
      const family = typeof record.family === "string" ? record.family : "bass";
      // agents may target by explicit trackId; family is the friendly default
      const ids = explicitTrackIds(ctx.getDoc(), { ...(record as Record<string, unknown>), family });
      if (typeof ids === "string") return { text: ids, mutated: false };
      if (ids.length === 0) return { text: `no track matches family "${family}"`, mutated: false };
      const trackId = ids[0];
      const track = ctx.getDoc().tracks.find((t) => t.id === trackId);
      const notesOf = (): { id: string; pitch: number; start: number; duration: number; velocity: number }[] =>
        ctx.getDoc().patterns.find((p) => p.id === ctx.getDoc().activePatternId)?.notes?.[trackId] ?? [];
      const op = String(record.op ?? "");
      const beat = (ticks: number): string => (ticks / 480).toFixed(2).replace(/\.?0+$/, "");
      const describe = (
        note: { pitch: number; start: number; duration: number; velocity: number },
        index: number,
      ): string =>
        `#${index} ${midiToNoteName(note.pitch)} @${beat(note.start)}b ×${beat(note.duration)}b v${note.velocity.toFixed(2)}`;

      if (op === "list") {
        const notes = notesOf();
        if (notes.length === 0)
          return { text: `track "${track?.name ?? trackId}" (${family}): no notes`, mutated: false };
        const head = notes.slice(0, 40).map(describe).join("; ");
        const tail = notes.length > 40 ? ` …+${notes.length - 40} more` : "";
        return {
          text: `track "${track?.name ?? trackId}" (${family}), ${notes.length} notes: ${head}${tail}`,
          mutated: false,
          data: { trackId, count: notes.length },
        };
      }
      if (op === "add") {
        const pitch = resolvePitch(record.pitch, typeof record.noteName === "string" ? record.noteName : undefined);
        if (pitch === null) return { text: 'add needs pitch (0..127) or noteName ("C3", "F#4")', mutated: false };
        const startBeat =
          typeof record.startBeat === "number" && Number.isFinite(record.startBeat) ? record.startBeat : 0;
        const durationBeats =
          typeof record.durationBeats === "number" && Number.isFinite(record.durationBeats)
            ? record.durationBeats
            : 0.5;
        const velocity = typeof record.velocity === "number" ? record.velocity : 0.8;
        const before = notesOf().length;
        ctx.execute(
          addNote(ctx.getDoc(), trackId, {
            pitch,
            start: Math.round(startBeat * 480),
            duration: Math.max(1, Math.round(durationBeats * 480)),
            velocity,
          }),
        );
        const after = notesOf();
        const added = after[after.length - 1];
        return {
          text: `added ${midiToNoteName(added?.pitch ?? pitch)} @${beat(added?.start ?? 0)}b ×${beat(added?.duration ?? 0)}b — ${track?.name ?? trackId} now has ${after.length} notes (was ${before})`,
          mutated: true,
        };
      }
      const index = typeof record.index === "number" ? Math.floor(record.index) : -1;
      const target = index >= 0 ? notesOf()[index] : undefined;
      if ((op === "move" || op === "delete" || op === "setVelocity") && !target) {
        return {
          text: `no note at index ${record.index} — call kyx_notes {op:"list"} first; indices are positions in that response`,
          mutated: false,
        };
      }
      if (op === "move") {
        const start = typeof record.startBeat === "number" ? Math.round(record.startBeat * 480) : undefined;
        const pitchDelta = typeof record.pitchDelta === "number" ? Math.round(record.pitchDelta) : undefined;
        const newPitch = typeof record.pitch === "number" ? Math.round(record.pitch) : undefined;
        if (start === undefined && pitchDelta === undefined && newPitch === undefined) {
          return { text: "move needs startBeat and/or pitch, or pitchDelta (semitones)", mutated: false };
        }
        ctx.execute(
          moveNote(ctx.getDoc(), trackId, target!.id, {
            ...(start !== undefined ? { start } : {}),
            ...(newPitch !== undefined
              ? { pitch: newPitch }
              : pitchDelta !== undefined
                ? { pitch: target!.pitch + pitchDelta }
                : {}),
          }),
        );
        const moved = notesOf()[index];
        return { text: `moved: now ${describe(moved, index)}`, mutated: true };
      }
      if (op === "delete") {
        ctx.execute(deleteNote(ctx.getDoc(), trackId, target!.id));
        return { text: `deleted ${describe(target!, index)} — ${notesOf().length} notes left`, mutated: true };
      }
      if (op === "setVelocity") {
        const velocity = typeof record.velocity === "number" ? record.velocity : NaN;
        if (!Number.isFinite(velocity)) return { text: "setVelocity needs velocity 0..1", mutated: false };
        ctx.execute(setNoteVelocity(ctx.getDoc(), trackId, target!.id, velocity));
        return { text: `velocity: ${describe(notesOf()[index], index)}`, mutated: true };
      }
      if (op === "quantize") {
        const key = typeof record.key === "string" ? record.key : null;
        const gridName = typeof record.grid === "string" ? record.grid : null;
        const gridTicks: Record<string, number> = {
          "1/4": 480,
          "1/8": 240,
          "1/16": 120,
          "1/32": 60,
          "1/8T": 160,
          "1/16T": 80,
        };
        if (key) {
          ctx.execute(quantizePatternToScale(ctx.getDoc(), ctx.getDoc().activePatternId, key as never));
          return {
            text: `quantized to the ${key} scale — ${notesOf().length} notes on ${track?.name ?? trackId}`,
            mutated: true,
          };
        }
        if (gridName && gridTicks[gridName] !== undefined) {
          ctx.execute(quantizePatternToGrid(ctx.getDoc(), ctx.getDoc().activePatternId, gridTicks[gridName]));
          return {
            text: `quantized to ${gridName} grid — ${notesOf().length} notes on ${track?.name ?? trackId}`,
            mutated: true,
          };
        }
        return {
          text: 'quantize needs grid ("1/4"|"1/8"|"1/16"|"1/32"|"1/8T"|"1/16T") or key ("C Major", "A Minor", …)',
          mutated: false,
        };
      }
      if (op === "transpose") {
        const semitones = typeof record.semitones === "number" ? Math.round(record.semitones) : NaN;
        if (!Number.isFinite(semitones) || semitones === 0) {
          return { text: "transpose needs semitones (non-zero, e.g. −3 or +5)", mutated: false };
        }
        for (const note of notesOf()) {
          ctx.execute(moveNote(ctx.getDoc(), trackId, note.id, { pitch: note.pitch + semitones }));
        }
        return {
          text: `transposed ${notesOf().length} notes by ${semitones > 0 ? "+" : ""}${semitones} st — use ONE undo to revert the whole shift`,
          mutated: true,
        };
      }
      return {
        text: "unknown op — kyx_notes ops: list | add | move | delete | setVelocity | quantize | transpose",
        mutated: false,
      };
    }
    case "kyx_music": {
      // STRUCTURED MUSICAL STATE — tempo, key, pattern length, global
      // transpose. One op = ONE undo step through the exact-intent executor
      // (the same clamps the text layer uses).
      const record = args as Record<string, unknown>;
      const op = String(record.op ?? "");
      const plan = (ops: { kind: string; [key: string]: unknown }[]): { label: string; ops: never[] } => ({
        label: "MCP music",
        ops: ops as never[],
      });
      if (op === "setTempo") {
        const bpm = typeof record.bpm === "number" ? Math.round(record.bpm) : NaN;
        if (!Number.isFinite(bpm)) return { text: "setTempo needs bpm (20..300)", mutated: false };
        ctx.execute(applyExactIntentCommand(ctx.getDoc(), plan([{ kind: "tempo", bpm }])));
        return { text: `tempo is now ${ctx.getDoc().bpm} BPM`, mutated: true };
      }
      if (op === "setKey") {
        const key = typeof record.key === "string" ? record.key : "";
        ctx.execute(applyExactIntentCommand(ctx.getDoc(), plan([{ kind: "key", key }])));
        return { text: `key is now ${ctx.getDoc().key}`, mutated: true };
      }
      if (op === "setPatternLength") {
        const steps = typeof record.steps === "number" ? Math.round(record.steps) : NaN;
        if (!Number.isFinite(steps)) return { text: "setPatternLength needs steps (16..256)", mutated: false };
        ctx.execute(applyExactIntentCommand(ctx.getDoc(), plan([{ kind: "patternLength", steps }])));
        const active = ctx.getDoc().patterns.find((p) => p.id === ctx.getDoc().activePatternId);
        return { text: `active pattern is now ${active?.stepCount ?? "?"} steps`, mutated: true };
      }
      if (op === "transposeAll") {
        const semitones = typeof record.semitones === "number" ? Math.round(record.semitones) : NaN;
        const target = typeof record.target === "string" ? record.target : "all";
        if (!Number.isFinite(semitones) || semitones === 0) {
          return {
            text: 'transposeAll needs semitones (non-zero) and optional target (family or "all")',
            mutated: false,
          };
        }
        ctx.execute(applyExactIntentCommand(ctx.getDoc(), plan([{ kind: "transpose", target, semitones }])));
        return {
          text: `transposed ${target} by ${semitones > 0 ? "+" : ""}${semitones} semitones — one undo step`,
          mutated: true,
        };
      }
      return {
        text: "unknown op — kyx_music ops: setTempo | setKey | setPatternLength | transposeAll",
        mutated: false,
      };
    }
    case "kyx_checkpoint":
      return executeCheckpointTool(ctx, record);
    case "__kyx_resource":
      // Hidden transport channel — the servers expose resources/list from
      // MCP_RESOURCES and route resources/read here, so every transport
      // (desktop IPC, web relay) reuses ONE live reader.
      return readMcpResource(ctx, String(record.uri ?? ""));
    case "kyx_export": {
      const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      if (ctx.export == null) {
        return {
          text: "export is not available over this MCP transport — use the KYX export panel",
          mutated: false,
        };
      }
      const format = exportFormatOf(record);
      const request: McpExportRequest = {
        format,
        ...(record.sampleRate === 44100 || record.sampleRate === 48000 || record.sampleRate === 96000
          ? { sampleRate: record.sampleRate }
          : {}),
        ...(record.bitDepth === 16 || record.bitDepth === 24 || record.bitDepth === 32
          ? { bitDepth: record.bitDepth }
          : {}),
        ...(typeof record.stems === "string" && ["all", "drums", "bass", "music"].includes(record.stems)
          ? { stems: record.stems as McpExportRequest["stems"] }
          : {}),
      };
      try {
        const exportResult = await ctx.export(request);
        const exportReport = typeof exportResult === "string" ? exportResult : exportResult.report;
        const exportFix =
          typeof exportResult === "object" && exportResult != null && "fix" in exportResult
            ? (exportResult.fix as { tiltDb: number; masterGain: number; label: string } | null)
            : null;
        let fixNote = "";
        let mutated = false;
        // Export → MIX FIX → re-export macro (autofix): the health
        // analysis flagged a mechanically-safe problem AND the agent asked
        // for the fix — apply it as ONE undo step, re-export to VERIFY
        // the numbers actually moved.
        if (record.autofix === true && exportFix != null) {
          ctx.execute(
            setMasterConfig(ctx.getDoc(), {
              ...(exportFix.tiltDb !== 0 ? { tiltDb: -exportFix.tiltDb } : {}),
              ...(exportFix.masterGain !== 1 ? { masterGain: exportFix.masterGain } : {}),
            }),
          );
          mutated = true;
          try {
            const reResult = await ctx.export(request);
            const reReport = typeof reResult === "string" ? reResult : reResult.report;
            const reCheck = /MIX CHECK[^—]*/.exec(reReport)?.[0]?.trim() ?? "MIX CHECK";
            fixNote = ` — fix applied (${exportFix.label}), re-exported: ${reCheck}`;
          } catch {
            fixNote = ` — fix applied (${exportFix.label}), re-export failed (verify manually)`;
          }
        } else if (record.autofix === true && exportFix == null) {
          fixNote = " — no mechanical fix needed (or none is safe to auto-apply)";
        }
        return {
          text: `export ${format.toUpperCase()} complete — ${exportReport}${fixNote}`,
          mutated,
        };
      } catch (error) {
        return {
          text: `export failed: ${error instanceof Error ? error.message : String(error)}`,
          mutated: false,
          isError: true,
        };
      }
    }
    case "kyx_audio_preview": {
      const rawBars = record.bars;
      if (rawBars != null && (!Number.isInteger(rawBars) || Number(rawBars) < 1 || Number(rawBars) > 4)) {
        return { text: "audio preview bars must be an integer from 1 to 4", mutated: false, isError: true };
      }
      if (ctx.audioPreview == null) {
        return {
          text: "audio preview is not available over this MCP transport — use the KYX export panel",
          mutated: false,
          isError: true,
        };
      }
      const bars = rawBars == null ? 2 : Number(rawBars);
      try {
        const preview = await ctx.audioPreview({ bars });
        return {
          text: `audio preview ready — ${preview.bars} bar(s), ${preview.durationSec.toFixed(1)} s, ${preview.sampleRate} Hz, ${(preview.byteLength / 1024).toFixed(0)} KiB. Listen to the attached audio content.`,
          mutated: false,
          audio: preview.audio,
          data: {
            bars: preview.bars,
            durationSec: preview.durationSec,
            sampleRate: preview.sampleRate,
            byteLength: preview.byteLength,
            mimeType: preview.audio.mimeType,
          },
        };
      } catch (error) {
        return {
          text: `audio preview failed: ${error instanceof Error ? error.message : String(error)}`,
          mutated: false,
          isError: true,
        };
      }
    }
    case "kyx_loudness": {
      const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const op = String(record.op ?? "measure");
      if (op === "measure") {
        if (ctx.measureLoudness == null) {
          return {
            text: "loudness measurement is not available over this MCP transport (no render context bound)",
            mutated: false,
            isError: true,
          };
        }
        try {
          const reading = await ctx.measureLoudness();
          if (!reading.measured) {
            return {
              text: "could not measure loudness — the render was too quiet or empty",
              mutated: false,
              isError: true,
            };
          }
          return {
            text: `current mix: ${reading.integrated.toFixed(1)} LUFS integrated (render-backed BS.1770)`,
            mutated: false,
            data: { integratedLufs: reading.integrated },
          };
        } catch (error) {
          return {
            text: `loudness render failed: ${error instanceof Error ? error.message : String(error)}`,
            mutated: false,
            isError: true,
          };
        }
      }
      if (ctx.applyLoudness == null) {
        return {
          text: "the loudness loop is not available over this MCP transport (no render context bound)",
          mutated: false,
          isError: true,
        };
      }
      const direction = record.direction === "quieter" ? ("quieter" as const) : ("louder" as const);
      const targetDb =
        typeof record.targetDb === "number" && Number.isFinite(record.targetDb) ? record.targetDb : undefined;
      try {
        const outcome = await ctx.applyLoudness({ direction, ...(targetDb !== undefined ? { targetDb } : {}) });
        if (!outcome.ok) return { text: outcome.error, mutated: false, isError: true };
        // The hook returns the UNEXECUTED command so the mutation still flows
        // through this context's executor (same store, same undo semantics).
        ctx.execute(outcome.command);
        const r = outcome.report;
        return {
          text: `loudness: ${r.measuredBefore} → ${r.measuredAfter ?? "?"} LUFS (trim ${r.trim >= 0 ? "+" : ""}${r.trim} dB toward ${r.target}) — one undo step`,
          mutated: true,
          data: {
            measuredBefore: r.measuredBefore,
            measuredAfter: r.measuredAfter,
            trimDb: r.trim,
            targetLufs: r.target,
          },
        };
      } catch (error) {
        return {
          text: `loudness loop failed: ${error instanceof Error ? error.message : String(error)}`,
          mutated: false,
          isError: true,
        };
      }
    }
    case "kyx_import_sfz": {
      if (ctx.importSamples == null) {
        return {
          text: "sample import is not available over this transport — import SFZ libraries from a live KYX session (web or desktop)",
          mutated: false,
        };
      }
      const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const sfzBase64 = typeof record.sfzBase64 === "string" ? record.sfzBase64 : "";
      const trackId = typeof record.trackId === "string" ? record.trackId : "";
      const samples = Array.isArray(record.samples)
        ? record.samples.filter(
            (s): s is { fileName: string; base64: string } =>
              s != null &&
              typeof s === "object" &&
              typeof (s as Record<string, unknown>).fileName === "string" &&
              typeof (s as Record<string, unknown>).base64 === "string",
          )
        : [];
      if (name === "" || sfzBase64 === "" || trackId === "" || samples.length === 0) {
        return {
          text:
            "kyx_import_sfz needs name, sfzBase64, trackId and at least one sample — " + "list tracks via kyx_state",
          mutated: false,
        };
      }
      let result: Awaited<ReturnType<NonNullable<McpToolContext["importSamples"]>>>;
      try {
        result = await ctx.importSamples({ name, sfzBase64, trackId, samples });
      } catch (error) {
        return {
          text: `SFZ import failed: ${error instanceof Error ? error.message : String(error)}`,
          mutated: false,
          isError: true,
        };
      }
      if (!result.ok) {
        return { text: `SFZ import failed: ${result.error}`, mutated: false, isError: true };
      }
      const r = result.report;
      return {
        text:
          `Imported "${name}": ${r.imported} samples → ${r.layers} velocity/keyzone layers on track ${r.trackId} ` +
          `(fallback sample ${r.fallbackSampleId}). ` +
          (r.missing.length > 0
            ? `MISSING from the import: ${r.missing.map((m) => m.fileName).join(", ")} — those zones stay silent.`
            : "All SFZ regions resolved."),
        mutated: true,
      };
    }
    case "kyx_publish_gallery": {
      const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      if (ctx.shareToGallery == null) {
        return {
          text: "gallery publishing is not available over this MCP transport — publish from a live KYX session (web or desktop)",
          mutated: false,
          isError: true,
        };
      }
      const title = typeof record.title === "string" ? record.title.trim() : "";
      if (!title || title.length > 64) {
        return { text: "title is required (max 64 chars)", mutated: false, isError: true };
      }
      const author =
        typeof record.author === "string" && record.author.trim() ? record.author.trim().slice(0, 32) : "KYX agent";
      const tags = Array.isArray(record.tags)
        ? record.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").slice(0, 6)
        : [];
      const agent =
        typeof record.agent === "string" && record.agent.trim() ? record.agent.trim().slice(0, 32) : "unknown agent";
      try {
        const { id } = await ctx.shareToGallery({ title, author, tags, agent });
        return {
          text: `published to the gallery as AGENT-MADE: "${title}" (id ${id}, agent ${agent}) — it shows with the robot badge in the gallery feed`,
          mutated: false,
          data: { galleryId: id, origin: "agent", agent },
        };
      } catch (error) {
        return {
          text: `gallery publish failed: ${error instanceof Error ? error.message : String(error)}`,
          mutated: false,
          isError: true,
        };
      }
    }
    case "kyx_arrange": {
      return executeArrangeTool(ctx, (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>);
    }
    case "kyx_song": {
      const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const genre = String(record.genre ?? "");
      if (!MIX_GENRES.includes(genre as (typeof MIX_GENRES)[number])) {
        return { text: `unknown genre "${genre}" - one of: ${MIX_GENRES.join(", ")}`, mutated: false, isError: true };
      }
      const doc = ctx.getDoc();
      if (doc.arrangement.clips.length > 0) {
        return {
          text:
            "arrangement already has clips - kyx_song builds a WHOLE track; " +
            "use kyx_sections / kyx_clips for surgical edits, or clear the arrangement first",
          mutated: false,
          isError: true,
        };
      }
      const spec = normalizeIntent({
        genre: genre as never,
        ...(typeof record.mood === "string" && record.mood.trim() !== "" ? { mood: record.mood.trim() } : {}),
        ...(typeof record.energy === "number" ? { energy: record.energy } : {}),
      });
      const lengthKind = ["short", "standard", "radio", "extended", "epic"].find((kind) => kind === record.length);
      const length =
        lengthKind != null
          ? { kind: lengthKind as "short" | "standard" | "radio" | "extended" | "epic", label: lengthKind }
          : null;
      const wantMix = record.mix !== false;
      try {
        const { applySongCommand, buildSong } = await import("../intent/song");
        const build = await buildSong(doc, spec, { length, yieldBetweenSections: false });
        let next = applySongCommand(doc, build).execute(doc);
        let mixDecisions = 0;
        if (wantMix) {
          try {
            const profile = planMixProfile(spec);
            if (profile.decisions.length > 0) {
              next = applyMixIntent(next, profile).execute(next);
              mixDecisions = profile.decisions.length;
            }
          } catch {
            // already at the profile - the song still lands
          }
        }
        const totalBars = build.sections.reduce((sum, section) => sum + section.bars, 0);
        ctx.execute(
          snapshot(
            "mcpSong",
            `MCP: song '${genre}' (${build.sections.length} sections, ${totalBars} bars${mixDecisions > 0 ? `, mixed (${mixDecisions})` : ""})`,
            doc,
            next,
          ),
        );
        const loudnessTarget =
          typeof record.loudness === "number" && Number.isFinite(record.loudness) ? record.loudness : null;
        let loudnessLine = "";
        if (loudnessTarget != null) {
          if (ctx.measureLoudness == null || ctx.applyLoudness == null) {
            loudnessLine = " | loudness skipped: no render context bound";
          } else {
            const reading = await ctx.measureLoudness();
            if (reading.measured) {
              const direction = reading.integrated < loudnessTarget ? ("louder" as const) : ("quieter" as const);
              const outcome = await ctx.applyLoudness({ direction, targetDb: loudnessTarget });
              if (outcome.ok) {
                ctx.execute(outcome.command);
                loudnessLine = ` | loudness ${outcome.report.measuredBefore} -> ${outcome.report.measuredAfter ?? "?"} LUFS (second undo step)`;
              } else {
                loudnessLine = ` | loudness skipped: ${outcome.error}`;
              }
            } else {
              loudnessLine = " | loudness skipped: render too quiet to measure";
            }
          }
        }
        return {
          text: `song '${genre}' landed: ${build.sections.length} sections, ${totalBars} bars${mixDecisions > 0 ? `, mix profile (${mixDecisions} decisions)` : ", mix skipped"} - song+mix is ONE undo step${loudnessLine}`,
          mutated: true,
        };
      } catch (error) {
        return {
          text: `song build failed: ${error instanceof Error ? error.message : String(error)}`,
          mutated: false,
          isError: true,
        };
      }
    }
    case "kyx_render_summary": {
      // THE AGENT'S EARS: offline render → per-strip LUFS/peak/crest + master
      // vs the streaming reference. Evidence for mixing decisions — numbers,
      // never vibes. Render-bound transport only; refusal is honest elsewhere.
      const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      if (ctx.renderSummary == null) {
        return {
          text: "render summary is not available over this MCP transport (no render context bound) — use kyx_meter for live levels",
          mutated: false,
          isError: true,
        };
      }
      const scope = record.scope === "master" || record.scope === "tracks" ? record.scope : "all";
      try {
        const data = await ctx.renderSummary({ scope });
        return { text: formatRenderSummary(data), mutated: false, data };
      } catch (error) {
        return {
          text: `render summary failed: ${error instanceof Error ? error.message : String(error)}`,
          mutated: false,
          isError: true,
        };
      }
    }
    case "kyx_diagnose_mix": {
      // EARS v2: the INTERPRETATION layer on top of the render evidence —
      // attributed findings + callable fixes, so an agent can run the loop
      // diagnose → fix → re-diagnose without a human ear in the middle.
      const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      if (ctx.diagnoseMix == null) {
        return {
          text: "mix diagnosis is not available over this MCP transport (no render context bound) — use kyx_render_summary for numbers only",
          mutated: false,
          isError: true,
        };
      }
      const scope = record.scope === "master" || record.scope === "tracks" ? record.scope : "all";
      try {
        // Lazy module: the diagnosis layer (analysis + formatting) stays off
        // the eager DAW graph — it loads on the first diagnose call.
        const { formatMixDiagnosis } = await import("./mix-diagnosis");
        const data = await ctx.diagnoseMix({ scope });
        return { text: formatMixDiagnosis(data), mutated: false, data };
      } catch (error) {
        return {
          text: `mix diagnosis failed: ${error instanceof Error ? error.message : String(error)}`,
          mutated: false,
          isError: true,
        };
      }
    }
    case "kyx_blind_ab": {
      // IN-APP BLIND A/B (P4 completion): level-matched comparison planning
      // + a binomial verdict over accumulated listening trials. The agent
      // prepares statistically honest comparisons; the HUMAN still listens.
      const op = String(record.op ?? "plan");
      if (op === "plan") {
        const lufsA = typeof record.lufsA === "number" ? record.lufsA : null;
        const lufsB = typeof record.lufsB === "number" ? record.lufsB : null;
        const plan = planBlindPairGains(lufsA, lufsB);
        return {
          text: `${plan.note} — apply these playback gains before the comparison so neither side is privileged`,
          mutated: false,
          data: { gains: plan.gains },
        };
      }
      if (op === "record") {
        if (record.xWas !== "A" && record.xWas !== "B") {
          return { text: "trial needs xWas: A|B (which side was X)", mutated: false, isError: true };
        }
        if (record.answer !== "A" && record.answer !== "B") {
          return { text: "trial needs answer: A|B (what the listener picked)", mutated: false, isError: true };
        }
        const entry = recordBlindAbTrial({
          lane: String(record.lane ?? "default"),
          xWas: record.xWas,
          answer: record.answer,
          ...(typeof record.reactionMs === "number" ? { reactionMs: record.reactionMs } : {}),
        });
        return {
          text: `trial recorded: ${entry.correct ? "correct" : "incorrect"} (lane "${entry.lane}")`,
          mutated: false,
        };
      }
      if (op === "verdict") {
        const summary = summarizeBlindAb(String(record.lane ?? "default"));
        if (summary == null) {
          return {
            text: "no trials recorded for this lane yet — record trials with op:record (the human listens, you count)",
            mutated: false,
          };
        }
        return {
          text: `blind A/B "${summary.lane}": ${summary.correct}/${summary.total} correct (p = ${summary.pValue.toFixed(4)}${summary.hastyExcluded > 0 ? `, ${summary.hastyExcluded} hasty excluded` : ""}) — ${summary.verdict}`,
          mutated: false,
          data: { total: summary.total, correct: summary.correct, pValue: summary.pValue },
        };
      }
      if (op === "reset") {
        resetBlindAbTrials();
        return { text: "blind A/B trial log cleared", mutated: false };
      }
      return { text: `unknown blind_ab op: ${op} (plan | record | verdict | reset)`, mutated: false, isError: true };
    }
    default:
      return { text: `unknown tool: ${name}`, mutated: false, isError: true };
  }
}

/** ── RESOURCES (MCP capability) — passive project reads ────────────────────
 * Static URI surface; the CONTENT is always live from the renderer's doc.
 * Read over the same relay channel as tools/call (hidden __kyx_resource),
 * so the desktop and web transports share one implementation. */
export interface McpResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: "text/plain";
}

export const MCP_RESOURCES: McpResourceDef[] = [
  {
    uri: "kyx://project/overview",
    name: "Project overview",
    description: "Tempo, key, track list, patterns, scenes and the active pattern.",
    mimeType: "text/plain",
  },
  {
    uri: "kyx://project/pattern",
    name: "Active pattern grid",
    description: "Per-family step map of the ACTIVE pattern with mean velocities.",
    mimeType: "text/plain",
  },
  {
    uri: "kyx://project/mix",
    name: "Mix state",
    description: "FX chain of every track (with bypass flags) and the groove settings.",
    mimeType: "text/plain",
  },
  {
    uri: "kyx://project/arrangement",
    name: "Arrangement map",
    description: "Scenes with roles/bars/intensity and the cue markers.",
    mimeType: "text/plain",
  },
  {
    uri: "kyx://project/history",
    name: "Undo history",
    description: "The most recent document commands (undo targets).",
    mimeType: "text/plain",
  },
  {
    uri: "kyx://playbook",
    name: "Producer playbook",
    description:
      "The agent manual: workflows (beat/compose/mix/arrange/live/publish), the tool index, the read-act-verify loop, " +
      "token economy and how to react to honest refusals.",
    mimeType: "text/plain",
  },
  {
    uri: "kyx://vocab",
    name: "Intent vocabulary",
    description:
      "What free-text kyx_intent understands (EN + SK) per category, with the " +
      "rule of thumb for structured-vs-free-text choices.",
    mimeType: "text/plain",
  },
];

export function readMcpResource(ctx: McpToolContext, uri: string): McpToolResult {
  const labels = () => ctx.historyLabels();
  switch (uri) {
    case "kyx://project/overview":
      return { text: stateSnapshot(ctx.getDoc(), "overview", undefined, labels), mutated: false };
    case "kyx://project/pattern":
      return { text: stateSnapshot(ctx.getDoc(), "pattern", undefined, labels), mutated: false };
    case "kyx://project/mix":
      return {
        text: [
          stateSnapshot(ctx.getDoc(), "fxChain", undefined, labels),
          "",
          stateSnapshot(ctx.getDoc(), "groove", undefined, labels),
        ].join("\n"),
        mutated: false,
      };
    case "kyx://project/arrangement":
      return {
        text: [
          stateSnapshot(ctx.getDoc(), "scenes", undefined, labels),
          "",
          `markers: ${stateSnapshot(ctx.getDoc(), "markers", undefined, labels)}`,
        ].join("\n"),
        mutated: false,
      };
    case "kyx://project/history":
      return { text: stateSnapshot(ctx.getDoc(), "history", undefined, labels), mutated: false };
    case "kyx://playbook":
      return { text: MCP_PLAYBOOK_TEXT, mutated: false };
    case "kyx://vocab":
      return { text: MCP_VOCAB_TEXT, mutated: false };
    default:
      return { text: `unknown resource: ${uri} — see resources/list`, mutated: false, isError: true };
  }
}

/** ── PRODUCER MOVES (docs/AGENTIC-DAW-PLAN.md Phase D) ---------------------------
 * One-call, whole-gesture operations over the EXISTING domain planners:
 * kyx_mix wraps planMixProfile + applyMixIntent (the measured mix engine),
 * kyx_arrange wraps planSongForm into a deterministic scenes+clips+markers
 * skeleton. Both fold into ONE snapshot so agent tokens stay on decisions. */

const MIX_GENRES = [
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
] as const;

function executeMixTool(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  const genre = String(record.genre ?? "");
  if (!MIX_GENRES.includes(genre as (typeof MIX_GENRES)[number])) {
    return { text: `unknown genre "${genre}" - one of: ${MIX_GENRES.join(", ")}`, mutated: false, isError: true };
  }
  const spec = normalizeIntent({
    genre: genre as never,
    ...(typeof record.mood === "string" && record.mood.trim() !== "" ? { mood: record.mood.trim() } : {}),
    ...(typeof record.energy === "number" ? { energy: record.energy } : {}),
  });
  const overrides: MixOverrides = {};
  if (record.tone === "dark" || record.tone === "bright" || record.tone === "warm" || record.tone === "cold") {
    overrides.tone = record.tone;
  }
  if (record.reverb === "more" || record.reverb === "less" || record.reverb === "huge") {
    overrides.reverb = record.reverb;
  }
  if (record.punch === "more" || record.punch === "less") overrides.punch = record.punch;
  if (record.pump === "on" || record.pump === "off") overrides.pump = record.pump;

  const profile = planMixProfile(spec, overrides);
  if (profile.decisions.length === 0) {
    return {
      text: "mix profile is neutral for this genre/mood (no decisions) - nothing to apply",
      mutated: false,
    };
  }
  try {
    const command = applyMixIntent(ctx.getDoc(), profile);
    ctx.execute(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/changed nothing/i.test(message)) {
      return { text: "mix already matches the profile - changed nothing", mutated: false };
    }
    return { text: `mix failed: ${message}`, mutated: false, isError: true };
  }
  return {
    text: `mix applied (${profile.decisions.length} decisions): ${profile.summary.join(" | ")} - one undo step`,
    mutated: true,
  };
}

async function executeArrangeTool(ctx: McpToolContext, record: Record<string, unknown>): Promise<McpToolResult> {
  const genre = String(record.genre ?? "");
  if (!MIX_GENRES.includes(genre as (typeof MIX_GENRES)[number])) {
    return { text: `unknown genre "${genre}" - one of: ${MIX_GENRES.join(", ")}`, mutated: false, isError: true };
  }
  const doc = ctx.getDoc();
  if (doc.arrangement.clips.length > 0) {
    return {
      text:
        "arrangement already has clips - kyx_arrange lays out a WHOLE form; " +
        "use kyx_sections / kyx_clips for surgical edits, or clear the arrangement first",
      mutated: false,
      isError: true,
    };
  }
  const spec = normalizeIntent({
    genre: genre as never,
    ...(typeof record.energy === "number" ? { energy: record.energy } : {}),
  });
  const lengthKind = ["short", "standard", "radio", "extended", "epic"].find((kind) => kind === record.length);
  const length =
    lengthKind != null
      ? { kind: lengthKind as "short" | "standard" | "radio" | "extended" | "epic", label: lengthKind }
      : null;
  // The song planner is a heavy domain module — load it only when an
  // arrange/song command actually arrives (keeps the eager DAW graph lean).
  const { planSongForm } = await import("../intent/song");
  const planned: SongSectionSpec[] = planSongForm(spec, undefined, length).sections;
  if (planned.length === 0) {
    return { text: "the genre produced an empty form - nothing to arrange", mutated: false };
  }

  let next = doc;
  let bar = 1; // human 1-based
  const rows: string[] = [];
  for (const section of planned) {
    next = createScene(next, section.label).execute(next);
    const scene = next.scenes[next.scenes.length - 1];
    if (!scene) return { text: "scene creation failed mid-form", mutated: false, isError: true };
    next = setSceneRole(next, scene.id, section.role).execute(next);
    next = setSceneIntensity(next, scene.id, section.intensity).execute(next);
    next = addArrangementClip(next, scene.id, (bar - 1) * 4, section.bars).execute(next);
    next = addMarker(next, { tick: (bar - 1) * TICKS_PER_BAR, name: section.label }).execute(next);
    rows.push(`${section.role} ${section.bars}bar@${bar}`);
    bar += section.bars;
  }
  const totalBars = bar - 1;
  const command = snapshot(
    "mcpArrange",
    `MCP: arrange '${genre}' form (${planned.length} sections, ${totalBars} bars)`,
    doc,
    next,
  );
  ctx.execute(command);
  return {
    text: `arranged '${genre}' form: ${rows.join(" · ")} - ${planned.length} scenes, ${totalBars} bars, cue markers at every section (one undo step)`,
    mutated: true,
  };
}

/** ── CHECKPOINTS (agent time machine, docs/AGENTIC-DAW-PLAN.md Phase C + C7) ──
 * Named full-document snapshots for explore/rollback loops. The in-memory
 * map is the live state; C7 adds a best-effort DURABLE copy per project
 * (own tiny IDB database, src/persistence/McpCheckpointRepository.ts) that
 * is hydrated on first checkpoint use of a project and written through on
 * every save/delete. Persistence is strictly best-effort: any failure
 * degrades to session-only, reported honestly in the read-back. Restore is
 * a plain snapshot command — ONE undo step returns to the pre-restore
 * state. Destructive ops that pass the D4 gate auto-save an
 * auto-before-<tool>-N checkpoint first. */
const CHECKPOINT_LIMIT = 8;

interface McpCheckpoint {
  doc: ProjectDocument;
  projectId: string;
  stepsAtSave: number;
  summary: string;
  auto: boolean;
  /** True when hydrated from IDB after a reload — steps-since resets. */
  reloaded?: boolean;
}

const checkpoints = new Map<string, McpCheckpoint>();
let checkpointCounter = 0;
/** Projects whose durable checkpoints were already merged into the map. */
const hydratedProjects = new Set<string>();

export interface CheckpointRepoLike {
  put(record: {
    key: string;
    projectId: string;
    name: string;
    label: string;
    auto: boolean;
    savedAt: string;
    doc: ProjectDocument;
  }): Promise<void>;
  list(projectId: string): Promise<
    Array<{
      key: string;
      projectId: string;
      name: string;
      label: string;
      auto: boolean;
      savedAt: string;
      doc: ProjectDocument;
    }>
  >;
  remove(projectId: string, name: string): Promise<void>;
}

/** Test/persistence injection. Null until the lazy default repo resolves;
 * a failed resolution memoizes session-only mode. */
let checkpointRepo: CheckpointRepoLike | null = null;
let checkpointRepoResolved = false;
let checkpointRepoPromise: Promise<CheckpointRepoLike | null> | null = null;

/** Test hook — inject a repository (e.g. fake-indexeddb backed). Pass null
 * to force session-only behavior. */
export function setMcpCheckpointRepository(repo: CheckpointRepoLike | null): void {
  checkpointRepo = repo;
  checkpointRepoResolved = true;
  checkpointRepoPromise = null;
}

/** Test hook — the store is module-level by design (per-window session). */
export function resetMcpCheckpoints(): void {
  checkpoints.clear();
  checkpointCounter = 0;
  hydratedProjects.clear();
}

async function getCheckpointRepo(): Promise<CheckpointRepoLike | null> {
  if (checkpointRepoResolved) return checkpointRepo;
  checkpointRepoPromise ??= (async () => {
    if (typeof indexedDB === "undefined") {
      checkpointRepo = null;
      checkpointRepoResolved = true;
      return null;
    }
    const { McpCheckpointRepository } = await import("../persistence/McpCheckpointRepository");
    checkpointRepo = new McpCheckpointRepository();
    return checkpointRepo;
  })();
  try {
    return await checkpointRepoPromise;
  } catch {
    checkpointRepo = null;
    checkpointRepoResolved = true;
    return null;
  }
}

function checkpointName(raw: string | undefined, auto: boolean): string {
  const cleaned = String(raw ?? "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  if (cleaned !== "") return cleaned;
  checkpointCounter += 1;
  return auto ? `auto-${checkpointCounter}` : `checkpoint-${checkpointCounter}`;
}

/** C7: merge the project's durable checkpoints into the live map (once per
 * project, first checkpoint use). Persisted entries restart their
 * steps-since counter at the current stack depth — reload resets that
 * relationship by definition. */
async function hydrateCheckpoints(ctx: McpToolContext, projectId: string): Promise<void> {
  if (hydratedProjects.has(projectId)) return;
  hydratedProjects.add(projectId);
  try {
    const repo = await getCheckpointRepo();
    if (repo == null) return;
    const persisted = await repo.list(projectId);
    for (const record of [...persisted].reverse()) {
      if (checkpoints.has(record.name)) continue;
      checkpoints.set(record.name, {
        doc: record.doc,
        projectId,
        stepsAtSave: ctx.undoStackLength(),
        summary: record.label,
        auto: record.auto,
        reloaded: true,
      });
    }
  } catch {
    // persistence unavailable — session-only mode, already recorded
  }
}

function checkpointProjectId(ctx: McpToolContext): string {
  const doc = ctx.getDoc();
  return doc.id !== "" ? doc.id : `unnamed:${doc.name}`;
}

function saveCheckpoint(rawName: string | undefined, ctx: McpToolContext, auto: boolean): string {
  const name = checkpointName(rawName, auto);
  const doc = ctx.getDoc();
  const projectId = checkpointProjectId(ctx);
  const active = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
  checkpoints.delete(name); // re-save moves the entry to the LRU tail
  checkpoints.set(name, {
    doc: structuredClone(doc),
    projectId,
    stepsAtSave: ctx.undoStackLength(),
    summary: `${doc.tracks.length} tracks · active pattern "${active?.name ?? "none"}" · ${doc.scenes.length} scenes`,
    auto,
  });
  while (checkpoints.size > CHECKPOINT_LIMIT) {
    const oldest = checkpoints.keys().next().value;
    if (oldest == null) break;
    const evicted = checkpoints.get(oldest);
    checkpoints.delete(oldest);
    if (evicted)
      void getCheckpointRepo()
        .then((repo) => repo?.remove(evicted.projectId, oldest))
        .catch(() => {});
  }
  return name;
}

/** D4 gate WITH the auto-checkpoint side effect — use at destructive sites:
 * returns true when allowed (after saving auto-before-<tool>), false when
 * the caller must return the refusal. */
function destructiveAllowedWithCheckpoint(ctx: McpToolContext, tool: string): boolean {
  if (ctx.allowDestructive?.() !== true) return false;
  saveCheckpoint(`auto-before-${tool}`, ctx, true);
  return true;
}

async function executeCheckpointTool(ctx: McpToolContext, record: Record<string, unknown>): Promise<McpToolResult> {
  const projectId = checkpointProjectId(ctx);
  await hydrateCheckpoints(ctx, projectId);
  const repo = await getCheckpointRepo();

  const op = String(record.op ?? "list");
  if (op === "list") {
    if (checkpoints.size === 0) {
      return {
        text: "no checkpoints — kyx_checkpoint {op: save, name} creates one; destructive ops auto-save when allowed",
        mutated: false,
      };
    }
    const lines: string[] = [];
    for (const [name, cp] of checkpoints) {
      const stepsSince = Math.max(0, ctx.undoStackLength() - cp.stepsAtSave);
      const scope = cp.projectId === projectId ? "" : " (other project)";
      const timing = cp.reloaded ? "↻ reloaded (steps reset)" : `${stepsSince} step(s) since`;
      lines.push(`${name}${cp.auto ? " (auto)" : ""} · ${cp.summary} · ${timing}${scope}`);
    }
    return { text: lines.join("\n"), mutated: false };
  }
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (op === "save") {
    const saved = saveCheckpoint(name === "" ? undefined : name, ctx, false);
    const entry = checkpoints.get(saved)!;
    let durable = "session only";
    if (repo != null) {
      try {
        await repo.put({
          key: `${entry.projectId}::${saved}`,
          projectId: entry.projectId,
          name: saved,
          label: entry.summary,
          auto: entry.auto,
          savedAt: new Date().toISOString(),
          doc: entry.doc,
        });
        durable = "persisted";
      } catch {
        durable = "session only (persistence unavailable)";
      }
    }
    return {
      text: `checkpoint "${saved}" saved (${entry.summary}) — ${durable}, ${checkpoints.size}/${CHECKPOINT_LIMIT} in memory`,
      mutated: false,
    };
  }
  if (name === "") {
    return {
      text: `checkpoint ${op} needs a name — kyx_checkpoint {op: list} shows them`,
      mutated: false,
      isError: true,
    };
  }
  const cp = checkpoints.get(name);
  if (!cp) {
    return {
      text: `no checkpoint "${name}" — kyx_checkpoint {op: list} shows: ${[...checkpoints.keys()].join(", ") || "none"}`,
      mutated: false,
      isError: true,
    };
  }
  if (op === "delete") {
    checkpoints.delete(name);
    if (repo != null) void repo.remove(projectId, name).catch(() => {});
    return { text: `checkpoint "${name}" deleted (${checkpoints.size} left)`, mutated: false };
  }
  if (op === "diff") {
    // C7.5: WHAT changed since the checkpoint — the agent decides whether to
    // restore with knowledge instead of blind-rolling the whole document.
    const doc = ctx.getDoc();
    const delta: string[] = [];
    const docTracks = new Map(doc.tracks.map((t) => [t.id, t]));
    const cpTracks = new Map(cp.doc.tracks.map((t) => [t.id, t]));
    let added = 0;
    let removed = 0;
    let renamed = 0;
    for (const t of docTracks.values()) {
      if (!cpTracks.has(t.id)) {
        added += 1;
        delta.push(`+ track "${t.name}" (${t.kind})`);
      } else if (cpTracks.get(t.id)?.name !== t.name) {
        renamed += 1;
        delta.push(`~ track renamed: "${cpTracks.get(t.id)?.name}" -> "${t.name}"`);
      }
    }
    for (const t of cpTracks.values()) {
      if (!docTracks.has(t.id)) {
        removed += 1;
        delta.push(`- track "${t.name}" (${t.kind})`);
      }
    }
    if (doc.bpm !== cp.doc.bpm) delta.push(`~ tempo ${cp.doc.bpm} -> ${doc.bpm} BPM`);
    if (doc.patterns.length !== cp.doc.patterns.length) {
      delta.push(`~ patterns: ${cp.doc.patterns.length} -> ${doc.patterns.length}`);
    }
    if (doc.arrangement.clips.length !== cp.doc.arrangement.clips.length) {
      delta.push(`~ clips: ${cp.doc.arrangement.clips.length} -> ${doc.arrangement.clips.length}`);
    }
    const fxThen = cp.doc.tracks.reduce((sum, t) => sum + t.effects.length, 0);
    const fxNow = doc.tracks.reduce((sum, t) => sum + t.effects.length, 0);
    if (fxThen !== fxNow) delta.push(`~ FX instances: ${fxThen} -> ${fxNow}`);
    if (delta.length === 0) {
      return { text: `checkpoint "${name}": no differences — the document matches the checkpoint`, mutated: false };
    }
    return {
      text:
        `checkpoint "${name}" diff (${delta.length} change(s) since save):` +
        "\n" +
        delta.slice(0, 12).join("\n") +
        (delta.length > 12 ? `\n... and ${delta.length - 12} more` : "") +
        "\nrestore replaces ALL of this in one undo step.",
      mutated: false,
    };
  }
  if (op === "restore") {
    const doc = ctx.getDoc();
    const command = snapshot("mcpCheckpointRestore", `MCP: restore checkpoint '${name}'`, doc, structuredClone(cp.doc));
    ctx.execute(command);
    return {
      text: `restored "${name}" (${cp.summary}) — one undo step returns to the pre-restore state`,
      mutated: true,
    };
  }
  return { text: `unknown checkpoint op: ${op}`, mutated: false, isError: true };
}

/** "wav" | "mp3" from the tool record — anything else falls back to wav. */
function exportFormatOf(record: Record<string, unknown>): "wav" | "mp3" {
  return record.format === "mp3" ? "mp3" : "wav";
}

/**
 * ASYNC executor — what the transports actually call. Identical to
 * {@link executeMcpTool} except `kyx_export`, which AWAITS the render +
 * encode + download hook and returns the completion report (duration/size)
 * instead of the fire-and-forget "started" echo. Render failures surface as
 * honest isError results. Render/generation calls receive an extended 60 s
 * transport window; exceptionally long jobs may still time out even though
 * the download lands in the window.
 */

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
export function explicitTrackIds(doc: ProjectDocument, record: Record<string, unknown>): string[] | string {
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

  if (op === "movePoint") {
    if (!lane)
      return {
        text: `no automation lane for ${automationTargetLabel(doc, target)} — nothing to move`,
        mutated: false,
      };
    if (lane.points.length === 0) return { text: "the lane has no points", mutated: false };
    const position = positionFromRecord(record);
    if (typeof position === "string") return { text: position, mutated: false };
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
    const original = lane.points[bestIndex];
    const hasNewPosition = record.newBar != null;
    const newTick = hasNewPosition ? positionFromRecord({ bar: record.newBar, beat: record.newBeat }) : original!.tick;
    if (typeof newTick === "string") return { text: newTick, mutated: false };
    const delta: { tick?: number; value?: number } = {};
    if (hasNewPosition && newTick !== original!.tick) delta.tick = newTick;
    if (record.value != null) {
      if (!Number.isFinite(Number(record.value)))
        return { text: "value must be a finite NATIVE number", mutated: false };
      if (Number(record.value) !== original!.value) delta.value = Number(record.value);
    }
    if (delta.tick === undefined && delta.value === undefined) {
      return {
        text: `nothing to change — point ${barBeat(original!.tick)}=${original!.value} already matches`,
        mutated: false,
      };
    }
    const valueChangedOnly = delta.tick === undefined;
    ctx.execute(moveAutomationPoint(doc, lane.id, bestIndex, delta));
    const after = ctx.getDoc().automation.find((candidate) => candidate.id === lane.id)?.points[bestIndex];
    const clampedNote =
      delta.value !== undefined && after && after.value !== delta.value ? " — value clamped into range" : "";
    return {
      text: `${automationTargetLabel(doc, target)}: ${barBeat(original!.tick)}=${Math.round(original!.value * 1e4) / 1e4} → ${valueChangedOnly ? `value ${after?.value}` : `${barBeat(after?.tick ?? newTick)}=${Math.round((after?.value ?? original!.value) * 1e4) / 1e4}`}${clampedNote} — one undo step`,
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

  return { text: `unknown op: ${op} (addPoint | movePoint | deletePoint | clearLane | removeLane)`, mutated: false };
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

/** The arrangement clip covering a 1-based bar (clips never overlap). */
function clipCoveringBar(doc: ProjectDocument, bar: number) {
  const start = bar - 1;
  return doc.arrangement.clips.find((clip) => start >= clip.startBar && start < clip.startBar + clip.lengthBars);
}

/** kyx_clips — structured arrangement-clip edits over the same commands the
 * NL arrange layer uses; delete rides the D4 gate. */
function executeClipsTool(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  const op = String(record.op ?? "");
  const doc = ctx.getDoc();
  const sceneName = (sceneId: string): string => doc.scenes.find((scene) => scene.id === sceneId)?.name ?? sceneId;
  const describeClip = (clip: {
    id: string;
    sceneId: string;
    startBar: number;
    lengthBars: number;
    loop?: boolean;
  }): string =>
    `"${sceneName(clip.sceneId)}" bars ${clip.startBar + 1}–${clip.startBar + clip.lengthBars}${clip.loop ? " (loop)" : ""}`;

  if (op === "list") {
    const lines: string[] = [];
    const sorted = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
    if (sorted.length === 0) lines.push("no arrangement clips");
    for (const clip of sorted) lines.push(describeClip(clip));
    const audio = doc.arrangement.audioClips ?? [];
    if (audio.length > 0) {
      const byTrack = new Map<string, number>();
      for (const clip of audio) byTrack.set(clip.trackId, (byTrack.get(clip.trackId) ?? 0) + 1);
      const summary = [...byTrack.entries()]
        .map(([trackId, count]) => `${ownerNameOf(doc, trackId)} ×${count}`)
        .join(", ");
      lines.push(
        `audio clips on track lanes: ${audio.length} (${summary}) — op:audioList for details / op:audio* to edit`,
      );
    }
    return {
      text: lines.join("\n"),
      mutated: false,
      data: {
        arrangementClips: sorted.map((clip) => ({
          id: clip.id,
          scene: sceneName(clip.sceneId),
          startBar: clip.startBar + 1,
          lengthBars: clip.lengthBars,
          loop: clip.loop === true,
        })),
        audioClipCount: audio.length,
      },
    };
  }

  // ── audio-clip surface (track-lane waveforms) ────────────────────────────
  if (op === "audioList") {
    const audio = doc.arrangement.audioClips ?? [];
    if (audio.length === 0) return { text: "no audio clips on track lanes", mutated: false };
    const lines = audio
      .slice(0, 12)
      .map(
        (clip) =>
          `${ownerNameOf(doc, clip.trackId)} (id=${clip.id}): bars ${clip.startBar + 1}–${clip.startBar + clip.lengthBars} · gain ${clip.gain.toFixed(2)} · fade ${clip.fadeIn.toFixed(2)}/${clip.fadeOut.toFixed(2)}${clip.reverse ? " · reversed" : ""}${clip.loop ? " · loop" : ""}`,
      );
    if (audio.length > 12) lines.push(`… and ${audio.length - 12} more audio clip(s)`);
    return {
      text: lines.join("\n"),
      mutated: false,
      data: {
        clips: audio.slice(0, 12).map((clip) => ({
          id: clip.id,
          track: ownerNameOf(doc, clip.trackId),
          trackId: clip.trackId,
          startBar: clip.startBar + 1,
          lengthBars: clip.lengthBars,
          gain: clip.gain,
          fadeIn: clip.fadeIn,
          fadeOut: clip.fadeOut,
          reverse: clip.reverse,
        })),
      },
    };
  }

  if (op.startsWith("audio")) {
    // Audio ops address a clip by trackId/family + the anchor bar it covers.
    const trackId = typeof record.trackId === "string" ? record.trackId.trim() : "";
    const family = typeof record.family === "string" ? record.family.trim() : "";
    let ownerId: string | null = null;
    if (trackId !== "") ownerId = trackId;
    else if (family !== "") {
      const ids = tracksInFamily(doc, family);
      if (ids.length === 0) return { text: `no track matches family "${family}"`, mutated: false };
      ownerId = ids[0];
    } else {
      return { text: `audio ops need trackId or family (op ${op})`, mutated: false };
    }
    const rawAnchor = Number(record.bar);
    if (!Number.isFinite(rawAnchor) || Math.round(rawAnchor) < 1) {
      return { text: `a 1-based anchor bar is required for ${op}`, mutated: false };
    }
    const anchor = Math.round(rawAnchor) - 1;
    const audio = doc.arrangement.audioClips ?? [];
    const target = audio.find(
      (clip) => clip.trackId === ownerId && anchor >= clip.startBar && anchor < clip.startBar + clip.lengthBars,
    );
    if (!target) {
      return {
        text: `no audio clip on ${ownerNameOf(doc, ownerId)} covers bar ${anchor + 1} — op:audioList to see the lanes`,
        mutated: false,
      };
    }
    const describe = (): string =>
      `audio clip ${target.bufferId} on ${ownerNameOf(doc, target.trackId)} bars ${target.startBar + 1}–${target.startBar + target.lengthBars}`;
    try {
      if (op === "audioMove") {
        const toBar = Math.round(Number(record.toBar));
        if (!Number.isFinite(toBar) || toBar < 1)
          return { text: "audioMove needs toBar (1-based destination start bar)", mutated: false };
        ctx.execute(moveAudioClip(doc, target.id, toBar - 1));
        return { text: `moved ${describe()} → starts at bar ${toBar} — one undo step`, mutated: true };
      }
      if (op === "audioSplit") {
        const tick = anchor * TICKS_PER_BAR;
        ctx.execute(splitAudioClipAtTick(doc, target.id, tick));
        return { text: `split ${describe()} at bar ${anchor + 1} — one undo step`, mutated: true };
      }
      if (op === "audioUpdate") {
        const patch: Record<string, number | boolean> = {};
        const notes: string[] = [];
        if (typeof record.gain === "number" && Number.isFinite(record.gain)) {
          patch.gain = Math.min(2, Math.max(0, record.gain));
          notes.push(`gain ${patch.gain}`);
        }
        if (typeof record.fadeIn === "number" && Number.isFinite(record.fadeIn)) {
          patch.fadeIn = Math.max(0, record.fadeIn);
          notes.push(`fadeIn ${patch.fadeIn}`);
        }
        if (typeof record.fadeOut === "number" && Number.isFinite(record.fadeOut)) {
          patch.fadeOut = Math.max(0, record.fadeOut);
          notes.push(`fadeOut ${patch.fadeOut}`);
        }
        if (typeof record.reverse === "boolean") {
          patch.reverse = record.reverse;
          notes.push(`reverse ${record.reverse ? "on" : "off"}`);
        }
        if (typeof record.loop === "boolean") {
          patch.loop = record.loop;
          notes.push(`loop ${record.loop ? "on" : "off"}`);
        }
        if (notes.length === 0) {
          return { text: "audioUpdate needs at least one of gain / fadeIn / fadeOut / reverse / loop", mutated: false };
        }
        ctx.execute(updateAudioClip(doc, target.id, patch));
        return { text: `updated ${describe()}: ${notes.join(", ")} — one undo step`, mutated: true };
      }
      if (op === "audioDelete") {
        if (ctx.allowDestructive?.() !== true) return destructiveRefusal();
        ctx.execute(deleteAudioClip(doc, target.id));
        return { text: `deleted ${describe()} — one undo step`, mutated: true };
      }
      return {
        text: `unknown op: ${op} (list | audioList | audioMove | audioSplit | audioUpdate | audioDelete | move | resize | duplicate | delete)`,
        mutated: false,
      };
    } catch (error) {
      return {
        text: `audio clip op failed: ${error instanceof Error ? error.message : String(error)}`,
        mutated: false,
      };
    }
  }

  const rawBar = Number(record.bar);
  if (!Number.isFinite(rawBar) || Math.round(rawBar) < 1) {
    return {
      text: "a 1-based anchor bar is required — the clip covering it is the target (list first)",
      mutated: false,
    };
  }
  const clip = clipCoveringBar(doc, Math.round(rawBar));
  if (!clip) {
    return {
      text: `no arrangement clip covers bar ${Math.round(rawBar)} — read the layout via op:list`,
      mutated: false,
    };
  }

  try {
    if (op === "move") {
      const toBar = Math.round(Number(record.toBar));
      if (!Number.isFinite(toBar) || toBar < 1) {
        return { text: "move needs toBar (1-based destination start bar)", mutated: false };
      }
      ctx.execute(moveArrangementClip(doc, clip.id, toBar - 1));
      return { text: `moved ${describeClip(clip)} → starts at bar ${toBar} — one undo step`, mutated: true };
    }
    if (op === "resize") {
      const bars = Math.round(Number(record.bars));
      if (!Number.isFinite(bars) || bars < 1 || bars > 64) {
        return { text: "resize needs bars 1..64 (new clip length)", mutated: false };
      }
      ctx.execute(resizeArrangementClip(doc, clip.id, bars));
      return {
        text: `resized ${describeClip(clip)} → ${bars} bar(s) — one undo step`,
        mutated: true,
      };
    }
    if (op === "duplicate") {
      ctx.execute(duplicateArrangementClip(doc, clip.id));
      return {
        text: `duplicated ${describeClip(clip)} — copy placed after the original, one undo step`,
        mutated: true,
      };
    }
    if (op === "delete") {
      if (ctx.allowDestructive?.() !== true) return destructiveRefusal();
      ctx.execute(deleteArrangementClip(doc, clip.id));
      return { text: `deleted ${describeClip(clip)} — one undo step`, mutated: true };
    }
    return { text: `unknown op: ${op} (list | move | resize | duplicate | delete)`, mutated: false };
  } catch (error) {
    // Arrangement commands throw on invariants (overlap, bounds) — honest
    // failure over MCP, never a thrown crash into the relay.
    return {
      text: `clip op failed: ${error instanceof Error ? error.message : String(error)}`,
      mutated: false,
      isError: true,
    };
  }
}

/** Resolve a return bus from the record: returnId (exact) or returnName
 * (case-insensitive). Null when nothing matches — the caller reports. */
function resolveReturnId(doc: ProjectDocument, record: Record<string, unknown>): string | null {
  const returnId = typeof record.returnId === "string" ? record.returnId.trim() : "";
  if (returnId !== "") return doc.returns.some((r) => r.id === returnId) ? returnId : null;
  const returnName = typeof record.returnName === "string" ? record.returnName.trim().toLowerCase() : "";
  if (returnName === "") return null;
  return doc.returns.find((r) => r.name.toLowerCase() === returnName)?.id ?? null;
}

/** kyx_routing — the group routing graph. The model is FLAT (a track joins
 * at most one group; addToGroup refuses group-into-group), so routing
 * cycles are impossible by construction — the domain IS the cycle check. */
function executeRoutingTool(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  const op = String(record.op ?? "list");
  const doc = ctx.getDoc();
  const resolveGroup = (): string | null => {
    const groupId = typeof record.groupId === "string" ? record.groupId.trim() : "";
    if (groupId !== "") {
      return doc.tracks.some((t) => t.id === groupId && t.kind === "group") ? groupId : null;
    }
    const groupName = typeof record.groupName === "string" ? record.groupName.trim() : "";
    if (groupName !== "") {
      const match = doc.tracks.find((t) => t.kind === "group" && t.name.toLowerCase() === groupName.toLowerCase());
      return match?.id ?? null;
    }
    return null;
  };

  if (op === "list") {
    const groups = doc.tracks.filter((t) => t.kind === "group");
    const lines: string[] = [];
    for (const track of doc.tracks) {
      if (track.kind === "group") continue;
      const route = "groupId" in track && track.groupId ? track.groupId : "master";
      const groupName = route === "master" ? "master" : ownerNameOf(doc, route);
      lines.push(`${track.name} (id=${track.id}) → ${groupName}${route !== "master" ? ` (id=${route})` : ""}`);
    }
    for (const group of groups) {
      const members = doc.tracks.filter((t) => t.kind !== "group" && "groupId" in t && t.groupId === group.id);
      lines.push(
        `group ${group.name} (id=${group.id}): ${members.length} member(s) — ${members.map((m) => m.name).join(", ") || "empty"}`,
      );
    }
    if (doc.returns.length > 0) {
      lines.push(`returns (send buses → master): ${doc.returns.map((r) => r.name).join(", ")}`);
    }
    return {
      text: lines.join("\n") || "no tracks",
      mutated: false,
      data: {
        routes: doc.tracks
          .filter((t) => t.kind !== "group")
          .map((t) => ({
            trackId: t.id,
            track: t.name,
            destination: "groupId" in t && t.groupId ? t.groupId : "master",
          })),
        groups: groups.map((g) => ({ id: g.id, name: g.name })),
      },
    };
  }

  try {
    if (op === "createGroup") {
      const command = createGroupTrack(doc);
      ctx.execute(command);
      const groups = ctx.getDoc().tracks.filter((t) => t.kind === "group");
      const groupId = groups[groups.length - 1]?.id;
      const name = typeof record.name === "string" ? record.name.trim().slice(0, 40) : "";
      if (name !== "" && groupId != null) {
        ctx.execute(setTrackParams(ctx.getDoc(), groupId, { name }));
        return { text: `created group "${name}" (id=${groupId}) — one undo step`, mutated: true };
      }
      return { text: `created group (id=${groupId}) — one undo step`, mutated: true };
    }
    if (op === "addToGroup") {
      const ids = explicitTrackIds(doc, record);
      if (typeof ids === "string") return { text: ids, mutated: false };
      if (ids.length === 0) return { text: `no track matches family "${String(record.family ?? "")}"`, mutated: false };
      const groupId = resolveGroup();
      if (groupId == null) {
        return {
          text: "target group not found — pass groupId (from op:list) or the exact groupName",
          mutated: false,
        };
      }
      let next = doc;
      const parts: string[] = [];
      for (const id of ids) {
        next = addToGroup(next, id, groupId).execute(next);
        parts.push(`${ownerNameOf(doc, id)} → ${ownerNameOf(doc, groupId)}`);
      }
      ctx.execute(snapshot("mcpRouting", `MCP: route ${ids.length} track(s) into group`, doc, next));
      return { text: `${parts.join("; ")} — one undo step`, mutated: true };
    }
    if (op === "removeFromGroup") {
      const ids = explicitTrackIds(doc, record);
      if (typeof ids === "string") return { text: ids, mutated: false };
      if (ids.length === 0) return { text: `no track matches family "${String(record.family ?? "")}"`, mutated: false };
      let next = doc;
      const parts: string[] = [];
      let changed = false;
      for (const id of ids) {
        const track = next.tracks.find((t) => t.id === id);
        if (!track || !("groupId" in track) || track.groupId == null) {
          parts.push(`${ownerNameOf(doc, id)}: not in a group`);
          continue;
        }
        next = removeFromGroup(next, id).execute(next);
        parts.push(`${track.name} → master`);
        changed = true;
      }
      if (!changed) return { text: `nothing changed — ${parts.join("; ")}`, mutated: false };
      ctx.execute(snapshot("mcpRouting", `MCP: unroute ${ids.length} track(s)`, doc, next));
      return { text: `${parts.join("; ")} — one undo step`, mutated: true };
    }
    if (op === "setSend" || op === "setReturnGain" || op === "createReturn") {
      // Structured send-bus writes — the last NL-only corner of the mixer.
      if (op === "createReturn") {
        try {
          const name = typeof record.name === "string" ? record.name.trim().slice(0, 40) : "";
          const command = createReturnTrack(ctx.getDoc(), name !== "" ? name : undefined);
          ctx.execute(command);
          const created = ctx.getDoc().returns[ctx.getDoc().returns.length - 1];
          return { text: `created return bus "${created.name}" (id=${created.id}) — one undo step`, mutated: true };
        } catch (error) {
          return {
            text: `routing op failed: ${error instanceof Error ? error.message : String(error)}`,
            mutated: false,
            isError: true,
          };
        }
      }
      const levelField = op === "setSend" ? "level" : "gain";
      const targetLevel = Number(record[levelField]);
      if (record[levelField] == null || !Number.isFinite(targetLevel)) {
        return {
          text:
            op === "setSend"
              ? "setSend needs level (linear 0..1.5; 1.0 = unity, 1.5 = +3.5 dB into the bus)"
              : "setReturnGain needs gain (linear 0..1.5)",
          mutated: false,
        };
      }
      const clamped = Math.min(1.5, Math.max(0, targetLevel));
      const returnId = resolveReturnId(ctx.getDoc(), record);
      if (returnId == null) {
        return {
          text: "no return bus matches — pass returnId or returnName (op:list shows the buses)",
          mutated: false,
        };
      }
      try {
        if (op === "setSend") {
          const ids = explicitTrackIds(ctx.getDoc(), record);
          if (typeof ids === "string") return { text: ids, mutated: false };
          if (ids.length === 0)
            return { text: `no track matches family "${String(record.family ?? "")}"`, mutated: false };
          let next = ctx.getDoc();
          const parts: string[] = [];
          for (const id of ids) {
            next = setTrackSend(next, id, returnId, clamped).execute(next);
            const track = next.tracks.find((t) => t.id === id)!;
            parts.push(`${track.name} → ${ownerNameOf(next, returnId)} ${clamped}`);
          }
          ctx.execute(snapshot("mcpSends", `MCP: set send ×${ids.length}`, ctx.getDoc(), next));
          return { text: `${parts.join("; ")} — one undo step`, mutated: true };
        }
        ctx.execute(setReturnGain(ctx.getDoc(), returnId, clamped));
        const ret = ctx.getDoc().returns.find((r) => r.id === returnId)!;
        return { text: `${ret.name}: return gain ${ret.gain.toFixed(2)} — one undo step`, mutated: true };
      } catch (error) {
        return {
          text: `routing op failed: ${error instanceof Error ? error.message : String(error)}`,
          mutated: false,
          isError: true,
        };
      }
    }
    return {
      text: `unknown op: ${op} (list | createGroup | addToGroup | removeFromGroup | setSend | setReturnGain | createReturn)`,
      mutated: false,
    };
  } catch (error) {
    return {
      text: `routing op failed: ${error instanceof Error ? error.message : String(error)}`,
      mutated: false,
      isError: true,
    };
  }
}

/** kyx_takes — the comp workflow over arrangement take groups: list the
 * alternatives and activate (comp pick) one; the domain validates that the
 * take actually has clips in the group. */
function executeTakesTool(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  const op = String(record.op ?? "list");
  const doc = ctx.getDoc();
  const groups = doc.arrangement.takeGroups ?? [];
  const clipsOf = (
    groupId: string,
  ): Array<{ takeId: string | undefined; id: string; startBar: number; lengthBars: number }> =>
    (doc.arrangement.audioClips ?? [])
      .filter((clip) => clip.takeGroupId === groupId)
      .map((clip) => ({ takeId: clip.takeId, id: clip.id, startBar: clip.startBar, lengthBars: clip.lengthBars }));

  if (op === "list") {
    if (groups.length === 0)
      return { text: "no take groups (takes appear when a lane holds alternative passes)", mutated: false };
    const lines: string[] = [];
    const data: Array<{ id: string; track: string; activeTakeId: string; takes: Record<string, number> }> = [];
    for (const group of groups) {
      const clips = clipsOf(group.id);
      const perTake: Record<string, number> = {};
      for (const clip of clips) {
        const key = clip.takeId ?? "(none)";
        perTake[key] = (perTake[key] ?? 0) + 1;
      }
      lines.push(
        `${ownerNameOf(doc, group.trackId)} (group id=${group.id}): ACTIVE take ${group.activeTakeId} · ${Object.entries(
          perTake,
        )
          .map(([take, count]) => `take ${take} ×${count} clip(s)`)
          .join(", ")}${group.compTakeId ? ` · comp: ${group.compTakeId}` : ""}`,
      );
      data.push({
        id: group.id,
        track: ownerNameOf(doc, group.trackId),
        activeTakeId: group.activeTakeId,
        takes: perTake,
      });
    }
    return { text: lines.join("\n"), mutated: false, data: { groups: data } };
  }

  if (op === "activate") {
    const groupId = typeof record.groupId === "string" ? record.groupId.trim() : "";
    const takeId = typeof record.takeId === "string" ? record.takeId.trim() : "";
    if (groupId === "" || takeId === "") {
      return { text: "activate needs groupId AND takeId — read them via op:list", mutated: false };
    }
    try {
      const group = groups.find((item) => item.id === groupId);
      if (!group) return { text: `no take group "${groupId}" — op:list for the groups`, mutated: false };
      if (group.activeTakeId === takeId) {
        return { text: `take ${takeId} is already the active comp of group ${groupId}`, mutated: false };
      }
      ctx.execute(setActiveAudioTake(doc, groupId, takeId));
      const clipCount = clipsOf(groupId).filter((clip) => clip.takeId === takeId).length;
      return {
        text: `comp pick: take ${takeId} is now ACTIVE in group ${groupId} (${clipCount} clip(s)) — one undo step`,
        mutated: true,
      };
    } catch (error) {
      return {
        text: `take op failed: ${error instanceof Error ? error.message : String(error)}`,
        mutated: false,
        isError: true,
      };
    }
  }

  if (op === "deleteTake") {
    if (ctx.allowDestructive?.() !== true) return destructiveRefusal();
    const groupId = typeof record.groupId === "string" ? record.groupId.trim() : "";
    const takeId = typeof record.takeId === "string" ? record.takeId.trim() : "";
    if (groupId === "" || takeId === "")
      return { text: "deleteTake needs groupId AND takeId — op:list for the groups", mutated: false };
    const group = groups.find((item) => item.id === groupId);
    if (!group) return { text: `no take group "${groupId}"`, mutated: false };
    if (group.activeTakeId === takeId) {
      return {
        text: "refused: that take is the ACTIVE comp — activate another take first",
        mutated: false,
        isError: true,
      };
    }
    const doomed = (doc.arrangement.audioClips ?? []).filter(
      (clip) => clip.takeGroupId === groupId && clip.takeId === takeId,
    );
    if (doomed.length === 0) return { text: `no clips for take ${takeId} in group ${groupId}`, mutated: false };
    let next = doc;
    for (const clip of doomed) next = deleteAudioClip(next, clip.id).execute(next);
    // prune the group when no clip of ANY take remains
    const remaining = (next.arrangement.audioClips ?? []).filter((clip) => clip.takeGroupId === groupId);
    const prunedGroups =
      remaining.length === 0
        ? (next.arrangement.takeGroups ?? []).filter((item) => item.id !== groupId)
        : next.arrangement.takeGroups;
    next = { ...next, arrangement: { ...next.arrangement, takeGroups: prunedGroups } };
    ctx.execute(snapshot("mcpTakeDelete", `MCP: delete take ${takeId} (${doomed.length} clip(s))`, doc, next));
    return {
      text: `deleted take ${takeId} (${doomed.length} clip(s)) from group ${groupId} — one undo step`,
      mutated: true,
    };
  }

  return { text: `unknown op: ${op} (list | activate | deleteTake)`, mutated: false };
}

/** kyx_batch — sequential multi-call with optional ONE-undo-frame folding.
 * Per-call failures never abort the batch; every result carries its own
 * read-back so the caller sees exactly what landed. */
async function executeBatchTool(ctx: McpToolContext, record: Record<string, unknown>): Promise<McpToolResult> {
  const calls = Array.isArray(record.calls) ? record.calls : null;
  if (calls == null || calls.length === 0) {
    return { text: "batch needs calls: [{tool, args}…] (1..10)", mutated: false, isError: true };
  }
  if (calls.length > 10) {
    return { text: `batch is capped at 10 calls (got ${calls.length}) — split it`, mutated: false, isError: true };
  }
  const framed = ctx.beginUndoFrame != null && ctx.endUndoFrame != null;
  const results: Array<{ tool: string; mutated: boolean; text: string }> = [];
  let mutations = 0;
  let failures = 0;
  if (framed) ctx.beginUndoFrame!("mcp-batch");
  try {
    for (const entry of calls) {
      const item = (entry != null && typeof entry === "object" ? entry : {}) as { tool?: unknown; args?: unknown };
      const tool = typeof item.tool === "string" ? item.tool : "";
      if (tool === "" || !MCP_TOOLS.some((def) => def.name === tool)) {
        results.push({ tool: tool || "(missing)", mutated: false, text: "unknown tool" });
        failures += 1;
        continue;
      }
      if (tool === "kyx_batch") {
        results.push({ tool, mutated: false, text: "refused: nested batches are not supported" });
        failures += 1;
        continue;
      }
      if (tool === "kyx_export" || tool === "kyx_audio_preview" || tool === "kyx_loudness") {
        results.push({ tool, mutated: false, text: `refused: ${tool} runs standalone (async, not batchable)` });
        failures += 1;
        continue;
      }
      try {
        const result = await executeMcpTool(ctx, tool, item.args ?? {});
        results.push({ tool, mutated: result.mutated, text: result.text });
        if (result.mutated) mutations += 1;
        if (result.isError === true) failures += 1;
      } catch (error) {
        results.push({
          tool,
          mutated: false,
          text: `crashed: ${error instanceof Error ? error.message : String(error)}`,
        });
        failures += 1;
      }
    }
  } finally {
    if (framed) ctx.endUndoFrame!();
  }
  const summary = [
    `${calls.length} call(s): ${mutations} mutated, ${failures} failed`,
    framed
      ? "ONE undo step for the whole batch"
      : "no undo-frame support on this host — each call is its own undo step",
  ].join(" · ");
  return {
    text: `batch — ${summary}\n${results.map((r, i) => `${i + 1}. ${r.tool}${r.mutated ? " ✓" : ""}: ${r.text}`).join("\n")}`,
    mutated: mutations > 0,
    data: { results, mutations, failures, singleUndo: framed },
  };
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
    const ownerNode =
      doc.tracks.find((t) => t.id === target.trackId) ?? doc.returns.find((r) => r.id === target.trackId);
    const fx = ownerNode?.effects.find((effect) => effect.id === target.fxId);
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

/** Family → track-id predicate for read filters (fxChain/sends/automation).
 * Uses the WRITE-side resolution (tracksInFamily: name + instrument kind, so
 * family "bass" covers the 808 track) and adds drum tracks for the kit and
 * pad families — a "kick" ask must still see the drum track's chain/sends. */
function familyTrackFilter(doc: ProjectDocument, family: string | undefined): ((trackId: string) => boolean) | null {
  if (family == null) return null;
  const ids = new Set(tracksInFamily(doc, family));
  if (family === "drums" || ["kick", "snare", "clap", "hat", "perc", "tom"].includes(family)) {
    for (const track of doc.tracks) if (track.kind === "drum") ids.add(track.id);
  }
  return (trackId) => ids.has(trackId);
}

/** kyx_state subject:automation — the lanes map + scene-curve summary. */
function automationSnapshot(doc: ProjectDocument, family: string | undefined): string {
  const passes = familyTrackFilter(doc, family);
  const lines: string[] = [];
  const lanes = doc.automation.filter((lane) => passes == null || passes(lane.target.trackId));
  if (lanes.length === 0) {
    lines.push(family != null ? `no automation lanes match family "${family}"` : "no automation lanes");
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
  if (subject === "mixer") {
    // THE ONE-CALL MIX BOARD for mixing agents — everything kyx_state
    // otherwise spreads across tracks/fxChain/sends, combined per strip:
    // fader (linear + dB), pan, mute/solo, preset, FX chain, send levels,
    // group membership, plus master and the return bus faders. The dispatch
    // attaches the same picture as structured `data` for machine reading.
    const db = (gain: number): string => `${(20 * Math.log10(Math.max(gain, 1e-4))).toFixed(1)} dB`;
    const panText = (pan: number): string =>
      Math.abs(pan) < 0.005 ? "C" : `${pan < 0 ? "L" : "R"}${Math.round(Math.abs(pan) * 100)}`;
    const trackName = (id: string): string => doc.tracks.find((t) => t.id === id)?.name ?? id;
    const lines: string[] = [];
    for (const track of doc.tracks) {
      if (track.kind === "group") continue;
      const bits: string[] = [];
      if (track.kind === "instrument") {
        bits.push(`inst=${track.instrument}`);
        if (track.presetId) {
          const preset = FACTORY_PRESETS.find((candidate) => candidate.id === track.presetId);
          bits.push(`preset=${preset?.name ?? track.presetId}`);
        }
      }
      bits.push(`gain ${db(track.gain)}`);
      bits.push(`pan ${panText(track.pan)}`);
      if (track.mute) bits.push("MUTED");
      if (track.solo) bits.push("SOLO");
      if ((track.kind === "drum" || track.kind === "instrument") && track.groupId)
        bits.push(`→ group ${trackName(track.groupId)}`);
      const fx = track.effects.map((fx) => `${fx.type}${fx.bypassed ? "!bypassed" : ""}`).join(",");
      if (fx !== "") bits.push(`FX: ${fx}`);
      const sends = doc.returns
        .map((ret) => `${ret.name} ${Math.round((track.sends?.[ret.id] ?? 0) * 1000) / 1000}`)
        .join(" · ");
      if (doc.returns.length > 0) bits.push(`sends: ${sends}`);
      lines.push(`${track.name} (id=${track.id}) — ${bits.join(" | ")}`);
    }
    for (const ret of doc.returns) {
      lines.push(
        `↩ return ${ret.name} (id=${ret.id}) — gain ${db(ret.gain)} | FX: ${ret.effects.map((fx) => fx.type).join(",") || "none"}`,
      );
    }
    const master = doc.master;
    if (master) {
      const masterBits = [`gain ${db(master.masterGain)}`];
      if (master.loudnessTrimDb !== undefined) {
        masterBits.push(`loudnessTrim ${master.loudnessTrimDb > 0 ? "+" : ""}${master.loudnessTrimDb} dB`);
      }
      lines.push(`MASTER — ${masterBits.join(" | ")}`);
    }
    if (lines.length > 14) return `${lines.slice(0, 14).join("\n")}\n… and ${lines.length - 14} more strip(s)`;
    return lines.join("\n") || "no tracks";
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
    const passes = familyTrackFilter(doc, family);
    const lines: string[] = [];
    for (const track of doc.tracks) {
      if (track.kind === "group") continue;
      if (passes != null && !passes(track.id)) continue;
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
    const passes = familyTrackFilter(doc, family);
    const level = (value: number): number => Math.round(value * 1000) / 1000;
    for (const track of doc.tracks) {
      if (passes != null && !passes(track.id)) continue;
      const levels = doc.returns.map((ret) => `${ret.name} ${level(track.sends?.[ret.id] ?? 0)}`);
      lines.push(`${track.name} (id=${track.id}): ${levels.join(" · ")}`);
    }
    if (passes == null && lines.length > 9) {
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
    const spanOf = (sceneId: string): { start: number; bars: number } => {
      const clips = doc.arrangement.clips.filter((clip) => clip.sceneId === sceneId);
      if (clips.length === 0) return { start: 0, bars: 0 };
      const start = Math.min(...clips.map((clip) => clip.startBar));
      return { start, bars: Math.max(...clips.map((clip) => clip.startBar + clip.lengthBars)) - start };
    };
    return doc.scenes
      .map((scene, index) => {
        const role = scene.role ?? "—";
        const { start, bars } = spanOf(scene.id);
        const launchable = bars > 0 ? ` @bar ${start + 1}` : " (no clip)";
        return `${index + 1}. "${scene.name}" ${role}${launchable}${bars > 0 ? ` ${bars}bar` : ""} intensity ${Math.round(scene.intensity * 100)}%`;
      })
      .join("\n");
  }
  if (subject === "model-misses") {
    // Failure-mining surfacing: the producer sentences the deterministic
    // layer AND the local model both failed on, most-frequent first. LOCAL
    // ONLY by contract — the log never leaves the machine; this read-back
    // runs in the host app like every other tool.
    const misses = topIntentMisses(20);
    if (misses.length === 0) {
      return "no unanswered asks logged yet — clarify prompts and model-misses accumulate here as mining rows for the next corpus round";
    }
    const totalHits = misses.reduce((sum, miss) => sum + miss.hits, 0);
    const lines = misses.map(
      (miss) =>
        `${miss.hits}× ${miss.outcome === "clarify" ? "[clarify]" : "[miss]"} "${miss.prompt}"${miss.reason ? ` (${miss.reason})` : ""}`,
    );
    return (
      `${misses.length} unanswered ask(s), ${totalHits} hit(s) total — corpus-round candidates (LOCAL ONLY, never telemetered):` +
      "\n" +
      lines.join("\n")
    );
  }
  if (subject === "reference") {
    // Complement to the reference-mix wave: the MATCH REF conditioning
    // lives in the match-eq module — agents could not see it until this
    // read-back. Read-only; never mutates the conditioning.
    if (!hasMatchEqReference()) {
      return "no reference loaded — load a reference track in the intent panel and click MATCH REF to condition tone + loudness";
    }
    const trim = referenceLoudnessTrim();
    const tone = "MATCH EQ curve installed (tonal shape toward the reference)";
    const level =
      trim != null
        ? `loudness trim ${trim.trimDb > 0 ? "+" : ""}${trim.trimDb} dB (reference at ${trim.refLufs} LUFS)`
        : "loudness trim declined (reference loudness implausible or too short)";
    return `reference conditioning installed — ${tone} · ${level}`;
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
    return { text: `unknown pad family "${family}"`, mutated: false, isError: true };
  }
  const drums = doc.tracks.filter((track): track is DrumTrack => track.kind === "drum");
  if (drums.length === 0) return { text: "no drum tracks in the project", mutated: false };

  const targets: Array<{ padId: string; name: string }> = [];
  for (const track of drums) {
    track.pads.forEach((pad, index) => {
      if (inferPadRole(pad.name, index) === family) targets.push({ padId: pad.id, name: pad.name });
    });
  }
  if (targets.length === 0) return { text: `no pad matches family "${family}"`, mutated: false, isError: true };

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
  return executeRoutedIntent(ctx, routeIntentText(trimmed, ctx.getDoc()));
}

/** Execute a resolved route over MCP — the deterministic path AND the local
 * model fallback land here, so the destructive gate, the UI-local refusals
 * and the verification read-back apply to BOTH brains identically. */
function executeRoutedIntent(ctx: McpToolContext, route: RoutedIntent): McpToolResult {
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

/** Back-compat alias — there is exactly ONE executor now; both names are the same function. */
export const executeMcpToolAsync = executeMcpTool;
