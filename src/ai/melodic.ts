import type { NoteEvent, MusicalKey } from '../project-model/types';
import type { GenerateOptions, MelodicNote } from './types';
import { STEP_TICKS } from '../project-model/types';
import { parseKey, snapToScale, SCALE_INTERVALS } from '../project-model/scales';
import { uid } from '../shared/ids';
import { MELODIC_BY_GENRE } from './grooves/melodic-data';

const DEGREE_MIN = -1; // rest
const DEGREE_MAX = 6;  // 7th
const DEGREE_COUNT = DEGREE_MAX - DEGREE_MIN + 1; // 8
const DURATIONS = [1, 2, 4, 8];
const DURATION_COUNT = DURATIONS.length;
const NUM_STATES = DEGREE_COUNT * DURATION_COUNT; // 32

/** Encode (degree, duration) into a flat state index */
function encodeMelodicState(degree: number, duration: number): number {
  const dIdx = DURATIONS.indexOf(duration);
  if (dIdx < 0) return 0;
  return (degree - DEGREE_MIN + 1) * DURATION_COUNT + dIdx;
}

/** Decode state index back to (degree, duration) */
function decodeMelodicState(index: number): { degree: number; duration: number } {
  const dIdx = index % DURATION_COUNT;
  const degree = Math.floor(index / DURATION_COUNT) + DEGREE_MIN;
  return { degree, duration: DURATIONS[dIdx] };
}

/** Build a Markov model from melodic reference sequences */
function buildMelodicModel(sequences: MelodicNote[][]): {
  transitions: Uint32Array;
  initial: Uint32Array;
  /** Observed velocities per state index, for sampling during generation */
  velocities: Map<number, number[]>;
} {
  const transitions = new Uint32Array(NUM_STATES * NUM_STATES);
  const initial = new Uint32Array(NUM_STATES);
  const velocities = new Map<number, number[]>();

  for (const seq of sequences) {
    if (seq.length < 1) continue;

    const firstState = encodeMelodicState(seq[0].degree, seq[0].duration);
    initial[firstState]++;
    if (seq[0].velocity > 0) {
      const vels = velocities.get(firstState) ?? [];
      vels.push(seq[0].velocity);
      velocities.set(firstState, vels);
    }

    for (let i = 0; i < seq.length - 1; i++) {
      const from = encodeMelodicState(seq[i].degree, seq[i].duration);
      const to = encodeMelodicState(seq[i + 1].degree, seq[i + 1].duration);
      transitions[from * NUM_STATES + to]++;
      if (seq[i + 1].velocity > 0) {
        const vels = velocities.get(to) ?? [];
        vels.push(seq[i + 1].velocity);
        velocities.set(to, vels);
      }
    }
  }

  return { transitions, initial, velocities };
}

/** Sample from a distribution vector */
function sampleDist(dist: Uint32Array, rand: () => number): number {
  let total = 0;
  for (let i = 0; i < dist.length; i++) total += dist[i];
  if (total === 0) return 0;

  let r = rand() * total;
  for (let i = 0; i < dist.length; i++) {
    r -= dist[i];
    if (r <= 0) return i;
  }
  return dist.length - 1;
}

/** Convert a scale degree to a MIDI pitch given root and scale intervals */
function degreeToPitch(degree: number, octaveOffset: number, root: number, intervals: readonly number[]): number {
  if (degree < 0) return -1; // rest
  const octave = Math.floor(degree / intervals.length);
  const idx = ((degree % intervals.length) + intervals.length) % intervals.length;
  const baseOctave = 3 + octaveOffset;
  return baseOctave * 12 + root + intervals[idx] + octave * 12;
}

/**
 * Chord voicings: each voicing is an array of degree offsets from the root.
 * For example, [0, 2, 4] means root + 3rd + 5th (triad).
 * The root degree comes from the Markov model, and these offsets are added to it.
 */
const CHORD_VOICINGS: number[][] = [
  [0, 2, 4],       // triad (root + 3rd + 5th)
  [0, 2, 4, 6],    // seventh (root + 3rd + 5th + 7th)
  [0, 4],           // power chord (root + 5th)
  [0, 3, 4],        // suspended (root + 4th + 5th)
  [0, 2, 4, 6],    // maj7 voicing
  [0, 3, 5],        // min triad inversion feel
];

/**
 * Velocity multipliers for chord voices: root is loudest, upper extensions softer.
 * Index 0 = root, index 1 = next, etc.
 */
const VOICE_VELOCITY_CURVE = [1.0, 0.85, 0.75, 0.65];

/** Expand a single degree into chord notes (multiple pitches at intervals) */
function expandChord(
  degree: number,
  _octaveOffset: number,
  _root: number,
  _intervals: readonly number[],
  velocity: number,
  rand: () => number,
): { degree: number; velocity: number }[] {
  // Pick a random voicing
  const voicing = CHORD_VOICINGS[Math.floor(rand() * CHORD_VOICINGS.length)];
  return voicing.map((offset, i) => ({
    degree: degree + offset,
    velocity: Math.max(0.1, Math.min(1, velocity * (VOICE_VELOCITY_CURVE[i] ?? 0.6))),
  }));
}

/** Sample a velocity from observed values for a state, with slight jitter */
function sampleVelocity(velocities: Map<number, number[]>, state: number, rand: () => number): number {
  const observed = velocities.get(state);
  if (observed && observed.length > 0) {
    // Pick a random observed velocity and add subtle jitter (±0.05)
    const base = observed[Math.floor(rand() * observed.length)];
    return Math.max(0.1, Math.min(1, base + (rand() - 0.5) * 0.1));
  }
  // Fallback: random velocity in a reasonable range
  return 0.5 + rand() * 0.3;
}

/** Generate a melodic sequence from a Markov model */
function generateMelodicSequence(
  model: { transitions: Uint32Array; initial: Uint32Array; velocities: Map<number, number[]> },
  length: number,
  rand: () => number,
): MelodicNote[] {
  const notes: MelodicNote[] = [];

  // Laplace smoothing on initial distribution
  const smoothedInitial = new Uint32Array(model.initial.length);
  for (let i = 0; i < model.initial.length; i++) {
    smoothedInitial[i] = model.initial[i] + 1;
  }
  let currentState = sampleDist(smoothedInitial, rand);

  for (let i = 0; i < length; i++) {
    const { degree, duration } = decodeMelodicState(currentState);

    // Skip consecutive rests — force a note instead
    if (degree < 0 && notes.length > 0 && notes[notes.length - 1].degree < 0) {
      const nonRest = new Uint32Array(smoothedInitial.length);
      for (let s = 0; s < nonRest.length; s++) {
        const d = decodeMelodicState(s);
        if (d.degree >= 0) nonRest[s] = smoothedInitial[s];
      }
      currentState = sampleDist(nonRest, rand);
      const forced = decodeMelodicState(currentState);
      notes.push({ degree: forced.degree, duration: forced.duration, velocity: sampleVelocity(model.velocities, currentState, rand) });
      continue;
    }

    notes.push({ degree, duration, velocity: sampleVelocity(model.velocities, currentState, rand) });

    if (i < length - 1) {
      const rowStart = currentState * NUM_STATES;
      const row = model.transitions.subarray(rowStart, rowStart + NUM_STATES);

      // Laplace smoothing on transition row
      const smoothed = new Uint32Array(row.length);
      for (let s = 0; s < row.length; s++) {
        smoothed[s] = row[s] + 1;
      }
      currentState = sampleDist(smoothed, rand);
    }
  }

  return notes;
}

/**
 * Generate melodic patterns for a given genre.
 * Returns NoteEvents for the first instrument track found in the project.
 */
export function generateMelodicPattern(
  options: GenerateOptions,
  rand: () => number,
  key?: MusicalKey,
): NoteEvent[] {
  const patterns = MELODIC_BY_GENRE[options.genre];
  if (!patterns || patterns.length === 0) return [];

  // Pick a pattern role (deterministic from rand)
  const patternIdx = Math.floor(rand() * patterns.length);
  const pattern = patterns[patternIdx];

  // Build Markov model from reference sequences
  const model = buildMelodicModel(pattern.sequences);

  // Estimate notes needed to fill the pattern
  const notesPerBar = pattern.role === 'chord' ? 2 : pattern.role === 'bass' ? 4 : 3;
  const bars = options.stepCount / 16;
  const targetNotes = Math.ceil(notesPerBar * bars);
  const maxSteps = options.stepCount;

  const sequence = generateMelodicSequence(model, targetNotes, rand);

  // Parse the project key for scale snapping
  let root = 0;
  let intervals: readonly number[] = SCALE_INTERVALS.major;
  if (key) {
    const parsed = parseKey(key);
    if (parsed) {
      root = parsed.root;
      intervals = SCALE_INTERVALS[parsed.scaleType];
    }
  }

  // Convert to NoteEvents with tick-based timing
  const notes: NoteEvent[] = [];
  let currentTick = 0;
  const isChord = pattern.role === 'chord';

  for (const note of sequence) {
    if (currentTick >= maxSteps * STEP_TICKS) break;

    const durationTicks = note.duration * STEP_TICKS;

    if (note.degree >= 0) {
      if (isChord) {
        // Expand degree into chord voicing (2-4 simultaneous notes)
        const chordNotes = expandChord(note.degree, pattern.octaveOffset, root, intervals, note.velocity, rand);
        for (const cn of chordNotes) {
          let pitch = degreeToPitch(cn.degree, pattern.octaveOffset, root, intervals);
          if (key) pitch = snapToScale(pitch, key);
          pitch = Math.max(0, Math.min(127, pitch));
          notes.push({
            id: uid('note'),
            pitch,
            start: currentTick,
            duration: durationTicks,
            velocity: cn.velocity,
          });
        }
      } else {
        // Single note (bass/lead)
        let pitch = degreeToPitch(note.degree, pattern.octaveOffset, root, intervals);
        if (key) pitch = snapToScale(pitch, key);
        pitch = Math.max(0, Math.min(127, pitch));
        notes.push({
          id: uid('note'),
          pitch,
          start: currentTick,
          duration: durationTicks,
          velocity: note.velocity,
        });
      }
    }

    currentTick += durationTicks;
  }

  return notes;
}
