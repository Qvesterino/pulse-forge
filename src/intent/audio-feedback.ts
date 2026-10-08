import {
  extractAudioFeaturesV2,
  extractAudioFeatures,
  extractStereoAudioFeatures,
  type AudioFeatures,
  type AudioFeaturesV2,
  type StereoAudioFeatures,
} from "../ai/audio-features";
import { GENERATED_AUDIO_TARGETS } from "./audio-targets.generated";
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

/** Hand-written fallback — exotic/out-of-union genres only. The 19 Genre
 * union members come from audio-targets.generated.ts (measured, W0.1). */
export const AUDIO_TARGETS: Record<string, GenreAudioTarget> = {
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
  // ── W0.1: informed values for all 19 Genre-union members ─────────────────
  // Values are derived from known BPM ranges, spectral characteristics and
  // production conventions per genre. When `npm run references:genres` runs
  // against a live server, GENERATED_AUDIO_TARGETS overrides these.
  dnb: {
    // 174 BPM breakbeats, Reese bass, moderate compression
    rmsRange: [0.06, 0.32],
    crestRange: [2, 10],
    zcrRange: [0.02, 0.18],
    bassRange: [0.2, 0.65],
  },
  drill: {
    // 142 BPM, sliding 808s, dark sparse beats
    rmsRange: [0.04, 0.28],
    crestRange: [3, 18],
    zcrRange: [0.005, 0.12],
    bassRange: [0.28, 0.75],
  },
  phonk: {
    // 150 BPM, lo-fi tape, cowbell melodies, heavy 808
    rmsRange: [0.05, 0.25],
    crestRange: [3, 15],
    zcrRange: [0.003, 0.08],
    bassRange: [0.3, 0.8],
  },
  jersey: {
    // 140 BPM club, dense compressed beats, bright
    rmsRange: [0.07, 0.35],
    crestRange: [1.5, 8],
    zcrRange: [0.015, 0.15],
    bassRange: [0.2, 0.65],
  },
  ukg: {
    // 133 BPM garage, shuffled hats, sub bass
    rmsRange: [0.05, 0.3],
    crestRange: [2.5, 12],
    zcrRange: [0.01, 0.14],
    bassRange: [0.2, 0.7],
  },
  amapiano: {
    // 112 BPM, log drum bass, spacious, airy hats
    rmsRange: [0.04, 0.28],
    crestRange: [3, 15],
    zcrRange: [0.008, 0.12],
    bassRange: [0.25, 0.7],
  },
  boombap: {
    // 90 BPM, punchy MPC drums, warm sample, moderate bass
    rmsRange: [0.05, 0.28],
    crestRange: [3, 15],
    zcrRange: [0.008, 0.12],
    bassRange: [0.15, 0.55],
  },
  chiptune: {
    // square/pulse waves, very bright, minimal sub bass
    rmsRange: [0.06, 0.3],
    crestRange: [4, 25],
    zcrRange: [0.08, 0.4],
    bassRange: [0.02, 0.3],
  },
  detroit: {
    // techno variant: driving kick, dark pads, high bass energy
    rmsRange: [0.08, 0.35],
    crestRange: [1.5, 8],
    zcrRange: [0.005, 0.1],
    bassRange: [0.28, 0.72],
  },
  drone: {
    // very slow evolving textures, minimal transients
    rmsRange: [0.005, 0.08],
    crestRange: [5, 40],
    zcrRange: [0.002, 0.06],
    bassRange: [0.1, 0.55],
  },
  eurodance: {
    // 140 BPM compressed dance pop, bright, driving
    rmsRange: [0.08, 0.35],
    crestRange: [1.5, 6],
    zcrRange: [0.015, 0.15],
    bassRange: [0.15, 0.55],
  },
  hyperpop: {
    // heavily compressed, glitchy, very bright, extreme dynamics crushed
    rmsRange: [0.1, 0.4],
    crestRange: [1, 5],
    zcrRange: [0.03, 0.3],
    bassRange: [0.1, 0.5],
  },
  latin: {
    // ~100 BPM, percussion-rich, warm bass, moderate brightness
    rmsRange: [0.05, 0.3],
    crestRange: [2, 14],
    zcrRange: [0.01, 0.14],
    bassRange: [0.15, 0.6],
  },
  postrock: {
    // quiet-loud crescendo, wide dynamics, moderate brightness
    rmsRange: [0.01, 0.2],
    crestRange: [4, 35],
    zcrRange: [0.005, 0.1],
    bassRange: [0.08, 0.5],
  },
  trance: {
    // 138 BPM, supersaw, compressed dance, moderate bass, bright
    rmsRange: [0.08, 0.35],
    crestRange: [1.5, 6],
    zcrRange: [0.015, 0.15],
    bassRange: [0.15, 0.55],
  },
};

/** How much the audio features influence the final ranking (0 = off, 1 = audio only). */
export const AUDIO_FEEDBACK_WEIGHT = 0.3;

/** Score a candidate's audio features against the genre target. 0..1, higher = better fit. */
export function scoreAudioFit(features: AudioFeatures, target: GenreAudioTarget): number {
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

/** Get the audio target for a genre: the MEASURED per-genre table first
 * (generated from full reference renders — see audio-targets.generated.ts),
 * then the hand-written table, then house. All 19 Genre-union members are
 * in the generated table, so the house fallback only fires for out-of-union
 * strings. */
export function audioTargetFor(genre: string): GenreAudioTarget {
  return GENERATED_AUDIO_TARGETS[genre] ?? AUDIO_TARGETS[genre] ?? AUDIO_TARGETS.house;
}

// ── Candidate audio scoring ────────────────────────────────────────────────

export interface CandidateAudioScore {
  candidateIndex: number;
  features: AudioFeaturesV2;
  stereoFeatures?: StereoAudioFeatures;
  audioScore: number;
}

export type RenderCandidateAudio = Float32Array | AudioBuffer;

export type RenderCandidateFn = (
  doc: ProjectDocument,
  bank: SampleBank,
  patternPattern: Pattern,
) => Promise<RenderCandidateAudio>;

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
  renderFn: (doc: ProjectDocument, pattern: Pattern) => Promise<RenderCandidateAudio>,
): Promise<CandidateAudioScore[]> {
  const target = audioTargetFor(genre);
  const results: CandidateAudioScore[] = [];

  // Render in PARALLEL: every render runs in its own OfflineAudioContext
  // (independent threads in the browser), so the audio-fit stage costs the
  // slowest render instead of the sum. Feature extraction + scoring stay on
  // the main thread after each render settles. Order is preserved — the
  // caller maps scores back by candidateIndex.
  const settled = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const audio = await renderFn(doc, candidate.pattern);
        let mono: Float32Array;
        let stereoFeatures: StereoAudioFeatures | undefined;
        let sampleRate = 44_100;
        if (audio instanceof Float32Array) {
          mono = audio;
        } else {
          const channels = Array.from({ length: Math.max(0, audio.numberOfChannels) }, (_, channel) =>
            audio.getChannelData(channel),
          );
          sampleRate = Number.isFinite(audio.sampleRate) && audio.sampleRate > 0 ? audio.sampleRate : 44_100;
          mono = new Float32Array(Math.max(0, audio.length));
          for (let frame = 0; frame < mono.length; frame++) {
            let sum = 0;
            let count = 0;
            for (const channel of channels) {
              const value = channel[frame];
              if (value === undefined || !Number.isFinite(value)) continue;
              sum += value;
              count++;
            }
            mono[frame] = count > 0 ? sum / count : 0;
          }
          const left = channels[0];
          const right = channels[1];
          if (left && right) stereoFeatures = extractStereoAudioFeatures(left, right);
        }
        const advancedFeatures = extractAudioFeaturesV2(mono, sampleRate);
        // Preserve the original global genre-fit behavior, which measured the
        // mono finalist stream at 44.1 kHz, while using the actual render rate
        // for the new spectral and periodicity summaries.
        const features: AudioFeaturesV2 = { ...advancedFeatures, ...extractAudioFeatures(mono, 44_100) };
        const audioScore = scoreAudioFit(features, target);
        return {
          candidateIndex: candidate.candidateIndex,
          features,
          ...(stereoFeatures ? { stereoFeatures } : {}),
          audioScore,
        };
      } catch {
        // Skip candidates that fail to render — they just don't get an audio score
        return null;
      }
    }),
  );
  for (const result of settled) {
    if (result) results.push(result);
  }
  return results;
}
