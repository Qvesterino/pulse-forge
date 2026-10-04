/**
 * Effect instances on a track: remove one, or add one together with the commands that make it
 * audible (landing, automation, reference wiring) as a single undoable group.
 *
 * Removing an effect also prunes the references other parts of the doc hold to it — a scene
 * pointing at a parameter that no longer exists. The pruning is reported on the command's `detail`
 * so the UI can tell the user what was cleaned up instead of silently losing the link.
 */
import type { Command } from "./types";
import type {
  ArrangementClip,
  ArrangementTransition,
  ArrangementTransitionType,
  AudioClip,
  DrumPad,
  DrumTrack,
  EffectInstance,
  EffectType,
  GrooveSettings,
  Marker,
  NoteEvent,
  PatternAssist,
  ProjectDocument,
  Scene,
  SceneRole,
  StepMeta,
  Track,
} from "../project-model/types";
import { BAR_TICKS, PPQ, STEP_TICKS } from "../project-model/types";
import { arrangementSecondsBetweenTicks, tempoAtTick } from "../project-model/scene-time";
import { buildStemProject } from "../rendering/stems";
import {
  planProductionActions,
  resolveProductionTargets,
  type ProductionAction,
  type ProductionIntent,
} from "../intent/production";
import { withPad } from "../project-model/transform";
import { warpBufferTimeAtTick } from "../project-model/audio-clip-warp";
import { patternPhaseOffsetAtTick, sceneOffsetAtTick } from "../project-model/events";
import {
  createGroupTrackModel,
  createPatternForDoc,
  MAX_ARRANGEMENT_CLIP_BARS,
  MAX_BPM,
  MIN_BPM,
  normalizeProject,
  sceneRoleOf,
  clampArrangementTransitionType,
  sanitizeArrangementTransitions,
} from "../project-model/schema";
import { sanitizeGateSteps, sanitizeManglerSteps } from "../project-model/modulators";
import type { Pattern } from "../project-model/types";
import { clampEffectParam, defaultParamsOf, EFFECT_META, normalizePluginParams } from "../effects/definitions";
import { targetParamDef } from "../project-model/targets";
import { CORE_EFFECT_PRESETS, type EffectPreset } from "../effects/presets";
import type { BeatmakingEffectChain } from "../effects/chains";
import { clampFxOutputTrimDb, factoryFxChainGainDb, factoryFxPresetGainDb } from "../effects/presetLoudness";
import { uid } from "../shared/ids";
import type { SharedPackSceneSketch, SharedPackSketch } from "../export/packCode";
import { resolveGrooveForGeneration } from "../ai/generator";
import { generateLocalResultFromOptions } from "../intent/pipeline";
import type { GenerationResult } from "../intent/types";
import type { GenerateOptions } from "../ai/types";
import { buildAssistPatch, normalizeAssistRequest } from "../assist/pipeline";
import { classifyPads } from "../assist/patternOps";
import { padsForFamily } from "../intent/pattern-verbs";
import type { ExactIntentPlan, ExactOp, ExactTarget } from "../intent/exact";
import { ASSIST_ENGINE_ID, ASSIST_ENGINE_VERSION, type AssistInput } from "../assist/types";
import { canonicalizePattern, contentHash } from "../ai/evaluation";
import { snapshot } from "./core";

/* ---------------- effect instances ---------------- */
export function removeEffect(doc: ProjectDocument, trackId: string, fxId: string): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target) {
    // Stale/collab-raced id — a silent no-op, not a dead undo entry.
    return { type: "removeEffect", label: "Remove effect", execute: (d) => d, undo: (d) => d };
  }
  const removed = new Set([`${trackId}|${fxId}`]);
  const next = stripDanglingEffectReferences(
    withTrackEffects(doc, trackId, (effects) => effects.filter((f) => f.id !== fxId)),
    removed,
  );
  // Whole-command delta (no partial applyToYDoc): the collab fallback
  // applies execute() on peers, which propagates the reference pruning too.
  const command = snapshot("removeEffect", `Remove ${EFFECT_META[target.type].name}`, doc, next);
  const detail = cleanupDetail(doc, next);
  return detail ? { ...command, detail } : command;
}

/**
 * Add an effect AND tune it in the SAME undo step (FX-ADD-REWORK-ROADMAP
 * Wave B: role-aware landings). `landing` params fold over factory
 * defaults, clamped to the registry's ParamDef metadata — an out-of-range
 * entry can never corrupt the instance; unknown param ids are skipped so a
 * stale table entry can never block adding the device. Undo removes the
 * effect entirely (add+tune was one user action, it undoes as one).
 */
export function addEffectWithLandingCommand(
  doc: ProjectDocument,
  trackId: string,
  type: EffectType,
  landing: Record<string, number>,
  insertAt?: number,
): Command & { readonly effectId: string } {
  const add = addEffect(doc, trackId, type, insertAt);
  let next = add.execute(doc);
  const def = EFFECT_META[type];
  for (const [paramId, value] of Object.entries(landing)) {
    const param = def.params.find((pd) => pd.id === paramId);
    if (!param) continue;
    const clamped = Math.max(param.min, Math.min(param.max, value));
    next = setEffectParam(next, trackId, add.effectId, paramId, clamped).execute(next);
  }
  return {
    type: "addEffect",
    label: `${add.label} (tuned)`,
    effectId: add.effectId,
    execute: () => next,
    undo: () => doc,
    // No applyToYDoc fast path: without it YDocStore falls back to the
    // generic whole-document diff, which is correct for add+fold.
  };
}

/** Replace the step pattern of a step-sequenced effect (stepGate) — one undo step per edit stroke. */
/**
 * Exact Intents (KYX_PRODUCTION_INTENT_ENGINE_MASTER.md §4.1): compile a
 * parsed exact plan — tempo / key / mute / solo / pan / gain dB / transpose /
 * pattern length — into ONE undoable command group by folding the existing
 * canonical commands (setBpm, setProjectKey, setTrackParams,
 * setPatternLength) over a working document and snapshotting the result.
 */
