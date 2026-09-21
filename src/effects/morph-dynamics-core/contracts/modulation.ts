/**
 * MORPH DYNAMICS — Modulation Matrix contracts
 *
 * The matrix is the central reactive subsystem: normalized control sources
 * (derived from the incoming audio's behavior) drive safe, bounded
 * destinations in the audible engine. A route is
 *
 *   delta = (amount/100) * source(0..1) * span     [clamped to dest bounds]
 *   effective = clamp(baseParam + delta, destMin, destMax)
 *
 * The signed `span` per destination encodes musical intent: positive
 * routing always means "more of the musical behavior" (e.g. routing
 * Transient into Threshold with a positive amount DUCKS the threshold so
 * loud events compress harder). Destination bounds are hard-coded here —
 * modulation must never push a parameter into an unstable region
 * (DSP_ARCHITECTURE.md §8 "Modulation Safety").
 */

// ── Sources ─────────────────────────────────────────────────

export const MOD_SOURCES = [
  "Input Energy",
  "Gain Reduction",
  "Transient",
  "Body",
  "Texture",
  "Density",
  "Pressure",
  // Experiment #3 (Phase III): the curved, enveloped spatial control
  // signal (body score → bloom curve → attack/release). Append-only,
  // index 7 — routes serialize sources by index.
  "Bloom",
] as const;

export type ModSource = (typeof MOD_SOURCES)[number];

/** Stable enum indices (serialized in routes.N.source). */
export const SOURCE_INDEX = {
  inputEnergy: 0,
  gainReduction: 1,
  transient: 2,
  body: 3,
  texture: 4,
  density: 5,
  pressure: 6,
  bloom: 7,
} as const;

// ── Destinations ────────────────────────────────────────────

export interface ModDestination {
  /** UI label. */
  label: string;
  /** Internal key the processor switches on (stable — never renumber). */
  key: string;
  /**
   * Plain-unit delta produced by a FULL route (amount=100, source=1.0).
   * Signed: positive spans push toward "more compression / more drive /
   * more space" so route polarity is musically consistent.
   */
  span: number;
  /** Hard clamp for the modulated value (safe region of the target). */
  min: number;
  max: number;
}

export const MOD_DESTINATIONS: readonly ModDestination[] = [
  { label: "Comp Threshold", key: "dyn.thresholdDb", span: -12, min: -60, max: 0 },
  { label: "Comp Ratio", key: "dyn.ratio", span: 6, min: 1, max: 20 },
  { label: "Drive", key: "char.drive", span: 100, min: 0, max: 100 },
  { label: "Tone", key: "char.tone", span: 100, min: -100, max: 100 },
  { label: "Clip", key: "char.clip", span: 100, min: 0, max: 100 },
  { label: "Motion Depth", key: "motion.depth", span: 100, min: 0, max: 100 },
  { label: "Motion Rate", key: "motion.rateHz", span: 2, min: 0, max: 5 },
  { label: "Motion Feedback", key: "motion.feedback", span: 60, min: -80, max: 80 },
  { label: "Space Send", key: "space.send", span: 100, min: 0, max: 100 },
  { label: "Diffusion", key: "space.diffusion", span: 80, min: 0, max: 100 },
  { label: "Decay", key: "space.decayS", span: 1.5, min: 0.1, max: 5 },
  { label: "Width", key: "space.width", span: 80, min: 0, max: 200 },
  // Experiment #1 (Harmonic Bloom hook, §10): BODY energy opening the
  // harmony is a ROUTE, not hardcoded DSP — append-only, index 12.
  { label: "Harmony Mix", key: "harm.mix", span: 100, min: 0, max: 100 },
  // Experiment #3 (Phase III): the spatial bloom destinations. All four
  // operate on the HARMONY BUS only. APPEND-ONLY (indices 13–16) —
  // serialized routes store enum indices, never renumber.
  { label: "Voice Spread", key: "harm.spread", span: 100, min: 0, max: 200 },
  { label: "Harmony Width", key: "harm.width", span: 100, min: 0, max: 200 },
  { label: "Harmony Diffusion", key: "harm.diffusion", span: 100, min: 0, max: 100 },
  { label: "Harmony Space", key: "harm.space", span: 100, min: 0, max: 100 },
] as const;

/** Stable enum indices (serialized in routes.N.destination). */
export const DEST_INDEX = {
  compThreshold: 0,
  compRatio: 1,
  drive: 2,
  tone: 3,
  clip: 4,
  motionDepth: 5,
  motionRate: 6,
  motionFeedback: 7,
  spaceSend: 8,
  diffusion: 9,
  decay: 10,
  width: 11,
  harmonyMix: 12,
  voiceSpread: 13,
  harmWidth: 14,
  harmDiffusion: 15,
  harmSpace: 16,
} as const;
