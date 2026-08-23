import type { ProjectDocument, Pattern, NoteEvent, StepMeta } from '../project-model/types';
import type { GenerateOptions, GrooveData } from './types';
import { mulberry32, hashString } from '../shared/rng';
import { uid } from '../shared/ids';
import { getGroovesForGenre, getGrooveById } from './grooves/index';
import { generateDrumPattern } from './drums';
import { generateMelodicPattern } from './melodic';

/** Resolve which groove to use based on genre + optional style name */
export function resolveGroove(genre: GenerateOptions['genre'], style?: string, rand?: () => number): GrooveData {
  if (style) {
    const byId = getGrooveById(`${genre}.${style.toLowerCase().replace(/\s+/g, '')}`);
    if (byId) return byId;

    const grooves = getGroovesForGenre(genre);
    const match = grooves.find(g => g.name.toLowerCase() === style.toLowerCase());
    if (match) return match;
  }

  // Pick a random groove from the genre (deterministic if rand provided)
  const grooves = getGroovesForGenre(genre);
  const idx = rand ? Math.floor(rand() * grooves.length) : 0;
  return grooves[idx];
}

/** Generate a complete Pattern from the Markov engine */
export function generatePattern(
  doc: ProjectDocument,
  options: GenerateOptions,
): Pattern {
  // Phase 1: create a temp PRNG to pick the groove
  const preSeed = hashString(`${options.genre}|${options.seed}`);
  const preRand = mulberry32(preSeed);
  const groove = resolveGroove(options.genre, options.style, preRand);

  // Phase 2: re-seed with groove ID for deterministic generation
  const mainSeed = hashString(`${options.genre}|${options.seed}|${groove.id}`);
  const rand = mulberry32(mainSeed);

  // Generate drum pattern
  const { rows: rawRows, meta } = generateDrumPattern(groove, options, rand);

  // Map pad indices to actual pad IDs from the project's drum track(s)
  const drumTrack = doc.tracks.find(t => t.kind === 'drum');
  const padIdMap = new Map<number, string>(); // index → padId
  if (drumTrack && drumTrack.kind === 'drum') {
    drumTrack.pads.forEach((pad, i) => {
      padIdMap.set(i, pad.id);
    });
  }

  // Build rows Record<ID, number[]>
  const rows: Record<string, number[]> = {};
  for (const [indexStr, velocities] of Object.entries(rawRows)) {
    const index = Number(indexStr);
    const padId = padIdMap.get(index);
    if (padId) {
      rows[padId] = velocities;
    }
  }

  // Build stepMeta Record<ID, Record<number, StepMeta>>
  const stepMeta: Record<string, Record<number, StepMeta>> = {};
  for (const [padIndex, padMeta] of meta) {
    const padId = padIdMap.get(padIndex);
    if (padId) {
      stepMeta[padId] = {};
      for (const [step, m] of padMeta) {
        stepMeta[padId][step] = m;
      }
    }
  }

  // Generate melodic content (Phase 2 stub)
  const notes = generateMelodicPattern(options, rand);

  // Build notes Record<ID, NoteEvent[]>
  const notesRecord: Record<string, NoteEvent[]> = {};
  if (notes.length > 0) {
    const instrumentTrack = doc.tracks.find(t => t.kind === 'instrument');
    if (instrumentTrack) {
      notesRecord[instrumentTrack.id] = notes;
    }
  }

  return {
    id: uid('pattern'),
    name: '',
    stepCount: options.stepCount,
    rows,
    notes: notesRecord,
    stepMeta: Object.keys(stepMeta).length > 0 ? stepMeta : undefined,
  };
}
