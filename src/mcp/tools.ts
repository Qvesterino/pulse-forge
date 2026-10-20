import type { MusicalKey, ProjectDocument } from "../project-model/types";
import { isForeignWork, labelsRevertedBy } from "./attribution";
import {
  LONG_RUNNING_AGENT_TOOLS,
  completeAgentCall,
  effectiveRisk,
  markSessionCheckpointSaved,
  prepareAgentCall,
  summarizeToolArgs,
  toolAnnotations,
  toolRisk,
  type McpToolAnnotations,
} from "./agentTrust";
import { startJob } from "../services/jobCenter";
import { setMasterConfig } from "../commands/master";
import { slipAudioClip, stretchAudioClip, setAudioClipsMute } from "../commands/audioClips";
import {
  crossfadeAudioClips,
  duplicateAudioClip,
  nudgeClips,
  sliceAudioClipToArrangement,
  stripSilenceAudioClip,
  consolidateAudioClips,
} from "../commands/clipEditing";
import { buildClipClipboard, cutClips, pasteClips, type ClipClipboard } from "../commands/clipClipboard";
import { hasMatchEqReference, referenceLoudnessTrim } from "../intent/match-eq";
import { topIntentMisses } from "../intent/failure-log";
import {
  BLIND_AB_MAX_LANE_LENGTH,
  BLIND_AB_MAX_LANES,
  BLIND_AB_MAX_REACTION_MS,
  BLIND_AB_MAX_TRIALS,
  BlindAbTrialLimitError,
  planBlindPairGains,
  recordBlindAbTrial,
  resetBlindAbTrials,
  summarizeBlindAb,
} from "./blind-ab";
import type { Command } from "../commands/types";
import { routeIntentText, type RoutedIntent } from "../intent/route";
import { clarifyMessage } from "../intent/clarify-messages";
import { isDescriptiveStatement } from "../intent/declarative";
import { routeIsDestructive } from "../intent/route-guard";
import { presetsForEffect } from "../effects/presets";
import { planMasterSettings, planReferenceMastering, resolveMasterAssistantStepValue } from "./master-assistant";
import { profileFor, resolveDeliveryTarget, verdictAgainst, worstStatus } from "./master-profiles";
import { stemMasteringPlan, stemRoleOf, type StemRole } from "./stem-mastering";
import { iterateTowardTarget, isConverged, type IterateMeasurement } from "./master-iterate";
import { analyzeMasterPcm } from "../mastering/analysis";
import { addStemTracksCommand } from "../commands/stemTracks";
import { collectDevices, diffSnapshots, snapshotSummary, type AbSnapshot } from "./master-ab";

const masterAbStore = new Map<string, Map<string, AbSnapshot>>();
import { MASTER_SIGNAL_FLOW, type MasterSignalFlowStageId } from "../mastering/signalFlow";
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
import { applyParamIntent } from "../intent/param-intent";
import {
  clearAdjustmentLedger,
  recordEffectAdjustment,
  recordFaderAdjustment,
  recordParamAdjustment,
} from "../intent/adjustment-recording";
import { transcribeTrack } from "../reference/transcribe";
import { unsunoCommand } from "../reference/unsuno";
import { restyleCommand } from "../reference/restyle";
import { regenerateStyleCommand } from "../reference/regen-style";
import {
  projectFingerprint,
  similarityAdvisory,
  sourceFingerprintFromTranscription,
  type SourceCompositionFingerprint,
} from "../analysis/similarity-advisory";
import type { SongSectionSpec } from "../intent/song";
import { reviseSectionTransitions } from "../intent/song";
import { applyCompoundIntent } from "../intent/compound";
import { productionReadback } from "../intent/production";
import {
  applyAutomateIntent,
  applyGrooveIntent,
  applyMarkerIntent,
  applySectionGrooveIntent,
} from "../intent/studio-words";
import { applyClipArrangeOps, applyArrangeOps, sceneRoleOf } from "../intent/arrangeWords";
import { applySoundSwapIntent, applyStepEditIntent } from "../intent/sound-words";
import { generateLocalResult } from "../intent/pipeline";
import { MCP_PLAYBOOK_TEXT, MCP_VOCAB_TEXT } from "./onboarding";
import { normalizeIntent } from "../intent/normalize";
import { inferPadRole } from "../ai/pad-roles";
import type { DrumTrack, InstrumentKind, Scene, Track, AutomationTarget, AutomationLane } from "../project-model/types";
import { MUSICAL_KEYS } from "../project-model/types";
import { resolveProductionTargets } from "../intent/production";
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
// The factory bank is lazy (presets/factory is ~130 KB): tools that read it
// warm it through the loader instead of forcing it into the MCP graph. The
// tool layer is a SELF-SUFFICIENT entry surface — a headless host or a test
// that calls kyx_tracks loadPreset must not need the UI to have warmed first.
import { factoryPresets, isFactoryPresetsWarm, warmFactoryPresets } from "../presets/factory-loader";
import {
  addAutomationLane,
  addAutomationPoint,
  addToGroup,
  addNote,
  createGroupTrack,
  createReturnTrack,
  deleteReturnTrack,
  setEffectOutputTrimDb,
  addMarker,
  addArrangementClip,
  createDrumTrack,
  createInstrumentTrack,
  createScene,
  deleteArrangementClip,
  deleteArrangementClipRipple,
  deleteAutomationPoint,
  deleteNote,
  deleteTrack,
  moveAutomationPoint,
  moveEffect,
  moveEffectToIndex,
  moveNote,
  moveArrangementClipRipple,
  resizeArrangementClipRipple,
  splitArrangementClipAtTick,
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
  duplicateTrack,
  setTrackParams,
  snapshot,
  toggleEffectBypass,
  splitAudioClipAtTick,
  updateAudioClip,
  addEffectToTracks,
  setTimeSignature,
} from "../commands/commands";
// F2 eager diet: intent graph loads with the MCP surface, not at boot.
import { applyExactIntentCommand, applyProductionIntentCommand } from "../commands/intentRouting";
import { applyGenerationResultCommand } from "../commands/aiPattern";
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
  /**
   * MCP-standard tool annotations (Wave 1/A trust layer). Derived from the
   * risk table in agentTrust.ts — `readOnlyHint` lets a client run reads
   * without asking, `destructiveHint` tells it to confirm removals.
   */
  annotations?: McpToolAnnotations;
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
    /** F2: how this owner reacts to machine proposals (local ledger, absent when empty). */
    reactions: { type: ["object", "null"] },
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
/** kyx_import_sfz — bounded read-back of the imported library mapping. */
const OUTPUT_SFZ_IMPORT: McpOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    trackId: { type: "string" },
    fallbackSampleId: { type: "string" },
    importedSamples: { type: "number" },
    velocityLayers: { type: "number" },
    missingSamples: { type: "number" },
    skippedSamples: { type: "number" },
  },
  required: [
    "name",
    "trackId",
    "fallbackSampleId",
    "importedSamples",
    "velocityLayers",
    "missingSamples",
    "skippedSamples",
  ],
};
/** kyx_undo — exact completed step count and bounded action labels. */
const OUTPUT_UNDO: McpOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["undo", "redo"] },
    requestedSteps: { type: "integer", minimum: 1, maximum: 20 },
    completedSteps: { type: "integer", minimum: 0, maximum: 20 },
    revertedLabels: {
      type: "array",
      maxItems: 20,
      items: { type: "string", maxLength: 240 },
    },
    partialFailure: { type: "string", maxLength: 2_000 },
  },
  required: ["action", "requestedSteps", "completedSteps", "revertedLabels"],
};
/** kyx_blind_ab — bounded planning, trial recording and verdict read-back. */
const OUTPUT_BLIND_AB: McpOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    op: { type: "string", enum: ["plan", "record", "verdict", "reset"] },
    status: { type: "string", enum: ["planned", "recorded", "summarized", "no_trials", "cleared"] },
    lane: { type: "string", maxLength: BLIND_AB_MAX_LANE_LENGTH },
    gains: {
      type: "object",
      additionalProperties: false,
      properties: {
        matched: { type: "boolean" },
        targetLufs: { type: ["number", "null"] },
        gainDbA: { type: "number", minimum: -12, maximum: 12 },
        gainDbB: { type: "number", minimum: -12, maximum: 12 },
        note: { type: "string" },
      },
      required: ["matched", "targetLufs", "gainDbA", "gainDbB", "note"],
    },
    trial: {
      type: "object",
      additionalProperties: false,
      properties: {
        lane: { type: "string", maxLength: BLIND_AB_MAX_LANE_LENGTH },
        xWas: { type: "string", enum: ["A", "B"] },
        answer: { type: "string", enum: ["A", "B"] },
        correct: { type: "boolean" },
        reactionMs: { type: "integer", minimum: 0, maximum: BLIND_AB_MAX_REACTION_MS },
        receivedAt: { type: "integer", minimum: 0 },
      },
      required: ["lane", "xWas", "answer", "correct", "receivedAt"],
    },
    summary: {
      type: "object",
      additionalProperties: false,
      properties: {
        lane: { type: "string", maxLength: BLIND_AB_MAX_LANE_LENGTH },
        total: { type: "integer", minimum: 0 },
        correct: { type: "integer", minimum: 0 },
        pValue: { type: "number", minimum: 0, maximum: 1 },
        hastyExcluded: { type: "integer", minimum: 0 },
        verdict: { type: "string" },
      },
      required: ["lane", "total", "correct", "pValue", "hastyExcluded", "verdict"],
    },
    total: { type: "integer", minimum: 0 },
    correct: { type: "integer", minimum: 0 },
    pValue: { type: "number", minimum: 0, maximum: 1 },
    hastyExcluded: { type: "integer", minimum: 0 },
    verdict: { type: "string" },
    clearedLanes: { type: "integer", minimum: 0, maximum: BLIND_AB_MAX_LANES },
    clearedTrials: { type: "integer", minimum: 0, maximum: BLIND_AB_MAX_TRIALS },
  },
  required: ["op", "status"],
};
const MIX_IDEA_MAX_LENGTH = 1_000;
const MIX_IDEA_TARGET_MAX_LENGTH = 128;
/** kyx_mix_idea — proposal, application and measured preview read-back. */
const OUTPUT_MIX_IDEA: McpOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["planned", "applied", "previewed", "rejected"] },
    ok: { type: "boolean" },
    applied: { type: "boolean" },
    reason: { type: "string", maxLength: 2_000 },
    interpreter: { type: "string", enum: ["production", "assistant"] },
    targets: { type: "array", items: { type: "string" } },
    goals: { type: "array", items: { type: "string" } },
    label: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          trackId: { type: "string" },
          track: { type: "string" },
          device: { type: "string" },
          params: { type: "string" },
          reason: { type: "string" },
        },
        required: ["trackId", "track", "device", "params", "reason"],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    preview: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string" },
        label: { type: "string" },
        targets: { type: "array", items: { type: "string" } },
        goals: { type: "array", items: { type: "string" } },
        interpreter: { type: "string", enum: ["production", "assistant"] },
        beforeLufs: { type: ["number", "null"] },
        afterLufs: { type: ["number", "null"] },
        matchGainDb: { type: "number", minimum: -12, maximum: 12 },
        seconds: { type: "number", minimum: 0 },
        studioBound: { type: "boolean" },
      },
      required: [
        "laneId",
        "label",
        "targets",
        "goals",
        "interpreter",
        "beforeLufs",
        "afterLufs",
        "matchGainDb",
        "seconds",
        "studioBound",
      ],
    },
  },
  required: ["status", "ok", "applied"],
};
/** kyx_mix — applied producer-profile result. */
const OUTPUT_MIX: McpOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["applied", "neutral", "already_matched"] },
    genre: { type: "string" },
    decisionCount: { type: "integer", minimum: 0 },
    summary: { type: "array", items: { type: "string" } },
  },
  required: ["status", "genre", "decisionCount", "summary"],
};
/** kyx_arrange — generated scenes, clips and cue-marker read-back. */
const OUTPUT_ARRANGE: McpOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["arranged", "empty", "partial"] },
    genre: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          role: {
            type: "string",
            enum: ["intro", "build", "drop", "break", "outro", "fill", "verse", "chorus", "bridge", "custom"],
          },
          startBar: { type: "integer", minimum: 1, description: "Human-facing 1-based bar number." },
          bars: { type: "integer", minimum: 1, description: "Section length in bars." },
          intensity: { type: "number", minimum: 0, maximum: 1, description: "Normalized section intensity." },
        },
        required: ["label", "role", "startBar", "bars", "intensity"],
      },
    },
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          role: {
            type: "string",
            enum: ["intro", "build", "drop", "break", "outro", "fill", "verse", "chorus", "bridge", "custom"],
          },
          intensity: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["id", "name", "role", "intensity"],
      },
    },
    clips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          sceneId: { type: "string" },
          startBar: { type: "integer", minimum: 0, description: "Project-model 0-based start bar." },
          lengthBars: { type: "integer", minimum: 1, description: "Clip length in bars." },
        },
        required: ["id", "sceneId", "startBar", "lengthBars"],
      },
    },
    markers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: { type: "string", enum: ["drop", "buildup", "riser", "impact", "cue", "custom"] },
          tick: { type: "integer", minimum: 0, description: "Absolute project tick (PPQ 480)." },
        },
        required: ["id", "name", "type", "tick"],
      },
    },
    sceneCount: { type: "integer", minimum: 0 },
    clipCount: { type: "integer", minimum: 0 },
    cueMarkerCount: { type: "integer", minimum: 0 },
    totalBars: { type: "integer", minimum: 0 },
    undoSteps: { type: "integer", minimum: 0, maximum: 1 },
  },
  required: [
    "status",
    "genre",
    "sections",
    "scenes",
    "clips",
    "markers",
    "sceneCount",
    "clipCount",
    "cueMarkerCount",
    "totalBars",
    "undoSteps",
  ],
};
/** kyx_takes — take-group inventory and comp/delete outcomes. */
const OUTPUT_TAKES: McpOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["empty", "listed", "activated", "already_active", "deleted", "already_absent", "partial"],
    },
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          trackId: { type: "string" },
          track: { type: "string" },
          activeTakeId: { type: "string" },
          compTakeId: { type: ["string", "null"] },
          takes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                takeId: { type: ["string", "null"] },
                clipCount: { type: "integer", minimum: 0 },
              },
              required: ["takeId", "clipCount"],
            },
          },
        },
        required: ["id", "trackId", "track", "activeTakeId", "compTakeId", "takes"],
      },
    },
    groupId: { type: "string" },
    takeId: { type: "string" },
    activeTakeId: { type: "string" },
    clipCount: { type: "integer", minimum: 0 },
    deletedClipCount: { type: "integer", minimum: 0 },
    remainingTakeClipCount: { type: "integer", minimum: 0 },
    remainingGroupClipCount: { type: "integer", minimum: 0 },
    groupRemaining: { type: "boolean" },
    undoSteps: { type: "integer", minimum: 0, maximum: 1 },
  },
  required: ["status"],
};
/** kyx_routing — route inventory and one-command mixer changes. */
const OUTPUT_ROUTING: McpOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: [
        "listed",
        "created",
        "routed",
        "already_routed",
        "unrouted",
        "already_unrouted",
        "send_set",
        "send_unchanged",
        "return_gain_set",
        "return_gain_unchanged",
        "return_created",
        "return_removed",
        "partial",
      ],
    },
    routes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          trackId: { type: "string" },
          track: { type: "string" },
          destination: { type: "string" },
          destinationName: { type: "string" },
        },
        required: ["trackId", "track", "destination", "destinationName"],
      },
    },
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          memberCount: { type: "integer", minimum: 0 },
        },
        required: ["id", "name", "memberCount"],
      },
    },
    returns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          gain: { type: "number", minimum: 0, maximum: 1.5 },
          sends: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                trackId: { type: "string" },
                track: { type: "string" },
                level: { type: "number", minimum: 0, maximum: 1.5 },
              },
              required: ["trackId", "track", "level"],
            },
          },
        },
        required: ["id", "name", "gain", "sends"],
      },
    },
    groupId: { type: "string" },
    groupName: { type: "string" },
    returnId: { type: "string" },
    returnName: { type: "string" },
    returnExists: { type: "boolean" },
    trackIds: { type: "array", items: { type: "string" } },
    changedTrackIds: { type: "array", items: { type: "string" } },
    sendLevel: { type: "number", minimum: 0, maximum: 1.5 },
    requestedLevel: { type: "number" },
    returnGain: { type: "number", minimum: 0, maximum: 1.5 },
    removedSendCount: { type: "integer", minimum: 0 },
    undoSteps: { type: "integer", minimum: 0, maximum: 1 },
  },
  required: ["status"],
};
/** kyx_markers — compact timeline cues with stable marker IDs. */
const OUTPUT_MARKERS: McpOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["listed", "created", "renamed", "already_named", "removed", "missing", "partial"],
    },
    markers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: { type: "string", enum: ["drop", "buildup", "riser", "impact", "cue", "custom"] },
          tick: { type: "integer", minimum: 0 },
          bar: { type: "integer", minimum: 1 },
          linkedClipId: { type: "string" },
        },
        required: ["id", "name", "type", "tick", "bar"],
      },
    },
    markerId: { type: "string" },
    name: { type: "string" },
    markerType: { type: "string", enum: ["drop", "buildup", "riser", "impact", "cue", "custom"] },
    tick: { type: "integer", minimum: 0 },
    bar: { type: "integer", minimum: 1 },
    linkedClipId: { type: "string" },
    undoSteps: { type: "integer", minimum: 0, maximum: 1 },
  },
  required: ["status"],
};
/** kyx_sections — current section inventory plus verified edit outcomes. */
const OUTPUT_SECTIONS: McpOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: [
        "listed",
        "created",
        "removed",
        "duplicated",
        "reordered",
        "already_ordered",
        "resized",
        "intensity_set",
        "already_set",
        "partial",
      ],
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          role: { type: "string" },
          index: { type: "integer", minimum: 1 },
          startBar: { type: "integer", minimum: 1 },
          bars: { type: "integer", minimum: 1 },
          intensity: { type: "number", minimum: 0, maximum: 1 },
          clipCount: { type: "integer", minimum: 0 },
        },
        required: ["id", "name", "role", "index", "bars", "intensity", "clipCount"],
      },
    },
    sectionId: { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
    index: { type: "integer", minimum: 1 },
    startBar: { type: "integer", minimum: 1 },
    bars: { type: "integer", minimum: 1 },
    intensity: { type: "number", minimum: 0, maximum: 1 },
    clipCount: { type: "integer", minimum: 0 },
    undoSteps: { type: "integer", minimum: 0, maximum: 1 },
  },
  required: ["status", "sections", "undoSteps"],
};
/** kyx_music — strict scalar musical-state setters and note-transpose read-back. */
const OUTPUT_MUSIC: McpOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["set", "already_set", "transposed", "no_notes", "partial"] },
    op: { type: "string", enum: ["setTempo", "setKey", "setPatternLength", "setTimeSignature", "transposeAll"] },
    bpm: { type: "integer", minimum: 20, maximum: 300 },
    key: { type: "string", enum: [...MUSICAL_KEYS] },
    patternId: { type: "string" },
    steps: { type: "integer", minimum: 16, maximum: 128 },
    numerator: { type: "integer", minimum: 1, maximum: 16 },
    denominator: { type: "integer", enum: [2, 4, 8, 16] },
    target: { type: "string", enum: ["all", "bass", "lead", "chords", "vocal"] },
    requestedSemitones: { type: "integer", minimum: -127, maximum: 127 },
    targetNoteCount: {
      type: "integer",
      minimum: 0,
      description: "Active-pattern notes in the resolved melodic target.",
    },
    transposedNotes: {
      type: "integer",
      minimum: 0,
      description: "Notes that landed the full requested semitone shift.",
    },
    partialNotes: {
      type: "integer",
      minimum: 0,
      description: "Target notes that did not land the full shift, including MIDI-boundary clamps.",
    },
    undoSteps: { type: "integer", minimum: 0, maximum: 1 },
  },
  required: ["status", "op", "undoSteps"],
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
            "automation",
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
    outputSchema: OUTPUT_UNDO,
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
      "Read the current section inventory or add/remove/duplicate/reorder/resize " +
      "named sections and set section intensity. Target existing sections by " +
      "stable sceneId, exact name, 1-based index, or an unambiguous role. " +
      "Writes use one undoable command and return committed section read-back. " +
      "Supply requestId when retrying a non-idempotent add/duplicate request.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "add", "remove", "duplicate", "reorder", "resize", "intensity"] },
        intensity: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "op=intensity — target scene intensity 0..1",
        },
        scene: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "Exact section name or role target for existing-section edits",
        },
        index: {
          type: "integer",
          minimum: 1,
          description: "1-based section index (alternative to sceneId/name/role)",
        },
        value: { type: "number", minimum: 0, maximum: 1, description: "op=intensity — the target intensity 0..1" },
        sceneId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Exact stable target scene ID from kyx_sections list",
        },
        role: {
          type: "string",
          enum: ["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro", "fill"],
          description: "Section role to add, or a unique existing-role target for edits",
        },
        direction: { type: "string", enum: ["earlier", "later"], description: "op=reorder direction (default later)" },
        bars: { type: "integer", minimum: 1, maximum: 64, description: "For resize" },
      },
      required: ["op"],
    },
    outputSchema: OUTPUT_SECTIONS,
  },
  {
    name: "kyx_markers",
    description:
      "List timeline markers, add a cue at a 1-based bar, or rename/remove one. " +
      "Exact markerId wins when provided; otherwise rename/remove target the nearest marker to bar. " +
      "Writes return the committed marker read-back and explicit no-op status.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "add", "remove", "rename"] },
        markerId: { type: "string", maxLength: 128, description: "Exact target for rename/remove; overrides bar" },
        bar: { type: "integer", minimum: 1, description: "1-based bar for add, or nearest-marker anchor" },
        name: { type: "string", maxLength: 40, description: "Optional for add; required for rename" },
      },
      required: ["op"],
    },
    outputSchema: OUTPUT_MARKERS,
  },
  {
    name: "kyx_tracks",
    description:
      "Track CRUD + absolute mixer setters: add a drum or instrument " +
      "track, remove/rename by family or exact trackId (group tracks are " +
      "not addressable here — removing the last track is declined; " +
      "duplicate clones one track with its FX and routing), or set " +
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
            "duplicate",
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
      "grid or key on one track, transpose a family's whole line. Targets " +
      "accept an exact trackId or a melodic family. Notes are addressed by " +
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
        trackId: { type: "string", description: "Exact track ID; takes precedence over family." },
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
        key: {
          type: "string",
          enum: [...MUSICAL_KEYS],
          description: 'quantize this track to a supported scale, e.g. "C Major", "A Natural Minor"',
        },
        semitones: { type: "integer", minimum: -127, maximum: 127, description: "transpose shift (non-zero)" },
      },
      required: ["op"],
    },
  },
  {
    name: "kyx_music",
    description:
      "Structured MUSICAL STATE: set tempo, set musical key, change the active " +
      "pattern's length, set meter, or transpose active-pattern melodic notes. " +
      "Changes use the canonical exact-intent command and return committed " +
      "read-back; no-ops add no undo step. Numeric inputs are strict, and " +
      "retries of transposeAll should include requestId.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["setTempo", "setKey", "setPatternLength", "transposeAll", "setTimeSignature"] },
        numerator: { type: "integer", minimum: 1, maximum: 16, description: "setTimeSignature — numerator" },
        denominator: {
          type: "integer",
          enum: [2, 4, 8, 16],
          description: "setTimeSignature — beat unit (denominator)",
        },
        bpm: { type: "integer", minimum: 20, maximum: 300, description: "setTempo" },
        key: {
          type: "string",
          enum: [...MUSICAL_KEYS],
          description: "setKey — choose from KYX's supported musical-key catalog",
        },
        steps: { type: "integer", minimum: 16, maximum: 128, description: "setPatternLength (16 steps per bar)" },
        semitones: { type: "integer", minimum: -127, maximum: 127, description: "transposeAll shift (non-zero)" },
        target: {
          type: "string",
          enum: ["all", "bass", "lead", "chords", "vocal"],
          description: 'transposeAll scope (default "all"); drum tracks do not contain pitched notes',
        },
      },
      required: ["op"],
    },
    outputSchema: OUTPUT_MUSIC,
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
      'plus per-track peak/RMS. scope:"fx" reports the telemetry of EVERY ' +
      "inserted effect (KOREŇ f0/clarity/+dB harmonics/key scaler, dynamics " +
      "gain reduction, plugin frames) — the closed loop for verifying an " +
      "effect change instead of assuming it. Read-only snapshot of the " +
      "RUNNING engine; honestly refused when no engine/audio context is " +
      "live. LUFS-I needs a few seconds of playback to stabilize.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["master", "tracks", "fx", "all"], description: "Default all" },
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
      "summary), audioList the track-lane waveforms in detail, or edit. " +
      "Scene ops target the clip COVERING an anchor bar: move/resize/" +
      "split/duplicate/delete, plus moveRipple/resizeRipple/deleteRipple " +
      "which close the gap after the edit the way the UI's RIPPLE toggle " +
      "does, and copy/cut/paste for the clipboard (cut and delete are " +
      "D4-gated; the MCP clipboard is per-session, never persisted). " +
      "Audio ops address a track (trackId or family) + the anchor bar its " +
      "clip covers: audioMove/audioSplit/audioUpdate (gain, fadeIn, " +
      "fadeOut, reverse, loop)/audioStretch (rate 0.25..4, optional " +
      "bars)/audioSlip (offsetSec - which part of the source plays)/" +
      "audioDuplicate/audioMute/audioNudge (whole bars)/audioSlice (" +
      "sliceTimesSec)/audioStrip (segments to keep)/audioConsolidate " +
      "(bufferId + range)/audioCrossfade/audioDelete (D4). " +
      "Values are native (gain linear, fades in seconds).",
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
            "audioStretch",
            "audioSlip",
            "audioCrossfade",
            "audioDuplicate",
            "audioMute",
            "audioNudge",
            "audioSlice",
            "audioStrip",
            "audioConsolidate",
            "audioDelete",
            "split",
            "moveRipple",
            "resizeRipple",
            "deleteRipple",
            "copy",
            "cut",
            "paste",
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
        rate: {
          type: "number",
          minimum: 0.25,
          maximum: 4,
          description: "For audioStretch — playback speed factor (2 = twice as fast)",
        },
        offsetSec: {
          type: "number",
          minimum: 0,
          description: "For audioSlip — seconds into the source (which part plays)",
        },
        curve: {
          type: "string",
          enum: ["linear", "equal"],
          description: "For audioCrossfade — fade curve (default linear)",
        },
        fadeOut: { type: "number", minimum: 0, description: "For audioUpdate — fade-out seconds" },
        reverse: { type: "boolean", description: "For audioUpdate — play the clip backwards" },
        loop: { type: "boolean", description: "For audioUpdate — loop the trimmed content over the clip length" },
        muted: { type: "boolean", description: "For audioMute — true mutes, false unmutes (default true)" },
        sliceTimesSec: {
          type: "array",
          items: { type: "number", minimum: 0 },
          description:
            "For audioSlice — wall seconds from the clip's first audible moment; the clip is kept and segments are laid out after it",
        },
        segments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              startSec: { type: "number", minimum: 0 },
              endSec: { type: "number", minimum: 0 },
            },
            required: ["startSec", "endSec"],
          },
          description: "For audioStrip — the ranges to KEEP; the clip is replaced by them",
        },
        sourceDurationSec: {
          type: "number",
          minimum: 0,
          description: "For audioStrip — decoded source duration, bounds the audible window (optional)",
        },
        bufferId: {
          type: "string",
          description:
            "For audioConsolidate — the rendered bounce buffer the merged clip points at (the tool cannot render it itself)",
        },
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
    outputSchema: OUTPUT_SFZ_IMPORT,
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
    name: "kyx_mix_idea",
    description:
      "TEXT-TO-MIX REMOTE CONTROL — one natural-language mix idea, the full " +
      "loop: 'warm it up and glue the drums' → a PLAN of concrete device " +
      "steps with the WHY attributed per step (nothing applied) → apply:true " +
      "lands the whole idea as ONE undo step → verify with kyx_render_summary " +
      "and let the human judge via kyx_blind_ab. Understands production " +
      "concepts (warmer, punchier, brighter, deeper, wider, air…) and their " +
      "targets from the sentence itself (drums, bass, lead, chords, the mix, " +
      "kick/snare/hats); an explicit target overrides the text. Plan first — " +
      "the plan is cheap and pure, the apply is a mutation.",
    inputSchema: {
      type: "object",
      properties: {
        idea: {
          type: "string",
          maxLength: MIX_IDEA_MAX_LENGTH,
          description: "The mix idea in plain language, e.g. 'warm it up and glue the drums'",
        },
        target: {
          type: "string",
          maxLength: MIX_IDEA_TARGET_MAX_LENGTH,
          description:
            'Optional target override: "drums | bass | lead | chords | mix | kick | snare | hats" or a track id from kyx_state',
        },
        apply: { type: "boolean", description: "false (default) = plan only; true = apply as ONE undo step" },
        preview: {
          type: "boolean",
          description:
            "true = render the BEFORE/AFTER masters, level-match them and arm the studio MIX PREVIEW card so the human can listen before you apply. Read-only; render-bound transports only",
        },
      },
      required: ["idea"],
    },
    outputSchema: OUTPUT_MIX_IDEA,
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
        mood: {
          type: "string",
          maxLength: 128,
          description: "Optional mood (dark, chill, warm, aggressive...)",
        },
        energy: { type: "number", minimum: 0, maximum: 1 },
        tone: { type: "string", enum: ["dark", "bright", "warm", "cold"] },
        reverb: { type: "string", enum: ["more", "less", "huge"] },
        punch: { type: "string", enum: ["more", "less"] },
        pump: { type: "string", enum: ["on", "off"] },
      },
      required: ["genre"],
    },
    outputSchema: OUTPUT_MIX,
  },
  {
    name: "kyx_arrange",
    description:
      "PRODUCER MOVE - lay out the genre song form as scenes + clips + " +
      "cue markers (intro/build/drop/... with per-section intensity) in ONE " +
      "undo step; returns created scene/clip/cue IDs and counts. Refused when " +
      "the arrangement already has clips: use " +
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
    outputSchema: OUTPUT_ARRANGE,
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
      "cycles are impossible by construction. Successful writes return committed " +
      "values and explicit no-op status. setSend/setReturnGain/createReturn " +
      "cover the send-bus mixer; removeReturn drops a bus and every send reference " +
      "into it (destructive-gated).",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "list",
            "createGroup",
            "addToGroup",
            "removeFromGroup",
            "setSend",
            "setReturnGain",
            "createReturn",
            "removeReturn",
          ],
        },
        trackId: { type: "string", maxLength: 128, description: "Exact track id — overrides family when present" },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Family alternative to trackId (applies to every resolved track)",
        },
        groupId: { type: "string", maxLength: 128, description: "For addToGroup — the group track id (op:list)" },
        groupName: { type: "string", maxLength: 40, description: "For addToGroup — group name alternative to groupId" },
        name: {
          type: "string",
          maxLength: 40,
          description: "For createGroup/createReturn — optional name (default: Group N / Return N)",
        },
        returnId: {
          type: "string",
          maxLength: 128,
          description: "For setSend/setReturnGain/removeReturn — the return bus id (op:list)",
        },
        returnName: { type: "string", maxLength: 40, description: "Return bus name alternative to returnId" },
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
    outputSchema: OUTPUT_ROUTING,
  },
  {
    name: "kyx_unsuno",
    description:
      "UN-SUNO — TRACK TO EDITABLE PROJECT (ADR 0019, the demo pipeline). " +
      "transcribe: decode a user-library audio id, transcribe it (tempo, key, " +
      "drums, bass, chords — deterministic DSP lanes) and BUILD a playable " +
      "project: drum/bass/keys tracks, section patterns, scenes, markers — " +
      "ONE undo step. Requires a live session able to load user-sample audio " +
      "(headless servers refuse honestly). restyle: swap the BAND through an " +
      "artist preset (genre kit + instrument presets + mix profile) while the " +
      "composition stays byte-equal. regen: REGENERATE section content in the " +
      "artist's style (genre groove drums + bass rhythm) keeping the source " +
      "harmony and structure. similarity: numerical composition overlap of " +
      "the CURRENT project vs the transcribed source (percent + verdict — " +
      "NOT legal clearance). The source fingerprint is session-scoped: " +
      "similarity works after a transcribe in the same session.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["transcribe", "restyle", "regen", "similarity"] },
        sourceId: {
          type: "string",
          description:
            "User-library audio id (required for transcribe) — e.g. from kyx_import or the user samples list",
        },
        artist: {
          type: "string",
          description: 'Artist label for restyle/regen — exact label (e.g. "travis scott", "fisher")',
        },
        separation: {
          type: "string",
          enum: ["off", "hpss"],
          description:
            'transcribe: "off" (default, full mix) or "hpss" (Tier-1 guide stems slow the pass but lift bass/drums lanes)',
        },
      },
      required: ["action"],
    },
  },
  {
    name: "kyx_master",
    description:
      "Mastering read-back and ZENIT controls. status reports the ordered global " +
      "KYX MASTER signal path, delivery profile, runtime fallbacks and a live " +
      "meter snapshot when available; it also lists ZENIT instances. Other ops " +
      "insert or manage the ZENIT composite mastering device (ADR 0020) on a " +
      "track/group bus. op:ab saves, compares and restores session-only " +
      "snapshots of ZENIT/APEX/SPAN/TIDE parameters and output trims. A group-hosted ZENIT shapes that stem before the final " +
      "global master chain. Use platform/land for profile checks and explicit " +
      "loudness adjustment; live meter snapshots are not full-song reports.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["add", "preset", "trim", "assist", "iterate", "land", "platform", "stems", "ab", "remove", "status"],
        },
        trackId: { type: "string", description: "Exact track id — overrides family when present" },
        family: {
          type: "string",
          enum: ["drums", "bass", "chords", "lead", "vocal"],
          description: "Family alternative to trackId",
        },
        target: {
          type: "string",
          enum: ["streaming", "club", "vinyl"],
          description: "For op:preset — the mastering target shape",
        },
        profile: {
          type: "string",
          enum: ["streaming", "apple", "loud", "vinyl", "custom"],
          description: "For op:land / op:platform / op:assist — the delivery target profile to evaluate",
        },
        targetLufs: {
          type: "number",
          minimum: -24,
          maximum: 0,
          description: "For op:assist / op:land / op:platform — loudness target override",
        },
        targetTruePeakDb: {
          type: "number",
          minimum: -12,
          maximum: 0,
          description: "For op:land / op:platform — maximum true peak in dBTP (overrides the profile)",
        },
        insert: {
          type: "boolean",
          description: "For op:assist — insert any missing mastering devices on the bus before applying the plan",
        },
        action: {
          type: "string",
          enum: ["save", "list", "compare", "restore"],
          description: "For op:ab — snapshot action",
        },
        import: {
          type: "array",
          description:
            "For op:stems — stem buffers to import as project lanes BEFORE mastering: [{role, bufferId, durationSec}] (roles: vocals/drums/bass/other). The lanes land in one STEMS bus, then get their per-role mastering shapes.",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["vocals", "drums", "bass", "other"] },
              bufferId: { type: "string" },
              durationSec: { type: "number", minimum: 0.1 },
            },
            required: ["role", "bufferId", "durationSec"],
          },
        },
        reference: {
          type: "object",
          description:
            "For op:assist — measured reference values. Each supplied field is compared only with the same measured field on the live master; missing values are skipped, never estimated.",
          properties: {
            lufs: { type: "number" },
            crestDb: { type: "number" },
            correlation: { type: "number", minimum: -1, maximum: 1 },
            hfShare: { type: "number", minimum: 0, maximum: 1 },
            lowEndShare: { type: "number", minimum: 0, maximum: 1 },
          },
        },
        trimDb: {
          type: "number",
          minimum: -18,
          maximum: 12,
          description: "For op:trim — output-trim delta in dB (e.g. target LUFS minus measured LUFS)",
        },
        instance: {
          type: "integer",
          minimum: 1,
          description: "1-based ZENIT instance index when a track carries more than one",
        },
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
      "Reversible (one undo step); returns stable group/take IDs and clip counts. " +
      "deleteTake (destructive-gated) removes every clip of one take.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "activate", "deleteTake"] },
        groupId: {
          type: "string",
          maxLength: 128,
          description: "For activate/deleteTake — the take group id (op:list)",
        },
        takeId: { type: "string", maxLength: 128, description: "The take id to activate or delete" },
      },
      required: ["op"],
    },
    outputSchema: OUTPUT_TAKES,
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
        lane: {
          type: "string",
          maxLength: BLIND_AB_MAX_LANE_LENGTH,
          description: "Trial lane name (record/verdict), e.g. 'tilt-vs-flat' (max 128 characters)",
        },
        xWas: { type: "string", enum: ["A", "B"], description: "For record — which side was X" },
        answer: { type: "string", enum: ["A", "B"], description: "For record — what the listener answered" },
        reactionMs: {
          type: "integer",
          minimum: 0,
          maximum: BLIND_AB_MAX_REACTION_MS,
          description: "For record — milliseconds from first playback (0–24 hours)",
        },
        confirm: {
          type: "boolean",
          description: "For reset — must be true to clear all session trial lanes and their accumulated evidence",
        },
      },
      required: ["op"],
    },
    outputSchema: OUTPUT_BLIND_AB,
  },
];

// P1-B: make the idempotency envelope DISCOVERABLE in every tool schema (the
// wrapper accepts `requestId` on any tool; the description states exactly
// when it matters). Injected once here instead of hand-editing 37 literals —
// the mirrors regenerate from this array.
const REQUEST_ID_PROPERTY: Record<string, unknown> = {
  type: "string",
  maxLength: 128,
  description:
    "Optional idempotency key. Retrying a mutating or side-effecting call with the same requestId in this session returns the original outcome (replayed: true) instead of re-executing — safe retry for relative ops (deltas, groove steps, batches) and committed session records. Reads always execute fresh; failures with no committed change are not remembered, so correcting the request and retrying with the same id re-executes. A partially failed call with committed changes is replayed to avoid applying its committed prefix twice.",
};
for (const def of MCP_TOOLS) {
  def.inputSchema.properties.requestId = { ...REQUEST_ID_PROPERTY };
  def.inputSchema.properties.dryRun = {
    type: "boolean",
    description:
      "Preview mode: run document logic against a sandbox and report what WOULD change. Refused for runtime/export-side operations (transport, export, gallery, audio preview), SFZ import, checkpoint save/delete, and live mix preview because those effects cannot be sandboxed.",
  };
  // Wave 1/A: MCP-standard annotations from the risk table — clients can run
  // reads autonomously and confirm destructive calls per spec. Derived, never
  // hand-maintained: agentTrust.ts is the single classification source.
  def.annotations = toolAnnotations(def.name);
}

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
  /** Runtime-only master readiness; absent in older/headless meter providers. */
  masterRuntime?: {
    available: boolean;
    degradedStages: Array<{ stageId: string; reason: string }>;
    degradedInserts: Array<{ fxId: string; reason: string }>;
  };
}

/**
 * Live telemetry of ONE inserted effect — the closed loop an agent needs to
 * verify a change instead of assuming it. KOREŇ reports its tracked f0, the
 * harmonic gain and the key scaler; dynamics report their gain-reduction
 * readings; PRISM/VLYX report their own frames. `meters` is whatever the
 * wrapper's `getMeters()` returns — the tool renders known scalars and never
 * invents meaning for the rest.
 */
export interface McpFxMeterReading {
  /** Track, group or return that owns the insert; "master" for the master chain. */
  ownerId: string;
  ownerName: string;
  fxId: string;
  type: string;
  /** Display name ("GROW", "PRISM", …). */
  name: string;
  bypassed: boolean;
  meters: unknown;
  gainReduction?: ReadonlyArray<{ label: string; gainReductionDb: number }> | null;
}

export interface McpFxMeterSnapshot {
  effects: McpFxMeterReading[];
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
  /** THE AI's EARS (closed-loop): renders the current doc pre-master → stereo PCM. Populated by the transport bridge. */
  renderMix?: () => Promise<{ channels: Float32Array[]; sampleRate: number } | null>;
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
  /** Live per-effect telemetry (kyx_meter scope:"fx"). Absent on transports
   * without a live engine → the tool refuses honestly. */
  fxMeters?: () => McpFxMeterSnapshot | null;
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
   * UN-SUNO (kyx_unsuno) — load a user-library audio id as MONO PCM for the
   * transcription lanes. Present when a live session can decode + read the
   * user sample bank; absent → kyx_unsuno transcribe refuses honestly
   * (headless servers have no audio to transcribe).
   */
  loadSampleMono?: (sampleId: string) => Promise<{ mono: Float32Array; sampleRate: number } | null>;

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
  /** kyx_mix_idea preview: render the before/after pair, measure, arm the
   * session lane the studio chip picks up. Read-only over the project. */
  mixPreview?: (request: { idea: string; target?: string }) => Promise<import("./mix-preview").MixPreviewOutcome>;
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
  /** Internal marker for committed non-document side effects; stripped before returning to transports. */
  idempotencyCommitted?: boolean;
  /** Optional standard MCP audio attachment (base64 encoded). */
  audio?: McpAudioContent;
  /** P1-B idempotency: true when this result is a REPLAY of the outcome
   * already produced under the caller's requestId — nothing re-executed.
   * The replay is honest even if the change was undone since: the
   * requestId names ONE logical operation, and the agent owns undo/redo. */
  replayed?: boolean;
  /** P1-D document attribution: the document this mutation landed on, as of
   * AFTER the command (a rename is reported renamed). Mutating results
   * only; the same facts ride the text as a human-readable line, which is
   * the one channel every transport forwards verbatim. */
  docId?: string;
  docName?: string;
  /** P2-B typed error contract (control-surface audit 2026-10-13, GAP-08):
   * a stable code from the closed {@link McpErrorCode} set, so an agent can
   * branch on WHAT failed instead of substring-matching the text. Every
   * `isError` result carries one; the text stays the human-readable
   * explanation with the actionable detail. */
  errorCode?: McpErrorCode;
  /** P2-C dry-run: true when this result previews a run against a sandbox
   * document — the live store was never touched (`mutated` is false and the
   * text names the commands that WOULD have applied). */
  dryRun?: boolean;
}

/**
 * P2-B — the CLOSED error-code set (control-surface audit 2026-10-13,
 * GAP-08). Eight codes, one per distinct agent-recovery action:
 *
 *   UNKNOWN_TOOL            the tool name itself does not exist — list
 *                           tools again, fix the call
 *   UNKNOWN_REQUEST         the tool exists but the op/action/genre/family
 *                           it names does not — fix the arguments
 *   INVALID_ARGUMENTS       missing, malformed or out-of-range arguments
 *   UNKNOWN_TARGET          a named id/target resolves to nothing in this
 *                           project — pick a target from a read tool
 *   EXECUTION_FAILED        the operation itself failed (command threw,
 *                           render failed) — the text carries the reason
 *   PARTIAL_FAILURE         a compound op stopped mid-form; the text says
 *                           what landed
 *   UNAVAILABLE_ON_TRANSPORT the tool needs a capability this session does
 *                           not have (live engine, export bridge, renderer)
 *   POLICY_REFUSED          a gate declined it (destructive ops locked, mic
 *                           take recording, active-comp protection) — ask
 *                           the user, do not retry blind
 */
export type McpErrorCode =
  | "UNKNOWN_TOOL"
  | "UNKNOWN_REQUEST"
  | "INVALID_ARGUMENTS"
  | "UNKNOWN_TARGET"
  | "EXECUTION_FAILED"
  | "PARTIAL_FAILURE"
  | "UNAVAILABLE_ON_TRANSPORT"
  | "POLICY_REFUSED"
  | "REQUEST_ID_CONFLICT"
  | "INVALID_REQUEST_ID"
  | "RESOURCE_LIMIT";

/** The single shaped constructor for error results — every `isError`
 * result goes through here so the code set stays exhaustive. `overrides`
 * carries the rare fields an error may need beyond the defaults (a
 * partially-applied atomic batch reports `mutated: true` with its
 * per-call ledger in `data`). */
function mcpError(code: McpErrorCode, text: string, overrides?: Partial<McpToolResult>): McpToolResult {
  return { text, mutated: false, isError: true, errorCode: code, ...overrides };
}

const TICKS_PER_BAR = 4 * 480;

/** D4 escalation gate — every destructive op routes through this refusal. */
function destructiveRefusal(): McpToolResult {
  return mcpError(
    "POLICY_REFUSED",
    "declined: destructive MCP ops are locked — the user must allow them " +
      "in the KYX MCP chip (undoable edits still work)",
  );
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
    return mcpError(
      "UNAVAILABLE_ON_TRANSPORT",
      "scene launch is not available over this MCP transport (no seek-capable transport bound)",
    );
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
    return mcpError(
      "UNAVAILABLE_ON_TRANSPORT",
      "seek is not available over this MCP transport (no seek-capable transport bound)",
    );
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

// ── P1-B IDEMPOTENCY LEDGER (control-surface audit 2026-10-13, GAP-04) ──────
//
// Relative operations (gain deltas, groove steps, batch folds) read LIVE
// state and re-apply on every call, so a retried or duplicated agent request
// double-applies — "−2 dB" twice = −4 dB. The fix at the one chokepoint every
// transport shares: an optional caller-supplied `requestId`. The FIRST call
// under an id that mutates the document is remembered (bounded FIFO, capped
// at the undo stack's size); a REPEAT returns that exact original outcome
// marked `replayed: true` instead of re-executing.
//
// Contract (tests: tests/mcp-idempotency.test.ts):
//  - document mutations and explicitly marked committed session side effects
//    are cached — reads always execute fresh, so a retried read never serves
//    stale state;
//  - calls with no committed change are not cached — fixing the args and
//    retrying with the same id re-executes;
//  - entries are scoped to the project document that produced them: the same
//    id in another project executes fresh and re-binds the id there;
//  - a replay does not re-execute even if the change was undone since — the
//    requestId names ONE logical operation, and the agent owns undo/redo;
//  - kyx_batch: a requestId on the batch caches the WHOLE batch outcome (its
//    per-call read-backs included) as one unit; per-call requestIds inside
//    `calls` work too — sub-calls dispatch through the same wrapper.
//  - the ledger is per host process (renderer / hub / stdio host) and
//    evicted deterministically (oldest first).

const IDEMPOTENCY_LEDGER_CAP = 256;

interface IdempotencyEntry {
  docId: string;
  signature: string;
  result: McpToolResult;
}

const idempotencyLedger = new Map<string, IdempotencyEntry>();
interface IdempotencyFlight {
  signature: string;
  done: Promise<void>;
  finish: () => void;
}
const idempotencyFlights = new Map<string, IdempotencyFlight>();

/** Wave 1/A: nesting depth of the CURRENT call (kyx_batch re-enters the
 *  wrapper per sub-call). Recorded in the audit log; the session checkpoint
 *  is taken by the OUTERMOST mutating call. */
let mcpCallDepth = 0;

/** Test/teardown hook — the ledger is otherwise process-lifetime state. */
export function resetMcpIdempotencyLedger(): void {
  idempotencyLedger.clear();
  idempotencyFlights.clear();
  mcpCallDepth = 0;
}

/** P2-C: tools whose side effects are NOT document mutations — a dry-run
 * cannot intercept them (transport drives the live clock; export/gallery
 * write files and network state), so they refuse instead of pretending. */
const NO_DRYRUN_TOOLS: ReadonlySet<string> = new Set([
  "kyx_transport",
  "kyx_export",
  "kyx_publish_gallery",
  "kyx_audio_preview",
]);

function dryRunPolicyRefusal(name: string, args: Record<string, unknown>): string | null {
  if (name === "kyx_batch" && Array.isArray(args.calls)) {
    for (const [index, entry] of args.calls.entries()) {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = entry as { tool?: unknown; args?: unknown };
      if (typeof item.tool !== "string") continue;
      const childArgs =
        item.args != null && typeof item.args === "object" && !Array.isArray(item.args)
          ? (item.args as Record<string, unknown>)
          : {};
      const refusal =
        item.tool === "kyx_batch" ? "nested batches are not supported" : dryRunPolicyRefusal(item.tool, childArgs);
      if (refusal !== null) {
        return `dryRun is unavailable for kyx_batch call ${index + 1} (${item.tool}): ${refusal}`;
      }
    }
  }
  if (NO_DRYRUN_TOOLS.has(name)) {
    return `dryRun applies to document mutations — ${name} drives runtime or export state`;
  }
  if (name === "kyx_blind_ab" && (args.op === "record" || args.op === "reset")) {
    return `dryRun is unavailable for kyx_blind_ab op:${args.op} because it changes the session trial log`;
  }
  if (name === "kyx_import_sfz") {
    return "dryRun is unavailable for kyx_import_sfz because it writes samples to the user library";
  }
  if (name === "kyx_checkpoint" && (args.op === "save" || args.op === "delete")) {
    return `dryRun is unavailable for kyx_checkpoint op:${args.op} because it writes the checkpoint repository`;
  }
  if (name === "kyx_mix_idea" && args.preview === true) {
    return "dryRun is unavailable for kyx_mix_idea preview because it arms live preview state";
  }
  return null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

async function idempotencySignature(agent: string, tool: string, args: unknown): Promise<string> {
  const requestArgs =
    args != null && typeof args === "object" && !Array.isArray(args)
      ? Object.fromEntries(
          Object.entries(args as Record<string, unknown>).filter(([key]) => key !== "requestId" && key !== "dryRun"),
        )
      : args;
  const source = canonicalJson({ agent, tool, args: requestArgs });
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("Web Crypto is unavailable for a safe idempotency check.");
  const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(source)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requestIdConflict(requestId: string): McpToolResult {
  return mcpError(
    "REQUEST_ID_CONFLICT",
    `requestId "${requestId}" is already bound to a different mutating request in this project; choose a fresh requestId`,
  );
}

/**
 * P2-C sandbox context: a wrapper whose `execute` advances a LOCAL document
 * chain instead of the live store. Every handler keeps its real logic —
 * validation, target resolution and command construction all run — while
 * the mutations land on the throwaway chain. Undo/redo and the label list
 * are tracked locally so `kyx_undo` previews work too.
 */
function dryRunContext(ctx: McpToolContext): { ctx: McpToolContext; applied: () => string[] } {
  let current = ctx.getDoc();
  const labels: string[] = [];
  const undoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  const redoStack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
  return {
    ctx: {
      ...ctx,
      getDoc: () => current,
      execute: (command) => {
        const prev = current;
        current = command.execute(current);
        labels.push(command.label);
        undoStack.push({ undo: () => command.undo(prev), redo: () => command.execute(current) });
        redoStack.length = 0;
      },
      undo: () => {
        const entry = undoStack.pop();
        if (entry) {
          current = entry.undo();
          redoStack.push(entry);
        }
      },
      redo: () => {
        const entry = redoStack.pop();
        if (entry) {
          current = entry.redo();
          undoStack.push(entry);
        }
      },
      undoStackLength: () => undoStack.length,
      historyLabels: () => [...labels],
    },
    applied: () => labels,
  };
}

const INSTANCE_INDEXED_MCP_TOOLS = new Set(["kyx_fx", "kyx_plugin_param", "kyx_automation", "kyx_master"]);

function invalidInstanceIndexMessage(name: string, args: unknown): string | null {
  if (!INSTANCE_INDEXED_MCP_TOOLS.has(name) || args == null || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "instance")) return null;
  const instance = record.instance;
  if (typeof instance === "number" && Number.isSafeInteger(instance) && instance >= 1) return null;
  return "instance must be a positive 1-based integer";
}

function invalidRequestIdMessage(args: unknown): string | null {
  if (args == null || typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "requestId") || record.requestId === undefined) return null;
  if (typeof record.requestId !== "string") return "requestId must be a string of at most 128 characters.";
  if (record.requestId.length > 128) return "requestId must be at most 128 characters; it is never truncated.";
  if (record.requestId.trim().length === 0) return "requestId must not be empty or whitespace-only.";
  return null;
}

export async function executeMcpTool(ctx: McpToolContext, name: string, args: unknown): Promise<McpToolResult> {
  const envelope = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const invalidRequestId = invalidRequestIdMessage(args);
  if (invalidRequestId !== null || envelope.dryRun === true) {
    return executeMcpToolCore(ctx, name, args);
  }
  const requestId = typeof envelope.requestId === "string" ? envelope.requestId.trim() : "";
  if (requestId === "") return executeMcpToolCore(ctx, name, args);

  const agent = ctx.agentId ?? "local";
  let signature: string;
  try {
    signature = await idempotencySignature(agent, name, args);
  } catch (error) {
    return mcpError(
      "UNAVAILABLE_ON_TRANSPORT",
      error instanceof Error ? error.message : "A safe idempotency check is unavailable.",
    );
  }

  const flightKey = `${ctx.getDoc().id}\u0000${requestId}`;
  const active = idempotencyFlights.get(flightKey);
  if (active) {
    if (active.signature !== signature) return requestIdConflict(requestId);
    await active.done;
    // The first request either stored its committed outcome (replay it) or
    // failed without mutation (retry the now-unblocked operation).
    return executeMcpToolCore(ctx, name, args, signature);
  }

  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const flight: IdempotencyFlight = { signature, done, finish };
  idempotencyFlights.set(flightKey, flight);
  try {
    return await executeMcpToolCore(ctx, name, args, signature);
  } finally {
    if (idempotencyFlights.get(flightKey) === flight) idempotencyFlights.delete(flightKey);
    flight.finish();
  }
}

async function executeMcpToolCore(
  ctx: McpToolContext,
  name: string,
  args: unknown,
  signature?: string,
): Promise<McpToolResult> {
  const envelope = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const requestId = typeof envelope.requestId === "string" ? envelope.requestId.trim() : "";
  // Wave 1/A trust layer: every call — all transports, dry-runs and replays —
  // is classified and audited; the audit lives outside the tool surface so it
  // can never change tool behavior.
  const agent = ctx.agentId ?? "local";
  const risk = toolRisk(name);
  const depth = mcpCallDepth;
  const summary = summarizeToolArgs(args);
  const invalidRequestId = invalidRequestIdMessage(args);
  if (invalidRequestId !== null) {
    const doc = ctx.getDoc();
    completeAgentCall({
      agent,
      tool: name,
      risk,
      depth,
      mutated: false,
      isError: true,
      errorCode: "INVALID_REQUEST_ID",
      durationMs: 0,
      docId: doc.id,
      docName: doc.name,
      ...(summary !== "" ? { summary } : {}),
    });
    return mcpError("INVALID_REQUEST_ID", invalidRequestId);
  }
  const invalidInstanceIndex = invalidInstanceIndexMessage(name, args);
  if (invalidInstanceIndex !== null) {
    const doc = ctx.getDoc();
    completeAgentCall({
      agent,
      tool: name,
      risk,
      depth,
      mutated: false,
      isError: true,
      errorCode: "INVALID_ARGUMENTS",
      durationMs: 0,
      docId: doc.id,
      docName: doc.name,
      ...(summary !== "" ? { summary } : {}),
    });
    return mcpError("INVALID_ARGUMENTS", invalidInstanceIndex);
  }
  // P2-C DRY-RUN (control-surface audit 2026-10-13, GAP-11): `dryRun: true`
  // executes the tool's FULL logic against a SANDBOX context — validation,
  // resolution and command construction run for real, but `ctx.execute`
  // advances a throwaway document chain, so the live store never mutates.
  // The result reports what WOULD have applied (the exact command labels
  // the real run would commit). Runtime/export-side tools are refused: a
  // dry-run cannot un-play a note or un-write a file.
  if (envelope.dryRun === true) {
    const refusal = dryRunPolicyRefusal(name, envelope);
    if (refusal != null) {
      return mcpError("POLICY_REFUSED", refusal);
    }
    const dry = dryRunContext(ctx);
    const dryStartedAt = Date.now();
    mcpCallDepth += 1;
    let preview: McpToolResult;
    try {
      preview = await executeMcpToolDispatch(dry.ctx, name, args);
    } finally {
      mcpCallDepth -= 1;
    }
    const labels = dry.applied();
    const would =
      labels.length > 0
        ? `would apply ${labels.length} command(s): ${labels.join("; ")}`
        : "no document change would occur";
    const dryDoc = ctx.getDoc();
    completeAgentCall({
      agent,
      tool: name,
      risk,
      depth,
      mutated: false,
      isError: preview.isError === true,
      durationMs: Date.now() - dryStartedAt,
      docId: dryDoc.id,
      docName: dryDoc.name,
      dryRun: true,
      ...(summary !== "" ? { summary } : {}),
    });
    return {
      ...preview,
      text: `dry-run — nothing was applied
${would}
${preview.text}`,
      mutated: false,
      dryRun: true,
    };
  }
  if (requestId !== "" && signature !== undefined) {
    const cached = idempotencyLedger.get(requestId);
    if (cached != null) {
      if (cached.docId === ctx.getDoc().id) {
        if (cached.signature !== signature) return requestIdConflict(requestId);
        const doc = ctx.getDoc();
        completeAgentCall({
          agent,
          tool: name,
          risk,
          depth,
          mutated: false,
          isError: cached.result.isError === true,
          durationMs: 0,
          docId: doc.id,
          docName: doc.name,
          replayed: true,
          ...(summary !== "" ? { summary } : {}),
        });
        return {
          ...cached.result,
          text: `idempotent replay — requestId was already applied; nothing re-executed\n${cached.result.text}`,
          replayed: true,
        };
      }
      idempotencyLedger.delete(requestId); // stale project scope — re-bind below
    }
  }
  // ── Wave 1/A: session checkpoint BEFORE the first document mutation ──
  // One clone per session, not per call: the first mutating call of a fresh
  // session parks a checkpoint so "revert everything this agent just did" is
  // a single action. Reads and runtime tools never start a session.
  const docBefore = ctx.getDoc();
  const prepared = prepareAgentCall({
    agent,
    tool: name,
    risk: effectiveRisk(name, args),
    docId: docBefore.id,
    docName: docBefore.name,
  });
  if (prepared.checkpointName != null) {
    try {
      const saved = saveCheckpoint(prepared.checkpointName, ctx, true);
      void persistCheckpoint(saved).then((durability) => {
        // "Restorable from any surface" requires the durable record (the
        // in-memory map alone is not visible to the UI's checkpoint module).
        if (durability === "persisted" && prepared.sessionId != null) markSessionCheckpointSaved(prepared.sessionId);
      });
    } catch {
      /* checkpointing is safety netting, never a gate on the call */
    }
  }
  const startedAt = Date.now();
  // Long-running calls surface in the Job Center so a user can see (and
  // cancel) what the agent is waiting on — same tool set the transports give
  // the extended 60 s call budget.
  const job = LONG_RUNNING_AGENT_TOOLS.has(name)
    ? startJob({
        kind: "agent",
        label: `${agent} · ${name}`,
        key: `agent:${agent}:${name}`,
        timeoutMs: 90_000,
        ...(summary !== "" ? { note: summary } : {}),
      })
    : null;
  mcpCallDepth += 1;
  let result: McpToolResult;
  try {
    result = await executeMcpToolDispatch(ctx, name, args);
  } catch (error) {
    mcpCallDepth -= 1;
    job?.fail(error);
    completeAgentCall({
      agent,
      tool: name,
      risk,
      depth,
      mutated: false,
      isError: true,
      errorCode: "THREW",
      durationMs: Date.now() - startedAt,
      docId: docBefore.id,
      docName: docBefore.name,
      ...(prepared.checkpointName != null ? { checkpoint: prepared.checkpointName } : {}),
      ...(summary !== "" ? { summary } : {}),
    });
    throw error;
  }
  mcpCallDepth -= 1;
  // P1-D DOCUMENT/WINDOW ATTRIBUTION (control-surface audit 2026-10-13,
  // GAP-06): every caller — desktop stdio, web relay, QMR — executes
  // against the ONE relay session's document (the hub forwards to a single
  // owning window; the relay's session-ownership model lives in
  // mcp-core.mjs). Whatever that model evolves into, this attribution makes
  // the shared reality OBSERVABLE at the result level:
  // every mutating result states exactly which document (name + id) and
  // which attributed surface produced it. The text carries the line — it
  // is the one channel every transport forwards verbatim; the structured
  // fields ride along for in-process consumers. A replay already carries
  // its original line (the cache stores the attributed result — the line
  // is appended exactly once per execution).
  const sideEffectCommitted = result.idempotencyCommitted === true;
  delete result.idempotencyCommitted;
  if (result.mutated === true) {
    // Any non-intent mutation supersedes the remembered fader move; the intent
    // path records/clears itself, and kyx_undo clears when it actually moves.
    if (name !== "kyx_intent" && name !== "kyx_undo") clearAdjustmentLedger();
    const doc = ctx.getDoc();
    result.text = `${result.text}\nmutated on ${ctx.agentId ? `${ctx.agentId} · ` : ""}document "${doc.name}" (id ${doc.id})`;
    result.docId = doc.id;
    result.docName = doc.name;
  }
  if (requestId !== "" && signature !== undefined && (result.mutated === true || sideEffectCommitted)) {
    idempotencyLedger.delete(requestId); // refresh FIFO position on re-bind
    idempotencyLedger.set(requestId, { docId: docBefore.id, signature, result });
    while (idempotencyLedger.size > IDEMPOTENCY_LEDGER_CAP) {
      const oldest = idempotencyLedger.keys().next();
      if (oldest.done) break;
      idempotencyLedger.delete(oldest.value);
    }
  }
  if (job != null) {
    if (result.isError === true) job.fail(result.errorCode ?? "tool returned an error");
    else job.done();
  }
  completeAgentCall({
    agent,
    tool: name,
    risk,
    depth,
    mutated: result.mutated === true,
    isError: result.isError === true,
    ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    durationMs: Date.now() - startedAt,
    docId: result.docId ?? docBefore.id,
    ...(result.docName !== undefined ? { docName: result.docName } : {}),
    ...(prepared.checkpointName != null ? { checkpoint: prepared.checkpointName } : {}),
    ...(summary !== "" ? { summary } : {}),
  });
  return result;
}

async function executeMcpToolDispatch(ctx: McpToolContext, name: string, args: unknown): Promise<McpToolResult> {
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
          // P0 SAFETY: a model route may not override the deterministic
          // description guard with a mutation.
          if (isDescriptiveStatement(trimmed) && modelRoute.kind !== "clarify" && modelRoute.kind !== "queryIntent") {
            logIntentMiningEvent({ prompt: trimmed, outcome: "clarify", reason: "descriptive-not-a-command" });
            return { text: clarifyMessage("descriptive-not-a-command"), mutated: false };
          }
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
  // Self-healing lazy-bank gate: kyx_state(mixer) and kyx_tracks(preset ops)
  // read the factory bank, which is a separate chunk. Warm it here so the
  // tool surface is a complete entry point on its own — a headless host, a
  // batch call or a test never depends on someone else having warmed the UI.
  if (name === "kyx_state" || name === "kyx_tracks") {
    if (!isFactoryPresetsWarm()) await warmFactoryPresets();
  }
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
        return mcpError("POLICY_REFUSED", "declined: a mic take is recording — stop it before undo");
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
        return mcpError(
          "POLICY_REFUSED",
          `declined: the top of history is foreign work (${top}) — ` +
            "pass allowForeign: true to revert it anyway (the human may have made these edits)",
        );
      }
      let done = 0;
      let failure: string | null = null;
      try {
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
      } catch (error) {
        // A broken command's undo must not turn into an uncountable partial
        // state — report exactly how far it got (audit re-run).
        failure = error instanceof Error ? error.message : String(error);
      }
      // The move a prior-delta reference points at is no longer applied.
      if (done > 0) clearAdjustmentLedger();
      let text = `${action} ×${done}`;
      if (failure) text += ` — step failed after ${done}: ${failure}`;
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
      return {
        text,
        mutated: done > 0,
        data: {
          action,
          requestedSteps: steps,
          completedSteps: done,
          revertedLabels: reverted.slice(0, done).map((label) => label.slice(0, 240)),
          ...(failure ? { partialFailure: failure.slice(0, 2_000) } : {}),
        },
      };
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
      // SILENT-DEFAULT rule: an unstated magnitude lands on the bounded
      // default (50 %), and the read-back says so — an agent that meant 80 %
      // must see that 50 happened, not mistake the default for its intent.
      const assumedNote =
        direction === "set" && percent == null ? " (swing 50% assumed default — pass percent for an exact value)" : "";
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
        return { text: `${command.label}${assumedNote}`, mutated: true };
      }
      const scoped = applySectionGrooveIntent(ctx.getDoc(), sectionGrooveFrom(direction, percent, section));
      if (!scoped) return { text: `no pattern for the "${section}" section`, mutated: false };
      ctx.execute(scoped);
      return { text: `${scoped.label}${assumedNote}`, mutated: true };
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
            return mcpError("EXECUTION_FAILED", `reorder failed — ${parts.join("; ")}`);
          }
          ctx.execute(snapshot("mcpFxReorder", `MCP: reorder ${effect}#${reorderIndex}`, before, next));
          return { text: `reorder ${effect}#${reorderIndex}: ${parts.join("; ")} — one undo step`, mutated: true };
        } catch (error) {
          return mcpError(
            "EXECUTION_FAILED",
            `fx op failed: ${error instanceof Error ? error.message : String(error)}`,
          );
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
          return mcpError(
            "EXECUTION_FAILED",
            `fx op failed: ${error instanceof Error ? error.message : String(error)}`,
          );
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
        return mcpError("EXECUTION_FAILED", `fx op failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    case "kyx_sections":
      return executeSectionsTool(ctx, record);
    case "kyx_markers": {
      if (record.op !== undefined && typeof record.op !== "string") {
        return mcpError("INVALID_ARGUMENTS", "op must be one of: list, add, rename, remove");
      }
      const op = typeof record.op === "string" ? record.op : "add";
      if (!["list", "add", "rename", "remove"].includes(op)) {
        return mcpError("UNKNOWN_REQUEST", `unknown marker op: ${op} (list | add | rename | remove)`);
      }
      if (record.markerId !== undefined && (typeof record.markerId !== "string" || record.markerId.length > 128)) {
        return mcpError("INVALID_ARGUMENTS", "markerId must be a string of at most 128 characters");
      }
      const markerId = typeof record.markerId === "string" ? record.markerId.trim() : "";
      if (record.markerId !== undefined && markerId === "") {
        return mcpError("INVALID_ARGUMENTS", "markerId must not be empty");
      }
      const hasBar = record.bar !== undefined;
      if (hasBar && (typeof record.bar !== "number" || !Number.isInteger(record.bar) || record.bar < 1)) {
        return mcpError("INVALID_ARGUMENTS", "bar must be a 1-based positive integer");
      }
      const bar = hasBar ? (record.bar as number) : undefined;
      const tick = bar === undefined ? undefined : (bar - 1) * TICKS_PER_BAR;
      if (record.name !== undefined && (typeof record.name !== "string" || record.name.length > 40)) {
        return mcpError("INVALID_ARGUMENTS", "name must be a string of at most 40 characters");
      }
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const markerReadback = (marker: ProjectDocument["markers"][number]) => ({
        id: marker.id,
        name: marker.name,
        type: marker.type,
        tick: marker.tick,
        bar: Math.floor(marker.tick / TICKS_PER_BAR) + 1,
        ...(marker.linkedClipId !== undefined ? { linkedClipId: marker.linkedClipId } : {}),
      });
      const markerMutationReadback = (marker: ProjectDocument["markers"][number]) => ({
        markerId: marker.id,
        name: marker.name,
        markerType: marker.type,
        tick: marker.tick,
        bar: Math.floor(marker.tick / TICKS_PER_BAR) + 1,
        ...(marker.linkedClipId !== undefined ? { linkedClipId: marker.linkedClipId } : {}),
      });
      const doc = ctx.getDoc();
      if (op === "list") {
        const markers = doc.markers.map(markerReadback);
        return {
          text:
            markers
              .map((marker) => `${marker.name} (id=${marker.id}) — bar ${marker.bar}, ${marker.type}`)
              .join("\n") || "no markers",
          mutated: false,
          data: { status: "listed", markers },
        };
      }
      if (op === "add") {
        if (tick === undefined || bar === undefined) return mcpError("INVALID_ARGUMENTS", "add needs bar (1-based)");
        const beforeIds = new Set(doc.markers.map((marker) => marker.id));
        const expectedName = name || `Marker ${doc.markers.length + 1}`;
        ctx.execute(addMarker(doc, { tick, ...(name !== "" ? { name } : {}) }));
        const committed = ctx.getDoc();
        const created = committed.markers.filter((marker) => !beforeIds.has(marker.id));
        const marker = created.length === 1 ? created[0] : undefined;
        const matches = marker != null && marker.name === expectedName && marker.tick === tick && marker.type === "cue";
        const data = {
          status: matches ? "created" : "partial",
          ...(marker !== undefined
            ? { markerId: marker.id, name: marker.name, markerType: marker.type, tick: marker.tick, bar }
            : {}),
          undoSteps: created.length > 0 ? 1 : 0,
        };
        if (!matches) {
          return mcpError("PARTIAL_FAILURE", "marker creation did not match one new marker in the project read-back", {
            mutated: created.length > 0,
            data,
          });
        }
        return {
          text: `created marker "${marker.name}" (id=${marker.id}) at bar ${bar} — one undo step`,
          mutated: true,
          data,
        };
      }

      let target = markerId !== "" ? doc.markers.find((marker) => marker.id === markerId) : undefined;
      if (markerId !== "" && target === undefined) {
        return mcpError("UNKNOWN_TARGET", `marker ${markerId} not found — use kyx_markers op:list for marker IDs`);
      }
      if (target === undefined) {
        if (tick === undefined || bar === undefined) {
          return mcpError("INVALID_ARGUMENTS", `${op} needs markerId or bar (1-based)`);
        }
        target = doc.markers
          .filter((marker) => Math.abs(marker.tick - tick) < TICKS_PER_BAR)
          .sort((a, b) => Math.abs(a.tick - tick) - Math.abs(b.tick - tick))[0];
      }
      if (target === undefined) {
        return {
          text: `no marker near bar ${bar}`,
          mutated: false,
          data: { status: "missing", ...(bar !== undefined ? { bar } : {}), undoSteps: 0 },
        };
      }
      if (op === "rename") {
        if (name === "") return mcpError("INVALID_ARGUMENTS", "rename needs a non-empty name");
        if (target.name === name) {
          return {
            text: `marker "${target.name}" is already named that — no change`,
            mutated: false,
            data: { status: "already_named", ...markerMutationReadback(target), undoSteps: 0 },
          };
        }
        const previous = target.name;
        ctx.execute(renameMarker(doc, target.id, name));
        const committed = ctx.getDoc().markers.find((marker) => marker.id === target!.id);
        const correct = committed?.name === name;
        const stateChanged = committed !== undefined && committed.name !== previous;
        const data = {
          status: correct ? "renamed" : "partial",
          ...(committed !== undefined ? markerMutationReadback(committed) : {}),
          undoSteps: stateChanged ? 1 : 0,
        };
        if (!correct) {
          return mcpError("PARTIAL_FAILURE", "marker rename did not match the committed project read-back", {
            mutated: stateChanged,
            data,
          });
        }
        return { text: `renamed marker "${previous}" → "${name}" — one undo step`, mutated: true, data };
      }

      const removed = markerReadback(target);
      ctx.execute(removeMarker(doc, target.id));
      const stillExists = ctx.getDoc().markers.some((marker) => marker.id === target!.id);
      const correct = !stillExists;
      const data = {
        status: correct ? "removed" : "partial",
        markerId: target.id,
        name: target.name,
        markerType: target.type,
        tick: target.tick,
        bar: removed.bar,
        undoSteps: correct ? 1 : 0,
      };
      if (!correct) {
        return mcpError("PARTIAL_FAILURE", "marker removal did not match the committed project read-back", {
          mutated: false,
          data,
        });
      }
      return { text: `marker "${target.name}" (id=${target.id}) removed — one undo step`, mutated: true, data };
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
          return mcpError(
            "EXECUTION_FAILED",
            `preset failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (op === "listPresets") {
        // Discovery for loadPreset — factory names that FIT the family's
        // instruments first, then the rest (capped for a readable tool call).
        const family = (typeof record.family === "string" ? record.family : "bass") as PresetTargetFamily;
        const query = typeof record.query === "string" ? record.query.toLowerCase() : "";
        const bank = factoryPresets();
        const fitting: string[] = [];
        const rest: string[] = [];
        for (const preset of bank) {
          const line = `${preset.name} (${preset.instrument})`;
          const fits = PRESET_FAMILY_INSTRUMENTS[family]?.has(preset.instrument) ?? false;
          if (query !== "" && !line.toLowerCase().includes(query)) continue;
          (fits ? fitting : rest).push(line);
        }
        const shown = [...fitting, ...rest].slice(0, 25);
        return {
          text: `${bank.length} factory presets; for ${family}${query !== "" ? ` matching "${query}"` : ""}: ${shown.join("; ")}${fitting.length + rest.length > 25 ? " …" : ""}`,
          mutated: false,
          data: { family, fitting: fitting.length, total: bank.length },
        };
      }
      if (op === "rename") {
        const name = typeof record.name === "string" ? record.name.trim().slice(0, 40) : "";
        const ids = explicitTrackIds(ctx.getDoc(), record);
        if (typeof ids === "string") return mcpError("UNKNOWN_TARGET", ids);
        if (ids.length === 0)
          return mcpError("UNKNOWN_TARGET", `no track matches family "${String(record.family ?? "")}"`);
        ctx.execute(setTrackParams(ctx.getDoc(), ids[0], { name }));
        return { text: `renamed to "${name}"`, mutated: true };
      }
      if (op === "duplicate") {
        // P2-D (parity sweep 2026-10-13): the only capability where NL
        // exceeded MCP — the exact parser could duplicate tracks, this tool
        // could not. Exactly one target: a family resolving to several
        // tracks is declined (duplicates are per-track decisions).
        const ids = explicitTrackIds(ctx.getDoc(), record);
        if (typeof ids === "string") return mcpError("UNKNOWN_TARGET", ids);
        if (ids.length !== 1) {
          return mcpError(
            "INVALID_ARGUMENTS",
            "duplicate needs exactly one track — pass trackId (a family resolving to several tracks is declined)",
          );
        }
        const command = duplicateTrack(ctx.getDoc(), ids[0]);
        ctx.execute(command);
        return { text: `${command.label} — one undo step`, mutated: true };
      }
      if (op === "remove") {
        if (!destructiveAllowedWithCheckpoint(ctx, "kyx_tracks")) return destructiveRefusal();
        const ids = explicitTrackIds(ctx.getDoc(), record);
        if (typeof ids === "string") return mcpError("UNKNOWN_TARGET", ids);
        if (ids.length === 0)
          return mcpError("UNKNOWN_TARGET", `no track matches family "${String(record.family ?? "")}"`);
        if (ctx.getDoc().tracks.length - ids.length < 1) {
          return mcpError("POLICY_REFUSED", "declined: cannot remove the last track");
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
        if (typeof ids === "string") return mcpError("UNKNOWN_TARGET", ids);
        if (ids.length === 0)
          return mcpError("UNKNOWN_TARGET", `no track matches family "${String(record.family ?? "")}"`);
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
      return mcpError("UNKNOWN_REQUEST", `unknown track op: ${op}`);
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
    case "kyx_master":
      return await executeMasterTool(ctx, record);
    case "kyx_unsuno":
      return executeUnsunoTool(ctx, record);
    case "kyx_takes":
      return executeTakesTool(ctx, record);
    case "kyx_batch":
      return executeBatchTool(ctx, record);
    case "kyx_meter": {
      const scope = String(record.scope ?? "all");
      // FX telemetry: the per-insert closed loop (KOREŇ's sound-identity
      // readings, dynamics gain reduction, plugin frames). Refused honestly on
      // transports without a live engine, exactly like the master meters.
      if (scope === "fx") {
        if (ctx.fxMeters == null) {
          return mcpError(
            "UNAVAILABLE_ON_TRANSPORT",
            "fx metering is not available over this MCP transport (no live engine bound) — start KYX with an audio context",
          );
        }
        const fxSnapshot = ctx.fxMeters();
        if (fxSnapshot == null) {
          return mcpError(
            "UNAVAILABLE_ON_TRANSPORT",
            "engine is not running (no audio context) — nothing to meter yet",
          );
        }
        const lines = fxSnapshot.effects.map((reading) => {
          const details = [describeFxMeters(reading.meters), describeGainReduction(reading.gainReduction)]
            .filter((part) => part !== "")
            .join(" · ");
          const bypass = reading.bypassed ? " · BYPASSED" : "";
          return `${reading.ownerName} / ${reading.name} (${reading.type}, id=${reading.fxId})${bypass}: ${
            details === "" ? "no telemetry (bypassed, degraded or offline)" : details
          }`;
        });
        return {
          text:
            lines.length > 0
              ? `${lines.length} inserted effect(s):\n${lines.join("\n")}`
              : "no effects inserted on tracks, returns or the master chain",
          mutated: false,
          data: fxSnapshot,
        };
      }
      if (ctx.meters == null) {
        return mcpError(
          "UNAVAILABLE_ON_TRANSPORT",
          "metering is not available over this MCP transport (no live engine bound) — start KYX with an audio context",
        );
      }
      const snapshotMeters = ctx.meters();
      if (snapshotMeters == null) {
        return mcpError("UNAVAILABLE_ON_TRANSPORT", "engine is not running (no audio context) — nothing to meter yet");
      }
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
      if (typeof ids === "string") return mcpError("UNKNOWN_TARGET", ids);
      if (ids.length === 0) return mcpError("UNKNOWN_TARGET", `no track matches family "${family}"`);
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
        // The one removal op that shipped without the D4 gate (audit 10-06):
        // every other removal (tracks/clips/fx/takes/master) refuses until
        // the user flips the chip — note delete must not be the loophole
        // that deletes a part one call at a time.
        if (!destructiveAllowedWithCheckpoint(ctx, "kyx_notes")) return destructiveRefusal();
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
        if ((key && gridName) || (!key && !gridName)) {
          return mcpError("INVALID_ARGUMENTS", "quantize needs exactly one of grid or key");
        }
        if (key) {
          if (!(MUSICAL_KEYS as readonly string[]).includes(key)) {
            return mcpError("INVALID_ARGUMENTS", `unsupported key "${key}" — choose a key from kyx_notes schema`);
          }
        }
        if (gridName && gridTicks[gridName] === undefined) {
          return mcpError("INVALID_ARGUMENTS", `unsupported grid "${gridName}" — choose a grid from kyx_notes schema`);
        }
        const before = ctx.getDoc();
        const activePattern = before.patterns.find((pattern) => pattern.id === before.activePatternId);
        const beforeNotes = activePattern?.notes?.[trackId] ?? [];
        if (beforeNotes.length === 0) {
          return {
            text: `track "${track?.name ?? trackId}" has no notes to quantize`,
            mutated: false,
            data: {
              status: "no_notes",
              op,
              trackId,
              targetNoteCount: 0,
              changedNotes: 0,
              undoSteps: 0,
              ...(key ? { key } : { grid: gridName }),
            },
          };
        }
        const command = key
          ? quantizePatternToScale(before, activePattern!.id, key as MusicalKey, trackId)
          : quantizePatternToGrid(before, activePattern!.id, gridTicks[gridName!]!, trackId);
        ctx.execute(command);
        const after = ctx.getDoc();
        const afterPattern = after.patterns.find((pattern) => pattern.id === activePattern!.id);
        const afterById = new Map((afterPattern?.notes?.[trackId] ?? []).map((note) => [note.id, note]));
        let changedNotes = 0;
        let missingNotes = 0;
        for (const note of beforeNotes) {
          const committed = afterById.get(note.id);
          if (!committed) missingNotes += 1;
          else if (committed.start !== note.start || committed.pitch !== note.pitch) changedNotes += 1;
        }
        const mutated = after !== before;
        const data = {
          status: missingNotes > 0 ? "partial" : changedNotes > 0 ? "quantized" : "already_quantized",
          op,
          trackId,
          targetNoteCount: beforeNotes.length,
          changedNotes,
          missingNotes,
          undoSteps: mutated ? 1 : 0,
          ...(key ? { key } : { grid: gridName }),
        };
        if (missingNotes > 0) {
          return mcpError("PARTIAL_FAILURE", "quantize did not preserve every targeted note in committed state", {
            mutated,
            data,
          });
        }
        if (changedNotes === 0) {
          return {
            text: `notes on ${track?.name ?? trackId} are already quantized${key ? ` to ${key}` : ` to ${gridName}`}`,
            mutated: false,
            data,
          };
        }
        return {
          text: `quantized ${changedNotes}/${beforeNotes.length} notes on ${track?.name ?? trackId}${key ? ` to ${key}` : ` to ${gridName}`} — one undo step`,
          mutated,
          data,
        };
      }
      if (op === "transpose") {
        const semitones = record.semitones;
        if (
          typeof semitones !== "number" ||
          !Number.isSafeInteger(semitones) ||
          semitones === 0 ||
          Math.abs(semitones) > 127
        ) {
          return mcpError(
            "INVALID_ARGUMENTS",
            "transpose needs an integer semitone shift from -127 to 127, excluding zero",
          );
        }
        const before = ctx.getDoc();
        const beforeNotes = notesOf();
        if (beforeNotes.length === 0) {
          return { text: `track "${track?.name ?? trackId}" has no notes to transpose`, mutated: false };
        }
        let next = before;
        for (const note of beforeNotes) {
          next = moveNote(next, trackId, note.id, { pitch: note.pitch + semitones }).execute(next);
        }
        const command = snapshot(
          "mcpTransposeNotes",
          `MCP: transpose ${track?.name ?? trackId} by ${semitones} st`,
          before,
          next,
        );
        if (command.execute(before) === before) {
          return mcpError(
            "PARTIAL_FAILURE",
            `transpose was clamped at the MIDI pitch boundary; no notes moved and no undo step was added`,
          );
        }
        ctx.execute(command);
        const after = notesOf();
        const afterById = new Map(after.map((note) => [note.id, note]));
        let transposed = 0;
        let partial = 0;
        for (const note of beforeNotes) {
          const committed = afterById.get(note.id);
          if (committed?.pitch === note.pitch + semitones) transposed += 1;
          else partial += 1;
        }
        if (partial > 0 || transposed === 0) {
          return mcpError(
            "PARTIAL_FAILURE",
            `transpose moved ${transposed}/${beforeNotes.length} notes by the full shift; ${partial} were clamped or missing. One undo reverts the committed changes.`,
            { mutated: ctx.getDoc() !== before },
          );
        }
        return {
          text: `transposed ${transposed} notes on ${track?.name ?? trackId} by ${semitones > 0 ? "+" : ""}${semitones} st — one undo step`,
          mutated: ctx.getDoc() !== before,
        };
      }
      return {
        text: "unknown op — kyx_notes ops: list | add | move | delete | setVelocity | quantize | transpose",
        mutated: false,
      };
    }
    case "kyx_music":
      return executeMusicTool(ctx, record);
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
        return mcpError(
          "UNAVAILABLE_ON_TRANSPORT",
          "export is not available over this MCP transport — use the KYX export panel",
        );
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
        return mcpError("EXECUTION_FAILED", `export failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    case "kyx_audio_preview": {
      const rawBars = record.bars;
      if (rawBars != null && (!Number.isInteger(rawBars) || Number(rawBars) < 1 || Number(rawBars) > 4)) {
        return mcpError("INVALID_ARGUMENTS", "audio preview bars must be an integer from 1 to 4");
      }
      if (ctx.audioPreview == null) {
        return mcpError(
          "UNAVAILABLE_ON_TRANSPORT",
          "audio preview is not available over this MCP transport — use the KYX export panel",
        );
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
        return mcpError(
          "EXECUTION_FAILED",
          `audio preview failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    case "kyx_loudness": {
      const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const op = String(record.op ?? "measure");
      if (op === "measure") {
        if (ctx.measureLoudness == null) {
          return mcpError(
            "UNAVAILABLE_ON_TRANSPORT",
            "loudness measurement is not available over this MCP transport (no render context bound)",
          );
        }
        try {
          const reading = await ctx.measureLoudness();
          if (!reading.measured) {
            return mcpError("EXECUTION_FAILED", "could not measure loudness — the render was too quiet or empty");
          }
          return {
            text: `current mix: ${reading.integrated.toFixed(1)} LUFS integrated (render-backed BS.1770)`,
            mutated: false,
            data: { integratedLufs: reading.integrated },
          };
        } catch (error) {
          return mcpError(
            "EXECUTION_FAILED",
            `loudness render failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (ctx.applyLoudness == null) {
        return mcpError(
          "UNAVAILABLE_ON_TRANSPORT",
          "the loudness loop is not available over this MCP transport (no render context bound)",
        );
      }
      const direction = record.direction === "quieter" ? ("quieter" as const) : ("louder" as const);
      const targetDb =
        typeof record.targetDb === "number" && Number.isFinite(record.targetDb) ? record.targetDb : undefined;
      try {
        const outcome = await ctx.applyLoudness({ direction, ...(targetDb !== undefined ? { targetDb } : {}) });
        if (!outcome.ok) return mcpError("EXECUTION_FAILED", outcome.error ?? "the operation failed without a reason");
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
        return mcpError(
          "EXECUTION_FAILED",
          `loudness loop failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    case "kyx_import_sfz": {
      if (ctx.importSamples == null) {
        return mcpError(
          "UNAVAILABLE_ON_TRANSPORT",
          "sample import is not available over this transport — import SFZ libraries from a live KYX session (web or desktop)",
        );
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
        return mcpError(
          "INVALID_ARGUMENTS",
          "kyx_import_sfz needs name, sfzBase64, trackId and at least one sample — list tracks via kyx_state",
        );
      }
      let result: Awaited<ReturnType<NonNullable<McpToolContext["importSamples"]>>>;
      try {
        result = await ctx.importSamples({ name, sfzBase64, trackId, samples });
      } catch (error) {
        return mcpError(
          "EXECUTION_FAILED",
          `SFZ import failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!result.ok) {
        return mcpError("EXECUTION_FAILED", `SFZ import failed: ${result.error}`);
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
        data: {
          name,
          trackId: r.trackId,
          fallbackSampleId: r.fallbackSampleId,
          importedSamples: r.imported,
          velocityLayers: r.layers,
          missingSamples: r.missing.length,
          skippedSamples: r.skipped.length,
        },
      };
    }
    case "kyx_publish_gallery": {
      const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      if (ctx.shareToGallery == null) {
        return mcpError(
          "UNAVAILABLE_ON_TRANSPORT",
          "gallery publishing is not available over this MCP transport — publish from a live KYX session (web or desktop)",
        );
      }
      const title = typeof record.title === "string" ? record.title.trim() : "";
      if (!title || title.length > 64) {
        return mcpError("INVALID_ARGUMENTS", "title is required (max 64 chars)");
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
        return mcpError(
          "EXECUTION_FAILED",
          `gallery publish failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    case "kyx_arrange": {
      return executeArrangeTool(ctx, (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>);
    }
    case "kyx_song": {
      const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const genre = String(record.genre ?? "");
      if (!MIX_GENRES.includes(genre as (typeof MIX_GENRES)[number])) {
        return mcpError("UNKNOWN_REQUEST", `unknown genre "${genre}" - one of: ${MIX_GENRES.join(", ")}`);
      }
      const doc = ctx.getDoc();
      if (doc.arrangement.clips.length > 0) {
        return mcpError(
          "POLICY_REFUSED",
          "arrangement already has clips - kyx_song builds a WHOLE track; " +
            "use kyx_sections / kyx_clips for surgical edits, or clear the arrangement first",
        );
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
        return mcpError(
          "EXECUTION_FAILED",
          `song build failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    case "kyx_render_summary": {
      // THE AGENT'S EARS: offline render → per-strip LUFS/peak/crest + master
      // vs the streaming reference. Evidence for mixing decisions — numbers,
      // never vibes. Render-bound transport only; refusal is honest elsewhere.
      const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      if (ctx.renderSummary == null) {
        return mcpError(
          "UNAVAILABLE_ON_TRANSPORT",
          "render summary is not available over this MCP transport (no render context bound) — use kyx_meter for live levels",
        );
      }
      const scope = record.scope === "master" || record.scope === "tracks" ? record.scope : "all";
      try {
        const data = await ctx.renderSummary({ scope });
        return { text: formatRenderSummary(data), mutated: false, data };
      } catch (error) {
        return mcpError(
          "EXECUTION_FAILED",
          `render summary failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    case "kyx_diagnose_mix": {
      // EARS v2: the INTERPRETATION layer on top of the render evidence —
      // attributed findings + callable fixes, so an agent can run the loop
      // diagnose → fix → re-diagnose without a human ear in the middle.
      const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      if (ctx.diagnoseMix == null) {
        return mcpError(
          "UNAVAILABLE_ON_TRANSPORT",
          "mix diagnosis is not available over this MCP transport (no render context bound) — use kyx_render_summary for numbers only",
        );
      }
      const scope = record.scope === "master" || record.scope === "tracks" ? record.scope : "all";
      try {
        // Lazy module: the diagnosis layer (analysis + formatting) stays off
        // the eager DAW graph — it loads on the first diagnose call.
        const { formatMixDiagnosis } = await import("./mix-diagnosis");
        const data = await ctx.diagnoseMix({ scope });
        // F2: the reaction ledger's report rides along with the ears. Silent
        // when nothing is resolved yet — a diagnose call must not grow a
        // section just because F1 exists.
        const { reactionReportForAgent } = await import("./reaction-report");
        const reactions = reactionReportForAgent();
        const text = formatMixDiagnosis(data);
        return {
          text: reactions ? `${text}\n\n${reactions.text}` : text,
          mutated: false,
          data: reactions ? { ...data, reactions: reactions.data } : data,
        };
      } catch (error) {
        return mcpError(
          "EXECUTION_FAILED",
          `mix diagnosis failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    case "kyx_mix_idea": {
      // TEXT-TO-MIX, CLOSED LOOP: plan (pure, attributed WHY) → apply as ONE
      // undo step. The heavy lifting lives in the lazy mix-idea module — the
      // tool stays a thin, honest envelope over the existing interpreters.
      const record = (args != null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const idea = typeof record.idea === "string" ? record.idea : "";
      if (idea.trim().length < 3) {
        return mcpError("INVALID_ARGUMENTS", 'kyx_mix_idea needs an idea — e.g. idea: "warm it up and glue the drums"');
      }
      if (idea.length > MIX_IDEA_MAX_LENGTH) {
        return mcpError("INVALID_ARGUMENTS", `idea must be at most ${MIX_IDEA_MAX_LENGTH} characters`);
      }
      if (
        record.target !== undefined &&
        (typeof record.target !== "string" || record.target.length > MIX_IDEA_TARGET_MAX_LENGTH)
      ) {
        return mcpError(
          "INVALID_ARGUMENTS",
          `target must be a string of at most ${MIX_IDEA_TARGET_MAX_LENGTH} characters`,
        );
      }
      if (record.apply !== undefined && typeof record.apply !== "boolean") {
        return mcpError("INVALID_ARGUMENTS", "apply must be a boolean");
      }
      if (record.preview !== undefined && typeof record.preview !== "boolean") {
        return mcpError("INVALID_ARGUMENTS", "preview must be a boolean");
      }
      if (record.apply === true && record.preview === true) {
        return mcpError("INVALID_ARGUMENTS", "apply and preview are mutually exclusive");
      }
      const target = typeof record.target === "string" ? record.target.trim() : undefined;
      const apply = record.apply === true;
      if (record.preview === true) {
        // PREVIEW MODE: render the before/after pair, measure both, arm the
        // studio chip — still a pure read over the project.
        if (ctx.mixPreview == null) {
          return mcpError(
            "UNAVAILABLE_ON_TRANSPORT",
            "mix preview is not available over this MCP transport (no render context bound) — use apply:true for the plan-and-apply loop",
          );
        }
        try {
          const { formatMixPreview } = await import("./mix-preview");
          const outcome = await ctx.mixPreview({ idea, ...(target ? { target } : {}) });
          const data = outcome.ok
            ? {
                status: "previewed",
                ok: true,
                applied: false,
                preview: {
                  laneId: outcome.lane.id,
                  label: outcome.lane.label,
                  targets: outcome.lane.targets,
                  goals: outcome.lane.goals,
                  interpreter: outcome.lane.interpreter,
                  beforeLufs: outcome.lane.stats.beforeLufs,
                  afterLufs: outcome.lane.stats.afterLufs,
                  matchGainDb: outcome.lane.stats.matchGainDb,
                  seconds: outcome.lane.stats.seconds,
                  studioBound: outcome.studioBound,
                },
              }
            : { status: "rejected", ok: false, applied: false, reason: outcome.reason };
          return { text: formatMixPreview(outcome), mutated: false, data };
        } catch (error) {
          return mcpError(
            "EXECUTION_FAILED",
            `mix preview failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      try {
        const { planMixIdea, formatMixIdea } = await import("./mix-idea");
        const plan = planMixIdea(ctx.getDoc(), idea, target);
        if (!plan.ok) {
          return {
            text: plan.reason,
            mutated: false,
            isError: apply,
            data: { status: "rejected", ok: false, applied: false, reason: plan.reason },
          };
        }
        if (apply) {
          ctx.execute(plan.command);
        }
        return {
          text: formatMixIdea(plan, apply),
          mutated: apply,
          data: {
            status: apply ? "applied" : "planned",
            ok: true,
            applied: apply,
            interpreter: plan.interpreter,
            targets: plan.targets,
            goals: plan.goals,
            label: plan.label,
            steps: plan.steps,
            warnings: plan.warnings,
          },
        };
      } catch (error) {
        return mcpError(
          "EXECUTION_FAILED",
          `mix idea failed: ${error instanceof Error ? error.message : String(error)}`,
        );
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
          data: { op: "plan", status: "planned", gains: plan.gains },
        };
      }
      if (op === "record") {
        const laneValue = record.lane;
        if (laneValue !== undefined && (typeof laneValue !== "string" || laneValue.length > BLIND_AB_MAX_LANE_LENGTH)) {
          return mcpError(
            "INVALID_ARGUMENTS",
            `lane must be a string of at most ${BLIND_AB_MAX_LANE_LENGTH} characters`,
          );
        }
        if (record.xWas !== "A" && record.xWas !== "B") {
          return mcpError("INVALID_ARGUMENTS", "trial needs xWas: A|B (which side was X)");
        }
        if (record.answer !== "A" && record.answer !== "B") {
          return mcpError("INVALID_ARGUMENTS", "trial needs answer: A|B (what the listener picked)");
        }
        if (
          record.reactionMs !== undefined &&
          (typeof record.reactionMs !== "number" ||
            !Number.isSafeInteger(record.reactionMs) ||
            record.reactionMs < 0 ||
            record.reactionMs > BLIND_AB_MAX_REACTION_MS)
        ) {
          return mcpError("INVALID_ARGUMENTS", `reactionMs must be an integer from 0 to ${BLIND_AB_MAX_REACTION_MS}`);
        }
        let entry: ReturnType<typeof recordBlindAbTrial>;
        try {
          entry = recordBlindAbTrial({
            lane: typeof laneValue === "string" ? laneValue : "default",
            xWas: record.xWas,
            answer: record.answer,
            ...(typeof record.reactionMs === "number" ? { reactionMs: record.reactionMs } : {}),
          });
        } catch (error) {
          if (error instanceof BlindAbTrialLimitError) return mcpError("RESOURCE_LIMIT", error.message);
          throw error;
        }
        return {
          text: `trial recorded: ${entry.correct ? "correct" : "incorrect"} (lane "${entry.lane}")`,
          mutated: false,
          data: { op: "record", status: "recorded", trial: entry },
          idempotencyCommitted: true,
        };
      }
      if (op === "verdict") {
        const laneValue = record.lane;
        if (laneValue !== undefined && (typeof laneValue !== "string" || laneValue.length > BLIND_AB_MAX_LANE_LENGTH)) {
          return mcpError(
            "INVALID_ARGUMENTS",
            `lane must be a string of at most ${BLIND_AB_MAX_LANE_LENGTH} characters`,
          );
        }
        const lane = typeof laneValue === "string" ? laneValue : "default";
        const summary = summarizeBlindAb(lane);
        if (summary == null) {
          return {
            text: "no trials recorded for this lane yet — record trials with op:record (the human listens, you count)",
            mutated: false,
            data: { op: "verdict", status: "no_trials", lane },
          };
        }
        return {
          text: `blind A/B "${summary.lane}": ${summary.correct}/${summary.total} correct (p = ${summary.pValue.toFixed(4)}${summary.hastyExcluded > 0 ? `, ${summary.hastyExcluded} hasty excluded` : ""}) — ${summary.verdict}`,
          mutated: false,
          data: {
            op: "verdict",
            status: "summarized",
            lane: summary.lane,
            total: summary.total,
            correct: summary.correct,
            pValue: summary.pValue,
            hastyExcluded: summary.hastyExcluded,
            verdict: summary.verdict,
            summary,
          },
        };
      }
      if (op === "reset") {
        if (record.confirm !== true) {
          return mcpError("POLICY_REFUSED", "clearing all blind A/B trial evidence needs confirm:true");
        }
        const cleared = resetBlindAbTrials();
        return {
          text: `blind A/B trial log cleared (${cleared.clearedTrials} trial(s) across ${cleared.clearedLanes} lane(s))`,
          mutated: false,
          data: { op: "reset", status: "cleared", ...cleared },
          idempotencyCommitted: true,
        };
      }
      return mcpError("UNKNOWN_REQUEST", `unknown blind_ab op: ${op} (plan | record | verdict | reset)`);
    }
    default:
      return mcpError("UNKNOWN_TOOL", `unknown tool: ${name}`);
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
      return mcpError("UNKNOWN_REQUEST", `unknown resource: ${uri} — see resources/list`);
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
  if (typeof record.genre !== "string" || record.genre.length === 0) {
    return mcpError("INVALID_ARGUMENTS", "genre is required and must be a string");
  }
  const genre = record.genre;
  if (!MIX_GENRES.includes(genre as (typeof MIX_GENRES)[number])) {
    return mcpError("UNKNOWN_REQUEST", `unknown genre "${genre}" - one of: ${MIX_GENRES.join(", ")}`);
  }
  if (record.mood !== undefined && (typeof record.mood !== "string" || record.mood.length > 128)) {
    return mcpError("INVALID_ARGUMENTS", "mood must be a string of at most 128 characters");
  }
  if (
    record.energy !== undefined &&
    (typeof record.energy !== "number" || !Number.isFinite(record.energy) || record.energy < 0 || record.energy > 1)
  ) {
    return mcpError("INVALID_ARGUMENTS", "energy must be a finite number from 0 to 1");
  }
  if (
    record.tone !== undefined &&
    (typeof record.tone !== "string" || !["dark", "bright", "warm", "cold"].includes(record.tone))
  ) {
    return mcpError("INVALID_ARGUMENTS", "tone must be one of: dark, bright, warm, cold");
  }
  if (
    record.reverb !== undefined &&
    (typeof record.reverb !== "string" || !["more", "less", "huge"].includes(record.reverb))
  ) {
    return mcpError("INVALID_ARGUMENTS", "reverb must be one of: more, less, huge");
  }
  if (record.punch !== undefined && (typeof record.punch !== "string" || !["more", "less"].includes(record.punch))) {
    return mcpError("INVALID_ARGUMENTS", "punch must be one of: more, less");
  }
  if (record.pump !== undefined && (typeof record.pump !== "string" || !["on", "off"].includes(record.pump))) {
    return mcpError("INVALID_ARGUMENTS", "pump must be one of: on, off");
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
      data: { status: "neutral", genre, decisionCount: 0, summary: [] },
    };
  }
  try {
    const command = applyMixIntent(ctx.getDoc(), profile);
    ctx.execute(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/changed nothing/i.test(message)) {
      return {
        text: "mix already matches the profile - changed nothing",
        mutated: false,
        data: { status: "already_matched", genre, decisionCount: profile.decisions.length, summary: profile.summary },
      };
    }
    return mcpError("EXECUTION_FAILED", `mix failed: ${message}`);
  }
  return {
    text: `mix applied (${profile.decisions.length} decisions): ${profile.summary.join(" | ")} - one undo step`,
    mutated: true,
    data: { status: "applied", genre, decisionCount: profile.decisions.length, summary: profile.summary },
  };
}

async function executeArrangeTool(ctx: McpToolContext, record: Record<string, unknown>): Promise<McpToolResult> {
  if (typeof record.genre !== "string" || record.genre.length === 0) {
    return mcpError("INVALID_ARGUMENTS", "genre is required and must be a string");
  }
  const genre = record.genre;
  if (!MIX_GENRES.includes(genre as (typeof MIX_GENRES)[number])) {
    return mcpError("UNKNOWN_REQUEST", `unknown genre "${genre}" - one of: ${MIX_GENRES.join(", ")}`);
  }
  if (
    record.energy !== undefined &&
    (typeof record.energy !== "number" || !Number.isFinite(record.energy) || record.energy < 0 || record.energy > 1)
  ) {
    return mcpError("INVALID_ARGUMENTS", "energy must be a finite number from 0 to 1");
  }
  const lengthKinds = ["short", "standard", "radio", "extended", "epic"] as const;
  if (
    record.length !== undefined &&
    (typeof record.length !== "string" || !lengthKinds.includes(record.length as (typeof lengthKinds)[number]))
  ) {
    return mcpError("INVALID_ARGUMENTS", "length must be one of: short, standard, radio, extended, epic");
  }
  const doc = ctx.getDoc();
  if (doc.arrangement.clips.length > 0) {
    return mcpError(
      "POLICY_REFUSED",
      "arrangement already has clips - kyx_arrange lays out a WHOLE form; " +
        "use kyx_sections / kyx_clips for surgical edits, or clear the arrangement first",
    );
  }
  const spec = normalizeIntent({
    genre: genre as never,
    ...(typeof record.energy === "number" ? { energy: record.energy } : {}),
  });
  const lengthKind = lengthKinds.find((kind) => kind === record.length);
  const length =
    lengthKind != null
      ? { kind: lengthKind as "short" | "standard" | "radio" | "extended" | "epic", label: lengthKind }
      : null;
  // The song planner is a heavy domain module — load it only when an
  // arrange/song command actually arrives (keeps the eager DAW graph lean).
  const { planSongForm } = await import("../intent/song");
  const planned: SongSectionSpec[] = planSongForm(spec, undefined, length).sections;
  if (planned.length === 0) {
    return {
      text: "the genre produced an empty form - nothing to arrange",
      mutated: false,
      data: {
        status: "empty",
        genre,
        sections: [],
        scenes: [],
        clips: [],
        markers: [],
        sceneCount: 0,
        clipCount: 0,
        cueMarkerCount: 0,
        totalBars: 0,
        undoSteps: 0,
      },
    };
  }

  let next = doc;
  let bar = 1; // human 1-based
  const rows: string[] = [];
  const resultSections: Array<{ label: string; role: string; startBar: number; bars: number; intensity: number }> = [];
  for (const section of planned) {
    next = createScene(next, section.label).execute(next);
    const scene = next.scenes[next.scenes.length - 1];
    if (!scene) return mcpError("PARTIAL_FAILURE", "scene creation failed mid-form");
    next = setSceneRole(next, scene.id, section.role).execute(next);
    next = setSceneIntensity(next, scene.id, section.intensity).execute(next);
    next = addArrangementClip(next, scene.id, (bar - 1) * 4, section.bars).execute(next);
    const clip = next.arrangement.clips.find((candidate) => candidate.sceneId === scene.id);
    if (!clip) return mcpError("PARTIAL_FAILURE", `arrangement clip creation failed for ${section.label}`);
    const existingMarkerIds = new Set(next.markers.map((marker) => marker.id));
    next = addMarker(next, { tick: (bar - 1) * TICKS_PER_BAR, name: section.label }).execute(next);
    const marker = next.markers.find((candidate) => !existingMarkerIds.has(candidate.id));
    if (!marker) return mcpError("PARTIAL_FAILURE", `cue marker creation failed for ${section.label}`);
    rows.push(`${section.role} ${section.bars}bar@${bar}`);
    resultSections.push({
      label: section.label,
      role: section.role,
      startBar: bar,
      bars: section.bars,
      intensity: section.intensity,
    });
    bar += section.bars;
  }
  const plannedTotalBars = bar - 1;
  const command = snapshot(
    "mcpArrange",
    `MCP: arrange '${genre}' form (${planned.length} sections, ${plannedTotalBars} bars)`,
    doc,
    next,
  );
  ctx.execute(command);
  const committed = ctx.getDoc();
  const existingSceneIds = new Set(doc.scenes.map((scene) => scene.id));
  const existingClipIds = new Set(doc.arrangement.clips.map((clip) => clip.id));
  const existingMarkerIds = new Set(doc.markers.map((marker) => marker.id));
  const scenes = committed.scenes
    .filter((scene) => !existingSceneIds.has(scene.id))
    .map((scene) => ({ id: scene.id, name: scene.name, role: scene.role ?? "custom", intensity: scene.intensity }));
  const clips = committed.arrangement.clips
    .filter((clip) => !existingClipIds.has(clip.id))
    .map((clip) => ({ id: clip.id, sceneId: clip.sceneId, startBar: clip.startBar, lengthBars: clip.lengthBars }));
  const markers = committed.markers
    .filter((marker) => !existingMarkerIds.has(marker.id))
    .map((marker) => ({ id: marker.id, name: marker.name, type: marker.type, tick: marker.tick }));
  const cueMarkerCount = markers.filter((marker) => marker.type === "cue").length;
  const totalBars = clips.reduce((sum, clip) => sum + clip.lengthBars, 0);
  const complete =
    scenes.length === planned.length && clips.length === planned.length && cueMarkerCount === planned.length;
  const data = {
    status: complete ? "arranged" : "partial",
    genre,
    sections: resultSections,
    scenes,
    clips,
    markers,
    sceneCount: scenes.length,
    clipCount: clips.length,
    cueMarkerCount,
    totalBars,
    undoSteps: scenes.length + clips.length + markers.length > 0 ? 1 : 0,
  };
  if (!complete) {
    return mcpError(
      "PARTIAL_FAILURE",
      `arrangement read-back incomplete: ${scenes.length}/${planned.length} scenes, ${clips.length}/${planned.length} clips, ${cueMarkerCount}/${planned.length} cue markers`,
      { mutated: data.undoSteps > 0, data },
    );
  }
  return {
    text: `arranged '${genre}' form: ${rows.join(" · ")} - ${planned.length} scenes, ${totalBars} bars, cue markers at every section (one undo step)`,
    mutated: true,
    data,
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
/** Session-scoped UN-SUNO source fingerprint (kyx_unsuno similarity) — dies
 * with reload like the producer session (D6 honesty, documented). */
let unsunoSourceFingerprint: SourceCompositionFingerprint | null = null;

/** Test/diagnostic hook: drop the session-scoped UN-SUNO state. */
export function resetMcpUnsunoState(): void {
  unsunoSourceFingerprint = null;
}

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

/** Best-effort durable write of an in-memory checkpoint. The record shape is
 *  the shared `qvester-mcp-checkpoints` convention (${projectId}::${name}), so
 *  the SAME checkpoint is restorable from the Intent Bar, kyx_checkpoint and
 *  the Agent Activity panel. Returns the durability for the caller's text. */
async function persistCheckpoint(name: string): Promise<"persisted" | "unavailable" | "failed"> {
  const entry = checkpoints.get(name);
  if (entry == null) return "failed";
  const repo = await getCheckpointRepo();
  if (repo == null) return "unavailable";
  try {
    await repo.put({
      key: `${entry.projectId}::${name}`,
      projectId: entry.projectId,
      name,
      label: entry.summary,
      auto: entry.auto,
      savedAt: new Date().toISOString(),
      doc: entry.doc,
    });
    return "persisted";
  } catch {
    return "failed";
  }
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
    const durability = await persistCheckpoint(saved);
    const durable =
      durability === "persisted"
        ? "persisted"
        : durability === "unavailable"
          ? "session only"
          : "session only (persistence unavailable)";
    return {
      text: `checkpoint "${saved}" saved (${entry.summary}) — ${durable}, ${checkpoints.size}/${CHECKPOINT_LIMIT} in memory`,
      mutated: false,
    };
  }
  if (name === "") {
    return mcpError("INVALID_ARGUMENTS", `checkpoint ${op} needs a name — kyx_checkpoint {op: list} shows them`);
  }
  const cp = checkpoints.get(name);
  if (!cp) {
    return mcpError(
      "UNKNOWN_TARGET",
      `no checkpoint "${name}" — kyx_checkpoint {op: list} shows: ${[...checkpoints.keys()].join(", ") || "none"}`,
    );
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
  return mcpError("UNKNOWN_REQUEST", `unknown checkpoint op: ${op}`);
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

/** MCP-side clipboard (P2 parity, owner-approved 2026-10-14). Module scope:
 * an agent's copy must survive to a later paste the way the UI's does, and a
 * ProjectDocument has no field for it. Deliberately NOT persisted into the
 * project — pasting into one project must never paste from another. */
let mcpClipClipboard: ClipClipboard | null = null;

/** Human-readable clipboard contents, so a copy/paste result says WHAT moved
 * rather than only that something did. */
function clipboardSummary(clipboard: ClipClipboard): string {
  const parts: string[] = [];
  if (clipboard.arrangementClips.length > 0) parts.push(`${clipboard.arrangementClips.length} scene clip(s)`);
  if (clipboard.audioClips.length > 0) parts.push(`${clipboard.audioClips.length} audio clip(s)`);
  if (clipboard.midiClips.length > 0) parts.push(`${clipboard.midiClips.length} MIDI clip(s)`);
  if (clipboard.automationClips.length > 0) parts.push(`${clipboard.automationClips.length} automation clip(s)`);
  return parts.length > 0 ? parts.join(", ") : "empty clipboard";
}

/** kyx_clips - structured arrangement-clip edits over the same commands the
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

  // ── CLIPBOARD (P2 parity, owner-approved 2026-10-14) ─────────────────
  // Handled before target resolution: `paste` has no source clip to address.
  try {
    if (op === "copy" || op === "cut" || op === "paste") {
      if (op === "paste") {
        if (!mcpClipClipboard) return { text: "clipboard is empty — copy or cut first", mutated: false };
        // Paste at the playhead unless a bar is named; the UI pastes at the
        // playhead, so an agent that passes no bar lands where a user would.
        const rawPasteBar = Number(record.bar);
        const playhead = typeof ctx.transport.position === "number" ? ctx.transport.position : 0;
        const atTick = Number.isFinite(rawPasteBar) && rawPasteBar >= 1 ? (rawPasteBar - 1) * TICKS_PER_BAR : playhead;
        ctx.execute(pasteClips(doc, mcpClipClipboard, atTick));
        const where =
          Number.isFinite(rawPasteBar) && rawPasteBar >= 1 ? `bar ${Math.round(rawPasteBar)}` : "the playhead";
        return { text: `pasted ${clipboardSummary(mcpClipClipboard)} at ${where} — one undo step`, mutated: true };
      }

      // copy / cut both need a source clip: the arrangement clip covering the
      // anchor bar, else the audio clip on a named track at that bar.
      const rawBar = typeof record.bar === "number" ? record.bar : 1;
      if (!Number.isFinite(rawBar) || rawBar < 1) {
        return { text: `${op} needs a 1-based anchor bar`, mutated: false };
      }
      const sceneClip = clipCoveringBar(doc, Math.round(rawBar));
      let targets: string[] = sceneClip ? [sceneClip.id] : [];
      if (targets.length === 0) {
        // No scene clip there — try the audio lane, using the SAME addressing the
        // audio* ops use (trackId or family + anchor bar).
        const trackId = typeof record.trackId === "string" ? record.trackId.trim() : "";
        const family = typeof record.family === "string" ? record.family.trim() : "";
        if (trackId !== "" || family !== "") {
          let ownerId: string | null = trackId !== "" ? trackId : null;
          if (ownerId === null) {
            const ids = tracksInFamily(doc, family);
            if (ids.length === 0) return mcpError("UNKNOWN_TARGET", `no track matches family "${family}"`);
            ownerId = ids[0]!;
          }
          const anchor = Math.round(rawBar) - 1;
          const audio = doc.arrangement.audioClips ?? [];
          const audioTarget = audio.find(
            (clip) => clip.trackId === ownerId && anchor >= clip.startBar && anchor < clip.startBar + clip.lengthBars,
          );
          if (audioTarget) targets = [audioTarget.id];
        }
      }
      if (targets.length === 0) {
        return {
          text: `no clip covers bar ${Math.round(rawBar)} — read the layout via op:list`,
          mutated: false,
        };
      }
      const built = buildClipClipboard(doc, targets);
      if (!built) return { text: "nothing copyable at that address", mutated: false };
      mcpClipClipboard = built;
      if (op === "copy") {
        return { text: `copied ${clipboardSummary(built)} — paste with op:paste`, mutated: false };
      }
      // CUT is a delete: it must ride the D4 gate like every other removal.
      if (ctx.allowDestructive?.() !== true) return destructiveRefusal();
      ctx.execute(cutClips(doc, targets));
      return { text: `cut ${clipboardSummary(built)} - one undo step`, mutated: true };
    }
  } catch (error) {
    // Clipboard commands throw on real invariants (a paste that would overlap a
    // scene clip, or a clipboard captured in another project). Over MCP that is an
    // honest failure, never a thrown crash into the relay.
    return mcpError(
      "EXECUTION_FAILED",
      `clipboard op failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

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
      if (ids.length === 0) return mcpError("UNKNOWN_TARGET", `no track matches family "${family}"`);
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
      if (op === "audioStretch") {
        // P2-D (parity sweep): stretch was UI-only. rate is the playback
        // speed factor (2 = twice as fast, half the length feel); bars keeps
        // the clip's musical length unless the caller names a new one.
        const rate = Number(record.rate);
        if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) {
          return mcpError("INVALID_ARGUMENTS", "audioStretch needs rate (0.25..4 — 2 = twice as fast)");
        }
        const bars = Number.isFinite(Number(record.bars)) ? Number(record.bars) : target.lengthBars;
        ctx.execute(stretchAudioClip(doc, target.id, bars, rate));
        return { text: `stretched ${describe()} ×${Math.round(rate * 100) / 100} — one undo step`, mutated: true };
      }
      if (op === "audioSlip") {
        // P2-D (parity sweep): slip was UI-only (Alt+drag). offsetSec picks
        // WHICH part of the source plays — geometry, fades and gain ride
        // untouched; the command asserts the clip is not take-locked.
        const offsetSec = Number(record.offsetSec);
        if (!Number.isFinite(offsetSec) || offsetSec < 0) {
          return mcpError("INVALID_ARGUMENTS", "audioSlip needs offsetSec (≥0 seconds into the source)");
        }
        ctx.execute(slipAudioClip(doc, target.id, offsetSec));
        return { text: `slipped ${describe()} to source offset ${offsetSec}s — one undo step`, mutated: true };
      }
      if (op === "audioCrossfade") {
        // P2-D remainder (parity sweep): crossfade was UI-only
        // (rangeCrossfade). The target is the clip covering the anchor bar;
        // the partner is the PREVIOUS clip on the same lane. The command is
        // direction-safe and throws on non-overlap — surfaced honestly.
        const earlier = (doc.arrangement.audioClips ?? [])
          .filter((c) => c.trackId === target.trackId && c.startBar < target.startBar)
          .sort((a, b) => b.startBar - a.startBar)[0];
        if (!earlier) {
          return mcpError(
            "UNKNOWN_TARGET",
            `no earlier clip on ${ownerNameOf(doc, target.trackId)} to crossfade into — both clips must overlap`,
          );
        }
        const curve = record.curve === "equal" ? { curve: "equal" as const } : {};
        ctx.execute(crossfadeAudioClips(doc, earlier.id, target.id, curve));
        return {
          text: `crossfaded ${describe()} into the clip at bar ${target.startBar + 1} — one undo step`,
          mutated: true,
        };
      }
      if (op === "audioDelete") {
        if (ctx.allowDestructive?.() !== true) return destructiveRefusal();
        ctx.execute(deleteAudioClip(doc, target.id));
        return { text: `deleted ${describe()} — one undo step`, mutated: true };
      }
      if (op === "audioDuplicate") {
        // P2 parity (owner-approved 2026-10-14): duplicate was UI-only. The
        // audio lane LAYERS by contract, so the copy lands exactly after its
        // source and may overlap neighbours - same as any moved clip.
        ctx.execute(duplicateAudioClip(doc, target.id));
        return { text: `duplicated ${describe()} - copy placed after the source, one undo step`, mutated: true };
      }
      if (op === "audioMute") {
        // Clip-level mute: the clip is skipped by playback entirely. Absent
        // means audible, so this writes `muted: true` and the command skips a
        // no-op re-mute so the undo stack never grows a dead step.
        const muted = record.muted !== false;
        ctx.execute(setAudioClipsMute(doc, [target.id], muted));
        return { text: `${muted ? "muted" : "unmuted"} ${describe()} - one undo step`, mutated: true };
      }
      if (op === "audioNudge") {
        // Keyboard `,` / `.` : shift the clip by whole bars without moving the
        // pointer. deltaBars may be negative.
        const deltaBars = Number(record.bars);
        if (!Number.isFinite(deltaBars) || deltaBars === 0) {
          return mcpError("INVALID_ARGUMENTS", "audioNudge needs bars - a non-zero whole-bar delta");
        }
        ctx.execute(nudgeClips(doc, [target.id], Math.round(deltaBars)));
        return {
          text: `nudged ${describe()} by ${Math.round(deltaBars) > 0 ? "+" : ""}${Math.round(deltaBars)} bar(s) - one undo step`,
          mutated: true,
        };
      }
      if (op === "audioSlice") {
        // SlicerX-style: the clip is KEPT and the segments are laid out as a
        // row after it (measured in wave 20 §J). Slice points are wall seconds
        // from the clip's first audible moment.
        // `record` values arrive as `unknown` from the relay, so narrow explicitly
        // rather than casting — a cast here would let a string through to the
        // command and fail deep inside it instead of at the boundary.
        const rawTimes = record.sliceTimesSec;
        const times: number[] = Array.isArray(rawTimes)
          ? rawTimes.filter((v: unknown): v is number => typeof v === "number" && Number.isFinite(v))
          : [];
        if (times.length === 0) {
          return mcpError("INVALID_ARGUMENTS", "audioSlice needs sliceTimesSec: an array of seconds inside the clip");
        }
        ctx.execute(sliceAudioClipToArrangement(doc, target.id, times));
        return { text: `sliced ${describe()} at ${times.length} point(s) - one undo step`, mutated: true };
      }
      if (op === "audioStrip") {
        // Strip silence: the clip is REPLACED by its audible segments, so this
        // is a delete-and-write and the command asserts the clip is editable.
        const segments = Array.isArray(record.segments)
          ? record.segments
              .filter(
                (v): v is { startSec: number; endSec: number } =>
                  typeof v === "object" &&
                  v !== null &&
                  Number.isFinite((v as { startSec?: number }).startSec) &&
                  Number.isFinite((v as { endSec?: number }).endSec),
              )
              .map((v) => ({ startSec: v.startSec, endSec: v.endSec }))
          : [];
        if (segments.length === 0) {
          return mcpError(
            "INVALID_ARGUMENTS",
            "audioStrip needs segments: [{startSec, endSec}, ...] - the ranges to KEEP",
          );
        }
        const sourceDurationSec =
          typeof record.sourceDurationSec === "number" && Number.isFinite(record.sourceDurationSec)
            ? record.sourceDurationSec
            : undefined;
        ctx.execute(stripSilenceAudioClip(doc, target.id, segments, sourceDurationSec));
        return { text: `stripped silence from ${describe()} - ${segments.length} segment(s) kept`, mutated: true };
      }
      if (op === "audioConsolidate") {
        // Consolidate merges N clips into ONE new clip pointing at a rendered
        // bounce buffer. It needs both the partner range and a bufferId - the
        // tool cannot render the bounce itself, so the caller supplies it.
        const bufferId = typeof record.bufferId === "string" ? record.bufferId.trim() : "";
        if (bufferId === "") {
          return mcpError(
            "INVALID_ARGUMENTS",
            "audioConsolidate needs bufferId - the rendered bounce buffer the merged clip will point at",
          );
        }
        const rangeBars = Math.max(1, Math.round(Number(record.bars) || 4));
        const first = target.startBar;
        const selected = (doc.arrangement.audioClips ?? [])
          .filter(
            (clip) => clip.trackId === target.trackId && clip.startBar >= first && clip.startBar < first + rangeBars,
          )
          .map((clip) => clip.id);
        if (selected.length < 2) {
          return mcpError(
            "INVALID_ARGUMENTS",
            `audioConsolidate needs at least 2 clips on ${ownerNameOf(doc, target.trackId)} in the range - found ${selected.length}; widen bars`,
          );
        }
        ctx.execute(consolidateAudioClips(doc, selected, bufferId));
        return {
          text: `consolidated ${selected.length} clip(s) on ${ownerNameOf(doc, target.trackId)} into buffer ${bufferId} - one undo step`,
          mutated: true,
        };
      }
      return {
        text: `unknown op: ${op} (list | audioList | audioMove | audioSplit | audioUpdate | audioStretch | audioSlip | audioDuplicate | audioMute | audioNudge | audioSlice | audioStrip | audioConsolidate | audioCrossfade | audioDelete | move | resize | split | duplicate | delete | moveRipple | resizeRipple | deleteRipple | copy | cut | paste)`,
        mutated: false,
      };
    } catch (error) {
      return mcpError(
        "EXECUTION_FAILED",
        `audio clip op failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    if (op === "split") {
      // Scene clips split on their BAR GRID by design (audit wave 1 verified
      // this is deliberate, not a snapping bug): audio clips split
      // sample-precise, scene clips split at the bar boundary covering the
      // anchor. The MCP lane can only name a whole bar, so it is the same
      // primitive the grid cut tool uses.
      const tick = (Math.round(rawBar) - 1) * TICKS_PER_BAR;
      ctx.execute(splitArrangementClipAtTick(doc, clip.id, tick));
      return { text: `split ${describeClip(clip)} at bar ${Math.round(rawBar)} — one undo step`, mutated: true };
    }
    if (op === "delete") {
      if (ctx.allowDestructive?.() !== true) return destructiveRefusal();
      ctx.execute(deleteArrangementClip(doc, clip.id));
      return { text: `deleted ${describeClip(clip)} — one undo step`, mutated: true };
    }
    // ── RIPPLE variants (P2 parity, owner-approved 2026-10-14) ─────────────
    // The UI has a RIPPLE toggle that switches move/resize/delete to their
    // gap-closing forms. Without these ops an agent's delete NEVER closes a
    // gap while a user's does — a silent semantic divergence, which is the
    // exact thing §B2 of the audit warned about.
    if (op === "moveRipple") {
      const toBar = Math.round(Number(record.toBar));
      if (!Number.isFinite(toBar) || toBar < 1) {
        return { text: "moveRipple needs toBar (1-based destination start bar)", mutated: false };
      }
      ctx.execute(moveArrangementClipRipple(doc, clip.id, toBar - 1));
      return {
        text: `moved ${describeClip(clip)} → bar ${toBar} (ripple: later clips close the gap) — one undo step`,
        mutated: true,
      };
    }
    if (op === "resizeRipple") {
      const bars = Math.round(Number(record.bars));
      if (!Number.isFinite(bars) || bars < 1 || bars > 64) {
        return { text: "resizeRipple needs bars 1..64 (new clip length)", mutated: false };
      }
      ctx.execute(resizeArrangementClipRipple(doc, clip.id, bars));
      return {
        text: `resized ${describeClip(clip)} → ${bars} bar(s) (ripple: later clips close the gap) — one undo step`,
        mutated: true,
      };
    }
    if (op === "deleteRipple") {
      if (ctx.allowDestructive?.() !== true) return destructiveRefusal();
      ctx.execute(deleteArrangementClipRipple(doc, clip.id));
      return {
        text: `deleted ${describeClip(clip)} (ripple: later clips close the gap) — one undo step`,
        mutated: true,
      };
    }
    return {
      text: `unknown op: ${op} (list | move | resize | split | duplicate | delete | moveRipple | resizeRipple | deleteRipple)`,
      mutated: false,
    };
  } catch (error) {
    // Arrangement commands throw on invariants (overlap, bounds) — honest
    // failure over MCP, never a thrown crash into the relay.
    return mcpError("EXECUTION_FAILED", `clip op failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Resolve a return bus from the record: returnId (exact) or returnName
 * (case-insensitive). Null when nothing matches — the caller reports. */
function resolveReturnId(doc: ProjectDocument, record: Record<string, unknown>): string | null {
  const returnId = typeof record.returnId === "string" ? record.returnId.trim() : "";
  if (returnId !== "") return doc.returns.some((r) => r.id === returnId) ? returnId : null;
  const returnName = typeof record.returnName === "string" ? record.returnName.trim().toLowerCase() : "";
  if (returnName === "") return null;
  const matches = doc.returns.filter((r) => r.name.toLowerCase() === returnName);
  return matches.length === 1 ? matches[0]!.id : null;
}

/** kyx_routing — the group routing graph. The model is FLAT (a track joins
 * at most one group; addToGroup refuses group-into-group), so routing
 * cycles are impossible by construction — the domain IS the cycle check. */
function executeRoutingTool(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  if (record.op !== undefined && typeof record.op !== "string") {
    return mcpError(
      "INVALID_ARGUMENTS",
      "op must be one of: list, createGroup, addToGroup, removeFromGroup, setSend, setReturnGain, createReturn, removeReturn",
    );
  }
  const op = typeof record.op === "string" ? record.op : "list";
  const validOps = [
    "list",
    "createGroup",
    "addToGroup",
    "removeFromGroup",
    "setSend",
    "setReturnGain",
    "createReturn",
    "removeReturn",
  ];
  if (!validOps.includes(op)) return mcpError("UNKNOWN_REQUEST", `unknown op: ${op} (${validOps.join(" | ")})`);
  for (const [field, maxLength] of [
    ["trackId", 128],
    ["groupId", 128],
    ["returnId", 128],
    ["groupName", 40],
    ["returnName", 40],
    ["name", 40],
  ] as const) {
    const value = record[field];
    if (value !== undefined && (typeof value !== "string" || value.length > maxLength)) {
      return mcpError("INVALID_ARGUMENTS", `${field} must be a string of at most ${maxLength} characters`);
    }
  }
  if (
    record.family !== undefined &&
    (typeof record.family !== "string" || !["drums", "bass", "chords", "lead", "vocal"].includes(record.family))
  ) {
    return mcpError("INVALID_ARGUMENTS", "family must be one of: drums, bass, chords, lead, vocal");
  }
  for (const field of ["level", "gain"] as const) {
    const value = record[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      return mcpError("INVALID_ARGUMENTS", `${field} must be a finite number`);
    }
  }
  const doc = ctx.getDoc();
  const groupNameMatches = (name: string) =>
    doc.tracks.filter((track) => track.kind === "group" && track.name.toLowerCase() === name.toLowerCase());
  const resolveGroup = (): string | null => {
    const groupId = typeof record.groupId === "string" ? record.groupId.trim() : "";
    if (groupId !== "") {
      return doc.tracks.some((t) => t.id === groupId && t.kind === "group") ? groupId : null;
    }
    const groupName = typeof record.groupName === "string" ? record.groupName.trim() : "";
    if (groupName !== "") {
      const matches = groupNameMatches(groupName);
      return matches.length === 1 ? matches[0]!.id : null;
    }
    return null;
  };

  const routeReadback = (current: ProjectDocument) => {
    const routes = current.tracks
      .filter((track) => track.kind !== "group")
      .map((track) => {
        const destination = "groupId" in track && track.groupId ? track.groupId : "master";
        return {
          trackId: track.id,
          track: track.name,
          destination,
          destinationName: destination === "master" ? "master" : ownerNameOf(current, destination),
        };
      });
    const groups = current.tracks
      .filter((track) => track.kind === "group")
      .map((group) => ({
        id: group.id,
        name: group.name,
        memberCount: current.tracks.filter((track) => track.kind !== "group" && track.groupId === group.id).length,
      }));
    const returns = current.returns.map((returnTrack) => ({
      id: returnTrack.id,
      name: returnTrack.name,
      gain: returnTrack.gain,
      sends: current.tracks.flatMap((track) => {
        const level = (track as { sends?: Record<string, number> }).sends?.[returnTrack.id];
        return track.kind !== "group" && level !== undefined ? [{ trackId: track.id, track: track.name, level }] : [];
      }),
    }));
    return { routes, groups, returns };
  };

  if (op === "list") {
    const readback = routeReadback(doc);
    const lines: string[] = [];
    for (const route of readback.routes) {
      lines.push(
        `${route.track} (id=${route.trackId}) → ${route.destinationName}${route.destination !== "master" ? ` (id=${route.destination})` : ""}`,
      );
    }
    for (const group of readback.groups) {
      const members = doc.tracks.filter((track) => track.kind !== "group" && track.groupId === group.id);
      lines.push(
        `group ${group.name} (id=${group.id}): ${members.length} member(s) — ${members.map((member) => member.name).join(", ") || "empty"}`,
      );
    }
    if (readback.returns.length > 0) {
      lines.push(
        `returns (send buses → master): ${readback.returns.map((returnTrack) => returnTrack.name).join(", ")}`,
      );
    }
    return {
      text: lines.join("\n") || "no tracks",
      mutated: false,
      data: { status: "listed", ...readback },
    };
  }

  try {
    if (op === "createGroup") {
      const name = typeof record.name === "string" ? record.name.trim().slice(0, 40) : "";
      const previousGroupIds = new Set(doc.tracks.filter((track) => track.kind === "group").map((track) => track.id));
      const expectedName =
        name !== "" ? name : `Group ${doc.tracks.filter((track) => track.kind === "group").length + 1}`;
      ctx.execute(createGroupTrack(doc, name || undefined));
      const committed = ctx.getDoc();
      const createdGroups = committed.tracks.filter(
        (track) => track.kind === "group" && !previousGroupIds.has(track.id),
      );
      const created = createdGroups.length === 1 ? createdGroups[0] : undefined;
      const matches = created != null && created.name === expectedName;
      const data = {
        status: matches ? "created" : "partial",
        ...(created != null ? { groupId: created.id, groupName: created.name } : {}),
        undoSteps: createdGroups.length > 0 ? 1 : 0,
      };
      if (!matches) {
        return mcpError("PARTIAL_FAILURE", "group creation did not match one new group in the project read-back", {
          mutated: createdGroups.length > 0,
          data,
        });
      }
      return {
        text: `created group "${created.name}" (id=${created.id}) — one undo step`,
        mutated: true,
        data,
      };
    }
    if (op === "addToGroup") {
      const ids = explicitTrackIds(doc, record);
      if (typeof ids === "string") return mcpError("UNKNOWN_TARGET", ids);
      if (ids.length === 0)
        return mcpError("UNKNOWN_TARGET", `no track matches family "${String(record.family ?? "")}"`);
      const groupId = resolveGroup();
      if (groupId == null) {
        const groupName = typeof record.groupName === "string" ? record.groupName.trim() : "";
        const message =
          groupName !== "" && groupNameMatches(groupName).length > 1
            ? `group name "${groupName}" is ambiguous — use groupId from op:list`
            : "target group not found — pass groupId (from op:list) or one exact groupName";
        return mcpError("UNKNOWN_TARGET", message);
      }
      const targetGroup = doc.tracks.find((track) => track.id === groupId && track.kind === "group");
      if (!targetGroup) return mcpError("UNKNOWN_TARGET", `group ${groupId} no longer exists`);
      const currentTracks = ids.map((id) => doc.tracks.find((track) => track.id === id)!);
      const changedIds = currentTracks
        .filter(
          (track) =>
            !("groupId" in track && track.groupId === groupId) || (targetGroup.solo === true && track.solo !== true),
        )
        .map((track) => track.id);
      if (changedIds.length === 0) {
        return {
          text: `already routed to ${ownerNameOf(doc, groupId)} — no change`,
          mutated: false,
          data: { status: "already_routed", groupId, trackIds: ids, changedTrackIds: [], undoSteps: 0 },
        };
      }
      let next = doc;
      const parts: string[] = [];
      for (const id of changedIds) {
        next = addToGroup(next, id, groupId).execute(next);
        parts.push(`${ownerNameOf(doc, id)} → ${ownerNameOf(doc, groupId)}`);
      }
      ctx.execute(snapshot("mcpRouting", `MCP: route ${changedIds.length} track(s) into group`, doc, next));
      const committed = ctx.getDoc();
      const correct = ids.every((id) => {
        const track = committed.tracks.find((candidate) => candidate.id === id);
        const before = doc.tracks.find((candidate) => candidate.id === id);
        return (
          track != null &&
          before != null &&
          "groupId" in track &&
          track.groupId === groupId &&
          track.solo === (targetGroup.solo === true ? true : before.solo)
        );
      });
      const stateChanged = changedIds.some((id) => {
        const before = doc.tracks.find((candidate) => candidate.id === id);
        const after = committed.tracks.find((candidate) => candidate.id === id);
        return (
          before != null &&
          after != null &&
          (("groupId" in before ? before.groupId : undefined) !== ("groupId" in after ? after.groupId : undefined) ||
            before.solo !== after.solo)
        );
      });
      const data = {
        status: correct ? "routed" : "partial",
        groupId,
        trackIds: ids,
        changedTrackIds: changedIds,
        undoSteps: stateChanged ? 1 : 0,
      };
      if (!correct) {
        return mcpError("PARTIAL_FAILURE", "route change did not match the committed project read-back", {
          mutated: stateChanged,
          data,
        });
      }
      return { text: `${parts.join("; ")} — one undo step`, mutated: true, data };
    }
    if (op === "removeFromGroup") {
      const ids = explicitTrackIds(doc, record);
      if (typeof ids === "string") return mcpError("UNKNOWN_TARGET", ids);
      if (ids.length === 0)
        return mcpError("UNKNOWN_TARGET", `no track matches family "${String(record.family ?? "")}"`);
      const changedIds = ids.filter((id) => {
        const track = doc.tracks.find((candidate) => candidate.id === id);
        return track != null && "groupId" in track && track.groupId != null;
      });
      if (changedIds.length === 0) {
        return {
          text: "nothing changed — every target is already on master",
          mutated: false,
          data: { status: "already_unrouted", trackIds: ids, changedTrackIds: [], undoSteps: 0 },
        };
      }
      let next = doc;
      const parts: string[] = [];
      for (const id of changedIds) {
        const track = next.tracks.find((t) => t.id === id);
        if (!track) continue;
        next = removeFromGroup(next, id).execute(next);
        parts.push(`${track.name} → master`);
      }
      ctx.execute(snapshot("mcpRouting", `MCP: unroute ${changedIds.length} track(s)`, doc, next));
      const committed = ctx.getDoc();
      const correct = ids.every((id) => {
        const track = committed.tracks.find((candidate) => candidate.id === id);
        return track != null && (!("groupId" in track) || track.groupId == null);
      });
      const stateChanged = changedIds.some((id) => {
        const before = doc.tracks.find((candidate) => candidate.id === id);
        const after = committed.tracks.find((candidate) => candidate.id === id);
        return (
          before != null &&
          after != null &&
          ("groupId" in before ? before.groupId : undefined) !== ("groupId" in after ? after.groupId : undefined)
        );
      });
      const data = {
        status: correct ? "unrouted" : "partial",
        trackIds: ids,
        changedTrackIds: changedIds,
        undoSteps: stateChanged ? 1 : 0,
      };
      if (!correct) {
        return mcpError("PARTIAL_FAILURE", "unroute change did not match the committed project read-back", {
          mutated: stateChanged,
          data,
        });
      }
      return { text: `${parts.join("; ")} — one undo step`, mutated: true, data };
    }
    if (op === "removeReturn") {
      // Destructive: drops the bus AND every send/LFO/automation reference
      // into it (deleteReturnTrack strips them inside one snapshot) — gated
      // + auto-checkpointed like the other destructive surfaces.
      if (!destructiveAllowedWithCheckpoint(ctx, "kyx_routing")) return destructiveRefusal();
      const returnId = resolveReturnId(doc, record);
      if (!returnId) {
        const name = typeof record.returnName === "string" ? record.returnName.trim() : "";
        if (name !== "" && doc.returns.filter((item) => item.name.toLowerCase() === name.toLowerCase()).length > 1) {
          return mcpError("UNKNOWN_TARGET", `return name "${name}" is ambiguous — use returnId from op:list`);
        }
        return record.returnId != null || name !== ""
          ? mcpError("UNKNOWN_TARGET", "return bus not found — use returnId or returnName from op:list")
          : mcpError("INVALID_ARGUMENTS", "removeReturn needs returnId or returnName from op:list");
      }
      const target = doc.returns.find((r) => r.id === returnId);
      const sendsBefore = doc.tracks.filter(
        (track) => (track as { sends?: Record<string, number> }).sends?.[returnId] !== undefined,
      ).length;
      ctx.execute(deleteReturnTrack(doc, returnId));
      const committed = ctx.getDoc();
      const returnExists = committed.returns.some((item) => item.id === returnId);
      const sendsAfter = committed.tracks.filter(
        (track) => (track as { sends?: Record<string, number> }).sends?.[returnId] !== undefined,
      ).length;
      const stateChanged = !returnExists || sendsAfter < sendsBefore;
      const correct = !returnExists && sendsAfter === 0;
      const data = {
        status: correct ? "return_removed" : "partial",
        returnId,
        ...(target != null ? { returnName: target.name } : {}),
        returnExists,
        removedSendCount: sendsBefore - sendsAfter,
        undoSteps: stateChanged ? 1 : 0,
      };
      if (!correct) {
        return mcpError("PARTIAL_FAILURE", "return removal did not clear the return and its send references", {
          mutated: stateChanged,
          data,
        });
      }
      return {
        text: `removed return bus "${target?.name ?? returnId}" and its send references — one undo step`,
        mutated: true,
        data,
      };
    }
    if (op === "createReturn") {
      const name = typeof record.name === "string" ? record.name.trim().slice(0, 40) : "";
      const current = ctx.getDoc();
      const beforeIds = new Set(current.returns.map((returnTrack) => returnTrack.id));
      const expectedName = name || `Return ${current.returns.length + 1}`;
      ctx.execute(createReturnTrack(current, name || undefined));
      const committed = ctx.getDoc();
      const created = committed.returns.filter((returnTrack) => !beforeIds.has(returnTrack.id));
      const target = created.length === 1 ? created[0] : undefined;
      const matches = target != null && target.name === expectedName;
      const data = {
        status: matches ? "return_created" : "partial",
        ...(target != null ? { returnId: target.id, returnName: target.name, returnGain: target.gain } : {}),
        undoSteps: created.length > 0 ? 1 : 0,
      };
      if (!matches) {
        return mcpError("PARTIAL_FAILURE", "return creation did not match one new return in the project read-back", {
          mutated: created.length > 0,
          data,
        });
      }
      return {
        text: `created return bus "${target.name}" (id=${target.id}) — one undo step`,
        mutated: true,
        data,
      };
    }
    if (op === "setSend" || op === "setReturnGain") {
      const field = op === "setSend" ? "level" : "gain";
      const value = record[field];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return mcpError("INVALID_ARGUMENTS", `${op} needs a finite ${field} (linear 0..1.5)`);
      }
      const requestedLevel = value;
      const appliedLevel = Math.min(1.5, Math.max(0, requestedLevel));
      const current = ctx.getDoc();
      const returnId = resolveReturnId(current, record);
      if (returnId == null) {
        const name = typeof record.returnName === "string" ? record.returnName.trim() : "";
        if (
          name !== "" &&
          current.returns.filter((item) => item.name.toLowerCase() === name.toLowerCase()).length > 1
        ) {
          return mcpError("UNKNOWN_TARGET", `return name "${name}" is ambiguous — use returnId from op:list`);
        }
        return record.returnId != null || name !== ""
          ? mcpError("UNKNOWN_TARGET", "return bus not found — use returnId or returnName from op:list")
          : mcpError("INVALID_ARGUMENTS", `${op} needs returnId or returnName from op:list`);
      }
      const returnTrack = current.returns.find((candidate) => candidate.id === returnId);
      if (returnTrack == null) return mcpError("UNKNOWN_TARGET", `return bus ${returnId} no longer exists`);
      if (op === "setSend") {
        const ids = explicitTrackIds(current, record);
        if (typeof ids === "string") return mcpError("UNKNOWN_TARGET", ids);
        if (ids.length === 0) {
          return mcpError("UNKNOWN_TARGET", `no track matches family "${String(record.family ?? "")}"`);
        }
        const previousLevels = new Map(
          ids.map((id) => [
            id,
            (current.tracks.find((track) => track.id === id) as { sends?: Record<string, number> } | undefined)
              ?.sends?.[returnId] ?? 0,
          ]),
        );
        const changedIds = ids.filter((id) => previousLevels.get(id) !== appliedLevel);
        if (changedIds.length === 0) {
          return {
            text: `send to ${returnTrack.name} is already ${appliedLevel} — no change`,
            mutated: false,
            data: {
              status: "send_unchanged",
              returnId,
              returnName: returnTrack.name,
              trackIds: ids,
              changedTrackIds: [],
              requestedLevel,
              sendLevel: appliedLevel,
              undoSteps: 0,
            },
          };
        }
        let next = current;
        const parts: string[] = [];
        for (const id of changedIds) {
          next = setTrackSend(next, id, returnId, appliedLevel).execute(next);
          parts.push(`${ownerNameOf(current, id)} → ${returnTrack.name} ${appliedLevel}`);
        }
        ctx.execute(snapshot("mcpSends", `MCP: set send ×${changedIds.length}`, current, next));
        const committed = ctx.getDoc();
        const correct = ids.every((id) => {
          const track = committed.tracks.find((candidate) => candidate.id === id);
          return (
            track != null && ((track as { sends?: Record<string, number> }).sends?.[returnId] ?? 0) === appliedLevel
          );
        });
        const stateChanged = changedIds.some((id) => {
          const track = committed.tracks.find((candidate) => candidate.id === id);
          return (
            track != null &&
            ((track as { sends?: Record<string, number> }).sends?.[returnId] ?? 0) !== previousLevels.get(id)
          );
        });
        const data = {
          status: correct ? "send_set" : "partial",
          returnId,
          returnName: returnTrack.name,
          trackIds: ids,
          changedTrackIds: changedIds,
          requestedLevel,
          sendLevel: appliedLevel,
          undoSteps: stateChanged ? 1 : 0,
        };
        if (!correct) {
          return mcpError("PARTIAL_FAILURE", "send write did not match the committed project read-back", {
            mutated: stateChanged,
            data,
          });
        }
        const clampNote = appliedLevel === requestedLevel ? "" : ` (clamped from ${requestedLevel})`;
        return { text: `${parts.join("; ")} — one undo step${clampNote}`, mutated: true, data };
      }

      if (returnTrack.gain === appliedLevel) {
        return {
          text: `${returnTrack.name}: return gain is already ${appliedLevel.toFixed(2)} — no change`,
          mutated: false,
          data: {
            status: "return_gain_unchanged",
            returnId,
            returnName: returnTrack.name,
            requestedLevel,
            returnGain: appliedLevel,
            undoSteps: 0,
          },
        };
      }
      ctx.execute(setReturnGain(current, returnId, appliedLevel));
      const committedReturn = ctx.getDoc().returns.find((candidate) => candidate.id === returnId);
      const correct = committedReturn?.gain === appliedLevel;
      const stateChanged = committedReturn?.gain !== returnTrack.gain;
      const data = {
        status: correct ? "return_gain_set" : "partial",
        returnId,
        returnName: committedReturn?.name ?? returnTrack.name,
        ...(committedReturn ? { returnGain: committedReturn.gain } : {}),
        undoSteps: stateChanged ? 1 : 0,
      };
      if (!correct) {
        return mcpError("PARTIAL_FAILURE", "return gain did not match the committed project read-back", {
          mutated: stateChanged,
          data,
        });
      }
      const clampNote = appliedLevel === requestedLevel ? "" : ` (clamped from ${requestedLevel})`;
      return {
        text: `${committedReturn.name}: return gain ${committedReturn.gain.toFixed(2)} — one undo step${clampNote}`,
        mutated: true,
        data,
      };
    }
    return mcpError("UNKNOWN_REQUEST", `unknown op: ${op}`);
  } catch (error) {
    return mcpError("EXECUTION_FAILED", `routing op failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** kyx_takes — the comp workflow over arrangement take groups: list the
 * alternatives and activate (comp pick) one; the domain validates that the
 * take actually has clips in the group. */
function executeTakesTool(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  if (record.op !== undefined && typeof record.op !== "string") {
    return mcpError("INVALID_ARGUMENTS", "op must be one of: list, activate, deleteTake");
  }
  const op = typeof record.op === "string" ? record.op : "list";
  if (!["list", "activate", "deleteTake"].includes(op)) {
    return mcpError("UNKNOWN_REQUEST", `unknown op: ${op} (list | activate | deleteTake)`);
  }
  for (const field of ["groupId", "takeId"] as const) {
    const value = record[field];
    if (value !== undefined && (typeof value !== "string" || value.length > 128)) {
      return mcpError("INVALID_ARGUMENTS", `${field} must be a string of at most 128 characters`);
    }
  }
  const doc = ctx.getDoc();
  const groups = doc.arrangement.takeGroups ?? [];
  type TakeClip = { takeId: string | undefined };
  const clipsOf = (groupId: string): TakeClip[] =>
    (doc.arrangement.audioClips ?? [])
      .filter((clip) => clip.takeGroupId === groupId)
      .map((clip) => ({ takeId: clip.takeId }));
  const groupReadback = (group: (typeof groups)[number]) => {
    const perTake = new Map<string | null, TakeClip[]>();
    for (const clip of clipsOf(group.id)) {
      const takeId = clip.takeId ?? null;
      const clips = perTake.get(takeId) ?? [];
      clips.push(clip);
      perTake.set(takeId, clips);
    }
    const takes = [...perTake.entries()].map(([takeId, clips]) => ({
      takeId,
      clipCount: clips.length,
    }));
    return {
      id: group.id,
      trackId: group.trackId,
      track: ownerNameOf(doc, group.trackId),
      activeTakeId: group.activeTakeId,
      compTakeId: group.compTakeId ?? null,
      takes,
    };
  };

  if (op === "list") {
    if (groups.length === 0) {
      return {
        text: "no take groups (takes appear when a lane holds alternative passes)",
        mutated: false,
        data: { status: "empty", groups: [] },
      };
    }
    const data = groups.map(groupReadback);
    const lines = data.map(
      (group) =>
        `${group.track} (group id=${group.id}): ACTIVE take ${group.activeTakeId} · ${group.takes
          .map(({ takeId, clipCount }) => `take ${takeId ?? "(none)"} ×${clipCount} clip(s)`)
          .join(", ")}${group.compTakeId ? ` · comp: ${group.compTakeId}` : ""}`,
    );
    return { text: lines.join("\n"), mutated: false, data: { status: "listed", groups: data } };
  }

  if (op === "activate") {
    const groupId = typeof record.groupId === "string" ? record.groupId.trim() : "";
    const takeId = typeof record.takeId === "string" ? record.takeId.trim() : "";
    if (groupId === "" || takeId === "") {
      return mcpError("INVALID_ARGUMENTS", "activate needs groupId and takeId — read them via op:list");
    }
    try {
      const group = groups.find((item) => item.id === groupId);
      if (!group) return mcpError("UNKNOWN_TARGET", `no take group "${groupId}" — op:list for the groups`);
      const clipCount = clipsOf(groupId).filter((clip) => clip.takeId === takeId).length;
      if (clipCount === 0) return mcpError("UNKNOWN_TARGET", `no clips for take ${takeId} in group ${groupId}`);
      if (group.activeTakeId === takeId) {
        return {
          text: `take ${takeId} is already the active comp of group ${groupId}`,
          mutated: false,
          data: {
            status: "already_active",
            groupId,
            takeId,
            activeTakeId: group.activeTakeId,
            clipCount,
            undoSteps: 0,
          },
        };
      }
      ctx.execute(setActiveAudioTake(doc, groupId, takeId));
      const committed = ctx.getDoc();
      const activeTakeId = committed.arrangement.takeGroups?.find((item) => item.id === groupId)?.activeTakeId;
      const committedClipCount = (committed.arrangement.audioClips ?? []).filter(
        (clip) => clip.takeGroupId === groupId && clip.takeId === takeId,
      ).length;
      const data = {
        status: activeTakeId === takeId && committedClipCount > 0 ? "activated" : "partial",
        groupId,
        takeId,
        ...(activeTakeId != null ? { activeTakeId } : {}),
        clipCount: committedClipCount,
        undoSteps: activeTakeId === takeId && committedClipCount > 0 ? 1 : 0,
      };
      if (activeTakeId !== takeId || committedClipCount === 0) {
        return mcpError("PARTIAL_FAILURE", `take ${takeId} activation did not pass the project read-back`, {
          mutated: activeTakeId !== group.activeTakeId,
          data,
        });
      }
      return {
        text: `comp pick: take ${takeId} is now ACTIVE in group ${groupId} (${committedClipCount} clip(s)) — one undo step`,
        mutated: true,
        data,
      };
    } catch (error) {
      return mcpError("EXECUTION_FAILED", `take op failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (op === "deleteTake") {
    const groupId = typeof record.groupId === "string" ? record.groupId.trim() : "";
    const takeId = typeof record.takeId === "string" ? record.takeId.trim() : "";
    if (groupId === "" || takeId === "") {
      return mcpError("INVALID_ARGUMENTS", "deleteTake needs groupId and takeId — op:list for the groups");
    }
    if (ctx.allowDestructive?.() !== true) return destructiveRefusal();
    const group = groups.find((item) => item.id === groupId);
    if (!group) return mcpError("UNKNOWN_TARGET", `no take group "${groupId}"`);
    if (group.activeTakeId === takeId) {
      return mcpError("POLICY_REFUSED", "refused: that take is the ACTIVE comp — activate another take first");
    }
    const doomed = (doc.arrangement.audioClips ?? []).filter(
      (clip) => clip.takeGroupId === groupId && clip.takeId === takeId,
    );
    if (doomed.length === 0) {
      return {
        text: `no clips for take ${takeId} in group ${groupId}`,
        mutated: false,
        data: {
          status: "already_absent",
          groupId,
          takeId,
          deletedClipCount: 0,
          remainingTakeClipCount: 0,
          remainingGroupClipCount: clipsOf(groupId).length,
          groupRemaining: true,
          undoSteps: 0,
        },
      };
    }
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
    const committed = ctx.getDoc();
    const committedGroupClips = (committed.arrangement.audioClips ?? []).filter((clip) => clip.takeGroupId === groupId);
    const deletedClipCount = doomed.filter(
      (clip) => !(committed.arrangement.audioClips ?? []).some((candidate) => candidate.id === clip.id),
    ).length;
    const groupRemaining = (committed.arrangement.takeGroups ?? []).some((item) => item.id === groupId);
    const expectedRemainingIds = new Set(
      (doc.arrangement.audioClips ?? [])
        .filter((clip) => clip.takeGroupId === groupId && clip.takeId !== takeId)
        .map((clip) => clip.id),
    );
    const actualRemainingIds = new Set(committedGroupClips.map((clip) => clip.id));
    const originalGroupIds = new Set(
      (doc.arrangement.audioClips ?? []).filter((clip) => clip.takeGroupId === groupId).map((clip) => clip.id),
    );
    const remainingContentMatches =
      actualRemainingIds.size === expectedRemainingIds.size &&
      [...expectedRemainingIds].every((id) => actualRemainingIds.has(id));
    const stateMatchesBefore =
      actualRemainingIds.size === originalGroupIds.size &&
      [...originalGroupIds].every((id) => actualRemainingIds.has(id)) &&
      groupRemaining;
    const stateChanged = !stateMatchesBefore;
    const expectedGroupRemaining = expectedRemainingIds.size > 0;
    const complete =
      deletedClipCount === doomed.length && remainingContentMatches && groupRemaining === expectedGroupRemaining;
    const targetTakeRemaining = committedGroupClips.filter((clip) => clip.takeId === takeId).length;
    const data = {
      status: complete ? "deleted" : "partial",
      groupId,
      takeId,
      deletedClipCount,
      remainingTakeClipCount: targetTakeRemaining,
      remainingGroupClipCount: committedGroupClips.length,
      groupRemaining,
      undoSteps: stateChanged ? 1 : 0,
    };
    if (!complete) {
      return mcpError("PARTIAL_FAILURE", `take delete read-back removed ${deletedClipCount}/${doomed.length} clips`, {
        mutated: stateChanged,
        data,
      });
    }
    return {
      text: `deleted take ${takeId} (${doomed.length} clip(s)) from group ${groupId} — one undo step`,
      mutated: true,
      data,
    };
  }

  return mcpError("UNKNOWN_REQUEST", `unknown op: ${op} (list | activate | deleteTake)`);
}

/** kyx_batch — sequential multi-call with optional ONE-undo-frame folding.
 * Per-call failures never abort the batch; every result carries its own
 * read-back so the caller sees exactly what landed. */
async function executeBatchTool(ctx: McpToolContext, record: Record<string, unknown>): Promise<McpToolResult> {
  const calls = Array.isArray(record.calls) ? record.calls : null;
  if (calls == null || calls.length === 0) {
    return mcpError("INVALID_ARGUMENTS", "batch needs calls: [{tool, args}…] (1..10)");
  }
  if (calls.length > 10) {
    return mcpError("INVALID_ARGUMENTS", `batch is capped at 10 calls (got ${calls.length}) — split it`);
  }
  const atomic = record.atomic === true;
  const framed = ctx.beginUndoFrame != null && ctx.endUndoFrame != null;
  const results: Array<{ tool: string; mutated: boolean; text: string }> = [];
  let mutations = 0;
  let failures = 0;
  let skipped = 0;
  let halted = false;
  if (framed) ctx.beginUndoFrame!("mcp-batch");
  try {
    for (const entry of calls) {
      if (halted) {
        skipped += 1;
        continue;
      }
      const item = (entry != null && typeof entry === "object" ? entry : {}) as { tool?: unknown; args?: unknown };
      const tool = typeof item.tool === "string" ? item.tool : "";
      if (tool === "" || !MCP_TOOLS.some((def) => def.name === tool)) {
        results.push({ tool: tool || "(missing)", mutated: false, text: "unknown tool" });
        failures += 1;
        if (atomic) halted = true;
        continue;
      }
      if (tool === "kyx_batch") {
        results.push({ tool, mutated: false, text: "refused: nested batches are not supported" });
        failures += 1;
        if (atomic) halted = true;
        continue;
      }
      if (tool === "kyx_export" || tool === "kyx_audio_preview" || tool === "kyx_loudness") {
        results.push({ tool, mutated: false, text: `refused: ${tool} runs standalone (async, not batchable)` });
        failures += 1;
        if (atomic) halted = true;
        continue;
      }
      try {
        const result = await executeMcpTool(ctx, tool, item.args ?? {});
        results.push({ tool, mutated: result.mutated, text: result.text });
        if (result.mutated) mutations += 1;
        if (result.isError === true) {
          failures += 1;
          if (atomic) halted = true;
        }
      } catch (error) {
        results.push({
          tool,
          mutated: false,
          text: `crashed: ${error instanceof Error ? error.message : String(error)}`,
        });
        failures += 1;
        if (atomic) halted = true;
      }
    }
  } finally {
    if (framed) ctx.endUndoFrame!();
  }
  const summary = [
    `${calls.length} call(s): ${mutations} mutated, ${failures} failed${skipped > 0 ? `, ${skipped} skipped` : ""}`,
    atomic
      ? "atomic mode — stopped at the first failure"
      : "partial-commit (pass atomic:true to stop at the first failure)",
    framed
      ? "ONE undo step for the whole batch"
      : "no undo-frame support on this host — each call is its own undo step",
  ].join(" · ");
  const text = `batch — ${summary}\n${results.map((r, i) => `${i + 1}. ${r.tool}${r.mutated ? " ✓" : ""}: ${r.text}`).join("\n")}`;
  if (atomic && failures > 0) {
    return mcpError("PARTIAL_FAILURE", text, {
      mutated: mutations > 0,
      data: { results, mutations, failures, skipped, singleUndo: framed, atomic: true },
    });
  }
  return {
    text,
    mutated: mutations > 0,
    data: { results, mutations, failures, skipped, singleUndo: framed, atomic },
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
      // A range alone is not a contract an agent can reason about: every
      // parameter may carry a one-sentence DESCRIPTION of what it does, on its
      // own indented line. Effects that have not been documented yet simply
      // omit the line — the catalog never invents one.
      ...meta.params.flatMap((param) => {
        const extras = [
          param.unit != null ? `unit ${param.unit}` : null,
          param.kind != null ? param.kind : null,
          param.step != null ? `step ${param.step}` : null,
          param.taper != null ? `${param.taper} taper` : null,
          param.options != null ? `options: ${param.options.map((o) => `${o.value}=${o.label}`).join("|")}` : null,
        ].filter(Boolean);
        const line = `  ${param.id} "${param.label}": ${param.min} .. ${param.max}, default ${param.default}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
        return param.description != null ? [line, `      ${param.description}`] : [line];
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

/**
 * Bounded, honest rendering of an effect's meter frame for `kyx_meter scope:fx`.
 * KOREŇ's sound-identity telemetry has known names (f0 / clarity / harmonics /
 * key / hint); everything else is printed as finite scalars and array lengths
 * with NO invented meaning — an unknown frame still tells an agent something,
 * but never something false.
 */
function describeFxMeters(meters: unknown): string {
  if (meters == null || typeof meters !== "object" || Array.isArray(meters)) return "";
  const record = meters as Record<string, unknown>;
  if (typeof record.f0 === "number" && Number.isFinite(record.f0) && record.f0 > 0) {
    const parts = [`f0 ${record.f0.toFixed(1)} Hz`];
    if (typeof record.clarity === "number" && Number.isFinite(record.clarity)) {
      parts.push(`clarity ${record.clarity.toFixed(2)}`);
    }
    if (typeof record.harm === "number" && Number.isFinite(record.harm))
      parts.push(`+${record.harm.toFixed(1)} dB harmonics`);
    if (typeof record.key === "number" && Number.isFinite(record.key)) parts.push(`key ×${record.key.toFixed(2)}`);
    if (record.hint === 1) parts.push("HINT");
    return parts.join(" · ");
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record).slice(0, 8)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${key} ${Math.round(value * 1000) / 1000}`);
    } else if (ArrayBuffer.isView(value) || Array.isArray(value)) {
      parts.push(`${key}[${(value as { length?: number }).length ?? 0}]`);
    }
  }
  return parts.join(" · ");
}

/** Dynamics-stage readings as one compact phrase (ZENIT reports several). */
function describeGainReduction(readings: McpFxMeterReading["gainReduction"]): string {
  if (readings == null || readings.length === 0) return "";
  return readings.map((reading) => `${reading.label} ${reading.gainReductionDb.toFixed(1)} dB`).join(" / ");
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
      return mcpError("UNKNOWN_TARGET", `no track with id "${trackId}" — list ids via kyx_state subject:tracks`);
    targets = [track];
  } else if (family !== "") {
    targets = tracksInFamily(doc, family)
      .map((id) => doc.tracks.find((t) => t.id === id))
      .filter((t): t is Track => t != null);
    if (targets.length === 0) return mcpError("UNKNOWN_TARGET", `no track matches family "${family}"`);
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

function executeMusicTool(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  const allowedOps = ["setTempo", "setKey", "setPatternLength", "setTimeSignature", "transposeAll"] as const;
  if (typeof record.op !== "string") return mcpError("INVALID_ARGUMENTS", "op is required");
  if (!allowedOps.includes(record.op as (typeof allowedOps)[number])) {
    return mcpError("UNKNOWN_REQUEST", `unknown op for kyx_music: ${record.op}`);
  }
  const op = record.op;
  const before = ctx.getDoc();
  const plan = (ops: { kind: string; [key: string]: unknown }[]): { label: string; ops: never[] } => ({
    label: "MCP music",
    ops: ops as never[],
  });
  const unchanged = (fields: Record<string, unknown>, text: string): McpToolResult => {
    const data = { status: "already_set", op, ...fields, undoSteps: 0 };
    return { text, mutated: false, data };
  };
  const commit = (
    command: Command,
    verify: (doc: ProjectDocument) => boolean,
    readback: (doc: ProjectDocument) => Record<string, unknown>,
    resultText: (doc: ProjectDocument) => string,
  ): McpToolResult => {
    try {
      ctx.execute(command);
      const after = ctx.getDoc();
      const mutated = after !== before;
      const verified = verify(after);
      const data = {
        status: verified ? (mutated ? "set" : "already_set") : "partial",
        op,
        ...readback(after),
        undoSteps: mutated ? 1 : 0,
      };
      if (!verified) {
        return mcpError("PARTIAL_FAILURE", `kyx_music ${op} did not match its committed read-back`, {
          mutated,
          data,
        });
      }
      return { text: resultText(after), mutated, data };
    } catch (error) {
      return mcpError(
        "EXECUTION_FAILED",
        `kyx_music ${op} failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          mutated: ctx.getDoc() !== before,
        },
      );
    }
  };

  if (op === "setTempo") {
    const bpm = record.bpm;
    if (typeof bpm !== "number" || !Number.isSafeInteger(bpm) || bpm < 20 || bpm > 300) {
      return mcpError("INVALID_ARGUMENTS", "setTempo needs an integer bpm from 20 to 300");
    }
    if (before.bpm === bpm) return unchanged({ bpm: before.bpm }, `tempo is already ${before.bpm} BPM`);
    const command = applyExactIntentCommand(before, plan([{ kind: "tempo", bpm }]));
    return commit(
      command,
      (doc) => doc.bpm === bpm,
      (doc) => ({ bpm: doc.bpm }),
      (doc) => `tempo is now ${doc.bpm} BPM (one undo step)`,
    );
  }

  if (op === "setKey") {
    const key = record.key;
    if (typeof key !== "string" || !(MUSICAL_KEYS as string[]).includes(key)) {
      return mcpError("INVALID_ARGUMENTS", "setKey needs one of KYX's supported musical keys (see tools/list schema)");
    }
    if (before.key === key) return unchanged({ key: before.key }, `key is already ${before.key}`);
    const command = applyExactIntentCommand(before, plan([{ kind: "key", key }]));
    return commit(
      command,
      (doc) => doc.key === key,
      (doc) => ({ key: doc.key }),
      (doc) => `key is now ${doc.key} (one undo step)`,
    );
  }

  if (op === "setPatternLength") {
    const steps = record.steps;
    if (typeof steps !== "number" || !Number.isSafeInteger(steps) || steps < 16 || steps > 128) {
      return mcpError("INVALID_ARGUMENTS", "setPatternLength needs an integer step count from 16 to 128");
    }
    const active = before.patterns.find((pattern) => pattern.id === before.activePatternId);
    if (!active) return mcpError("UNKNOWN_TARGET", "the active pattern does not exist in this project");
    if (active.stepCount === steps) {
      return unchanged({ patternId: active.id, steps: active.stepCount }, `active pattern is already ${steps} steps`);
    }
    const command = applyExactIntentCommand(before, plan([{ kind: "patternLength", steps }]));
    return commit(
      command,
      (doc) => doc.patterns.find((pattern) => pattern.id === active.id)?.stepCount === steps,
      (doc) => ({
        patternId: active.id,
        steps: doc.patterns.find((pattern) => pattern.id === active.id)?.stepCount ?? active.stepCount,
      }),
      (doc) =>
        `active pattern is now ${doc.patterns.find((pattern) => pattern.id === active.id)?.stepCount ?? "?"} steps (one undo step)`,
    );
  }

  if (op === "setTimeSignature") {
    const numerator = record.numerator;
    const denominator = record.denominator;
    if (
      typeof numerator !== "number" ||
      !Number.isSafeInteger(numerator) ||
      numerator < 1 ||
      numerator > 16 ||
      typeof denominator !== "number" ||
      !Number.isSafeInteger(denominator) ||
      ![2, 4, 8, 16].includes(denominator)
    ) {
      return mcpError(
        "INVALID_ARGUMENTS",
        "setTimeSignature needs an integer numerator 1..16 and denominator 2|4|8|16",
      );
    }
    const beforeSignature = before.timeSignature;
    if (beforeSignature.numerator === numerator && beforeSignature.denominator === denominator) {
      return unchanged({ numerator, denominator }, `time signature is already ${numerator}/${denominator}`);
    }
    return commit(
      setTimeSignature(before, numerator, denominator),
      (doc) => doc.timeSignature.numerator === numerator && doc.timeSignature.denominator === denominator,
      (doc) => ({ numerator: doc.timeSignature.numerator, denominator: doc.timeSignature.denominator }),
      (doc) => `time signature is now ${doc.timeSignature.numerator}/${doc.timeSignature.denominator} (one undo step)`,
    );
  }

  const semitones = record.semitones;
  const rawTarget = record.target ?? "all";
  const targets = ["all", "bass", "lead", "chords", "vocal"] as const;
  if (
    typeof semitones !== "number" ||
    !Number.isSafeInteger(semitones) ||
    semitones === 0 ||
    Math.abs(semitones) > 127
  ) {
    return mcpError(
      "INVALID_ARGUMENTS",
      "transposeAll needs an integer semitone shift from -127 to 127, excluding zero",
    );
  }
  if (typeof rawTarget !== "string" || !targets.includes(rawTarget as (typeof targets)[number])) {
    return mcpError("INVALID_ARGUMENTS", "transposeAll target must be all, bass, lead, chords, or vocal");
  }
  const target = rawTarget as (typeof targets)[number];
  const active = before.patterns.find((pattern) => pattern.id === before.activePatternId);
  if (!active) return mcpError("UNKNOWN_TARGET", "the active pattern does not exist in this project");
  let targetTrackIds: string[];
  try {
    targetTrackIds =
      target === "all"
        ? before.tracks.filter((track) => track.kind === "instrument").map((track) => track.id)
        : resolveProductionTargets(before, [target as never]).filter((id) =>
            before.tracks.some((track) => track.id === id && track.kind === "instrument"),
          );
  } catch (error) {
    return mcpError("UNKNOWN_TARGET", error instanceof Error ? error.message : String(error));
  }
  if (targetTrackIds.length === 0) return mcpError("UNKNOWN_TARGET", `no melodic track matches target "${target}"`);
  const targetNoteCount = targetTrackIds.reduce((count, id) => count + (active.notes[id]?.length ?? 0), 0);
  if (targetNoteCount === 0) {
    const data = {
      status: "no_notes",
      op,
      target,
      requestedSemitones: semitones,
      targetNoteCount: 0,
      transposedNotes: 0,
      partialNotes: 0,
      undoSteps: 0,
    };
    return { text: `no active-pattern notes for ${target}; nothing was changed`, mutated: false, data };
  }
  const command = applyExactIntentCommand(before, plan([{ kind: "transpose", target, semitones }]));
  try {
    ctx.execute(command);
    const after = ctx.getDoc();
    const afterPattern = after.patterns.find((pattern) => pattern.id === active.id);
    let transposedNotes = 0;
    let partialNotes = 0;
    for (const trackId of targetTrackIds) {
      const afterById = new Map((afterPattern?.notes[trackId] ?? []).map((note) => [note.id, note]));
      for (const note of active.notes[trackId] ?? []) {
        const committed = afterById.get(note.id);
        if (!committed) {
          partialNotes += 1;
        } else if (committed.pitch - note.pitch === semitones) {
          transposedNotes += 1;
        } else {
          partialNotes += 1;
        }
      }
    }
    const mutated = after !== before;
    const status = partialNotes > 0 || transposedNotes === 0 ? "partial" : "transposed";
    const data = {
      status,
      op,
      target,
      requestedSemitones: semitones,
      targetNoteCount,
      transposedNotes,
      partialNotes,
      undoSteps: mutated ? 1 : 0,
    };
    if (status === "partial") {
      return mcpError("PARTIAL_FAILURE", "transposeAll did not land the full requested shift on every targeted note", {
        mutated,
        data,
      });
    }
    return {
      text: `transposed ${transposedNotes} notes in ${target} by ${semitones > 0 ? "+" : ""}${semitones} semitones (one undo step)`,
      mutated,
      data,
    };
  } catch (error) {
    return mcpError(
      "EXECUTION_FAILED",
      `kyx_music transposeAll failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        mutated: ctx.getDoc() !== before,
      },
    );
  }
}

function executeSectionsTool(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  const op = record.op;
  if (typeof op !== "string") return mcpError("INVALID_ARGUMENTS", "op is required");
  if (!["list", "add", "remove", "duplicate", "reorder", "resize", "intensity"].includes(op)) {
    return mcpError("UNKNOWN_REQUEST", `unknown section op: ${op}`);
  }
  const before = ctx.getDoc();
  if (op === "list") {
    const data = sectionResultData(before, "listed", undefined, undefined, 0);
    return { text: formatSectionResult(data), mutated: false, data };
  }
  if (
    record.sceneId !== undefined &&
    (typeof record.sceneId !== "string" || record.sceneId.trim() === "" || record.sceneId.length > 128)
  ) {
    return mcpError("INVALID_ARGUMENTS", "sceneId must be a non-empty string of at most 128 characters");
  }
  if (
    record.scene !== undefined &&
    (typeof record.scene !== "string" || record.scene.trim() === "" || record.scene.length > 80)
  ) {
    return mcpError("INVALID_ARGUMENTS", "scene must be a non-empty string of at most 80 characters");
  }
  if (
    record.index !== undefined &&
    (typeof record.index !== "number" || !Number.isSafeInteger(record.index) || record.index < 1)
  ) {
    return mcpError("INVALID_ARGUMENTS", "index must be a 1-based positive integer");
  }
  if (
    record.role !== undefined &&
    (typeof record.role !== "string" || !SECTION_ADD_ROLES.includes(record.role as (typeof SECTION_ADD_ROLES)[number]))
  ) {
    return mcpError("INVALID_ARGUMENTS", `role must be one of: ${SECTION_ADD_ROLES.join(", ")}`);
  }
  if (record.direction !== undefined && record.direction !== "earlier" && record.direction !== "later") {
    return mcpError("INVALID_ARGUMENTS", "direction must be earlier or later");
  }
  const role = typeof record.role === "string" ? record.role : undefined;
  if (op === "add") {
    if (role === undefined) return mcpError("INVALID_ARGUMENTS", `add needs role (${SECTION_ADD_ROLES.join(" | ")})`);
    try {
      const command = sectionCommand({ op, role }, before);
      if (!command) return mcpError("UNKNOWN_REQUEST", "section could not be created");
      ctx.execute(command);
      const after = ctx.getDoc();
      const created = after.scenes.filter((candidate) => !before.scenes.some((prior) => prior.id === candidate.id));
      const affectedId = created.length === 1 ? created[0]!.id : undefined;
      const status = created.length === 1 ? "created" : "partial";
      const data = sectionResultData(after, status, affectedId, undefined, after === before ? 0 : 1);
      if (created.length !== 1) {
        return mcpError("PARTIAL_FAILURE", "section add did not produce exactly one committed scene", {
          mutated: after !== before,
          data,
        });
      }
      return { text: formatSectionResult(data), mutated: after !== before, data };
    } catch (error) {
      return mcpError(
        "EXECUTION_FAILED",
        `section add failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const selected = resolveSectionTarget(before, record);
  if (!("id" in selected)) return selected;
  const scene = selected;
  const previousIndex = before.scenes.findIndex((candidate) => candidate.id === scene.id);
  const previous = sectionSummary(before, scene, previousIndex);
  if (op === "remove" && !destructiveAllowedWithCheckpoint(ctx, "kyx_sections")) return destructiveRefusal();

  if (op === "intensity") {
    const value = typeof record.intensity === "number" ? record.intensity : record.value;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return mcpError("INVALID_ARGUMENTS", "intensity needs a number from 0 to 1");
    }
    if (scene.intensity === value) {
      const data = sectionResultData(before, "already_set", scene.id, previous, 0);
      return { text: formatSectionResult(data), mutated: false, data };
    }
    try {
      ctx.execute(setSceneIntensity(before, scene.id, value));
      const after = ctx.getDoc();
      const committed = after.scenes.find((candidate) => candidate.id === scene.id);
      if (!committed || committed.intensity !== value) {
        const data = sectionResultData(after, "partial", scene.id, previous, after === before ? 0 : 1);
        return mcpError("PARTIAL_FAILURE", "section intensity did not match its committed read-back", {
          mutated: after !== before,
          data,
        });
      }
      const data = sectionResultData(after, "intensity_set", scene.id, previous, after === before ? 0 : 1);
      return { text: formatSectionResult(data), mutated: after !== before, data };
    } catch (error) {
      return mcpError(
        "EXECUTION_FAILED",
        `section intensity failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (op === "reorder") {
    const direction = record.direction ?? "later";
    if (
      (direction === "earlier" && previousIndex === 0) ||
      (direction === "later" && previousIndex === before.scenes.length - 1)
    ) {
      const data = sectionResultData(before, "already_ordered", scene.id, previous, 0);
      return { text: formatSectionResult(data), mutated: false, data };
    }
  }
  if (op === "resize") {
    if (typeof record.bars !== "number" || !Number.isSafeInteger(record.bars) || record.bars < 1 || record.bars > 64) {
      return mcpError("INVALID_ARGUMENTS", "resize needs an integer bars value from 1 to 64");
    }
    if (previous.bars === record.bars) {
      const data = sectionResultData(before, "already_set", scene.id, previous, 0);
      return { text: formatSectionResult(data), mutated: false, data };
    }
    if (!before.arrangement.clips.some((clip) => clip.sceneId === scene.id)) {
      return mcpError("UNKNOWN_TARGET", `section ${scene.name} has no arrangement clip to resize`);
    }
  }

  try {
    const command = sectionCommand(record, before, scene);
    if (!command) return mcpError("UNKNOWN_REQUEST", `section op ${op} could not be resolved`);
    ctx.execute(command);
    const after = ctx.getDoc();
    const stillExists = after.scenes.some((candidate) => candidate.id === scene.id);
    let status =
      op === "remove" ? "removed" : op === "duplicate" ? "duplicated" : op === "reorder" ? "reordered" : "resized";
    let affectedId: string | undefined = scene.id;
    let fallback: McpSectionSummary | undefined = previous;
    let verified = op === "remove" ? !stillExists : stillExists;
    if (op === "duplicate") {
      const additions = after.scenes.filter((candidate) => !before.scenes.some((prior) => prior.id === candidate.id));
      verified = additions.length === 1;
      affectedId = additions.length === 1 ? additions[0]!.id : undefined;
      fallback = undefined;
    } else if (op === "reorder") {
      const currentIndex = after.scenes.findIndex((candidate) => candidate.id === scene.id);
      verified = currentIndex >= 0 && currentIndex !== previousIndex;
      if (!verified && after === before) status = "already_ordered";
    } else if (op === "resize") {
      const committed = after.scenes.find((candidate) => candidate.id === scene.id);
      const committedIndex = after.scenes.findIndex((candidate) => candidate.id === scene.id);
      verified = committed !== undefined && sectionSummary(after, committed, committedIndex).bars === record.bars;
    }
    if (!verified) status = "partial";
    const data = sectionResultData(after, status, affectedId, fallback, after === before ? 0 : 1);
    if (!verified) {
      return mcpError("PARTIAL_FAILURE", `section ${op} did not match the committed read-back`, {
        mutated: after !== before,
        data,
      });
    }
    return { text: formatSectionResult(data), mutated: after !== before, data };
  } catch (error) {
    return mcpError("EXECUTION_FAILED", `section op failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const SECTION_ADD_ROLES = ["intro", "build", "chorus", "verse", "bridge", "drop", "break", "outro", "fill"] as const;

type McpSectionSummary = {
  id: string;
  name: string;
  role: string;
  index: number;
  startBar?: number;
  bars: number;
  intensity: number;
  clipCount: number;
};

function sectionSummary(doc: ProjectDocument, scene: Scene, index: number): McpSectionSummary {
  const clips = doc.arrangement.clips.filter((clip) => clip.sceneId === scene.id);
  const pattern = doc.patterns.find((candidate) => candidate.id === scene.patternId);
  const bars =
    clips.length > 0
      ? Math.max(1, Math.round(clips.reduce((total, clip) => total + clip.lengthBars, 0)))
      : Math.max(1, Math.ceil((pattern?.stepCount ?? 16) / 16));
  const startBar =
    clips.length > 0
      ? Math.floor(clips.reduce((minimum, clip) => Math.min(minimum, clip.startBar), Number.POSITIVE_INFINITY)) + 1
      : undefined;
  return {
    id: scene.id,
    name: scene.name,
    role: sceneRoleOf(scene) ?? "custom",
    index: index + 1,
    ...(startBar !== undefined ? { startBar } : {}),
    bars,
    intensity: scene.intensity,
    clipCount: clips.length,
  };
}

function sectionResultData(
  doc: ProjectDocument,
  status: string,
  sectionId: string | undefined,
  fallback: McpSectionSummary | undefined,
  undoSteps: number,
): Record<string, unknown> {
  const sections = doc.scenes.map((scene, index) => sectionSummary(doc, scene, index));
  const selected = (sectionId && sections.find((section) => section.id === sectionId)) || fallback;
  return {
    status,
    sections,
    ...(sectionId ? { sectionId } : {}),
    ...(selected
      ? {
          name: selected.name,
          role: selected.role,
          index: selected.index,
          ...(selected.startBar !== undefined ? { startBar: selected.startBar } : {}),
          bars: selected.bars,
          intensity: selected.intensity,
          clipCount: selected.clipCount,
        }
      : {}),
    undoSteps,
  };
}

function formatSectionResult(data: Record<string, unknown>): string {
  const status = String(data.status ?? "unknown");
  if (status === "listed") return `listed ${Array.isArray(data.sections) ? data.sections.length : 0} sections`;
  const label = typeof data.name === "string" ? ` "${data.name}"` : "";
  const detail = typeof data.startBar === "number" ? ` at bar ${data.startBar}, ${String(data.bars)} bars` : "";
  const undo = data.undoSteps === 1 ? " (one undo step)" : " (no change)";
  return `${status.replaceAll("_", " ")}${label}${detail}${undo}`;
}

function resolveSectionTarget(doc: ProjectDocument, record: Record<string, unknown>): Scene | McpToolResult {
  if (typeof record.sceneId === "string" && record.sceneId.trim() !== "") {
    const sceneId = record.sceneId.trim();
    const exact = doc.scenes.find((scene) => scene.id === sceneId);
    return exact ?? mcpError("UNKNOWN_TARGET", `no section has sceneId ${record.sceneId}`);
  }
  if (typeof record.index === "number") {
    const target = doc.scenes[record.index - 1];
    return target ?? mcpError("UNKNOWN_TARGET", `no section at index ${record.index} (1..${doc.scenes.length})`);
  }
  const label = typeof record.scene === "string" ? record.scene.trim() : "";
  if (label !== "") {
    const byName = doc.scenes.filter((scene) => scene.name.trim().toLowerCase() === label.toLowerCase());
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1)
      return mcpError("INVALID_ARGUMENTS", `section name "${label}" is ambiguous; use sceneId or index`);
    const byRole = doc.scenes.filter((scene) => sceneRoleOf(scene) === label.toLowerCase());
    if (byRole.length === 1) return byRole[0]!;
    if (byRole.length > 1)
      return mcpError("INVALID_ARGUMENTS", `section role "${label}" is ambiguous; use sceneId or index`);
    return mcpError("UNKNOWN_TARGET", `no section matches exact name or role "${label}"`);
  }
  const role = typeof record.role === "string" ? record.role : "";
  if (role !== "") {
    const matches = doc.scenes.filter((scene) => sceneRoleOf(scene) === role);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1)
      return mcpError("INVALID_ARGUMENTS", `section role "${role}" is ambiguous; use sceneId or index`);
    return mcpError("UNKNOWN_TARGET", `no section has role ${role}`);
  }
  return mcpError("INVALID_ARGUMENTS", "choose a section by sceneId, exact scene name, 1-based index, or unique role");
}

/** Section op -> canonical arrange command for one already-resolved scene. */
function sectionCommand(record: Record<string, unknown>, doc: ProjectDocument, scene?: Scene): Command | null {
  const op = String(record.op ?? "");
  switch (op) {
    case "add":
      return applyArrangeOps(doc, [
        { op: "addRole", role: record.role as (typeof SECTION_ADD_ROLES)[number], beforeSceneId: null },
      ]);
    case "remove":
      if (!scene) return null;
      return applyArrangeOps(doc, [{ op: "remove", sceneId: scene.id, role: scene.role ?? null, name: scene.name }]);
    case "duplicate":
      if (!scene) return null;
      return applyArrangeOps(doc, [{ op: "duplicate", sceneId: scene.id, role: scene.role ?? null, name: scene.name }]);
    case "reorder":
      if (!scene) return null;
      return applyArrangeOps(doc, [
        { op: "reorder", sceneId: scene.id, dir: record.direction === "earlier" ? "earlier" : "later" },
      ]);
    case "resize":
      if (!scene || typeof record.bars !== "number") return null;
      return applyArrangeOps(doc, [
        { op: "resize", sceneId: scene.id, role: scene.role ?? null, name: scene.name, bars: record.bars },
      ]);
    default:
      return null;
  }
}

/** ZENIT instances on one track, in chain order. */
function zenitInstancesOf(doc: ProjectDocument, trackId: string): { id: string }[] {
  return (doc.tracks.find((t) => t.id === trackId)?.effects ?? [])
    .filter((fx) => fx.type === "zenit")
    .map((fx) => ({ id: fx.id }));
}

function pickZenitInstance(doc: ProjectDocument, trackId: string, record: Record<string, unknown>): string | null {
  const instances = zenitInstancesOf(doc, trackId);
  if (instances.length === 0) return null;
  const requested = record.instance ?? 1;
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1) return null;
  return instances[requested - 1]?.id ?? null;
}

function masterSignalFlowStatus(doc: ProjectDocument): string[] {
  const master = doc.master;
  const inputDb = (value: number): string => (value <= 0 ? "−∞" : `${(20 * Math.log10(value)).toFixed(1)} dB`);
  const trimDb = master.loudnessTrimDb ?? 0;
  const activeMatchBands = Object.values(master.matchEq ?? {}).filter(
    (value) => Number.isFinite(value) && Math.abs(value) >= 0.05,
  ).length;
  const insertSummary = (master.effects ?? []).length
    ? (master.effects ?? [])
        .map((effect) => `${effect.type.toUpperCase()} ${effect.id}${effect.bypassed ? " (bypassed)" : ""}`)
        .join(", ")
    : "none";
  const details: Record<MasterSignalFlowStageId, string> = {
    inputTrim: `IN ${inputDb(master.masterGain)} · loudness trim ${trimDb > 0 ? "+" : ""}${trimDb.toFixed(1)} dB`,
    tape: master.tapeEnabled ? `enabled · drive ${Math.round((master.tapeDrive ?? 0.35) * 100)}%` : "bypassed",
    midSide: master.msEnabled
      ? `enabled · mid ${master.msMidGain ?? 0} dB · side ${master.msSideGain ?? 0} dB`
      : "unity / transparent",
    bassMono: master.bassMonoEnabled
      ? `enabled below ${Math.round(master.bassMonoFreq ?? 120)} Hz`
      : "stereo unchanged",
    dcFilter: "always on · 12 Hz",
    matchEq: activeMatchBands ? `${activeMatchBands} corrective band(s) active` : "flat / transparent",
    tilt: `${(master.tiltDb ?? 0) > 0 ? "+" : ""}${(master.tiltDb ?? 0).toFixed(1)} dB`,
    glue: (master.glueEnabled ?? true) ? "enabled" : "bypassed",
    masterInserts: insertSummary,
    clipper: master.clipperEnabled ? `enabled · ceiling ${master.ceilingDb.toFixed(1)} dBFS` : "bypassed",
    monitorBypass: "monitor-only audition junction; rejoins before final limiter",
    limiter: master.limiterEnabled ? `enabled · ceiling ${master.ceilingDb.toFixed(1)} dBFS` : "bypassed",
    outputMeter: "post-limiter output · source PCM is pre-encode",
  };
  return MASTER_SIGNAL_FLOW.map(
    (stage, index) => `${String(index + 1).padStart(2, "0")} ${stage.label}: ${details[stage.id]}`,
  );
}

/**
 * The ZENIT composite mastering device (ADR 0020) over the MCP transport.
 * trackId may name a GROUP bus deliberately — a ZENIT on a group IS stem
 * mastering (host position is the feature); families resolve non-group tracks.
 */
/** kyx_unsuno — the track-to-project pipeline for agents. */
async function executeUnsunoTool(ctx: McpToolContext, record: Record<string, unknown>): Promise<McpToolResult> {
  const action = typeof record.action === "string" ? record.action : "";
  const text = (value: string, mutated = false, data?: unknown): McpToolResult => ({
    text: value,
    mutated,
    ...(data !== undefined ? { data } : {}),
  });

  if (action === "transcribe") {
    const sourceId = typeof record.sourceId === "string" ? record.sourceId.trim() : "";
    if (!sourceId) return text("kyx_unsuno transcribe needs sourceId — a user-library audio id.");
    if (!ctx.loadSampleMono) {
      return text(
        "kyx_unsuno transcribe needs a live session able to load user-sample audio — this context cannot (headless?).",
      );
    }
    if (record.separation !== undefined && record.separation !== "off" && record.separation !== "hpss") {
      return text(
        'separation must be "off" or "hpss" — the neural tier is not an agent surface (it downloads an 80 MB model).',
      );
    }
    const loaded = await ctx.loadSampleMono(sourceId);
    {
      if (!loaded) return text(`sample "${sourceId}" not found or undecodable — nothing transcribed.`);
      const transcription = transcribeTrack(loaded.mono, loaded.sampleRate, {
        separation: record.separation === "hpss" ? "hpss" : "off",
      });
      if (!transcription.tempo) {
        return text(
          "transcription found no tempo — the source is too short or too sparse to build a project from. Nothing mutated.",
        );
      }
      const result = unsunoCommand(ctx.getDoc(), { transcription });
      if (!result.command) {
        return text(`UN-SUNO: ${result.summary}`);
      }
      ctx.execute(result.command);
      unsunoSourceFingerprint = sourceFingerprintFromTranscription(transcription);
      const layers = Object.entries(result.layers)
        .filter(([, note]) => !/skipped|no /.test(note))
        .map(([layer, note]) => `${layer}: ${note}`);
      const layerLines = layers.length > 0 ? `\n${layers.join("\n")}` : "";
      return text(
        `UN-SUNO built: ${result.summary}${layerLines}\n` +
          `Next: kyx_unsuno restyle/regen with an artist label, kyx_unsuno similarity for the overlap report, kyx_render_summary to verify.`,
        true,
        {
          bpm: result.bpm,
          patternCount: result.patternCount,
          layers: result.layers,
          warnings: transcription.drums.warning ?? transcription.bass.warning ?? transcription.chords.warning ?? null,
        },
      );
    }
  }

  if (action === "restyle" || action === "regen") {
    const artist = typeof record.artist === "string" ? record.artist.trim() : "";
    if (!artist) return text(`kyx_unsuno ${action} needs an exact artist label — e.g. "travis scott".`);
    const result =
      action === "restyle" ? restyleCommand(ctx.getDoc(), artist) : regenerateStyleCommand(ctx.getDoc(), artist);
    if (!result.command) {
      const verbFail = action === "restyle" ? "Re-style" : "Regen";
      return text(`${verbFail}: ${result.summary}`);
    }
    ctx.execute(result.command);
    const verb = action === "restyle" ? "Re-styled as" : "Regenerated as";
    const applied: Record<string, unknown> = {
      ...("applied" in result ? (result.applied as Record<string, unknown>) : {}),
    };
    return text(`${verb} ${artist}: ${result.summary} (one undo step restores the previous version)`, true, {
      applied,
      sections: "sections" in result ? (result.sections as number) : 0,
    });
  }

  if (action === "similarity") {
    if (!unsunoSourceFingerprint) {
      return text(
        "no session source fingerprint — run kyx_unsuno transcribe first (the fingerprint is session-scoped).",
      );
    }
    const verdict = similarityAdvisory(unsunoSourceFingerprint, projectFingerprint(ctx.getDoc()));
    return text(
      `Similarity: ${Math.round(verdict.overall * 100)} % — ${verdict.verdict}.\n` +
        `drums ${verdict.drums !== null ? Math.round(verdict.drums * 100) + " %" : "n/a"} · ` +
        `harmony ${verdict.harmony !== null ? Math.round(verdict.harmony * 100) + " %" : "n/a"} · ` +
        `bass ${verdict.bass !== null ? Math.round(verdict.bass * 100) + " %" : "n/a"}\n` +
        `${verdict.disclaimer}`,
      false,
      { drums: verdict.drums, harmony: verdict.harmony, bass: verdict.bass, overall: verdict.overall },
    );
  }

  return text("kyx_unsuno action must be one of: transcribe | restyle | regen | similarity.");
}

async function executeMasterTool(ctx: McpToolContext, record: Record<string, unknown>): Promise<McpToolResult> {
  const op = String(record.op ?? "status");
  let doc = ctx.getDoc();
  if (op === "status") {
    const rows: string[] = [];
    for (const track of doc.tracks) {
      for (const fx of zenitInstancesOf(doc, track.id)) {
        const instance = track.effects.find((candidate) => candidate.id === fx.id);
        if (!instance) continue;
        const pct = (v: unknown): number => Math.round(Number(v ?? 0) * 100);
        rows.push(
          `${track.name} (id=${track.id}): ZENIT ${fx.id} · ceil ${Number(instance.params.ceiling ?? -1)} dB · ` +
            `limit ${pct(instance.params.limit)}% · glue ${pct(instance.params.glue)}% · drive ${pct(instance.params.drive)}%`,
        );
      }
    }
    const profile = resolveDeliveryTarget(doc.master);
    const meterSnapshot = ctx.meters?.() ?? null;
    const runtime = meterSnapshot?.masterRuntime;
    const runtimeLines =
      !runtime || !runtime.available
        ? ["RUNTIME: no active audio context; worklet readiness/fallbacks are not currently observable."]
        : [
            ...runtime.degradedStages.map(({ stageId, reason }) => `FALLBACK ${stageId}: ${reason}`),
            ...runtime.degradedInserts.map(({ fxId, reason }) => `FALLBACK master insert ${fxId}: ${reason}`),
            ...(!runtime.degradedStages.length && !runtime.degradedInserts.length
              ? ["RUNTIME: no master processor fallback reported."]
              : []),
          ];
    const liveMeterLines =
      runtime?.available && meterSnapshot
        ? [
            `LIVE SNAPSHOT (not a full-song report) · ${meterSnapshot.master.lufsIntegrated.toFixed(1)} LUFS-I · ${meterSnapshot.master.truePeakDb.toFixed(1)} dBTP · ${meterSnapshot.master.clipping ? "clip flag" : "no clip flag"}`,
          ]
        : [];
    return {
      text:
        (rows.length > 0
          ? rows.join("\n")
          : "no ZENIT instances — op:add inserts the mastering strip on a bus (a group bus = stem mastering)") +
        `\n\nGLOBAL MASTER · ${profile.label} · target ${profile.targetLufs} LUFS · delivery ceiling ${profile.maxTruePeakDb} dBTP · processing ceiling ${doc.master.ceilingDb.toFixed(1)} dBFS` +
        `\n${masterSignalFlowStatus(doc).join("\n")}` +
        `\n${runtimeLines.join("\n")}` +
        `${liveMeterLines.length ? `\n${liveMeterLines.join("\n")}` : ""}` +
        "\nMeasure a full master with MASTER → Analyze / Export; live meter values above are only a current snapshot.",
      mutated: false,
    };
  }
  let ids: string[];
  const exactId = typeof record.trackId === "string" ? record.trackId.trim() : "";
  if (exactId !== "") {
    if (!doc.tracks.some((t) => t.id === exactId)) return { text: `track ${exactId} not found`, mutated: false };
    ids = [exactId];
  } else {
    ids = tracksInFamily(doc, String(record.family ?? ""));
    // Import-only calls create their own lanes — no early refusal.
    if (ids.length === 0 && !Array.isArray(record.import)) {
      return {
        text: `no track matches family "${String(record.family ?? "")}" — pass trackId (group buses allowed and encouraged: that IS stem mastering)`,
        mutated: false,
      };
    }
  }

  if (op === "add") {
    let next = doc;
    for (const id of ids) next = addEffectToTracks(next, [id], "zenit").execute(next);
    ctx.execute(snapshot("mcpMasterAdd", `MCP: add ZENIT (${ids.length} bus)`, doc, next));
    const placed = ids
      .map((id) => `${doc.tracks.find((t) => t.id === id)!.name}: ${pickZenitInstance(next, id, {}) ?? "?"}`)
      .join("; ");
    return { text: `ZENIT inserted — ${placed} — one undo step`, mutated: true };
  }

  // The remove gate fires BEFORE target resolution: a locked context must
  // refuse as locked even when no instance exists (the lock is the message).
  if (op === "remove" && !destructiveAllowedWithCheckpoint(ctx, "kyx_master")) return destructiveRefusal();

  if (op === "platform" || op === "land") {
    // Closed loudness/true-peak loop against a delivery platform contract.
    // platform: measure → verdict lines (read-only). land: iterate
    // measure → master loudness-trim → measure until |delta| ≤ 0.3 LU
    // (max 3 bounded iterations — the loop reports honestly when the
    // ±12 dB trim range cannot close the gap).
    const requestedProfile =
      typeof record.profile === "string" ? record.profile : (doc.master.deliveryProfileId ?? "streaming");
    const baseProfile =
      profileFor(requestedProfile) ??
      (requestedProfile === "custom" ? resolveDeliveryTarget(doc.master) : profileFor("streaming"))!;
    const profile = {
      ...baseProfile,
      targetLufs: typeof record.targetLufs === "number" ? record.targetLufs : baseProfile.targetLufs,
      maxTruePeakDb: typeof record.targetTruePeakDb === "number" ? record.targetTruePeakDb : baseProfile.maxTruePeakDb,
    };
    const targetLufs = profile.targetLufs;
    const readMeter = () => {
      const master = (ctx.meters?.() as { master?: Record<string, unknown> } | null)?.master;
      if (!master) return null;
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const measuredLufs = num(master.lufsIntegrated) ?? num(master.lufsShortTerm);
      const lufs = measuredLufs != null && measuredLufs > -119 ? measuredLufs : null;
      const truePeakDb = num(master.truePeakDb) ?? num(master.peakHoldDb);
      if (truePeakDb == null) return null;
      return {
        lufs,
        truePeakDb,
        correlation: num(master.correlation),
        monoLossDb: num(master.monoLossDb),
        lrImbalanceDb: num(master.lrImbalanceDb),
      };
    };
    const first = readMeter();
    if (!first) {
      return { text: `${op} needs live audio meters (play a few seconds for LUFS-I to settle)`, mutated: false };
    }
    if (op === "platform") {
      const verdicts = verdictAgainst(first, profile);
      return {
        text: `${worstStatus(verdicts).toUpperCase()} — ${verdicts.map((v) => v.line).join("\n")}`,
        mutated: false,
      };
    }
    if (first.lufs == null) {
      return {
        text: "land needs measurable LUFS-I (play the full song or use op:platform to read available checks)",
        mutated: false,
      };
    }
    // op:land — bounded closed loop on the MASTER loudness trim. Each
    // iteration APPLIES the trim through the command layer (the engine syncs
    // immediately) and re-measures the REAL meters — no simulated arithmetic.
    const clampTrim = (v: number) => Math.min(12, Math.max(-12, v));
    const TOLERANCE = 0.3;
    const MAX_STEPS = 3;
    const steps: string[] = [];
    let meter = first;
    let mutated = false;
    for (let step = 0; step < MAX_STEPS; step++) {
      if (meter.lufs == null) break;
      const delta = targetLufs - meter.lufs;
      if (Math.abs(delta) <= TOLERANCE) break;
      const current = ctx.getDoc().master.loudnessTrimDb ?? 0;
      const nextTrim = clampTrim(current + delta);
      if (Math.abs(nextTrim - current) < 0.01) {
        steps.push(
          `master trim range (±12 dB) exhausted at ${current.toFixed(1)} dB — cannot close the remaining ${Math.abs(delta).toFixed(1)} LU`,
        );
        break;
      }
      ctx.execute(setMasterConfig(ctx.getDoc(), { loudnessTrimDb: nextTrim }));
      mutated = true;
      const remeasured = readMeter();
      if (!remeasured) break;
      meter = remeasured;
      if (meter.lufs == null) break;
      steps.push(
        `step ${step + 1}: trim ${nextTrim >= 0 ? "+" : ""}${nextTrim.toFixed(1)} dB → measured ${meter.lufs.toFixed(1)} LUFS`,
      );
    }
    if (meter.lufs == null) {
      return { text: "NOT LANDED — LUFS-I became unavailable after a trim; remeasure the master", mutated };
    }
    const finalDelta = targetLufs - meter.lufs;
    const landed = Math.abs(finalDelta) <= 0.5;
    const verdicts = verdictAgainst(meter, profile);
    return {
      text:
        `${landed ? "LANDED" : "NOT LANDED"} — target ${targetLufs} LUFS, measured ${meter.lufs.toFixed(1)}:\n` +
        (steps.length > 0 ? `${steps.join("\n")}\n` : "") +
        verdicts.map((v) => v.line).join("\n"),
      mutated,
    };
  }

  if (op === "stems") {
    const originalDoc = doc; // the import reassigns doc — prev must be the pre-import state
    // STEM MASTERING payoff: per-stem ZENIT shapes on the separated lanes
    // (vocals/drums/bass/other). Lanes are matched by NAME; a lane without
    // a stem role is reported, never touched. ONE snapshot for everything.
    const plan = stemMasteringPlan();
    // OPTIONAL IMPORT (the separation→mastering full flow): stem buffers
    // become project lanes (Vocals/Drums/Bass/Other in one STEMS bus) in the
    // SAME op — then the per-role shapes land on them.
    const importSpecs = Array.isArray(record.import) ? (record.import as Record<string, unknown>[]) : [];
    if (importSpecs.length > 0) {
      const specs = importSpecs
        .map((spec) => ({
          role: String(spec.role ?? "") as StemRole,
          bufferId: String(spec.bufferId ?? ""),
          durationSec: Number(spec.durationSec),
        }))
        .filter((spec) => ["vocals", "drums", "bass", "other"].includes(spec.role) && spec.bufferId !== "");
      if (specs.length === 0) {
        return {
          text: "import needs entries {role: vocals|drums|bass|other, bufferId, durationSec}",
          mutated: false,
        };
      }
      doc = addStemTracksCommand(doc, specs).execute(doc);
      // The imported lanes are the mastering targets (matched by role name).
      const importedIds = doc.tracks
        .filter((t) => t.kind === "instrument" && stemRoleOf(t.name) !== null)
        .map((t) => t.id);
      ids.splice(0, ids.length, ...importedIds);
    }
    let next = doc;
    const lines: string[] = [];
    let matched = 0;
    for (const id of ids) {
      const track = next.tracks.find((t) => t.id === id)!;
      const stem = stemRoleOf(track.name);
      if (!stem) {
        lines.push(`${track.name}: no stem role in the name — skipped (rename the lane vocals/drums/bass/other)`);
        continue;
      }
      const shape = plan.find((entry) => entry.stem === stem)!;
      let fxId = pickZenitInstance(next, id, record);
      if (!fxId) {
        if (record.instance != null) {
          return mcpError(
            "INVALID_ARGUMENTS",
            `${track.name}: ZENIT instance #${String(record.instance)} does not exist`,
          );
        }
        next = addEffectToTracks(next, [id], "zenit").execute(next);
        const created = next.tracks
          .find((t) => t.id === id)!
          .effects.filter((fx) => fx.type === "zenit")
          .at(-1);
        if (!created) return mcpError("EXECUTION_FAILED", `insert of ZENIT failed on ${track.name}`);
        fxId = created.id;
      }
      for (const [paramId, value] of Object.entries(shape.params))
        next = setEffectParam(next, id, fxId, paramId, value).execute(next);
      matched++;
      lines.push(`${track.name} → ${shape.label} — ${shape.why}`);
    }
    if (matched === 0) {
      const detail = lines.length > 0 ? ` — ${lines.join("; ")}` : "";
      return {
        text: `no stem lanes matched — stem mastering needs lanes named vocals/drums/bass/other${detail}`,
        mutated: false,
      };
    }
    ctx.execute(snapshot("mcpStemMastering", `MCP: stem mastering on ${matched} lane(s)`, originalDoc, next));
    return {
      text: `stem mastering applied on ${matched} lane(s), one undo step:\n${lines.join("\n")}\nland the master with op:land after a fresh measure`,
      mutated: true,
    };
  }

  if (op === "ab") {
    // MASTER A/B SNAPSHOTS — scope names to this project and keep the snapshots
    // session-only, never in the project document.
    // Restore folds every param + trim write into ONE undoable snapshot.
    const projectId = doc.id !== "" ? doc.id : `unnamed:${doc.name}`;
    const snapshots = masterAbStore.get(projectId) ?? new Map<string, AbSnapshot>();
    masterAbStore.set(projectId, snapshots);
    const action = String(record.action ?? "list");
    if (action === "list") {
      const names = [...snapshots.keys()];
      return {
        text:
          names.length === 0
            ? "no snapshots — op:ab {action:save, name} captures the bus mastering state"
            : names.map((n) => snapshotSummary(snapshots.get(n)!)).join("\n"),
        mutated: false,
      };
    }
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (action === "save") {
      if (name === "") return { text: "save needs a snapshot name", mutated: false };
      const devices = ids.flatMap((id) => {
        const track = doc.tracks.find((t) => t.id === id)!;
        return collectDevices(track);
      });
      if (devices.length === 0) {
        return { text: "no mastering devices on the bus — add ZENIT/APEX/SPAN/TIDE first", mutated: false };
      }
      snapshots.set(name, { name, savedAt: new Date().toISOString(), devices });
      return {
        text: `snapshot '${name}' saved — ${devices.length} device(s); mutate freely, then compare/restore`,
        mutated: false,
      };
    }
    const snap = snapshots.get(name);
    if (!snap) return { text: `no snapshot '${name}' — op:ab {action:list}`, mutated: false };
    if (action === "compare") {
      const current: AbSnapshot = {
        name: "current",
        savedAt: new Date().toISOString(),
        devices: ids.flatMap((id) => collectDevices(doc.tracks.find((t) => t.id === id)!)),
      };
      const rows = diffSnapshots(snap, current);
      const body =
        rows.length === 0
          ? "identical to the current state"
          : rows
              .map((row) => {
                const device = `${row.track} · ${row.device}${row.instanceIndex === undefined ? "" : ` #${row.instanceIndex + 1}`}`;
                if (row.presenceChange === "missing-in-current") return `${device}: present in snapshot, missing now`;
                if (row.presenceChange === "new-in-current") return `${device}: added since snapshot`;
                return `${device}.${row.param}: ${row.a == null ? "—" : row.a.toFixed(2)} → ${row.b == null ? "—" : row.b.toFixed(2)}`;
              })
              .join("\n") + "\nlevel-match hint: restore, then offset op:trim by the trims shown in the list";
      return { text: `'${name}' vs current:\n${body}`, mutated: false };
    }
    if (action === "restore") {
      let next = doc;
      const applied: string[] = [];
      const skipped: string[] = [];
      for (const device of snap.devices) {
        const track = next.tracks.find((t) => t.id === device.trackId);
        const instanceLabel = `${device.trackName}/${device.type}${device.instanceIndex === undefined ? "" : ` #${device.instanceIndex + 1}`}`;
        if (!track) {
          skipped.push(instanceLabel);
          continue;
        }
        // Prefer the saved ID when it survived; the per-type occurrence handles recreated IDs.
        const matchingDevices = track.effects.filter((fx) => fx.type === device.type);
        const instance =
          matchingDevices.find((fx) => fx.id === device.fxId) ?? matchingDevices[device.instanceIndex ?? 0];
        if (!instance) {
          skipped.push(instanceLabel);
          continue;
        }
        for (const [paramId, value] of Object.entries(device.params))
          next = setEffectParam(next, track.id, instance.id, paramId, value).execute(next);
        if (device.outputTrimDb != null)
          next = setEffectOutputTrimDb(next, track.id, instance.id, device.outputTrimDb).execute(next);
        applied.push(
          `${track.name}/${device.type}${device.instanceIndex === undefined ? "" : ` #${device.instanceIndex + 1}`}`,
        );
      }
      if (applied.length === 0)
        return {
          text: `nothing to restore — the saved mastering devices are missing: ${skipped.join(", ") || "unknown"}`,
          mutated: false,
        };
      ctx.execute(snapshot("mcpMasterAbRestore", `MCP: restore A/B '${name}'`, doc, next));
      const skippedReadback = skipped.length > 0 ? `; skipped missing ${skipped.join(", ")}` : "";
      return { text: `restored '${name}' on ${applied.join(", ")}${skippedReadback} — one undo step`, mutated: true };
    }
    return mcpError("UNKNOWN_REQUEST", `unknown op:ab action: ${action} (save | list | compare | restore)`);
  }

  if (op === "iterate") {
    // CLOSED-LOOP TONAL ITERATOR: render → measure → adjust → re-render.
    // Bounded at 3 iterations; ctx.renderMix is the AI's ears.
    if (!ctx.renderMix) {
      return {
        text: "iterate needs ctx.renderMix (the transport bridge must provide the render callback)",
        mutated: false,
      };
    }
    const targetLufs = typeof record.targetLufs === "number" ? record.targetLufs : -14;
    const targetHf = typeof record.targetHfShare === "number" ? record.targetHfShare : 0.2;
    const targetLow = typeof record.targetLowEndShare === "number" ? record.targetLowEndShare : 0.25;
    const targetCrest = typeof record.targetCrestDb === "number" ? record.targetCrestDb : 11;
    const targetCorr = typeof record.targetCorrelation === "number" ? record.targetCorrelation : null;
    const lines: string[] = [];
    let next = doc;
    let converged = false;
    for (let iteration = 0; iteration < 3; iteration++) {
      const rendered = await ctx.renderMix();
      if (!rendered) {
        lines.push(`render failed at iteration ${iteration + 1}`);
        break;
      }
      const analysis = analyzeMasterPcm(rendered.channels, rendered.sampleRate, {
        id: "iterate",
        label: "Iterate",
        targetLufs,
        maxTruePeakDb: -1,
      } as never);
      const mh = analysis.mixHealth;
      const bandSharesDb: Record<string, number> = {};
      if (mh.bandShares) {
        for (const [band, share] of Object.entries(mh.bandShares)) {
          if (typeof share === "number") bandSharesDb[band] = 10 * Math.log10(Math.max(share, 1e-6));
        }
      }
      const measurement: IterateMeasurement = {
        lufs: mh.integratedLufs,
        crestDb: mh.crestDb,
        correlation: mh.stereoCorrelation,
        bandSharesDb,
        target: {
          lufs: targetLufs,
          crestDb: targetCrest,
          correlation: targetCorr,
          hfShare: targetHf,
          lowEndShare: targetLow,
        },
      };
      if (isConverged(measurement)) {
        lines.push(`iteration ${iteration + 1}: CONVERGED (LUFS ${mh.integratedLufs?.toFixed(1) ?? "?"})`);
        converged = true;
        break;
      }
      const steps = iterateTowardTarget(measurement);
      if (steps.length === 0) {
        lines.push(`iteration ${iteration + 1}: converged (no adjustments needed)`);
        converged = true;
        break;
      }
      for (const step of steps) {
        for (const track of next.tracks) {
          const instance = track.effects.find((fx) => fx.type === step.device);
          if (!instance) continue;
          const current = instance.params[step.param] ?? 0;
          const adjusted = Math.max(0, current + step.delta);
          next = setEffectParam(next, track.id, instance.id, step.param, adjusted).execute(next);
          lines.push(
            `iter ${iteration + 1}: ${track.name} · ${step.device}.${step.param} ${current.toFixed(2)} → ${adjusted.toFixed(2)} — ${step.why}`,
          );
        }
      }
    }
    if (next === doc) {
      return { text: `iterate: ${lines.join("\n") || "already converged"}`, mutated: false };
    }
    ctx.execute(snapshot("mcpMasterIterate", `MCP: iterate (${converged ? "converged" : "capped at 3"})`, doc, next));
    // Structured iteration data for the light-show UI: each line parsed into
    // { iteration, device, param, from, to } for the convergence renderer.
    const iterationSteps = lines.map((line) => {
      const iterMatch = /iter (\d+):/.exec(line);
      const paramMatch = /([\w.]+) ([-\d.]+) → ([-\d.]+)/.exec(line);
      return {
        iteration: iterMatch ? Number(iterMatch[1]) : 0,
        deviceParam: paramMatch ? paramMatch[1] : line.slice(0, 30),
        from: paramMatch ? Number(paramMatch[2]) : 0,
        to: paramMatch ? Number(paramMatch[3]) : 0,
      };
    });
    return {
      text: `iterate ${converged ? "CONVERGED" : "CAPPED at 3"} — ${lines.length} adjustment(s), one undo step:\n${lines.join("\n")}`,
      data: { iterations: iterationSteps, converged },
      mutated: true,
    };
  }

  if (op === "assist") {
    // MASTER ASSISTANT (M3): measure → deterministic plan (master-assistant.ts)
    // → apply through the command layer as ONE snapshot. Every step carries
    // its WHY; the loudness authority stays with op:trim after measuring.
    const meter = ctx.meters?.();
    const master = (meter as { master?: Record<string, unknown> } | null)?.master;
    if (!master) {
      return {
        text: "assist needs live audio meters (play a few seconds first) — or use op:preset + op:trim with explicit values",
        mutated: false,
      };
    }
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const lufs = num(master.lufsIntegrated) ?? num(master.lufsShortTerm);
    const measuredPeakDb = num(master.truePeakDb) ?? num(master.peakHoldDb);
    const peakDb = measuredPeakDb ?? 0;
    const rmsDb = num(master.rmsDb);
    const crestDb = num(master.crestDb) ?? (peakDb != null && rmsDb != null ? peakDb - rmsDb : 10);
    const correlation = num(master.correlation);
    const requestedProfile = typeof record.profile === "string" ? record.profile : doc.master.deliveryProfileId;
    const assistantProfile =
      requestedProfile === "custom"
        ? resolveDeliveryTarget({ ...doc.master, deliveryProfileId: "custom" })
        : (profileFor(requestedProfile) ?? resolveDeliveryTarget(doc.master));
    // REFERENCE MASTERING: when the caller supplies a reference measurement,
    // the plan moves toward the measured DIFFERENCE (F2 §2.2 — the
    // reference's absolute shape is never the target).
    const referenceRaw = record.reference;
    const referenceRequested = referenceRaw !== undefined && referenceRaw !== null;
    const referenceIn =
      typeof referenceRaw === "object" && !Array.isArray(referenceRaw) ? (referenceRaw as Record<string, unknown>) : {};
    const referenceMineLufs = lufs != null && lufs > -119 ? lufs : null;
    const referenceMineHasSignal = referenceMineLufs != null;
    const boundedNumber = (value: unknown, min: number, max: number): number | null => {
      const parsed = num(value);
      return parsed != null && parsed >= min && parsed <= max ? parsed : null;
    };
    const referencePlan = referenceRequested
      ? planReferenceMastering({
          mine: {
            lufs: referenceMineLufs,
            crestDb: referenceMineHasSignal
              ? (num(master.crestDb) ?? (measuredPeakDb != null && rmsDb != null ? measuredPeakDb - rmsDb : null))
              : null,
            correlation: referenceMineHasSignal ? boundedNumber(correlation, -1, 1) : null,
            hfShare: null,
            lowEndShare: null,
          },
          reference: {
            lufs: boundedNumber(referenceIn.lufs, -119, 12),
            crestDb: boundedNumber(referenceIn.crestDb, -100, 100),
            correlation: boundedNumber(referenceIn.correlation, -1, 1),
            hfShare: boundedNumber(referenceIn.hfShare, 0, 1),
            lowEndShare: boundedNumber(referenceIn.lowEndShare, 0, 1),
          },
          targetLufs: boundedNumber(record.targetLufs, -24, 0) ?? undefined,
        })
      : null;
    const plan =
      referencePlan ??
      planMasterSettings({
        lufs,
        peakDb,
        crestDb,
        correlation,
        targetLufs: typeof record.targetLufs === "number" ? record.targetLufs : assistantProfile.targetLufs,
        targetTruePeakDb:
          typeof record.targetTruePeakDb === "number" ? record.targetTruePeakDb : assistantProfile.maxTruePeakDb,
      });
    if (plan.length === 0) {
      return {
        text: referenceRequested
          ? "assist found no actionable difference in the supplied reference measurements"
          : "assist found nothing to change",
        mutated: false,
      };
    }

    const wantedTypeOf: Record<string, "zenit" | "apeks" | "sirka"> = {
      zenit: "zenit",
      apeks: "apeks",
      sirka: "sirka",
    };
    let next = doc;
    const lines: string[] = [];
    let appliedCount = 0;
    for (const step of plan) {
      if (step.device === "master")
        return mcpError("POLICY_REFUSED", "track-scoped kyx_master assist cannot change the final project limiter");
      for (const id of ids) {
        const track = next.tracks.find((t) => t.id === id)!;
        let fxId = pickZenitInstance(next, id, record);
        const wantedType = wantedTypeOf[step.device];
        if (step.device !== "zenit") {
          const sameDevice = track.effects.find((fx) => fx.type === wantedType);
          fxId = sameDevice?.id ?? null;
        }
        const existing = fxId ? track.effects.find((fx) => fx.id === fxId) : undefined;
        const definition = EFFECT_META[wantedType].params.find((candidate) => candidate.id === step.param);
        const currentValue = clampEffectParam(
          wantedType,
          step.param,
          existing?.params[step.param] ?? definition?.default ?? 0,
        );
        const value = clampEffectParam(
          wantedType,
          step.param,
          resolveMasterAssistantStepValue(step, currentValue, definition?.min, definition?.max),
        );
        if (Math.abs(value - currentValue) <= 1e-9) {
          lines.push(`${track.name} · ${step.device}.${step.param} already meets the suggested direction — skipped`);
          continue;
        }
        if (!fxId) {
          if (step.device === "zenit" && record.instance != null) {
            return mcpError(
              "INVALID_ARGUMENTS",
              `${track.name}: ZENIT instance #${String(record.instance)} does not exist`,
            );
          }
          if (record.insert !== true) {
            return {
              text: `${track.name}: ${step.device} not inserted — pass insert:true to let assist add missing devices`,
              mutated: false,
            };
          }
          next = addEffectToTracks(next, [id], wantedType).execute(next);
          const created = next.tracks
            .find((t) => t.id === id)!
            .effects.filter((fx) => fx.type === wantedType)
            .at(-1);
          if (!created) return mcpError("EXECUTION_FAILED", `insert of ${step.device} failed on ${track.name}`);
          fxId = created.id;
        }
        if (existing?.bypassed) next = toggleEffectBypass(next, id, fxId).execute(next);
        next = setEffectParam(next, id, fxId, step.param, value).execute(next);
        appliedCount++;
        lines.push(
          `${track.name} · ${step.device}.${step.param} ${currentValue.toFixed(2)} → ${value.toFixed(2)}${existing?.bypassed ? " · device enabled" : ""} — ${step.why}`,
        );
      }
    }
    if (appliedCount === 0) {
      return {
        text: `assist found no applicable setting changes${lines.length ? `:\n${lines.join("\n")}` : ""}`,
        mutated: false,
      };
    }
    ctx.execute(snapshot("mcpMasterAssist", "MCP: master assistant plan", doc, next));
    return {
      text: `master assistant applied ${appliedCount} setting change(s), one undo step:\n${lines.join("\n")}\nmeasure again (kyx_loudness) and fine-land with op:trim`,
      mutated: true,
    };
  }

  // Every op below targets EXISTING ZENIT instances.
  const targets: { trackId: string; trackName: string; fxId: string }[] = [];
  for (const id of ids) {
    const track = doc.tracks.find((t) => t.id === id)!;
    const fxId = pickZenitInstance(doc, id, record);
    if (!fxId) {
      if (record.instance != null) {
        return mcpError(
          "INVALID_ARGUMENTS",
          `${track.name}: ZENIT instance #${String(record.instance)} does not exist`,
        );
      }
      return { text: `${track.name} carries no ZENIT instance — op:add first`, mutated: false };
    }
    targets.push({ trackId: id, trackName: track.name, fxId });
  }

  if (op === "preset") {
    const target = String(record.target ?? "");
    const preset = presetsForEffect("zenit").find((candidate) => candidate.id === `zenit-${target}`);
    if (!preset) return { text: "preset needs target: streaming | club | vinyl", mutated: false };
    let next = doc;
    for (const { trackId, fxId } of targets)
      for (const [paramId, value] of Object.entries(preset.params))
        next = setEffectParam(next, trackId, fxId, paramId, value).execute(next);
    ctx.execute(snapshot("mcpMasterPreset", `MCP: ZENIT preset "${preset.name}"`, doc, next));
    return {
      text: `${preset.name} on ${targets.map((t) => t.trackName).join(", ")} — one undo step; measure with kyx_loudness, then op:trim`,
      mutated: true,
    };
  }

  if (op === "trim") {
    const trimDb = Number(record.trimDb);
    if (record.trimDb == null || !Number.isFinite(trimDb)) {
      return {
        text: "trim needs trimDb = target LUFS − measured LUFS (measure with kyx_loudness first)",
        mutated: false,
      };
    }
    let next = doc;
    for (const { trackId, fxId } of targets) next = setEffectOutputTrimDb(next, trackId, fxId, trimDb).execute(next);
    ctx.execute(snapshot("mcpMasterTrim", `MCP: ZENIT trim ${trimDb > 0 ? "+" : ""}${trimDb} dB`, doc, next));
    return {
      text: `output trim ${trimDb > 0 ? "+" : ""}${trimDb} dB on ${targets.map((t) => t.trackName).join(", ")} — one undo step (clamped −18…+12)`,
      mutated: true,
    };
  }

  if (op === "remove") {
    let next = doc;
    for (const { trackId, fxId } of targets) next = removeEffect(next, trackId, fxId).execute(next);
    ctx.execute(snapshot("mcpMasterRemove", `MCP: remove ZENIT (${targets.length})`, doc, next));
    return { text: `ZENIT removed from ${targets.map((t) => t.trackName).join(", ")} — one undo step`, mutated: true };
  }

  return mcpError("UNKNOWN_REQUEST", `unknown kyx_master op: ${op}`);
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
          // Degrade honestly to the raw id when the bank chunk is cold — the
          // kyx_state path warms before snapshotting, so this is belt-and-braces
          // for any direct/internal caller of stateSnapshot.
          const preset = isFactoryPresetsWarm()
            ? factoryPresets().find((candidate) => candidate.id === track.presetId)
            : undefined;
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
    return mcpError("UNKNOWN_REQUEST", `unknown pad family "${family}"`);
  }
  const drums = doc.tracks.filter((track): track is DrumTrack => track.kind === "drum");
  if (drums.length === 0) return { text: "no drum tracks in the project", mutated: false };

  const targets: Array<{ padId: string; name: string }> = [];
  for (const track of drums) {
    track.pads.forEach((pad, index) => {
      if (inferPadRole(pad.name, index) === family) targets.push({ padId: pad.id, name: pad.name });
    });
  }
  if (targets.length === 0) return mcpError("UNKNOWN_TARGET", `no pad matches family "${family}"`);

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
// routeIsDestructive lives in src/intent/route-guard.ts (shared with the
// Intent Bar's destructive-intent checkpoint — the UI must not import the
// lazy MCP surface, so the predicate moved to the intent layer).

function executeIntentTool(ctx: McpToolContext, instruction: string): McpToolResult {
  const trimmed = instruction.trim();
  if (trimmed.length === 0) return { text: "empty instruction", mutated: false };
  return executeRoutedIntent(ctx, routeIntentText(trimmed, ctx.getDoc()));
}

/** Execute a resolved route over MCP — the deterministic path AND the local
 * model fallback land here, so the destructive gate, the UI-local refusals
 * and the verification read-back apply to BOTH brains identically. */
function executeRoutedIntent(ctx: McpToolContext, route: RoutedIntent): McpToolResult {
  // The prior-adjustment ledger is session-scoped and invalidated by any
  // other mutation / generation / undo; the three recordable routes re-record
  // after their command lands.
  if (
    route.kind !== "fader" &&
    route.kind !== "paramIntent" &&
    route.kind !== "effectIntent" &&
    route.kind !== "clarify" &&
    route.kind !== "queryIntent"
  ) {
    clearAdjustmentLedger();
  }
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
    // The sentence, not the machine key — an agent reading "negated-mutation-
    // command" learns nothing about what to say next.
    const message = clarifyMessage(route.reason);
    const suggestions = route.suggestions.length > 0 ? ` suggestions: ${route.suggestions.join(" | ")}` : "";
    return { text: `${message}${suggestions}`, mutated: false };
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
  if (route.kind === "sectionTransition") {
    // Structural arrangement repaint — a plain doc mutation, one undo step,
    // terse read-back (MCP P3): the label IS the summary.
    const outcome = reviseSectionTransitions(ctx.getDoc(), route.targetRole, route.transition);
    if (!outcome.ok || !outcome.command) {
      return { text: outcome.error ?? "transition failed", mutated: false };
    }
    ctx.execute(outcome.command);
    return { text: outcome.label ?? "transition applied", mutated: true };
  }
  if (routeIsDestructive(route) && !destructiveAllowedWithCheckpoint(ctx, "kyx_intent")) return destructiveRefusal();

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
    if (route.kind === "fader") recordFaderAdjustment(before.id, route.intent, before, ctx.getDoc());
    else if (route.kind === "effectIntent") recordEffectAdjustment(before.id, route.intent, before, ctx.getDoc());
    else if (route.kind === "paramIntent") recordParamAdjustment(before.id, route.intent, before, ctx.getDoc());
    const extra = route.kind === "production" ? ` — ${productionReadback(before, ctx.getDoc(), route.intent)}` : "";
    return { text: `${command.label}${extra} — verification: applied, one undo step in KYX`, mutated: true };
  } catch (error) {
    // The intent appliers throw on no-target / already-matches — surface as
    // an honest failure instead of letting it kill the relay round-trip.
    return mcpError("EXECUTION_FAILED", `intent failed: ${error instanceof Error ? error.message : String(error)}`);
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
    case "paramIntent":
      return applyParamIntent(doc, route.intent);
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
