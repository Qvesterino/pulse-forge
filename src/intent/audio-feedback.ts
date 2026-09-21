import { extractAudioFeatures, type AudioFeatures } from "../ai/audio-features";
import type { SampleBank } from "../sample-library/factory";
import type { ProjectDocument } from "../project-model/types";

/**
 * AUDIO FEEDBACK LOOP (INTENT_ENGINE.md #5 / D1 v3) — the ranking pipeline
 * HEARS the candidates before selecting a winner.
 *
 * Flow: render each candidate offline → extract time-domain features →
 * score against a per-genre target profile → blend with the symbolic rank.
 *
 * "Kandidát znie príliš tmavo na energetic house" is now a PROGRAMMATIC
 * observation: the spectral centroid (ZCR proxy) is below the target range,
 * and the candidate gets penalised.
 */

// ── Genre target profiles ───────────────────────────────────────────────────

export interface GenreAudioTarget {
  /** Expected integrated LUFS range (approximate — from render, not meter). */
  rmsRange: [number, number];
  /** Expected crest factor range (dynamic range proxy). */
  crestRange: [number, number];
  /** Expected ZCR range (brightness proxy). */
  zcrRange: [number, number];
  /** Expected bass energy ratio range. */
  bassRange: [number, number];
}

const AUDIO_TARGETS: Record<string, GenreAudioTarget> = {
  house: {
    rmsRange: [0.05, 0.3],
    crestRange: [2, 12],
    zcrRange: [0.01, 0.15],
    bassRange: [0.15, 0.6],
  },
  techno: {
    rmsRange: [0.08, 0.35],
    crestRange: [1.5, 8],
    zcrRange: [0.005, 0.1],
    bassRange: [0.25, 0.7],
  },
  trap: {
    rmsRange: [0.04, 0.25],
    crestRange: [3, 20],
    zcrRange: [0.005, 0.12],
    bassRange: [0.3, 0.8],
  },
  ambient: {
    rmsRange: [0.01, 0.12],
    crestRange: [4, 30],
    zcrRange: [0.005, 0.08],
    bassRange: [0.1, 0.5],
  },
};

/** How much the audio features influence the final ranking (0 = off, 1 = audio only). */
export const AUDIO_FEEDBACK_WEIGHT = 0.3;

/** Score a candidate's audio features against the genre target. 0..1, higher = better fit. */
export function scoreAudioFit(
  features: AudioFeatures,
  target: GenreAudioTarget,
): number {
  let total = 0;
  let dimensions = 0;

  // Each dimension: 1.0 if inside the range, linear falloff outside
  const rangeScore = (value: number, [lo, hi]: [number, number]): number => {
    if (value >= lo && value <= hi) return 1;
    if (value < lo) return Math.max(0, 1 - (lo - value) / (lo * 0.5 || 0.1));
    return Math.max(0, 1 - (value - hi) / (hi * 0.5 || 0.1));
  };

  total += rangeScore(features.rms, target.rmsRange);
  dimensions++;
  total += rangeScore(features.crestFactor, target.crestRange);
  dimensions++;
  total += rangeScore(features.zeroCrossingRate, target.zcrRange);
  dimensions++;
  total += rangeScore(features.lowBandRatio, target.bassRange);
  dimensions++;

  return dimensions > 0 ? total / dimensions : 0.5;
}

/** Get the audio target for a genre, falling back to house if unknown. */
export function audioTargetFor(genre: string): GenreAudioTarget {
  return AUDIO_TARGETS[genre] ?? AUDIO_TARGETS.house;
}

// ── Candidate audio scoring ────────────────────────────────────────────────

export interface CandidateAudioScore {
  candidateIndex: number;
  features: AudioFeatures;
  audioScore: number;
}

export type RenderCandidateFn = (
  doc: ProjectDocument,
  bank: SampleBank,
  patternPattern: Pattern,
) => Promise<Float32Array>;

import type { Pattern } from "../project-model/types";

/**
 * The audio feedback loop: render each candidate → extract features →
 * score against the genre target. Returns per-candidate audio scores.
 * The caller blends these with the symbolic rank.
 */
export async function scoreCandidatesBySound(
  doc: ProjectDocument,
  candidates: Array<{ pattern: Pattern; candidateIndex: number }>,
  genre: string,
  renderFn: (doc: ProjectDocument, pattern: Pattern) => Promise<Float32Array>,
): Promise<CandidateAudioScore[]> {
  const target = audioTargetFor(genre);
  const results: CandidateAudioScore[] = [];

  for (const candidate of candidates) {
    try {
      const audio = await renderFn(doc, candidate.pattern);
      const features = extractAudioFeatures(audio, 44100);
      const audioScore = scoreAudioFit(features, target);
      results.push({
        candidateIndex: candidate.candidateIndex,
        features,
        audioScore,
      });
    } catch {
      // Skip candidates that fail to render — they just don't get an audio score
    }
  }
  return results;
}
