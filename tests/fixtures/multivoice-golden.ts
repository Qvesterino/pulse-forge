import { hashString } from "../../src/shared/rng";
import { generateMultiVoice, type MultiVoiceResult } from "../../src/intent/multi-voice";
import { testDoc } from "./doc";

/**
 * MULTI-VOICE GOLDEN (QA-4) — frozen regression lock for the harmony engine
 * (P2 dynamics + P3 figures). 8 genres × fixed seed, 64 steps, default
 * density/complexity: any harmonic/dynamical drift changes these hashes.
 * Template-path goldens live in ai-correctness.expected.ts; the intent-ranker
 * human golden lives in scripts/data/intent-ranker-golden.json — this file
 * covers neither, only generateMultiVoice output identity.
 */

export interface MultivoiceGoldenCase {
  id: string;
  genre: string;
  seed: number;
  energy: number;
}

export const MULTIVOICE_GOLDEN_CASES: readonly MultivoiceGoldenCase[] = [
  { id: "house", genre: "house", seed: 42, energy: 0.8 },
  { id: "techno", genre: "techno", seed: 42, energy: 0.8 },
  { id: "trap", genre: "trap", seed: 42, energy: 0.8 },
  { id: "ambient", genre: "ambient", seed: 42, energy: 0.8 },
  { id: "drill", genre: "drill", seed: 42, energy: 0.8 },
  { id: "phonk", genre: "phonk", seed: 42, energy: 0.8 },
  { id: "jersey", genre: "jersey", seed: 42, energy: 0.8 },
  { id: "dnb", genre: "dnb", seed: 42, energy: 0.8 },
];

/** Canonical content identity: sorted voices, no unstable ids. */
export function canonicalMultivoice(result: MultiVoiceResult): string {
  const voice = (notes: MultiVoiceResult["bass"]) =>
    [...notes]
      .map((n) => [n.pitch, n.start, n.duration, n.velocity] as const)
      .sort((a, b) => a[1] - b[1] || a[0] - b[0])
      .map(([pitch, start, duration, velocity]) => `${pitch}:${start}:${duration}:${velocity}`);
  return JSON.stringify({
    bass: voice(result.bass),
    chord: voice(result.chord),
    lead: voice(result.lead),
    progression: result.progressionName,
  });
}

export function multivoiceHash(result: MultiVoiceResult): string {
  return (hashString(canonicalMultivoice(result)) >>> 0).toString(16).padStart(8, "0");
}

export function generateGoldenVoice(testCase: MultivoiceGoldenCase): MultiVoiceResult {
  return generateMultiVoice(testDoc(), testCase.genre, testCase.seed, 64, null, testCase.energy, 0.3);
}

/**
 * Frozen hashes — generated 2026-09-24 from the P3 implementation
 * (seed 42 → legacy index 0 everywhere; drill/phonk/jersey/dnb resolve
 * their own sets, no house fallback). Sanity at freeze: 32 bass (8ths),
 * 24 lead (full rhythm), voiced chords, named progressions — see QA-4 log.
 *
 * Re-frozen 2026-10-17 for drill/phonk/jersey only: the melodic-dialect waves
 * landed after the freeze (gabber/hardcore roster, dialects wave 3, melodic
 * table coverage 21/21) and legitimately changed those three voices' content
 * identity — the other five hashes are byte-identical to the freeze. The
 * full-band sanity spec below (bass/chord/lead non-empty, named progression)
 * still passes for every case; only content identity moved, which is exactly
 * what a freeze on generated MUSIC is expected to do when the dialect library
 * grows. House/techno/trap/ambient/dnb stay untouched.
 */
export const MULTIVOICE_GOLDEN_EXPECTED: ReadonlyArray<{ caseId: string; hash: string }> = [
  { caseId: "house", hash: "e7f3d7f1" },
  { caseId: "techno", hash: "6985914c" },
  { caseId: "trap", hash: "a5b858a3" },
  { caseId: "ambient", hash: "a94d6c99" },
  { caseId: "drill", hash: "4cc8313b" },
  { caseId: "phonk", hash: "4e1b40dd" },
  { caseId: "jersey", hash: "eaec86f3" },
  { caseId: "dnb", hash: "07e3a388" },
];
