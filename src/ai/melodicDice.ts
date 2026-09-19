import { forkRandom } from "../shared/rng";
import { uid } from "../shared/ids";
import { STEP_TICKS } from "../project-model/types";
import type { MusicalKey, NoteEvent, ProjectDocument } from "../project-model/types";
import { getScalePitchesInRange } from "../project-model/scales";

export interface MelodicPhraseOptions {
  seed: string;
  /** Phrase length in 16th steps — caller clamps to the pattern length. */
  lengthSteps: number;
  /** 0..1 — probability a step starts a note (downbeats get a bonus). */
  density: number;
  /** 0..1 — widens melodic leaps and velocity spread. */
  energy: number;
  key: MusicalKey;
  pitchMin?: number;
  pitchMax?: number;
}

export interface MelodicPhrase {
  notes: NoteEvent[];
}

/**
 * Scale-aware melodic phrase from a seed — a random walk over the project
 * scale's degrees. Deterministic per (seed, options): the dice preview and
 * apply call it with identical inputs and get identical notes, so what you
 * previewed is exactly what APPLY writes.
 */
export function buildMelodicPhrase(_doc: ProjectDocument, opts: MelodicPhraseOptions): MelodicPhrase {
  const pitchMin = opts.pitchMin ?? 36; // C2
  const pitchMax = opts.pitchMax ?? 84; // C6
  const scale = [...getScalePitchesInRange(opts.key, pitchMin, pitchMax)].sort((a, b) => a - b);
  if (scale.length === 0) return { notes: [] };

  const rng = forkRandom(opts.seed, "melodic-dice");
  const lengthSteps = Math.max(1, Math.min(256, Math.round(opts.lengthSteps)));
  const density = Math.max(0.05, Math.min(0.95, opts.density));
  const energy = Math.max(0, Math.min(1, opts.energy));

  // Start mid-range so phrases sit in a singable register, not at the extremes.
  let index = Math.floor(scale.length / 2);
  const notes: NoteEvent[] = [];
  let step = 0;
  let guard = 0;
  while (step < lengthSteps && guard < lengthSteps * 4) {
    guard += 1;
    const inBar = step % 16;
    // Downbeats invite a note, phrase ends breathe.
    const chance = density + (inBar === 0 ? 0.25 : 0) - (inBar === 15 ? 0.1 : 0);
    if (rng() > chance) {
      step += 1;
      continue;
    }
    // Melodic leap: mostly stepwise, energy opens bigger jumps.
    const moves = energy > 0.6 ? [-4, -3, -2, -1, -1, 0, 1, 1, 2, 3, 4] : [-2, -1, -1, 0, 0, 1, 1, 2];
    index = Math.max(0, Math.min(scale.length - 1, index + moves[Math.floor(rng() * moves.length)]));
    // Contour relief: after climbing to an edge, pull back toward the middle.
    if (index === 0 || index === scale.length - 1) {
      index = index === 0 ? Math.min(scale.length - 1, index + 2) : Math.max(0, index - 2);
    }
    const durSteps = [1, 1, 1, 2, 2, 3, 4][Math.floor(rng() * 7)];
    const duration = Math.min(durSteps, lengthSteps - step) * STEP_TICKS;
    const velocity = Math.max(0.05, Math.min(1, 0.45 + rng() * 0.35 + energy * 0.15));
    notes.push({
      id: uid("note"),
      pitch: scale[index],
      start: step * STEP_TICKS,
      duration: Math.max(STEP_TICKS, duration),
      velocity,
    });
    step += durSteps;
  }
  return { notes };
}
