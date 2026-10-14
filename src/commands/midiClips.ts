import type { MidiClip, Pattern, ProjectDocument } from "../project-model/types";
import { MAX_ARRANGEMENT_CLIP_TICKS } from "../project-model/schema";
import { cloneStepMeta, unlinkMarkersOfClips } from "./docOps";
import { clipGroupsWithoutIds } from "./clipGroups";
import { snapshot } from "./core";
import type { Command } from "./types";
import { uid } from "../shared/ids";
import { STEP_TICKS } from "../project-model/types";

function clipOf(doc: ProjectDocument, clipId: string): MidiClip {
  const clip = doc.arrangement.midiClips?.find((candidate) => candidate.id === clipId);
  if (!clip) throw new Error(`MIDI clip ${clipId} not found`);
  return clip;
}

function editable(clip: MidiClip): void {
  if (clip.locked) throw new Error("MIDI clip is locked");
}

function patternOf(doc: ProjectDocument, patternId: string): Pattern {
  const pattern = doc.patterns.find((candidate) => candidate.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return pattern;
}

function safeGeometry(startTick: number, lengthTicks: number): { startTick: number; lengthTicks: number } {
  if (!Number.isFinite(startTick) || !Number.isFinite(lengthTicks)) {
    throw new Error("MIDI clip position and length must be finite ticks");
  }
  const length = Math.min(MAX_ARRANGEMENT_CLIP_TICKS, Math.max(1, Math.round(lengthTicks)));
  const start = Math.min(MAX_ARRANGEMENT_CLIP_TICKS - length, Math.max(0, Math.round(startTick)));
  return { startTick: start, lengthTicks: length };
}

function modulo(value: number, period: number): number {
  return ((value % period) + period) % period;
}

export function addMidiClip(
  doc: ProjectDocument,
  trackId: string,
  patternId: string,
  startTick: number,
  lengthTicks = STEP_TICKS * 64,
): Command {
  const track = doc.tracks.find((candidate) => candidate.id === trackId);
  if (!track || track.kind !== "instrument") throw new Error("MIDI clips need an instrument track");
  patternOf(doc, patternId);
  const geometry = safeGeometry(startTick, lengthTicks);
  const clip: MidiClip = { id: uid("midiclip"), trackId, patternId, ...geometry };
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      midiClips: [...(doc.arrangement.midiClips ?? []), clip].sort((a, b) => a.startTick - b.startTick),
    },
  };
  return snapshot("addMidiClip", `Place ${track.name} MIDI clip`, doc, next);
}

export function moveMidiClip(doc: ProjectDocument, clipId: string, startTick: number): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  const geometry = safeGeometry(startTick, clip.lengthTicks);
  const nextClips = (doc.arrangement.midiClips ?? [])
    .map((candidate) => (candidate.id === clipId ? { ...candidate, startTick: geometry.startTick } : candidate))
    .sort((a, b) => a.startTick - b.startTick);
  return snapshot("moveMidiClip", `Move MIDI clip to tick ${geometry.startTick}`, doc, {
    ...doc,
    arrangement: { ...doc.arrangement, midiClips: nextClips },
  });
}

export function resizeMidiClip(doc: ProjectDocument, clipId: string, lengthTicks: number): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  const geometry = safeGeometry(clip.startTick, lengthTicks);
  return snapshot("resizeMidiClip", `Resize MIDI clip to ${geometry.lengthTicks} ticks`, doc, {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      midiClips: (doc.arrangement.midiClips ?? []).map((candidate) =>
        candidate.id === clipId ? { ...candidate, lengthTicks: geometry.lengthTicks } : candidate,
      ),
    },
  });
}

export function trimMidiClipStart(doc: ProjectDocument, clipId: string, startTick: number): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  if (!Number.isFinite(startTick)) throw new Error("MIDI clip trim position must be finite ticks");
  const endTick = clip.startTick + clip.lengthTicks;
  const nextStart = Math.max(0, Math.min(endTick - 1, Math.round(startTick)));
  const pattern = patternOf(doc, clip.patternId);
  const patternTicks = pattern.stepCount * STEP_TICKS;
  const phaseOffsetTicks =
    patternTicks > 0 ? modulo((clip.phaseOffsetTicks ?? 0) + nextStart - clip.startTick, patternTicks) : 0;
  const nextClip: MidiClip = {
    ...clip,
    startTick: nextStart,
    lengthTicks: endTick - nextStart,
    ...(phaseOffsetTicks > 0 ? { phaseOffsetTicks } : {}),
  };
  if (phaseOffsetTicks === 0) delete nextClip.phaseOffsetTicks;
  return snapshot("trimMidiClipStart", `Trim MIDI clip start to tick ${nextStart}`, doc, {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      midiClips: (doc.arrangement.midiClips ?? []).map((candidate) => (candidate.id === clipId ? nextClip : candidate)),
    },
  });
}

export function splitMidiClipAtTick(doc: ProjectDocument, clipId: string, splitTick: number): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  if (!Number.isFinite(splitTick)) throw new Error("MIDI clip split position must be finite ticks");
  const split = Math.round(splitTick);
  const end = clip.startTick + clip.lengthTicks;
  if (split <= clip.startTick || split >= end) throw new Error("Split must leave two non-empty MIDI clips");
  const pattern = patternOf(doc, clip.patternId);
  const patternTicks = pattern.stepCount * STEP_TICKS;
  const phaseOffsetTicks =
    patternTicks > 0 ? modulo((clip.phaseOffsetTicks ?? 0) + split - clip.startTick, patternTicks) : 0;
  const right: MidiClip = {
    ...clip,
    id: uid("midiclip"),
    startTick: split,
    lengthTicks: end - split,
    ...(phaseOffsetTicks > 0 ? { phaseOffsetTicks } : {}),
  };
  if (phaseOffsetTicks === 0) delete right.phaseOffsetTicks;
  const left = { ...clip, lengthTicks: split - clip.startTick };
  const midiClips = (doc.arrangement.midiClips ?? [])
    .flatMap((candidate) => (candidate.id === clipId ? [left, right] : [candidate]))
    .sort((a, b) => a.startTick - b.startTick);
  return snapshot("splitMidiClipAtTick", `Split MIDI clip at tick ${split}`, doc, {
    ...doc,
    arrangement: { ...doc.arrangement, midiClips },
  });
}

export function duplicateMidiClip(doc: ProjectDocument, clipId: string, startTick?: number): Command {
  const source = clipOf(doc, clipId);
  const geometry = safeGeometry(startTick ?? source.startTick + source.lengthTicks, source.lengthTicks);
  const copy: MidiClip = {
    ...source,
    id: uid("midiclip"),
    ...geometry,
  };
  const midiClips = [...(doc.arrangement.midiClips ?? []), copy].sort((a, b) => a.startTick - b.startTick);
  return snapshot("duplicateMidiClip", "Duplicate MIDI clip", doc, {
    ...doc,
    arrangement: { ...doc.arrangement, midiClips },
  });
}

export function makeMidiClipUnique(doc: ProjectDocument, clipId: string): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  const source = patternOf(doc, clip.patternId);
  const copy: Pattern = {
    ...source,
    id: uid("pattern"),
    name: `${source.name} · MIDI clip`,
    rows: Object.fromEntries(Object.entries(source.rows).map(([padId, row]) => [padId, [...row]])),
    notes: Object.fromEntries(
      Object.entries(source.notes ?? {}).map(([trackId, notes]) => [
        trackId,
        notes.map((note) => ({ ...note, id: uid("note"), ...(note.locks ? { locks: { ...note.locks } } : {}) })),
      ]),
    ),
    stepMeta: cloneStepMeta(source.stepMeta),
    generation: source.generation ? { ...source.generation, sourcePatternId: source.id } : undefined,
    phrasePlan: source.phrasePlan?.map((bar) => ({ ...bar })),
    assist: source.assist ? { ...source.assist } : undefined,
  };
  return snapshot("makeMidiClipUnique", `Make MIDI clip unique`, doc, {
    ...doc,
    patterns: [...doc.patterns, copy],
    arrangement: {
      ...doc.arrangement,
      midiClips: (doc.arrangement.midiClips ?? []).map((candidate) =>
        candidate.id === clipId ? { ...candidate, patternId: copy.id } : candidate,
      ),
    },
  });
}

export function setMidiClipMuted(doc: ProjectDocument, clipId: string, muted: boolean): Command {
  clipOf(doc, clipId);
  return snapshot(`setMidiClipMuted:${clipId}:${muted}`, `${muted ? "Mute" : "Unmute"} MIDI clip`, doc, {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      midiClips: (doc.arrangement.midiClips ?? []).map((candidate) => {
        if (candidate.id !== clipId) return candidate;
        const next = { ...candidate };
        if (muted) next.muted = true;
        else delete next.muted;
        return next;
      }),
    },
  });
}

export function setMidiClipLocked(doc: ProjectDocument, clipId: string, locked: boolean): Command {
  clipOf(doc, clipId);
  return snapshot(`setMidiClipLocked:${clipId}:${locked}`, `${locked ? "Lock" : "Unlock"} MIDI clip`, doc, {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      midiClips: (doc.arrangement.midiClips ?? []).map((candidate) => {
        if (candidate.id !== clipId) return candidate;
        const next = { ...candidate };
        if (locked) next.locked = true;
        else delete next.locked;
        return next;
      }),
    },
  });
}

export function deleteMidiClip(doc: ProjectDocument, clipId: string): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  const midiClips = (doc.arrangement.midiClips ?? []).filter((candidate) => candidate.id !== clipId);
  const removed = new Set([clipId]);
  const markers = unlinkMarkersOfClips(doc.markers, removed);
  const clipGroups = clipGroupsWithoutIds(doc.arrangement.clipGroups, [...removed]);
  return snapshot("deleteMidiClip", "Delete MIDI clip", doc, {
    ...doc,
    ...(markers ? { markers } : {}),
    arrangement: {
      ...doc.arrangement,
      midiClips,
      ...(clipGroups ? { clipGroups } : {}),
      ...(doc.arrangement.clipGroups && clipGroups?.length === 0 ? { clipGroups: undefined } : {}),
    },
  });
}
