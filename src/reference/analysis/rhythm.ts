import { computeOnsetEnvelopes, type OnsetEnvelopes } from "../dsp/spectralFlux";
import {
  type ReferenceRhythm,
  type TempoCandidate,
  type TempoStability,
} from "../types";
import { estimateBeatGrid } from "./beatGrid";
import { clamp01 } from "./confidence";
import { estimateTempoCandidates, refineTempo, tempoPrior } from "./tempoCandidates";

export interface RhythmAnalysisInput {
  signal: Float32Array;
  sampleRate: number;
  fftSize: number;
  hopSize: number;
  tempoMin: number;
  tempoMax: number;
  durationSeconds: number;
}

export interface RhythmAnalysisOutput extends ReferenceRhythm {
  /** Internal onset envelopes (flux, low-band, high-band, combined) — kept for downstream tonal analysis. */
  envelopes: OnsetEnvelopes;
}

const PRIOR_TIE_WEIGHT = 0.12;

function pickTempoFamily(
  primaryBpm: number,
  score: number,
  envelope: Float32Array,
  frameRate: number,
  tempoMin: number,
  tempoMax: number,
): { bpm: number; score: number } {
  // Evaluate the tempo family T/2, T, T*2 using the onset envelope, with an
  // explicit (small) preference for musically common ranges.
  const options = [primaryBpm / 2, primaryBpm, primaryBpm * 2].filter(
    (b) => b >= tempoMin && b <= tempoMax,
  );
  if (options.length <= 1) return { bpm: primaryBpm, score };

  const scored = options.map((bpm) => {
    const grid = estimateBeatGrid(envelope, frameRate, bpm, envelope.length / frameRate);
    const raw = grid.alignment;
    return { bpm, raw, total: raw * (1 - PRIOR_TIE_WEIGHT) + PRIOR_TIE_WEIGHT * tempoPrior(bpm) };
  });
  scored.sort((a, b) => b.total - a.total || a.bpm - b.bpm);
  const best = scored[0];
  return { bpm: best.bpm, score: best.bpm === primaryBpm ? score : score * 0.98 };
}

function localTempi(
  envelope: Float32Array,
  frameRate: number,
  tempoMin: number,
  tempoMax: number,
): number[] {
  const windows = 4;
  const size = Math.floor(envelope.length / windows);
  if (size < frameRate * 6) return [];
  const out: number[] = [];
  for (let w = 0; w < windows; w++) {
    const slice = envelope.subarray(w * size, (w + 1) * size);
    const c = estimateTempoCandidates(slice, frameRate, tempoMin, tempoMax, 1);
    if (c.length > 0) out.push(Number(c[0].bpm.toFixed(2)));
  }
  return out;
}

function stabilityFrom(local: number[], primary: number): TempoStability {
  if (local.length < 3 || !primary) return "unknown";
  let agree = 0;
  for (const bpm of local) {
    const ratios = [bpm, bpm * 2, bpm / 2];
    if (ratios.some((r) => Math.abs(r - primary) / primary < 0.03)) agree++;
  }
  const frac = agree / local.length;
  if (frac >= 0.99) return "stable";
  if (frac >= 0.6) return "mostly-stable";
  return "variable";
}

/**
 * Rhythm analysis pipeline: spectral-flux envelopes → comb ACF tempo
 * candidates → T/2-T-2T family pick → ±3% refinement → beat grid →
 * 4-window local tempi → stability classification → weighted confidence
 * (dominance + strength + alignment + stability bonus).
 *
 * Returns a null BPM + warning when the envelope carries no usable
 * periodicity (silence, too-short buffers, or pure tonal content).
 *
 * Ported verbatim from audiokey-analyzer/src/analysis/rhythmAnalyzer.ts
 * (Apache-2.0 / project-owned, see docs/REFERENCE-MAP-ROADMAP.md §B).
 */
export function analyzeRhythm(input: RhythmAnalysisInput): RhythmAnalysisOutput {
  const { signal, sampleRate, fftSize, hopSize, tempoMin, tempoMax, durationSeconds } = input;
  const envelopes = computeOnsetEnvelopes(signal, sampleRate, fftSize, hopSize);
  const env = envelopes.combined;
  const frameRate = envelopes.frameRate;

  const empty: RhythmAnalysisOutput = {
    bpm: null,
    confidence: 0,
    beatIntervalSeconds: null,
    beatOffsetSeconds: null,
    beatTimes: [],
    candidates: [],
    stability: "unknown",
    localBpms: [],
    warning: "Tempo could not be determined: insufficient rhythmic information.",
    envelopes,
  };

  const raw = estimateTempoCandidates(env, frameRate, tempoMin, tempoMax, 6);
  if (raw.length === 0) return empty;

  const top = raw[0];
  const family = pickTempoFamily(top.bpm, top.score, env, frameRate, tempoMin, tempoMax);
  const primaryBpm = Number(refineTempo(env, frameRate, family.bpm).toFixed(2));

  const grid = estimateBeatGrid(env, frameRate, primaryBpm, durationSeconds);

  // Confidence: peak dominance + periodicity strength + grid alignment.
  const second = raw.find((c) => Math.abs(c.bpm - top.bpm) / top.bpm > 0.02);
  const dominance = second ? clamp01((top.score - second.score) / top.score) : 1;
  const strength = clamp01(top.score);
  const alignment = clamp01(grid.alignment);

  const local = localTempi(env, frameRate, tempoMin, tempoMax);
  const stability = stabilityFrom(local, primaryBpm);
  const stabilityBonus =
    stability === "stable" ? 1 : stability === "mostly-stable" ? 0.75 : stability === "variable" ? 0.4 : 0.5;

  const confidence = clamp01(
    0.35 * dominance + 0.25 * strength + 0.25 * alignment + 0.15 * stabilityBonus,
  );

  const candidates: TempoCandidate[] = [];
  candidates.push({ bpm: primaryBpm, score: Number(top.score.toFixed(4)), relation: "primary" });
  const half = primaryBpm / 2;
  const double = primaryBpm * 2;
  if (half >= tempoMin * 0.5 && half >= 30) {
    candidates.push({ bpm: Number(half.toFixed(2)), score: 0, relation: "half-time" });
  }
  if (double <= 400) {
    candidates.push({ bpm: Number(double.toFixed(2)), score: 0, relation: "double-time" });
  }
  for (const c of raw.slice(1, 4)) {
    const bpm = Number(c.bpm.toFixed(2));
    if (candidates.some((x) => Math.abs(x.bpm - bpm) / bpm < 0.02)) continue;
    candidates.push({ bpm, score: Number(c.score.toFixed(4)), relation: "alternative" });
  }

  let warning: string | null = null;
  if (confidence < 0.55) {
    const alts = candidates
      .filter((c) => c.relation !== "primary")
      .slice(0, 2)
      .map((c) => `${c.bpm.toFixed(2)} BPM`)
      .join(", ");
    warning = `Tempo uncertain.${alts ? ` Possible values: ${alts}.` : ""}`;
  }

  return {
    bpm: primaryBpm,
    confidence,
    beatIntervalSeconds: 60 / primaryBpm,
    beatOffsetSeconds: Number(grid.offsetSeconds.toFixed(4)),
    beatTimes: grid.beatTimes,
    candidates,
    stability,
    localBpms: local,
    warning,
    envelopes,
  };
}
