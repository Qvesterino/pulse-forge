/**
 * Sidechain parameter contract for the AI bridge.
 *
 * Same class of hazard as ./eqSlots.ts: `normalizeEffects` rebuilds
 * `EffectInstance.params` from the registry whitelist, so a key the bridge
 * invents is silently dropped on the next normalize and the effect never
 * changes the sound.
 *
 * Canonical ids (verified in three places, they must stay in sync):
 *   - src/effects/definitions.ts → `sidechainParams` (the ParamDef whitelist)
 *   - src/audio-worklets/sidechain-node.ts → initial `safeApplyAudioParam` set
 *   - src/effects/registry.ts → `sidechain` fallback `apply()` switch
 *
 * SEMANTIC NOTES — these are the traps the bridge originally fell into:
 *
 *  1. `attack` / `release` are in **SECONDS**, not milliseconds. The
 *     fallback coerces with `Math.exp(-1 / (sampleRate * v))`, so a value
 *     written in ms (5) would become a 5-second time constant.
 *
 *  2. `amount` is a 0…1 **blend**, not a depth. From the fallback:
 *         reductionDb = overDb * (1 - 1/ratio)
 *         gain = max(0, 1 - amount * (1 - 10^(-reductionDb/20)))
 *     So `amount: 1` means "apply the full ratio-derived reduction";
 *     `amount: 0` is a bypass. The *depth* of the duck is set by `ratio`
 *     and `threshold`, not by `amount`.
 *
 *  3. There is no `bypassThreshold` param. Level gating is `threshold` (dBFS
 *     on the KEY signal) and the optional `splitFreq` crossover.
 *
 * Because of (2), the bridge's user-facing "how deep should the duck be"
 * number is a dB value that the executor must TRANSLATE into ratio/amount —
 * it cannot be written straight into params.
 */

/** Canonical sidechain param ids. */
export type SidechainParamId = "threshold" | "ratio" | "attack" | "release" | "amount" | "splitFreq";

/** Legal ranges mirrored from `sidechainParams` in src/effects/definitions.ts. */
export const SIDECHAIN_RANGES = {
  /** dBFS on the key signal. */
  threshold: { min: -60, max: 0, default: -18 },
  /** Compression ratio of the duck. Higher = deeper duck. */
  ratio: { min: 1, max: 20, default: 4 },
  /** Seconds (NOT ms). */
  attack: { min: 0.0002, max: 0.5, default: 0.005 },
  /** Seconds (NOT ms). */
  release: { min: 0.02, max: 2, default: 0.2 },
  /** 0…1 blend of the computed reduction. 0 = bypass, 1 = full duck. */
  amount: { min: 0, max: 1, default: 1 },
  /** Hz. ≤10 means "off" (full-band duck). */
  splitFreq: { min: 0, max: 500, default: 0 },
} as const;

/** The subset of canonical params the bridge sets for a duck. */
export interface SidechainDuckSpec {
  readonly thresholdDb: number;
  readonly ratio: number;
  readonly attackSec: number;
  readonly releaseSec: number;
  readonly amount: number;
  readonly splitFreqHz: number;
}

export const SIDECHAIN_DEFAULTS: SidechainDuckSpec = {
  thresholdDb: SIDECHAIN_RANGES.threshold.default,
  ratio: SIDECHAIN_RANGES.ratio.default,
  attackSec: SIDECHAIN_RANGES.attack.default,
  releaseSec: SIDECHAIN_RANGES.release.default,
  amount: SIDECHAIN_RANGES.amount.default,
  splitFreqHz: SIDECHAIN_RANGES.splitFreq.default,
};

/** Ducks deeper than this are indistinguishable from a mute. */
export const MAX_SENSIBLE_DUCK_DB = 24;

/**
 * Translate a musical "how deep should this duck" intent (dB) into the
 * canonical (ratio, amount) pair the sidechain actually understands.
 *
 * Why a translation is needed: the processor derives gain reduction from the
 * KEY signal's level above `threshold` scaled by `ratio`. The final depth in
 * dB therefore depends on how hot the key signal plays, which a recipe cannot
 * know ahead of time. So the bridge expresses intent as a **worst-case**
 * depth and picks the ratio that would reach it for a typical 12 dB of
 * overshoot above the threshold — the value a backbeat snare/hit normally
 * sits at. `amount` stays at 1 (full application) unless the intent is very
 * shallow, where a partial blend keeps the duck from sounding gated.
 *
 * The result is a musically sane starting point the user can refine, NOT a
 * guarantee of exactly N dB — the rationale text says so.
 *
 * @param duckDb  desired worst-case depth, 0…MAX_SENSIBLE_DUCK_DB
 * @param typicalOverDb  assumed key overshoot above threshold (default 12)
 */
export function duckDepthToRatio(duckDb: number, typicalOverDb = 12): { ratio: number; amount: number } {
  const depth = Math.min(Math.max(duckDb, 0), MAX_SENSIBLE_DUCK_DB);
  if (depth <= 0.01) return { ratio: SIDECHAIN_RANGES.ratio.min, amount: 0 };

  // GR = over * (1 - 1/ratio)  ⇒  ratio = 1 / (1 - depth/over)
  const needed = depth / typicalOverDb;
  // When the intent asks for more reduction than the overshoot can give at a
  // finite ratio, saturate at the max ratio rather than dividing by ~0.
  const ratio = needed >= 0.99 ? SIDECHAIN_RANGES.ratio.max : 1 / (1 - needed);
  const clamped = Math.min(SIDECHAIN_RANGES.ratio.max, Math.max(SIDECHAIN_RANGES.ratio.min, ratio));

  // A very shallow duck reads as gating rather than as breathing — blend it
  // down so the movement stays subtle instead of choppy.
  const amount = depth < 2 ? Math.min(1, Math.max(0.3, depth / 2)) : 1;
  return { ratio: Math.round(clamped * 10) / 10, amount: Math.round(amount * 100) / 100 };
}
