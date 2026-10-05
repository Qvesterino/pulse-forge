import { GENRES } from "../ai/types";
import { FEATURE_V2_NAMES } from "../ai/features/pattern-features-v2";
import { fitPersonalPreferenceModel } from "./personal-ranker";
import {
  isPreferenceLearningEnabled,
  preferenceContextForIntent,
  readPreferenceLedger,
  type PreferenceObservationV1,
} from "./preference-ledger";
import { normalizeIntent } from "./normalize";
import { isValidStyleExample, readStyleExamples, type StyleExampleV1 } from "./style-example-ledger";

export interface PersonalStyleProfile {
  genre: string;
  exampleCount: number;
  confidence: number;
  energy: number;
  density: number;
  complexity: number;
  variation: number;
}

export interface PersonalStyleIntentSuggestion {
  id: "signature" | "more-driving" | "more-space";
  label: string;
  prompt: string;
}

export interface PersonalStyleCorrectionSummary {
  /** Unique, locally stored before/after edit comparisons for this genre. */
  correctionCount: number;
  /** Directional comparisons available to the same model used for reranking. */
  learnedComparisonCount: number;
  modelReady: boolean;
  rankerEnabled: boolean;
  /** Human-readable directions whose 69-feature weights carry the clearest signal. */
  directions: string[];
}

const MIN_SUGGESTION_EXAMPLES = 3;
const RECENCY_HALF_LIFE_MS = 120 * 24 * 60 * 60 * 1000;

const FEATURE_DIRECTIONS: Readonly<Record<string, readonly [string, string]>> = {
  "drums.density": ["hustejšie bicie", "viac priestoru v bicích"],
  "drums.anchorCoverage": ["pevný kick/snare základ", "voľnejší rytmický základ"],
  "drums.ghostRatio": ["jemné ghost údery", "čisté bicie bez ghost úderov"],
  "drums.syncopation": ["synkopované bicie", "rovnejší groove"],
  "drums.offbeatRatio": ["offbeat údery", "údery pevne v gride"],
  "drums.barRepetition": ["opakujúci sa groove", "obmeny medzi taktmi"],
  "drums.velocitySpread": ["výrazné dynamické akcenty", "rovnomerná dynamika"],
  "drums.microtimingPresence": ["ľudský mikrotiming", "presný timing v gride"],
  "melodic.noteDensity": ["hutnejšia melodika", "vzdušná melodika"],
  "melodic.restRatio": ["melodické pauzy", "plynulé melodické frázy"],
  "melodic.pitchRange": ["širší melodický register", "úzky melodický register"],
  "melodic.intervalVariety": ["pestrejší pohyb tónov", "jednoduchý pohyb tónov"],
  "melodic.motifRepetition": ["vracajúci sa melodický motív", "vyvíjajúca sa melódia"],
  "melodic.motifNovelty": ["nové melodické motívy", "opakujúca sa fráza"],
  "bass.noteDensity": ["hustejšia basa", "úspornejšia basa"],
  "bass.rootAlignment": ["basu pevne viazanú na harmóniu", "voľnejší pohyb basy"],
  "bass.movement": ["pohyblivú basovú linku", "stabilnejšiu basovú linku"],
  "bass.syncopation": ["synkopovanú basu", "rovnejšiu basu"],
  "bass.registerStability": ["stabilnú polohu basy", "pohyb basy medzi registrami"],
  "harmony.voicingMovement": ["plynulé zmeny akordov", "stabilné akordické voicingy"],
  "harmony.harmonicRhythm": ["častejšie harmonické zmeny", "dlhšie držané akordy"],
  "harmony.voiceRichness": ["bohatšie akordické voicingy", "jednoduchšie akordy"],
  "harmony.chordDensity": ["hustejšiu harmóniu", "viac priestoru medzi akordmi"],
  "arrangement.rhythmicAlignment": ["pevný súlad basy s bicími", "nezávislejší pohyb basy a bicích"],
};

/**
 * Read the same local pairwise model that reranks valid Intent candidates and
 * translate its strongest learned axes into useful, inspectable style cues.
 */
export function personalStyleCorrectionSummary(
  genre: string,
  observations: readonly PreferenceObservationV1[] = readPreferenceLedger(),
): PersonalStyleCorrectionSummary {
  const matching = observations.filter((observation) => observation.context.genre === genre);
  const corrections = matching.filter(
    (observation) => observation.source === "edit" && (observation.choice === "a" || observation.choice === "b"),
  );
  const context = preferenceContextForIntent(normalizeIntent({ genre }));
  const model = fitPersonalPreferenceModel(observations, context);
  const directions = model
    ? Object.entries(FEATURE_DIRECTIONS)
        .map(([featureName, labels]) => {
          const index = FEATURE_V2_NAMES.indexOf(featureName);
          const weight = model.weights[index] ?? 0;
          return { label: weight >= 0 ? labels[0] : labels[1], strength: Math.abs(weight) };
        })
        .filter((entry) => entry.strength >= 0.025)
        .sort((a, b) => b.strength - a.strength || a.label.localeCompare(b.label))
        .slice(0, 3)
        .map((entry) => entry.label)
    : [];
  return {
    correctionCount: corrections.length,
    learnedComparisonCount: model?.comparisonCount ?? 0,
    modelReady: model !== null,
    rankerEnabled: isPreferenceLearningEnabled(),
    directions,
  };
}

function genreExamples(examples: readonly StyleExampleV1[], genre: string): StyleExampleV1[] {
  return examples.filter((example) => example.genre === genre);
}

function dominantGenre(examples: readonly StyleExampleV1[]): string | null {
  const counts = new Map<string, number>();
  for (const example of examples) counts.set(example.genre, (counts.get(example.genre) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

export function personalStyleProfileFromExamples(
  examples: readonly StyleExampleV1[],
  genre: string,
): PersonalStyleProfile | null {
  const relevant = genreExamples(examples.filter(isValidStyleExample), genre);
  if (!(GENRES as readonly string[]).includes(genre) || relevant.length === 0) return null;
  const selectedGenre = genre;

  const newest = Math.max(...relevant.map((example) => example.savedAt));
  const weightedMean = (field: "energy" | "density" | "complexity" | "variation"): number => {
    let weighted = 0;
    let totalWeight = 0;
    for (const example of relevant) {
      const age = Math.max(0, newest - example.savedAt);
      const weight = Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
      weighted += example[field] * weight;
      totalWeight += weight;
    }
    return totalWeight > 0 ? weighted / totalWeight : 0.5;
  };

  return {
    genre: selectedGenre,
    exampleCount: relevant.length,
    confidence: Math.min(1, relevant.length / MIN_SUGGESTION_EXAMPLES),
    energy: weightedMean("energy"),
    density: weightedMean("density"),
    complexity: weightedMean("complexity"),
    variation: weightedMean("variation"),
  };
}

export function personalStyleProfilesFromExamples(examples: readonly StyleExampleV1[]): PersonalStyleProfile[] {
  const valid = examples.filter(isValidStyleExample);
  const genres = [...new Set(valid.map((example) => example.genre))].sort();
  return genres
    .map((genre) => personalStyleProfileFromExamples(valid, genre))
    .filter((profile): profile is PersonalStyleProfile => profile !== null);
}

export function personalStyleProfile(genre?: string | null): PersonalStyleProfile | null {
  const examples = readStyleExamples();
  const selectedGenre = genre && (GENRES as readonly string[]).includes(genre) ? genre : dominantGenre(examples);
  return selectedGenre ? personalStyleProfileFromExamples(examples, selectedGenre) : null;
}

export function personalStyleDescription(profile: PersonalStyleProfile, directions: readonly string[] = []): string {
  const energy = profile.energy >= 0.68 ? "energický" : profile.energy <= 0.38 ? "pokojný" : "vyvážený";
  const density = profile.density >= 0.68 ? "hustý" : profile.density <= 0.34 ? "vzdušný" : "stredne hustý";
  const rhythm =
    profile.complexity >= 0.64 ? "rytmicky členitý" : profile.complexity <= 0.3 ? "minimalistický" : "jemne členitý";
  const movement =
    profile.variation >= 0.62
      ? "vyvíjajúci sa"
      : profile.variation <= 0.28
        ? "hypnoticky opakujúci sa"
        : "s drobnými obmenami";
  const base = `${energy}, ${density}, ${rhythm}, ${movement}`;
  return directions.length > 0 ? `${base}, ${directions.slice(0, 2).join(", ")}` : base;
}

/** Concrete, deterministic prompt ideas distilled from repeated local edits. */
export function personalStyleIntentSuggestions(
  profile: PersonalStyleProfile | null,
  directions: readonly string[] = [],
): PersonalStyleIntentSuggestion[] {
  if (!profile || profile.exampleCount < MIN_SUGGESTION_EXAMPLES) return [];
  const descriptors = personalStyleDescription(profile, directions);
  const correctionTail = directions.length > 0 ? `; môj zvuk: ${directions.slice(0, 3).join(", ")}` : "";
  return [
    {
      id: "signature",
      label: `Môj podpis · ${profile.genre}`,
      prompt: `${profile.genre} beat, ${descriptors}, v mojom osobnom štýle${correctionTail}`,
    },
    {
      id: "more-driving",
      label: "Môj podpis · viac ťahu",
      prompt: `${profile.genre} beat v mojom osobnom štýle${correctionTail}, driving, punchy, viac energie`,
    },
    {
      id: "more-space",
      label: "Môj podpis · viac priestoru",
      prompt: `${profile.genre} beat v mojom osobnom štýle${correctionTail}, sparse, minimalistický, viac priestoru`,
    },
  ];
}
