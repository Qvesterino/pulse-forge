import type { PadMarkovModel, VelocityLevel, StateIndex } from './types';

const STEPS_PER_BAR = 16;

/** Quantize a velocity value (0-1) to a discrete level (0-3) */
export function quantizeVelocity(v: number): VelocityLevel {
  if (v <= 0) return 0;
  if (v < 0.35) return 1;
  if (v < 0.7) return 2;
  return 3;
}

/** Encode (level, position) into a single state index */
export function encodeState(level: VelocityLevel, position: number): StateIndex {
  return level * STEPS_PER_BAR + (position % STEPS_PER_BAR);
}

/** Decode state index back to level */
export function decodeLevel(index: StateIndex): VelocityLevel {
  const level = Math.floor(index / STEPS_PER_BAR) % 4;
  return level as VelocityLevel;
}

/** Decode state index back to position */
export function decodePosition(index: StateIndex): number {
  return index % STEPS_PER_BAR;
}

const NUM_STATES = 4 * STEPS_PER_BAR; // 64 states

/** Build a Markov model for one pad from reference patterns */
export function buildPadModel(padIndex: number, patterns: number[][]): PadMarkovModel {
  const transitions = new Uint32Array(NUM_STATES * NUM_STATES);
  const initial = new Uint32Array(NUM_STATES);

  for (const pattern of patterns) {
    if (pattern.length < 2) continue;

    // Seed state from first step
    const firstLevel = quantizeVelocity(pattern[0]);
    const firstState = encodeState(firstLevel, 0);
    initial[firstState]++;

    // Walk the pattern and count transitions
    for (let i = 0; i < pattern.length - 1; i++) {
      const fromLevel = quantizeVelocity(pattern[i]);
      const toLevel = quantizeVelocity(pattern[i + 1]);
      const fromState = encodeState(fromLevel, i);
      const toState = encodeState(toLevel, i + 1);
      transitions[fromState * NUM_STATES + toState]++;
    }
  }

  return { padIndex, states: NUM_STATES, transitions, initial };
}

/** Sample a state from a distribution vector using a PRNG, with optional temperature control */
function sampleFromDistribution(dist: Uint32Array, rand: () => number, temperature: number = 1): number {
  // Apply temperature: raise each count to power (1/temperature)
  // T=1 → normal, T>1 → flatten (more random), T<1 → sharpen (more faithful)
  const invT = 1 / Math.max(0.01, temperature);
  let total = 0;
  for (let i = 0; i < dist.length; i++) {
    total += Math.pow(dist[i] + 0.1, invT); // +0.1 to avoid 0^anything = 0
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

  // Check if there are any transitions from this state
  let hasTransitions = false;
  for (let i = 0; i < row.length; i++) {
    if (row[i] > 0) { hasTransitions = true; break; }
  }

  if (!hasTransitions) {
    // Fallback: use initial distribution weighted by same level
    const level = decodeLevel(currentState);
    const fallback = new Uint32Array(model.states);
    for (let pos = 0; pos < STEPS_PER_BAR; pos++) {
      const s = encodeState(level, pos);
      fallback[s] = model.initial[s] + 1;
    }
    return sampleFromDistribution(fallback, rand, temperature);
  }

  // Laplace smoothing: add 1 to every transition count to avoid zero-probability
  // transitions and improve generalization from small training sets
  const smoothed = new Uint32Array(row.length);
  for (let i = 0; i < row.length; i++) {
    smoothed[i] = row[i] + 1;
  }
  return sampleFromDistribution(smoothed, rand, temperature);
}

/** Generate a full velocity sequence for one pad */
export function generatePadSequence(model: PadMarkovModel, length: number, rand: () => number, temperature: number = 1): number[] {
  const sequence: number[] = new Array(length);

  // Sample initial state with Laplace smoothing
  const smoothedInitial = new Uint32Array(model.initial.length);
  for (let i = 0; i < model.initial.length; i++) {
    smoothedInitial[i] = model.initial[i] + 1;
  }
  let currentState = sampleFromDistribution(smoothedInitial, rand, temperature);

  for (let i = 0; i < length; i++) {
    const level = decodeLevel(currentState);
    sequence[i] = level;
    if (i < length - 1) {
      currentState = sampleTransition(model, currentState, rand, temperature);
    }
  }

  return sequence;
}

/** Convert a quantized level back to a musical velocity with slight randomness */
export function dequantizeVelocity(level: VelocityLevel, rand: () => number): number {
  switch (level) {
    case 0: return 0;
    case 1: return 0.2 + rand() * 0.15;   // 0.20 - 0.35
    case 2: return 0.5 + rand() * 0.2;    // 0.50 - 0.70
    case 3: return 0.8 + rand() * 0.2;    // 0.80 - 1.00
  }
}
