/**
 * Whole-time-range operations: duplicate every clip, note and step inside [fromTick, toTick),
 * consolidate that range into one clip, or consolidate it all the way to rendered audio.
 *
 * These go through buildStemProject for the range's stem, so the FX that consolidate bakes
 * in are the same ones bounce would have used. That shared path is the reason the two
 * operations agree; a change to stem routing that skipped it would show up as a consolidated
 * clip that sounds different from a bounced one.
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
import { type EffectPreset } from "../effects/presets";
import { clampFxOutputTrimDb, factoryFxPresetGainDb } from "../effects/presetLoudness";
import { uid } from "../shared/ids";
import type { SharedPackSceneSketch, SharedPackSketch } from "../export/packCode";
import { resolveGrooveForGeneration } from "../ai/generator";
import { generateLocalResultFromOptions } from "../intent/pipeline";
import type { GenerationResult } from "../intent/types";
import type { GenerateOptions } from "../ai/types";
import { buildAssistPatch, normalizeAssistRequest } from "../assist/pipeline";
import { ASSIST_ENGINE_ID, ASSIST_ENGINE_VERSION, type AssistInput } from "../assist/types";
import { canonicalizePattern, contentHash } from "../ai/evaluation";
import { snapshot } from "./core";

import type { Command } from "./types";
import type {
  ArrangementClip,
  ArrangementTransition,
  ArrangementTransitionType,
  AudioClip,
  DrumTrack,
  Marker,
  NoteEvent,
  Pattern,
  ProjectDocument,
  Scene,
  SceneRole,
} from "../project-model/types";
import { BAR_TICKS, PPQ, STEP_TICKS } from "../project-model/types";
import { arrangementSecondsBetweenTicks, tempoAtTick } from "../project-model/scene-time";
import { buildStemProject } from "../rendering/stems";
import { warpBufferTimeAtTick } from "../project-model/audio-clip-warp";
import { patternPhaseOffsetAtTick, sceneOffsetAtTick } from "../project-model/events";
import {
  clampArrangementTransitionType,
  createGroupTrackModel,
  MAX_ARRANGEMENT_CLIP_BARS,
  MAX_BPM,
  MIN_BPM,
  normalizeProject,
  sanitizeArrangementTransitions,
  sceneRoleOf,
} from "../project-model/schema";
import { uid } from "../shared/ids";
import type { SharedPackSceneSketch, SharedPackSketch } from "../export/packCode";
import { snapshot } from "./core";
import { cloneStepMeta, unlinkMarkersOfClips } from "./docOps";

/* ---------------- time range ---------------- */
/**
 * Duplicate all musical material inside a timeRange [fromTick, toTick) and
 * insert the copy immediately after the range, shifting later clips forward.
 * Operates on arrangement clips (wholly inside), notes and steps (active
 * patterns). One undo via snapshot(). Guardrails: buildStemProject is
 * exercised for the zone's stem so consolidate stays in sync with bounce
 * routing (group FX preserved).
 */
export function duplicateTimeRange(doc: ProjectDocument, fromTick: number, toTick: number): Command {
  const rawFrom = Math.min(fromTick, toTick);
  const rawTo = Math.max(fromTick, toTick);
  if (rawFrom === rawTo) throw new Error("Cannot duplicate empty time range");
  // Scene clips live on an integer-bar grid (every move/resize command rounds
  // to whole bars) but the marquee only quantizes to ticks — a 2.4-bar drag
  // would shift later sections to fractional startBars, which the next move
  // command silently snaps back to an integer (position jump) and whose
  // startBar*BAR_TICKS is not even tick-exact in floating point. Widen the
  // zone to whole bars, never shrink it; bar-aligned ranges are unaffected.
  const from = Math.floor(rawFrom / BAR_TICKS) * BAR_TICKS;
  const to = Math.ceil(rawTo / BAR_TICKS) * BAR_TICKS;
  const delta = to - from;
  const deltaBars = delta / BAR_TICKS;
  // Scene clips are a no-overlap lane: a clip crossing either zone boundary
  // neither duplicates (not wholly inside) nor shifts (not trailing), so an
  // inside clip's copy would land on top of it — the audio lane below refuses
  // straddling clips for exactly this reason. Fail closed, not with an
  // overlapping arrangement.
  if (
    doc.arrangement.clips.some((c) => {
      const cFrom = c.startBar * BAR_TICKS;
      const cTo = (c.startBar + c.lengthBars) * BAR_TICKS;
      return (cFrom < from && cTo > from) || (cFrom < to && cTo > to);
    })
  ) {
    throw new Error("Cannot duplicate a time range when a clip crosses its boundary; adjust the range first.");
  }
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
    // Carry the per-clip loop/phase flags — duplicateArrangementClip does; a
    // fresh literal silently reset them, so the zone copy of a phase-shifted
    // clip played the pattern from the wrong phase.
    ...(c.phaseOffsetTicks !== undefined ? { phaseOffsetTicks: c.phaseOffsetTicks } : {}),
    ...(c.sceneOffsetTicks !== undefined ? { sceneOffsetTicks: c.sceneOffsetTicks } : {}),
    ...(c.loop ? { loop: c.loop } : {}),
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

  // Audio clips use a free-overlap lane, so only clips wholly contained in
  // the selected range can be copied safely. A clip crossing either range
  // edge would need a destructive split; fail closed rather than leave it
  // straddling the inserted section. Clips at/after the insertion point move
  // with the timeline, including their absolute warp-pin ticks.
  const fromBar = from / BAR_TICKS;
  const toBar = to / BAR_TICKS;
  const audioClips = doc.arrangement.audioClips ?? [];
  const overlapsRange = (clip: AudioClip) => clip.startBar < toBar && clip.startBar + clip.lengthBars > fromBar;
  const isWhollyInsideRange = (clip: AudioClip) => clip.startBar >= fromBar && clip.startBar + clip.lengthBars <= toBar;
  if (audioClips.some((clip) => overlapsRange(clip) && !isWhollyInsideRange(clip))) {
    throw new Error("Cannot duplicate a time range when an audio clip crosses its boundary; adjust the range first.");
  }
  const shiftWarpPins = (clip: AudioClip): AudioClip["warpMarkers"] =>
    clip.warpMarkers?.map((marker) => ({ ...marker, tick: marker.tick + delta }));
  const nextAudioClips = audioClips
    .flatMap((clip) => {
      if (isWhollyInsideRange(clip)) {
        return [
          {
            ...clip,
            id: uid("audioClip"),
            startBar: clip.startBar + deltaBars,
            ...(clip.warpMarkers ? { warpMarkers: shiftWarpPins(clip) } : {}),
          },
          clip,
        ];
      }
      if (clip.startBar >= toBar) {
        return [
          {
            ...clip,
            startBar: clip.startBar + deltaBars,
            ...(clip.warpMarkers ? { warpMarkers: shiftWarpPins(clip) } : {}),
          },
        ];
      }
      return [clip];
    })
    .sort((a, b) => a.startBar - b.startBar);
  if (doc.arrangement.audioClips !== undefined) {
    nextDoc = {
      ...nextDoc,
      arrangement: { ...nextDoc.arrangement, audioClips: nextAudioClips },
    };
  }

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
 * Legacy synchronous, musical-only range consolidation. Producer-facing
 * selected-range actions use `consolidateTimeRangeToAudio` after rendering;
 * this command remains for callers that explicitly want pattern material.
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
      // Spread the existing arrangement: rebuilding it from scratch DROPPED
      // `audioClips` — consolidating a zone silently deleted every audio
      // clip in the project (undoable once, permanent after a save).
      ...doc.arrangement,
      clips: nextClips,
      ...(nextTransitions ? { transitions: nextTransitions } : { transitions: undefined }),
    },
  };
  return snapshot("consolidateTimeRange", `Consolidate zone ${Math.round(deltaBars * 10) / 10} bars`, doc, nextDoc);
}

/**
 * Replace a complete arrangement range with one rendered audio clip. Empty
 * scene clips retain the source scene tempos for the printed clip; their IDs
 * stay stable so timeline markers and transitions remain attached. Source
 * patterns themselves are never destructively edited. Audio clips crossing a
 * range edge are split at the exact boundary, leaving their outside segments
 * intact while replacing only the rendered middle.
 */
interface SplitAudioRangeResult {
  project: ProjectDocument;
  removedClipIds: Set<string>;
}

function splitAudioClipsForConsolidationRange(
  doc: ProjectDocument,
  clips: AudioClip[],
  fromTick: number,
  toTick: number,
  sourceDurationsByBufferId: ReadonlyMap<string, number>,
): SplitAudioRangeResult {
  let project = doc;
  const removedClipIds = new Set<string>();

  for (const sourceClip of clips) {
    const sourceDuration = sourceDurationsByBufferId.get(sourceClip.bufferId);
    const crossesRangeBoundary =
      sourceClip.startBar * BAR_TICKS < fromTick || (sourceClip.startBar + sourceClip.lengthBars) * BAR_TICKS > toTick;
    if (
      crossesRangeBoundary &&
      sourceClip.warpMarkers?.length &&
      (!Number.isFinite(sourceDuration) || sourceDuration! <= 0)
    ) {
      throw new Error(`Load the source audio for warped clip ${sourceClip.id} before consolidating its range.`);
    }

    let rangeClipId = sourceClip.id;
    const currentClip = () => project.arrangement.audioClips?.find((clip) => clip.id === rangeClipId);
    const initial = currentClip();
    if (!initial) throw new Error(`AudioClip ${sourceClip.id} disappeared during range consolidation.`);

    const splitAt = (clipId: string, tick: number): AudioClip[] => {
      const priorIds = new Set((project.arrangement.audioClips ?? []).map((clip) => clip.id));
      project = splitAudioClipAtTickWithMinimumFragment(project, clipId, tick, sourceDuration, 0).execute(project);
      const pieces = (project.arrangement.audioClips ?? []).filter(
        (clip) =>
          !priorIds.has(clip.id) && clip.bufferId === sourceClip.bufferId && clip.trackId === sourceClip.trackId,
      );
      if (pieces.length !== 2)
        throw new Error(`Could not preserve the source segments for audio clip ${sourceClip.id}.`);
      return pieces;
    };

    if (initial.startBar * BAR_TICKS < fromTick) {
      const rangeFragment = splitAt(rangeClipId, fromTick).find(
        (clip) => Math.abs(clip.startBar * BAR_TICKS - fromTick) < 1e-6,
      );
      if (!rangeFragment) throw new Error(`Could not preserve the left audio fragment for clip ${sourceClip.id}.`);
      rangeClipId = rangeFragment.id;
    }

    const middle = currentClip();
    if (!middle) throw new Error(`AudioClip ${sourceClip.id} disappeared during range consolidation.`);
    if ((middle.startBar + middle.lengthBars) * BAR_TICKS > toTick) {
      const rangeFragment = splitAt(rangeClipId, toTick).find(
        (clip) =>
          clip.startBar * BAR_TICKS >= fromTick - 1e-6 &&
          (clip.startBar + clip.lengthBars) * BAR_TICKS <= toTick + 1e-6 &&
          (clip.startBar + clip.lengthBars) * BAR_TICKS > fromTick,
      );
      if (!rangeFragment) throw new Error(`Could not isolate the selected audio range for clip ${sourceClip.id}.`);
      rangeClipId = rangeFragment.id;
    }
    removedClipIds.add(rangeClipId);
  }

  return { project, removedClipIds };
}

export function consolidateTimeRangeToAudio(
  doc: ProjectDocument,
  fromTick: number,
  toTick: number,
  bufferId: string,
  sourceDurationsByBufferId: ReadonlyMap<string, number> = new Map(),
  printLengthBars?: number,
): Command {
  const from = Math.min(fromTick, toTick);
  const to = Math.max(fromTick, toTick);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
    throw new Error("Select a valid, non-empty time range.");
  }
  if (from % BAR_TICKS !== 0 || to % BAR_TICKS !== 0) {
    throw new Error("Consolidation requires a selection aligned to complete bars.");
  }
  if (!bufferId) throw new Error("A rendered audio asset is required for consolidation.");
  if (doc.tracks.some((track) => track.solo)) {
    throw new Error("Turn off Solo before consolidating so the print does not change the rest of the mix.");
  }

  const fromBar = from / BAR_TICKS;
  const toBar = to / BAR_TICKS;
  const lengthBars = toBar - fromBar;
  const renderedLengthBars = printLengthBars ?? lengthBars;
  if (
    !Number.isFinite(renderedLengthBars) ||
    renderedLengthBars < lengthBars ||
    renderedLengthBars > MAX_ARRANGEMENT_CLIP_BARS
  ) {
    throw new Error("The rendered print duration must cover the selected range and stay within the clip limit.");
  }
  const overlaps = (startBar: number, bars: number) => startBar < toBar && startBar + bars > fromBar;
  const sourceClips = doc.arrangement.clips.filter((clip) => overlaps(clip.startBar, clip.lengthBars));
  const sourceAudio = (doc.arrangement.audioClips ?? []).filter((clip) => overlaps(clip.startBar, clip.lengthBars));

  const splitAudio = splitAudioClipsForConsolidationRange(doc, sourceAudio, from, to, sourceDurationsByBufferId);

  const groupCount = splitAudio.project.tracks.filter((track) => track.kind === "group").length;
  const printTrack = {
    ...createGroupTrackModel(`Consolidated ${groupCount + 1}`),
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
    sends: {},
  };
  const withPrintTrack: ProjectDocument = {
    ...splitAudio.project,
    tracks: [...splitAudio.project.tracks, printTrack],
  };
  const withPrintClip = addAudioClip(withPrintTrack, printTrack.id, bufferId, fromBar, renderedLengthBars, {
    gain: 1,
    stretchRate: 1,
    fadeIn: 0.003,
    fadeOut: 0.003,
  }).execute(withPrintTrack);
  const printClip = withPrintClip.arrangement.audioClips?.find(
    (clip) => clip.trackId === printTrack.id && clip.bufferId === bufferId,
  );
  if (!printClip) throw new Error("The rendered audio clip could not be added to the print track.");

  const tempoPatterns: Pattern[] = [];
  const tempoScenes: Scene[] = [];
  const tempoSceneByClipId = new Map<string, Scene>();
  for (const clip of sourceClips) {
    const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
    const pattern = scene && doc.patterns.find((candidate) => candidate.id === scene.patternId);
    if (!scene || !pattern) throw new Error(`Cannot preserve tempo for arrangement clip ${clip.id}.`);
    const tempoPattern: Pattern = {
      ...pattern,
      id: uid("pattern"),
      name: `${pattern.name} · print tempo`,
      rows: {},
      notes: {},
      stepMeta: undefined,
    };
    const tempoScene: Scene = {
      ...scene,
      id: uid("scene"),
      name: `Print tempo · ${scene.name}`,
      patternId: tempoPattern.id,
    };
    tempoPatterns.push(tempoPattern);
    tempoScenes.push(tempoScene);
    tempoSceneByClipId.set(clip.id, tempoScene);
  }

  const sourceClipIds = new Set(sourceClips.map((clip) => clip.id));
  const nextClips: ArrangementClip[] = [];
  for (const clip of doc.arrangement.clips) {
    if (!sourceClipIds.has(clip.id)) {
      nextClips.push(clip);
      continue;
    }
    const tempoScene = tempoSceneByClipId.get(clip.id);
    const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
    const pattern = scene && doc.patterns.find((candidate) => candidate.id === scene.patternId);
    if (!tempoScene || !pattern) throw new Error(`Cannot preserve tempo for arrangement clip ${clip.id}.`);

    const clipEndBar = clip.startBar + clip.lengthBars;
    const overlapStartBar = Math.max(clip.startBar, fromBar);
    const overlapEndBar = Math.min(clipEndBar, toBar);
    const hasLeftRemainder = clip.startBar < overlapStartBar;
    const hasRightRemainder = overlapEndBar < clipEndBar;
    const isPartial = hasLeftRemainder || hasRightRemainder;

    if (hasLeftRemainder) {
      nextClips.push({ ...clip, lengthBars: overlapStartBar - clip.startBar });
    }

    if (hasRightRemainder) {
      const rightStartTick = overlapEndBar * BAR_TICKS;
      nextClips.push({
        ...clip,
        id: hasLeftRemainder ? uid("clip") : clip.id,
        startBar: overlapEndBar,
        lengthBars: clipEndBar - overlapEndBar,
        phaseOffsetTicks: patternPhaseOffsetAtTick(clip, pattern, rightStartTick),
        sceneOffsetTicks: sceneOffsetAtTick(clip, rightStartTick),
      });
    }

    const placeholder: ArrangementClip = {
      ...clip,
      id: isPartial ? uid("clip") : clip.id,
      sceneId: tempoScene.id,
      startBar: overlapStartBar,
      lengthBars: overlapEndBar - overlapStartBar,
    };
    delete placeholder.phaseOffsetTicks;
    delete placeholder.sceneOffsetTicks;
    nextClips.push(placeholder);
  }
  nextClips.sort((a, b) => a.startBar - b.startBar);
  const nextAudioClips = (withPrintClip.arrangement.audioClips ?? [])
    .filter((clip) => !splitAudio.removedClipIds.has(clip.id))
    .sort((a, b) => a.startBar - b.startBar);
  const liveTakeGroupIds = new Set(nextAudioClips.flatMap((clip) => (clip.takeGroupId ? [clip.takeGroupId] : [])));
  const takeGroups = doc.arrangement.takeGroups?.filter((group) => liveTakeGroupIds.has(group.id));
  const transitions = sanitizeArrangementTransitions(doc.arrangement.transitions, nextClips);

  const nextDoc = normalizeProject({
    ...withPrintClip,
    patterns: [...doc.patterns, ...tempoPatterns],
    scenes: [...doc.scenes, ...tempoScenes],
    arrangement: {
      ...withPrintClip.arrangement,
      clips: nextClips,
      audioClips: nextAudioClips,
      ...(takeGroups ? { takeGroups } : {}),
      ...(transitions ? { transitions } : { transitions: undefined }),
    },
  });
  return snapshot(
    "consolidateTimeRangeToAudio",
    `Consolidate ${Math.round(lengthBars * 10) / 10} bars to audio`,
    doc,
    nextDoc,
  );
}