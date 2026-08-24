import type { MusicalKey, NoteEvent } from "../project-model/types";
import { parseKey, SCALE_INTERVALS, snapToScale } from "../project-model/scales";
import { clamp } from "../shared/ids";
import { hashString, mulberry32 } from "../shared/rng";

export type ChordMode = "diatonic" | "explicit";
export type ChordQuality =
  | "major"
  | "minor"
  | "diminished"
  | "augmented"
  | "sus2"
  | "sus4"
  | "dominant7"
  | "major7"
  | "minor7"
  | "add9";
export type ChordVoicing = "close" | "open" | "drop2";
export type StrumDirection = "up" | "down";

export const CHORD_QUALITIES: readonly ChordQuality[] = [
  "major",
  "minor",
  "diminished",
  "augmented",
  "sus2",
  "sus4",
  "dominant7",
  "major7",
  "minor7",
  "add9",
];

export const CHORD_INTERVALS: Record<ChordQuality, readonly number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  diminished: [0, 3, 6],
  augmented: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dominant7: [0, 4, 7, 10],
  major7: [0, 4, 7, 11],
  minor7: [0, 3, 7, 10],
  add9: [0, 4, 7, 14],
};

export interface ChordOptions {
  mode: ChordMode;
  quality: ChordQuality;
  voicing: ChordVoicing;
  inversion: number;
  seventh: boolean;
  gate: number;
  strumTicks: number;
  strumDirection: StrumDirection;
  scaleLock: boolean;
  key?: MusicalKey;
}

export interface TimingPerformanceOptions {
  timingTicks: number;
  velocityAmount: number;
  seed: string;
}

export interface VelocityPerformanceOptions {
  amount: number;
  seed: string;
}

export interface StrumOptions {
  spreadTicks: number;
  direction: StrumDirection;
}

export type MidiCreativeOperation =
  | { kind: "snap-scale"; key: MusicalKey }
  | { kind: "chord"; options: ChordOptions }
  | { kind: "reverse"; scaleLock: boolean; key?: MusicalKey }
  | { kind: "invert"; scaleLock: boolean; key?: MusicalKey }
  | { kind: "halve"; scaleLock: boolean; key?: MusicalKey }
  | { kind: "double"; scaleLock: boolean; key?: MusicalKey }
  | { kind: "strum"; options: StrumOptions; scaleLock: boolean; key?: MusicalKey }
  | { kind: "gate"; gate: number; scaleLock: boolean; key?: MusicalKey }
  | { kind: "humanize"; options: TimingPerformanceOptions; scaleLock: boolean; key?: MusicalKey }
  | { kind: "velocity-randomize"; options: VelocityPerformanceOptions; scaleLock: boolean; key?: MusicalKey };

const MIN_VELOCITY = 0.05;

function mod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function clampNote(note: NoteEvent, patternTicks: number): NoteEvent {
  const safePatternTicks = Math.max(1, Math.round(patternTicks));
  const start = clamp(Math.round(note.start), 0, Math.max(0, safePatternTicks - 1));
  const duration = clamp(Math.round(note.duration), 1, Math.max(1, safePatternTicks - start));
  return {
    ...note,
    pitch: clamp(Math.round(note.pitch), 0, 127),
    start,
    duration,
    velocity: clamp(note.velocity, MIN_VELOCITY, 1),
  };
}

function withScaleLock(note: NoteEvent, key: MusicalKey | undefined, enabled: boolean): NoteEvent {
  return enabled && key ? { ...note, pitch: clamp(snapToScale(note.pitch, key), 0, 127) } : note;
}

function scaleStepPitch(pitch: number, key: MusicalKey, steps: number): number {
  const parsed = parseKey(key);
  if (!parsed) return pitch;
  const intervals = SCALE_INTERVALS[parsed.scaleType];
  let current = snapToScale(pitch, key);
  const direction = steps < 0 ? -1 : 1;
  for (let i = 0; i < Math.abs(steps); i++) {
    let candidate = current + direction;
    while (!intervals.includes(mod(candidate - parsed.root, 12))) candidate += direction;
    current = candidate;
  }
  return current;
}

function diatonicPitches(rootPitch: number, key: MusicalKey, seventh: boolean): number[] {
  const parsed = parseKey(key);
  if (!parsed) throw new Error(`Invalid project key ${key}`);
  const intervals = SCALE_INTERVALS[parsed.scaleType];
  const snappedRoot = snapToScale(rootPitch, key);
  const rootDegree = intervals.findIndex((interval) => mod(snappedRoot - parsed.root, 12) === interval);
  if (rootDegree < 0) throw new Error(`Root ${rootPitch} is not compatible with ${key}`);
  const offsets = seventh ? [0, 2, 4, 6] : [0, 2, 4];
  return offsets.map((offset) => scaleStepPitch(snappedRoot, key, offset));
}

function applyVoicing(pitches: number[], voicing: ChordVoicing, inversion: number): number[] {
  if (pitches.length === 0) return [];
  const voiced = [...pitches];
  const safeInversion = Math.min(Math.max(0, Math.round(inversion)), voiced.length - 1);
  for (let i = 0; i < safeInversion; i++) {
    const first = voiced.shift();
    if (first !== undefined) voiced.push(first + 12);
  }
  if (voicing === "open" && voiced.length > 2) {
    for (let i = 1; i < voiced.length; i += 2) voiced[i] += 12;
  }
  if (voicing === "drop2" && voiced.length > 2) {
    const index = voiced.length - 2;
    voiced[index] -= 12;
  }
  return voiced.sort((a, b) => a - b);
}

export function createChordNotes(
  root: NoteEvent,
  options: ChordOptions,
  patternTicks: number,
  makeId: (index: number) => string,
): NoteEvent[] {
  let pitches: number[];
  if (options.mode === "diatonic") {
    if (!options.key) throw new Error("Set a project key before using diatonic chords");
    pitches = diatonicPitches(root.pitch, options.key, options.seventh);
  } else {
    const intervals = CHORD_INTERVALS[options.quality];
    pitches = intervals.map((interval) => root.pitch + interval);
  }
  pitches = applyVoicing(pitches, options.voicing, options.inversion);
  const gate = clamp(Number.isFinite(options.gate) ? options.gate : 1, 0.01, 1);
  const spread = Math.max(0, Math.round(options.strumTicks));
  const direction = options.strumDirection === "down" ? -1 : 1;
  const denominator = Math.max(1, pitches.length - 1);

  return pitches.map((pitch, index) => {
    const offset = spread > 0 ? Math.round((index / denominator) * spread) : 0;
    const strumOffset = direction === 1 ? offset : spread - offset;
    const note: NoteEvent = {
      id: makeId(index),
      pitch,
      start: root.start + strumOffset,
      duration: Math.max(1, Math.round(root.duration * gate)),
      velocity: root.velocity,
    };
    return clampNote(withScaleLock(note, options.key, options.scaleLock), patternTicks);
  });
}

export function snapNotesToScale(notes: NoteEvent[], key: MusicalKey, patternTicks: number): NoteEvent[] {
  return notes.map((note) => clampNote(withScaleLock(note, key, true), patternTicks));
}

export function reverseNotes(notes: NoteEvent[], patternTicks: number): NoteEvent[] {
  if (notes.length === 0) return [];
  const rangeStart = Math.min(...notes.map((note) => note.start));
  const rangeEnd = Math.max(...notes.map((note) => note.start + note.duration));
  return notes.map((note) => clampNote({
    ...note,
    start: rangeStart + rangeEnd - note.start - note.duration,
  }, patternTicks));
}

export function invertNotes(notes: NoteEvent[], patternTicks: number): NoteEvent[] {
  if (notes.length === 0) return [];
  const minPitch = Math.min(...notes.map((note) => note.pitch));
  const maxPitch = Math.max(...notes.map((note) => note.pitch));
  const pivot = (minPitch + maxPitch) / 2;
  return notes.map((note) => clampNote({ ...note, pitch: Math.round(2 * pivot - note.pitch) }, patternTicks));
}

function scaleTime(notes: NoteEvent[], factor: number, patternTicks: number): NoteEvent[] {
  if (notes.length === 0) return [];
  const origin = Math.min(...notes.map((note) => note.start));
  return notes.map((note) => clampNote({
    ...note,
    start: origin + Math.round((note.start - origin) * factor),
    duration: Math.max(1, Math.round(note.duration * factor)),
  }, patternTicks));
}

export function halveNotes(notes: NoteEvent[], patternTicks: number): NoteEvent[] {
  return scaleTime(notes, 0.5, patternTicks);
}

export function doubleNotes(notes: NoteEvent[], patternTicks: number): NoteEvent[] {
  return scaleTime(notes, 2, patternTicks);
}

function groupedByStart(notes: NoteEvent[]): Map<number, NoteEvent[]> {
  const groups = new Map<number, NoteEvent[]>();
  for (const note of notes) groups.set(note.start, [...(groups.get(note.start) ?? []), note]);
  return groups;
}

export function strumNotes(notes: NoteEvent[], options: StrumOptions, patternTicks: number): NoteEvent[] {
  const spread = Math.max(0, Math.round(options.spreadTicks));
  if (spread === 0) return notes.map((note) => clampNote(note, patternTicks));
  const result = notes.map((note) => ({ ...note }));
  for (const group of groupedByStart(result).values()) {
    const ordered = [...group].sort((a, b) => a.pitch - b.pitch);
    if (options.direction === "down") ordered.reverse();
    const denominator = Math.max(1, ordered.length - 1);
    ordered.forEach((note, index) => {
      note.start += Math.round((index / denominator) * spread);
    });
  }
  return result.map((note) => clampNote(note, patternTicks));
}

export function gateNotes(notes: NoteEvent[], gate: number, patternTicks: number): NoteEvent[] {
  const amount = clamp(Number.isFinite(gate) ? gate : 1, 0.01, 1);
  return notes.map((note) => clampNote({ ...note, duration: Math.max(1, Math.round(note.duration * amount)) }, patternTicks));
}

export function humanizeNotes(
  notes: NoteEvent[],
  options: TimingPerformanceOptions,
  patternTicks: number,
): NoteEvent[] {
  const random = mulberry32(hashString(options.seed));
  const timing = Math.max(0, Math.round(options.timingTicks));
  const velocity = Math.max(0, options.velocityAmount);
  return notes.map((note) => {
    const timingOffset = Math.round((random() * 2 - 1) * timing);
    const velocityOffset = (random() * 2 - 1) * velocity;
    return clampNote({
      ...note,
      start: note.start + timingOffset,
      velocity: note.velocity + velocityOffset,
    }, patternTicks);
  });
}

export function randomizeVelocity(
  notes: NoteEvent[],
  options: VelocityPerformanceOptions,
  patternTicks: number,
): NoteEvent[] {
  const random = mulberry32(hashString(options.seed));
  const amount = Math.max(0, options.amount);
  return notes.map((note) => clampNote({
    ...note,
    velocity: note.velocity + (random() * 2 - 1) * amount,
  }, patternTicks));
}

export function applyScaleOption(
  notes: NoteEvent[],
  key: MusicalKey | undefined,
  scaleLock: boolean,
  patternTicks: number,
): NoteEvent[] {
  return scaleLock && key ? snapNotesToScale(notes, key, patternTicks) : notes.map((note) => clampNote(note, patternTicks));
}

