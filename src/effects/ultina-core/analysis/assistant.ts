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
// Ultina — Mix Assistant Contracts (v1)
//
// The Mix Assistant is an analyzer and proposal generator — not
// an opaque processor and not an audio-thread feature. It listens
// to a representative selection, classifies the instrument, detects
// problems, proposes a module chain with settings + reason codes,
// and waits for the user to press Apply.
//
// Architecture:
//   Audio → FeatureExtractor → InstrumentClassifier
//        → ProblemDetector → ProposalGenerator → User Review
//
// Rules:
//   1. Analysis never mutates live parameters.
//   2. Proposals are structured data with machine-testable
//      reason codes, not just natural language.
//   3. Apply creates one undoable state transaction.
//   4. Reject leaves the processor bit-for-bit unchanged.
//   5. First release uses deterministic signal features and
//      rules. No ML model.
// ═══════════════════════════════════════════════════════════

// ── Instrument types ─────────────────────────────────────────

export const INSTRUMENT_TYPES = [
  "vocalMale",
  "vocalFemale",
  "bass",
  "guitar",
  "keys",
  "drums",
  "bus",
  "master",
] as const;
export type InstrumentType = typeof INSTRUMENT_TYPES[number];

export const INSTRUMENT_LABELS: Record<InstrumentType, string> = {
  vocalMale: "Vocal (Male)",
  vocalFemale: "Vocal (Female)",
  bass: "Bass",
  guitar: "Guitar",
  keys: "Keys / Piano",
  drums: "Drums",
  bus: "Bus / Group",
  master: "Master",
};

// ── Character / Intensity ────────────────────────────────────

export const ASSISTANT_CHARACTERS = [
  "clean", "warm", "forward", "punchy", "wide", "aggressive",
] as const;
export type AssistantCharacter = typeof ASSISTANT_CHARACTERS[number];

export const ASSISTANT_INTENSITIES = ["subtle", "balanced", "strong"] as const;
export type AssistantIntensity = typeof ASSISTANT_INTENSITIES[number];

// ── Reason codes ─────────────────────────────────────────────

export const REASON_CODES = [
  // Level / dynamics
  "LOW_FREQUENCY_RUMBLE",
  "SUB_BASS_BUILDUP",
  "EXCESSIVE_DYNAMIC_RANGE",
  "INSUFFICIENT_LEVEL",
  "UNEVEN_LEVEL",
  "CLIPPING_DETECTED",
  "NOISE_FLOOR_DETECTED",
  "BREATH_NOISE",

  // Spectral
  "MUD_FREQUENCY_BUILDUP",
  "BOXINESS",
  "NASAL_RESONANCE",
  "HARSH_FREQUENCY",
  "HIGH_SIBILANCE",
  "LACK_OF_PRESENCE",
  "LACK_OF_AIR",
  "DULL_SPECTRUM",
  "BRIGHT_SPECTRUM",

  // Stereo / phase
  "NARROW_STEREO",
  "WIDE_STEREO_INSTABILITY",
  "PHASE_ISSUES",

  // Transient
  "LACK_OF_PUNCH",
  "EXCESSIVE_TRANSIENT",

  // Character
  "NEEDS_WARMTH",
  "NEEDS_BRIGHTNESS",
  "NEEDS_DENSITY",

  // Instrument-specific
  "INSTRUMENT_PROFILE_MISMATCH",

  // Generic
  "SUGGESTED_STARTING_POINT",
] as const;
export type ReasonCode = typeof REASON_CODES[number];

// ── Feature extraction results ───────────────────────────────

export interface SpectralBand {
  /** Lower frequency bound (Hz) */
  freqLow: number;
  /** Upper frequency bound (Hz) */
  freqHigh: number;
  /** Energy in this band relative to total (0–1) */
  ratio: number;
}

export interface UltinaFeatures {
  // ── Level / dynamics ──
  /** Sample peak level (linear) */
  peakLevel: number;
  /** Number of detected clips (samples at 0 dBFS) */
  clipCount: number;
  /** RMS level (linear) */
  rmsLevel: number;
  /** Short-term loudness estimate (LUFS) */
  shortTermLoudness: number;
  /** Integrated loudness estimate (K-weighted, LUFS) */
  lufsIntegrated: number;
  /** Crest factor (peak/RMS ratio in dB) */
  crestFactorDb: number;
  /** Phrase dynamic range (loudest to quietest, dB) */
  dynamicRangeDb: number;
  /** Noise floor estimate (dBFS) */
  noiseFloorDb: number;

  // ── Spectral ──
  /** Low-frequency rumble level (below 80 Hz, dBFS) */
  rumbleLevelDb: number;
  /** Sub-bass energy ratio (20–60 Hz) */
  subBassRatio: number;
  /** Low-mid energy ratio (60–250 Hz) */
  lowMidRatio: number;
  /** Mid energy ratio (250 Hz–2 kHz) */
  midRatio: number;
  /** High-mid energy ratio (2–6 kHz) */
  highMidRatio: number;
  /** High energy ratio (6–20 kHz) */
  highRatio: number;
  /** Sibilant-band/full-band energy ratio (4–10 kHz) */
  sibilanceRatio: number;
  /** Spectral tilt (positive = bright, negative = dark) */
  spectralTilt: number;
  /** Harshness indicator (3–5 kHz energy concentration) */
  harshnessIndicator: number;
  /** Octave-band spectral profile (10 bands: 31, 63, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz) */
  spectralProfile: SpectralBand[];

  // ── Pitch ──
  /** Voiced/unvoiced ratio */
  voicedRatio: number;
  /** Approximate fundamental frequency range (Hz), null if unreliable */
  fundamentalRange: { low: number; high: number } | null;

  // ── Stereo ──
  /** Stereo width (M/S ratio in dB, positive = wide) */
  stereoWidthDb: number;
  /** Stereo correlation (–1 to +1) */
  correlation: number;

  // ── Transient ──
  /** Onset density (onsets per second) */
  transientDensity: number;
  /** Spectral flux average (transient activity indicator) */
  spectralFlux: number;

  // ── Meta ──
  /** Duration of analyzed material (seconds) */
  analyzedDuration: number;
  /** Whether the analysis is valid (sufficient content) */
  valid: boolean;
  /** Diagnostic message if analysis is not valid */
  invalidReason: string | null;
}

// ── Classification result ────────────────────────────────────

export interface ClassificationResult {
  /** Detected instrument type */
  instrument: InstrumentType;
  /** Confidence score (0–1) */
  confidence: number;
  /** Scores for all instrument types */
  scores: Partial<Record<InstrumentType, number>>;
  /** Explanation of classification */
  explanation: string;
}

// ── Proposal ─────────────────────────────────────────────────

export interface ParameterProposal {
  /** Stable parameter ID */
  parameterId: string;
  /** Proposed value in plain units */
  value: number;
  /** Confidence score (0–1) */
  confidence: number;
  /** Machine-testable reason code */
  reasonCode: ReasonCode;
  /** Human-readable explanation (localizable) */
  explanation: string;
}

export interface ModuleToggleProposal {
  /** Module type to enable/disable */
  moduleType: string;
  /** Whether the module should be enabled */
  enabled: boolean;
  /** Confidence score (0–1) */
  confidence: number;
  /** Machine-testable reason code */
  reasonCode: ReasonCode;
  /** Human-readable explanation */
  explanation: string;
}

export interface UltinaProposal {
  /** Analysis schema version */
  analysisVersion: number;
  /** Detected instrument type */
  instrument: InstrumentType;
  /** Character used for analysis */
  character: AssistantCharacter;
  /** Intensity used for analysis */
  intensity: AssistantIntensity;
  /** Timestamp of analysis */
  analyzedAt: number;
  /** Duration of analyzed material (seconds) */
  analyzedDuration: number;
  /** Extracted features */
  features: UltinaFeatures;
  /** Classification result */
  classification: ClassificationResult;
  /** Proposed module enable/disable changes */
  moduleToggles: ModuleToggleProposal[];
  /** Proposed parameter changes */
  changes: ParameterProposal[];
  /** Whether this proposal has been applied */
  applied: boolean;
}

// ── Analysis request ─────────────────────────────────────────

export interface AnalysisRequest {
  /** Audio data to analyze (per channel) */
  channels: Float32Array[];
  /** Sample rate of the audio data */
  sampleRate: number;
  /** Explicit instrument override (skip classification) */
  instrumentOverride?: InstrumentType;
  /** Character target */
  character?: AssistantCharacter;
  /** Intensity of processing */
  intensity?: AssistantIntensity;
  /** Minimum duration required (seconds), default 2 */
  minimumDuration?: number;
}

// ── Analysis result ──────────────────────────────────────────

export type AnalysisResult =
  | { kind: "success"; proposal: UltinaProposal }
  | { kind: "insufficient"; reason: string; features: UltinaFeatures }
  | { kind: "error"; message: string };

// ── Tonal Balance ────────────────────────────────────────────

export interface TonalBalanceReading {
  /** Timestamp */
  timestamp: number;
  /** Current spectral profile (10 octave bands, dB) */
  current: number[];
  /** Target spectral profile (10 octave bands, dB), null if none */
  target: number[] | null;
  /** Deviation per band (current – target, dB), null if no target */
  deviation: number[] | null;
  /** Overall balance score (0 = perfect, higher = worse) */
  rmsDeviation: number;
  /** Suggested EQ adjustments per band (dB), null if no target */
  suggestions: number[] | null;
}

// ── Target Library ───────────────────────────────────────────

export interface TargetCurve {
  /** Unique ID */
  id: string;
  /** Display name */
  name: string;
  /** Category */
  category: "vocal" | "instrument" | "bus" | "master" | "custom";
  /** 10 octave-band target values in dB (31 Hz – 16 kHz) */
  curve: number[];
  /** Description */
  description: string;
}

// ── Empty / default helpers ──────────────────────────────────

export function createEmptyFeatures(): UltinaFeatures {
  return {
    peakLevel: 0,
    clipCount: 0,
    rmsLevel: 0,
    shortTermLoudness: -70,
    lufsIntegrated: -70,
    crestFactorDb: 0,
    dynamicRangeDb: 0,
    noiseFloorDb: -96,
    rumbleLevelDb: -96,
    subBassRatio: 0,
    lowMidRatio: 0,
    midRatio: 0,
    highMidRatio: 0,
    highRatio: 0,
    sibilanceRatio: 0,
    spectralTilt: 0,
    harshnessIndicator: 0,
    spectralProfile: [],
    voicedRatio: 0,
    fundamentalRange: null,
    stereoWidthDb: 0,
    correlation: 1,
    transientDensity: 0,
    spectralFlux: 0,
    analyzedDuration: 0,
    valid: false,
    invalidReason: "No analysis performed",
  };
}

export function createEmptyProposal(): UltinaProposal {
  return {
    analysisVersion: 1,
    instrument: "vocalMale",
    character: "clean",
    intensity: "balanced",
    analyzedAt: 0,
    analyzedDuration: 0,
    features: createEmptyFeatures(),
    classification: {
      instrument: "vocalMale",
      confidence: 0,
      scores: {},
      explanation: "No analysis performed",
    },
    moduleToggles: [],
    changes: [],
    applied: false,
  };
}
