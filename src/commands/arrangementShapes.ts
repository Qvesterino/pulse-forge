/**
 * Arrangement transitions and generated shapes: crossfades between neighbouring clips, the
 * scene skeleton a song is laid out from, and capture of a running arrangement.
 *
 * autoArrangeSong and arrangementSkeletonPreview share the skeleton builder, and they sit in
 * one module on purpose: a preview that lays the song out differently from the real thing is
 * worse than no preview.
 */
import type { Command } from "./types";
import type {
  ArrangementClip,
  ArrangementTransition,
  ArrangementTransitionType,
  AudioClip,
  DrumPad,
  DrumTrack,
  GrooveSettings,
  Marker,
  NoteEvent,
  Pattern,
  PatternAssist,
  ProjectDocument,
  Scene,
  SceneRole,
  StepMeta,
} from "../project-model/types";
import { BAR_TICKS, PPQ, STEP_TICKS } from "../project-model/types";
import { arrangementSecondsBetweenTicks, tempoAtTick } from "../project-model/scene-time";
import { buildStemProject } from "../rendering/stems";
import { withPad } from "../project-model/transform";
import { warpBufferTimeAtTick } from "../project-model/audio-clip-warp";
import { patternPhaseOffsetAtTick, sceneOffsetAtTick } from "../project-model/events";
import {
  clampArrangementTransitionType,
  createGroupTrackModel,
  createPatternForDoc,
  MAX_ARRANGEMENT_CLIP_BARS,
  MAX_BPM,
  MIN_BPM,
  normalizeProject,
  sanitizeArrangementTransitions,
  sceneRoleOf,
} from "../project-model/schema";
import { sanitizeGateSteps, sanitizeManglerSteps } from "../project-model/modulators";
import { clampEffectParam, defaultParamsOf, EFFECT_META, normalizePluginParams } from "../effects/definitions";
import type { EffectPreset } from "../effects/presets";
import { clampFxOutputTrimDb, factoryFxPresetGainDb } from "../effects/presetLoudness";
import { uid } from "../shared/ids";
import type { SharedPackSceneSketch, SharedPackSketch } from "../export/packCode";
import { resolveGrooveForGeneration } from "../ai/generator";
import { generateLocalResultFromOptions } from "../intent/pipeline";
import type { GenerationResult } from "../intent/types";
import type { GenerateOptions } from "../ai/types";
import { buildAssistPatch, normalizeAssistRequest } from "../assist/pipeline";
import type { AssistInput } from "../assist/types";
import { ASSIST_ENGINE_ID, ASSIST_ENGINE_VERSION } from "../assist/types";
import { canonicalizePattern, contentHash } from "../ai/evaluation";
import { snapshot } from "./core";
import { cloneStepMeta, unlinkMarkersOfClips } from "./docOps";

/* ---------------- arrangement shapes ---------------- */
function transitionBetween(doc: ProjectDocument, fromClipId: string, toClipId: string): void {
  const from = doc.arrangement.clips.find((clip) => clip.id === fromClipId);
  const to = doc.arrangement.clips.find((clip) => clip.id === toClipId);
  if (!from || !to) throw new Error("Transition clips not found");
  if (fromClipId === toClipId || from.startBar >= to.startBar || from.startBar + from.lengthBars > to.startBar) {
    throw new Error("Transition clips must be ordered and non-overlapping");
  }
}

export function addArrangementTransition(
  doc: ProjectDocument,
  fromClipId: string,
  toClipId: string,
  type: ArrangementTransitionType = "custom",
  lengthBars = 1,
  cueAssetId?: string,
): Command {
  transitionBetween(doc, fromClipId, toClipId);
  if (
    doc.arrangement.transitions?.some(
      (transition) => transition.fromClipId === fromClipId && transition.toClipId === toClipId,
    )
  ) {
    throw new Error("A transition already exists between these clips");
  }
  const transition: ArrangementTransition = {
    id: uid("transition"),
    fromClipId,
    toClipId,
    type,
    lengthBars: Math.min(4, Math.max(1, Math.round(lengthBars))),
    cueAssetId: cueAssetId?.trim() || undefined,
  };
  const next: ProjectDocument = {
    ...doc,
    arrangement: { ...doc.arrangement, transitions: [...(doc.arrangement.transitions ?? []), transition] },
  };
  return snapshot("addArrangementTransition", "Add arrangement transition", doc, next);
}

export function updateArrangementTransition(
  doc: ProjectDocument,
  transitionId: string,
  changes: Partial<Pick<ArrangementTransition, "type" | "lengthBars" | "cueAssetId">>,
): Command {
  const target = doc.arrangement.transitions?.find((transition) => transition.id === transitionId);
  if (!target) throw new Error(`Transition ${transitionId} not found`);
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      transitions: doc.arrangement.transitions!.map((transition) =>
        transition.id === transitionId
          ? {
              ...transition,
              ...(changes.type ? { type: clampArrangementTransitionType(changes.type) } : {}),
              ...(changes.lengthBars !== undefined
                ? { lengthBars: Math.min(4, Math.max(1, Math.round(changes.lengthBars))) }
                : {}),
              ...(changes.cueAssetId !== undefined ? { cueAssetId: changes.cueAssetId?.trim() || undefined } : {}),
            }
          : transition,
      ),
    },
  };
  return snapshot("updateArrangementTransition", "Edit arrangement transition", doc, next);
}

export function removeArrangementTransition(doc: ProjectDocument, transitionId: string): Command {
  if (!doc.arrangement.transitions?.some((transition) => transition.id === transitionId)) {
    throw new Error(`Transition ${transitionId} not found`);
  }
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      transitions: doc.arrangement.transitions!.filter((transition) => transition.id !== transitionId),
    },
  };
  return snapshot("removeArrangementTransition", "Remove arrangement transition", doc, next);
}

export interface ArrangementSkeletonStep {
  role: Exclude<SceneRole, "fill" | "custom">;
  sceneId: string;
  startBar: number;
  lengthBars: number;
}

const SKELETON_LAYOUT: ReadonlyArray<{ role: ArrangementSkeletonStep["role"]; lengthBars: number }> = [
  { role: "intro", lengthBars: 8 },
  { role: "build", lengthBars: 8 },
  { role: "drop", lengthBars: 16 },
  { role: "break", lengthBars: 8 },
  { role: "outro", lengthBars: 8 },
];

export function arrangementSkeletonPreview(doc: ProjectDocument): ArrangementSkeletonStep[] {
  const used = new Set<string>();
  let startBar = 0;
  const steps: ArrangementSkeletonStep[] = [];
  for (const item of SKELETON_LAYOUT) {
    const scene = doc.scenes.find((candidate) => !used.has(candidate.id) && sceneRoleOf(candidate) === item.role);
    if (!scene) continue;
    used.add(scene.id);
    steps.push({ role: item.role, sceneId: scene.id, startBar, lengthBars: item.lengthBars });
    startBar += item.lengthBars;
  }
  return steps;
}

/**
 * Auto-Arrange: lay ALL scenes into a classic electronic song template —
 * intro → build → drop → break → build → drop → outro — with riser/fill
 * transitions between the key boundaries and drop/buildup cue markers.
 *
 * Scenes are bucketed by role (`sceneRoleOf` infers from names); slots pick
 * from their bucket in order, cycling when a bucket has several scenes
 * (two drops → DROP A / DROP B). Missing roles fall back through a chain so
 * even a 3-scene jam gets a coherent song.
 */
export function autoArrangeSong(doc: ProjectDocument): Command {
  if (doc.scenes.length === 0) throw new Error("No scenes to arrange — create a few first");
  type Bucket = "intro" | "build" | "drop" | "break" | "outro" | "other";
  const buckets = new Map<Bucket, string[]>();
  for (const scene of doc.scenes) {
    const role = sceneRoleOf(scene) ?? "custom";
    // Songwriting roles (A2 v2) fold into their nearest electronic bucket:
    // chorus plays like a drop, verse like a build, bridge like a break.
    const folded = role === "chorus" ? "drop" : role === "verse" ? "build" : role === "bridge" ? "break" : role;
    const bucket: Bucket =
      folded === "intro" || folded === "build" || folded === "drop" || folded === "break" || folded === "outro"
        ? folded
        : "other";
    const list = buckets.get(bucket) ?? [];
    list.push(scene.id);
    buckets.set(bucket, list);
  }
  const cursor = new Map<Bucket, number>();
  const pick = (primary: Bucket, fallbacks: Bucket[]): string | null => {
    for (const bucket of [primary, ...fallbacks]) {
      const list = buckets.get(bucket) ?? [];
      if (list.length === 0) continue;
      const at = cursor.get(bucket) ?? 0;
      cursor.set(bucket, (at + 1) % list.length);
      return list[at];
    }
    return null;
  };

  const TEMPLATE: Array<{
    primary: Bucket;
    fallbacks: Bucket[];
    lengthBars: number;
    marker?: { type: Marker["type"]; name: string };
    transitionIn?: ArrangementTransitionType | null;
  }> = [
    { primary: "intro", fallbacks: ["break", "other", "drop"], lengthBars: 4 },
    {
      primary: "build",
      fallbacks: ["intro", "other", "drop"],
      lengthBars: 4,
      marker: { type: "buildup", name: "BUILD A" },
      transitionIn: null,
    },
    {
      primary: "drop",
      fallbacks: ["other", "build"],
      lengthBars: 8,
      marker: { type: "drop", name: "DROP A" },
      transitionIn: "riser",
    },
    {
      primary: "break",
      fallbacks: ["intro", "other"],
      lengthBars: 4,
      marker: { type: "cue", name: "BREAK" },
      transitionIn: "break",
    },
    {
      primary: "build",
      fallbacks: ["intro", "other", "drop"],
      lengthBars: 4,
      marker: { type: "buildup", name: "BUILD B" },
      transitionIn: "fill",
    },
    {
      primary: "drop",
      fallbacks: ["other", "build"],
      lengthBars: 8,
      marker: { type: "drop", name: "DROP B" },
      transitionIn: "riser",
    },
    { primary: "outro", fallbacks: ["break", "intro", "other"], lengthBars: 4, transitionIn: "break" },
  ];

  let bar = 0;
  const clips: ArrangementClip[] = [];
  const transitions: ArrangementTransition[] = [];
  const markers: Marker[] = [];
  let previousClipId: string | null = null;
  let usedSlots = 0;
  for (const slot of TEMPLATE) {
    const sceneId = pick(slot.primary, slot.fallbacks);
    if (!sceneId) continue;
    usedSlots += 1;
    const clip: ArrangementClip = { id: uid("clip"), sceneId, startBar: bar, lengthBars: slot.lengthBars };
    clips.push(clip);
    if (previousClipId && slot.transitionIn) {
      transitions.push({
        id: uid("transition"),
        fromClipId: previousClipId,
        toClipId: clip.id,
        type: slot.transitionIn,
        lengthBars: 1,
      });
    }
    if (slot.marker) {
      markers.push({
        id: uid("marker"),
        name: slot.marker.name,
        type: slot.marker.type,
        tick: bar * BAR_TICKS,
        linkedClipId: clip.id,
      });
    }
    previousClipId = clip.id;
    bar += slot.lengthBars;
  }
  if (usedSlots === 0) throw new Error("No scenes could be placed — create a few scenes first");

  const next: ProjectDocument = {
    ...doc,
    arrangement: { ...doc.arrangement, clips, transitions },
    markers: markers,
  };
  return snapshot("autoArrangeSong", `Auto-arrange song (intro→build→drop→break→drop→outro)`, doc, next);
}

export function createArrangementSkeleton(doc: ProjectDocument): Command {
  const steps = arrangementSkeletonPreview(doc);
  if (steps.length === 0) throw new Error("No INTRO, BUILD, DROP, BREAK or OUTRO scenes found");
  const clips = steps.map((step) => ({
    id: uid("clip"),
    sceneId: step.sceneId,
    startBar: step.startBar,
    lengthBars: step.lengthBars,
  }));
  const next: ProjectDocument = { ...doc, arrangement: { ...doc.arrangement, clips, transitions: undefined } };
  return snapshot("createArrangementSkeleton", "Build arrangement skeleton", doc, next);
}

export interface CapturedArrangementClip {
  sceneId: string;
  startBar: number;
  lengthBars: number;
}

export function appendCapturedArrangement(doc: ProjectDocument, captured: CapturedArrangementClip[]): Command {
  if (captured.length === 0) throw new Error("No captured scene launches");
  for (const entry of captured) {
    if (!doc.scenes.some((scene) => scene.id === entry.sceneId)) throw new Error(`Scene ${entry.sceneId} not found`);
  }
  const baseBar = doc.arrangement.clips.reduce((max, clip) => Math.max(max, clip.startBar + clip.lengthBars), 0);
  const clips = captured.map((entry) => ({
    id: uid("clip"),
    sceneId: entry.sceneId,
    startBar: baseBar + Math.max(0, Math.round(entry.startBar)),
    lengthBars: Math.max(1, Math.round(entry.lengthBars)),
  }));
  const allClips = [...doc.arrangement.clips, ...clips].sort((a, b) => a.startBar - b.startBar);
  if (
    allClips.some(
      (clip, index) => index > 0 && clip.startBar < allClips[index - 1].startBar + allClips[index - 1].lengthBars,
    )
  ) {
    throw new Error("Captured arrangement overlaps an existing clip");
  }
  return snapshot("appendCapturedArrangement", `Capture ${clips.length} scene${clips.length === 1 ? "" : "s"}`, doc, {
    ...doc,
    arrangement: { ...doc.arrangement, clips: allClips },
  });
}
