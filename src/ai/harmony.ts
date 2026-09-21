/**
 * FUNCTIONAL HARMONY ENGINE (INTENT_ENGINE.md #2) — chord progressions with
 * tonal function awareness, voice leading, and modal interchange.
 *
 * This replaces "random chord from Markov model" with HARMONIC LOGIC:
 * the engine knows that a dominant resolves to the tonic, that
 * subdominant → dominant is a strong motion, and that modal interchange
 * (borrowing from the parallel mode) adds colour without losing tonality.
 *
 * Deterministic — the progression is selected from the seed, and voice
 * leading is computed from the chord intervals (no RNG for the core
 * progression, only for voicing variation).
 */

export type ChordQuality = "maj" | "min" | "dim" | "dom7" | "maj7" | "min7" | "sus4" | "sus2";
export type HarmonicFunction = "T" | "S" | "D" | "p"; // Tonic, Subdominant, Dominant, passing

export interface ChordEvent {
  /** Scale degree of the chord root (0 = tonic, 1 = supertonic, …) */
  degree: number;
  quality: ChordQuality;
  /** Duration in steps */
  duration: number;
  func: HarmonicFunction;
}

export interface ChordProgression {
  name: string;
  genre: string;
  events: ChordEvent[];
}

/** Intervals from the chord root for each quality (semitones). */
export const CHORD_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  dom7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  sus4: [0, 5, 7],
  sus2: [0, 2, 7],
};

/** Roman numeral analysis label for diagnostics. */
export function romanNumeral(degree: number, quality: ChordQuality): string {
  const romans = ["I", "II", "III", "IV", "V", "VI", "VII"];
  let base = romans[degree % 7];
  if (quality === "min" || quality === "min7" || quality === "dim") base = base.toLowerCase();
  if (quality === "dom7" || quality === "maj7" || quality === "min7") base += "7";
  return base;
}

// ── Per-genre progression library ───────────────────────────────────────────
// Each progression is 4 bars (16 steps per bar = 4 steps per chord unless noted).
// Degrees are 0-indexed scale degrees (0 = tonic).

const HOUSE_PROGRESSIONS: ChordProgression[] = [
  {
    name: "I-vi-IV-V (pop hook)",
    genre: "house",
    events: [
      { degree: 0, quality: "maj7", duration: 4, func: "T" },
      { degree: 5, quality: "min7", duration: 4, func: "T" },
      { degree: 3, quality: "maj", duration: 4, func: "S" },
      { degree: 4, quality: "dom7", duration: 4, func: "D" },
    ],
  },
  {
    name: "i-VII-VI-VII (deep minor loop)",
    genre: "house",
    events: [
      { degree: 0, quality: "min7", duration: 4, func: "T" },
      { degree: 6, quality: "maj", duration: 4, func: "p" },
      { degree: 5, quality: "maj", duration: 4, func: "S" },
      { degree: 6, quality: "maj", duration: 4, func: "p" },
    ],
  },
  {
    name: "ii-V-I (jazzy resolution)",
    genre: "house",
    events: [
      { degree: 1, quality: "min7", duration: 4, func: "S" },
      { degree: 4, quality: "dom7", duration: 4, func: "D" },
      { degree: 0, quality: "maj7", duration: 8, func: "T" },
    ],
  },
];

const TECHNO_PROGRESSIONS: ChordProgression[] = [
  {
    name: "i-♭VI (dark loop)",
    genre: "techno",
    events: [
      { degree: 0, quality: "min", duration: 8, func: "T" },
      { degree: 5, quality: "maj", duration: 8, func: "p" },
    ],
  },
  {
    name: "i-iv-♭VII-i (hypnotic cycle)",
    genre: "techno",
    events: [
      { degree: 0, quality: "min", duration: 4, func: "T" },
      { degree: 3, quality: "min", duration: 4, func: "S" },
      { degree: 6, quality: "maj", duration: 4, func: "p" },
      { degree: 0, quality: "min", duration: 4, func: "T" },
    ],
  },
  {
    name: "i-♭II (phrygian, industrial)",
    genre: "techno",
    events: [
      { degree: 0, quality: "min", duration: 8, func: "T" },
      { degree: 1, quality: "maj", duration: 8, func: "D" },
    ],
  },
];

const TRAP_PROGRESSIONS: ChordProgression[] = [
  {
    name: "i-VI-III-VII (emotional trap loop)",
    genre: "trap",
    events: [
      { degree: 0, quality: "min", duration: 4, func: "T" },
      { degree: 5, quality: "maj", duration: 4, func: "S" },
      { degree: 2, quality: "maj", duration: 4, func: "p" },
      { degree: 6, quality: "maj", duration: 4, func: "p" },
    ],
  },
  {
    name: "i-iv-v (dark trap minor)",
    genre: "trap",
    events: [
      { degree: 0, quality: "min", duration: 4, func: "T" },
      { degree: 3, quality: "min7", duration: 4, func: "S" },
      { degree: 4, quality: "min", duration: 4, func: "D" },
      { degree: 3, quality: "min7", duration: 4, func: "S" },
    ],
  },
  {
    name: "i-♭VI-♭III-♭VII (anthem loop)",
    genre: "trap",
    events: [
      { degree: 0, quality: "min", duration: 4, func: "T" },
      { degree: 5, quality: "maj", duration: 4, func: "S" },
      { degree: 2, quality: "maj", duration: 4, func: "p" },
      { degree: 6, quality: "maj", duration: 4, func: "S" },
    ],
  },
];

const AMBIENT_PROGRESSIONS: ChordProgression[] = [
  {
    name: "Imaj7-IVmaj7 (lounge flow)",
    genre: "ambient",
    events: [
      { degree: 0, quality: "maj7", duration: 8, func: "T" },
      { degree: 3, quality: "maj7", duration: 8, func: "S" },
    ],
  },
  {
    name: "i7-iv7 (modal drift)",
    genre: "ambient",
    events: [
      { degree: 0, quality: "min7", duration: 8, func: "T" },
      { degree: 3, quality: "min7", duration: 8, func: "S" },
    ],
  },
  {
    name: "Isus2-♭IIIsus2 (open, unresolved)",
    genre: "ambient",
    events: [
      { degree: 0, quality: "sus2", duration: 8, func: "T" },
      { degree: 2, quality: "sus2", duration: 8, func: "p" },
    ],
  },
];

export const PROGRESSIONS_BY_GENRE: Record<string, ChordProgression[]> = {
  house: HOUSE_PROGRESSIONS,
  techno: TECHNO_PROGRESSIONS,
  trap: TRAP_PROGRESSIONS,
  ambient: AMBIENT_PROGRESSIONS,
};

/**
 * Select a progression deterministically from the seed.
 * The index is seed % progressions.length — simple, reproducible.
 */
export function selectProgression(genre: string, seed: number): ChordProgression {
  const list = PROGRESSIONS_BY_GENRE[genre] ?? HOUSE_PROGRESSIONS;
  return list[seed % list.length];
}

/**
 * Extend a progression to fill `targetBars` bars by looping it.
 * Each event covers `duration` steps (typically 4 = one bar at 4/4).
 */
export function expandProgression(
  progression: ChordProgression,
  targetSteps: number,
): ChordEvent[] {
  const result: ChordEvent[] = [];
  let totalSteps = 0;
  let loop = 0;
  while (totalSteps < targetSteps) {
    for (const event of progression.events) {
      if (totalSteps >= targetSteps) break;
      result.push({ ...event });
      totalSteps += event.duration;
    }
    loop += 1;
    if (loop > 64) break; // safety
  }
  return result;
}

/**
 * Get the chord tones (as scale-degree offsets from the chord root) for a
 * quality. These are SEMITONE offsets from the chord root pitch, not scale
 * degrees — the caller converts to absolute pitches using the scale intervals.
 */
export function chordToneSemitones(quality: ChordQuality): number[] {
  return CHORD_INTERVALS[quality];
}

/**
 * Voice leading: find the chord voicing that minimises movement from the
 * previous voicing. Returns chord tones as semitone offsets from the root,
 * rotated to be closest to the previous voicing's intervals.
 */
export function voiceLead(
  previousPitches: number[],
  rootPitch: number,
  quality: ChordQuality,
): number[] {
  const intervals = CHORD_INTERVALS[quality];
  if (previousPitches.length === 0) return intervals.map((i) => rootPitch + i);

  // Try all rotations of the chord tones, pick the one closest (L1) to previous
  let bestRotation = intervals;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let rotation = 0; rotation < intervals.length; rotation++) {
    const rotated = intervals.map((_, i) => intervals[(i + rotation) % intervals.length]);
    let distance = 0;
    for (let i = 0; i < Math.min(previousPitches.length, rotated.length); i++) {
      distance += Math.abs(rootPitch + rotated[i] - previousPitches[i]);
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      bestRotation = rotated;
    }
  }
  return bestRotation.map((i) => rootPitch + i);
}
