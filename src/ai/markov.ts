import type { PadMarkovModel, VelocityLevel, StateIndex } from './types';

const STEPS_PER_BAR = 16;
const NUM_LEVELS = 4;
const NUM_STATES = NUM_LEVELS * NUM_LEVELS * STEPS_PER_BAR; // 256 states

/** Quantize a velocity value (0-1) to a discrete level (0-3) */
export function quantizeVelocity(v: number): VelocityLevel {
  if (v <= 0) return 0;
  if (v < 0.35) return 1;
  if (v < 0.7) return 2;
  return 3;
}

/**
 * Encode (levelPrev, levelCurr, position) into a single state index.
 * Second-order: state captures the velocity trend + position.
 * Encoding: levelPrev * 64 + levelCurr * 16 + position
 */
export function encodeState(levelPrev: VelocityLevel, levelCurr: VelocityLevel, position: number): StateIndex {
  return levelPrev * NUM_LEVELS * STEPS_PER_BAR + levelCurr * STEPS_PER_BAR + (position % STEPS_PER_BAR);
}

/** Decode state index back to levelPrev */
export function decodeLevelPrev(index: StateIndex): VelocityLevel {
  return (Math.floor(index / (NUM_LEVELS * STEPS_PER_BAR)) % NUM_LEVELS) as VelocityLevel;
}

/** Decode state index back to levelCurr */
export function decodeLevelCurr(index: StateIndex): VelocityLevel {
  return (Math.floor(index / STEPS_PER_BAR) % NUM_LEVELS) as VelocityLevel;
}

/** Decode state index back to position */
export function decodePosition(index: StateIndex): number {
  return index % STEPS_PER_BAR;
}

/** Build a second-order Markov model for one pad from reference patterns */
export function buildPadModel(padIndex: number, patterns: number[][]): PadMarkovModel {
  const transitions = new Uint32Array(NUM_STATES * NUM_STATES);
  const initial = new Uint32Array(NUM_STATES);

  for (const pattern of patterns) {
    if (pattern.length < 2) continue;

    const levels: VelocityLevel[] = pattern.map(quantizeVelocity);

    // Seed: first two steps form the initial state
    if (levels.length >= 2) {
      const initState = encodeState(levels[0], levels[1], 1);
      initial[initState]++;
    }

    // Walk and count bigram transitions
    for (let i = 0; i < levels.length - 2; i++) {
      const fromState = encodeState(levels[i], levels[i + 1], i + 1);
      const toState = encodeState(levels[i + 1], levels[i + 2], i + 2);
      transitions[fromState * NUM_STATES + toState]++;
    }
  }

  return { padIndex, states: NUM_STATES, transitions, initial };
}

/** Sample a state from a distribution vector using a PRNG, with optional temperature */
function sampleFromDistribution(dist: Uint32Array, rand: () => number, temperature: number = 1): number {
  const invT = 1 / Math.max(0.01, temperature);
  let total = 0;
  for (let i = 0; i < dist.length; i++) {
    total += Math.pow(dist[i] + 0.1, invT);
  }
  if (total === 0) return 0;

  let r = rand() * total;
  for (let i = 0; i < dist.length; i++) {
    r -= Math.pow(dist[i] + 0.1, invT);
    if (r <= 0) return i;
  }
  return dist.length - 1;
}

/** Sample the next state given the current state */
export function sampleTransition(model: PadMarkovModel, currentState: StateIndex, rand: () => number, temperature: number = 1): StateIndex {
  const rowStart = currentState * model.states;
  const row = model.transitions.subarray(rowStart, rowStart + model.states);

  let hasTransitions = false;
  for (let i = 0; i < row.length; i++) {
    if (row[i] > 0) { hasTransitions = true; break; }
  }

  if (!hasTransitions) {
    // Fallback: use initial distribution
    const smoothed = new Uint32Array(model.initial.length);
    for (let i = 0; i < model.initial.length; i++) {
      smoothed[i] = model.initial[i] + 1;
    }
    return sampleFromDistribution(smoothed, rand, temperature);
  }

  const smoothed = new Uint32Array(row.length);
  for (let i = 0; i < row.length; i++) {
    smoothed[i] = row[i] + 1;
  }
  return sampleFromDistribution(smoothed, rand, temperature);
}

/** Generate a full velocity sequence for one pad using second-order Markov */
export function generatePadSequence(model: PadMarkovModel, length: number, rand: () => number, temperature: number = 1): number[] {
  const sequence: number[] = new Array(length);

  if (length === 0) return sequence;

  // Sample initial two-step state
  const smoothedInitial = new Uint32Array(model.initial.length);
  for (let i = 0; i < model.initial.length; i++) {
    smoothedInitial[i] = model.initial[i] + 1;
  }
  let currentState = sampleFromDistribution(smoothedInitial, rand, temperature);

  // First step
  sequence[0] = decodeLevelPrev(currentState);

  if (length >= 2) {
    // Second step
    sequence[1] = decodeLevelCurr(currentState);

    // Remaining steps via transitions
    for (let i = 2; i < length; i++) {
      currentState = sampleTransition(model, currentState, rand, temperature);
      sequence[i] = decodeLevelCurr(currentState);
    }
  }

  return sequence;
}

/** Convert a quantized level back to a musical velocity with slight randomness */
export function dequantizeVelocity(level: VelocityLevel, rand: () => number): number {
  switch (level) {
    case 0: return 0;
    case 1: return 0.2 + rand() * 0.15;
    case 2: return 0.5 + rand() * 0.2;
    case 3: return 0.8 + rand() * 0.2;
  }
}
