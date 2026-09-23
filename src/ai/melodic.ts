import type { NoteEvent, MusicalKey } from "../project-model/types";
import type { GenerateOptions, GenerationRole, MelodicNote, MelodicPatternData } from "./types";
import { STEP_TICKS } from "../project-model/types";
import { parseKey, snapToScale, SCALE_INTERVALS } from "../project-model/scales";
import { uid } from "../shared/ids";
import { MELODIC_BY_GENRE } from "./grooves/melodic-data";

const DEGREE_MIN = -1; // rest
const DEGREE_MAX = 6; // 7th
const DEGREE_COUNT = DEGREE_MAX - DEGREE_MIN + 1; // 8
const DURATIONS = [1, 2, 4, 8];
const DURATION_COUNT = DURATIONS.length;
const NUM_STATES = DEGREE_COUNT * DURATION_COUNT; // 32

interface MelodicModel {
  transitions: Uint32Array;
  initial: Uint32Array;
  /** Initial-state distribution with rests removed, reused by rest repair. */
  nonRestInitial: Uint32Array;
  /** Observed velocities per state index, for sampling during generation. */
  velocities: Map<number, number[]>;
}

const melodicModelCache = new WeakMap<MelodicNote[][], MelodicModel>();

/** Encode (degree, duration) into a flat state index */
export function encodeMelodicState(degree: number, duration: number): number {
  const safeDegree = Number.isFinite(degree)
    ? Math.max(DEGREE_MIN, Math.min(DEGREE_MAX, Math.trunc(degree)))
    : DEGREE_MIN;
  const dIdx = DURATIONS.indexOf(duration);
  const safeDurationIndex = dIdx >= 0 ? dIdx : 0;
  return (safeDegree - DEGREE_MIN) * DURATION_COUNT + safeDurationIndex;
}

function safeMelodicStateIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(NUM_STATES - 1, Math.trunc(index)));
}

function melodicDegreeFromSafeState(safeIndex: number): number {
  return Math.floor(safeIndex / DURATION_COUNT) + DEGREE_MIN;
}

function melodicDurationFromSafeState(safeIndex: number): number {
  return DURATIONS[safeIndex % DURATION_COUNT];
}

function melodicDegreeFromState(index: number): number {
  return melodicDegreeFromSafeState(safeMelodicStateIndex(index));
}

/** Decode state index back to (degree, duration) */
export function decodeMelodicState(index: number): { degree: number; duration: number } {
  const safeIndex = safeMelodicStateIndex(index);
  return { degree: melodicDegreeFromSafeState(safeIndex), duration: melodicDurationFromSafeState(safeIndex) };
}

/** Build a Markov model from melodic reference sequences */
function getMelodicModel(sequences: MelodicNote[][]): MelodicModel {
  const cached = melodicModelCache.get(sequences);
  if (cached) return cached;

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

  const nonRestInitial = new Uint32Array(NUM_STATES);
  for (let state = 0; state < NUM_STATES; state++) {
    if (melodicDegreeFromState(state) >= 0) nonRestInitial[state] = initial[state];
  }
  const model = { transitions, initial, nonRestInitial, velocities };
  melodicModelCache.set(sequences, model);
  return model;
}

/** Sample from a distribution vector with optional temperature control */
function sampleDist(
  dist: Uint32Array,
  rand: () => number,
  temperature: number = 1,
  start = 0,
  end = dist.length,
): number {
  const invT = 1 / Math.max(0.01, temperature);
  let total = 0;
  for (let i = start; i < end; i++) {
    if (dist[i] > 0) total += Math.pow(dist[i], invT);
  }
  if (total <= 0) return -1;

  let r = rand() * total;
  for (let i = start; i < end; i++) {
    if (dist[i] <= 0) continue;
    r -= Math.pow(dist[i], invT);
    if (r <= 0) return i - start;
  }
  for (let i = end - 1; i >= start; i--) {
    if (dist[i] > 0) return i - start;
  }
  return -1;
}

/** Convert a scale degree to a MIDI pitch given root and scale intervals */
export function degreeToPitch(
  degree: number,
  octaveOffset: number,
  root: number,
  intervals: readonly number[],
): number {
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
  [0, 2, 4], // triad (root + 3rd + 5th)
  [0, 2, 4, 6], // seventh (root + 3rd + 5th + 7th)
  [0, 4], // power chord (root + 5th)
  [0, 3, 4], // suspended (root + 4th + 5th)
  [0, 2, 4, 6], // maj7 voicing
  [0, 3, 5], // min triad inversion feel
];

/**
 * Velocity multipliers for chord voices: root is loudest, upper extensions softer.
 * Index 0 = root, index 1 = next, etc.
 */
const VOICE_VELOCITY_CURVE = [1.0, 0.85, 0.75, 0.65];

/** Expand a single degree into chord notes (multiple pitches at intervals) */
export function expandChord(
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

/** Clamp a scaled velocity back into the valid unit range (keeps the >0 invariant). */
function clampUnit(value: number): number {
  return Math.max(0.1, Math.min(1, value));
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
  model: MelodicModel,
  length: number,
  rand: () => number,
  temperature: number = 1,
): MelodicNote[] {
  const notes: MelodicNote[] = [];

  // Sample only observed states. The reference corpus is intentionally the
  // complete support of the offline model; inventing probability for all 32
  // states made rests and impossible durations appear too often.
  const sampledInitial = sampleDist(model.initial, rand, temperature);
  let currentState = sampledInitial >= 0 ? sampledInitial : encodeMelodicState(0, 1);

  for (let i = 0; i < length; i++) {
    const safeState = safeMelodicStateIndex(currentState);
    const degree = melodicDegreeFromSafeState(safeState);
    const duration = melodicDurationFromSafeState(safeState);

    // Skip consecutive rests — force a note instead
    if (degree < 0 && notes.length > 0 && notes[notes.length - 1].degree < 0) {
      const sampledNonRest = sampleDist(model.nonRestInitial, rand, temperature);
      currentState = sampledNonRest >= 0 ? sampledNonRest : encodeMelodicState(0, 1);
      const forcedState = safeMelodicStateIndex(currentState);
      notes.push({
        degree: melodicDegreeFromSafeState(forcedState),
        duration: melodicDurationFromSafeState(forcedState),
        velocity: sampleVelocity(model.velocities, currentState, rand),
      });
      continue;
    }

    notes.push({ degree, duration, velocity: sampleVelocity(model.velocities, currentState, rand) });

    if (i < length - 1) {
      const rowStart = currentState * NUM_STATES;
      const sampledNext = sampleDist(model.transitions, rand, temperature, rowStart, rowStart + NUM_STATES);
      currentState = sampledNext >= 0 ? sampledNext : encodeMelodicState(degree, duration);
    }
  }

  return notes;
}

/**
 * Generate melodic patterns for a given genre.
 * Generates content for ALL roles (bass, chord, lead) and returns combined NoteEvents.
 * kickRows: optional array of kick velocities per step — used for sidechain-aware bass placement.
 */
export type MelodicParts = Record<MelodicPatternData["role"], NoteEvent[]>;

export function generateMelodicParts(
  options: GenerateOptions,
  rand: () => number,
  key?: MusicalKey,
  kickRows?: number[][],
  roleRandoms?: Partial<Record<MelodicPatternData["role"], () => number>>,
): MelodicParts {
  const patterns = MELODIC_BY_GENRE[options.genre];
  if (!patterns || patterns.length === 0) return { bass: [], chord: [], lead: [] };

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

  const parts: MelodicParts = { bass: [], chord: [], lead: [] };
  const maxSteps = options.stepCount;
  const bars = options.stepCount / 16;

  // P2 melodic dynamics — the intent sliders reach the melody, not just the
  // drums. Both gains are identity at the intent defaults (energy 0.7,
  // density 0.5), so default renders stay bit-identical to the golden
  // baselines. The hints are only present when a slider leaves its default
  // (see mapIntentToOptions); absent hints mean neutral.
  const diceEnergy = options._diceEnergy ?? 0.7;
  const diceDensity = options._diceDensity ?? 0.5;
  const energyVelocityGain = Math.max(0.5, Math.min(1.3, 1 + (diceEnergy - 0.7) * 0.8));
  const densityCountGain = 0.6 + diceDensity * 0.8; // 0.5 → 1.0

  // Generate for each role in the genre
  for (const pattern of patterns) {
    const intentRole: GenerationRole = pattern.role === "chord" ? "chords" : pattern.role;
    if (options.roles && !options.roles.includes(intentRole)) continue;
    const roleRand = roleRandoms?.[pattern.role] ?? rand;
    // Build Markov model from reference sequences for this role
    const model = getMelodicModel(pattern.sequences);

    // Role-specific note density, scaled by the density slider (P2)
    const baseNotesPerBar = pattern.role === "chord" ? 2 : pattern.role === "bass" ? 4 : 3;
    const notesPerBar = Math.max(1, Math.round(baseNotesPerBar * densityCountGain));
    const targetNotes = Math.ceil(notesPerBar * bars);

    const sequence = generateMelodicSequence(model, targetNotes, roleRand, options.temperature);

    // Convert to NoteEvents with tick-based timing
    let currentTick = 0;
    const isChord = pattern.role === "chord";
    const isBass = pattern.role === "bass";

    // Pre-compute kick activity for sidechain awareness
    const kickActive = new Set<number>();
    if (isBass && kickRows && kickRows.length > 0) {
      const kickRow = kickRows[0]; // first kick pad
      if (kickRow) {
        for (let s = 0; s < Math.min(kickRow.length, maxSteps); s++) {
          if (kickRow[s] > 0.3) kickActive.add(s);
        }
      }
    }

    for (const note of sequence) {
      if (currentTick >= maxSteps * STEP_TICKS) break;

      const durationTicks = note.duration * STEP_TICKS;
      const stepIndex = Math.floor(currentTick / STEP_TICKS);

      if (note.degree >= 0) {
        if (isChord) {
          const chordNotes = expandChord(note.degree, pattern.octaveOffset, root, intervals, note.velocity, roleRand);
          for (const cn of chordNotes) {
            let pitch = degreeToPitch(cn.degree, pattern.octaveOffset, root, intervals);
            if (key) pitch = snapToScale(pitch, key);
            pitch = Math.max(0, Math.min(127, pitch));
            parts[pattern.role].push({
              id: uid("note"),
              pitch,
              start: currentTick,
              duration: durationTicks,
              velocity: clampUnit(cn.velocity * energyVelocityGain),
            });
          }
        } else {
          // Sidechain-aware bass: if kick is active at this step, duck the velocity
          // (P2: the corpus velocity first rides the energy gain, then ducks)
          let velocity = clampUnit(note.velocity * energyVelocityGain);
          let startTick = currentTick;
          if (isBass && kickActive.has(stepIndex)) {
            // Duck: reduce velocity and shift note slightly later
            velocity = Math.max(0.15, velocity * 0.5);
            startTick = currentTick + STEP_TICKS * 0.25; // shift by 1/4 of a step
          }

          let pitch = degreeToPitch(note.degree, pattern.octaveOffset, root, intervals);
          if (key) pitch = snapToScale(pitch, key);
          pitch = Math.max(0, Math.min(127, pitch));
          parts[pattern.role].push({
            id: uid("note"),
            pitch,
            start: startTick,
            duration: durationTicks,
            velocity,
          });
        }
      }

      currentTick += durationTicks;
    }
  }

  return parts;
}

/** Backward-compatible flattened melodic output for callers that use one track. */
export function generateMelodicPattern(
  options: GenerateOptions,
  rand: () => number,
  key?: MusicalKey,
  kickRows?: number[][],
  roleRandoms?: Partial<Record<MelodicPatternData["role"], () => number>>,
): NoteEvent[] {
  const parts = generateMelodicParts(options, rand, key, kickRows, roleRandoms);
  return [parts.bass, parts.chord, parts.lead].flat();
}
