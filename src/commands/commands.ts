import type { Command } from "./types";
import type {
  ArrangementClip,
  ArrangementTransition,
  ArrangementTransitionType,
  AudioClip,
  AutomationLane,
  AutomationTarget,
  DrumPad,
  DrumTrack,
  EffectInstance,
  EffectType,
  GrooveSettings,
  InstrumentKind,
  InstrumentTrack,
  IntensityPoint,
  Lfo,
  LfoKind,
  Macro,
  MasterConfig,
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
import { BAR_TICKS, PPQ, STEP_TICKS } from "../project-model/types";
import { buildStemProject } from "../rendering/stems";
import { DEFAULT_GATE_PATTERN, DEFAULT_STEP_PATTERN, sanitizeGateSteps } from "../project-model/modulators";
import { setStepVelocity, withPad, withTrack } from "../project-model/transform";
import { insertPointSorted } from "../project-model/automation";
import {
  clampUnit,
  createDrumTrackModel,
  createGroupTrackModel,
  createInstrumentTrackModel,
  createPatternForDoc,
  drumTracksOf,
  instrumentTracksOf,
  normalizeProject,
  patternLetter,
  sceneRoleOf,
  clampArrangementTransitionType,
  sanitizeArrangementTransitions,
  sanitizeColor,
} from "../project-model/schema";
import type { Pattern } from "../project-model/types";
import { EFFECT_DEFS, clampEffectParam, defaultParamsOf } from "../effects/registry";
import { INSTRUMENT_DEFS, clampInstrumentParam, defaultInstrumentParams } from "../instruments/registry";
import type { InstrumentPreset } from "../presets/types";
import type { EffectPreset } from "../effects/presets";
import { clamp, uid } from "../shared/ids";
import { applyDocDelta, computeDocDelta, deepEqualRef, deepFreeze } from "./docDelta";
import { hashString, mulberry32 } from "../shared/rng";
import { snapToScale } from "../project-model/scales";
import { resolveGrooveForGeneration } from "../ai/generator";
import { generateLocalResultFromOptions } from "../intent/pipeline";
import type { GenerateOptions } from "../ai/types";
import { buildAssistPatch, normalizeAssistRequest } from "../assist/pipeline";
import { ASSIST_ENGINE_ID, ASSIST_ENGINE_VERSION, type AssistInput } from "../assist/types";
import { canonicalizePattern, contentHash } from "../ai/evaluation";
import {
  applyScaleOption,
  arpeggiateNotes,
  basslineNotes,
  clusterNotes,
  createChordNotes,
  doubleNotes,
  euclideanNotes,
  gateNotes,
  halveNotes,
  humanizeNotes,
  invertNotes,
  mirrorNotes,
  repeatNotes,
  retrogradeNotes,
  randomizeVelocity,
  reverseNotes,
  snapNotesToScale,
  stampChordNotes,
  strumNotes,
} from "../midi/creative";
import type { MidiCreativeOperation } from "../midi/creative";

// Immutability enforcement for the delta undo engine. In DEV/test, snapshot()
// deep-freezes `prev`: any command factory (or later code holding the
// reference) that mutates the previous document in place throws a loud
// TypeError immediately, instead of silently corrupting the undo stack.
// In production builds the check is dead-code-eliminated (NODE_ENV=production).
const IS_DEV = process.env.NODE_ENV !== "production";

let snapshotVerificationFallbacks = 0;
/** TEST-ONLY: how many snapshot() calls failed delta self-verification and fell back to the legacy whole-document command. */
export function __snapshotVerificationFallbacks(): number {
  return snapshotVerificationFallbacks;
}
/** TEST-ONLY: reset the fallback counter (call at the start of a battery). */
export function __resetSnapshotVerificationFallbacks(): void {
  snapshotVerificationFallbacks = 0;
}

export function snapshot(type: string, label: string, prev: ProjectDocument, next: ProjectDocument): Command {
  // Inverse-patch command: capture the CHANGE (id-anchored operations), not
  // the documents. Functional execute/undo apply the delta to whatever
  // document is current — an async dispatch (seconds-long freeze render,
  // collab merge) can no longer silently revert concurrent edits, and the
  // undo stack no longer pins whole document chains.
  if (IS_DEV) deepFreeze(prev);
  const forward = computeDocDelta(prev, next);
  const backward = computeDocDelta(next, prev);
  // Self-verification: the delta must round-trip exactly, or we keep the
  // legacy whole-document command. Costs ~O(changes) thanks to structural
  // sharing — the reference-pruned walk skips untouched subtrees.
  const verified =
    deepEqualRef(applyDocDelta(prev, forward.ops), next) && deepEqualRef(applyDocDelta(next, backward.ops), prev);
  if (!verified) {
    snapshotVerificationFallbacks++;
    return { type, label, execute: () => next, undo: () => prev };
  }
  return {
    type,
    label,
    execute: (d) => applyDocDelta(d, forward.ops),
    undo: (d) => applyDocDelta(d, backward.ops),
  };
}

export function setProjectName(doc: ProjectDocument, name: string): Command {
  const prev = doc.name;
  return {
    type: "setProjectName",
    label: `Rename project to "${name}"`,
    execute: (d) => ({ ...d, name }),
    undo: (d) => ({ ...d, name: prev }),
    applyToYDoc: (yMap) => {
      yMap.set("name", name);
    },
  };
}

export function setBpm(doc: ProjectDocument, bpm: number): Command {
  const prev = doc.bpm;
  const value = clamp(bpm, 20, 300);
  return {
    type: "setBpm",
    label: `Set BPM to ${value}`,
    execute: (d) => ({ ...d, bpm: value }),
    undo: (d) => ({ ...d, bpm: prev }),
    applyToYDoc: (yMap) => {
      yMap.set("bpm", value);
    },
  };
}

export function toggleStep(doc: ProjectDocument, padId: string, stepIndex: number, defaultVelocity = 0.8): Command {
  const prev = doc.patterns.find((p) => p.id === doc.activePatternId)?.rows[padId]?.[stepIndex] ?? 0;
  const next = prev > 0 ? 0 : defaultVelocity;
  const patternId = doc.activePatternId;
  return {
    type: "toggleStep",
    label: prev > 0 ? `Remove step ${stepIndex + 1}` : `Add step ${stepIndex + 1}`,
    execute: (d) => setStepVelocity(d, padId, stepIndex, next),
    undo: (d) => setStepVelocity(d, padId, stepIndex, prev),
    applyToYDoc: (yMap) => {
      const { yToggleStep } = require("./yDocHelpers");
      yToggleStep(yMap, patternId, padId, stepIndex);
    },
  };
}

export function setStepVelocityCommand(
  doc: ProjectDocument,
  padId: string,
  stepIndex: number,
  velocity: number,
): Command {
  const prev = doc.patterns.find((p) => p.id === doc.activePatternId)?.rows[padId]?.[stepIndex] ?? 0;
  const patternId = doc.activePatternId;
  return {
    type: "setStepVelocity",
    label: `Set step ${stepIndex + 1} velocity`,
    execute: (d) => setStepVelocity(d, padId, stepIndex, velocity),
    undo: (d) => setStepVelocity(d, padId, stepIndex, prev),
    applyToYDoc: (yMap) => {
      const { ySetStepVelocity } = require("./yDocHelpers");
      ySetStepVelocity(yMap, patternId, padId, stepIndex, velocity);
    },
  };
}

type PadParams = Partial<
  Pick<
    DrumPad,
    | "name"
    | "assetId"
    | "gain"
    | "pan"
    | "pitch"
    | "mute"
    | "solo"
    | "chokeGroup"
    | "sliceStart"
    | "sliceEnd"
    | "sliceFadeIn"
    | "sliceFadeOut"
    | "sliceReverse"
  >
>;

export interface PadSlice {
  start: number;
  end: number;
  fadeIn?: number;
  fadeOut?: number;
  reverse?: boolean;
}

/**
 * Chop a sample onto the drum track's pads (chop-beats). Each slice becomes
 * one pad referencing the source asset with a [start, end) region — no
 * buffer copies, reload-safe, and undoable as one gesture.
 */
export function sliceToPads(
  doc: ProjectDocument,
  trackId: string,
  assetId: string,
  slices: PadSlice[],
  sourceName = "Chop",
): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track || track.kind !== "drum") throw new Error(`Drum track ${trackId} not found`);
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.id !== trackId || t.kind !== "drum") return t;
      return {
        ...t,
        pads: t.pads.map((pad, index) => {
          const slice = slices[index];
          if (!slice) return pad;
          return {
            ...pad,
            assetId,
            sliceStart: slice.start,
            sliceEnd: slice.end,
            sliceFadeIn: slice.fadeIn ?? 0,
            sliceFadeOut: slice.fadeOut ?? 0,
            sliceReverse: slice.reverse ?? false,
            name: `${sourceName} ${String(index + 1).padStart(2, "0")}`,
          };
        }),
      };
    }),
  };
  return snapshot("sliceToPads", `Chop ${slices.length} slices to pads`, doc, next);
}

export function setPadParams(doc: ProjectDocument, padId: string, params: PadParams): Command {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum");
  const current = track?.pads.find((p) => p.id === padId);
  const prev = { ...current } as PadParams;
  const apply = (d: ProjectDocument, values: PadParams): ProjectDocument =>
    withPad(d, padId, (pad) => {
      const next = { ...pad, ...values };
      // Assigning a different source must not leave the old source's region
      // attached to the new asset.
      if (values.assetId !== undefined && values.assetId !== pad.assetId) {
        delete next.sliceStart;
        delete next.sliceEnd;
        delete next.sliceFadeIn;
        delete next.sliceFadeOut;
        delete next.sliceReverse;
      }
      return next;
    });
  return {
    type: "setPadParams",
    label: `Edit pad ${padId}`,
    execute: (d) => apply(d, params),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i);
        if (t.get("kind") === "drum") {
          const pads = t.get("pads") as any;
          for (let j = 0; j < pads.length; j++) {
            if (pads.get(j).get("id") === padId) {
              const target = pads.get(j);
              const sourceChanged = params.assetId !== undefined && params.assetId !== target.get("assetId");
              for (const [k, v] of Object.entries(params)) {
                if (v !== undefined) target.set(k, v);
              }
              if (sourceChanged) {
                for (const key of ["sliceStart", "sliceEnd", "sliceFadeIn", "sliceFadeOut", "sliceReverse"])
                  target.delete(key);
              }
              break;
            }
          }
          break;
        }
      }
    },
  };
}

export function setPadSynth(
  doc: ProjectDocument,
  padId: string,
  synth: import("../project-model/types").DrumSynthConfig | null,
): Command {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum");
  const current = track?.pads.find((p) => p.id === padId);
  const prevSynth = (current as any)?.synth ?? null;
  const prevAssetId = current?.assetId ?? null;
  const nextDoc: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.kind !== "drum") return t;
      return {
        ...t,
        pads: t.pads.map((p) => {
          if (p.id !== padId) return p;
          const next: any = { ...p, synth: synth ? { ...synth } : null };
          // When switching to synth, clear sample to avoid confusion
          if (synth) {
            next.assetId = null;
            delete next.sliceStart;
            delete next.sliceEnd;
            delete next.sliceFadeIn;
            delete next.sliceFadeOut;
            delete next.sliceReverse;
          }
          return next;
        }),
      };
    }),
  };
  const prevDoc: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.kind !== "drum") return t;
      return {
        ...t,
        pads: t.pads.map((p) =>
          p.id === padId ? { ...p, synth: prevSynth ? { ...prevSynth } : null, assetId: prevAssetId } : p,
        ),
      };
    }),
  };
  return {
    type: "setPadSynth",
    label: synth ? `Set ${synth.type} synth` : "Clear synth",
    execute: () => nextDoc,
    undo: () => prevDoc,
  };
}

type TrackParams = Partial<Pick<Track, "name" | "gain" | "pan" | "mute" | "solo">>;

export function setTrackParams(doc: ProjectDocument, trackId: string, params: TrackParams): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  const prev: TrackParams = track
    ? { name: track.name, gain: track.gain, pan: track.pan, mute: track.mute, solo: track.solo }
    : {};
  const apply = (d: ProjectDocument, values: TrackParams): ProjectDocument =>
    withTrack(d, trackId, (t) => ({ ...t, ...values }));
  return {
    type: "setTrackParams",
    label: `Edit track ${trackId}`,
    execute: (d) => apply(d, params),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i) as any;
        if (t.get("id") === trackId) {
          for (const [k, v] of Object.entries(params)) {
            if (v !== undefined) t.set(k, v);
          }
          break;
        }
      }
    },
  };
}

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

function cloneStepMeta(meta: Pattern["stepMeta"]): Pattern["stepMeta"] {
  if (!meta) return undefined;
  return Object.fromEntries(
    Object.entries(meta).map(([padId, steps]) => [
      padId,
      Object.fromEntries(
        Object.entries(steps).map(([step, m]) => [step, { ...m, ...(m.locks ? { locks: { ...m.locks } } : {}) }]),
      ),
    ]),
  );
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
  const next: ProjectDocument = {
    ...doc,
    patterns: remaining,
    scenes,
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
  const safeCount = Math.max(1, Math.floor(stepCount));
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
                notes.filter((n) => n.start + n.duration <= patternTicks),
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
    patterns: doc.patterns.map((p) =>
      p.id === patternId
        ? {
            ...p,
            rows: Object.fromEntries(
              Object.entries(p.rows).map(([padId, row]) => [padId, new Array<number>(row.length).fill(0)]),
            ),
            notes: {},
          }
        : p,
    ),
  };
  return snapshot("clearPattern", `Clear ${target.name}`, doc, next);
}

export interface PatternClipboard {
  stepCount: number;
  rows: Record<string, number[]>;
  notes: Record<string, NoteEvent[]>;
}

export function pastePattern(doc: ProjectDocument, clip: PatternClipboard): Command {
  const target = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!target) throw new Error("No active pattern");
  const rows = Object.fromEntries(Object.entries(clip.rows).map(([padId, row]) => [padId, [...row]]));
  const notes = Object.fromEntries(
    Object.entries(clip.notes).map(([trackId, noteList]) => [trackId, noteList.map((n) => ({ ...n }))]),
  );
  const pasted: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) => (p.id === target.id ? { ...p, stepCount: clip.stepCount, rows, notes } : p)),
  };
  return snapshot("pastePattern", `Paste into ${target.name}`, doc, normalizeProject(pasted));
}

/* ---------------- groove & step performance ---------------- */

export function setGroove(doc: ProjectDocument, groove: Partial<GrooveSettings>): Command {
  const prev = doc.groove ?? {};
  const nextGroove: Partial<GrooveSettings> = { ...prev, ...groove };
  const describe = (g: Partial<GrooveSettings>) =>
    `swing ${Math.round((g.swing ?? 0) * 100)}% · humanize ${Math.round((g.humanizeTiming ?? 0) * 100)}/${Math.round((g.humanizeVelocity ?? 0) * 100)}`;
  return {
    type: "setGroove",
    label: `Groove → ${describe(nextGroove)}`,
    execute: (d) => ({ ...d, groove: nextGroove }),
    undo: (d) => ({ ...d, groove: prev }),
    applyToYDoc: (yMap) => {
      let g = yMap.get("groove") as any;
      if (!g) {
        g = new (require("yjs").Map)();
        yMap.set("groove", g);
      }
      for (const [k, v] of Object.entries(nextGroove)) {
        if (v !== undefined) g.set(k, v);
      }
    },
  };
}

/**
 * Merge per-step performance metadata (probability / ratchet / microtiming).
 * Values that land on the defaults (1 / 1 / 0) are pruned so the model stays
 * clean; an entry with nothing left is removed entirely.
 */
export function setStepMeta(
  doc: ProjectDocument,
  patternId: string,
  padId: string,
  stepIndex: number,
  meta: StepMeta,
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const prevEntry = pattern.stepMeta?.[padId]?.[stepIndex];

  const apply = (d: ProjectDocument, entry: StepMeta | undefined): ProjectDocument => ({
    ...d,
    patterns: d.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const padMeta = { ...(p.stepMeta?.[padId] ?? {}) };
      if (entry && Object.keys(entry).length > 0) padMeta[stepIndex] = entry;
      else delete padMeta[stepIndex];
      const stepMeta = { ...(p.stepMeta ?? {}) };
      if (Object.keys(padMeta).length > 0) stepMeta[padId] = padMeta;
      else delete stepMeta[padId];
      return { ...p, stepMeta: Object.keys(stepMeta).length > 0 ? stepMeta : undefined };
    }),
  });

  const hasLocksPatch = Object.prototype.hasOwnProperty.call(meta, "locks");
  const merged: StepMeta = { ...(prevEntry ?? {}) };
  for (const [k, v] of Object.entries(meta)) {
    if (k === "locks") continue;
    (merged as Record<string, unknown>)[k] = v;
  }
  if (hasLocksPatch) {
    const patch = (meta as StepMeta).locks;
    const baseLocks: Record<string, number> = { ...(prevEntry?.locks ?? {}) };
    if (patch === undefined) {
      // explicit locks: undefined → clear all
      (merged as StepMeta).locks = undefined;
    } else {
      for (const [k, v] of Object.entries(patch as Record<string, number | undefined>)) {
        if (v === undefined) delete baseLocks[k];
        else baseLocks[k] = v;
      }
      (merged as StepMeta).locks = Object.keys(baseLocks).length > 0 ? (baseLocks as StepMeta["locks"]) : undefined;
    }
  }
  const cleaned: StepMeta = {};
  if (merged.probability !== undefined && merged.probability < 1) cleaned.probability = clampUnit(merged.probability);
  if (merged.ratchet !== undefined && merged.ratchet > 1)
    cleaned.ratchet = Math.max(1, Math.min(8, Math.round(merged.ratchet)));
  if (merged.microtiming !== undefined && merged.microtiming !== 0)
    cleaned.microtiming = Math.max(-1, Math.min(1, merged.microtiming));
  if (merged.locks !== undefined && Object.keys(merged.locks).length > 0) {
    const cleanedLocks: NonNullable<StepMeta["locks"]> = {};
    const ALLOWED = new Set(["pitch", "gain", "pan", "cutoff", "sampleStart", "length"]);
    const clampMap = {
      pitch: { min: -24, max: 24 },
      gain: { min: 0, max: 2 },
      pan: { min: -1, max: 1 },
      cutoff: { min: 80, max: 16000 },
      sampleStart: { min: 0, max: 1 },
      length: { min: 0.1, max: 2 },
    } as const;
    for (const [k, v] of Object.entries(merged.locks)) {
      if (!ALLOWED.has(k)) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const clamped = Math.min(
        clampMap[k as keyof typeof clampMap].max,
        Math.max(clampMap[k as keyof typeof clampMap].min, v),
      );
      let rounded: number;
      if (k === "pitch") rounded = Math.round(clamped * 10) / 10;
      else if (k === "cutoff") rounded = Math.round(clamped);
      else rounded = Math.round(clamped * 100) / 100;
      cleanedLocks[k as keyof typeof cleanedLocks] = rounded;
    }
    if (Object.keys(cleanedLocks).length > 0) cleaned.locks = cleanedLocks;
  }

  return {
    type: "setStepMeta",
    label: "Edit step performance",
    execute: (d) => apply(d, Object.keys(cleaned).length > 0 ? cleaned : undefined),
    undo: (d) => apply(d, prevEntry),
  };
}

/**
 * Shorthand for p-locks: patch `locks` on one step without touching
 * probability/ratchet/microtiming. `patch` keys with `undefined` delete.
 */
export function setStepLocks(
  doc: ProjectDocument,
  patternId: string,
  padId: string,
  stepIndex: number,
  patch: Partial<Record<import("../project-model/types").StepLockKey, number | undefined>>,
): Command {
  return setStepMeta(doc, patternId, padId, stepIndex, { locks: patch } as StepMeta);
}

/** Bulk apply p-locks to every step in a rectangular selection. */
export function setStepsLocks(
  doc: ProjectDocument,
  patternId: string,
  padIds: string[],
  fromStep: number,
  toStep: number,
  patch: Partial<Record<import("../project-model/types").StepLockKey, number | undefined>>,
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  let nextDoc = doc;
  for (const padId of padIds) {
    for (let step = fromStep; step <= toStep; step++) {
      if (step < 0 || step >= pattern.stepCount) continue;
      nextDoc = setStepLocks(nextDoc, patternId, padId, step, patch).execute(nextDoc);
    }
  }
  const prev = doc;
  const next = nextDoc;
  const label = `Set p-locks for ${padIds.length}×${toStep - fromStep + 1} steps`;
  return {
    type: "setStepsLocks",
    label,
    execute: () => next,
    undo: () => prev,
  };
}

/** Paste locks from a copied source (shallow) onto a selection. */
export function pasteStepLocks(
  doc: ProjectDocument,
  patternId: string,
  padIds: string[],
  fromStep: number,
  toStep: number,
  locks: Partial<Record<import("../project-model/types").StepLockKey, number>>,
): Command {
  if (!locks || Object.keys(locks).length === 0) {
    return { type: "pasteStepLocks", label: "Paste p-locks (empty)", execute: (d) => d, undo: (d) => d };
  }
  return setStepsLocks(
    doc,
    patternId,
    padIds,
    fromStep,
    toStep,
    locks as Partial<Record<import("../project-model/types").StepLockKey, number | undefined>>,
  );
}

export function clearStepLocks(
  doc: ProjectDocument,
  patternId: string,
  padIds: string[],
  fromStep: number,
  toStep: number,
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  let nextDoc = doc;
  for (const padId of padIds) {
    for (let step = fromStep; step <= toStep; step++) {
      const locks = pattern.stepMeta?.[padId]?.[step]?.locks;
      if (!locks) continue;
      const patch: Record<string, undefined> = {};
      for (const k of Object.keys(locks)) patch[k] = undefined;
      nextDoc = setStepLocks(nextDoc, patternId, padId, step, patch as any).execute(nextDoc);
    }
  }
  const prev = doc;
  const finalDoc = nextDoc;
  return {
    type: "clearStepLocks",
    label: `Clear p-locks for ${padIds.length}×${toStep - fromStep + 1} steps`,
    execute: () => finalDoc,
    undo: () => prev,
  };
}

export function clearSteps(
  doc: ProjectDocument,
  patternId: string,
  padIds: string[],
  fromStep: number,
  toStep: number,
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const prevRows: Record<string, number[]> = {};
  for (const padId of padIds) prevRows[padId] = [...(pattern.rows[padId] ?? [])];
  const prevMeta = cloneStepMeta(pattern.stepMeta);

  const apply = (d: ProjectDocument, rows: Record<string, number[]>, meta: Pattern["stepMeta"]): ProjectDocument => ({
    ...d,
    patterns: d.patterns.map((p) =>
      p.id === patternId ? { ...p, rows: { ...p.rows, ...rows }, stepMeta: cloneStepMeta(meta) } : p,
    ),
  });

  const clearedRows: Record<string, number[]> = {};
  for (const padId of padIds) {
    const row = [...(pattern.rows[padId] ?? [])];
    for (let i = fromStep; i <= toStep && i < row.length; i++) row[i] = 0;
    clearedRows[padId] = row;
  }
  const clearedMeta = cloneStepMeta(pattern.stepMeta) ?? {};
  for (const padId of padIds) {
    const padMeta = clearedMeta[padId];
    if (!padMeta) continue;
    for (const key of Object.keys(padMeta)) {
      const idx = Number(key);
      if (idx >= fromStep && idx <= toStep) delete padMeta[idx];
    }
    if (Object.keys(padMeta).length === 0) delete clearedMeta[padId];
  }

  return {
    type: "clearSteps",
    label: `Clear steps ${fromStep + 1}–${toStep + 1}`,
    execute: (d) => apply(d, clearedRows, Object.keys(clearedMeta).length > 0 ? clearedMeta : undefined),
    undo: (d) => apply(d, prevRows, prevMeta),
  };
}

/** Batch-set velocities for a set of steps (multi-select velocity drag). */
export function setStepsVelocity(
  doc: ProjectDocument,
  patternId: string,
  entries: { padId: string; stepIndex: number; velocity: number }[],
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const prev: { padId: string; stepIndex: number; velocity: number }[] = entries.map((e) => ({
    ...e,
    velocity: pattern.rows[e.padId]?.[e.stepIndex] ?? 0,
  }));

  const apply = (
    d: ProjectDocument,
    list: { padId: string; stepIndex: number; velocity: number }[],
  ): ProjectDocument => ({
    ...d,
    patterns: d.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const rows = { ...p.rows };
      for (const entry of list) {
        const row = [...(rows[entry.padId] ?? [])];
        if (entry.stepIndex < row.length) row[entry.stepIndex] = entry.velocity;
        rows[entry.padId] = row;
      }
      return { ...p, rows };
    }),
  });

  return {
    type: "setStepsVelocity",
    label: `Set velocity for ${entries.length} steps`,
    execute: (d) => apply(d, entries),
    undo: (d) => apply(d, prev),
  };
}

/**
 * Mutate the active pattern into a variation: seeded velocity jitter, sparse
 * ghost notes next to existing hits, occasional dropped weak hits and a touch
 * of microtiming. One undo step returns the original.
 */
export function mutatePattern(doc: ProjectDocument, patternId: string): Command {
  const source = doc.patterns.find((p) => p.id === patternId);
  if (!source) throw new Error(`Pattern ${patternId} not found`);
  const rand = mulberry32(hashString(`${source.id}|${uid("mut")}`));

  const rows: Record<string, number[]> = {};
  const meta: NonNullable<Pattern["stepMeta"]> = cloneStepMeta(source.stepMeta) ?? {};
  for (const [padId, row] of Object.entries(source.rows)) {
    const next = [...row];
    for (let i = 0; i < next.length; i++) {
      const velocity = next[i];
      if (velocity > 0) {
        if (velocity < 0.5 && rand() < 0.12) {
          next[i] = 0;
          continue;
        }
        next[i] = Math.min(1, Math.max(0.1, velocity + (rand() - 0.5) * 0.35));
        if (rand() < 0.25) {
          const padMeta = meta[padId] ?? (meta[padId] = {});
          const jitter = (rand() - 0.5) * 0.6;
          if (Math.abs(jitter) > 0.05) padMeta[i] = { ...padMeta[i], microtiming: jitter };
        }
      } else {
        const neighbor = row[i - 1] > 0 || row[i + 1] > 0;
        if (neighbor && i % 2 === 1 && rand() < 0.08) {
          next[i] = 0.22 + rand() * 0.15;
        }
      }
    }
    rows[padId] = next;
  }

  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === patternId ? { ...p, rows, stepMeta: Object.keys(meta).length > 0 ? meta : undefined } : p,
    ),
  };
  return snapshot("mutatePattern", `Mutate ${source.name}`, doc, next);
}

/**
 * Duplicate the pattern as an explicit fill: a snare roll with rising velocity
 * over the last beat, capped by a ratcheted final hit. The fill becomes active.
 */
export function createFill(doc: ProjectDocument, patternId: string): Command {
  const source = doc.patterns.find((p) => p.id === patternId);
  if (!source) throw new Error(`Pattern ${patternId} not found`);
  const drumTrack = drumTracksOf(doc)[0];
  if (!drumTrack) throw new Error("No drum track for fill");
  const snarePad = drumTrack.pads.find((p) => /snare/i.test(p.name)) ?? drumTrack.pads[4] ?? drumTrack.pads[0];

  const rows = Object.fromEntries(Object.entries(source.rows).map(([padId, row]) => [padId, [...row]]));
  const rollVelocities = [0.45, 0.6, 0.78, 0.95];
  const snareRow = [...(rows[snarePad.id] ?? new Array<number>(source.stepCount).fill(0))];
  for (let k = 0; k < 4; k++) {
    const idx = source.stepCount - 4 + k;
    if (idx >= 0) snareRow[idx] = rollVelocities[k];
  }
  rows[snarePad.id] = snareRow;

  const stepMeta = cloneStepMeta(source.stepMeta) ?? {};
  const lastStep = source.stepCount - 1;
  stepMeta[snarePad.id] = { ...(stepMeta[snarePad.id] ?? {}), [lastStep]: { ratchet: 2 } };

  const copy: Pattern = {
    id: uid("pattern"),
    name: `${source.name} Fill`,
    stepCount: source.stepCount,
    rows,
    notes: Object.fromEntries(
      Object.entries(source.notes ?? {}).map(([trackId, notes]) => [
        trackId,
        notes.map((n) => ({ ...n, id: uid("note") })),
      ]),
    ),
    stepMeta,
  };
  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, copy],
    activePatternId: copy.id,
  };
  return snapshot("createFill", `Fill from ${source.name}`, doc, next);
}

/* ---------------- tracks ---------------- */

export function createDrumTrack(doc: ProjectDocument): Command {
  const count = drumTracksOf(doc).length;
  const track = createDrumTrackModel(`Drums ${count + 1}`);
  const withTrack: ProjectDocument = { ...doc, tracks: [...doc.tracks, track] };
  const next = normalizeProject(withTrack);
  return snapshot("createDrumTrack", `Add track ${track.name}`, doc, next);
}

export function createInstrumentTrack(doc: ProjectDocument, kind: InstrumentKind): Command {
  const count = instrumentTracksOf(doc).filter((t) => t.instrument === kind).length + 1;
  const track = createInstrumentTrackModel(kind, count);
  const next: ProjectDocument = { ...doc, tracks: [...doc.tracks, track] };
  return snapshot("createInstrumentTrack", `Add track ${track.name}`, doc, next);
}

export function createGroupTrack(doc: ProjectDocument): Command {
  const count = doc.tracks.filter((t) => t.kind === "group").length;
  const track = createGroupTrackModel(`Group ${count + 1}`);
  const next: ProjectDocument = { ...doc, tracks: [...doc.tracks, track] };
  return snapshot("createGroupTrack", `Add group ${track.name}`, doc, next);
}

export function addToGroup(doc: ProjectDocument, trackId: string, groupId: string): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track || track.kind === "group") throw new Error(`Cannot add group to group`);
  if (!doc.tracks.some((t) => t.id === groupId && t.kind === "group")) throw new Error(`Group ${groupId} not found`);
  const prevGroupId = "groupId" in track ? track.groupId : undefined;
  const hadGroupId = prevGroupId !== undefined;
  return {
    type: "addToGroup",
    label: `Add ${track.name} to group`,
    execute: (d) => ({
      ...d,
      tracks: d.tracks.map((t) => (t.id === trackId && t.kind !== "group" ? { ...t, groupId } : t)),
    }),
    undo: (d) => ({
      ...d,
      tracks: d.tracks.map((t) => {
        if (t.id !== trackId || t.kind === "group") return t;
        if (hadGroupId) return { ...t, groupId: prevGroupId };
        const { groupId: _, ...rest } = t as any;
        return rest;
      }),
    }),
  };
}

export function removeFromGroup(doc: ProjectDocument, trackId: string): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track || track.kind === "group") throw new Error(`Cannot remove group from group`);
  const prevGroupId = "groupId" in track ? track.groupId : undefined;
  if (prevGroupId === undefined) {
    return { type: "removeFromGroup", label: "Remove from group", execute: (d) => d, undo: (d) => d };
  }
  return {
    type: "removeFromGroup",
    label: `Remove ${track.name} from group`,
    execute: (d) => ({
      ...d,
      tracks: d.tracks.map((t) => (t.id === trackId && t.kind !== "group" ? { ...t, groupId: undefined } : t)),
    }),
    undo: (d) => ({
      ...d,
      tracks: d.tracks.map((t) => (t.id === trackId && t.kind !== "group" ? { ...t, groupId: prevGroupId } : t)),
    }),
  };
}

export function deleteTrack(doc: ProjectDocument, trackId: string): Command {
  if (doc.tracks.length <= 1) throw new Error("Cannot delete the last track");
  const target = doc.tracks.find((t) => t.id === trackId);
  if (!target) throw new Error(`Track ${trackId} not found`);
  const removedPadIds = new Set(target.kind === "drum" ? target.pads.map((p) => p.id) : []);
  // When deleting a group, orphan its children (remove groupId)
  const isGroup = target.kind === "group";
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks
      .filter((t) => t.id !== trackId)
      .map((t) => (isGroup && t.kind !== "group" && t.groupId === trackId ? { ...t, groupId: undefined } : t)),
    patterns: doc.patterns.map((pattern) => ({
      ...pattern,
      rows: Object.fromEntries(Object.entries(pattern.rows).filter(([padId]) => !removedPadIds.has(padId))),
      notes: Object.fromEntries(Object.entries(pattern.notes ?? {}).filter(([tid]) => tid !== trackId)),
    })),
  };
  return snapshot("deleteTrack", `Delete track ${target.name}`, doc, next);
}

export function duplicateTrack(doc: ProjectDocument, trackId: string): Command {
  const target = doc.tracks.find((t) => t.id === trackId);
  if (!target) throw new Error(`Track ${trackId} not found`);
  const cloneId = uid("track");
  let clone: Track;
  if (target.kind === "drum") {
    clone = {
      ...target,
      id: cloneId,
      name: `${target.name} copy`,
      pads: target.pads.map((p) => ({ ...p, id: uid("pad"), chokeGroup: p.chokeGroup })),
      effects: target.effects.map((fx) => ({
        ...fx,
        id: uid("fx"),
        params: { ...fx.params },
        ...(fx.steps ? { steps: [...fx.steps] } : {}),
        ...(fx.sidechainTrackId ? { sidechainTrackId: fx.sidechainTrackId } : {}),
      })),
      sends: { ...target.sends },
      ...(target.groupId ? { groupId: target.groupId } : {}),
      ...(target.color ? { color: target.color } : {}),
    };
    // Remove frozen state on clone
    if ((clone as unknown as Record<string, unknown>).frozen)
      delete (clone as unknown as Record<string, unknown>).frozen;
  } else if (target.kind === "instrument") {
    clone = {
      ...target,
      id: cloneId,
      name: `${target.name} copy`,
      params: { ...target.params },
      effects: target.effects.map((fx) => ({
        ...fx,
        id: uid("fx"),
        params: { ...fx.params },
        ...(fx.steps ? { steps: [...fx.steps] } : {}),
        ...(fx.sidechainTrackId ? { sidechainTrackId: fx.sidechainTrackId } : {}),
      })),
      sends: { ...target.sends },
      ...(target.groupId ? { groupId: target.groupId } : {}),
      ...(target.color ? { color: target.color } : {}),
      ...(target.presetId ? { presetId: target.presetId } : {}),
    };
    if ((clone as unknown as Record<string, unknown>).frozen)
      delete (clone as unknown as Record<string, unknown>).frozen;
    // Clear midiOutput to avoid duplicate MIDI routing collision
    if ((clone as InstrumentTrack).midiOutput) delete (clone as InstrumentTrack).midiOutput;
  } else {
    clone = {
      ...target,
      id: cloneId,
      name: `${target.name} copy`,
      effects: target.effects.map((fx) => ({
        ...fx,
        id: uid("fx"),
        params: { ...fx.params },
        ...(fx.steps ? { steps: [...fx.steps] } : {}),
        ...(fx.sidechainTrackId ? { sidechainTrackId: fx.sidechainTrackId } : {}),
      })),
      sends: { ...target.sends },
      ...(target.color ? { color: target.color } : {}),
    };
    if ((clone as unknown as Record<string, unknown>).frozen)
      delete (clone as unknown as Record<string, unknown>).frozen;
  }
  const idx = doc.tracks.findIndex((t) => t.id === trackId);
  const tracks = [...doc.tracks];
  tracks.splice(idx + 1, 0, clone);
  let next: ProjectDocument = { ...doc, tracks };
  // Duplicate pattern rows/notes for the new drum track's pads
  if (target.kind === "drum") {
    const padIdMap = new Map<string, string>();
    (target as DrumTrack).pads.forEach((p, i) => padIdMap.set(p.id, (clone as DrumTrack).pads[i].id));
    next = {
      ...next,
      patterns: next.patterns.map((pat) => {
        const newRows: Record<string, number[]> = { ...pat.rows };
        for (const [oldId, newId] of padIdMap) if (pat.rows[oldId]) newRows[newId] = [...pat.rows[oldId]];
        // stepMeta clone
        let newMeta = pat.stepMeta ? { ...pat.stepMeta } : undefined;
        if (newMeta) {
          for (const [oldId, newId] of padIdMap) if (newMeta[oldId]) newMeta[newId] = { ...newMeta[oldId] };
        }
        return { ...pat, rows: newRows, ...(newMeta ? { stepMeta: newMeta } : {}) };
      }),
    };
  }
  next = normalizeProject(next);
  return snapshot("duplicateTrack", `Duplicate track ${target.name}`, doc, next);
}

export function setTrackColor(doc: ProjectDocument, trackId: string, color: string | null): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  const clean = color ? sanitizeColor(color) : undefined;
  if (color && !clean) throw new Error("Invalid color (use #rrggbb)");
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.id !== trackId) return t;
      if (!clean) {
        const { color: _c, ...rest } = t as unknown as Record<string, unknown>;
        return rest as unknown as Track;
      }
      return { ...t, color: clean } as unknown as Track;
    }),
  };
  return snapshot("setTrackColor", color ? `Set ${track.name} color` : `Clear ${track.name} color`, doc, next);
}

export function setGroupCollapsed(doc: ProjectDocument, groupId: string, collapsed: boolean): Command {
  const track = doc.tracks.find((t) => t.id === groupId);
  if (!track || track.kind !== "group") throw new Error(`Group ${groupId} not found`);
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) =>
      t.id === groupId ? ({ ...t, collapsed } as import("../project-model/types").GroupTrack) : t,
    ),
  };
  return snapshot("setGroupCollapsed", collapsed ? `Fold ${track.name}` : `Unfold ${track.name}`, doc, next);
}

export function setGroupMute(doc: ProjectDocument, groupId: string, mute: boolean): Command {
  const group = doc.tracks.find((t) => t.id === groupId && t.kind === "group");
  if (!group) throw new Error(`Group ${groupId} not found`);
  const memberIds = new Set(doc.tracks.filter((t) => t.kind !== "group" && t.groupId === groupId).map((t) => t.id));
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.id === groupId) return { ...t, mute } as import("../project-model/types").GroupTrack;
      if (memberIds.has(t.id)) return { ...t, mute } as Track;
      return t;
    }),
  };
  return snapshot("setGroupMute", `${mute ? "Mute" : "Unmute"} ${group.name} (+${memberIds.size})`, doc, next);
}

export function setGroupSolo(doc: ProjectDocument, groupId: string, solo: boolean): Command {
  const group = doc.tracks.find((t) => t.id === groupId && t.kind === "group");
  if (!group) throw new Error(`Group ${groupId} not found`);
  const memberIds = new Set(doc.tracks.filter((t) => t.kind !== "group" && t.groupId === groupId).map((t) => t.id));
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.id === groupId) return { ...t, solo } as import("../project-model/types").GroupTrack;
      if (memberIds.has(t.id)) return { ...t, solo } as Track;
      return t;
    }),
  };
  return snapshot("setGroupSolo", `${solo ? "Solo" : "Un-solo"} ${group.name} (+${memberIds.size})`, doc, next);
}

export function createReturnTrack(doc: ProjectDocument, name?: string): Command {
  const baseName = name?.trim() || `Return ${doc.returns.length + 1}`;
  const ret: import("../project-model/types").ReturnTrack = {
    id: uid("return"),
    kind: "return",
    name: baseName,
    gain: 0.9,
    effects: [],
  };
  const next: ProjectDocument = { ...doc, returns: [...doc.returns, ret] };
  return snapshot("createReturnTrack", `Add return ${baseName}`, doc, next);
}

export function addEffectToTracks(doc: ProjectDocument, trackIds: string[], type: EffectType): Command {
  if (trackIds.length === 0) throw new Error("Select at least one track");
  const unique = [...new Set(trackIds)];
  for (const id of unique)
    if (!doc.tracks.some((t) => t.id === id) && !doc.returns.some((r) => r.id === id))
      throw new Error(`Track ${id} not found`);
  let next: ProjectDocument = doc;
  for (const id of unique) {
    const isReturn = doc.returns.some((r) => r.id === id);
    if (isReturn) {
      const fx: EffectInstance = { id: uid("fx"), type, bypassed: false, params: defaultParamsOf(type) };
      if (type === "stepGate") fx.steps = [...DEFAULT_GATE_PATTERN];
      if (type === "stutter") fx.steps = Array.from({ length: 16 }, () => 1);
      next = { ...next, returns: next.returns.map((r) => (r.id === id ? { ...r, effects: [...r.effects, fx] } : r)) };
    } else {
      next = addEffect(next, id, type).execute(next);
    }
  }
  return snapshot("addEffectToTracks", `Add ${EFFECT_DEFS[type].name} to ${unique.length} tracks`, doc, next);
}

/* ---------------- notes ---------------- */

function withTrackNotes(
  doc: ProjectDocument,
  trackId: string,
  fn: (notes: NoteEvent[]) => NoteEvent[],
): ProjectDocument {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!pattern) throw new Error("No active pattern");
  const notes = fn(pattern.notes?.[trackId] ?? []);
  return {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [trackId]: notes } } : p,
    ),
  };
}

export function activeTrackNotes(doc: ProjectDocument, trackId: string): NoteEvent[] {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  return pattern?.notes?.[trackId] ?? [];
}

export function addNote(
  _doc: ProjectDocument,
  trackId: string,
  note: { pitch: number; start: number; duration: number; velocity: number },
): Command {
  const id = uid("note");
  return {
    type: "addNote",
    label: `Add note`,
    execute: (d) => withTrackNotes(d, trackId, (notes) => [...notes, { id, ...note }]),
    undo: (d) => withTrackNotes(d, trackId, (notes) => notes.filter((n) => n.id !== id)),
  };
}

export function moveNote(
  doc: ProjectDocument,
  trackId: string,
  noteId: string,
  delta: { pitch?: number; start?: number },
): Command {
  const prev = activeTrackNotes(doc, trackId).find((n) => n.id === noteId);
  if (!prev) throw new Error(`Note ${noteId} not found`);
  const apply = (d: ProjectDocument, patch: { pitch?: number; start?: number }) =>
    withTrackNotes(d, trackId, (notes) => notes.map((n) => (n.id === noteId ? { ...n, ...patch } : n)));
  return {
    type: "moveNote",
    label: "Move note",
    execute: (d) => apply(d, delta),
    undo: (d) => apply(d, { pitch: prev.pitch, start: prev.start }),
  };
}

export function resizeNote(doc: ProjectDocument, trackId: string, noteId: string, duration: number): Command {
  const prev = activeTrackNotes(doc, trackId).find((n) => n.id === noteId);
  if (!prev) throw new Error(`Note ${noteId} not found`);
  const apply = (d: ProjectDocument, dur: number) =>
    withTrackNotes(d, trackId, (notes) => notes.map((n) => (n.id === noteId ? { ...n, duration: dur } : n)));
  return {
    type: "resizeNote",
    label: "Resize note",
    execute: (d) => apply(d, duration),
    undo: (d) => apply(d, prev.duration),
  };
}

export function setNoteVelocity(doc: ProjectDocument, trackId: string, noteId: string, velocity: number): Command {
  const prev = activeTrackNotes(doc, trackId).find((n) => n.id === noteId);
  if (!prev) throw new Error(`Note ${noteId} not found`);
  const clamped = clamp(velocity, 0.05, 1);
  const apply = (d: ProjectDocument, v: number) =>
    withTrackNotes(d, trackId, (notes) => notes.map((n) => (n.id === noteId ? { ...n, velocity: v } : n)));
  return {
    type: "setNoteVelocity",
    label: "Set note velocity",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev.velocity),
  };
}

export function deleteNote(doc: ProjectDocument, trackId: string, noteId: string): Command {
  return {
    type: "deleteNote",
    label: "Delete note",
    execute: (d) => withTrackNotes(d, trackId, (notes) => notes.filter((n) => n.id !== noteId)),
    undo: (d) => {
      const target = activeTrackNotes(doc, trackId).find((n) => n.id === noteId);
      if (!target) return d;
      return withTrackNotes(d, trackId, (notes) => (notes.some((n) => n.id === noteId) ? notes : [...notes, target]));
    },
  };
}

export function deleteNotes(doc: ProjectDocument, trackId: string, noteIds: string[]): Command {
  const ids = new Set(noteIds);
  const removed = activeTrackNotes(doc, trackId).filter((note) => ids.has(note.id));
  return {
    type: "deleteNotes",
    label: `Delete ${ids.size} notes`,
    execute: (d) => withTrackNotes(d, trackId, (notes) => notes.filter((note) => !ids.has(note.id))),
    undo: (d) =>
      withTrackNotes(d, trackId, (notes) => {
        const present = new Set(notes.map((n) => n.id));
        const missing = removed.filter((note) => !present.has(note.id));
        return missing.length === 0 ? notes : [...notes, ...missing];
      }),
  };
}

export function quantizeNotes(
  doc: ProjectDocument,
  trackId: string,
  noteIds?: string[],
  gridTicks: number = STEP_TICKS,
  strength = 1,
): Command {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!pattern) throw new Error("Active pattern not found");
  const all = pattern.notes?.[trackId] ?? [];
  const targetIds = noteIds && noteIds.length > 0 ? new Set(noteIds) : null;
  const before = all.filter((n) => !targetIds || targetIds.has(n.id));
  const prev = [...all];
  const s = Math.min(1, Math.max(0, strength));
  const quantized = all.map((n) => {
    if (targetIds && !targetIds.has(n.id)) return n;
    const qStart = Math.round(n.start / gridTicks) * gridTicks;
    const qDur = Math.round(n.duration / gridTicks) * gridTicks;
    // FL partial quantize: strength < 1 moves the start only a fraction of
    // the way to the grid (50% = "quick quantize 50%", keeps the groove feel)
    const start = qStart + (n.start - qStart) * (1 - s);
    const duration = n.duration * (1 - s) + Math.max(gridTicks, qDur) * s;
    return {
      ...n,
      start: Math.max(0, Math.min(pattern.stepCount * STEP_TICKS - duration, Math.round(start))),
      duration: Math.max(1, Math.round(duration)),
    };
  });
  return {
    type: "quantizeNotes",
    label: s < 1 ? `Quantize ${before.length} notes ${Math.round(s * 100)}%` : `Quantize ${before.length} notes`,
    execute: (d) => withTrackNotes(d, trackId, () => quantized),
    undo: (d) => withTrackNotes(d, trackId, () => prev),
  };
}

export function duplicateNotes(doc: ProjectDocument, trackId: string, noteIds?: string[]): Command {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!pattern) throw new Error("Active pattern not found");
  const all = pattern.notes?.[trackId] ?? [];
  const targetIds = noteIds && noteIds.length > 0 ? new Set(noteIds) : null;
  const toDup = targetIds ? all.filter((n) => targetIds.has(n.id)) : all;
  if (toDup.length === 0) throw new Error("Select at least one note to duplicate");
  const patternTicks = pattern.stepCount * STEP_TICKS;
  const minStart = Math.min(...toDup.map((n) => n.start));
  const maxEnd = Math.max(...toDup.map((n) => n.start + n.duration));
  const width = maxEnd - minStart;
  // Duplicate shifted by width, wrap if exceeds pattern
  const copies = toDup.map((n) => ({
    ...n,
    id: uid("note"),
    start: (n.start + width) % patternTicks,
  }));
  // If wrap would overlap original, keep original and add copies (allow overlap for now)
  const next = [...all, ...copies].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const prev = [...all];
  return {
    type: "duplicateNotes",
    label: `Duplicate ${toDup.length} notes`,
    execute: (d) => withTrackNotes(d, trackId, () => next),
    undo: (d) => withTrackNotes(d, trackId, () => prev),
  };
}

export function splitNotes(doc: ProjectDocument, trackId: string, noteIds?: string[]): Command {
  const all = activeTrackNotes(doc, trackId);
  const targetIds = noteIds && noteIds.length > 0 ? new Set(noteIds) : null;
  const toSplit = targetIds ? all.filter((n) => targetIds.has(n.id)) : all;
  if (toSplit.length === 0) throw new Error("Select at least one note to split");
  const prev = [...all];
  const next: NoteEvent[] = [];
  for (const n of all) {
    if (!toSplit.includes(n)) {
      next.push(n);
      continue;
    }
    if (n.duration < STEP_TICKS * 2) {
      next.push(n);
      continue;
    }
    const half = Math.floor(n.duration / 2);
    const a = { ...n, duration: half };
    const b = { ...n, id: uid("note"), start: n.start + half, duration: n.duration - half };
    next.push(a, b);
  }
  next.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return {
    type: "splitNotes",
    label: `Split ${toSplit.length} notes`,
    execute: (d) => withTrackNotes(d, trackId, () => next),
    undo: (d) => withTrackNotes(d, trackId, () => prev),
  };
}

export function glueNotes(doc: ProjectDocument, trackId: string, noteIds?: string[]): Command {
  const all = activeTrackNotes(doc, trackId);
  const targetIds = noteIds && noteIds.length > 0 ? new Set(noteIds) : new Set(all.map((n) => n.id));
  const toGlue = all.filter((n) => targetIds.has(n.id));
  if (toGlue.length < 2) throw new Error("Select at least two notes to glue");
  // Group by pitch
  const byPitch = new Map<number, NoteEvent[]>();
  for (const n of toGlue) {
    const arr = byPitch.get(n.pitch) ?? [];
    arr.push(n);
    byPitch.set(n.pitch, arr);
  }
  // If multiple pitches, glue only if all same pitch, else no-op
  if (byPitch.size !== 1) throw new Error("Glue requires notes of the same pitch");
  const group = [...toGlue].sort((a, b) => a.start - b.start);
  const glued: NoteEvent = {
    id: uid("note"),
    pitch: group[0].pitch,
    start: group[0].start,
    duration: Math.max(...group.map((n) => n.start + n.duration)) - group[0].start,
    velocity: group[0].velocity,
  };
  const remaining = all.filter((n) => !targetIds.has(n.id));
  const next = [...remaining, glued].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const prev = [...all];
  return {
    type: "glueNotes",
    label: `Glue ${toGlue.length} notes`,
    execute: (d) => withTrackNotes(d, trackId, () => next),
    undo: (d) => withTrackNotes(d, trackId, () => prev),
  };
}

export function setNotesVelocity(doc: ProjectDocument, trackId: string, noteIds: string[], velocity: number): Command {
  const clamped = clamp(velocity, 0.05, 1);
  const prev = activeTrackNotes(doc, trackId).filter((n) => noteIds.includes(n.id));
  const prevMap = new Map(prev.map((n) => [n.id, n.velocity]));
  return {
    type: "setNotesVelocity",
    label: `Set velocity for ${noteIds.length} notes`,
    execute: (d) =>
      withTrackNotes(d, trackId, (notes) =>
        notes.map((n) => (noteIds.includes(n.id) ? { ...n, velocity: clamped } : n)),
      ),
    undo: (d) =>
      withTrackNotes(d, trackId, (notes) =>
        notes.map((n) => (prevMap.has(n.id) ? { ...n, velocity: prevMap.get(n.id)! } : n)),
      ),
  };
}

export function nudgeNotes(
  doc: ProjectDocument,
  trackId: string,
  noteIds: string[],
  deltaTicks: number,
  deltaPitch: number,
): Command {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!pattern) throw new Error("Active pattern not found");
  const patternTicks = pattern.stepCount * STEP_TICKS;
  const all = activeTrackNotes(doc, trackId);
  const targetIds = new Set(noteIds);
  const before = all.filter((n) => targetIds.has(n.id));
  if (before.length === 0) throw new Error("Select notes to nudge");
  const after = all.map((n) => {
    if (!targetIds.has(n.id)) return n;
    const newStart = clamp(Math.round(n.start + deltaTicks), 0, Math.max(0, patternTicks - n.duration));
    const newPitch = clamp(Math.round(n.pitch + deltaPitch), 0, 127);
    return { ...n, start: newStart, pitch: newPitch };
  });
  // Keep sorted for deterministic order
  const sortedAfter = [...after].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const sortedBefore = [...all].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return {
    type: "nudgeNotes",
    label: `Nudge ${before.length} notes`,
    execute: (d) => withTrackNotes(d, trackId, () => sortedAfter),
    undo: (d) => withTrackNotes(d, trackId, () => sortedBefore),
  };
}

export function setNotesVelocities(doc: ProjectDocument, trackId: string, velocities: Record<string, number>): Command {
  const all = activeTrackNotes(doc, trackId);
  const prev = new Map(all.filter((n) => velocities[n.id] !== undefined).map((n) => [n.id, n.velocity]));
  if (prev.size === 0) throw new Error("No matching notes for velocity update");
  return {
    type: "setNotesVelocities",
    label: `Set velocity for ${prev.size} notes`,
    execute: (d) =>
      withTrackNotes(d, trackId, (notes) =>
        notes.map((n) => (velocities[n.id] !== undefined ? { ...n, velocity: clamp(velocities[n.id], 0.05, 1) } : n)),
      ),
    undo: (d) =>
      withTrackNotes(d, trackId, (notes) =>
        notes.map((n) => (prev.has(n.id) ? { ...n, velocity: prev.get(n.id)! } : n)),
      ),
  };
}

export interface ApplyMidiCreativeOptions {
  trackId: string;
  noteIds?: string[];
  operation: MidiCreativeOperation;
}

function midiCreativeLabel(operation: MidiCreativeOperation): string {
  switch (operation.kind) {
    case "snap-scale":
      return "Snap notes to scale";
    case "chord":
      return "Generate chords";
    case "stamp-chord":
      return `Stamp ${operation.shape} chord`;
    case "reverse":
      return "Reverse notes";
    case "invert":
      return "Invert notes";
    case "mirror":
      return "Mirror notes";
    case "retrograde":
      return "Retrograde notes";
    case "cluster":
      return "Cluster notes";
    case "halve":
      return "Halve note timing";
    case "double":
      return "Double note timing";
    case "strum":
      return "Strum notes";
    case "gate":
      return "Set note gate";
    case "humanize":
      return "Humanize notes";
    case "velocity-randomize":
      return "Randomize note velocity";
    case "arpeggiate":
      return "Arpeggiate notes";
    case "note-repeat":
      return "Repeat notes";
    case "euclidean":
      return "Generate Euclidean rhythm";
    case "bassline":
      return "Generate bassline";
  }
}

/** Apply one materialized MIDI creativity operation as one undoable edit. */
export function applyMidiCreativeTool(doc: ProjectDocument, options: ApplyMidiCreativeOptions): Command {
  const track = doc.tracks.find(
    (candidate): candidate is InstrumentTrack => candidate.kind === "instrument" && candidate.id === options.trackId,
  );
  if (!track) throw new Error(`Instrument track ${options.trackId} not found`);
  const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
  if (!pattern) throw new Error(`Active pattern ${doc.activePatternId} not found`);
  const notes = pattern.notes?.[track.id] ?? [];
  const requestedIds = options.noteIds && options.noteIds.length > 0 ? new Set(options.noteIds) : null;
  const target = requestedIds ? notes.filter((note) => requestedIds.has(note.id)) : notes;
  if (target.length === 0) throw new Error("Select at least one note first");

  const patternTicks = pattern.stepCount * STEP_TICKS;
  let transformed: NoteEvent[];
  const operation = options.operation;
  switch (operation.kind) {
    case "snap-scale":
      transformed = snapNotesToScale(target, operation.key, patternTicks);
      break;
    case "chord":
      transformed = target.flatMap((note) =>
        createChordNotes(note, operation.options, patternTicks, (index) => uid(`note-${index}`)),
      );
      break;
    case "stamp-chord":
      // FL Chord Stamp: every selected note becomes a chord root; roots keep
      // their id so selection persists, added voices get fresh ids.
      transformed = target.flatMap((note) =>
        stampChordNotes(note, operation.shape, patternTicks, (index) => uid(`stamp-${index}`)),
      );
      break;
    case "reverse":
      transformed = applyScaleOption(
        reverseNotes(target, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "invert":
      transformed = applyScaleOption(
        invertNotes(target, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "mirror":
      transformed = applyScaleOption(
        mirrorNotes(target, operation.centerPitch, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "retrograde":
      transformed = applyScaleOption(
        retrogradeNotes(target, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "cluster":
      transformed = applyScaleOption(
        clusterNotes(target, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "halve":
      transformed = applyScaleOption(
        halveNotes(target, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "double":
      transformed = applyScaleOption(
        doubleNotes(target, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "strum":
      transformed = applyScaleOption(
        strumNotes(target, operation.options, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "gate":
      transformed = applyScaleOption(
        gateNotes(target, operation.gate, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "humanize":
      transformed = applyScaleOption(
        humanizeNotes(target, operation.options, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "velocity-randomize":
      transformed = applyScaleOption(
        randomizeVelocity(target, operation.options, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "arpeggiate":
      transformed = applyScaleOption(
        arpeggiateNotes(target, operation.options, patternTicks, (index) => uid(`arp-${index}`)),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "note-repeat":
      transformed = applyScaleOption(
        repeatNotes(target, operation.options, patternTicks, (index) => uid(`repeat-${index}`)),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "euclidean":
      transformed = applyScaleOption(
        euclideanNotes(target, operation.options, patternTicks, (index) => uid(`euclidean-${index}`)),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "bassline":
      transformed = basslineNotes(target, operation.options, patternTicks, (index) => uid(`bass-${index}`));
      break;
  }

  const untouched = requestedIds ? notes.filter((note) => !requestedIds.has(note.id)) : [];
  const nextNotes = [...untouched, ...transformed].sort(
    (a, b) => a.start - b.start || a.pitch - b.pitch || a.id.localeCompare(b.id),
  );
  return {
    type: `applyMidiCreativeTool:${operation.kind}`,
    label: midiCreativeLabel(operation),
    execute: (d) => ({
      ...d,
      patterns: d.patterns.map((candidate) =>
        candidate.id === pattern.id
          ? { ...candidate, notes: { ...(candidate.notes ?? {}), [track.id]: nextNotes } }
          : candidate,
      ),
    }),
    undo: (d) => ({
      ...d,
      patterns: d.patterns.map((candidate) =>
        candidate.id === pattern.id
          ? { ...candidate, notes: { ...(candidate.notes ?? {}), [track.id]: notes } }
          : candidate,
      ),
    }),
  };
}

/* ---------------- instrument params ---------------- */

export function setInstrumentParam(doc: ProjectDocument, trackId: string, paramId: string, value: number): Command {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.id === trackId);
  if (!track) throw new Error(`Instrument track ${trackId} not found`);
  const prev = track.params[paramId] ?? defaultInstrumentParams(track.instrument)[paramId];
  const clamped = clampInstrumentParam(track.instrument, paramId, value);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) =>
      t.kind === "instrument" && t.id === trackId ? { ...t, params: { ...t.params, [paramId]: v } } : t,
    ),
  });
  return {
    type: "setInstrumentParam",
    label: `Set ${INSTRUMENT_DEFS[track.instrument].name} ${paramId}`,
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i);
        if (t.get("id") === trackId) {
          (t.get("params") as any).set(paramId, clamped);
          break;
        }
      }
    },
  };
}

export function setInstrumentSample(doc: ProjectDocument, trackId: string, assetId: string | null): Command {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.id === trackId);
  if (!track) throw new Error(`Instrument track ${trackId} not found`);
  const prev = track.sampleId;
  const apply = (d: ProjectDocument, v: string | null): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) => (t.kind === "instrument" && t.id === trackId ? { ...t, sampleId: v } : t)),
  });
  return {
    type: "setInstrumentSample",
    label: `Set sample`,
    execute: (d) => apply(d, assetId),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i);
        if (t.get("id") === trackId) {
          t.set("sampleId", assetId);
          break;
        }
      }
    },
  };
}

/**
 * Apply an instrument preset as a single undoable step: replaces the track's
 * parameters (clamped to the instrument's ranges), sampler sample, and records
 * the preset id. Params not present in the preset keep their current value.
 */
export function applyInstrumentPreset(doc: ProjectDocument, trackId: string, preset: InstrumentPreset): Command {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.id === trackId);
  if (!track) throw new Error(`Instrument track ${trackId} not found`);
  const prevParams = { ...track.params };
  const prevSample = track.sampleId;
  const prevPresetId = track.presetId ?? null;

  const nextParams: Record<string, number> = { ...track.params };
  for (const [key, value] of Object.entries(preset.params)) {
    nextParams[key] = clampInstrumentParam(track.instrument, key, value);
  }
  const nextSample = preset.sampleId !== undefined ? preset.sampleId : track.sampleId;

  const apply = (
    d: ProjectDocument,
    params: Record<string, number>,
    sampleId: string | null,
    presetId: string | null,
  ): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) =>
      t.kind === "instrument" && t.id === trackId ? { ...t, params, sampleId, presetId } : t,
    ),
  });
  return {
    type: "applyInstrumentPreset",
    label: `Apply preset "${preset.name}"`,
    execute: (d) => apply(d, nextParams, nextSample, preset.id),
    undo: (d) => apply(d, prevParams, prevSample, prevPresetId),
  };
}

/* ---------------- scenes ---------------- */

export function createScene(doc: ProjectDocument, name?: string): Command {
  const scene: Scene = {
    id: uid("scene"),
    name: name ?? `Scene ${patternLetter(doc.scenes.length)}`,
    patternId: doc.activePatternId,
    intensity: 0.7,
  };
  const next: ProjectDocument = { ...doc, scenes: [...doc.scenes, scene] };
  return snapshot("createScene", `Add ${scene.name}`, doc, next);
}

function uniqueVariationName(doc: ProjectDocument, sourceName: string): string {
  const base = `${sourceName} VAR`;
  let index = 1;
  while (
    doc.scenes.some((scene) => scene.name.toLowerCase() === `${base} ${String(index).padStart(2, "0")}`.toLowerCase())
  ) {
    index += 1;
  }
  return `${base} ${String(index).padStart(2, "0")}`;
}

function clonePatternForVariation(source: Pattern, sourceName: string): Pattern {
  return {
    ...source,
    id: uid("pattern"),
    name: `${sourceName} Variation`,
    rows: Object.fromEntries(Object.entries(source.rows).map(([id, row]) => [id, [...row]])),
    notes: Object.fromEntries(
      Object.entries(source.notes ?? {}).map(([id, notes]) => [id, notes.map((note) => ({ ...note }))]),
    ),
    stepMeta: source.stepMeta
      ? Object.fromEntries(Object.entries(source.stepMeta).map(([padId, meta]) => [padId, { ...meta }]))
      : undefined,
    generation: source.generation ? { ...source.generation, sourcePatternId: source.id } : undefined,
  };
}

function makeSceneVariation(
  doc: ProjectDocument,
  source: Scene,
  roleOverride?: SceneRole,
): { scene: Scene; pattern: Pattern } {
  const sourcePattern = doc.patterns.find((pattern) => pattern.id === source.patternId);
  if (!sourcePattern) throw new Error(`Pattern ${source.patternId} not found`);
  const name = uniqueVariationName(doc, source.name);
  const pattern = clonePatternForVariation(sourcePattern, name);
  const scene: Scene = {
    ...source,
    id: uid("scene"),
    name,
    patternId: pattern.id,
    intensityCurve: source.intensityCurve?.map((point) => ({ ...point })),
    role: roleOverride ?? source.role ?? sceneRoleOf(source),
  };
  return { scene, pattern };
}

export function duplicateSceneAsVariation(doc: ProjectDocument, sceneId: string, roleOverride?: SceneRole): Command {
  const source = doc.scenes.find((scene) => scene.id === sceneId);
  if (!source) throw new Error(`Scene ${sceneId} not found`);
  const { scene, pattern } = makeSceneVariation(doc, source, roleOverride);
  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, pattern],
    scenes: [...doc.scenes, scene],
  };
  return snapshot("duplicateSceneAsVariation", `Create variation ${scene.name}`, doc, next);
}

export function setSceneRole(doc: ProjectDocument, sceneId: string, role: SceneRole | null): Command {
  const target = doc.scenes.find((scene) => scene.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  const next: ProjectDocument = {
    ...doc,
    scenes: doc.scenes.map((scene) => {
      if (scene.id !== sceneId) return scene;
      if (role) return { ...scene, role };
      const { role: _role, ...withoutRole } = scene;
      return withoutRole;
    }),
  };
  return snapshot("setSceneRole", role ? `Set ${target.name} role to ${role}` : `Clear ${target.name} role`, doc, next);
}

export function reorderScenes(doc: ProjectDocument, fromIndex: number, toIndex: number): Command {
  if (fromIndex < 0 || fromIndex >= doc.scenes.length || toIndex < 0 || toIndex >= doc.scenes.length) {
    throw new Error("Scene reorder index out of range");
  }
  if (fromIndex === toIndex) return snapshot("reorderScenes", "Reorder scenes", doc, doc);
  const scenes = [...doc.scenes];
  const [moved] = scenes.splice(fromIndex, 1);
  scenes.splice(toIndex, 0, moved);
  return snapshot("reorderScenes", "Reorder scenes", doc, { ...doc, scenes });
}

export function renameScene(doc: ProjectDocument, sceneId: string, name: string): Command {
  const prev = doc.scenes.find((s) => s.id === sceneId)?.name ?? "";
  return {
    type: "renameScene",
    label: `Rename scene to "${name}"`,
    execute: (d) => ({ ...d, scenes: d.scenes.map((s) => (s.id === sceneId ? { ...s, name } : s)) }),
    undo: (d) => ({ ...d, scenes: d.scenes.map((s) => (s.id === sceneId ? { ...s, name: prev } : s)) }),
  };
}

export function setScenePattern(doc: ProjectDocument, sceneId: string, patternId: string): Command {
  const prev = doc.scenes.find((s) => s.id === sceneId)?.patternId ?? "";
  const apply = (d: ProjectDocument, v: string): ProjectDocument => ({
    ...d,
    scenes: d.scenes.map((s) => (s.id === sceneId ? { ...s, patternId: v } : s)),
  });
  return {
    type: "setScenePattern",
    label: "Set scene pattern",
    execute: (d) => apply(d, patternId),
    undo: (d) => apply(d, prev),
  };
}

export function deleteScene(doc: ProjectDocument, sceneId: string): Command {
  if (doc.scenes.length <= 1) throw new Error("Cannot delete the last scene");
  const target = doc.scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  const next: ProjectDocument = {
    ...doc,
    scenes: doc.scenes.filter((s) => s.id !== sceneId),
    arrangement: {
      ...doc.arrangement,
      clips: doc.arrangement.clips.filter((c) => c.sceneId !== sceneId),
      transitions: doc.arrangement.transitions?.filter((transition) => {
        const clipIds = new Set(
          doc.arrangement.clips.filter((clip) => clip.sceneId !== sceneId).map((clip) => clip.id),
        );
        return clipIds.has(transition.fromClipId) && clipIds.has(transition.toClipId);
      }),
    },
  };
  return snapshot("deleteScene", `Delete scene ${target.name}`, doc, next);
}

/* ---------------- arrangement ---------------- */

function clipsOverlap(
  clips: ArrangementClip[],
  ignoreId: string | null,
  startBar: number,
  lengthBars: number,
): boolean {
  const endBar = startBar + lengthBars;
  return clips.some((c) => {
    if (c.id === ignoreId) return false;
    return startBar < c.startBar + c.lengthBars && c.startBar < endBar;
  });
}

export function addArrangementClip(doc: ProjectDocument, sceneId: string, startBar: number, lengthBars = 4): Command {
  const scene = doc.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  if (clipsOverlap(doc.arrangement.clips, null, startBar, lengthBars)) {
    throw new Error(`Clip overlaps an existing clip at bar ${startBar + 1}`);
  }
  const clip: ArrangementClip = { id: uid("clip"), sceneId, startBar, lengthBars };
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: [...doc.arrangement.clips, clip].sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("addArrangementClip", `Place ${scene.name} at bar ${startBar + 1}`, doc, next);
}

function transitionsForClips(doc: ProjectDocument, clips: ArrangementClip[]): ArrangementTransition[] | undefined {
  return sanitizeArrangementTransitions(doc.arrangement.transitions, clips);
}

export function createVariationAndPlaceClip(
  doc: ProjectDocument,
  sceneId: string,
  startBar: number,
  lengthBars = 4,
  roleOverride?: SceneRole,
): Command {
  const source = doc.scenes.find((scene) => scene.id === sceneId);
  if (!source) throw new Error(`Scene ${sceneId} not found`);
  const bar = Math.max(0, Math.round(startBar));
  const bars = Math.max(1, Math.round(lengthBars));
  if (clipsOverlap(doc.arrangement.clips, null, bar, bars)) {
    throw new Error(`Clip overlaps an existing clip at bar ${bar + 1}`);
  }
  const { scene, pattern } = makeSceneVariation(doc, source, roleOverride);
  const clip: ArrangementClip = { id: uid("clip"), sceneId: scene.id, startBar: bar, lengthBars: bars };
  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, pattern],
    scenes: [...doc.scenes, scene],
    arrangement: {
      ...doc.arrangement,
      clips: [...doc.arrangement.clips, clip].sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("createVariationAndPlaceClip", `Place ${scene.name}`, doc, next);
}

export function moveArrangementClip(doc: ProjectDocument, clipId: string, startBar: number): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  const bar = Math.max(0, Math.round(startBar));
  if (clipsOverlap(doc.arrangement.clips, clipId, bar, clip.lengthBars)) {
    throw new Error(`Clip overlaps an existing clip at bar ${bar + 1}`);
  }
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: doc.arrangement.clips
        .map((c) => (c.id === clipId ? { ...c, startBar: bar } : c))
        .sort((a, b) => a.startBar - b.startBar),
      transitions: transitionsForClips(
        doc,
        doc.arrangement.clips
          .map((c) => (c.id === clipId ? { ...c, startBar: bar } : c))
          .sort((a, b) => a.startBar - b.startBar),
      ),
    },
  };
  return snapshot("moveArrangementClip", `Move clip to bar ${bar + 1}`, doc, next);
}

export function resizeArrangementClip(doc: ProjectDocument, clipId: string, lengthBars: number): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  const bars = Math.max(1, Math.round(lengthBars));
  if (clipsOverlap(doc.arrangement.clips, clipId, clip.startBar, bars)) {
    throw new Error(`Clip would overlap the next clip`);
  }
  const nextClips = doc.arrangement.clips.map((c) => (c.id === clipId ? { ...c, lengthBars: bars } : c));
  const next: ProjectDocument = {
    ...doc,
    arrangement: { ...doc.arrangement, clips: nextClips, transitions: transitionsForClips(doc, nextClips) },
  };
  return snapshot("resizeArrangementClip", `Resize clip to ${bars} bars`, doc, next);
}

export function deleteArrangementClip(doc: ProjectDocument, clipId: string): Command {
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: doc.arrangement.clips.filter((c) => c.id !== clipId),
      transitions: doc.arrangement.transitions?.filter(
        (transition) => transition.fromClipId !== clipId && transition.toClipId !== clipId,
      ),
    },
  };
  return snapshot("deleteArrangementClip", "Delete clip", doc, next);
}

export function duplicateArrangementClip(doc: ProjectDocument, clipId: string): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  let startBar = clip.startBar + clip.lengthBars;
  while (clipsOverlap(doc.arrangement.clips, null, startBar, clip.lengthBars)) startBar += clip.lengthBars;
  const copy: ArrangementClip = { id: uid("clip"), sceneId: clip.sceneId, startBar, lengthBars: clip.lengthBars };
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: [...doc.arrangement.clips, copy].sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("duplicateArrangementClip", "Duplicate clip", doc, next);
}

/* ---------------- audioClips ---------------- */

function audioClipOverlap(a: AudioClip, b: AudioClip): boolean {
  if (a.trackId !== b.trackId) return false;
  return a.startBar < b.startBar + b.lengthBars && b.startBar < a.startBar + a.lengthBars;
}
void audioClipOverlap;

export function addAudioClip(
  doc: ProjectDocument,
  trackId: string,
  bufferId: string,
  startBar: number,
  lengthBars = 4,
  patch: Partial<Omit<AudioClip, "id" | "trackId" | "bufferId" | "startBar" | "lengthBars">> = {},
): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  if (!bufferId) throw new Error("bufferId required");
  const clip: AudioClip = {
    id: uid("audioClip"),
    trackId,
    bufferId,
    startBar: Math.max(0, Math.round(startBar * 100) / 100),
    lengthBars: Math.max(0.25, Math.round(lengthBars * 100) / 100),
    offsetSec: Math.max(0, patch.offsetSec ?? 0),
    trimStart: Math.max(0, patch.trimStart ?? 0),
    trimEnd: Math.max(0, patch.trimEnd ?? 0),
    gain: Math.min(2, Math.max(0, patch.gain ?? 1)),
    fadeIn: Math.max(0, patch.fadeIn ?? 0),
    fadeOut: Math.max(0, patch.fadeOut ?? 0),
    stretchRate: Math.min(4, Math.max(0.25, patch.stretchRate ?? 1)),
    reverse: patch.reverse === true,
    ...(patch.stretchMode ? { stretchMode: patch.stretchMode } : {}),
  };
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: [...(doc.arrangement.audioClips ?? []), clip].sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("addAudioClip", `Add audio clip`, doc, next);
}

export function deleteAudioClip(doc: ProjectDocument, clipId: string): Command {
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? []).filter((c) => c.id !== clipId),
    },
  };
  return snapshot("deleteAudioClip", "Delete audio clip", doc, next);
}

export function moveAudioClip(doc: ProjectDocument, clipId: string, startBar: number): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  const bar = Math.max(0, Math.round(startBar * 100) / 100);
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? [])
        .map((c) => (c.id === clipId ? { ...c, startBar: bar } : c))
        .sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("moveAudioClip", `Move audio clip to bar ${bar + 1}`, doc, next);
}

export function resizeAudioClip(doc: ProjectDocument, clipId: string, lengthBars: number): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  const bars = Math.max(0.25, Math.round(lengthBars * 100) / 100);
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? []).map((c) => (c.id === clipId ? { ...c, lengthBars: bars } : c)),
    },
  };
  return snapshot("resizeAudioClip", `Resize audio clip to ${bars} bars`, doc, next);
}

export function updateAudioClip(
  doc: ProjectDocument,
  clipId: string,
  patch: Partial<
    Pick<
      AudioClip,
      | "offsetSec"
      | "trimStart"
      | "trimEnd"
      | "gain"
      | "fadeIn"
      | "fadeOut"
      | "stretchRate"
      | "stretchMode"
      | "reverse"
      | "bufferId"
      | "warpMarkers"
    >
  >,
): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  // sanitizeAudioClips drops non-finite numbers on load; match that here so a
  // NaN patch (parse bug in a caller) can never poison the in-memory doc —
  // a NaN stretchRate would throw inside the scheduler's audio window.
  const num = (value: number | undefined, min: number, max: number): number | undefined =>
    value === undefined || !Number.isFinite(value) ? undefined : Math.min(max, Math.max(min, value));
  const nextPatch: Partial<AudioClip> = {};
  if (patch.bufferId !== undefined) nextPatch.bufferId = patch.bufferId;
  const offsetSec = num(patch.offsetSec, 0, Infinity);
  if (offsetSec !== undefined) nextPatch.offsetSec = offsetSec;
  const trimStart = num(patch.trimStart, 0, Infinity);
  if (trimStart !== undefined) nextPatch.trimStart = trimStart;
  const trimEnd = num(patch.trimEnd, 0, Infinity);
  if (trimEnd !== undefined) nextPatch.trimEnd = trimEnd;
  const gain = num(patch.gain, 0, 2);
  if (gain !== undefined) nextPatch.gain = gain;
  const fadeIn = num(patch.fadeIn, 0, Infinity);
  if (fadeIn !== undefined) nextPatch.fadeIn = fadeIn;
  const fadeOut = num(patch.fadeOut, 0, Infinity);
  if (fadeOut !== undefined) nextPatch.fadeOut = fadeOut;
  const stretchRate = num(patch.stretchRate, 0.25, 4);
  if (stretchRate !== undefined) nextPatch.stretchRate = stretchRate;
  if (patch.stretchMode !== undefined) nextPatch.stretchMode = patch.stretchMode;
  if (patch.warpMarkers !== undefined) nextPatch.warpMarkers = patch.warpMarkers;
  if (patch.reverse !== undefined) nextPatch.reverse = patch.reverse === true;
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? []).map((c) => (c.id === clipId ? { ...c, ...nextPatch } : c)),
    },
  };
  return snapshot("updateAudioClip", "Edit audio clip", doc, next);
}

/**
 * Fit a loop clip to the project tempo: pitch-preserving time-stretch with
 * rate = detected loop BPM / project BPM, so the loop locks to the grid
 * while keeping its pitch. Warp markers are left untouched — they describe
 * the source material, not the playback rate.
 */
export function fitAudioClipTempo(doc: ProjectDocument, clipId: string, detectedBpm: number): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  if (!Number.isFinite(detectedBpm) || detectedBpm < 40 || detectedBpm > 240) {
    throw new Error(`Detected tempo ${detectedBpm} out of range — refusing to fit`);
  }
  const rate = Math.round(Math.min(4, Math.max(0.25, detectedBpm / doc.bpm)) * 100) / 100;
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? []).map((c) =>
        c.id === clipId ? { ...c, stretchMode: "stretch", stretchRate: rate } : c,
      ),
    },
  };
  return snapshot("fitAudioClipTempo", `Fit loop ${Math.round(detectedBpm)}→${doc.bpm} BPM (×${rate})`, doc, next);
}

/**
 * Slice an audio clip into multiple clips at given time positions (seconds).
 * Each segment becomes a separate AudioClip in the arrangement, positioned
 * sequentially after the original. SlicerX/PT-style: transient → clip row.
 */
export function sliceAudioClipToArrangement(doc: ProjectDocument, clipId: string, sliceTimesSec: number[]): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  if (sliceTimesSec.length === 0) throw new Error("No slice points provided");
  // Build segments: [0, time1), [time1, time2), ..., [last, end)
  const sorted = [...sliceTimesSec].sort((a, b) => a - b);
  const totalDurationSec = (clip.lengthBars * (BAR_TICKS * 60)) / (doc.bpm * PPQ);
  const ends = [...sorted, totalDurationSec];
  const starts = [0, ...sorted];
  const segments: Array<{ startSec: number; endSec: number }> = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = ends[i];
    if (e - s > 0.03) segments.push({ startSec: s, endSec: e });
  }
  if (segments.length < 2) throw new Error("Slices too short or too few");
  // Position segments sequentially after original clip's end
  const secPerBar = (BAR_TICKS * 60) / (doc.bpm * PPQ);
  const originalEndBar = clip.startBar + clip.lengthBars;
  const newClips: AudioClip[] = [];
  let currentBar = originalEndBar + 0.5; // 0.5 bar gap after original
  for (const seg of segments) {
    const segDurationSec = seg.endSec - seg.startSec;
    const segBars = Math.max(0.25, segDurationSec / secPerBar);
    newClips.push({
      ...clip,
      id: uid("audioClip"),
      startBar: currentBar,
      lengthBars: Math.round(segBars * 100) / 100,
      offsetSec: (clip.offsetSec ?? 0) + seg.startSec,
      trimStart: 0,
      trimEnd: 0,
      warpMarkers: undefined,
    });
    currentBar += segBars + 0.25;
  }
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: [...(doc.arrangement.audioClips ?? []), ...newClips].sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("sliceAudioClipToArrangement", `Slice clip → ${newClips.length} segments`, doc, next);
}

export function duplicateAudioClip(doc: ProjectDocument, clipId: string): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  let startBar = clip.startBar + clip.lengthBars;
  // Avoid same-track overlap by bumping forward
  const existing = doc.arrangement.audioClips ?? [];
  while (
    existing.some(
      (c) =>
        c.trackId === clip.trackId && startBar < c.startBar + c.lengthBars && c.startBar < startBar + clip.lengthBars,
    )
  )
    startBar += clip.lengthBars;
  const copy: AudioClip = { ...clip, id: uid("audioClip"), startBar };
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: [...(doc.arrangement.audioClips ?? []), copy].sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("duplicateAudioClip", "Duplicate audio clip", doc, next);
}

export function bounceStemsToAudioClip(
  doc: ProjectDocument,
  trackIds: string[],
  startBar: number,
  lengthBars: number,
  bufferId: string,
): Command {
  // Guardrail: use buildStemProject so grouped FX are preserved in the future freeze render
  const stemDoc = buildStemProject(doc, (t) => trackIds.includes(t.id));
  void stemDoc;
  if (trackIds.length === 0) throw new Error("Select at least one track to bounce");
  if (!bufferId) throw new Error("bufferId required for bounced clip");
  // Use first track as destination (or first selected)
  const trackId = trackIds[0];
  return addAudioClip(doc, trackId, bufferId, startBar, lengthBars, { gain: 1, stretchRate: 1 });
}

export function splitAudioClipAtTick(doc: ProjectDocument, clipId: string, splitTick: number): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  const startTick = clip.startBar * BAR_TICKS;
  const endTick = startTick + clip.lengthBars * BAR_TICKS;
  if (splitTick <= startTick || splitTick >= endTick) throw new Error("Split point outside clip");
  const leftBars = (splitTick - startTick) / BAR_TICKS;
  const rightBars = clip.lengthBars - leftBars;
  if (leftBars < 0.05 || rightBars < 0.05) throw new Error("Split too close to edge");
  const secondsPerTick = 60 / (doc.bpm * PPQ);
  const leftSec = leftBars * BAR_TICKS * secondsPerTick;
  const rightOffset = (clip.offsetSec ?? 0) + (clip.trimStart ?? 0) + leftSec * (clip.stretchRate ?? 1);
  const leftId = uid("audioClip");
  const rightId = uid("audioClip");
  const leftClip: import("../project-model/types").AudioClip = {
    ...clip,
    id: leftId,
    lengthBars: Math.round(leftBars * 100) / 100,
  };
  const rightClip: import("../project-model/types").AudioClip = {
    ...clip,
    id: rightId,
    startBar: splitTick / BAR_TICKS,
    lengthBars: Math.round(rightBars * 100) / 100,
    offsetSec: clip.reverse ? clip.offsetSec : Math.max(0, rightOffset - (clip.trimStart ?? 0)),
    // For reverse, keep offset as is — approximate
  };
  // Fix reverse offset handling: keep original for now if reverse
  if (clip.reverse) {
    rightClip.offsetSec = clip.offsetSec;
    leftClip.offsetSec = Math.max(
      0,
      (clip.offsetSec ?? 0) + rightBars * BAR_TICKS * secondsPerTick * (clip.stretchRate ?? 1),
    );
  }
  const nextClips = (doc.arrangement.audioClips ?? [])
    .filter((c) => c.id !== clipId)
    .concat([leftClip, rightClip])
    .sort((a, b) => a.startBar - b.startBar);
  const next: ProjectDocument = { ...doc, arrangement: { ...doc.arrangement, audioClips: nextClips } };
  return snapshot("splitAudioClip", `Split audio clip at bar ${(splitTick / BAR_TICKS + 1).toFixed(2)}`, doc, next);
}

export function stripSilenceAudioClip(
  doc: ProjectDocument,
  clipId: string,
  segments: Array<{ startSec: number; endSec: number }>,
): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  if (segments.length === 0) throw new Error("No non-silent segments");
  if (
    segments.length === 1 &&
    Math.abs(segments[0].startSec - (clip.offsetSec ?? 0)) < 0.001 &&
    Math.abs(segments[0].endSec - ((clip.offsetSec ?? 0) + (clip.lengthBars * BAR_TICKS * 60) / (doc.bpm * PPQ))) < 0.1
  ) {
    throw new Error("No silence to strip");
  }
  const secondsPerTick = 60 / (doc.bpm * PPQ);
  const startTick = clip.startBar * BAR_TICKS;
  const newClips: import("../project-model/types").AudioClip[] = segments.map((seg) => {
    const segDurSec = seg.endSec - seg.startSec;
    const segBars = segDurSec / secondsPerTick / BAR_TICKS;
    const segStartTick = startTick + (seg.startSec - (clip.offsetSec ?? 0)) / secondsPerTick;
    return {
      ...clip,
      id: uid("audioClip"),
      startBar: segStartTick / BAR_TICKS,
      lengthBars: Math.max(0.05, Math.round(segBars * 100) / 100),
      offsetSec: seg.startSec,
      trimStart: 0,
      trimEnd: 0,
    } as import("../project-model/types").AudioClip;
  });
  // Keep original clip's track/color but replace single with many
  const nextClips = (doc.arrangement.audioClips ?? [])
    .filter((c) => c.id !== clipId)
    .concat(newClips)
    .sort((a, b) => a.startBar - b.startBar);
  const next: ProjectDocument = { ...doc, arrangement: { ...doc.arrangement, audioClips: nextClips } };
  return snapshot("stripSilence", `Strip silence → ${newClips.length} clips`, doc, next);
}

export function consolidateAudioClips(doc: ProjectDocument, clipIds: string[]): Command {
  const clips = (doc.arrangement.audioClips ?? []).filter((c) => clipIds.includes(c.id));
  if (clips.length < 2) throw new Error("Select at least 2 audio clips to consolidate");
  const trackIds = new Set(clips.map((c) => c.trackId));
  if (trackIds.size > 1) throw new Error("Consolidate requires clips on same track");
  const sorted = [...clips].sort((a, b) => a.startBar - b.startBar);
  const minStart = Math.min(...sorted.map((c) => c.startBar));
  const maxEnd = Math.max(...sorted.map((c) => c.startBar + c.lengthBars));
  const totalBars = maxEnd - minStart;
  // Guardrail: build stem for the track's group
  const stemDoc = buildStemProject(doc, (t) => t.id === sorted[0].trackId);
  void stemDoc;
  const first = sorted[0];
  const consolidated: import("../project-model/types").AudioClip = {
    ...first,
    id: uid("audioClip"),
    startBar: minStart,
    lengthBars: Math.round(totalBars * 100) / 100,
  };
  const remaining = (doc.arrangement.audioClips ?? []).filter((c) => !clipIds.includes(c.id));
  const nextClips = [...remaining, consolidated].sort((a, b) => a.startBar - b.startBar);
  const next: ProjectDocument = { ...doc, arrangement: { ...doc.arrangement, audioClips: nextClips } };
  return snapshot("consolidateAudioClips", `Consolidate ${clips.length} clips`, doc, next);
}

/**
 * Duplicate all musical material inside a timeRange [fromTick, toTick) and
 * insert the copy immediately after the range, shifting later clips forward.
 * Operates on arrangement clips (wholly inside), notes and steps (active
 * patterns). One undo via snapshot(). Guardrails: buildStemProject is
 * exercised for the zone's stem so consolidate stays in sync with bounce
 * routing (group FX preserved).
 */
export function duplicateTimeRange(doc: ProjectDocument, fromTick: number, toTick: number): Command {
  const from = Math.min(fromTick, toTick);
  const to = Math.max(fromTick, toTick);
  if (from === to) throw new Error("Cannot duplicate empty time range");
  const delta = to - from;
  const deltaBars = delta / BAR_TICKS;
  const fromStep = Math.floor(from / STEP_TICKS);
  const toStepEx = Math.ceil(to / STEP_TICKS);
  const deltaSteps = toStepEx - fromStep;
  // Verify stem routing for tracks that contribute to the zone (guardrail)
  const zoneTrackIds = new Set<string>();
  for (const clip of doc.arrangement.clips) {
    const cFrom = clip.startBar * BAR_TICKS;
    const cTo = (clip.startBar + clip.lengthBars) * BAR_TICKS;
    if (cFrom >= from && cTo <= to) {
      const scene = doc.scenes.find((s) => s.id === clip.sceneId);
      if (scene) {
        const pat = doc.patterns.find((p) => p.id === scene.patternId);
        if (pat) {
          for (const t of doc.tracks) if (pat.rows[t.id] || pat.notes?.[t.id]) zoneTrackIds.add(t.id);
        }
      }
    }
  }
  for (const pattern of doc.patterns) {
    for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
      if (notes.some((n) => n.start >= from && n.start < to)) zoneTrackIds.add(trackId);
    }
    for (const [padId, row] of Object.entries(pattern.rows)) {
      for (let s = fromStep; s < toStepEx && s < row.length; s++) if (row[s] > 0) zoneTrackIds.add(padId);
    }
  }
  // Exercise buildStemProject so consolidation and duplicate stay consistent
  void buildStemProject(doc, (t) => zoneTrackIds.has(t.id));

  let nextDoc: ProjectDocument = { ...doc };

  // 1) Arrangement clips: wholly-inside are duplicated; trailing clips are shifted forward by deltaBars
  const whollyInside = doc.arrangement.clips.filter((c) => {
    const cFrom = c.startBar * BAR_TICKS;
    const cTo = (c.startBar + c.lengthBars) * BAR_TICKS;
    return cFrom >= from && cTo <= to;
  });
  const trailingIds = new Set(doc.arrangement.clips.filter((c) => c.startBar * BAR_TICKS >= to).map((c) => c.id));
  const baseClips: ArrangementClip[] = doc.arrangement.clips.map((c) =>
    trailingIds.has(c.id) ? { ...c, startBar: c.startBar + deltaBars } : c,
  );
  const duplicatedClips: ArrangementClip[] = whollyInside.map((c) => ({
    id: uid("clip"),
    sceneId: c.sceneId,
    startBar: c.startBar + deltaBars,
    lengthBars: c.lengthBars,
  }));
  const nextClips = [...baseClips, ...duplicatedClips].sort((a, b) => a.startBar - b.startBar);
  // Preserve transitions where possible (sanitize prunes dangling ones)
  const nextTransitions = sanitizeArrangementTransitions(doc.arrangement.transitions, nextClips);
  nextDoc = {
    ...nextDoc,
    arrangement: {
      ...nextDoc.arrangement,
      clips: nextClips,
      ...(nextTransitions ? { transitions: nextTransitions } : { transitions: undefined }),
    },
  };

  // Markers inside zone are duplicated; trailing markers are shifted
  const nextMarkers = doc.markers.flatMap((m) => {
    if (m.tick >= from && m.tick < to) {
      return [m, { ...m, id: uid("marker"), tick: m.tick + delta }];
    }
    if (m.tick >= to) return [{ ...m, tick: m.tick + delta }];
    return [m];
  });

  nextDoc = { ...nextDoc, markers: nextMarkers };

  // 2) Patterns: duplicate notes and steps; extend pattern if needed
  const nextPatterns: Pattern[] = nextDoc.patterns.map((pattern) => {
    const patternTicks = pattern.stepCount * STEP_TICKS;
    // Notes
    const notesEntries = Object.entries(pattern.notes ?? {});
    let maxEnd = patternTicks;
    const nextNotes: Record<string, NoteEvent[]> = {};
    let notesChanged = false;
    for (const [trackId, notes] of notesEntries) {
      const inside = notes.filter((n) => n.start >= from && n.start < to);
      if (inside.length === 0) {
        nextNotes[trackId] = notes;
        continue;
      }
      const copies = inside.map((n) => ({ ...n, id: uid("note"), start: n.start + delta }));
      for (const c of copies) maxEnd = Math.max(maxEnd, c.start + c.duration);
      nextNotes[trackId] = [...notes, ...copies].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      notesChanged = true;
    }
    // Include empty trackId entries that only had step duplicates? Keep as is.
    for (const [tid, nlist] of Object.entries(pattern.notes ?? {})) if (!nextNotes[tid]) nextNotes[tid] = nlist;

    // Rows + stepMeta
    const nextRows: Record<string, number[]> = {};
    let rowsChanged = false;
    let nextStepMeta = pattern.stepMeta ? cloneStepMeta(pattern.stepMeta) : undefined;
    let neededSteps = pattern.stepCount;
    // Determine needed steps from note copies
    if (maxEnd > patternTicks) neededSteps = Math.max(neededSteps, Math.ceil(maxEnd / STEP_TICKS));
    for (const [padId, row] of Object.entries(pattern.rows)) {
      let newRow = [...row];
      // Ensure row can hold duplicated steps
      const requiredLen = toStepEx + deltaSteps;
      if (requiredLen > newRow.length) {
        newRow = [...newRow, ...new Array(requiredLen - newRow.length).fill(0)];
        neededSteps = Math.max(neededSteps, newRow.length);
      }
      let changed = false;
      for (let s = fromStep; s < toStepEx && s < row.length; s++) {
        const vel = row[s];
        if (vel > 0) {
          const dst = s + deltaSteps;
          if (dst < newRow.length) {
            newRow[dst] = vel;
            changed = true;
            const meta = pattern.stepMeta?.[padId]?.[s];
            if (meta) {
              if (!nextStepMeta) nextStepMeta = {};
              if (!nextStepMeta[padId]) nextStepMeta[padId] = {};
              nextStepMeta[padId][dst] = { ...meta, ...(meta.locks ? { locks: { ...meta.locks } } : {}) };
            }
          }
        }
      }
      nextRows[padId] = newRow;
      if (changed) rowsChanged = true;
    }
    // Ensure all rows same length = neededSteps
    for (const padId of Object.keys(nextRows)) {
      const r = nextRows[padId];
      if (r.length < neededSteps) nextRows[padId] = [...r, ...new Array(neededSteps - r.length).fill(0)];
      else if (r.length > neededSteps) neededSteps = r.length;
    }
    // Final harmonize length if needed
    if (neededSteps !== pattern.stepCount) {
      for (const padId of Object.keys(nextRows)) {
        const r = nextRows[padId];
        if (r.length < neededSteps) nextRows[padId] = [...r, ...new Array(neededSteps - r.length).fill(0)];
        if (r.length > neededSteps) nextRows[padId] = r.slice(0, neededSteps);
      }
    }
    if (!notesChanged && !rowsChanged && neededSteps === pattern.stepCount) return pattern;
    return {
      ...pattern,
      stepCount: neededSteps,
      rows: Object.keys(nextRows).length > 0 ? nextRows : pattern.rows,
      notes: Object.keys(nextNotes).length > 0 ? nextNotes : pattern.notes,
      stepMeta: nextStepMeta && Object.keys(nextStepMeta).length > 0 ? nextStepMeta : undefined,
    };
  });
  nextDoc = { ...nextDoc, patterns: nextPatterns };

  return snapshot("duplicateTimeRange", `Duplicate zone ${Math.round(deltaBars * 10) / 10} bars`, doc, nextDoc);
}

/**
 * Consolidate the timeRange into a single clip backed by a stem-project
 * filtered to the zone's contributing tracks. V1 semantics (no AudioClip yet):
 * collect notes/rows inside the zone, move them into a new pattern, create
 * a new scene+clip at the zone start, and remove the source material inside
 * the zone from all patterns plus the wholly-inside arrangement clips.
 * The stem project is built so that when AudioClip / frozen render lands the
 * track selection (including parent groups) is already correct.
 */
export function consolidateTimeRange(doc: ProjectDocument, fromTick: number, toTick: number): Command {
  const from = Math.min(fromTick, toTick);
  const to = Math.max(fromTick, toTick);
  if (from === to) throw new Error("Cannot consolidate empty time range");
  const delta = to - from;
  const deltaBars = delta / BAR_TICKS;
  const fromBar = from / BAR_TICKS;
  const fromStep = Math.floor(from / STEP_TICKS);
  const toStepEx = Math.ceil(to / STEP_TICKS);
  const zoneSteps = toStepEx - fromStep;
  if (zoneSteps <= 0) throw new Error("Zone too small to consolidate");

  // Collect zone track affinity for stem filtering
  const zoneTrackIds = new Set<string>();
  for (const clip of doc.arrangement.clips) {
    const cFrom = clip.startBar * BAR_TICKS;
    const cTo = (clip.startBar + clip.lengthBars) * BAR_TICKS;
    if (cFrom < to && cTo > from) {
      const scene = doc.scenes.find((s) => s.id === clip.sceneId);
      if (scene) {
        const pat = doc.patterns.find((p) => p.id === scene.patternId);
        if (pat)
          for (const t of doc.tracks) if (pat.rows[t.id] !== undefined || pat.notes?.[t.id]) zoneTrackIds.add(t.id);
      }
    }
  }
  for (const pattern of doc.patterns) {
    for (const [trackId, notes] of Object.entries(pattern.notes ?? {}))
      if (notes.some((n) => n.start >= from && n.start < to)) zoneTrackIds.add(trackId);
    for (const [padId, row] of Object.entries(pattern.rows))
      for (let s = fromStep; s < toStepEx && s < row.length; s++) if (row[s] > 0) zoneTrackIds.add(padId);
  }
  // Guardrail: build the stem project so group parents are pulled in
  const stemProject = buildStemProject(doc, (t) => zoneTrackIds.has(t.id));
  void stemProject;

  // Gather zone's musical content shifted to 0
  const consolidatedNotes: Record<string, NoteEvent[]> = {};
  const consolidatedRows: Record<string, number[]> = {};
  const consolidatedMeta: NonNullable<Pattern["stepMeta"]> = {};
  // Use first drum pad list as row template
  const drumPadIds = doc.tracks
    .filter((t): t is DrumTrack => t.kind === "drum")
    .flatMap((t) => t.pads.map((p) => p.id));
  for (const padId of drumPadIds) consolidatedRows[padId] = new Array<number>(zoneSteps).fill(0);

  for (const pattern of doc.patterns) {
    for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
      for (const n of notes)
        if (n.start >= from && n.start < to) {
          const shifted = { ...n, id: uid("note"), start: n.start - from };
          if (!consolidatedNotes[trackId]) consolidatedNotes[trackId] = [];
          consolidatedNotes[trackId].push(shifted);
        }
    }
    for (const [padId, row] of Object.entries(pattern.rows)) {
      if (!consolidatedRows[padId]) consolidatedRows[padId] = new Array<number>(zoneSteps).fill(0);
      for (let s = fromStep; s < toStepEx && s < row.length; s++)
        if (row[s] > 0) {
          const dst = s - fromStep;
          consolidatedRows[padId][dst] = row[s];
          const meta = pattern.stepMeta?.[padId]?.[s];
          if (meta) {
            if (!consolidatedMeta[padId]) consolidatedMeta[padId] = {};
            consolidatedMeta[padId][dst] = { ...meta, ...(meta.locks ? { locks: { ...meta.locks } } : {}) };
          }
        }
    }
  }
  // Prune empty rows / notes
  for (const padId of Object.keys(consolidatedRows))
    if (consolidatedRows[padId].every((v) => v === 0)) delete consolidatedRows[padId];
  for (const tid of Object.keys(consolidatedNotes))
    consolidatedNotes[tid].sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  const hasContent = Object.keys(consolidatedRows).length > 0 || Object.keys(consolidatedNotes).length > 0;
  if (!hasContent) throw new Error("Nothing to consolidate in this zone");

  const newPattern: Pattern = {
    id: uid("pattern"),
    name: `Zone ${Math.round(fromBar + 1)}–${Math.round(fromBar + deltaBars + 1)} consolidated`,
    stepCount: zoneSteps,
    rows: consolidatedRows,
    notes: consolidatedNotes,
    stepMeta: Object.keys(consolidatedMeta).length > 0 ? consolidatedMeta : undefined,
  };
  const newScene: Scene = {
    id: uid("scene"),
    name: newPattern.name,
    patternId: newPattern.id,
    intensity: 0.7,
  };
  const newClip: ArrangementClip = {
    id: uid("clip"),
    sceneId: newScene.id,
    startBar: fromBar,
    lengthBars: deltaBars,
  };

  // Remove wholly-inside clips and source notes/rows inside zone
  const whollyInsideIds = new Set(
    doc.arrangement.clips
      .filter((c) => {
        const cFrom = c.startBar * BAR_TICKS;
        const cTo = (c.startBar + c.lengthBars) * BAR_TICKS;
        return cFrom >= from && cTo <= to;
      })
      .map((c) => c.id),
  );
  let nextPatterns: Pattern[] = doc.patterns.map((pattern) => {
    let changed = false;
    const nextNotes: Record<string, NoteEvent[]> = {};
    for (const [tid, notes] of Object.entries(pattern.notes ?? {})) {
      const filtered = notes.filter((n) => !(n.start >= from && n.start < to));
      nextNotes[tid] = filtered;
      if (filtered.length !== notes.length) changed = true;
    }
    const nextRows: Record<string, number[]> = { ...pattern.rows };
    let nextMeta = pattern.stepMeta ? cloneStepMeta(pattern.stepMeta) : undefined;
    for (const [padId, row] of Object.entries(pattern.rows)) {
      let rowChanged = false;
      const newRow = [...row];
      for (let s = fromStep; s < toStepEx && s < newRow.length; s++)
        if (newRow[s] !== 0) {
          newRow[s] = 0;
          rowChanged = true;
        }
      if (rowChanged) {
        nextRows[padId] = newRow;
        changed = true;
        if (nextMeta?.[padId]) {
          for (let s = fromStep; s < toStepEx; s++) delete nextMeta[padId][s];
          if (Object.keys(nextMeta[padId]).length === 0) delete nextMeta[padId];
        }
      }
    }
    if (nextMeta && Object.keys(nextMeta).length === 0) nextMeta = undefined;
    if (!changed) return pattern;
    return { ...pattern, notes: nextNotes, rows: nextRows, stepMeta: nextMeta };
  });

  nextPatterns = [...nextPatterns, newPattern];
  const nextScenes = [...doc.scenes, newScene];
  const remainingClips = doc.arrangement.clips.filter((c) => !whollyInsideIds.has(c.id));
  const nextClips = [...remainingClips, newClip].sort((a, b) => a.startBar - b.startBar);
  const nextTransitions = sanitizeArrangementTransitions(doc.arrangement.transitions, nextClips);

  const nextDoc: ProjectDocument = {
    ...doc,
    patterns: nextPatterns,
    scenes: nextScenes,
    arrangement: {
      clips: nextClips,
      ...(nextTransitions ? { transitions: nextTransitions } : { transitions: undefined }),
    },
  };
  return snapshot("consolidateTimeRange", `Consolidate zone ${Math.round(deltaBars * 10) / 10} bars`, doc, nextDoc);
}

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

/* ---------------- automation ---------------- */

export function automationLaneOf(doc: ProjectDocument, laneId: string): AutomationLane | undefined {
  return doc.automation.find((l) => l.id === laneId);
}

export function addAutomationLane(doc: ProjectDocument, target: AutomationTarget): Command {
  const track = doc.tracks.find((t) => t.id === target.trackId);
  if (!track) throw new Error(`Track ${target.trackId} not found`);
  if (target.kind === "fxParam") {
    if (!target.fxId) throw new Error("fxParam target requires fxId");
    if (!("effects" in track) || !track.effects.some((f) => f.id === target.fxId)) {
      throw new Error(`Effect ${target.fxId} not found on track ${target.trackId}`);
    }
  }
  if (target.kind === "instParam" && track.kind !== "instrument") {
    throw new Error(`instParam target requires an instrument track`);
  }
  if ((target.kind === "fxParam" || target.kind === "instParam") && !target.paramId) {
    throw new Error(`${target.kind} target requires paramId`);
  }
  const exists = doc.automation.some(
    (l) =>
      l.target.kind === target.kind &&
      l.target.trackId === target.trackId &&
      l.target.fxId === target.fxId &&
      l.target.paramId === target.paramId,
  );
  if (exists) throw new Error("Automation lane for this target already exists");
  const lane: AutomationLane = { id: uid("lane"), target, points: [] };
  const next: ProjectDocument = { ...doc, automation: [...doc.automation, lane] };
  return snapshot("addAutomationLane", "Add automation lane", doc, next);
}

export function removeAutomationLane(doc: ProjectDocument, laneId: string): Command {
  const next: ProjectDocument = { ...doc, automation: doc.automation.filter((l) => l.id !== laneId) };
  return snapshot("removeAutomationLane", "Remove automation lane", doc, next);
}

function withLane(doc: ProjectDocument, laneId: string, fn: (lane: AutomationLane) => AutomationLane): ProjectDocument {
  return { ...doc, automation: doc.automation.map((l) => (l.id === laneId ? fn(l) : l)) };
}

export function addAutomationPoint(doc: ProjectDocument, laneId: string, tick: number, value: number): Command {
  const lane = automationLaneOf(doc, laneId);
  if (!lane) throw new Error(`Lane ${laneId} not found`);
  const point = { tick: Math.max(0, Math.round(tick)), value };
  return {
    type: "addAutomationPoint",
    label: "Add automation point",
    execute: (d) => withLane(d, laneId, (l) => ({ ...l, points: insertPointSorted(l.points, point) })),
    undo: (d) =>
      withLane(d, laneId, (l) => {
        // Inverse of the sorted insert: remove one instance of that (tick, value).
        const idx = l.points.findIndex((p) => p.tick === point.tick && p.value === point.value);
        if (idx === -1) return l;
        const points = [...l.points];
        points.splice(idx, 1);
        return { ...l, points };
      }),
  };
}

export function moveAutomationPoint(
  doc: ProjectDocument,
  laneId: string,
  index: number,
  delta: { tick?: number; value?: number },
): Command {
  const lane = automationLaneOf(doc, laneId);
  if (!lane || index < 0 || index >= lane.points.length) throw new Error("Automation point not found");
  const prev = lane.points;
  return {
    type: "moveAutomationPoint",
    label: "Move automation point",
    execute: (d) =>
      withLane(d, laneId, (l) => {
        const points = [...l.points];
        const p = points[index];
        points[index] = {
          tick: Math.max(0, Math.round(delta.tick ?? p.tick)),
          value: delta.value ?? p.value,
        };
        return { ...l, points: points.sort((a, b) => a.tick - b.tick) };
      }),
    undo: (d) => withLane(d, laneId, (l) => ({ ...l, points: prev })),
  };
}

export function deleteAutomationPoint(doc: ProjectDocument, laneId: string, index: number): Command {
  const lane = automationLaneOf(doc, laneId);
  if (!lane || index < 0 || index >= lane.points.length) throw new Error("Automation point not found");
  const removed = lane.points[index];
  return {
    type: "deleteAutomationPoint",
    label: "Delete automation point",
    execute: (d) => withLane(d, laneId, (l) => ({ ...l, points: l.points.filter((_, i) => i !== index) })),
    undo: (d) =>
      withLane(d, laneId, (l) => {
        if (l.points.some((p) => p === removed)) return l;
        const points = [...l.points];
        points.splice(Math.min(index, points.length), 0, removed);
        return { ...l, points };
      }),
  };
}

/* ---------------- LFO / modulators ---------------- */

/** Fresh seed for a random modulator. The seed itself is stored — streams are deterministic once created. */
export function newModulatorSeed(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function addLfo(doc: ProjectDocument, trackId: string, kind: LfoKind = "osc"): Command {
  const id = uid("lfo");
  let lfo: Lfo;
  if (kind === "random") {
    lfo = {
      id,
      trackId,
      kind,
      param: "gain",
      snh: "hold",
      rateMode: "sync",
      rateHz: 8,
      division: 3,
      amount: 0.4,
      seed: newModulatorSeed(),
    };
  } else if (kind === "step") {
    lfo = {
      id,
      trackId,
      kind,
      param: "gain",
      division: 3,
      glideSec: 0.02,
      amount: 0.6,
      steps: [...DEFAULT_STEP_PATTERN],
    };
  } else if (kind === "envFollower") {
    lfo = {
      id,
      trackId,
      kind,
      param: "gain",
      sourceTrackId: trackId,
      attackMs: 12,
      releaseMs: 180,
      sensitivity: 1.5,
      amount: 0.5,
    };
  } else {
    lfo = { id, trackId, param: "gain", wave: "sine", rateMode: "sync", rateHz: 2, division: 2, amount: 0.3 };
  }
  const next: ProjectDocument = { ...doc, lfos: [...doc.lfos, lfo] };
  return snapshot("addLfo", ADD_LFO_LABELS[kind], doc, next);
}

const ADD_LFO_LABELS: Record<LfoKind, string> = {
  osc: "Add LFO",
  random: "Add Random S&H",
  step: "Add Step Modulator",
  envFollower: "Add Envelope Follower",
};

export function removeLfo(doc: ProjectDocument, lfoId: string): Command {
  const next: ProjectDocument = { ...doc, lfos: doc.lfos.filter((l) => l.id !== lfoId) };
  return snapshot("removeLfo", "Remove LFO", doc, next);
}

export function setLfoParams(
  doc: ProjectDocument,
  lfoId: string,
  patch: Partial<Omit<Lfo, "id" | "trackId">>,
): Command {
  const prev: Partial<Omit<Lfo, "id" | "trackId">> = {};
  const current = doc.lfos.find((l) => l.id === lfoId);
  if (!current) throw new Error(`LFO ${lfoId} not found`);
  for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
    (prev as Record<string, unknown>)[key] = current[key];
  }
  const apply = (d: ProjectDocument, values: Partial<Omit<Lfo, "id" | "trackId">>): ProjectDocument => ({
    ...d,
    lfos: d.lfos.map((l) => (l.id === lfoId ? { ...l, ...values } : l)),
  });
  return {
    type: "setLfoParams",
    label: "Edit LFO",
    execute: (d) => apply(d, patch),
    undo: (d) => apply(d, prev),
  };
}

/* ---------------- macros ---------------- */

export function setMacroValue(doc: ProjectDocument, macroId: string, value: number): Command {
  const prev = doc.macros.find((m) => m.id === macroId)?.value ?? 0.5;
  const clamped = clamp(value, 0, 1);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    macros: d.macros.map((m) => (m.id === macroId ? { ...m, value: v } : m)),
  });
  return {
    type: "setMacroValue",
    label: "Set macro",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const macros = yMap.get("macros") as any;
      for (let i = 0; i < macros.length; i++) {
        const m = macros.get(i);
        if (m.get("id") === macroId) {
          m.set("value", clamped);
          break;
        }
      }
    },
  };
}

export function renameMacro(doc: ProjectDocument, macroId: string, name: string): Command {
  const prev = doc.macros.find((m) => m.id === macroId)?.name ?? "";
  const apply = (d: ProjectDocument, v: string): ProjectDocument => ({
    ...d,
    macros: d.macros.map((m) => (m.id === macroId ? { ...m, name: v } : m)),
  });
  return {
    type: "renameMacro",
    label: `Rename macro to "${name}"`,
    execute: (d) => apply(d, name),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const macros = yMap.get("macros") as any;
      for (let i = 0; i < macros.length; i++) {
        const m = macros.get(i);
        if (m.get("id") === macroId) {
          m.set("name", name);
          break;
        }
      }
    },
  };
}

export function addMacroMapping(
  doc: ProjectDocument,
  macroId: string,
  trackId: string,
  param: "gain" | "pan",
): Command {
  if (!doc.tracks.some((t) => t.id === trackId)) throw new Error(`Track ${trackId} not found`);
  if (!doc.macros.some((m) => m.id === macroId)) throw new Error(`Macro ${macroId} not found`);
  const mapping = { id: uid("map"), trackId, param, amount: 0.5 };
  const next: ProjectDocument = {
    ...dMap(doc, macroId, (m) => ({ ...m, mappings: [...m.mappings, mapping] })),
  };
  return snapshot("addMacroMapping", "Add macro mapping", doc, next);
}

export function addMacroMappingMidiCC(
  doc: ProjectDocument,
  macroId: string,
  trackId: string,
  param: "gain" | "pan" | string,
  ccNumber: number,
  channel?: number,
): Command {
  if (!doc.tracks.some((t) => t.id === trackId)) throw new Error(`Track ${trackId} not found`);
  if (!doc.macros.some((m) => m.id === macroId)) throw new Error(`Macro ${macroId} not found`);
  if (!Number.isFinite(ccNumber) || ccNumber < 0 || ccNumber > 127) throw new Error("Invalid CC number");
  const mapping: import("../project-model/types").MacroMapping = {
    id: uid("map"),
    trackId,
    param,
    amount: 0.5,
    source: "midiCC",
    ccNumber: Math.floor(ccNumber),
    ...(channel !== undefined ? { channel: Math.floor(channel) } : {}),
  };
  const next: ProjectDocument = {
    ...dMap(doc, macroId, (m) => ({ ...m, mappings: [...m.mappings, mapping] })),
  };
  return snapshot("addMacroMappingMidiCC", `Map CC${ccNumber} → ${param}`, doc, next);
}

export function removeMacroMapping(doc: ProjectDocument, macroId: string, mappingId: string): Command {
  const next: ProjectDocument = {
    ...dMap(doc, macroId, (m) => ({ ...m, mappings: m.mappings.filter((x) => x.id !== mappingId) })),
  };
  return snapshot("removeMacroMapping", "Remove macro mapping", doc, next);
}

export function setMacroMappingAmount(
  doc: ProjectDocument,
  macroId: string,
  mappingId: string,
  amount: number,
): Command {
  const prev = doc.macros.find((m) => m.id === macroId)?.mappings.find((x) => x.id === mappingId)?.amount;
  if (prev === undefined) throw new Error("Macro mapping not found");
  const clamped = clamp(amount, -1, 1);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    macros: d.macros.map((m) =>
      m.id === macroId ? { ...m, mappings: m.mappings.map((x) => (x.id === mappingId ? { ...x, amount: v } : x)) } : m,
    ),
  });
  return {
    type: "setMacroMappingAmount",
    label: "Set macro amount",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
  };
}

function dMap(doc: ProjectDocument, macroId: string, fn: (m: Macro) => Macro): ProjectDocument {
  return { ...doc, macros: doc.macros.map((m) => (m.id === macroId ? fn(m) : m)) };
}

/* ---------------- master / sends / returns ---------------- */

export function setMasterConfig(doc: ProjectDocument, patch: Partial<MasterConfig>): Command {
  const prev = { ...doc.master };
  return {
    type: "setMasterConfig",
    label: "Edit master chain",
    execute: (d) => ({ ...d, master: { ...d.master, ...patch } }),
    undo: (d) => ({ ...d, master: prev }),
    applyToYDoc: (yMap) => {
      const master = yMap.get("master") as any;
      if (master)
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined) master.set(k, v);
        }
    },
  };
}

export function setTrackSend(doc: ProjectDocument, trackId: string, returnId: string, level: number): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  const prev = track.sends[returnId] ?? 0;
  const clamped = clamp(level, 0, 1.5);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) => (t.id === trackId ? { ...t, sends: { ...t.sends, [returnId]: v } } : t)),
  });
  return {
    type: "setTrackSend",
    label: "Set send level",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i);
        if (t.get("id") === trackId) {
          (t.get("sends") as any).set(returnId, clamped);
          break;
        }
      }
    },
  };
}

export function setReturnGain(doc: ProjectDocument, returnId: string, gain: number): Command {
  const prev = doc.returns.find((r) => r.id === returnId)?.gain ?? 0.9;
  const clamped = clamp(gain, 0, 1.5);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    returns: d.returns.map((r) => (r.id === returnId ? { ...r, gain: v } : r)),
  });
  return {
    type: "setReturnGain",
    label: "Set return gain",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const returns = yMap.get("returns") as any;
      for (let i = 0; i < returns.length; i++) {
        const r = returns.get(i);
        if (r.get("id") === returnId) {
          r.set("gain", clamped);
          break;
        }
      }
    },
  };
}

/* ---------------- effects ---------------- */

function withTrackEffects(
  doc: ProjectDocument,
  trackId: string,
  fn: (effects: EffectInstance[]) => EffectInstance[],
): ProjectDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((t) => (t.id === trackId && "effects" in t ? { ...t, effects: fn(t.effects) } : t)),
  };
}

function trackEffectsOf(doc: ProjectDocument, trackId: string): EffectInstance[] {
  const track = doc.tracks.find((t) => t.id === trackId);
  return track && "effects" in track ? track.effects : [];
}

export function addEffect(_doc: ProjectDocument, trackId: string, type: EffectType): Command {
  const fx: EffectInstance = { id: uid("fx"), type, bypassed: false, params: defaultParamsOf(type) };
  if (type === "stepGate") fx.steps = [...DEFAULT_GATE_PATTERN];
  if (type === "stutter") fx.steps = Array.from({ length: 16 }, () => 1);
  return {
    type: "addEffect",
    label: `Add ${EFFECT_DEFS[type].name}`,
    execute: (d) => withTrackEffects(d, trackId, (effects) => [...effects, fx]),
    undo: (d) => withTrackEffects(d, trackId, (effects) => effects.filter((f) => f.id !== fx.id)),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i) as any;
        if (t.get("id") === trackId) {
          const effects = t.get("effects") as any;
          const Y = require("yjs");
          const fxMap = new Y.Map();
          fxMap.set("id", fx.id);
          fxMap.set("type", fx.type);
          fxMap.set("bypassed", false);
          const params = new Y.Map();
          fxMap.set("params", params);
          for (const [k, v] of Object.entries(fx.params)) params.set(k, v);
          if (fx.steps) fxMap.set("steps", [...fx.steps]);
          effects.push([fxMap]);
          break;
        }
      }
    },
  };
}

export function removeEffect(doc: ProjectDocument, trackId: string, fxId: string): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  const targetIndex = trackEffectsOf(doc, trackId).findIndex((f) => f.id === fxId);
  return {
    type: "removeEffect",
    label: `Remove ${target ? EFFECT_DEFS[target.type].name : fxId}`,
    execute: (d) => withTrackEffects(d, trackId, (effects) => effects.filter((f) => f.id !== fxId)),
    undo: (d) =>
      withTrackEffects(d, trackId, (effects) => {
        if (!target || effects.some((f) => f.id === fxId)) return effects;
        const copy = [...effects];
        copy.splice(Math.max(0, Math.min(targetIndex, copy.length)), 0, target);
        return copy;
      }),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i) as any;
        if (t.get("id") === trackId) {
          const effects = t.get("effects") as any;
          for (let j = 0; j < effects.length; j++) {
            if ((effects.get(j) as any).get("id") === fxId) {
              effects.delete(j, 1);
              break;
            }
          }
          break;
        }
      }
    },
  };
}

/** Replace the step pattern of a step-sequenced effect (stepGate) — one undo step per edit stroke. */
export function setEffectSteps(doc: ProjectDocument, trackId: string, fxId: string, steps: number[]): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target) throw new Error(`Effect ${fxId} not found`);
  const prev = target.steps ? [...target.steps] : undefined;
  const next = sanitizeGateSteps(steps);
  const apply = (d: ProjectDocument, values: number[] | undefined): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) => effects.map((f) => (f.id === fxId ? { ...f, steps: values } : f)));
  return {
    type: "setEffectSteps",
    label: "Edit step pattern",
    execute: (d) => apply(d, next),
    undo: (d) => apply(d, prev),
  };
}

export function setEffectParam(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  paramId: string,
  value: number,
): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target) throw new Error(`Effect ${fxId} not found`);
  const { type, params } = target;
  const def = EFFECT_DEFS[type].params.find((p) => p.id === paramId);
  if (!def) throw new Error(`Effect param ${paramId} not defined for ${type}`);
  const eqLegacyMap: Record<string, string> = {
    lowGain: "lowShelfGain",
    lowFreq: "lowShelfFreq",
    midGain: "lowMidGain",
    midFreq: "lowMidFreq",
    midQ: "lowMidQ",
    highGain: "highShelfGain",
    highFreq: "highShelfFreq",
  };
  const canonicalId = type === "eq" ? eqLegacyMap[paramId] : undefined;
  const clamped = clampEffectParam(type, paramId, value);
  const nextValues: Record<string, number> = { [paramId]: clamped };
  if (canonicalId) nextValues[canonicalId] = clampEffectParam(type, canonicalId, value);
  const previousValues: Record<string, number> = { [paramId]: params[paramId] ?? def.default };
  if (canonicalId)
    previousValues[canonicalId] =
      params[canonicalId] ?? EFFECT_DEFS[type].params.find((p) => p.id === canonicalId)?.default ?? 0;
  const apply = (d: ProjectDocument, values: Record<string, number>): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: { ...f.params, ...values } } : f)),
    );
  return {
    type: "setEffectParam",
    label: `Set ${EFFECT_DEFS[type].name} ${paramId}`,
    execute: (d) => apply(d, nextValues),
    undo: (d) => apply(d, previousValues),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i) as any;
        if (t.get("id") === trackId) {
          const effects = t.get("effects") as any;
          for (let j = 0; j < effects.length; j++) {
            const fx = effects.get(j) as any;
            if (fx.get("id") === fxId) {
              const fxParams = fx.get("params") as any;
              for (const [id, nextValue] of Object.entries(nextValues)) fxParams.set(id, nextValue);
              break;
            }
          }
          break;
        }
      }
    },
  };
}

export function toggleEffectBypass(doc: ProjectDocument, trackId: string, fxId: string): Command {
  const prev = trackEffectsOf(doc, trackId).find((f) => f.id === fxId)?.bypassed ?? false;
  const apply = (d: ProjectDocument, bypassed: boolean): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) => effects.map((f) => (f.id === fxId ? { ...f, bypassed } : f)));
  return {
    type: "toggleEffectBypass",
    label: `${prev ? "Enable" : "Bypass"} effect`,
    execute: (d) => apply(d, !prev),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i);
        if (t.get("id") === trackId) {
          const effects = t.get("effects") as any;
          for (let j = 0; j < effects.length; j++) {
            if (effects.get(j).get("id") === fxId) {
              effects.get(j).set("bypassed", !prev);
              break;
            }
          }
          break;
        }
      }
    },
  };
}

export function moveEffect(doc: ProjectDocument, trackId: string, fxId: string, direction: -1 | 1): Command {
  const effects = trackEffectsOf(doc, trackId);
  const index = effects.findIndex((f) => f.id === fxId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= effects.length) throw new Error("Effect cannot move in that direction");
  const reordered = [...effects];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(target, 0, moved);
  const next = withTrackEffects(doc, trackId, () => reordered);
  return snapshot("moveEffect", `Reorder ${EFFECT_DEFS[moved.type].name}`, doc, next);
}
/* ---------------- metadata & scorepack ---------------- */ export function setProjectKey(
  doc: ProjectDocument,
  key: MusicalKey | null,
): Command {
  const prev = doc.key;
  const next: ProjectDocument = key
    ? { ...doc, key }
    : (() => {
        const { key: _drop, ...rest } = doc;
        return rest as ProjectDocument;
      })();
  return {
    type: "setProjectKey",
    label: key ? `Set project key to ${key}` : "Clear project key",
    execute: () => next,
    undo: (d) =>
      prev
        ? { ...d, key: prev }
        : (() => {
            const { key: _drop, ...rest } = d;
            return rest as ProjectDocument;
          })(),
  };
}
export function setProjectTags(doc: ProjectDocument, tags: string[]): Command {
  const prev = doc.tags;
  const cleaned = tags.map((t) => t.trim()).filter((t) => t.length > 0);
  return {
    type: "setProjectTags",
    label: "Edit project tags",
    execute: (d) => ({ ...d, tags: cleaned }),
    undo: (d) =>
      prev
        ? { ...d, tags: prev }
        : (() => {
            const { tags: _drop, ...rest } = d;
            return rest as ProjectDocument;
          })(),
  };
}
/* ---------------- markers ---------------- */ export function addMarker(
  doc: ProjectDocument,
  partial: { tick: number; type?: Marker["type"]; name?: string; linkedClipId?: string; customId?: string },
): Command {
  const marker: Marker = {
    id: uid("marker"),
    name: partial.name?.trim() || `Marker ${doc.markers.length + 1}`,
    type: partial.type ?? "cue",
    tick: Math.max(0, Math.floor(partial.tick)),
    linkedClipId: partial.linkedClipId,
    customId: partial.customId,
  };
  const next: ProjectDocument = { ...doc, markers: [...doc.markers, marker] };
  return snapshot("addMarker", `Add marker ${marker.name}`, doc, next);
}
export function removeMarker(doc: ProjectDocument, markerId: string): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  const next: ProjectDocument = { ...doc, markers: doc.markers.filter((m) => m.id !== markerId) };
  return snapshot("removeMarker", `Remove marker ${target.name}`, doc, next);
}
export function renameMarker(doc: ProjectDocument, markerId: string, name: string): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  const trimmed = name.trim() || target.name;
  const next = { ...doc, markers: doc.markers.map((m) => (m.id === markerId ? { ...m, name: trimmed } : m)) };
  return snapshot("renameMarker", `Rename marker to ${trimmed}`, doc, next);
}
export function setMarkerType(doc: ProjectDocument, markerId: string, type: Marker["type"]): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  const next = { ...doc, markers: doc.markers.map((m) => (m.id === markerId ? { ...m, type } : m)) };
  return snapshot("setMarkerType", `Marker type to ${type}`, doc, next);
}
export function moveMarker(doc: ProjectDocument, markerId: string, tick: number): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  const clamped = Math.max(0, Math.floor(tick));
  const next = { ...doc, markers: doc.markers.map((m) => (m.id === markerId ? { ...m, tick: clamped } : m)) };
  return snapshot("moveMarker", "Move marker", doc, next);
}
export function setMarkerLinkedClip(doc: ProjectDocument, markerId: string, linkedClipId: string | null): Command {
  const target = doc.markers.find((m) => m.id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found`);
  const next = {
    ...doc,
    markers: doc.markers.map((m) => (m.id === markerId ? { ...m, linkedClipId: linkedClipId ?? undefined } : m)),
  };
  return snapshot("setMarkerLinkedClip", "Link marker to clip", doc, next);
}
/* ---------------- scenes (intensity / loop) ---------------- */ export function setSceneIntensity(
  doc: ProjectDocument,
  sceneId: string,
  intensity: number,
): Command {
  const target = doc.scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  const clamped = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0.7));
  const next = { ...doc, scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, intensity: clamped } : s)) };
  return snapshot("setSceneIntensity", `Scene intensity to ${clamped.toFixed(2)}`, doc, next);
}
export function setSceneIntensityCurve(doc: ProjectDocument, sceneId: string, curve: IntensityPoint[]): Command {
  const target = doc.scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  const cleaned = curve
    .map((p) => ({
      offset: Math.max(0, Math.floor(p.offset)),
      value: Math.min(1, Math.max(0, Number.isFinite(p.value) ? p.value : 0)),
    }))
    .sort((a, b) => a.offset - b.offset);
  const next = {
    ...doc,
    scenes: doc.scenes.map((s) =>
      s.id === sceneId ? { ...s, intensityCurve: cleaned.length > 0 ? cleaned : undefined } : s,
    ),
  };
  return snapshot("setSceneIntensityCurve", "Scene intensity curve", doc, next);
}
export function setSceneLoop(doc: ProjectDocument, sceneId: string, loop: boolean): Command {
  const target = doc.scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  const next = { ...doc, scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, loop } : s)) };
  return snapshot("setSceneLoop", loop ? "Loop scene" : "Unloop scene", doc, next);
}
export function setArrangementClipLoop(doc: ProjectDocument, clipId: string, loop: boolean): Command {
  const target = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!target) throw new Error(`Clip ${clipId} not found`);
  const next = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: doc.arrangement.clips.map((c) => (c.id === clipId ? { ...c, loop } : c)),
    },
  };
  return snapshot("setArrangementClipLoop", loop ? "Loop clip" : "Unloop clip", doc, next);
}
/* ---------------- scene automation ---------------- */ export function addSceneAutomation(
  doc: ProjectDocument,
  sceneId: string,
  target: AutomationTarget,
): Command {
  if (!doc.scenes.some((s) => s.id === sceneId)) throw new Error(`Scene ${sceneId} not found`);
  const lane: SceneAutomation = { id: uid("sceneAuto"), sceneId, target, points: [{ tick: 0, value: 0 }] };
  const next = { ...doc, sceneAutomation: [...doc.sceneAutomation, lane] };
  return snapshot("addSceneAutomation", "Add scene lane", doc, next);
}
export function removeSceneAutomation(doc: ProjectDocument, laneId: string): Command {
  const target = doc.sceneAutomation.find((l) => l.id === laneId);
  if (!target) throw new Error(`Scene lane ${laneId} not found`);
  const next = { ...doc, sceneAutomation: doc.sceneAutomation.filter((l) => l.id !== laneId) };
  return snapshot("removeSceneAutomation", "Remove scene lane", doc, next);
}
export function addSceneAutomationPoint(doc: ProjectDocument, laneId: string, tick: number, value: number): Command {
  const lane = doc.sceneAutomation.find((l) => l.id === laneId);
  if (!lane) throw new Error(`Scene lane ${laneId} not found`);
  const next = {
    ...doc,
    sceneAutomation: doc.sceneAutomation.map((l) =>
      l.id === laneId
        ? {
            ...l,
            points: [...l.points, { tick: Math.max(0, Math.floor(tick)), value }].sort((a, b) => a.tick - b.tick),
          }
        : l,
    ),
  };
  return snapshot("addSceneAutomationPoint", "Add scene point", doc, next);
}
export function moveSceneAutomationPoint(
  doc: ProjectDocument,
  laneId: string,
  index: number,
  delta: { tick?: number; value?: number },
): Command {
  const lane = doc.sceneAutomation.find((l) => l.id === laneId);
  if (!lane) throw new Error(`Scene lane ${laneId} not found`);
  if (index < 0 || index >= lane.points.length) throw new Error("Scene point out of range");
  const next = {
    ...doc,
    sceneAutomation: doc.sceneAutomation.map((l) => {
      if (l.id !== laneId) return l;
      const points = [...l.points];
      const p = points[index];
      points[index] = {
        tick: delta.tick !== undefined ? Math.max(0, Math.floor(delta.tick)) : p.tick,
        value: delta.value !== undefined ? delta.value : p.value,
      };
      points.sort((a, b) => a.tick - b.tick);
      return { ...l, points };
    }),
  };
  return snapshot("moveSceneAutomationPoint", "Move scene point", doc, next);
}
export function removeSceneAutomationPoint(doc: ProjectDocument, laneId: string, index: number): Command {
  const lane = doc.sceneAutomation.find((l) => l.id === laneId);
  if (!lane) throw new Error(`Scene lane ${laneId} not found`);
  if (index < 0 || index >= lane.points.length) throw new Error("Scene point out of range");
  const next = {
    ...doc,
    sceneAutomation: doc.sceneAutomation.map((l) =>
      l.id === laneId ? { ...l, points: l.points.filter((_, i) => i !== index) } : l,
    ),
  };
  return snapshot("removeSceneAutomationPoint", "Remove scene point", doc, next);
}

/* ---------------- scale quantize ---------------- */

export function quantizePatternToScale(doc: ProjectDocument, patternId: string, key: MusicalKey): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const nextNotes: Record<string, import("../project-model/types").NoteEvent[]> = {};
  for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
    nextNotes[trackId] = notes.map((n) => ({
      ...n,
      pitch: snapToScale(n.pitch, key),
    }));
  }
  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) => (p.id === patternId ? { ...p, notes: nextNotes } : p)),
  };
  return snapshot("quantizePatternToScale", `Quantize to ${key}`, doc, next);
}

/* ---------------- time quantize ---------------- */

export function quantizePatternToGrid(doc: ProjectDocument, patternId: string, gridTicks: number): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  if (gridTicks <= 0) throw new Error("Grid resolution must be positive");

  const nextNotes: Record<string, import("../project-model/types").NoteEvent[]> = {};
  for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
    nextNotes[trackId] = notes.map((n) => ({
      ...n,
      start: Math.round(n.start / gridTicks) * gridTicks,
    }));
  }
  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) => (p.id === patternId ? { ...p, notes: nextNotes } : p)),
  };
  return snapshot("quantizePatternToGrid", `Quantize to grid`, doc, next);
}

// ---------------------------------------------------------------------------
// MIDI
// ---------------------------------------------------------------------------

function ensureMidi(doc: ProjectDocument): NonNullable<ProjectDocument["midi"]> {
  return (
    doc.midi ?? {
      enabled: false,
      deviceId: "",
      drumChannel: 0,
      instrumentChannel: 0,
      ccMappings: [],
      drumNoteMap: [],
      pitchBendRange: 2,
    }
  );
}

export function setMidiConfig(
  doc: ProjectDocument,
  changes: Partial<import("../project-model/types").MidiConfig>,
): Command {
  const prev = ensureMidi(doc);
  const next: ProjectDocument = { ...doc, midi: { ...prev, ...changes } };
  return snapshot("setMidiConfig", `MIDI settings`, doc, next);
}

export function addMidiCcMapping(
  doc: ProjectDocument,
  ccNumber: number,
  target: import("../project-model/types").AutomationTarget,
  min: number,
  max: number,
): Command {
  const midi = ensureMidi(doc);
  const mapping: import("../project-model/types").MidiCcMapping = { id: uid("midiMap"), ccNumber, target, min, max };
  const next: ProjectDocument = { ...doc, midi: { ...midi, ccMappings: [...midi.ccMappings, mapping] } };
  return snapshot("addMidiCcMapping", `Map CC${ccNumber}`, doc, next);
}

export function removeMidiCcMapping(doc: ProjectDocument, mappingId: string): Command {
  const midi = ensureMidi(doc);
  const next: ProjectDocument = {
    ...doc,
    midi: { ...midi, ccMappings: midi.ccMappings.filter((m) => m.id !== mappingId) },
  };
  return snapshot("removeMidiCcMapping", `Remove CC mapping`, doc, next);
}

export function setDrumNoteMapping(doc: ProjectDocument, midiNote: number, padId: string): Command {
  const midi = ensureMidi(doc);
  const existing = midi.drumNoteMap.filter((m) => m.midiNote !== midiNote);
  const next: ProjectDocument = {
    ...doc,
    midi: { ...midi, drumNoteMap: [...existing, { midiNote, padId }] },
  };
  return snapshot("setDrumNoteMapping", `Map note ${midiNote}`, doc, next);
}

export function resetDrumNoteMapping(doc: ProjectDocument): Command {
  const midi = ensureMidi(doc);
  const next: ProjectDocument = { ...doc, midi: { ...midi, drumNoteMap: [] } };
  return snapshot("resetDrumNoteMapping", `Reset drum map`, doc, next);
}

// ---------------------------------------------------------------------------
// Program Change & Bank Select
// ---------------------------------------------------------------------------

export function setTrackPreset(doc: ProjectDocument, trackId: string, presetId: string): Command {
  const track = doc.tracks.find((t) => t.id === trackId && t.kind === "instrument");
  if (!track || track.kind !== "instrument") throw new Error(`Instrument track ${trackId} not found`);
  const prev = track.presetId;
  const hadPresetId = prev !== undefined;
  const apply = (d: ProjectDocument, id: string | null | undefined): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) => {
      if (t.id !== trackId || t.kind !== "instrument") return t;
      if (id === undefined && !hadPresetId) {
        const { presetId: _, ...rest } = t as any;
        return rest;
      }
      return { ...t, presetId: id };
    }),
  });
  return {
    type: "setTrackPreset",
    label: `Program Change → ${presetId}`,
    execute: (d) => apply(d, presetId),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i);
        if (t.get("id") === trackId) {
          t.set("presetId", presetId);
          break;
        }
      }
    },
  };
}

export function setMidiProgramMap(doc: ProjectDocument, programMap: { program: number; presetId: string }[]): Command {
  const midi = ensureMidi(doc);
  const next: ProjectDocument = { ...doc, midi: { ...midi, programMap } };
  return snapshot("setMidiProgramMap", `Set program map`, doc, next);
}

// ---------------------------------------------------------------------------
// Note-Off (lifecycle extension)
// ---------------------------------------------------------------------------

// Note-off is handled at the AudioEngine level, not as a document command.
// See AudioEngine.noteOff() and MidiInput.handleNoteOff().

// ---------------------------------------------------------------------------
// Aftertouch
// ---------------------------------------------------------------------------

export function setMidiAftertouch(
  doc: ProjectDocument,
  target: import("../project-model/types").AutomationTarget,
  range: number,
): Command {
  const midi = ensureMidi(doc);
  const next: ProjectDocument = { ...doc, midi: { ...midi, aftertouchTarget: target, aftertouchRange: range } };
  return snapshot("setMidiAftertouch", `Aftertouch config`, doc, next);
}

// ---------------------------------------------------------------------------
// MIDI Output
// ---------------------------------------------------------------------------

export function setTrackMidiOutput(
  doc: ProjectDocument,
  trackId: string,
  output: { enabled: boolean; channel: number; deviceId?: string },
): Command {
  const prev = doc.tracks.find((t) => t.id === trackId);
  if (!prev) throw new Error(`Track ${trackId} not found`);
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => (t.id === trackId ? { ...t, midiOutput: output } : t)),
  };
  return snapshot("setTrackMidiOutput", `MIDI output config`, doc, next);
}

// ---------------------------------------------------------------------------
// MIDI Clock
// ---------------------------------------------------------------------------

export function setMidiClockMode(doc: ProjectDocument, clockMode: "off" | "master" | "slave"): Command {
  const midi = ensureMidi(doc);
  const next: ProjectDocument = { ...doc, midi: { ...midi, clockMode } };
  return snapshot("setMidiClockMode", `Clock mode: ${clockMode}`, doc, next);
}

// ---------------------------------------------------------------------------
// Freeze / Unfreeze
// ---------------------------------------------------------------------------

export function freezeTrack(
  doc: ProjectDocument,
  trackId: string,
  bufferId: string,
  durationSec: number,
  sampleRate: number,
): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  const label = `Freeze ${track.name}`;
  // Freeze is dispatched AFTER a seconds-long offline render — it must apply
  // to whatever document is current at dispatch time, not the snapshot taken
  // when rendering started (a snapshot silently reverts concurrent edits).
  let prevFrozen: ProjectDocument["tracks"][number]["frozen"] = undefined;
  return {
    type: "freezeTrack",
    label,
    execute: (d) => {
      if (!d.tracks.some((t) => t.id === trackId)) return d;
      prevFrozen = d.tracks.find((t) => t.id === trackId)?.frozen;
      return {
        ...d,
        tracks: d.tracks.map((t) => (t.id === trackId ? { ...t, frozen: { bufferId, durationSec, sampleRate } } : t)),
      };
    },
    undo: (d) => {
      if (!d.tracks.some((t) => t.id === trackId)) return d;
      return {
        ...d,
        tracks: d.tracks.map((t) => {
          if (t.id !== trackId) return t;
          if (prevFrozen === undefined) {
            const { frozen: _, ...rest } = t as any;
            return rest;
          }
          return { ...t, frozen: prevFrozen };
        }),
      };
    },
  };
}

export function unfreezeTrack(doc: ProjectDocument, trackId: string): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  const label = `Unfreeze ${track.name}`;
  let prevFrozen: ProjectDocument["tracks"][number]["frozen"] = undefined;
  return {
    type: "unfreezeTrack",
    label,
    execute: (d) => {
      if (!d.tracks.some((t) => t.id === trackId)) return d;
      prevFrozen = d.tracks.find((t) => t.id === trackId)?.frozen;
      return {
        ...d,
        tracks: d.tracks.map((t) => (t.id === trackId ? { ...t, frozen: undefined } : t)),
      };
    },
    undo: (d) => {
      if (!d.tracks.some((t) => t.id === trackId)) return d;
      return {
        ...d,
        tracks: d.tracks.map((t) => {
          if (t.id !== trackId) return t;
          if (prevFrozen === undefined) {
            const { frozen: _, ...rest } = t as any;
            return rest;
          }
          return { ...t, frozen: prevFrozen };
        }),
      };
    },
  };
}

/* ---------------- AI pattern generation ---------------- */

export function generatePatternCommand(doc: ProjectDocument, options: GenerateOptions, patternName?: string): Command {
  const result = generateLocalResultFromOptions(doc, options, "apply");
  const pattern = result.proposal?.pattern;
  if (!pattern) throw new Error(result.diagnostics.errors.join(", ") || "Intent generation was rejected");
  if (patternName) pattern.name = patternName;
  if (!pattern.name) pattern.name = `${options.genre} ${options.seed.slice(0, 4)}`.trim();

  // Apply groove settings from the resolved groove if requested
  let grooveUpdate: Partial<GrooveSettings> | undefined;
  if (options.applyGrooveSettings) {
    // Reuse the exact source-aware resolution path used by the generator.
    const groove = resolveGrooveForGeneration(doc, options);
    grooveUpdate = { swing: groove.swing };
  }

  if (options.replaceMode === "replace") {
    const activeId = doc.activePatternId;
    const next: ProjectDocument = {
      ...doc,
      patterns: doc.patterns.map((p) =>
        p.id === activeId
          ? {
              ...p,
              rows: pattern.rows,
              notes: pattern.notes,
              stepMeta: pattern.stepMeta,
              stepCount: pattern.stepCount,
              name: pattern.name || p.name,
              generation: pattern.generation,
            }
          : p,
      ),
      ...(grooveUpdate ? { groove: { ...doc.groove, ...grooveUpdate } } : {}),
    };
    return snapshot("generatePattern", `Replace with ${pattern.name}`, doc, next);
  }

  const scene: Scene = {
    id: uid("scene"),
    name: pattern.name,
    patternId: pattern.id,
    intensity: 0.7,
  };

  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, pattern],
    scenes: [...doc.scenes, scene],
    activePatternId: pattern.id,
    ...(grooveUpdate ? { groove: { ...doc.groove, ...grooveUpdate } } : {}),
  };
  return snapshot("generatePattern", `Generate ${pattern.name}`, doc, next);
}

/* ---------------- Pattern assist (iteration on your idea) ---------------- */

function drumPadsOf(doc: ProjectDocument): DrumPad[] {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum");
  return track ? track.pads : [];
}

export function setEffectSidechainSource(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  sourceTrackId: string | null,
): Command {
  const targetTrack = doc.tracks.find((track) => track.id === trackId);
  const target = trackEffectsOf(doc, trackId).find((fx) => fx.id === fxId);
  if (!targetTrack || !target) throw new Error(`Effect ${fxId} not found`);
  if (sourceTrackId !== null) {
    if (sourceTrackId === trackId) throw new Error("A track cannot sidechain itself");
    if (!doc.tracks.some((track) => track.id === sourceTrackId))
      throw new Error(`Sidechain source ${sourceTrackId} not found`);
  }
  const previous = target.sidechainTrackId ?? null;
  const apply = (d: ProjectDocument, source: string | null): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((fx) => (fx.id === fxId ? { ...fx, sidechainTrackId: source } : fx)),
    );
  return {
    type: "setEffectSidechainSource",
    label: sourceTrackId ? "Set sidechain source" : "Clear sidechain source",
    execute: (d) => apply(d, sourceTrackId),
    undo: (d) => apply(d, previous),
  };
}

export function applyEffectPreset(doc: ProjectDocument, trackId: string, fxId: string, preset: EffectPreset): Command {
  const target = trackEffectsOf(doc, trackId).find((fx) => fx.id === fxId);
  if (!target) throw new Error(`Effect ${fxId} not found`);
  if (target.type !== preset.type) throw new Error("Preset does not match effect type");
  const previous = { ...target.params };
  const previousSteps = target.steps ? [...target.steps] : undefined;
  const nextParams = { ...target.params };
  for (const [id, value] of Object.entries(preset.params)) nextParams[id] = clampEffectParam(target.type, id, value);
  const nextSteps = preset.steps ? sanitizeGateSteps(preset.steps) : target.steps;
  const apply = (d: ProjectDocument, params: Record<string, number>, steps: number[] | undefined): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((fx) => (fx.id === fxId ? { ...fx, params: { ...params }, steps } : fx)),
    );
  return {
    type: "applyEffectPreset",
    label: `Apply ${preset.name} preset`,
    execute: (d) => apply(d, nextParams, nextSteps),
    undo: (d) => apply(d, previous, previousSteps),
  };
}

function applyRowsPatch(
  doc: ProjectDocument,
  patternId: string,
  patch: import("../assist/patternOps").RowsPatch,
): ProjectDocument {
  return {
    ...doc,
    patterns: doc.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const stepCount = patch.stepCount ?? p.stepCount;
      const sourceRows = { ...p.rows, ...patch.rows };
      const rows = Object.fromEntries(
        Object.entries(sourceRows).map(([padId, row]) => [
          padId,
          new Array<number>(stepCount).fill(0).map((_, step) => row[step] ?? 0),
        ]),
      );
      const mergedMeta: NonNullable<Pattern["stepMeta"]> = Object.fromEntries(
        Object.entries(p.stepMeta ?? {}).map(([padId, padMeta]) => [padId, { ...padMeta }]),
      );
      if (patch.clearStepMeta) {
        const padIds = patch.clearStepMeta.padIds
          ? new Set(patch.clearStepMeta.padIds)
          : new Set(Object.keys(mergedMeta));
        for (const padId of padIds) {
          const padMeta = mergedMeta[padId];
          if (!padMeta) continue;
          for (const stepKey of Object.keys(padMeta)) {
            const step = Number(stepKey);
            if (step >= patch.clearStepMeta.from && step < patch.clearStepMeta.to) delete padMeta[step];
          }
        }
      }
      for (const [padId, padMeta] of Object.entries(patch.stepMeta ?? {})) {
        mergedMeta[padId] = { ...(mergedMeta[padId] ?? {}), ...padMeta };
      }
      const cleanedMeta: NonNullable<Pattern["stepMeta"]> = {};
      for (const [padId, padMeta] of Object.entries(mergedMeta)) {
        const row = rows[padId];
        if (!row) continue;
        const cleanSteps: Record<number, StepMeta> = {};
        for (const [stepKey, meta] of Object.entries(padMeta)) {
          const step = Number(stepKey);
          if (Number.isInteger(step) && step >= 0 && step < stepCount && row[step] > 0) {
            cleanSteps[step] = { ...meta };
          }
        }
        if (Object.keys(cleanSteps).length > 0) cleanedMeta[padId] = cleanSteps;
      }
      const notes = patch.notes
        ? Object.fromEntries(
            Object.entries(patch.notes).map(([trackId, noteList]) => [
              trackId,
              noteList
                .map((note) => ({ ...note }))
                .filter((note) => note.start >= 0 && note.start + note.duration <= stepCount * STEP_TICKS),
            ]),
          )
        : p.notes;
      return {
        ...p,
        rows,
        notes,
        stepCount,
        stepMeta: Object.keys(cleanedMeta).length > 0 ? cleanedMeta : undefined,
        phrasePlan: patch.phrasePlan ?? p.phrasePlan,
      };
    }),
  };
}

/** Remove the project-local slice edit from a pad while keeping its asset. */
export function resetPadSlice(doc: ProjectDocument, padId: string): Command {
  const pad = doc.tracks.flatMap((t) => (t.kind === "drum" ? t.pads : [])).find((p) => p.id === padId);
  if (!pad) throw new Error(`Pad ${padId} not found`);
  const next = withPad(doc, padId, (current) => {
    const clean = { ...current };
    delete clean.sliceStart;
    delete clean.sliceEnd;
    delete clean.sliceFadeIn;
    delete clean.sliceFadeOut;
    delete clean.sliceReverse;
    return clean;
  });
  return snapshot("resetPadSlice", `Reset slice on ${pad.name}`, doc, next);
}

export interface ChopSampleOptions {
  trackId: string;
  assetId: string;
  sourceName: string;
  slices: PadSlice[];
  createPattern: boolean;
}

/** Atomically map a source's first 16 slices and optionally create a pattern. */
export function chopSampleToPads(doc: ProjectDocument, options: ChopSampleOptions): Command {
  const track = doc.tracks.find((t): t is DrumTrack => t.id === options.trackId && t.kind === "drum");
  if (!track) throw new Error(`Drum track ${options.trackId} not found`);
  const fit = options.slices.slice(0, track.pads.length);
  let next = sliceToPads(doc, options.trackId, options.assetId, fit, options.sourceName).execute(doc);

  if (options.createPattern) {
    const pattern = createPatternForDoc(next, `${options.sourceName} Chop`, 16);
    const rows = { ...pattern.rows };
    fit.forEach((_, index) => {
      const pad = track.pads[index];
      if (!pad) return;
      const row = [...(rows[pad.id] ?? new Array<number>(16).fill(0))];
      row[index] = 0.9;
      rows[pad.id] = row;
    });
    const choppedPattern = { ...pattern, rows };
    next = {
      ...next,
      patterns: [...next.patterns, choppedPattern],
      activePatternId: choppedPattern.id,
    };
  }

  return snapshot(
    "chopSampleToPads",
    options.createPattern ? `Chop ${fit.length} slices + create pattern` : `Chop ${fit.length} slices to pads`,
    doc,
    next,
  );
}

function assistCommand(
  type: string,
  label: string,
  doc: ProjectDocument,
  patternId: string,
  input: AssistInput,
): Command {
  const sourcePattern = doc.patterns.find((pattern) => pattern.id === patternId);
  if (!sourcePattern) throw new Error(`Pattern ${patternId} not found`);
  const request = normalizeAssistRequest(input);
  const patch = buildAssistPatch(sourcePattern, drumPadsOf(doc), request);
  const patchedDoc = applyRowsPatch(doc, patternId, patch);
  const patchedPattern = patchedDoc.patterns.find((pattern) => pattern.id === patternId);
  if (!patchedPattern) throw new Error(`Pattern ${patternId} disappeared during Assist operation`);
  const sourceContentHash = contentHash(canonicalizePattern(doc, sourcePattern));
  const outputContentHash = contentHash(canonicalizePattern(patchedDoc, patchedPattern));
  const assist: PatternAssist = {
    engineId: ASSIST_ENGINE_ID,
    engineVersion: ASSIST_ENGINE_VERSION,
    operation: request.operation,
    seed: request.seed,
    sourceContentHash,
    outputContentHash,
    ...(request.operation === "vary" ? { amount: request.amount } : {}),
    ...(request.operation === "build" ? { bars: request.bars } : {}),
    ...(request.operation === "replace" ? { target: request.target, style: request.style } : {}),
  };
  const next: ProjectDocument = {
    ...patchedDoc,
    patterns: patchedDoc.patterns.map((pattern) => {
      if (pattern.id !== patternId) return pattern;
      if (!pattern.generation) return { ...pattern, assist };
      const generation = {
        ...pattern.generation,
        inputContentHash: sourceContentHash,
        outputContentHash,
      };
      delete generation.quality;
      return { ...pattern, assist, generation };
    }),
  };
  return snapshot(type, label, doc, next);
}

/** Vary the active pattern: velocity humanization + ghost notes + micro feel. */
export function assistVary(doc: ProjectDocument, patternId: string, seed: string, amount: number): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return assistCommand("assistVary", `Vary ${pattern.name} (${seed})`, doc, patternId, {
    operation: "vary",
    seed,
    amount,
  });
}

/** Expand the pattern to `bars` with a progressive element + energy build. */
export function assistBuild(doc: ProjectDocument, patternId: string, bars: number, seed: string): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return assistCommand("assistBuild", `Build ${pattern.name} to ${bars} bars`, doc, patternId, {
    operation: "build",
    bars,
    seed,
  });
}

/** Replace one pad family's groove with a style (hats → house, kicks → trap…). */
export function assistReplace(
  doc: ProjectDocument,
  patternId: string,
  target: import("../assist/patternOps").ReplaceTarget,
  style: string,
  seed: string,
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return assistCommand("assistReplace", `${target} → ${style}`, doc, patternId, {
    operation: "replace",
    target,
    style,
    seed,
  });
}

/** Crescendo snare fill over the pattern's last bar. */
export function assistFill(doc: ProjectDocument, patternId: string, seed: string): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return assistCommand("assistFill", `Fill ${pattern.name} (${seed})`, doc, patternId, { operation: "fill", seed });
}
