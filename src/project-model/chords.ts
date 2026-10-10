/**
 * CHORD TRACK — pure music theory for the arrangement's chord lane (schema
 * v17). Deliberately model-level (not `src/ai/`): a chord is project data,
 * and the quality/interval tables here are the single source both the model
 * and UI read. The AI harmony module (src/ai/harmony.ts) uses the same
 * quality union — the two unions are structurally identical on purpose.
 *
 * A chord event occupies whole bars on the arrangement (same integer-bar
 * contract as scene clips, same no-overlap lane), and everything is a pitch
 * CLASS (0–11, C = 0) — voicing/octave is left to the instruments.
 */

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export type ChordQuality = "maj" | "min" | "dim" | "dom7" | "maj7" | "min7" | "sus4" | "sus2";

/** Semitone intervals from the chord root, ascending. */
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

/** Human label per quality — appended to the root name ("Cmaj7"). */
export const CHORD_LABELS: Record<ChordQuality, string> = {
  maj: "",
  min: "m",
  dim: "dim",
  dom7: "7",
  maj7: "maj7",
  min7: "m7",
  sus4: "sus4",
  sus2: "sus2",
};

export const CHORD_QUALITIES = Object.keys(CHORD_INTERVALS) as ChordQuality[];

/** Pitch classes (0–11) a chord contains, root included. */
export function chordPitchClasses(root: number, quality: ChordQuality): number[] {
  if (!Number.isFinite(root)) return [];
  const rootClass = ((Math.round(root) % 12) + 12) % 12;
  return CHORD_INTERVALS[quality].map((interval) => (rootClass + interval) % 12);
}

/** Display name: root note + quality suffix ("C", "Am7", "F#maj7", "Gsus4"). */
export function chordName(root: number, quality: ChordQuality): string {
  if (!Number.isFinite(root)) return "?";
  const rootClass = ((Math.round(root) % 12) + 12) % 12;
  return `${NOTE_NAMES[rootClass]}${CHORD_LABELS[quality]}`;
}

/** The chord event covering an absolute arrangement tick, if any. */
export function chordAtTick(
  chords: readonly { id: string; startBar: number; lengthBars: number; root: number; quality: ChordQuality }[],
  tick: number,
): { root: number; quality: ChordQuality } | null {
  for (const chord of chords) {
    const start = chord.startBar * 1920;
    if (tick >= start && tick < start + chord.lengthBars * 1920) {
      return { root: chord.root, quality: chord.quality };
    }
  }
  return null;
}

/**
 * Snap a MIDI pitch to the NEAREST chord tone (searching ±6 semitones, so a
 * pitch always keeps its octave neighborhood). Used by the piano roll's
 * chord-snap: inserted or dragged notes land on tones of the chord under the
 * cursor. Returns the pitch unchanged when nothing applies.
 */
export function nearestChordPitch(
  pitch: number,
  chord: { root: number; quality: ChordQuality },
  range: { min: number; max: number } = { min: 0, max: 127 },
): number {
  if (!Number.isFinite(pitch)) return pitch;
  const tones = chordPitchClasses(chord.root, chord.quality);
  let best = Math.max(range.min, Math.min(range.max, Math.round(pitch)));
  let bestDist = Number.POSITIVE_INFINITY;
  for (let candidate = Math.max(range.min, pitch - 6); candidate <= Math.min(range.max, pitch + 6); candidate++) {
    if (!tones.includes(((candidate % 12) + 12) % 12)) continue;
    const distance = Math.abs(candidate - pitch);
    if (distance < bestDist) {
      bestDist = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * SUGGEST a chord for a set of pitch classes (e.g. the notes of a pattern):
 * score every root × quality by how many of the chord's tones are present
 * and how many of the given pitches the chord explains. Deterministic; ties
 * break toward the earlier scale-degree root and simpler triads. Returns
 * null when there are fewer than two distinct pitch classes (any chord fits
 * nothing).
 */
export function suggestChordFromPitches(
  pitchClasses: readonly number[],
): { root: number; quality: ChordQuality; score: number } | null {
  const present = new Set(pitchClasses.filter((p) => Number.isFinite(p)).map((p) => ((Math.round(p) % 12) + 12) % 12));
  if (present.size < 2) return null;
  let best: { root: number; quality: ChordQuality; score: number } | null = null;
  for (let root = 0; root < 12; root++) {
    for (const quality of CHORD_QUALITIES) {
      const tones = chordPitchClasses(root, quality);
      const tonesInChord = tones.filter((t) => present.has(t)).length;
      // Explain: chord tones found / chord tones. Coverage: how much of the
      // input the chord accounts for. A triad matching 3 of 3 input classes
      // beats a seventh that matches 3 of 4 only via the coverage term.
      const explained = present.size === 0 ? 0 : tonesInChord / present.size;
      const purity = tonesInChord / tones.length;
      const score = explained * 2 + purity;
      if (tonesInChord < 2) continue;
      if (!best || score > best.score + 1e-9) best = { root, quality, score };
    }
  }
  return best;
}
