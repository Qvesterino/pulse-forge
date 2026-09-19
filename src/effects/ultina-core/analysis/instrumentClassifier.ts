/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ultina. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden vectors
 * (tests/ultina-vectors.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ultina.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ultina — Instrument Classifier (v1)
//
// Classifies the input signal into one of 8 instrument types
// using deterministic scoring rules. No ML model.
//
// Classification signals:
//   - Pitch range (from autocorrelation)
//   - Spectral profile (octave-band energy distribution)
//   - Transient density (onset rate)
//   - Stereo width (M/S ratio)
//   - Crest factor / dynamic range
//   - Voiced ratio (vocal vs non-vocal)
//
// Each instrument type has a set of feature "fingerprints".
// The classifier computes a similarity score for each type
// and returns the best match with confidence.
// ═══════════════════════════════════════════════════════════

import { INSTRUMENT_LABELS, type UltinaFeatures, type ClassificationResult, type InstrumentType } from "./assistant.js";

// ── Instrument feature fingerprints ──────────────────────────
//
// Each fingerprint describes the "typical" feature profile for
// that instrument type. The classifier compares extracted
// features against each fingerprint and computes a score.

interface InstrumentFingerprint {
  /** Pitch range where this instrument lives, null if N/A */
  pitchRange: { low: number; high: number } | null;
  /** Expected octave-band energy ratios (10 bands) */
  spectralProfile: number[];
  /** Expected transient density (onsets/sec) */
  transientDensity: number;
  /** Expected voiced ratio (0–1) */
  voicedRatio: number;
  /** Expected stereo width in dB */
  stereoWidthDb: number;
  /** Expected crest factor in dB */
  crestFactorDb: number;
}

// Reference spectral profiles (10 octave bands: 31, 63, 125, 250, 500, 1k, 2k, 4k, 8k, 16k)
// These are approximate normalized energy distributions.
const FINGERPRINTS: Record<InstrumentType, InstrumentFingerprint> = {
  vocalMale: {
    pitchRange: { low: 80, high: 180 },
    spectralProfile: [0.02, 0.04, 0.1, 0.15, 0.18, 0.17, 0.14, 0.1, 0.07, 0.03],
    transientDensity: 1.5,
    voicedRatio: 0.6,
    stereoWidthDb: -12,
    crestFactorDb: 12,
  },
  vocalFemale: {
    pitchRange: { low: 160, high: 350 },
    spectralProfile: [0.01, 0.02, 0.05, 0.1, 0.15, 0.18, 0.17, 0.15, 0.12, 0.05],
    transientDensity: 1.5,
    voicedRatio: 0.6,
    stereoWidthDb: -12,
    crestFactorDb: 12,
  },
  bass: {
    pitchRange: { low: 40, high: 120 },
    spectralProfile: [0.15, 0.25, 0.25, 0.15, 0.08, 0.05, 0.03, 0.02, 0.01, 0.01],
    transientDensity: 2.0,
    voicedRatio: 0.2,
    stereoWidthDb: -25,
    crestFactorDb: 10,
  },
  guitar: {
    pitchRange: { low: 80, high: 350 },
    spectralProfile: [0.05, 0.08, 0.12, 0.15, 0.15, 0.15, 0.12, 0.08, 0.06, 0.04],
    transientDensity: 2.5,
    voicedRatio: 0.15,
    stereoWidthDb: -10,
    crestFactorDb: 14,
  },
  keys: {
    pitchRange: { low: 100, high: 1200 },
    spectralProfile: [0.05, 0.07, 0.1, 0.12, 0.13, 0.13, 0.12, 0.1, 0.1, 0.08],
    transientDensity: 1.0,
    voicedRatio: 0.1,
    stereoWidthDb: -6,
    crestFactorDb: 13,
  },
  drums: {
    pitchRange: null,
    spectralProfile: [0.12, 0.15, 0.12, 0.1, 0.08, 0.08, 0.08, 0.1, 0.1, 0.07],
    transientDensity: 5.0,
    voicedRatio: 0.05,
    stereoWidthDb: -8,
    crestFactorDb: 18,
  },
  bus: {
    pitchRange: null,
    spectralProfile: [0.06, 0.08, 0.1, 0.11, 0.12, 0.13, 0.13, 0.11, 0.09, 0.07],
    transientDensity: 2.0,
    voicedRatio: 0.1,
    stereoWidthDb: -3,
    crestFactorDb: 11,
  },
  master: {
    pitchRange: null,
    spectralProfile: [0.05, 0.07, 0.09, 0.11, 0.12, 0.13, 0.13, 0.12, 0.1, 0.08],
    transientDensity: 2.0,
    voicedRatio: 0.1,
    stereoWidthDb: -2,
    crestFactorDb: 8,
  },
};

// ── Scoring helpers ──────────────────────────────────────────

function spectralDistance(observed: number[], reference: number[]): number {
  if (observed.length !== reference.length || observed.length === 0) {
    return 1.0;
  }
  let sumSq = 0;
  for (let i = 0; i < observed.length; i++) {
    const diff = observed[i] - reference[i];
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq / observed.length);
}

function gaussianScore(value: number, center: number, sigma: number): number {
  if (sigma <= 0) return value === center ? 1 : 0;
  const diff = (value - center) / sigma;
  return Math.exp(-0.5 * diff * diff);
}

function pitchInRange(features: UltinaFeatures, range: { low: number; high: number } | null): number {
  if (!range) return 0.7; // neutral — pitch not applicable
  if (!features.fundamentalRange) return 0.3; // no pitch detected
  const f0 = (features.fundamentalRange.low + features.fundamentalRange.high) / 2;
  if (f0 >= range.low && f0 <= range.high) return 1.0;
  if (f0 >= range.low * 0.8 && f0 <= range.high * 1.2) return 0.7;
  return 0.1;
}

// ── Main classifier ──────────────────────────────────────────

export function classifyInstrument(features: UltinaFeatures): ClassificationResult {
  const scores: Partial<Record<InstrumentType, number>> = {};

  // Extract observed spectral profile ratios
  const observedProfile =
    features.spectralProfile.length === 10
      ? features.spectralProfile.map((b) => b.ratio)
      : [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];

  for (const instrument of Object.keys(FINGERPRINTS) as InstrumentType[]) {
    const fp = FINGERPRINTS[instrument];

    // Spectral similarity (weight: 40%)
    const specDist = spectralDistance(observedProfile, fp.spectralProfile);
    const specScore = Math.max(0, 1 - specDist * 3);

    // Pitch match (weight: 15%)
    const pitchScore = pitchInRange(features, fp.pitchRange);

    // Transient density (weight: 15%)
    const transientScore = gaussianScore(features.transientDensity, fp.transientDensity, 3.0);

    // Voiced ratio (weight: 15%)
    const voicedScore = gaussianScore(features.voicedRatio, fp.voicedRatio, 0.3);

    // Stereo width (weight: 10%)
    const stereoScore = gaussianScore(features.stereoWidthDb, fp.stereoWidthDb, 8.0);

    // Crest factor (weight: 5%)
    const crestScore = gaussianScore(features.crestFactorDb, fp.crestFactorDb, 5.0);

    const total =
      specScore * 0.4 +
      pitchScore * 0.15 +
      transientScore * 0.15 +
      voicedScore * 0.15 +
      stereoScore * 0.1 +
      crestScore * 0.05;

    scores[instrument] = Math.max(0, Math.min(1, total));
  }

  // Find best match
  let bestInstrument: InstrumentType = "vocalMale";
  let bestScore = 0;

  for (const [instrument, score] of Object.entries(scores)) {
    if ((score as number) > bestScore) {
      bestScore = score as number;
      bestInstrument = instrument as InstrumentType;
    }
  }

  // Build explanation
  const explanation = buildExplanation(bestInstrument, bestScore, features);

  return {
    instrument: bestInstrument,
    confidence: bestScore,
    scores,
    explanation,
  };
}

function buildExplanation(instrument: InstrumentType, confidence: number, features: UltinaFeatures): string {
  const confLabel = confidence > 0.7 ? "High confidence" : confidence > 0.5 ? "Moderate confidence" : "Low confidence";

  const details: string[] = [];

  if (features.fundamentalRange) {
    const f0 = Math.round((features.fundamentalRange.low + features.fundamentalRange.high) / 2);
    details.push(`fundamental at ${f0} Hz`);
  }
  if (features.transientDensity > 3) {
    details.push(`high transient activity (${features.transientDensity.toFixed(1)}/s)`);
  } else if (features.transientDensity < 1) {
    details.push(`low transient activity`);
  }
  if (features.stereoWidthDb > -5) {
    details.push(`wide stereo image`);
  } else if (features.stereoWidthDb < -20) {
    details.push(`narrow/mono image`);
  }
  if (features.voicedRatio > 0.4) {
    details.push(`sustained tonal content`);
  }

  const detailStr = details.length > 0 ? ` (${details.join(", ")})` : "";

  return `${confLabel}: detected as ${INSTRUMENT_LABELS[instrument]}${detailStr}.`;
}
