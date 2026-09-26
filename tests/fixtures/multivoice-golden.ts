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
 */
export const MULTIVOICE_GOLDEN_EXPECTED: ReadonlyArray<{ caseId: string; hash: string }> = [
  { caseId: "house", hash: "e7f3d7f1" },
  { caseId: "techno", hash: "6985914c" },
  { caseId: "trap", hash: "a5b858a3" },
  { caseId: "ambient", hash: "a94d6c99" },
  { caseId: "drill", hash: "4e733b49" },
  { caseId: "phonk", hash: "d3c8d39d" },
  { caseId: "jersey", hash: "6d92fe79" },
  { caseId: "dnb", hash: "07e3a388" },
];
