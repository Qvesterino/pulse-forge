/**
 * EQ band slot table for the AI bridge.
 *
 * KYX's `eq` effect is a FIXED 6-slot parametric shelf/bell EQ — not an
 * N-band graph. Recipes therefore cannot invent a new band; they must pick
 * an existing slot and move it. This table is the single source of truth for
 * which slots exist, what param keys they own, and the frequency window each
 * slot can address.
 *
 * Canonical param ids (verified in three places, they must stay in sync):
 *   - src/effects/definitions.ts → `eqParams` (the ParamDef whitelist)
 *   - src/audio-worklets/eq-node.ts → `EQ_CANONICAL` (worklet message shape)
 *   - src/effects/registry.ts → `eqNativeFallback` (degraded path switch)
 *
 * WHY THIS FILE EXISTS: `normalizeEffects` in src/project-model/schema.ts
 * rebuilds params as `{...defaults}` and then copies ONLY keys that appear
 * in the registry defaults. Any key the bridge invents (e.g. `band0_freq`)
 * is silently dropped the next time the document is normalized — which is
 * why the first bridge iteration stored carve/boost moves that never reached
 * the audio graph. Only ids listed here survive.
 *
 * Slot geometry (from eqParams, `min`/`max`/`taper: "log"`):
 *   hp          20 … 1000 Hz    highpass corner, no gain/Q
 *   lowShelf    40 …  500 Hz    shelf, no Q
 *   lowMid      80 … 2000 Hz    bell, Q 0.2 … 16
 *   highMid   500 … 8000 Hz    bell, Q 0.2 … 16
 *   highShelf 1500 … 16000 Hz   shelf, no Q
 *   lp        2000 … 20000 Hz   lowpass corner, no gain/Q
 */

export type EqBandSlot = "hp" | "lp" | "lowShelf" | "lowMid" | "highMid" | "highShelf";

export interface EqBandSpec {
  readonly slot: EqBandSlot;
  /** Human label for rationale strings. */
  readonly label: string;
  /** Param key holding the centre/corner frequency. */
  readonly freqId: string;
  /** Param key holding the boost/cut, or null for hp/lp. */
  readonly gainId: string | null;
  /** Param key holding Q, or null for hp/lp/shelves. */
  readonly qId: string | null;
  readonly minHz: number;
  readonly maxHz: number;
  /** EQ gain params are ±15 dB in eqParams (not ±24). */
  readonly minGainDb: number;
  readonly maxGainDb: number;
  /** True for shelves/corners — no Q param, gain is a slope-shaped shelf. */
  readonly isShelf: boolean;
}

export const EQ_BANDS: Record<EqBandSlot, EqBandSpec> = {
  hp: {
    slot: "hp",
    label: "HPF",
    freqId: "hpFreq",
    gainId: null,
    qId: null,
    minHz: 20,
    maxHz: 1000,
    minGainDb: -15,
    maxGainDb: 15,
    isShelf: true,
  },
  lowShelf: {
    slot: "lowShelf",
    label: "LOW SHELF",
    freqId: "lowShelfFreq",
    gainId: "lowShelfGain",
    qId: null,
    minHz: 40,
    maxHz: 500,
    minGainDb: -15,
    maxGainDb: 15,
    isShelf: true,
  },
  lowMid: {
    slot: "lowMid",
    label: "LOW MID",
    freqId: "lowMidFreq",
    gainId: "lowMidGain",
    qId: "lowMidQ",
    minHz: 80,
    maxHz: 2000,
    minGainDb: -15,
    maxGainDb: 15,
    isShelf: false,
  },
  highMid: {
    slot: "highMid",
    label: "HIGH MID",
    freqId: "highMidFreq",
    gainId: "highMidGain",
    qId: "highMidQ",
    minHz: 500,
    maxHz: 8000,
    minGainDb: -15,
    maxGainDb: 15,
    isShelf: false,
  },
  highShelf: {
    slot: "highShelf",
    label: "HIGH SHELF",
    freqId: "highShelfFreq",
    gainId: "highShelfGain",
    qId: null,
    minHz: 1500,
    maxHz: 16000,
    minGainDb: -15,
    maxGainDb: 15,
    isShelf: true,
  },
  lp: {
    slot: "lp",
    label: "LPF",
    freqId: "lpFreq",
    gainId: null,
    qId: null,
    minHz: 2000,
    maxHz: 20000,
    minGainDb: -15,
    maxGainDb: 15,
    isShelf: true,
  },
};

/**
 * Snap a requested frequency into a slot's legal window, and report how far
 * it had to move. Recipes call this so a "carve 6 kHz" intent aimed at the
 * high-mid bell lands at a frequency the slot can actually address instead
 * of being rejected by validation.
 *
 * Returns the clamped frequency plus a human-readable notice when the
 * request fell outside the window (the executor surfaces that in the batch
 * rationale so the UI never claims a move it did not make).
 */
export function clampToSlot(slot: EqBandSpec, freqHz: number): { freqHz: number; notice: string | null } {
  const clamped = Math.min(slot.maxHz, Math.max(slot.minHz, freqHz));
  if (clamped === freqHz) return { freqHz, notice: null };
  return {
    freqHz: clamped,
    notice: `${freqHz} Hz snapped into the ${slot.label} window ${slot.minHz}–${slot.maxHz} Hz`,
  };
}
