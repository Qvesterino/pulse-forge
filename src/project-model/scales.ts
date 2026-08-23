/**
 * Scale computation module for Pulse Forge.
 * Defines 9 scale types (FEATURES.md §7), computes valid pitches from a
 * MusicalKey, and provides snap / quantize helpers used by the piano roll.
 */
import type { MusicalKey } from "./types";

/** Semitone intervals from the root for each scale type (0 = root). */
export type ScaleType =
  | "major"
  | "natural_minor"
  | "harmonic_minor"
  | "melodic_minor"
  | "dorian"
  | "phrygian"
  | "mixolydian"
  | "pentatonic_major"
  | "pentatonic_minor";

export const SCALE_TYPES: ScaleType[] = [
  "major",
  "natural_minor",
  "harmonic_minor",
  "melodic_minor",
  "dorian",
  "phrygian",
  "mixolydian",
  "pentatonic_major",
  "pentatonic_minor",
];

export const SCALE_LABELS: Record<ScaleType, string> = {
  major: "Major",
  natural_minor: "Natural Minor",
  harmonic_minor: "Harmonic Minor",
  melodic_minor: "Melodic Minor",
  dorian: "Dorian",
  phrygian: "Phrygian",
  mixolydian: "Mixolydian",
  pentatonic_major: "Pentatonic Major",
  pentatonic_minor: "Pentatonic Minor",
};

export const SCALE_INTERVALS: Record<ScaleType, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  natural_minor: [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  melodic_minor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonic_major: [0, 2, 4, 7, 9],
  pentatonic_minor: [0, 2, 3, 7, 8],
};

const ROOT_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const ROOT_OFFSETS: Record<string, number> = {};
ROOT_NAMES.forEach((name, i) => (ROOT_OFFSETS[name] = i));

export function parseKey(key: MusicalKey): { root: number; scaleType: ScaleType } | null {
  if (!key || typeof key !== "string") return null;
  // Try to match from the end: scale types are the longest matching suffix.
  for (const scale of SCALE_TYPES) {
    const label = SCALE_LABELS[scale];
    if (key.endsWith(label)) {
      const rootName = key.slice(0, key.length - label.length - 1).trim();
      const root = ROOT_OFFSETS[rootName];
      if (root !== undefined) return { root, scaleType: scale };
    }
  }
  return null;
}

export function formatKey(root: number, scaleType: ScaleType): MusicalKey {
  return (`${ROOT_NAMES[root]} ${SCALE_LABELS[scaleType]}`) as MusicalKey;
}

/** Get all MIDI pitches in the scale within [pitchMin, pitchMax]. */
export function getScalePitchesInRange(key: MusicalKey, pitchMin: number, pitchMax: number): Set<number> {
  const parsed = parseKey(key);
  if (!parsed) return new Set();
  const intervals = SCALE_INTERVALS[parsed.scaleType];
  const result = new Set<number>();
  for (let octave = Math.floor(pitchMin / 12) - 1; octave <= Math.ceil(pitchMax / 12) + 1; octave++) {
    for (const interval of intervals) {
      const pitch = octave * 12 + parsed.root + interval;
      if (pitch >= pitchMin && pitch <= pitchMax) {
        result.add(pitch);
      }
    }
  }
  return result;
}

/** Check if a MIDI pitch is in the given key's scale. */
export function isInScale(pitch: number, key: MusicalKey): boolean {
  const parsed = parseKey(key);
  if (!parsed) return true; // if no key set, everything is "in scale"
  const intervals = SCALE_INTERVALS[parsed.scaleType];
  const semitone = ((pitch % 12) + 12) % 12;
  const root = parsed.root;
  return intervals.some((interval) => (semitone - root + 12) % 12 === interval);
}

/** Snap a MIDI pitch to the nearest degree in the scale. If pitch is already in scale, returns it unchanged. */
export function snapToScale(pitch: number, key: MusicalKey): number {
  const parsed = parseKey(key);
  if (!parsed) return pitch;
  const intervals = SCALE_INTERVALS[parsed.scaleType];
  const semitone = ((pitch % 12) + 12) % 12;
  const octave = Math.floor(pitch / 12);
  const offset = (semitone - parsed.root + 12) % 12;

  if (intervals.includes(offset)) return pitch; // already in scale

  // Find nearest scale degree above and below
  let best = pitch;
  let bestDist = Infinity;
  for (const interval of intervals) {
    // Try same octave
    const candidate = octave * 12 + parsed.root + interval;
    const dist = Math.abs(candidate - pitch);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
    // Try octave below
    const below = (octave - 1) * 12 + parsed.root + interval;
    const distBelow = Math.abs(below - pitch);
    if (distBelow < bestDist) {
      bestDist = distBelow;
      best = below;
    }
    // Try octave above
    const above = (octave + 1) * 12 + parsed.root + interval;
    const distAbove = Math.abs(above - pitch);
    if (distAbove < bestDist) {
      bestDist = distAbove;
      best = above;
    }
  }
  return best;
}

/** Get the display name of a scale degree (1–7) for a given pitch. */
export function scaleDegreeLabel(pitch: number, key: MusicalKey): string | null {
  const parsed = parseKey(key);
  if (!parsed) return null;
  const intervals = SCALE_INTERVALS[parsed.scaleType];
  const semitone = ((pitch % 12) + 12) % 12;
  const offset = (semitone - parsed.root + 12) % 12;
  const idx = intervals.indexOf(offset);
  if (idx < 0) return null;
  // Pentatonic uses 1,2,3,4,5 labels; heptatonic uses 1..7
  const labels = intervals.length <= 5
    ? ["1", "2", "3", "4", "5"]
    : ["1", "2", "3", "4", "5", "6", "7"];
  return labels[idx] ?? null;
}

/** Root note label from a pitch. */
export function rootNoteName(pitch: number): string {
  return ROOT_NAMES[((pitch % 12) + 12) % 12];
}

export { ROOT_NAMES };
