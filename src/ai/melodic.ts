import type { NoteEvent } from '../project-model/types';
import type { GenerateOptions } from './types';

/**
 * Melodic pattern generation — stub for Phase 2.
 * Will use pitch-interval Markov chains trained on bass/lead/chord patterns.
 */
export function generateMelodicPattern(
  _options: GenerateOptions,
  _rand: () => number,
): NoteEvent[] {
  // Phase 2: generate bass lines, chord stabs, lead melodies
  return [];
}
