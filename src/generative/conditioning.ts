import type { GenerativeInput, GenerativeMacroValues, GenerativeStyle } from "./types";
import { GENERATIVE_FRAME_RATE_HZ, GENERATIVE_PITCH_COUNT } from "./types";
import type { GenerativeTrack, NoteEvent, ProjectDocument } from "../project-model/types";
import { PPQ, STEP_TICKS } from "../project-model/types";
import { ticksPerBar } from "../project-model/schema";
import { valueAt } from "../project-model/automation";

const MAX_CONDITIONING_SECONDS = 120;

export interface GenerativeConditioningOptions {
  /** Effective transport BPM (scene override wins over document BPM). */
  bpm?: number;
  /** Runtime resolver for a persisted audio style reference. */
  resolveAudioStyle?: (bufferId: string) => GenerativeStyle & { kind: "audio" };
  /** Runtime-resolved macro values, including section/automation overlays. */
  macros?: GenerativeMacroValues;
}

/** Resolve persisted macro lanes and the active scene intensity at a tick. */
export function resolveGenerativeMacrosAtTick(
  doc: ProjectDocument,
  track: GenerativeTrack,
  tick: number,
): GenerativeMacroValues {
  const macros: GenerativeMacroValues = { ...track.generative.macros };
  for (const lane of track.generative.automation ?? []) {
    macros[lane.macro] = Math.min(1, Math.max(0, valueAt(lane.points, tick, macros[lane.macro])));
  }
  const bar = tick / ticksPerBar(doc);
  const clip = doc.arrangement.clips.find(
    (candidate) => bar >= candidate.startBar && bar < candidate.startBar + candidate.lengthBars,
  );
  const scene = clip
    ? doc.scenes.find((candidate) => candidate.id === clip.sceneId)
    : doc.scenes.find((candidate) => candidate.patternId === doc.activePatternId);
  if (!scene || !Number.isFinite(scene.intensity)) return macros;
  const intensity = Math.min(1, Math.max(0, scene.intensity));
  const level = 0.25 + intensity * 0.75;
  return {
    energy: Math.min(1, Math.max(0, macros.energy * level)),
    density: Math.min(1, Math.max(0, macros.density * (0.65 + intensity * 0.35))),
    variation: Math.min(1, Math.max(0, macros.variation * (0.8 + intensity * 0.2))),
    texture: Math.min(1, Math.max(0, macros.texture * (0.75 + intensity * 0.25))),
  };
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function noteStateAtFrame(
  notes: readonly NoteEvent[],
  frameStart: number,
  frameEnd: number,
  patternTicks: number,
): number[] {
  const state = new Array<number>(GENERATIVE_PITCH_COUNT).fill(0);
  if (notes.length === 0) return state;
  const safePatternTicks = Math.max(STEP_TICKS, patternTicks);
  const position = modulo(frameStart, safePatternTicks);
  const frameLength = Math.max(1, frameEnd - frameStart);
  const windowEnd = position + frameLength;
  for (const note of notes) {
    if (!Number.isFinite(note.pitch) || !Number.isFinite(note.start) || !Number.isFinite(note.duration)) continue;
    const pitch = Math.round(note.pitch);
    if (pitch < 0 || pitch >= GENERATIVE_PITCH_COUNT || note.duration <= 0) continue;
    const normalizedStart = modulo(note.start, safePatternTicks);
    for (let cycle = -1; cycle <= 1; cycle++) {
      const start = normalizedStart + cycle * safePatternTicks;
      const end = start + note.duration;
      if (start >= windowEnd || end <= position) continue;
      const onsetInFrame = start >= position && start < windowEnd;
      state[pitch] = onsetInFrame ? 2 : Math.max(state[pitch] ?? 0, 1);
    }
  }
  return state;
}

function notesForSources(doc: ProjectDocument, track: GenerativeTrack): NoteEvent[] {
  const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
  if (!pattern) return [];
  const sourceIds = [track.generative.noteSourceTrackId, track.generative.chordSourceTrackId].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  const notes: NoteEvent[] = [];
  for (const sourceId of sourceIds) notes.push(...(pattern.notes?.[sourceId] ?? []));
  return notes;
}

function styleOf(track: GenerativeTrack, options: GenerativeConditioningOptions): GenerativeStyle {
  if (track.generative.style.kind === "text") return { ...track.generative.style };
  const style = options.resolveAudioStyle?.(track.generative.style.bufferId);
  if (!style) throw new Error(`Audio style asset ${track.generative.style.bufferId} is unavailable`);
  return style;
}

/**
 * Convert the serializable KYX track recipe plus active pattern notes into the
 * provider-neutral frame contract. This is pure and intentionally does not
 * open audio contexts, talk to a provider, or read React state.
 */
export function buildGenerativeInput(
  doc: ProjectDocument,
  track: GenerativeTrack,
  startTick: number,
  durationTicks: number,
  options: GenerativeConditioningOptions = {},
): GenerativeInput {
  if (!Number.isFinite(startTick) || startTick < 0) throw new Error("startTick must be non-negative");
  if (!Number.isFinite(durationTicks) || durationTicks <= 0) throw new Error("durationTicks must be positive");
  const bpm = Number.isFinite(options.bpm) && (options.bpm ?? 0) > 0 ? options.bpm! : doc.bpm;
  const ticksPerSecond = PPQ * (bpm / 60);
  const durationSec = durationTicks / ticksPerSecond;
  if (durationSec > MAX_CONDITIONING_SECONDS) throw new Error("conditioning window exceeds 120 seconds");
  const ticksPerFrame = ticksPerSecond / GENERATIVE_FRAME_RATE_HZ;
  const frameCount = Math.max(1, Math.ceil(durationTicks / ticksPerFrame));
  const notes = notesForSources(doc, track);
  const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
  const patternTicks = Math.max(STEP_TICKS, (pattern?.stepCount ?? 16) * STEP_TICKS);
  const noteFrames = Array.from({ length: frameCount }, (_, frameIndex) => {
    const frameStart = startTick + frameIndex * ticksPerFrame;
    return {
      frameIndex,
      pitchState: noteStateAtFrame(notes, frameStart, frameStart + ticksPerFrame, patternTicks),
    };
  });
  return {
    bpm,
    frameRateHz: GENERATIVE_FRAME_RATE_HZ,
    startTick,
    style: styleOf(track, options),
    noteFrames,
    drumsMode: track.generative.drumsMode,
    macros: { ...(options.macros ?? track.generative.macros) },
    ...(track.generative.seed !== undefined ? { seed: track.generative.seed } : {}),
  };
}
