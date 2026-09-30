/**
 * Compressor parameter contract for the AI bridge.
 *
 * Third instance of the same hazard documented in ./eqSlots.ts and
 * ./sidechainSlots.ts: `normalizeEffects` rebuilds params from the registry
 * whitelist, so an invented key is silently dropped and the effect does
 * nothing.
 *
 * Canonical ids (verified in three places, they must stay in sync):
 *   - src/effects/definitions.ts → `compressorParams` (the ParamDef whitelist)
 *   - src/audio-worklets/compressor-node.ts → initial `apply()` calls
 *   - src/effects/registry.ts → `compressor` native-fallback `apply()` switch
 *
 * HOW COMPRESSOR DIFFERS FROM SIDECHAIN — the two are easy to conflate:
 *
 *  1. NO `amount` param. Sidechain blends via `amount` (0…1); the compressor
 *     has no such blend. It uses `mix` (dry/wet 0…1) and `makeup` instead.
 *
 *  2. `attack` / `release` are in SECONDS, same as sidechain — the same trap.
 *
 *  3. `makeup` is stored in **dB** (0…24) even though the worklet param is
 *     linear. The node wrapper converts:
 *         apply("makeup", Math.pow(10, params.makeup / 20), undefined)
 *     so the bridge must write dB, never a linear factor.
 *
 *  4. The compressor DOES have a real sidechain input (`numberOfInputs: 2`
 *     and `setSidechainInput`), and AudioEngine routes `sidechainTrackId`
 *     into it generically — so a keyed compressor works the same way a
 *     sidechain effect does. The catch: the NATIVE FALLBACK has no sidechain
 *     (no second input, coarse GR) and reports `degraded: true`. A keyed
 *     compressor therefore only behaves as written when the worklet is
 *     loaded — see `supportsSidechain`.
 */

export type CompressorParamId =
  | "threshold"
  | "ratio"
  | "attack"
  | "release"
  | "knee"
  | "detector"
  | "scHpf"
  | "scMode"
  | "scBandHz"
  | "autoRelease"
  | "makeup"
  | "mix";

/** Legal ranges mirrored from `compressorParams` in src/effects/definitions.ts. */
export const COMPRESSOR_RANGES = {
  /** dBFS. */
  threshold: { min: -60, max: 0, default: -18 },
  /** 1…20:1. */
  ratio: { min: 1, max: 20, default: 3 },
  /** Seconds (NOT ms). */
  attack: { min: 0.0002, max: 0.5, default: 0.01 },
  /** Seconds (NOT ms). */
  release: { min: 0.02, max: 2, default: 0.2 },
  /** Soft-knee width in dB. 0 = hard knee. */
  knee: { min: 0, max: 40, default: 6 },
  /** 0 = RMS, 1 = PEAK. */
  detector: { min: 0, max: 1, default: 0 },
  /** Sidechain detector high-pass in Hz (detector path only). */
  scHpf: { min: 20, max: 500, default: 20 },
  /**
   * DE-ESS detector mode (added with the scMode/scBandHz feature): 0 = the
   * scHpf high-pass detector, 1 = a band-pass detector centred on scBandHz.
   * Registry default is 0, so a bridge-written compressor keeps the classic
   * sidechain behaviour unless a recipe explicitly opts into de-essing.
   */
  scMode: { min: 0, max: 1, default: 0 },
  /** DE-ESS band centre in Hz. Mirrors the `scBandHz` registry def (2000…12000). */
  scBandHz: { min: 2000, max: 12000, default: 6500 },
  /** 0 = fixed release, 1 = program-dependent. */
  autoRelease: { min: 0, max: 1, default: 0 },
  /** Makeup gain in dB (registry unit; the worklet converts to linear). */
  makeup: { min: 0, max: 24, default: 0 },
  /** Dry/wet blend. */
  mix: { min: 0, max: 1, default: 1 },
} as const;

/**
 * Which runtime paths can honour a keyed (`sidechainTrackId`) compressor.
 * The native DynamicsCompressorNode fallback has a single input, so the key
 * is silently dropped and the compressor runs un-keyed — it still compresses,
 * but nothing pumps. A recipe that wants a key should prefer the plain
 * sidechain effect, or the user must accept degraded behaviour.
 */
export function supportsSidechain(): "worklet-only" {
  return "worklet-only";
}

/** Fraction of GR left when the key is missing → the "not actually keyed" case. */
export const COMPRESSOR_SIDECHAIN_CAVEAT =
  "Keyed compression only runs on the worklet path. If the effect reports degraded, " +
  "the native fallback has no sidechain input and the compressor is un-keyed.";

/**
 * The musical archetypes a recipe can ask for. KYX's compressor exposes the
 * raw parameters, not character presets, so the bridge has to own the
 * translation from "glue" / "punch" into numbers.
 */
export type CompressorCharacter = "glue" | "punch" | "bus" | "vocal";

export interface CompressorSpec {
  readonly thresholdDb: number;
  readonly ratio: number;
  readonly attackSec: number;
  readonly releaseSec: number;
  readonly kneeDb: number;
  /** 0 = RMS, 1 = PEAK. */
  readonly detector: 0 | 1;
  readonly scHpfHz: number;
  /** 0 = fixed, 1 = program-dependent. */
  readonly autoRelease: 0 | 1;
  readonly makeupDb: number;
  readonly mix: number;
}

/**
 * Character → concrete numbers.
 *
 * The reasoning behind the numbers, since KYX has no character presets:
 *   - GLUE: high ratio, slow-ish attack, long release. A lot of the music is
 *     above threshold, so the compressor works continuously and evens the
 *     ride rather than reacting to hits.
 *   - PUNCH: fast attack so transients get caught before they decay, short
 *     release so the gap between hits fills back in. PEAK detector keeps it
 *     from pumping between transient peaks.
 *   - BUS: gentler than glue, wide knee — a mixing bus should hold the
 *     ensemble together without obviously flattening the source.
 *   - VOCAL: PEAK detector + slow-ish release, keyed to the kick when the
 *     recipe supplies a source. Avoids the "chicken and egg" RMS level
 *     problem where a vocal that ducks itself stops ducking.
 *
 * Makeup compensates the level loss the compression causes, which is why
 * `makeup` is in dB here and must not be a linear factor.
 */
export const COMPRESSOR_CHARACTERS: Record<CompressorCharacter, CompressorSpec> = {
  glue: {
    thresholdDb: -24,
    ratio: 6,
    attackSec: 0.03,
    releaseSec: 0.5,
    kneeDb: 12,
    detector: 0,
    scHpfHz: 20,
    autoRelease: 1,
    makeupDb: 4,
    mix: 1,
  },
  punch: {
    thresholdDb: -18,
    ratio: 8,
    attackSec: 0.002,
    releaseSec: 0.12,
    kneeDb: 4,
    detector: 1,
    scHpfHz: 20,
    autoRelease: 0,
    makeupDb: 6,
    mix: 1,
  },
  bus: {
    thresholdDb: -28,
    ratio: 3,
    attackSec: 0.05,
    releaseSec: 0.6,
    kneeDb: 20,
    detector: 0,
    scHpfHz: 20,
    autoRelease: 1,
    makeupDb: 2,
    mix: 1,
  },
  vocal: {
    thresholdDb: -22,
    ratio: 4,
    attackSec: 0.01,
    releaseSec: 0.25,
    kneeDb: 8,
    detector: 1,
    scHpfHz: 20,
    autoRelease: 0,
    makeupDb: 3,
    mix: 1,
  },
};

/** Blends a character toward a per-user intensity (0 = as authored, 1 = max). */
export function tuneCharacter(base: CompressorSpec, intensity: number): CompressorSpec {
  const t = Math.min(1, Math.max(0, intensity));
  return {
    ...base,
    // More intensity = lower threshold and a higher ratio (more reduction).
    thresholdDb: Math.round((base.thresholdDb + 6 * t) * 10) / 10,
    ratio: Math.round((base.ratio + (COMPRESSOR_RANGES.ratio.max - base.ratio) * 0.5 * t) * 10) / 10,
    makeupDb: Math.round((base.makeupDb + 3 * t) * 10) / 10,
  };
}
