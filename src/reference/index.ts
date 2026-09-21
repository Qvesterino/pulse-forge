/**
 * Reference Map — F1 public API.
 *
 * Browser-native deterministic audio analysis (BPM + beat grid + key +
 * Camelot + confidence + candidates). All heavy DSP runs in a Web Worker
 * with a transparent main-thread fallback. Same input → same output
 * everywhere — no RNG, no time, no network.
 *
 * Public surface (callers should import from this barrel):
 *   analyzeReferenceAsync — entry point (worker + fallback + AbortSignal)
 *   analyzeReference     — pure main-thread entry (no worker)
 *   decodeReferenceFile   — File → mono PCM at original sample rate
 *   PITCH_CLASSES, DEFAULT_REFERENCE_OPTIONS, REFERENCE_ENGINE_VERSION,
 *   REFERENCE_STAGE_LABELS, REFERENCE_STAGE_ORDER
 *   ReferenceMap / ReferenceRhythm / ReferenceTonal / ReferenceKeyCandidate /
 *   TempoCandidate / ReferenceStage / ReferenceMode / PitchClass
 *
 * Lower-level DSP is intentionally not re-exported — callers that need
 * the building blocks can import them from src/reference/dsp/*.
 */

export {
  REFERENCE_ENGINE_VERSION,
  REFERENCE_SCHEMA_VERSION,
  PITCH_CLASSES,
  REFERENCE_STAGE_LABELS,
  REFERENCE_STAGE_ORDER,
  DEFAULT_REFERENCE_OPTIONS,
} from "./types";
export type {
  PitchClass,
  ReferenceMode,
  ReferenceAudioMetadata,
  ReferenceDiagnostics,
  ReferenceKeyCandidate,
  ReferenceMap,
  ReferenceOptions,
  ReferenceRhythm,
  ReferenceStage,
  ReferenceTonal,
  TempoCandidate,
  TempoStability,
} from "./types";

export { analyzeReferenceAsync } from "./reference-client";
export {
  analyzeReference,
  type AnalyzeReferenceInput,
  type AnalyzeReferenceOutput,
} from "./analysis/analyzeReference";

export { decodeReferenceFile, ReferenceDecodeError } from "./audio/decode";
