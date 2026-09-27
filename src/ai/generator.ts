import type { ProjectDocument, Pattern, NoteEvent, StepMeta } from "../project-model/types";
import type { GenerateOptions, GrooveData } from "./types";
import { forkRandom, hashString } from "../shared/rng";
import { uid } from "../shared/ids";
import { getGroovesForGenre, getGrooveById } from "./grooves/index";
import { generateDrumPattern } from "./drums";
import { generateMelodicParts } from "./melodic";
import { drumTrackForTarget, instrumentTargets, instrumentTrackForRole } from "./role-targets";
import { inferPadRole } from "./pad-roles";
import { canonicalizePattern, contentHash, createGenerationRecipe } from "./evaluation";
import { measureDrumQuality, measureMelodicQuality } from "./quality";
import { evaluateStyleDistance } from "./style-quality";
import { buildPhrasePlan } from "./phrase";

/**
 * Stable seeded groove selection — ARCHITECTURE.md #67 / invariant #4
 * ("Old projects must not silently sound different").
 *
 * The obvious implementation is `Math.floor(rand() * grooves.length)`, but the
 * picked groove is then a function of the ARRAY LENGTH, not of the seed. Any
 * library edit — one new groove per genre per wave — remaps *every* seed at
 * once, so reopening a project and regenerating with the same seed yields a
 * different pocket than the day it was written. Measured on this repository:
 * house 52 grooves, seed "my-project-seed" resolved to `house.ukg`; adding one
 * groove flipped it to `house.afro`.
 *
 * Rendezvous (highest-random-weight) hashing instead scores each candidate
 * independently and takes the maximum:
 *   - order-independent — re-sorting the library changes nothing;
 *   - insertion-tolerant — a NEW groove only wins the seeds where its own hash
 *     beats the incumbent, i.e. ~1/(N+1) of them, not 100%.
 *
 * The residual ~1/(N+1) is unavoidable and correct: if the candidate set gains
 * a member, some seed is entitled to prefer it. What must not happen is the
 * current behaviour where adding one groove invalidates all N.
 */
function pickGrooveBySeed(grooves: readonly GrooveData[], seed: string): GrooveData {
  let best = grooves[0];
  let bestWeight = -1;
  for (const groove of grooves) {
    // Tie-break on id so a 32-bit hash collision can never make the result
    // depend on array order.
    const weight = hashString(`${seed}|${groove.id}`);
    if (weight > bestWeight || (weight === bestWeight && groove.id < best.id)) {
      bestWeight = weight;
      best = groove;
    }
  }
  return best;
}

/**
 * Seeded groove resolution used by generation. Explicit `style` still wins
 * (by id, then by display name) so a named request is never overridden.
 */
export function resolveGrooveSeeded(
  genre: GenerateOptions["genre"],
  style: string | undefined,
  seed: string,
): GrooveData {
  if (style) {
    const byId = getGrooveById(`${genre}.${style.toLowerCase().replace(/\s+/g, "")}`);
    if (byId) return byId;

    const named = getGroovesForGenre(genre).find((g) => g.name.toLowerCase() === style.toLowerCase());
    if (named) return named;
  }

  let grooves = getGroovesForGenre(genre);
  if (grooves.length === 0) {
    // Fallback for unknown / mistyped genres — never let the indexed lookup
    // dereference `undefined.id` and throw into the generator pipeline.
    grooves = getGroovesForGenre("house");
  }
  if (grooves.length === 0) throw new Error("resolveGrooveSeeded: groove library is empty");
  return pickGrooveBySeed(grooves, `${genre}|${seed}`);
}

/** Resolve which groove to use based on genre + optional style name */
export function resolveGroove(genre: GenerateOptions["genre"], style?: string, rand?: () => number): GrooveData {
  if (style) {
    const byId = getGrooveById(`${genre}.${style.toLowerCase().replace(/\s+/g, "")}`);
    if (byId) return byId;

    const grooves = getGroovesForGenre(genre);
    const match = grooves.find((g) => g.name.toLowerCase() === style.toLowerCase());
    if (match) return match;
  }

  // Index-based selection: kept for the explicit `rand` seam used by tests and
  // for the genre's canonical first entry. Generation itself goes through
  // resolveGrooveSeeded so that the pick does not depend on array length.
  let grooves = getGroovesForGenre(genre);
  if (grooves.length === 0) {
    grooves = getGroovesForGenre("house");
  }
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

/**
 * Resolve the groove using exactly the same seed derivation as generation.
 *
 * Goes through resolveGrooveSeeded, NOT resolveGroove: the index-based pick
 * depends on how many grooves the genre happens to have, so every new groove
 * in the library would change what an existing seed produces. See the
 * pickGrooveBySeed comment for the measured regression this avoids.
 */
export function resolveGrooveForGeneration(doc: ProjectDocument, options: GenerateOptions): GrooveData {
  const effectiveSeed = resolveEffectiveSeed(doc, options);
  return resolveGrooveSeeded(options.genre, options.style, effectiveSeed);
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

  // Defensive: clamp stepCount to a finite positive value so downstream
  // array allocations (new Array(stepCount)) never throw on negative/NaN input.
  const safeStepCount =
    Number.isFinite(options.stepCount) && options.stepCount > 0 ? Math.min(256, Math.floor(options.stepCount)) : 16;

  // Groove choice and every generation subsystem receive independent streams.
  const groove = resolveGrooveForGeneration(doc, options);
  const effectiveKey = options.key ?? doc.key;
  const roles = options.roles;
  const drumsEnabled = !roles || roles.includes("drums");

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
  const targetDrumTrack = drumTrackForTarget(doc, options.drumTrackId);
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

  // Dice swing jitter — if _diceSwing is set, it overrides groove swing
  const effectiveSwing =
    options.constraints?.allowSwing === false
      ? 0
      : typeof (options as GenerateOptions & { _diceSwing?: number })._diceSwing === "number"
        ? (options as GenerateOptions & { _diceSwing?: number })._diceSwing!
        : options.applyGrooveSettings || (doc.groove?.swing ?? 0) > 0
          ? 0
          : groove.swing;

  // Generate drum pattern
  const safeOptions = { ...options, stepCount: safeStepCount };
  const { rows: rawRows, meta } = drumsEnabled
    ? generateDrumPattern(
        groove,
        safeOptions,
        drumRand,
        {
          variation: drumVariationRand,
          meta: drumMetaRand,
          swing: effectiveSwing,
          lockedIndices,
          prevRows: prevRowsByIndex,
          prevMeta: prevMetaByIndex,
        } as unknown as import("./drums").DrumRandomStreams,
        padNames,
      )
    : { rows: [] as number[][], meta: new Map<number, Map<number, StepMeta>>() };

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
  const melodicParts = generateMelodicParts(options, melodyRand, effectiveKey, rawRows, {
    bass: bassRand,
    chord: chordRand,
    lead: leadRand,
  });

  // Build notes Record<ID, NoteEvent[]>
  const notesRecord: Record<string, NoteEvent[]> = {};
  const targetTracks = instrumentTargets(doc, options.instrumentTrackIds);
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
          const track = instrumentTrackForRole(doc, role, options.instrumentTrackIds);
          if (!track) continue;
          const prevNotes = dicePrev.notes[track.id];
          if (prevNotes) {
            notesRecord[track.id] = JSON.parse(JSON.stringify(prevNotes));
            continue;
          }
        }
      }
      const part = melodicParts[role];
      if (part.length === 0) continue;
      const track = instrumentTrackForRole(doc, role, options.instrumentTrackIds);
      if (!track) continue;
      notesRecord[track.id] = [...(notesRecord[track.id] ?? []), ...part];
    }
  }

  const pattern: Pattern = {
    id: uid("pattern"),
    name: `${groove.genre} - ${groove.name}`,
    stepCount: safeStepCount,
    rows,
    notes: notesRecord,
    stepMeta: Object.keys(stepMeta).length > 0 ? stepMeta : undefined,
    phrasePlan: buildPhrasePlan(safeStepCount),
  };

  const outputContentHash = contentHash(canonicalizePattern(doc, pattern));
  const padRoles = Array.from({ length: rawRows.length }, (_, index) => inferPadRole(padNames?.[index], index));
  const drumQuality = measureDrumQuality(groove, rawRows, padRoles, safeStepCount);
  const styleGate = evaluateStyleDistance(groove, rawRows, safeStepCount);
  const melodicQuality = measureMelodicQuality(Object.values(notesRecord).flat(), safeStepCount, effectiveKey);
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
