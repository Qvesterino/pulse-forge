/**
 * Drum-track content going in and out: steal a groove into a pattern, capture and apply a
 * kit, and capture / install a pack sketch.
 *
 * These are three import formats, not one operation, and they share a reason for being
 * together: each one is a boundary between a portable description of drum material and the
 * project document, so each has to decide what happens to markers, patterns and arrangement
 * clips on the way through.
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

/* ---------------- drum content ---------------- */
/**
 * "Steal the groove": bake an extracted loop-groove map into a pattern.
 * Every ACTIVE step gets the loop's microtiming shift; with `applyVelocity`
 * the step velocity is also scaled by the loop's accent (steps the loop was
 * silent on keep their original velocity). Locks, probability and ratchets
 * are preserved — only timing/velocity fields are touched.
 */
export function stealGrooveIntoPattern(
  doc: ProjectDocument,
  patternId: string,
  map: { timing: number[]; accent: number[] },
  options: { applyVelocity?: boolean } = {},
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  if (!map.timing.length || !map.accent.length || map.timing.length !== map.accent.length) {
    throw new Error("Invalid groove map");
  }
  const steps = pattern.stepCount;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const timingAt = (step: number) => map.timing[((step % map.timing.length) + map.timing.length) % map.timing.length];
  const accentAt = (step: number) => map.accent[((step % map.accent.length) + map.accent.length) % map.accent.length];

  const rows: Pattern["rows"] = {};
  const stepMeta: Pattern["stepMeta"] = {};
  let touched = 0;
  for (const pad of doc.tracks.filter((t): t is DrumTrack => t.kind === "drum").flatMap((t) => t.pads)) {
    const row = pattern.rows[pad.id];
    if (!row) continue;
    const nextRow = [...row];
    const padMeta = pattern.stepMeta?.[pad.id];
    let padTouched = false;
    for (let step = 0; step < steps; step++) {
      if ((row[step] ?? 0) <= 0) continue;
      const timing = Math.max(-1, Math.min(1, timingAt(step)));
      const accent = accentAt(step);
      const meta = padMeta?.[step] ?? {};
      stepMeta[pad.id] = { ...(stepMeta[pad.id] ?? {}), [step]: { ...meta, microtiming: timing } };
      if (options.applyVelocity && accent > 0) {
        nextRow[step] = clamp01((row[step] ?? 0) * (0.4 + 0.6 * accent));
      }
      padTouched = true;
      touched += 1;
    }
    if (padTouched) rows[pad.id] = nextRow;
  }
  if (touched === 0) throw new Error("Pattern has no active steps to groove");

  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === patternId ? { ...p, rows: { ...p.rows, ...rows }, stepMeta: { ...p.stepMeta, ...stepMeta } } : p,
    ),
  };
  return snapshot("stealGrooveIntoPattern", `Steal groove → ${touched} steps`, doc, next);
}

// ── User kits — pad mappings as first-class, shareable objects ─────────────

export interface KitPadCapture {
  idx: number;
  assetId: string | null;
  synth?: DrumTrack["pads"][number]["synth"] | null;
  gain?: number;
  pan?: number;
  chokeGroup?: number | null;
  pitch?: number;
}

/** Read a drum track's pad mapping into a portable kit object. */
export function captureKitFromTrack(doc: ProjectDocument, trackId: string): KitPadCapture[] {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum" && t.id === trackId);
  if (!track) throw new Error(`Drum track ${trackId} not found`);
  return track.pads.map((pad, idx) => ({
    idx,
    assetId: pad.assetId ?? null,
    synth: pad.synth ?? null,
    gain: pad.gain,
    pan: pad.pan,
    chokeGroup: pad.chokeGroup ?? null,
    pitch: pad.pitch ?? 0,
  }));
}

/**
 * Apply a kit's pad mapping onto a drum track (one undo entry). Pads with
 * `assetId: null` in the kit keep their current sample; everything else
 * (sample, synth, gain, pan, choke, pitch) is replaced.
 */
export function applyKitToDrumTrack(
  doc: ProjectDocument,
  trackId: string,
  kitName: string,
  pads: KitPadCapture[],
): Command {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum" && t.id === trackId);
  if (!track) throw new Error(`Drum track ${trackId} not found`);
  const byIdx = new Map(pads.map((p) => [p.idx, p]));
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.id !== trackId || t.kind !== "drum") return t;
      const drum = t as DrumTrack;
      return {
        ...drum,
        pads: drum.pads.map((pad, idx) => {
          const k = byIdx.get(idx);
          if (!k || k.assetId === null) return pad;
          return {
            ...pad,
            assetId: k.assetId,
            synth: k.synth ?? null,
            gain: k.gain ?? pad.gain,
            pan: k.pan ?? pad.pan,
            chokeGroup: k.chokeGroup ?? pad.chokeGroup,
            pitch: k.pitch ?? pad.pitch ?? 0,
          };
        }),
      };
    }),
  };
  return snapshot("applyKitToDrumTrack", `Apply kit "${kitName}"`, doc, next);
}

// ── Pack sketch — the arrangement half of a PFPACK bundle ──────────────────

const SKETCH_SCENE_LIMIT = 16;
const SKETCH_CLIP_LIMIT = 64;
const SKETCH_VELOCITY_STEPS = 15;

function hexRowOf(row: number[] | undefined, steps: number): string | null {
  if (!row) return null;
  let out = "";
  for (let i = 0; i < steps; i++) {
    const v = Math.round(Math.min(1, Math.max(0, row[i] ?? 0)) * SKETCH_VELOCITY_STEPS);
    out += v.toString(16);
  }
  return /[^0]/.test(out) ? out : null;
}

/**
 * Capture the arrangement side of the current project as a portable sketch:
 * scenes become drum rows keyed by the kit track's PAD INDEX (so the sketch
 * replays through any installed kit), plus the timeline clip layout and bpm.
 */
export function captureSketchFromDoc(doc: ProjectDocument, trackId: string): SharedPackSketch | undefined {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum" && t.id === trackId);
  if (!track) throw new Error(`Drum track ${trackId} not found`);
  const scenes = doc.scenes.slice(0, SKETCH_SCENE_LIMIT);
  if (scenes.length === 0) return undefined;
  const padIds = track.pads.map((p) => p.id);
  const sketchScenes: SharedPackSceneSketch[] = [];
  const sceneIndexByScene = new Map<string, number>();
  scenes.forEach((scene) => {
    const pattern = doc.patterns.find((p) => p.id === scene.patternId);
    if (!pattern) return;
    const rows: string[] = [];
    padIds.forEach((padId) => {
      const hex = hexRowOf(pattern.rows[padId], pattern.stepCount);
      if (hex) rows.push(hex);
    });
    if (rows.length === 0) return;
    sceneIndexByScene.set(scene.id, sketchScenes.length);
    sketchScenes.push({
      name: scene.name.slice(0, 40),
      role: scene.role,
      intensity: scene.intensity,
      steps: Math.min(64, Math.max(1, pattern.stepCount)),
      rows,
    });
  });
  if (sketchScenes.length === 0) return undefined;
  const clips: SharedPackSketch["clips"] = [];
  for (const clip of doc.arrangement.clips) {
    const scene = sceneIndexByScene.get(clip.sceneId);
    if (scene === undefined) continue;
    clips.push({ scene, startBar: clip.startBar, lengthBars: clip.lengthBars });
    if (clips.length >= SKETCH_CLIP_LIMIT) break;
  }
  return { bpm: doc.bpm, scenes: sketchScenes, clips };
}

const SKETCH_ROLE_SET = new Set<string>(["intro", "build", "drop", "break", "outro", "fill", "custom"]);

/**
 * Install a pack sketch against a drum track: creates one pattern per scene
 * (rows mapped pad-index → this track's pads), matching scenes and the
 * arrangement clips — all in ONE command so undo removes the whole import.
 */
export function installPackSketch(doc: ProjectDocument, trackId: string, sketch: SharedPackSketch): Command | null {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum" && t.id === trackId);
  if (!track) return null;
  if (!sketch.scenes.length) return null;
  const drumPadIds = doc.tracks
    .filter((t): t is DrumTrack => t.kind === "drum")
    .flatMap((t) => t.pads.map((p) => p.id));
  const emptyRow = (steps: number) => new Array<number>(steps).fill(0);

  const patterns: Pattern[] = [];
  const scenes: Scene[] = [];
  const sceneIdByIndex: string[] = [];
  const stamp = Date.now().toString(36);
  sketch.scenes.forEach((sc, index) => {
    const steps = Math.min(64, Math.max(1, Math.round(sc.steps)));
    const patternId = uid(`psk-${stamp}`);
    const rows: Pattern["rows"] = {};
    for (const padId of drumPadIds) rows[padId] = emptyRow(steps);
    sc.rows.forEach((hex, padIdx) => {
      const pad = track.pads[padIdx];
      if (!pad) return;
      const row = rows[pad.id];
      for (let step = 0; step < Math.min(steps, hex.length); step++) {
        const v = parseInt(hex[step], 16);
        if (v > 0) row[step] = Math.min(1, v / SKETCH_VELOCITY_STEPS);
      }
    });
    patterns.push({
      id: patternId,
      name: sc.name || `Sketch ${index + 1}`,
      stepCount: steps,
      rows,
      notes: {},
    });
    const sceneId = uid(`ssk-${stamp}`);
    sceneIdByIndex.push(sceneId);
    scenes.push({
      id: sceneId,
      name: sc.name || `Sketch ${index + 1}`,
      patternId,
      intensity: typeof sc.intensity === "number" ? Math.min(1, Math.max(0, sc.intensity)) : 0.7,
      role: sc.role && SKETCH_ROLE_SET.has(sc.role) ? (sc.role as SceneRole) : undefined,
    });
  });
  if (patterns.length === 0) return null;

  const endBar = doc.arrangement.clips.reduce((max, c) => Math.max(max, c.startBar + c.lengthBars), 0);
  const clips: ArrangementClip[] = [];
  for (const c of sketch.clips) {
    const sceneId = sceneIdByIndex[c.scene];
    if (!sceneId) continue;
    clips.push({
      id: uid(`csk-${stamp}`),
      sceneId,
      startBar: endBar + c.startBar,
      lengthBars: c.lengthBars,
    });
  }

  const next: ProjectDocument = {
    ...doc,
    bpm: typeof sketch.bpm === "number" ? Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(sketch.bpm))) : doc.bpm,
    patterns: [...doc.patterns, ...patterns],
    scenes: [...doc.scenes, ...scenes],
    arrangement: clips.length ? { ...doc.arrangement, clips: [...doc.arrangement.clips, ...clips] } : doc.arrangement,
  };
  return snapshot("installPackSketch", `Install sketch (${patterns.length} scenes)`, doc, next);
}
