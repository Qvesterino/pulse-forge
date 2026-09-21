import { extractChroma } from "../dsp/chroma";
import { MAJOR_PROFILE, MINOR_PROFILE, pearson, rotateProfile } from "../dsp/keyProfiles";
import type { ReferenceKeyCandidate, ReferenceTonal } from "../types";
import { camelotFromKey, pitchClassName } from "./camelot";
import { clamp01 } from "./confidence";

export interface TonalAnalysisInput {
  signal: Float32Array;
  sampleRate: number;
  fftSize: number;
  hopSize: number;
}

export interface TonalAnalysisOutput extends ReferenceTonal {
  /** Number of chroma frames that fed the scoring (0 when input was silent/too short). */
  frameCount: number;
}

/**
 * Score all 24 keys (12 tonics × major/minor) against a normalized chroma
 * vector using the Krumhansl–Schmuckler rotated Pearson correlation. Returns
 * the candidates deterministically sorted by score (desc), then mode, then
 * tonic — same input always yields the same order.
 *
 * Ported verbatim from audiokey-analyzer/src/analysis/tonalAnalyzer.ts
 * (Apache-2.0 / project-owned, see docs/REFERENCE-MAP-ROADMAP.md §B).
 */
export function scoreKeys(chroma: number[]): ReferenceKeyCandidate[] {
  const results: ReferenceKeyCandidate[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const tonicName = pitchClassName(tonic);
    results.push({
      tonic: tonicName,
      mode: "major",
      score: pearson(chroma, rotateProfile(MAJOR_PROFILE, tonic)),
      confidence: 0,
    });
    results.push({
      tonic: tonicName,
      mode: "minor",
      score: pearson(chroma, rotateProfile(MINOR_PROFILE, tonic)),
      confidence: 0,
    });
  }
  // Deterministic ordering: score desc, then mode, then tonic name.
  results.sort((a, b) => b.score - a.score || a.mode.localeCompare(b.mode) || a.tonic.localeCompare(b.tonic));
  return results;
}

/**
 * Tonal analysis pipeline: pitch-class chroma → 24-key Pearson scoring →
 * best vs second-best separation + absolute + tonality + peakiness weighted
 * confidence. Returns null tonic when the chroma carries no usable tonal
 * energy (silence, broadband noise, very-short buffers).
 */
export function analyzeTonality(input: TonalAnalysisInput): TonalAnalysisOutput {
  const { signal, sampleRate, fftSize, hopSize } = input;
  const { chroma, frameCount, tonalEnergy } = extractChroma(signal, sampleRate, fftSize, hopSize);

  if (frameCount === 0) {
    return {
      tonic: null,
      mode: null,
      camelot: null,
      confidence: 0,
      chroma,
      candidates: [],
      warning: "Key could not be determined: insufficient tonal information.",
      frameCount,
    };
  }

  const ranked = scoreKeys(chroma);
  const best = ranked[0];
  const second = ranked[1];

  // Tonality strength: how peaked the aggregate chroma is vs. a flat spectrum.
  const maxBin = Math.max(...chroma);
  const peakiness = clamp01((maxBin - 1 / 12) / (0.25 - 1 / 12));

  const separation = clamp01((best.score - second.score) / 0.35);
  const absolute = clamp01((best.score - 0.3) / 0.55);
  const tonality = clamp01(tonalEnergy * 3);

  const confidence = clamp01(0.4 * absolute + 0.3 * separation + 0.2 * tonality + 0.1 * peakiness);

  const candidates = ranked.slice(0, 5).map((c) => ({
    ...c,
    score: Number(c.score.toFixed(4)),
    confidence: clamp01((c.score - 0.3) / 0.55),
  }));

  return {
    tonic: best.tonic,
    mode: best.mode,
    camelot: camelotFromKey(best.tonic, best.mode),
    confidence,
    chroma,
    candidates,
    warning: confidence < 0.55 ? "Low tonal confidence — the key is ambiguous." : null,
    frameCount,
  };
}
