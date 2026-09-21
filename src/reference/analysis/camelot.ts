/**
 * Deterministic Camelot wheel mapping. Ported from audiokey `src/analysis/camelot.ts`.
 * Examples: C major -> 8B, A minor -> 8A, F# minor -> 11A.
 */
import type { PitchClass, ReferenceMode } from "../types";
import { PITCH_CLASSES } from "../types";

const MAJOR_CAMELOT: Record<string, string> = {
  C: "8B",
  "C#": "3B",
  D: "10B",
  "D#": "5B",
  E: "12B",
  F: "7B",
  "F#": "2B",
  G: "9B",
  "G#": "4B",
  A: "11B",
  "A#": "6B",
  B: "1B",
};

const MINOR_CAMELOT: Record<string, string> = {
  C: "5A",
  "C#": "12A",
  D: "7A",
  "D#": "2A",
  E: "9A",
  F: "4A",
  "F#": "11A",
  G: "6A",
  "G#": "1A",
  A: "8A",
  "A#": "3A",
  B: "10A",
};

export function camelotFromKey(tonic: PitchClass, mode: ReferenceMode): string {
  return mode === "major" ? MAJOR_CAMELOT[tonic] : MINOR_CAMELOT[tonic];
}

export function pitchClassName(index: number): PitchClass {
  return PITCH_CLASSES[((index % 12) + 12) % 12];
}

/** 0..11 index for a pitch-class name. */
export function pitchClassIndex(name: PitchClass): number {
  return PITCH_CLASSES.indexOf(name);
}
