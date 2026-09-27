import type { MusicalKey } from "../project-model/types";
import { parseKey, SCALE_INTERVALS } from "../project-model/scales";

/**
 * VOCAL HARMONY (vocal lane) — diatonic harmony stacks over a sung melody.
 *
 * Input melody notes are the SINGER's pitches (from YIN tracking via
 * hum-to-notes, or any NoteEvent source). Every harmony note is derived
 * INSIDE the song key: the melody pitch snaps to the nearest scale tone,
 * moves the requested diatonic distance, and the result folds back into the
 * singer's octave (a harmony more than an octave away stops feeling like a
 * stack). Unisons are impossible by construction — a third/fifth shift from
 * a snapped scale tone always lands on a different pitch class.
 */

export type HarmonyInterval = "third-above" | "third-below" | "fifth-below";

export interface HarmonySourceNote {
  pitch: number;
  start: number;
  duration: number;
}

export interface HarmonyNote {
  pitch: number;
  start: number;
  duration: number;
  /** The requested stack (every harmony note carries its voice). */
  interval: HarmonyInterval;
}

/** Diatonic step distance (scale degrees, signed) per stack. */
const INTERVAL_STEPS: Record<HarmonyInterval, number> = {
  "third-above": 2,
  "third-below": -2,
  "fifth-below": -4,
};

/** Diatonic shift inside the scale, expressed in semitones from `pitch`. */
function shiftDiatonic(pitch: number, steps: number, root: number, scale: readonly number[]): number {
  const octave = Math.floor(pitch / 12);
  const pitchClass = ((pitch % 12) + 12) % 12;
  // index of the nearest scale tone above-or-equal within this octave
  let index = scale.findIndex((interval) => (((root + interval) % 12) + 12) % 12 === pitchClass);
  if (index < 0) {
    // off-scale melody note: snap UP to the next scale tone first
    for (let offset = 1; offset <= 6; offset++) {
      const candidate = (pitchClass + offset) % 12;
      index = scale.findIndex((interval) => (((root + interval) % 12) + 12) % 12 === candidate);
      if (index >= 0) break;
    }
    if (index < 0) return pitch + steps >= 0 ? pitch : pitch;
  }
  let newIndex = index + steps;
  let newOctave = octave;
  while (newIndex < 0) {
    newIndex += scale.length;
    newOctave -= 1;
  }
  while (newIndex >= scale.length) {
    newIndex -= scale.length;
    newOctave += 1;
  }
  return newOctave * 12 + ((root + scale[newIndex]!) % 12);
}

/**
 * Build the harmony stack for a melody. Every melody note yields exactly one
 * harmony note at the requested diatonic distance, folded into the singer's
 * octave (max ±12 semitones away) so the stack reads as backing vocals.
 */
export function planVocalHarmony(
  melody: readonly HarmonySourceNote[],
  key: MusicalKey,
  interval: HarmonyInterval = "third-above",
): HarmonyNote[] {
  const parsed = parseKey(key);
  if (!parsed) return [];
  const scale = SCALE_INTERVALS[parsed.scaleType];
  const steps = INTERVAL_STEPS[interval];

  return melody.map((note) => {
    let harmony = shiftDiatonic(note.pitch, steps, parsed.root, scale);
    // fold into the singer's octave — a backing vocal never drifts an octave away
    while (harmony - note.pitch > 12) harmony -= 12;
    while (note.pitch - harmony > 12) harmony += 12;
    return { pitch: harmony, start: note.start, duration: note.duration, interval };
  });
}

/** Convenience: harmony stacks for the classic backing pair (above + below). */
export function planVocalHarmonyPair(
  melody: readonly HarmonySourceNote[],
  key: MusicalKey,
): { above: HarmonyNote[]; below: HarmonyNote[] } {
  return {
    above: planVocalHarmony(melody, key, "third-above"),
    below: planVocalHarmony(melody, key, "third-below"),
  };
}
