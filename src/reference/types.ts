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

/**
 * Schema version of the persisted ReferenceMap shape. Bump + migrate on change.
 *
 * v2 (F2): added the optional `structure` block (energy curve + sections).
 * v3 (F2 §2.2): added the optional `descriptors` block (spectral, loudness,
 * stereo, groove family, plain summary). Both are optional and additive, so an
 * older document still loads — it simply has nothing to show for that part,
 * which is reported as absent rather than faked.
 */
export const REFERENCE_SCHEMA_VERSION = 3;

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

/**
 * One section of the "where is what" map (F2).
 *
 * Positions are held in BOTH seconds and beats because the two consumers
 * differ: the waveform overlay and click-to-seek work in seconds, while
 * marker import works in project ticks and needs the beat anchor. Holding
 * only one forces the consumer to re-derive the other with a tempo it may not
 * have.
 */
export interface ReferenceSection {
  role: "intro" | "outro" | "drop" | "breakdown" | "development" | "full";
  /** Section start, snapped to the nearest detected beat. */
  startSec: number;
  endSec: number;
  /** Index into the F1 beat grid, or null when no tempo was detected. */
  startBeat: number | null;
  endBeat: number | null;
  /** Mean energy over the section, 0..1, relative to the loudest point. */
  energy: number;
  /** KYX Marker type this role maps to. */
  markerType: MarkerType;
}

/** Mirrors `Marker["type"]` without importing the project model into types.ts. */
export type MarkerType = "drop" | "buildup" | "riser" | "impact" | "cue" | "custom";

export interface ReferenceStructure {
  /** Normalized energy samples: position 0..1, energy 0..1. */
  energyCurve: Array<{ position: number; energy: number }>;
  sections: ReferenceSection[];
  /** Mean of the energy curve — the "how loud overall" headline. */
  averageEnergy: number;
}

export interface ReferenceSpectral {
  centroidHz: number;
  rolloffHz: number;
  flatness: number;
  lowEnergy: number;
  midEnergy: number;
  highEnergy: number;
  brightness: number;
}

export interface ReferenceLoudness {
  /** LUFS-ish integrated level — a descriptor of the file, never a target. */
  integratedLufs: number;
  peakDbfs: number;
  crestFactorDb: number;
  dynamicRangeDb: number;
  /** True when any sample reaches full scale. Reported, never corrected. */
  clipped: boolean;
}

export interface ReferenceStereo {
  width: number;
  sideEnergyRatio: number;
}

export type GrooveFamily = "four_on_the_floor" | "breakbeat" | "half_time" | "two_step";

export interface ReferenceGroove {
  family: GrooveFamily;
  drumDensity: number;
  syncopation: number;
}

export interface ReferenceDescriptors {
  spectral: ReferenceSpectral;
  loudness: ReferenceLoudness;
  stereo: ReferenceStereo;
  groove: ReferenceGroove;
  /** One plain-language sentence; the F5 Inspiration builder's input. */
  summary: string;
}

export interface ReferenceMap {
  metadata: ReferenceAudioMetadata;
  rhythm: ReferenceRhythm;
  tonal: ReferenceTonal;
  /** F2 — absent only when the signal was too short to segment. */
  structure?: ReferenceStructure;
  /** F2 §2.2 — present whenever the signal was long enough to describe. */
  descriptors?: ReferenceDescriptors;
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

export type ReferenceStage =
  | "decoding"
  | "buffer"
  | "transients"
  | "tempo"
  | "chroma"
  | "key"
  | "structure"
  | "descriptors"
  | "finalizing"
  | "done";

export const REFERENCE_STAGE_LABELS: Record<ReferenceStage, string> = {
  decoding: "Decoding audio",
  buffer: "Preparing analysis buffer",
  transients: "Analyzing transients",
  tempo: "Estimating tempo",
  chroma: "Analyzing pitch classes",
  key: "Estimating key",
  structure: "Mapping song structure",
  descriptors: "Measuring spectrum and loudness",
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
  "structure",
  "descriptors",
  "finalizing",
  "done",
];
