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
export { analyzeReference, type AnalyzeReferenceInput, type AnalyzeReferenceOutput } from "./analysis/analyzeReference";

export { decodeReferenceFile, ReferenceDecodeError, type DecodedReference } from "./audio/decode";
export { toMono } from "./audio/mono";

/**
 * F2 structure — energy curve + section map ("where is what"). Ported from
 * beat_modifier's analysis pipeline, with section edges snapped to the F1 beat
 * grid so an imported marker lands on a downbeat.
 */
export {
  averageEnergy,
  dominantRole,
  energyCurve,
  markerTypeForRole,
  sectionsFromEnergy,
  sectionsToMarkerSeconds,
  type StructureOptions,
} from "./structure";

/**
 * F2 §2.2 — descriptors: spectral balance, loudness, stereo width, groove
 * family and a plain-language summary. Ported from beat_modifier's analysis
 * pipeline; scipy's spectrogram/find_peaks are reimplemented over the repo's
 * own FFT rather than added as a dependency.
 */
export {
  grooveDescriptor,
  keyLabel,
  loudnessDescriptor,
  plainSummary,
  spectralDescriptor,
  stereoDescriptor,
  type GrooveFamily,
  type ReferenceGroove,
  type ReferenceLoudness,
  type ReferenceSpectral,
  type ReferenceStereo,
} from "./descriptors";

/**
 * Reference Map → project commands (F4-full). Pure `(doc, map) → Command`
 * functions so a panel can act on an analysis without owning any mutation
 * logic, and so the mapping is testable without React.
 */
export {
  bpmCommand,
  effectiveBpm,
  grooveCommand,
  keyCommand,
  markerCommand,
  musicalKeyFor,
  secondsToTicks,
  sectionMarkerCommand,
  type PhraseMarkerOptions,
  type SectionMarkerOptions,
  type TempoReading,
} from "./apply";

/**
 * Reference Match (reference-matching wave) — the measured "ako ďaleko som
 * od referencie" report: both sides through the same analyzers, the deltas in
 * the mix-doctor band vocabulary, the master match-EQ curve + loudness trim
 * an APPLY would land. Pure; the panel renders and applies, this measures.
 */
export {
  buildReferenceMatch,
  measureProjectMatch,
  referenceIntegratedLufs,
  rankMatchBandOwnership,
  attributeMatchToStrips,
  matchStripMoves,
  applyMatchCommand,
  MATCH_DEADZONE_DB,
  MATCH_LOUDNESS_MIN_LU,
  MATCH_MAX_DB,
  MATCH_OWNER_MIN_SHARE,
  MATCH_STRIP_GAIN_LIMIT_DB,
  type BandOwner,
  type MatchBandRow,
  type MatchLoudness,
  type MatchProjectInput,
  type MatchReferenceInput,
  type MatchStereo,
  type MatchStrip,
  type MatchStripMove,
  type ReferenceMatchReport,
} from "./match";

/**
 * Confidence wording lives in the engine so the thresholds cannot drift from
 * the number that produced them. F4 renders the label directly; a panel that
 * invents its own "High/Moderate/Low" cutoffs would silently disagree with
 * every other surface once the threshold moves.
 */
export { confidenceLabel, confidenceLevel, toPercent, type ConfidenceLevel } from "./analysis/confidence";
