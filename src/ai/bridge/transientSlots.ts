/**
 * Transient shaper parameter contract for the AI bridge.
 *
 * Same whitelist hazard as ./eqSlots.ts, ./sidechainSlots.ts and
 * ./compressorSlots.ts: only ids present in the registry defaults survive
 * `normalizeEffects`.
 *
 * Canonical ids (verified in two places):
 *   - src/effects/definitions.ts → `transientParams`
 *   - src/effects/registry.ts → `createWorkletRuntime` `apply()`, which does
 *     `node.parameters.get(id)` — so each id is also the worklet's
 *     AudioParam name.
 *
 * The ranges are SIGNED: attack and sustain run −1…1, not 0…1. A positive
 * `attack` boosts the transient, a negative `sustain` shortens the body so
 * the click reads more clearly. Writing 0.5 where −0.5 was meant inverts the
 * move rather than failing loudly, so the executor validates the sign.
 *
 * The runtime has no native fallback: when the worklet is unavailable the
 * registry returns a transparent 1:1 bypass and flags it degraded, so this
 * effect is a no-op rather than a wrong sound.
 */

export const TRANSIENT_RANGES = {
  /** −1…1, signed. Positive = more transient. */
  attack: { min: -1, max: 1, default: 0.25 },
  /** −1…1, signed. Negative = shorter body. */
  sustain: { min: -1, max: 1, default: 0 },
  /** 0…1: how much material reacts. */
  sensitivity: { min: 0, max: 1, default: 0.5 },
  /** Dry/wet blend. */
  mix: { min: 0, max: 1, default: 1 },
  /** Post-effect trim in dB. */
  output: { min: -24, max: 24, default: 0 },
} as const;

export interface TransientSpec {
  readonly attack: number;
  readonly sustain: number;
  readonly sensitivity: number;
  readonly mix: number;
  readonly outputDb: number;
}

/** A "punchier" starting point: more transient, shorter body, unity output. */
export const TRANSIENT_PUNCH: TransientSpec = {
  attack: 0.6,
  sustain: -0.35,
  sensitivity: 0.5,
  mix: 1,
  outputDb: 0,
};

/** A gentler variant for glue-ish contexts. */
export const TRANSIENT_GENTLE: TransientSpec = {
  attack: 0.25,
  sustain: -0.1,
  sensitivity: 0.4,
  mix: 1,
  outputDb: 0,
};
