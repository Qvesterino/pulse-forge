/**
 * Pattern CRUD: create, duplicate, rename, reorder, resize, clear and paste.
 *
 * `PatternClipboard` is public and lives here too, so the barrel re-exports this module
 * wholesale and the export surface stays the same.
 */
import type { Command } from "./types";
import type {
  ArrangementClip,
  ArrangementTransition,
  ArrangementTransitionType,
  AudioClip,
  AutomationTarget,
  DrumPad,
  DrumTrack,
  EffectInstance,
  EffectType,
  GrooveSettings,
  IntensityPoint,
  Marker,
  MusicalKey,
  NoteEvent,
  PatternAssist,
  ProjectDocument,
  Scene,
  SceneRole,
  SceneAutomation,
  StepMeta,
  Track,
} from "../project-model/types";
import { STEP_TICKS } from "../project-model/types";
import { arrangementSecondsBetweenTicks, tempoAtTick } from "../project-model/scene-time";
import {
  planProductionActions,
  resolveProductionTargets,
  type ProductionAction,
  type ProductionIntent,
} from "../intent/production";
import { patternPhaseOffsetAtTick, sceneOffsetAtTick } from "../project-model/events";
import {
  createPatternForDoc,
  normalizeProject,
  patternLetter,
  sanitizeArrangementTransitions,
} from "../project-model/schema";
import { sanitizeGateSteps, sanitizeManglerSteps } from "../project-model/modulators";
import type { Pattern } from "../project-model/types";
import { clampEffectParam, defaultParamsOf, EFFECT_META, normalizePluginParams } from "../effects/definitions";
import { clampTargetValue, isAutomationTargetValid, targetParamDef } from "../project-model/targets";
import { CORE_EFFECT_PRESETS, type EffectPreset } from "../effects/presets";
import { clampFxOutputTrimDb, factoryFxChainGainDb, factoryFxPresetGainDb } from "../effects/presetLoudness";
import { uid } from "../shared/ids";
import type { SharedPackSceneSketch, SharedPackSketch } from "../export/packCode";
import { buildAssistPatch, normalizeAssistRequest } from "../assist/pipeline";
import type { ExactIntentPlan, ExactOp, ExactTarget } from "../intent/exact";
import { ASSIST_ENGINE_ID, ASSIST_ENGINE_VERSION, type AssistInput } from "../assist/types";
import { canonicalizePattern, contentHash } from "../ai/evaluation";
import { snapshot } from "./core";
import { cloneStepMeta, markerClampPatch } from "./docOps";

/* ---------------- patterns ---------------- */

export function createPattern(doc: ProjectDocument, name?: string): Command {
  const pattern = createPatternForDoc(doc, name ?? `Pattern ${patternLetter(doc.patterns.length)}`);
  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, pattern],
    activePatternId: pattern.id,
  };
  return snapshot("createPattern", `Add ${pattern.name}`, doc, next);
}

function clonePatternWithFreshNoteIds(source: Pattern, name: string): Pattern {
  return {
    ...source,
    id: uid("pattern"),
    name,
    rows: Object.fromEntries(Object.entries(source.rows).map(([padId, row]) => [padId, [...row]])),
    notes: Object.fromEntries(
      Object.entries(source.notes ?? {}).map(([trackId, notes]) => [
        trackId,
        notes.map((note) => ({ ...note, id: uid("note") })),
      ]),
    ),
    stepMeta: cloneStepMeta(source.stepMeta),
    generation: source.generation ? { ...source.generation, sourcePatternId: source.id } : undefined,
  };
}

export function duplicatePattern(doc: ProjectDocument, patternId: string): Command {
  const source = doc.patterns.find((p) => p.id === patternId);
  if (!source) throw new Error(`Pattern ${patternId} not found`);
  const copy = clonePatternWithFreshNoteIds(source, `${source.name} 2`);
  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, copy],
    activePatternId: copy.id,
  };
  return snapshot("duplicatePattern", `Duplicate ${source.name}`, doc, next);
}

/**
 * Give one scene an independent pattern without creating a second scene.
 * This is the safe escape hatch when several scenes currently share a pattern.
 */
export function duplicatePatternForScene(doc: ProjectDocument, sceneId: string): Command {
  const scene = doc.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  const source = doc.patterns.find((pattern) => pattern.id === scene.patternId);
  if (!source) throw new Error(`Pattern ${scene.patternId} not found`);
  const copy = clonePatternWithFreshNoteIds(source, `${source.name} · ${scene.name}`);
  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, copy],
    scenes: doc.scenes.map((candidate) =>
      candidate.id === sceneId ? { ...candidate, patternId: copy.id } : candidate,
    ),
    activePatternId: copy.id,
  };
  return snapshot("duplicatePatternForScene", `Make ${scene.name} independent`, doc, next);
}

export function deletePattern(doc: ProjectDocument, patternId: string): Command {
  if (doc.patterns.length <= 1) throw new Error("Cannot delete the last pattern");
  const target = doc.patterns.find((p) => p.id === patternId);
  if (!target) throw new Error(`Pattern ${patternId} not found`);
  const remaining = doc.patterns.filter((p) => p.id !== patternId);
  // Scenes bound to the deleted pattern would dangle — launch one and
  // activePatternId points at a nonexistent pattern, crashing the scheduler.
  // Remove them (and any arrangement clips referencing them) with it.
  const removedSceneIds = new Set(doc.scenes.filter((s) => s.patternId === patternId).map((s) => s.id));
  const scenes = removedSceneIds.size > 0 ? doc.scenes.filter((s) => !removedSceneIds.has(s.id)) : doc.scenes;
  const arrangement =
    removedSceneIds.size > 0 && doc.arrangement.clips.some((c) => removedSceneIds.has(c.sceneId))
      ? {
          clips: doc.arrangement.clips.filter((c) => !removedSceneIds.has(c.sceneId)),
          ...(sanitizeArrangementTransitions(
            doc.arrangement.transitions,
            doc.arrangement.clips.filter((c) => !removedSceneIds.has(c.sceneId)),
          ) ?? {}),
        }
      : doc.arrangement;
  // Audit 08 D4: if the cascade emptied the scene list, synthesize a
  // deterministic default scene IN-COMMAND — normalize's backfill mints a
  // fresh-uid "Scene A" outside the delta, resurrecting a phantom scene
  // that undo could never remove.
  const finalScenes =
    scenes.length > 0 ? scenes : [{ id: uid("scene"), name: "Scene A", patternId: remaining[0]!.id, intensity: 0.7 }];
  const next: ProjectDocument = {
    ...doc,
    patterns: remaining,
    scenes: finalScenes,
    // Audit 08 D2: the removed scenes' automation lanes go WITH them —
    // leaving them for normalize meant undo restored the scenes but the
    // lanes were gone (same class as deleteTrack).
    ...(doc.sceneAutomation
      ? { sceneAutomation: doc.sceneAutomation.filter((l) => !removedSceneIds.has(l.sceneId)) }
      : {}),
    // Audit 08 D3: clamp markers to the shrunken project end IN-COMMAND so
    // undo restores their ticks (normalize clamps them outside any delta).
    ...markerClampPatch(doc.markers, finalScenes, remaining, arrangement),
    arrangement,
    activePatternId: doc.activePatternId === patternId ? remaining[0].id : doc.activePatternId,
  };
  return snapshot("deletePattern", `Delete ${target.name}`, doc, next);
}

export function reorderPattern(doc: ProjectDocument, fromIndex: number, toIndex: number): Command {
  if (fromIndex < 0 || fromIndex >= doc.patterns.length) throw new Error("fromIndex out of range");
  if (toIndex < 0 || toIndex >= doc.patterns.length) throw new Error("toIndex out of range");
  if (fromIndex === toIndex) {
    return { type: "reorderPattern", label: "Reorder pattern", execute: (d) => d, undo: (d) => d };
  }
  const patterns = [...doc.patterns];
  const [moved] = patterns.splice(fromIndex, 1);
  patterns.splice(toIndex, 0, moved);
  return snapshot("reorderPattern", `Reorder ${moved.name}`, doc, { ...doc, patterns });
}

export function renamePattern(_doc: ProjectDocument, patternId: string, name: string): Command {
  const prev = _doc.patterns.find((p) => p.id === patternId)?.name ?? "";
  return {
    type: "renamePattern",
    label: `Rename pattern to "${name}"`,
    execute: (d) => ({ ...d, patterns: d.patterns.map((p) => (p.id === patternId ? { ...p, name } : p)) }),
    undo: (d) => ({ ...d, patterns: d.patterns.map((p) => (p.id === patternId ? { ...p, name: prev } : p)) }),
    applyToYDoc: (yMap) => {
      const patterns = yMap.get("patterns") as any;
      for (let i = 0; i < patterns.length; i++) {
        if (patterns.get(i).get("id") === patternId) {
          patterns.get(i).set("name", name);
          break;
        }
      }
    },
  };
}

export function setActivePattern(doc: ProjectDocument, patternId: string): Command {
  const prev = doc.activePatternId;
  return {
    type: "setActivePattern",
    label: `Select pattern ${doc.patterns.find((p) => p.id === patternId)?.name ?? patternId}`,
    // Validate at apply time, not factory time: a quantized launch or a
    // scene chip can race a pattern deletion — activating a nonexistent
    // pattern would crash the scheduler loop with every tick.
    execute: (d) => (d.patterns.some((p) => p.id === patternId) ? { ...d, activePatternId: patternId } : d),
    undo: (d) =>
      d.patterns.some((p) => p.id === prev)
        ? { ...d, activePatternId: prev }
        : d.patterns.length > 0
          ? { ...d, activePatternId: d.patterns[0].id }
          : d,
    applyToYDoc: (yMap) => {
      yMap.set("activePatternId", patternId);
    },
  };
}

export function setPatternLength(doc: ProjectDocument, patternId: string, stepCount: number): Command {
  const target = doc.patterns.find((p) => p.id === patternId);
  if (!target) throw new Error(`Pattern ${patternId} not found`);
  // Math.max(1, Math.floor(NaN)) is NaN — the row rebuild would throw on
  // `new Array(NaN)`. Reject explicitly instead of crashing at dispatch.
  if (!Number.isFinite(stepCount)) throw new Error(`Pattern length must be a finite number`);
  // Same hard ceiling normalize enforces on load (Audit 08 D6).
  const safeCount = Math.min(128, Math.max(1, Math.floor(stepCount)));
  const patternTicks = safeCount * STEP_TICKS;
  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === patternId
        ? {
            ...p,
            stepCount: safeCount,
            rows: Object.fromEntries(
              Object.entries(p.rows).map(([padId, row]) => [
                padId,
                new Array<number>(safeCount).fill(0).map((_, i) => row[i] ?? 0),
              ]),
            ),
            notes: Object.fromEntries(
              Object.entries(p.notes ?? {}).map(([trackId, notes]) => [
                trackId,
                notes.flatMap((n) => {
                  // Shrinking floors, not cliffs (FL keeps long pads): a note
                  // crossing the new end is clamped to fit (min 1 tick, so the
                  // normalize invariant holds); only notes starting at/after
                  // the new end are dropped.
                  if (n.start >= patternTicks) return [];
                  if (n.duration <= patternTicks - n.start) return [n];
                  return [{ ...n, duration: Math.max(1, patternTicks - n.start) }];
                }),
              ]),
            ),
            // Prune meta beyond the new length — otherwise shrink→grow
            // resurrects stale probability/ratchet/p-locks on zeroed steps.
            stepMeta: Object.fromEntries(
              Object.entries(p.stepMeta ?? {}).map(([padId, steps]) => [
                padId,
                Object.fromEntries(Object.entries(steps).filter(([stepKey]) => Number(stepKey) < safeCount)),
              ]),
            ),
          }
        : p,
    ),
  };
  return snapshot("setPatternLength", `Set pattern length to ${safeCount}`, doc, next);
}

export function clearPattern(doc: ProjectDocument, patternId: string): Command {
  const target = doc.patterns.find((p) => p.id === patternId);
  if (!target) throw new Error(`Pattern ${patternId} not found`);
  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const { stepMeta: _stepMeta, ...patternWithoutStepMeta } = p;
      return {
        ...patternWithoutStepMeta,
        rows: Object.fromEntries(
          Object.entries(p.rows).map(([padId, row]) => [padId, new Array<number>(row.length).fill(0)]),
        ),
        notes: {},
        // Clear performance meta with the content: stale p-locks /
        // probability would otherwise resurrect on re-drawn steps (the
        // exact bug setPatternLength's comment warns about).
      };
    }),
  };
  return snapshot("clearPattern", `Clear ${target.name}`, doc, next);
}

export interface PatternClipboard {
  stepCount: number;
  rows: Record<string, number[]>;
  notes: Record<string, NoteEvent[]>;
  /** Performance meta (p-locks/probability/ratchet) — carried since the
      editing-timeline audit; pasting used to drop it silently while stale
      TARGET meta kept binding to pasted content at the same indexes. */
  stepMeta?: Pattern["stepMeta"];
}

export function pastePattern(doc: ProjectDocument, clip: PatternClipboard): Command {
  const target = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!target) throw new Error("No active pattern");
  const rows = Object.fromEntries(Object.entries(clip.rows).map(([padId, row]) => [padId, [...row]]));
  const notes = Object.fromEntries(
    Object.entries(clip.notes).map(([trackId, noteList]) => [
      trackId,
      // Fresh ids per paste — carrying the source's ids duplicated them
      // across patterns (PianoRoll's own clipboard regenerates too).
      noteList.map((n) => ({ ...n, id: uid("note") })),
    ]),
  );
  const pasted: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === target.id
        ? {
            ...p,
            stepCount: clip.stepCount,
            rows,
            notes,
            // Replace (not merge) — stale target meta would bind old
            // p-locks to the pasted content at the same indexes.
            stepMeta: clip.stepMeta ? structuredClone(clip.stepMeta) : undefined,
          }
        : p,
    ),
  };
  return snapshot("pastePattern", `Paste into ${target.name}`, doc, normalizeProject(pasted));
}
