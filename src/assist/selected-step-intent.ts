import type { AssistTarget } from "./types";

export interface SelectedStepIntent {
  operation: "humanize" | "thin";
  /** Null means the user referred to the visible step selection as a whole. */
  target: AssistTarget | null;
}

const HUMANIZE_WORDS = new Set(["humanize", "humanise", "vary", "randomize", "randomise", "humanizuj", "varuj"]);
const THIN_WORDS = new Set(["thin", "sparse", "sparser", "sparsify", "redsie", "redsi", "uber", "zredukuj"]);
const DENSITY_WORDS = new Set(["dense", "density", "hustota", "hustotu"]);
const SCOPE_WORDS = new Set([
  "selected",
  "selection",
  "these",
  "this",
  "vybrany",
  "vybrana",
  "vybrane",
  "vybranych",
  "vybraneho",
  "vybratu",
  "tieto",
  "tento",
  "tuto",
  "step",
  "steps",
  "hit",
  "hits",
  "cell",
  "cells",
  "row",
  "rows",
  "kroky",
  "krokov",
  "uder",
  "udery",
  "bunky",
]);
const FILLER_WORDS = new Set(["a", "an", "the", "my", "our", "please", "make", "some", "less", "more", "hi", "z"]);

const TARGET_WORDS: Record<AssistTarget, ReadonlySet<string>> = {
  hats: new Set(["hat", "hats", "haty", "hihat", "hihats", "hihatky", "cymbal", "cymbals", "cinely"]),
  kicks: new Set(["kick", "kicks", "kopak", "kopaky"]),
  snares: new Set(["snare", "snares", "clap", "claps", "malokop"]),
};

/**
 * Compile a deliberately small, fail-closed instruction vocabulary for the
 * visible sequencer selection. This is a deterministic fallback path; the
 * selected rows remain the authority for scope and target identity.
 */
export function parseSelectedStepIntent(text: string): SelectedStepIntent | null {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const words: string[] = normalized.match(/[a-z0-9]+/g) ?? [];
  if (words.length === 0) return null;

  const humanize = words.some((word) => HUMANIZE_WORDS.has(word));
  const explicitThin = words.some((word) => THIN_WORDS.has(word));
  const densityDown = words.includes("less") && words.some((word) => DENSITY_WORDS.has(word));
  if (Number(humanize) + Number(explicitThin || densityDown) !== 1) return null;

  const targets = (Object.entries(TARGET_WORDS) as Array<[AssistTarget, ReadonlySet<string>]>)
    .filter(([, aliases]) => words.some((word) => aliases.has(word)))
    .map(([target]) => target);
  if (targets.length > 1) return null;

  const hasScope = words.some((word) => SCOPE_WORDS.has(word));
  if (!hasScope && targets.length === 0) return null;

  const allowedWords = new Set([
    ...HUMANIZE_WORDS,
    ...THIN_WORDS,
    ...DENSITY_WORDS,
    ...SCOPE_WORDS,
    ...FILLER_WORDS,
    ...Object.values(TARGET_WORDS).flatMap((aliases) => [...aliases]),
  ]);
  if (words.some((word) => !allowedWords.has(word))) return null;

  return {
    operation: humanize ? "humanize" : "thin",
    target: targets[0] ?? null,
  };
}
