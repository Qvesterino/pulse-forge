/**
 * Reference Map — F1 core types.
 *
 * Deterministic browser-native reference analysis (BPM + beat grid + key).
 * Ported from the audiokey-analyzer type contract
 * (`src/types/analysis.ts`, engine 1.0.0) into KYX naming; semantics kept 1:1
 * so fixture expectations stay comparable across both codebases.
 *
 * Rhythm and tonal results are independently nullable: one side may succeed
 * while the other reports "could not be determined".
 */

export const REFERENCE_ENGINE_VERSION = "kyx-reference/1.0.0";

/** Schema version of the persisted ReferenceMap shape. Bump + migrate on change. */
export const REFERENCE_SCHEMA_VERSION = 1;

export const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export type PitchClass = (typeof PITCH_CLASSES)[number];

export type ReferenceMode = "major" | "minor";

export interface ReferenceAudioMetadata {
  name: string;
  size: number;
  duration: number;
  sampleRate: number;
  channels: number;
}

export interface TempoCandidate {
  bpm: number;
  score: number;
  relation: "primary" | "half-time" | "double-time" | "alternative";
}

export type TempoStability = "stable" | "mostly-stable" | "variable" | "unknown";

export interface ReferenceRhythm {
  bpm: number | null;
  /** 0..1 deterministic confidence (peak dominance + strength + grid alignment + stability). */
  confidence: number;
  beatIntervalSeconds: number | null;
  beatOffsetSeconds: number | null;
  /** Detected beat positions in seconds (phase-aligned grid, not downbeats). */
  beatTimes: number[];
  candidates: TempoCandidate[];
  stability: TempoStability;
  localBpms: number[];
  warning: string | null;
}

export interface ReferenceKeyCandidate {
  tonic: PitchClass;
  mode: ReferenceMode;
  score: number;
  confidence: number;
}

export interface ReferenceTonal {
  tonic: PitchClass | null;
  mode: ReferenceMode | null;
  camelot: string | null;
  /** 0..1 deterministic confidence (absolute + separation + tonality + peakiness). */
  confidence: number;
  /** Aggregate 12-bin pitch-class energy, C..B, normalized to sum 1. */
  chroma: number[];
  candidates: ReferenceKeyCandidate[];
  warning: string | null;
}

export interface ReferenceDiagnostics {
  engineVersion: string;
  schemaVersion: number;
  analysisSampleRate: number;
  fftSize: number;
  hopSize: number;
  frameCount: number;
  onsetEnvelopeLength: number;
  tempoRange: [number, number];
  tonalRegion: "full" | "middle";
  tonalFrameCount: number;
  analyzedSeconds: number;
  processingMs: number;
  peakAmplitude: number;
  rmsLevel: number;
}

export interface ReferenceMap {
  metadata: ReferenceAudioMetadata;
  rhythm: ReferenceRhythm;
  tonal: ReferenceTonal;
  diagnostics: ReferenceDiagnostics;
  warnings: string[];
}

export interface ReferenceOptions {
  tempoMin: number;
  tempoMax: number;
  analysisSampleRate: number;
  keyRegion: "full" | "middle";
  fftSize: number;
  hopSize: number;
}

export const DEFAULT_REFERENCE_OPTIONS: ReferenceOptions = {
  tempoMin: 50,
  tempoMax: 220,
  analysisSampleRate: 22050,
  keyRegion: "middle",
  fftSize: 2048,
  hopSize: 512,
};

export type ReferenceStage = "decoding" | "buffer" | "transients" | "tempo" | "chroma" | "key" | "finalizing" | "done";

export const REFERENCE_STAGE_LABELS: Record<ReferenceStage, string> = {
  decoding: "Decoding audio",
  buffer: "Preparing analysis buffer",
  transients: "Analyzing transients",
  tempo: "Estimating tempo",
  chroma: "Analyzing pitch classes",
  key: "Estimating key",
  finalizing: "Finalizing results",
  done: "Complete",
};

export const REFERENCE_STAGE_ORDER: ReferenceStage[] = [
  "decoding",
  "buffer",
  "transients",
  "tempo",
  "chroma",
  "key",
  "finalizing",
  "done",
];
