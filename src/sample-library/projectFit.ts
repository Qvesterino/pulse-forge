import type { ProjectDocument } from "../project-model/types";
import { ASSET_MOODS } from "./manifest";
import { PRESET_GENRES } from "../presets/types";

export interface ProjectSoundContext {
  genreTokens: ReadonlySet<string>;
  moodTokens: ReadonlySet<string>;
  bpm: number;
  keyRoot: string | null;
}

export interface SoundFitDescriptor {
  genres?: readonly string[];
  moods?: readonly string[];
  bpm?: number;
  bpmRange?: { min: number; max: number };
  key?: string;
}

const GENRE_TOKENS = new Set([
  ...PRESET_GENRES,
  "rnb",
  "boombap",
  "jungle",
  "ukg",
  "garage",
  "lofi",
  "lo-fi",
  "breakbeat",
  "electro",
]);

function tokens(value: string): string[] {
  return value.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function keyRoot(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^\s*([a-g])\s*([#b]?)/i.exec(value);
  if (!match) return null;
  const letter = match[1]!.toUpperCase();
  const accidental = match[2] ?? "";
  const pitchClass = ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as const)[
    letter as "A" | "B" | "C" | "D" | "E" | "F" | "G"
  ];
  const normalized = (pitchClass + (accidental === "#" ? 1 : accidental === "b" ? 11 : 0)) % 12;
  return ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][normalized] ?? null;
}

export function projectSoundContext(doc: ProjectDocument, bpm = doc.bpm): ProjectSoundContext {
  const genreTokens = new Set<string>();
  const moodTokens = new Set<string>();
  const addProjectTag = (value: string): void => {
    for (const token of tokens(value)) {
      if (GENRE_TOKENS.has(token)) genreTokens.add(token);
      if ((ASSET_MOODS as readonly string[]).includes(token)) moodTokens.add(token);
    }
  };

  for (const tag of doc.tags ?? []) addProjectTag(tag);
  for (const fact of doc.producerBrief?.facts ?? []) {
    if (fact.field === "genre" || fact.field === "style") {
      for (const token of tokens(fact.value)) genreTokens.add(token);
    } else if (fact.field === "mood") {
      for (const token of tokens(fact.value)) moodTokens.add(token);
    }
  }

  return {
    genreTokens,
    moodTokens,
    bpm: Number.isFinite(bpm) ? bpm : doc.bpm,
    keyRoot: keyRoot(doc.key),
  };
}

export function scoreProjectSoundFit(descriptor: SoundFitDescriptor, context: ProjectSoundContext): number {
  let score = 0;
  const soundGenres = new Set((descriptor.genres ?? []).flatMap(tokens));
  const soundMoods = new Set((descriptor.moods ?? []).flatMap(tokens));
  if ([...soundGenres].some((token) => context.genreTokens.has(token))) score += 4;
  if ([...soundMoods].some((token) => context.moodTokens.has(token))) score += 2;

  if (descriptor.bpmRange && context.bpm >= descriptor.bpmRange.min && context.bpm <= descriptor.bpmRange.max) {
    score += 2;
  } else if (
    descriptor.bpm !== undefined &&
    Number.isFinite(descriptor.bpm) &&
    Math.abs(descriptor.bpm - context.bpm) <= Math.max(6, context.bpm * 0.05)
  ) {
    score += 2;
  }

  const soundKeyRoot = keyRoot(descriptor.key);
  if (soundKeyRoot && context.keyRoot && soundKeyRoot === context.keyRoot) score += 1;
  return score;
}

export function rankByProjectSoundFit<T>(
  values: readonly T[],
  descriptorOf: (value: T) => SoundFitDescriptor,
  context: ProjectSoundContext,
): T[] {
  return values
    .map((value, index) => ({ value, index, score: scoreProjectSoundFit(descriptorOf(value), context) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ value }) => value);
}

export function projectSoundGenreOptions(tags: readonly string[]): string[] {
  const values = new Map<string, string>();
  for (const genre of PRESET_GENRES) values.set(genre, genre);
  for (const tag of tags) {
    for (const token of tokens(tag)) {
      if (GENRE_TOKENS.has(token)) values.set(token, token);
    }
  }
  return [...values.values()].sort((a, b) => a.localeCompare(b));
}

export function projectSoundMoodOptions(tags: readonly string[]): string[] {
  const values = new Map<string, string>(ASSET_MOODS.map((mood) => [mood, mood]));
  for (const tag of tags) {
    for (const token of tokens(tag)) {
      if ((ASSET_MOODS as readonly string[]).includes(token)) values.set(token, token);
    }
  }
  return [...values.values()].sort((a, b) => a.localeCompare(b));
}
