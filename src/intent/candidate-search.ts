import { generateOptionsFromIntent } from "./plan";
import { getGroovesForGenre } from "../ai/grooves";
import { candidatePlan } from "./providers/candidate";
import type { GenerationPlan, IntentSpec } from "./types";
import type { PersonalSearchBias } from "./personal-ranker";
import { STEP_TICKS, type InstrumentTrack, type Pattern, type ProjectDocument } from "../project-model/types";
import { uid } from "../shared/ids";
import { refreshPatternQuality } from "./quality";

export type SearchLane = "safe" | "personal" | "experimental";

export interface CandidateSearchInfo {
  version: 1;
  lane: SearchLane;
  family: "baseline" | "soft-axis" | "alternate-groove" | "personal-groove";
  melodyFamily?: "repeating-hook";
  /** Exact in-library groove selected for a controlled rhythmic alternative. */
  grooveId?: string;
  /** Measured syncopation change in the generated pattern vs SAFE; only set after direction is verified. */
  measuredSyncopationDelta?: number;
  /** Number of deterministic groove seeds auditioned to realize that direction. */
  grooveSeedAttempts?: number;
  /** Personal lane without enough usable votes is explicitly cold-start. */
  mode: "baseline" | "personalized" | "cold-start" | "experimental";
  variant: number;
}

export interface CandidateSearchVariant {
  /** Plan used only to produce this candidate. */
  generationPlan: GenerationPlan;
  /** Original user intent + candidate seed; always used for gates/provenance. */
  validationPlan: GenerationPlan;
  search: CandidateSearchInfo;
}

const EXPERIMENTAL_VARIANTS = [
  { energy: 0.04, density: 0.15, complexity: 0.13, variation: 0.08 },
  { energy: -0.05, density: -0.14, complexity: 0.18, variation: 0.12 },
  { energy: 0.1, density: 0.07, complexity: -0.1, variation: 0.16 },
] as const;

const PERSONAL_HOOK_BIAS_THRESHOLD = 0.025;
const PERSONAL_GROOVE_BIAS_THRESHOLD = 0.025;
const PERSONAL_GROOVE_MIN_DISTANCE = 0.02;
const PERSONAL_GROOVE_OUTPUT_MIN_DISTANCE = 0.01;
const PERSONAL_GROOVE_MAX_ATTEMPTS = 8;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function searchLaneForCandidate(candidateIndex: number): SearchLane {
  switch (Math.abs(Math.floor(candidateIndex)) % 3) {
    case 1:
      return "personal";
    case 2:
      return "experimental";
    default:
      return "safe";
  }
}

function withSoftIntent(
  intent: IntentSpec,
  delta: Pick<PersonalSearchBias, "energy" | "density" | "complexity" | "variation">,
): IntentSpec {
  return {
    ...intent,
    energy: clamp01(intent.energy + delta.energy),
    density: clamp01(intent.density + delta.density),
    complexity: clamp01(intent.complexity + delta.complexity),
    variation: clamp01(intent.variation + delta.variation),
  };
}

function withSearchSeed(
  plan: GenerationPlan,
  intent: IntentSpec,
  seed: string,
  grooveOverride?: ReturnType<typeof getGroovesForGenre>[number],
): GenerationPlan {
  const generationIntent = { ...intent, seed };
  const options = generateOptionsFromIntent(generationIntent);
  return {
    ...plan,
    intent: {
      ...generationIntent,
      controls: {
        ...generationIntent.controls,
        ghostWeight: options.ghostWeight,
        microWeight: options.microWeight,
        velocityVariation: options.velocityVariation,
        temperature: options.temperature,
      },
    },
    ...(grooveOverride
      ? {
          groove: {
            id: grooveOverride.id,
            genre: grooveOverride.genre,
            name: grooveOverride.name,
            bpm: grooveOverride.bpm,
            swing: grooveOverride.swing,
          },
        }
      : {}),
    options: {
      ...options,
      ...(grooveOverride ? { style: grooveOverride.name } : {}),
      seed,
      candidateCount: plan.options.candidateCount,
    },
    recipe: {
      ...plan.recipe,
      ...(grooveOverride ? { style: grooveOverride.name } : {}),
      seed,
    },
  };
}

function experimentalGroove(
  plan: GenerationPlan,
  variant: number,
): ReturnType<typeof getGroovesForGenre>[number] | null {
  // An explicit style is part of the request, not a knob for search to replace.
  // Also avoid paying for a groove family when the drum role is not generated.
  if (plan.intent.style || !plan.rolePlans.drums.enabled || plan.rolePlans.drums.targetTrackIds.length === 0) {
    return null;
  }

  const grooves = getGroovesForGenre(plan.intent.genre);
  if (grooves.length < 2) return null;
  const baseIndex = Math.max(
    0,
    grooves.findIndex((groove) => groove.id === plan.groove.id),
  );
  const offset = 1 + (variant % (grooves.length - 1));
  return grooves[(baseIndex + offset) % grooves.length] ?? null;
}

/** Match the stable `drums.syncopation` feature: share of hits on 16th offbeats. */
function grooveSyncopation(groove: ReturnType<typeof getGroovesForGenre>[number]): number {
  let hits = 0;
  let syncopated = 0;
  for (const pattern of groove.patterns) {
    for (const velocities of Object.values(pattern)) {
      for (let step = 0; step < Math.min(16, velocities.length); step++) {
        if ((velocities[step] ?? 0) <= 0) continue;
        hits += 1;
        if (step % 4 === 1 || step % 4 === 3) syncopated += 1;
      }
    }
  }
  return hits > 0 ? syncopated / hits : 0;
}

function personalGroove(
  plan: GenerationPlan,
  personalBias: PersonalSearchBias | null,
  variant: number,
): ReturnType<typeof getGroovesForGenre>[number] | null {
  const bias = personalBias?.grooveSyncopation ?? 0;
  if (
    Math.abs(bias) < PERSONAL_GROOVE_BIAS_THRESHOLD ||
    plan.intent.style ||
    !plan.rolePlans.drums.enabled ||
    plan.rolePlans.drums.targetTrackIds.length === 0
  ) {
    return null;
  }

  const grooves = getGroovesForGenre(plan.intent.genre);
  const baseline = grooves.find((groove) => groove.id === plan.groove.id);
  if (!baseline || grooves.length < 2) return null;
  const baseSyncopation = grooveSyncopation(baseline);
  const direction = Math.sign(bias);
  const preferred = grooves
    .filter((groove) => {
      if (groove.id === baseline.id) return false;
      const delta = (grooveSyncopation(groove) - baseSyncopation) * direction;
      return delta >= PERSONAL_GROOVE_MIN_DISTANCE;
    })
    .sort(
      (a, b) =>
        Math.abs(grooveSyncopation(a) - baseSyncopation) - Math.abs(grooveSyncopation(b) - baseSyncopation) ||
        a.id.localeCompare(b.id),
    );
  return preferred.length > 0 ? (preferred[variant % preferred.length] ?? null) : null;
}

function experimentalMelodyFamily(plan: GenerationPlan): CandidateSearchInfo["melodyFamily"] {
  if (!plan.rolePlans.lead.enabled || plan.rolePlans.lead.targetTrackIds.length === 0 || plan.options.stepCount < 32) {
    return undefined;
  }
  return "repeating-hook";
}

function personalMelodyFamily(
  plan: GenerationPlan,
  personalBias: PersonalSearchBias | null,
): CandidateSearchInfo["melodyFamily"] {
  if (!personalBias || personalBias.motifRepetition < PERSONAL_HOOK_BIAS_THRESHOLD) return undefined;
  return experimentalMelodyFamily(plan);
}

function leadTrackForPlan(doc: ProjectDocument, plan: GenerationPlan): InstrumentTrack | null {
  const targetTracks = doc.tracks.filter(
    (track): track is InstrumentTrack =>
      track.kind === "instrument" && plan.rolePlans.lead.targetTrackIds.includes(track.id),
  );
  if (targetTracks.length === 0) return null;
  return (
    targetTracks.find((track) => track.name.toLowerCase().includes("lead")) ?? targetTracks[2 % targetTracks.length]
  );
}

/** Apply the requested motif family after any template/ONNX/multivoice path. */
export function applyCandidateSearchFamily(
  pattern: Pattern,
  doc: ProjectDocument,
  generationPlan: GenerationPlan,
  searchInfo: CandidateSearchInfo,
): { pattern: Pattern; search: CandidateSearchInfo } {
  if (searchInfo.melodyFamily !== "repeating-hook") return { pattern, search: searchInfo };

  const leadTrack = leadTrackForPlan(doc, generationPlan);
  const leadNotes = leadTrack ? (pattern.notes?.[leadTrack.id] ?? []) : [];
  const barTicks = 16 * STEP_TICKS;
  const firstBar = leadNotes.filter(
    (note) =>
      Number.isFinite(note.start) &&
      note.start >= 0 &&
      note.start < barTicks &&
      Number.isFinite(note.duration) &&
      note.duration > 0 &&
      Number.isFinite(note.pitch),
  );
  if (firstBar.length === 0) {
    const search = { ...searchInfo };
    delete search.melodyFamily;
    return { pattern, search };
  }

  const totalTicks = pattern.stepCount * STEP_TICKS;
  const repeated = firstBar.map((note) => ({
    ...note,
    duration: Math.max(1, Math.min(note.duration, barTicks - note.start)),
  }));
  const bars = Math.ceil(totalTicks / barTicks);
  for (let bar = 1; bar < bars; bar++) {
    for (const note of firstBar) {
      const start = note.start + bar * barTicks;
      if (start >= totalTicks) continue;
      const duration = Math.min(note.duration, totalTicks - start, barTicks - note.start);
      if (!Number.isFinite(duration) || duration <= 0) continue;
      repeated.push({ ...note, id: uid("note"), start, duration });
    }
  }

  const notes = [...repeated].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const transformed = {
    ...pattern,
    notes: { ...pattern.notes, [leadTrack!.id]: notes },
  };
  return {
    pattern: refreshPatternQuality(doc, transformed, generationPlan.options),
    search: searchInfo,
  };
}

/**
 * Build a deterministic lane-specific generation plan while retaining a
 * separate unmodified plan for hard brief gates and truthful provenance.
 * Candidate 0 is deliberately byte-for-byte on the legacy SAFE path.
 */
export function candidateSearchVariant(
  plan: GenerationPlan,
  seed: string,
  candidateIndex: number,
  personalBias: PersonalSearchBias | null,
): CandidateSearchVariant {
  const lane = searchLaneForCandidate(candidateIndex);
  const variant = Math.floor(Math.abs(Math.floor(candidateIndex)) / 3);
  const validationPlan = candidatePlan(plan, seed);

  if (lane === "safe") {
    return {
      generationPlan: validationPlan,
      validationPlan,
      search: { version: 1, lane, family: "baseline", mode: "baseline", variant },
    };
  }

  let delta: Pick<PersonalSearchBias, "energy" | "density" | "complexity" | "variation">;
  let mode: CandidateSearchInfo["mode"];
  if (lane === "personal") {
    delta = personalBias ?? { energy: 0, density: 0, complexity: 0, variation: 0 };
    mode = personalBias ? "personalized" : "cold-start";
  } else {
    delta = EXPERIMENTAL_VARIANTS[variant % EXPERIMENTAL_VARIANTS.length];
    mode = "experimental";
  }

  const intent = withSoftIntent(plan.intent, delta);
  const grooveOverride =
    lane === "experimental" ? experimentalGroove(plan, variant) : personalGroove(plan, personalBias, variant);
  const melodyFamily =
    lane === "experimental" ? experimentalMelodyFamily(plan) : personalMelodyFamily(plan, personalBias);
  const family = grooveOverride ? (lane === "personal" ? "personal-groove" : "alternate-groove") : "soft-axis";
  const searchSeed = `${seed}|search:v1:${lane}:e${intent.energy.toFixed(2)}:d${intent.density.toFixed(2)}:c${intent.complexity.toFixed(2)}:v${intent.variation.toFixed(2)}${grooveOverride ? `:groove:${grooveOverride.id}` : ""}${melodyFamily ? `:melody:${melodyFamily}` : ""}`;
  return {
    generationPlan: withSearchSeed(validationPlan, intent, searchSeed, grooveOverride ?? undefined),
    validationPlan,
    search: {
      version: 1,
      lane,
      family,
      ...(melodyFamily ? { melodyFamily } : {}),
      ...(grooveOverride ? { grooveId: grooveOverride.id } : {}),
      mode,
      variant,
    },
  };
}

export interface PersonalGrooveSelection<T> {
  variant: CandidateSearchVariant;
  candidate: T | null;
  attempts: number;
  outputDelta: number | null;
}

/**
 * A groove template's syncopation score is only a prior: the Markov generator can
 * produce a result on the wrong side of the preference. Retry deterministic
 * seeds until the actual candidate moves measurably in the learned direction.
 * The caller's `build` callback must run the ordinary hard gates before it
 * returns a candidate; a failed search is omitted rather than mislabeled.
 */
export function selectPersonalGrooveCandidate<T>(args: {
  plan: GenerationPlan;
  seed: string;
  candidateIndex: number;
  personalBias: PersonalSearchBias;
  baselineSyncopation: number;
  build: (variant: CandidateSearchVariant) => { candidate: T; syncopation: number } | null;
  maxAttempts?: number;
}): PersonalGrooveSelection<T> {
  const initialVariant = candidateSearchVariant(args.plan, args.seed, args.candidateIndex, args.personalBias);
  const direction = Math.sign(args.personalBias.grooveSyncopation);
  const requestedAttempts = args.maxAttempts ?? PERSONAL_GROOVE_MAX_ATTEMPTS;
  const maxAttempts = Number.isFinite(requestedAttempts) ? Math.max(1, Math.min(16, Math.floor(requestedAttempts))) : 1;
  if (
    initialVariant.search.family !== "personal-groove" ||
    direction === 0 ||
    !Number.isFinite(args.baselineSyncopation)
  ) {
    return { variant: initialVariant, candidate: null, attempts: 0, outputDelta: null };
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const seed = attempt === 0 ? args.seed : `${args.seed}|personal-groove-attempt:${attempt}`;
    const variant = candidateSearchVariant(args.plan, seed, args.candidateIndex, args.personalBias);
    try {
      const built = args.build(variant);
      if (!built || !Number.isFinite(built.syncopation)) continue;
      const outputDelta = (built.syncopation - args.baselineSyncopation) * direction;
      if (outputDelta >= PERSONAL_GROOVE_OUTPUT_MIN_DISTANCE) {
        return { variant, candidate: built.candidate, attempts: attempt + 1, outputDelta };
      }
    } catch {
      // A failed attempt is not a reason to skip later deterministic seeds.
    }
  }

  return { variant: initialVariant, candidate: null, attempts: maxAttempts, outputDelta: null };
}
