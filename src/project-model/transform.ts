import type { DrumPad, DrumTrack, ProjectDocument, Track } from "./types";
import { getActivePattern } from "./types";
import { clamp } from "../shared/ids";

type DocMutator<T> = (value: T) => T;

export function withDrumTrack(doc: ProjectDocument, fn: DocMutator<DrumTrack>): ProjectDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((t) => (t.kind === "drum" ? fn(t) : t)),
  };
}

export function withTrack(doc: ProjectDocument, trackId: string, fn: DocMutator<Track>): ProjectDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((t) => (t.id === trackId ? fn(t) : t)),
  };
}

export function withPad(doc: ProjectDocument, padId: string, fn: DocMutator<DrumPad>): ProjectDocument {
  return withDrumTrack(doc, (track) => ({
    ...track,
    pads: track.pads.map((p) => (p.id === padId ? fn(p) : p)),
  }));
}

export function withActivePattern(doc: ProjectDocument, fn: Parameters<typeof withPattern>[2]): ProjectDocument {
  return withPattern(doc, doc.activePatternId, fn);
}

function withPattern(
  doc: ProjectDocument,
  patternId: string,
  fn: (pattern: ProjectDocument["patterns"][number]) => ProjectDocument["patterns"][number],
): ProjectDocument {
  return {
    ...doc,
    patterns: doc.patterns.map((p) => (p.id === patternId ? fn(p) : p)),
  };
}

export function setStepVelocity(
  doc: ProjectDocument,
  padId: string,
  stepIndex: number,
  velocity: number,
): ProjectDocument {
  const clamped = clamp(velocity, 0, 1);
  if (!Number.isInteger(stepIndex) || stepIndex < 0) return doc;
  return withActivePattern(doc, (pattern) => {
    // Rows are only guaranteed at normalize boundaries — a live doc can be
    // missing the pad's row entirely. Write into a fresh row instead of
    // crashing the dispatch.
    const row = [...(pattern.rows[padId] ?? [])];
    row[stepIndex] = clamped;
    return { ...pattern, rows: { ...pattern.rows, [padId]: row } };
  });
}

export function activePatternOf(doc: ProjectDocument) {
  return getActivePattern(doc);
}
