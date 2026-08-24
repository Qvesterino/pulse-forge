import type { ProjectDocument, Pattern, NoteEvent, StepMeta } from '../project-model/types';
import type { GenerateOptions, GrooveData } from './types';
import { forkRandom, hashString } from '../shared/rng';
import { uid } from '../shared/ids';
import { getGroovesForGenre, getGrooveById } from './grooves/index';
import { generateDrumPattern } from './drums';
import { generateMelodicParts } from './melodic';
import { canonicalizePattern, contentHash, createGenerationRecipe } from './evaluation';

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

/** UUID-free content identity for source-pattern variation. */
export function sourcePatternContentHash(doc: ProjectDocument, sourcePatternId?: string): string | null {
  if (!sourcePatternId) return null;
  const sourcePattern = doc.patterns.find(p => p.id === sourcePatternId);
  return sourcePattern ? contentHash(canonicalizePattern(doc, sourcePattern)) : null;
}

/** Derive the effective seed from explicit input plus stable source content. */
export function resolveEffectiveSeed(doc: ProjectDocument, options: GenerateOptions): string {
  const inputHash = sourcePatternContentHash(doc, options.sourcePatternId);
  return inputHash
    ? hashString(`${options.seed}|${inputHash}`).toString(36)
    : options.seed;
}

/** Resolve the groove using exactly the same seed derivation as generation. */
export function resolveGrooveForGeneration(doc: ProjectDocument, options: GenerateOptions): GrooveData {
  const effectiveSeed = resolveEffectiveSeed(doc, options);
  return resolveGroove(
    options.genre,
    options.style,
    forkRandom(`${options.genre}|${effectiveSeed}`, 'groove'),
  );
}

/** Generate a complete Pattern from the Markov engine */
export function generatePattern(
  doc: ProjectDocument,
  options: GenerateOptions,
): Pattern {
  const effectiveSeed = resolveEffectiveSeed(doc, options);
  const inputContentHash = sourcePatternContentHash(doc, options.sourcePatternId);

  // Groove choice and every generation subsystem receive independent streams.
  const groove = resolveGrooveForGeneration(doc, options);

  const generationSeed = `${options.genre}|${effectiveSeed}|${groove.id}`;
  const drumRand = forkRandom(generationSeed, 'drums.core');
  const drumVariationRand = forkRandom(generationSeed, 'drums.variation');
  const drumMetaRand = forkRandom(generationSeed, 'drums.meta');
  const melodyRand = forkRandom(generationSeed, 'melody.fallback');
  const bassRand = forkRandom(generationSeed, 'melody.bass');
  const chordRand = forkRandom(generationSeed, 'melody.chord');
  const leadRand = forkRandom(generationSeed, 'melody.lead');

  // Resolve the target drum track before generation so semantic pad metadata
  // (names/order) can participate in the local quality rules.
  const drumTracks = doc.tracks.filter(t => t.kind === 'drum');
  const targetDrumTrack = options.drumTrackId
    ? drumTracks.find(t => t.id === options.drumTrackId) ?? drumTracks[0]
    : drumTracks[0];
  const padNames = targetDrumTrack && targetDrumTrack.kind === 'drum'
    ? targetDrumTrack.pads.map(pad => pad.name)
    : undefined;

  // Generate drum pattern
  const { rows: rawRows, meta } = generateDrumPattern(groove, options, drumRand, {
    variation: drumVariationRand,
    meta: drumMetaRand,
    // Existing project swing remains the owner unless the caller explicitly
    // asks generation to apply the resolved groove settings.
    swing: options.applyGrooveSettings || doc.groove.swing > 0 ? 0 : groove.swing,
  }, padNames);

  // Map pad indices to actual pad IDs from the target drum track
  const padIdMap = new Map<number, string>();
  if (targetDrumTrack && targetDrumTrack.kind === 'drum') {
    targetDrumTrack.pads.forEach((pad, i) => {
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

  // Generate melodic content with scale constraints and drum-aware placement
  const melodicParts = generateMelodicParts(options, melodyRand, doc.key, rawRows, {
    bass: bassRand,
    chord: chordRand,
    lead: leadRand,
  });

  // Build notes Record<ID, NoteEvent[]>
  const notesRecord: Record<string, NoteEvent[]> = {};
  const instrumentTracks = doc.tracks.filter(t => t.kind === 'instrument');
  const targetTracks = options.instrumentTrackIds && options.instrumentTrackIds.length > 0
    ? instrumentTracks.filter(t => options.instrumentTrackIds!.includes(t.id))
    : instrumentTracks;
  const roleOrder = ['bass', 'chord', 'lead'] as const;

  if (targetTracks.length > 0) {
    for (const [roleIndex, role] of roleOrder.entries()) {
      const part = melodicParts[role];
      if (part.length === 0) continue;
      const namedTrack = targetTracks.find(track => {
        const name = track.name.toLowerCase();
        return name.includes(role);
      });
      const track = namedTrack ?? targetTracks[roleIndex % targetTracks.length];
      notesRecord[track.id] = [...(notesRecord[track.id] ?? []), ...part];
    }
  }

  const pattern: Pattern = {
    id: uid('pattern'),
    name: `${groove.genre} - ${groove.name}`,
    stepCount: options.stepCount,
    rows,
    notes: notesRecord,
    stepMeta: Object.keys(stepMeta).length > 0 ? stepMeta : undefined,
  };

  const outputContentHash = contentHash(canonicalizePattern(doc, pattern));
  return {
    ...pattern,
    generation: {
      ...createGenerationRecipe(options, groove.id, inputContentHash),
      outputContentHash,
    },
  };
}
