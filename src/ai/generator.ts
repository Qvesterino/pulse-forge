import type { ProjectDocument, Pattern, NoteEvent, StepMeta } from "../project-model/types";
import type { GenerateOptions, GrooveData } from "./types";
import { forkRandom, hashString } from "../shared/rng";
import { uid } from "../shared/ids";
import { getGroovesForGenre, getGrooveById } from "./grooves/index";
import { generateDrumPattern } from "./drums";
import { generateMelodicParts } from "./melodic";
import { inferPadRole } from "./pad-roles";
import { canonicalizePattern, contentHash, createGenerationRecipe } from "./evaluation";
import { measureDrumQuality, measureMelodicQuality } from "./quality";
import { evaluateStyleDistance } from "./style-quality";
import { buildPhrasePlan } from "./phrase";

/** Resolve which groove to use based on genre + optional style name */
export function resolveGroove(genre: GenerateOptions["genre"], style?: string, rand?: () => number): GrooveData {
  if (style) {
    const byId = getGrooveById(`${genre}.${style.toLowerCase().replace(/\s+/g, "")}`);
    if (byId) return byId;

    const grooves = getGroovesForGenre(genre);
    const match = grooves.find((g) => g.name.toLowerCase() === style.toLowerCase());
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
  const sourcePattern = doc.patterns.find((p) => p.id === sourcePatternId);
  return sourcePattern ? contentHash(canonicalizePattern(doc, sourcePattern)) : null;
}

/** Derive the effective seed from explicit input plus stable source content. */
export function resolveEffectiveSeed(doc: ProjectDocument, options: GenerateOptions): string {
  const inputHash = sourcePatternContentHash(doc, options.sourcePatternId);
  return inputHash ? hashString(`${options.seed}|${inputHash}`).toString(36) : options.seed;
}

/** Resolve the groove using exactly the same seed derivation as generation. */
export function resolveGrooveForGeneration(doc: ProjectDocument, options: GenerateOptions): GrooveData {
  const effectiveSeed = resolveEffectiveSeed(doc, options);
  return resolveGroove(options.genre, options.style, forkRandom(`${options.genre}|${effectiveSeed}`, "groove"));
}

export interface DiceLocks {
  drums?: boolean;
  bass?: boolean;
  chords?: boolean;
  lead?: boolean;
  kick?: boolean;
  snare?: boolean;
  hats?: boolean;
  /** Active pattern to lock from (for drums + melodic). */
  prevPattern?: Pattern | null;
}

function isDrumPadLocked(padIndex: number, padNames: readonly string[] | undefined, locks: DiceLocks): boolean {
  if (locks.drums) return true;
  const role = inferPadRole(padNames?.[padIndex], padIndex);
  if (locks.kick && role === "kick") return true;
  if (locks.snare && (role === "snare" || role === "clap")) return true;
  if (locks.hats && (role === "closedHat" || role === "openHat")) return true;
  return false;
}

/** Generate a complete Pattern from the Markov engine */
export function generatePattern(doc: ProjectDocument, options: GenerateOptions, diceLocks?: DiceLocks): Pattern {
  const effectiveSeed = resolveEffectiveSeed(doc, options);
  const inputContentHash = sourcePatternContentHash(doc, options.sourcePatternId);

  // Groove choice and every generation subsystem receive independent streams.
  const groove = resolveGrooveForGeneration(doc, options);

  const generationSeed = `${options.genre}|${effectiveSeed}|${groove.id}`;
  const drumRand = forkRandom(generationSeed, "drums.core");
  const drumVariationRand = forkRandom(generationSeed, "drums.variation");
  const drumMetaRand = forkRandom(generationSeed, "drums.meta");
  const melodyRand = forkRandom(generationSeed, "melody.fallback");
  const bassRand = forkRandom(generationSeed, "melody.bass");
  const chordRand = forkRandom(generationSeed, "melody.chord");
  const leadRand = forkRandom(generationSeed, "melody.lead");

  // Resolve the target drum track before generation so semantic pad metadata
  // (names/order) can participate in the local quality rules.
  const drumTracks = doc.tracks.filter((t) => t.kind === "drum");
  const targetDrumTrack = options.drumTrackId
    ? (drumTracks.find((t) => t.id === options.drumTrackId) ?? drumTracks[0])
    : drumTracks[0];
  const padNames =
    targetDrumTrack && targetDrumTrack.kind === "drum" ? targetDrumTrack.pads.map((pad) => pad.name) : undefined;

  // Dice subSeed locks: build prevRows/indices if needed
  const dicePrev = diceLocks?.prevPattern ?? null;
  let lockedIndices: Set<number> | undefined;
  let prevRowsByIndex: Map<number, number[]> | undefined;
  let prevMetaByIndex: Map<number, Map<number, StepMeta>> | undefined;
  if (diceLocks && dicePrev && (diceLocks.drums || diceLocks.kick || diceLocks.snare || diceLocks.hats)) {
    const targetTrackForLocks = targetDrumTrack;
    const padIdToIndex = new Map<string, number>();
    targetTrackForLocks?.pads.forEach((pad, i) => padIdToIndex.set(pad.id, i));
    prevRowsByIndex = new Map<number, number[]>();
    prevMetaByIndex = new Map<number, Map<number, StepMeta>>();
    for (const [padId, row] of Object.entries(dicePrev.rows)) {
      const idx = padIdToIndex.get(padId);
      if (idx !== undefined) prevRowsByIndex.set(idx, [...row]);
    }
    if (dicePrev.stepMeta) {
      for (const [padId, meta] of Object.entries(dicePrev.stepMeta)) {
        const idx = padIdToIndex.get(padId);
        if (idx !== undefined) {
          const m = new Map<number, StepMeta>();
          for (const [k, v] of Object.entries(meta)) m.set(Number(k), { ...v });
          prevMetaByIndex.set(idx, m);
        }
      }
    }
    lockedIndices = new Set<number>();
    for (const padIdx of groove.activePads) {
      if (isDrumPadLocked(padIdx, padNames, diceLocks)) lockedIndices.add(padIdx);
    }
  }

  // Generate drum pattern
  const { rows: rawRows, meta } = generateDrumPattern(
    groove,
    options,
    drumRand,
    {
      variation: drumVariationRand,
      meta: drumMetaRand,
      swing: options.applyGrooveSettings || (doc.groove?.swing ?? 0) > 0 ? 0 : groove.swing,
      lockedIndices,
      prevRows: prevRowsByIndex,
      prevMeta: prevMetaByIndex,
    } as unknown as import("./drums").DrumRandomStreams,
    padNames,
  );

  // Map pad indices to actual pad IDs from the target drum track
  const padIdMap = new Map<number, string>();
  if (targetDrumTrack && targetDrumTrack.kind === "drum") {
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
  const instrumentTracks = doc.tracks.filter((t) => t.kind === "instrument");
  const targetTracks =
    options.instrumentTrackIds && options.instrumentTrackIds.length > 0
      ? instrumentTracks.filter((t) => options.instrumentTrackIds!.includes(t.id))
      : instrumentTracks;
  const roleOrder = ["bass", "chord", "lead"] as const;

  if (targetTracks.length > 0) {
    for (let roleIndex = 0; roleIndex < roleOrder.length; roleIndex++) {
      const role = roleOrder[roleIndex];
      // Melodic subSeed lock: if locked and prev exists, reuse prev notes for that role's track
      if (diceLocks && dicePrev) {
        const shouldLock =
          (role === "bass" && diceLocks.bass) ||
          (role === "chord" && diceLocks.chords) ||
          (role === "lead" && diceLocks.lead);
        if (shouldLock) {
          const namedTrack = targetTracks.find((track) => track.name.toLowerCase().includes(role));
          const track = namedTrack ?? targetTracks[roleIndex % targetTracks.length];
          const prevNotes = dicePrev.notes[track.id];
          if (prevNotes) {
            notesRecord[track.id] = JSON.parse(JSON.stringify(prevNotes));
            continue;
          }
        }
      }
      const part = melodicParts[role];
      if (part.length === 0) continue;
      const namedTrack = targetTracks.find((track) => {
        const name = track.name.toLowerCase();
        return name.includes(role);
      });
      const track = namedTrack ?? targetTracks[roleIndex % targetTracks.length];
      notesRecord[track.id] = [...(notesRecord[track.id] ?? []), ...part];
    }
  }

  const pattern: Pattern = {
    id: uid("pattern"),
    name: `${groove.genre} - ${groove.name}`,
    stepCount: options.stepCount,
    rows,
    notes: notesRecord,
    stepMeta: Object.keys(stepMeta).length > 0 ? stepMeta : undefined,
    phrasePlan: buildPhrasePlan(options.stepCount),
  };

  const outputContentHash = contentHash(canonicalizePattern(doc, pattern));
  const roles = Array.from({ length: rawRows.length }, (_, index) => inferPadRole(padNames?.[index], index));
  const drumQuality = measureDrumQuality(groove, rawRows, roles, options.stepCount);
  const styleGate = evaluateStyleDistance(groove, rawRows, options.stepCount);
  const melodicQuality = measureMelodicQuality(Object.values(notesRecord).flat(), options.stepCount, doc.key);
  return {
    ...pattern,
    generation: {
      ...createGenerationRecipe(options, groove.id, inputContentHash),
      outputContentHash,
      quality: {
        styleDistance: styleGate.distance,
        styleAccepted: styleGate.accepted,
        syncopation: drumQuality.syncopation,
        anchorCoverage: drumQuality.anchorCoverage,
        melodicMotifRepetition: melodicQuality.motifRepetition,
        melodicRestRatio: melodicQuality.restRatio,
        melodicDurationLongRatio: melodicQuality.durationDistribution.long,
      },
    },
  };
}
