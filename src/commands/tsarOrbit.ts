/**
 * TSAR ORBIT commands (roadmap wave 5, ADR 0074).
 *
 * The surface is a performance instrument, and the commands follow the
 * house rules:
 *
 *  - every mutation is ONE undoable step (a whole drag, a whole recording);
 *  - every value that lands is clamped and DISCLOSED, never silently
 *    different from what was asked;
 *  - the project model holds the truth. The panel dispatches; it never
 *    writes a parameter behind the command layer's back.
 */

import type { Command } from "./types";
import type { AutomationLane, AutomationPoint, InstrumentTrack, ProjectDocument } from "../project-model/types";
import type { OrbitAxis, OrbitMapping } from "../project-model/types";
import { uid } from "../shared/ids";
import { snapshot } from "./core";
import { setInstrumentParams } from "./instrument";
import {
  defaultOrbitMapping,
  describeOrbitMapping,
  isOrbitTarget,
  normalizeOrbitMapping,
  ORBIT_PRESETS,
  orbitAxisValue,
  orbitAxesCollide,
} from "../tsar/orbit";

/** One recorded sample of the surface: where it was, and where it stood. */
export interface OrbitSample {
  /** The musical tick the sample was taken at. */
  tick: number;
  /** The surface position along X, 0..1. */
  x: number;
  /** The surface position along Y, 0..1. */
  y: number;
}

function tsarTrack(doc: ProjectDocument, trackId: string): InstrumentTrack {
  const track = doc.tracks.find((candidate): candidate is InstrumentTrack => candidate.id === trackId);
  if (!track || track.kind !== "instrument") throw new Error(`Track ${trackId} not found`);
  return track;
}

/** The track's mapping — repaired, so a damaged document still drives something. */
export function orbitMappingOf(doc: ProjectDocument, trackId: string): OrbitMapping {
  return normalizeOrbitMapping(tsarTrack(doc, trackId).orbit);
}

/**
 * Install a mapping on a track.
 *
 * The mapping is repaired before it is stored (`normalizeOrbitMapping`), so
 * the document can never hold a mapping the engine cannot honour. Two axes
 * on the SAME parameter are refused: the X write and the Y write would
 * overwrite each other, and the surface would show a position that is not
 * the parameter's value.
 */
export function setOrbitMapping(doc: ProjectDocument, trackId: string, mapping: OrbitMapping): Command {
  tsarTrack(doc, trackId);
  const canonical = normalizeOrbitMapping(mapping);
  if (orbitAxesCollide(canonical)) {
    throw new Error("Both ORBIT axes drive the same parameter — pick a different target for one of them");
  }
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((candidate) =>
      candidate.id === trackId && candidate.kind === "instrument" ? { ...candidate, orbit: canonical } : candidate,
    ),
  };
  return snapshot("setOrbitMapping", `ORBIT mapping — ${describeOrbitMapping(canonical)}`, doc, next);
}

/**
 * Apply a mapping preset — a named pair of axes.
 *
 * Installing a mapping does NOT touch the patch: the two parameters keep the
 * values they have, so the surface appears where the sound already is and
 * the producer decides when to move it.
 */
export function applyOrbitPreset(doc: ProjectDocument, trackId: string, presetId: string): Command {
  const preset = ORBIT_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) throw new Error(`Unknown ORBIT preset ${presetId}`);
  const track = tsarTrack(doc, trackId);
  if (track.instrument !== "tsar") throw new Error("ORBIT is a TSAR surface");
  return setOrbitMapping(doc, trackId, { x: { ...preset.x }, y: { ...preset.y } });
}

/**
 * Restore the ORIGINAL mapping — the gate's "the user can get the original
 * back, simply" requirement.
 *
 * One command, no dialog: the documented default pair of axes goes back.
 * The position is not touched — the mapping is what was restored.
 */
export function restoreDefaultOrbitMapping(doc: ProjectDocument, trackId: string): Command {
  const track = tsarTrack(doc, trackId);
  if (track.instrument !== "tsar") throw new Error("ORBIT is a TSAR surface");
  return setOrbitMapping(doc, trackId, defaultOrbitMapping());
}

/**
 * Move the surface — ONE undoable step that writes BOTH axes.
 *
 * The position is the parameter value, so the number the producer sees, the
 * number the engine plays and the number an automation lane writes are the
 * same number. There is no second copy to drift.
 */
export function setOrbitPosition(doc: ProjectDocument, trackId: string, x: number, y: number): Command {
  const mapping = orbitMappingOf(doc, trackId);
  const params: Record<string, number> = {};
  params[mapping.x.paramId] = orbitAxisValue(mapping.x, x);
  params[mapping.y.paramId] = orbitAxisValue(mapping.y, y);
  return setInstrumentParams(doc, trackId, params, "ORBIT move");
}

/** Find the lane that drives an instrument parameter, if there is one. */
function laneFor(doc: ProjectDocument, trackId: string, paramId: string): AutomationLane | undefined {
  return doc.automation.find(
    (lane) =>
      lane.target.kind === "instParam" &&
      lane.target.trackId === trackId &&
      lane.target.paramId === paramId &&
      !lane.target.fxId,
  );
}

/**
 * Write one axis' value at one tick, creating the lane when it is missing.
 *
 * The lane's target is the AXIS' parameter, so the recorded curve is an
 * ordinary project automation lane: it is drawn, edited and undone in the
 * existing KYX workflow, and it drives the parameter through the same
 * writer every other lane uses.
 */
function writeAxisAt(
  doc: ProjectDocument,
  trackId: string,
  axis: OrbitAxis,
  tick: number,
  value: number,
): ProjectDocument {
  const safeTick = Number.isFinite(tick) ? Math.max(0, Math.round(tick)) : 0;
  const existing = laneFor(doc, trackId, axis.paramId);
  const points: AutomationPoint[] = existing
    ? existing.points
    : [];
  const at = points.findIndex((point) => point.tick === safeTick);
  const nextPoints =
    at === -1
      ? [...points, { id: uid("pt"), tick: safeTick, value }].sort((a, b) => a.tick - b.tick)
      : points.map((point, index) => (index === at ? { ...point, value } : point));
  const lane: AutomationLane = existing
    ? { ...existing, points: nextPoints }
    : {
        id: uid("lane"),
        target: { kind: "instParam", trackId, paramId: axis.paramId },
        points: nextPoints,
      };
  return {
    ...doc,
    automation: existing ? doc.automation.map((entry) => (entry.id === existing.id ? lane : entry)) : [...doc.automation, lane],
  };
}

/**
 * Record a performance through the surface — into the PROJECT AUTOMATION.
 *
 * The recorded path is written as ordinary automation lanes on the two axis
 * parameters: one point per tick, the newest value wins, and the whole
 * recording is ONE undo step. The curve it produces is then editable in the
 * existing lane editor, survives a save, and is rendered by the offline
 * exporter.
 */
export function recordOrbitPath(doc: ProjectDocument, trackId: string, samples: readonly OrbitSample[]): Command {
  const track = tsarTrack(doc, trackId);
  if (track.instrument !== "tsar") throw new Error("ORBIT is a TSAR surface");
  if (samples.length === 0) throw new Error("Nothing to record — the surface did not move");
  const mapping = orbitMappingOf(doc, trackId);
  let next = doc;
  for (const sample of samples) {
    next = writeAxisAt(next, trackId, mapping.x, sample.tick, orbitAxisValue(mapping.x, sample.x));
    next = writeAxisAt(next, trackId, mapping.y, sample.tick, orbitAxisValue(mapping.y, sample.y));
  }
  return snapshot("recordOrbitPath", `Record ORBIT performance (${samples.length} points)`, doc, next);
}

/**
 * Remove the lanes the surface recorded — the "undo the recording" step.
 *
 * It removes the lanes that drive the two axis parameters and nothing else:
 * a lane the producer drew by hand on the same parameter is theirs, and
 * this command does not guess which is which.
 */
export function clearOrbitRecording(doc: ProjectDocument, trackId: string): Command {
  const mapping = orbitMappingOf(doc, trackId);
  const owned = new Set([mapping.x.paramId, mapping.y.paramId]);
  const next: ProjectDocument = {
    ...doc,
    automation: doc.automation.filter(
      (lane) =>
        !(
          lane.target.kind === "instParam" &&
          lane.target.trackId === trackId &&
          !lane.target.fxId &&
          lane.target.paramId &&
          owned.has(lane.target.paramId)
        ),
    ),
  };
  return snapshot("clearOrbitRecording", "Clear ORBIT recording", doc, next);
}

/** Is this parameter id assignable to an axis? (Re-exported for the panel.) */
export { isOrbitTarget };
