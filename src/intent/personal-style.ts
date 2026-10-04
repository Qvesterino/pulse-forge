import { GENRES } from "../ai/types";
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

const MIN_SUGGESTION_EXAMPLES = 3;
const RECENCY_HALF_LIFE_MS = 120 * 24 * 60 * 60 * 1000;

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

export function personalStyleDescription(profile: PersonalStyleProfile): string {
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
  return `${energy}, ${density}, ${rhythm}, ${movement}`;
}

/** Concrete, deterministic prompt ideas distilled from repeated local edits. */
export function personalStyleIntentSuggestions(profile: PersonalStyleProfile | null): PersonalStyleIntentSuggestion[] {
  if (!profile || profile.exampleCount < MIN_SUGGESTION_EXAMPLES) return [];
  const descriptors = personalStyleDescription(profile);
  return [
    {
      id: "signature",
      label: `Môj podpis · ${profile.genre}`,
      prompt: `${profile.genre} beat, ${descriptors}, v mojom osobnom štýle`,
    },
    {
      id: "more-driving",
      label: "Môj podpis · viac ťahu",
      prompt: `${profile.genre} beat v mojom osobnom štýle, driving, punchy, viac energie`,
    },
    {
      id: "more-space",
      label: "Môj podpis · viac priestoru",
      prompt: `${profile.genre} beat v mojom osobnom štýle, sparse, minimalistický, viac priestoru`,
    },
  ];
}
