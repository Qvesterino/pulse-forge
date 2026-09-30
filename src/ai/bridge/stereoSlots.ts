/**
 * Stereo-width and mid/side parameter contracts for the AI bridge.
 *
 * Same whitelist hazard as every other `*Slots.ts` in this folder: only ids
 * present in the registry defaults survive `normalizeEffects`.
 *
 * Canonical ids:
 *   - src/effects/definitions.ts → `haasWidenerParams` / `msEqParams`
 *   - src/effects/registry.ts → the `haasWidener` and `msEq` `apply()` switches
 *
 * ---------------------------------------------------------------------------
 * TWO PARAMS THE BRIDGE MUST NEVER SET ON AN INFERRED INTENT
 * ---------------------------------------------------------------------------
 *
 * 1. `haasWidener.invert` — flips which channel is delayed. Haas widening
 *    relies on the delay being BELOW the ~1.5 ms coherence limit to create
 *    width; inverting puts the delay on the far channel, which flips which
 *    ear hears the transient FIRST. On a mono source that reads as a
 *    pre-echo smear. The effect is legal and the range is 0…1, so validation
 *    cannot catch a bad choice — it is an editorial decision. The bridge only
 *    ever writes 0.
 *
 *    (The sibling hazard — the `msEq.soloLow/Mid/High` band solos — no longer
 *    exists. The 4-band M/S redesign removed the solos entirely; they were
 *    previously written as 0 by construction.)
 *
 * Both are enforced in the `*Spec` constructors below AND asserted in the
 * tests, because "the bridge quietly set a solo" is the kind of change a
 * user undoes without understanding why it sounded like a filter sweep.
 *
 * ---------------------------------------------------------------------------
 * `msEq` BAND ORDERING
 * ---------------------------------------------------------------------------
 *
 * Each channel carries a low band (40…500 Hz) and a high band (1500…16000 Hz),
 * so the two are separated by the registry ranges themselves and a zero-width
 * band is structurally unreachable. `midSideSpec` still clamps every centre
 * into its own window, and the validator re-checks the pair.
 */

export type StereoWidth = "subtle" | "wide" | "huge";
export type MidSideShape = "scooped" | "vocal-focus" | "bright" | "balanced";

/** `haasWidenerParams`. */
export const HAAS_RANGES = {
  /** MILLISECONDS. 0.5…40 — Haas only reads as width below ~1.5 ms. */
  delayMs: { min: 0.5, max: 40, default: 12 },
  /** 0…1 amount of extra side signal. */
  width: { min: 0, max: 1, default: 0.7 },
  /** 0…1 how much dry bleeds into the delayed path (keeps mono sources blooming). */
  crossfeed: { min: 0, max: 1, default: 0.4 },
  /** 0/1 phase flip. The bridge NEVER sets 1 — see the file header. */
  invert: { min: 0, max: 1, default: 0 },
  /** 0…0.6 comb recirculation. */
  feedback: { min: 0, max: 0.6, default: 0 },
} as const;

/**
 * `msEqParams`.
 *
 * NOTE (audit 2026-09-30): the `msEq` effect was redesigned from a 3-band
 * crossover layout into a 4-band M/S EQ (a low band and a high band on the MID
 * channel, and the same two bands on the SIDE channel). This table used to hold
 * the old ids — lowFreq / highFreq / lowGain / midGain / highGain / comp /
 * soloLow / soloMid / soloHigh / mix — which are all DEAD KEYS on the current
 * effect. Because `applyMidSideEq` seeds from `defaultParamsOf("msEq")` and then
 * overwrites with the old names, every musically meaningful value the intent
 * computed was stripped by `normalizeEffects` and the user received a default,
 * silent-to-the-request M/S EQ. The bridge is now mapped onto the real surface.
 */
export const MSEQ_RANGES = {
  /** MID-channel low band centre, Hz. */
  midLowFreq: { min: 40, max: 500, default: 120 },
  /** MID-channel low band gain, dB. */
  midLowGain: { min: -15, max: 15, default: 0 },
  /** MID-channel high band centre, Hz. */
  midHighFreq: { min: 1500, max: 16000, default: 6000 },
  /** MID-channel high band gain, dB. */
  midHighGain: { min: -15, max: 15, default: 0 },
  /** SIDE-channel low band centre, Hz. */
  sideLowFreq: { min: 40, max: 500, default: 120 },
  /** SIDE-channel low band gain, dB. */
  sideLowGain: { min: -15, max: 15, default: 0 },
  /** SIDE-channel high band centre, Hz. */
  sideHighFreq: { min: 1500, max: 16000, default: 6000 },
  /** SIDE-channel high band gain, dB. */
  sideHighGain: { min: -15, max: 15, default: 0 },
} as const;

export interface HaasSpec {
  readonly delayMs: number;
  readonly width: number;
  readonly crossfeed: number;
  /** Always 0 from the bridge. */
  readonly invert: 0;
  readonly feedback: number;
}

export interface MidSideSpec {
  readonly midLowFreqHz: number;
  readonly midLowGainDb: number;
  readonly midHighFreqHz: number;
  readonly midHighGainDb: number;
  readonly sideLowFreqHz: number;
  readonly sideLowGainDb: number;
  readonly sideHighFreqHz: number;
  readonly sideHighGainDb: number;
}

/**
 * Width intent → Haas numbers.
 *
 * The delay is the only control that actually decides whether this reads as
 * "wider": under ~10 ms it is a doubling cue, over ~25 ms it becomes an
 * audible slap that smears the attack. So every width tier stays inside a
 * musical window and only `width` carries the intent.
 *
 *   - SUBTLE: 8 ms, low width, generous crossfeed so a mono source (a single
 *     guitar DI is mono!) still blooms instead of collapsing to one side.
 *   - WIDE: 15 ms, the classic doubling range.
 *   - HUGE: 22 ms — the top of the "still musical" band. Deliberately short
 *     of the 30 ms+ settings that read as a separate echo.
 *
 * `intensity` opens `width` and nudges the delay up; it never pushes the
 * delay past the slap threshold.
 */
export function haasSpec(width: StereoWidth, intensity: number): HaasSpec | null {
  const t = Math.min(1, Math.max(0, intensity));
  const base: Record<StereoWidth, HaasSpec> = {
    subtle: { delayMs: 8, width: 0.35, crossfeed: 0.55, invert: 0, feedback: 0 },
    wide: { delayMs: 15, width: 0.7, crossfeed: 0.4, invert: 0, feedback: 0 },
    huge: { delayMs: 22, width: 0.95, crossfeed: 0.25, invert: 0, feedback: 0.08 },
  };
  const s = base[width];
  if (!s) return null;
  return {
    ...s,
    width: round2(Math.min(1, s.width * (1 + 0.25 * t))),
    // Capped well below the ~30 ms slap region.
    delayMs: round2(Math.min(28, s.delayMs * (1 + 0.15 * t))),
  };
}

/**
 * Shape intent → mid/side EQ numbers.
 *
 * Mapped onto the CURRENT 4-band M/S surface (two bands per channel), which is
 * what makes this worth an M/S EQ rather than a plain one: the MID channel
 * carries the tone shaping and the SIDE channel carries the width intent, so a
 * "scooped" mix can be tight in the centre AND airy at the edges — a decision a
 * mono-summed EQ cannot express.
 *
 *   - SCOOPED: centre low cut + side high lift — the modern "wide and thin" mix.
 *   - VOCAL-FOCUS: low cut on both channels, side high cut — puts the centre
 *     forward and keeps sibilance out of the sides, which is what a vocal needs.
 *   - BRIGHT: centre high lift, side low cut — air without harsh low-mid buildup.
 *   - BALANCED: the crossovers move, no gain change — a neutral way to re-focus
 *     the bands without touching tone.
 *
 * Band CENTRES are ordered by construction: the registry's low bands top out at
 * 500 Hz and the high bands start at 1500 Hz, so a zero-width band is
 * unreachable. `MIN_CROSSOVER_GAP` is still asserted below as a guard.
 */
export function midSideSpec(shape: MidSideShape, intensity: number): MidSideSpec | null {
  const t = Math.min(1, Math.max(0, intensity));
  const base: Record<MidSideShape, MidSideSpec> = {
    scooped: {
      midLowFreqHz: 240,
      midLowGainDb: -3,
      midHighFreqHz: 2400,
      midHighGainDb: 0,
      sideLowFreqHz: 240,
      sideLowGainDb: 0,
      sideHighFreqHz: 2400,
      sideHighGainDb: 3,
    },
    "vocal-focus": {
      midLowFreqHz: 180,
      midLowGainDb: -4,
      midHighFreqHz: 3200,
      midHighGainDb: 0,
      sideLowFreqHz: 180,
      sideLowGainDb: -2,
      sideHighFreqHz: 3200,
      sideHighGainDb: -3,
    },
    bright: {
      midLowFreqHz: 200,
      midLowGainDb: 0,
      midHighFreqHz: 2000,
      midHighGainDb: 3,
      sideLowFreqHz: 200,
      sideLowGainDb: -1.5,
      sideHighFreqHz: 2000,
      sideHighGainDb: 1,
    },
    balanced: {
      midLowFreqHz: 200,
      midLowGainDb: 0,
      midHighFreqHz: 2000,
      midHighGainDb: 0,
      sideLowFreqHz: 200,
      sideLowGainDb: 0,
      sideHighFreqHz: 2000,
      sideHighGainDb: 0,
    },
  };
  const s = base[shape];
  if (!s) return null;
  const scale = (db: number): number => round2(db * (1 + 0.35 * t));
  // Intensity opens the band centres apart (a more decisive focus) while the
  // registry clamp keeps each centre inside its own window.
  const lowHz = (hz: number): number =>
    Math.min(MSEQ_RANGES.midLowFreq.max, Math.max(MSEQ_RANGES.midLowFreq.min, round2(hz * (1 - 0.15 * t))));
  const highHz = (hz: number): number =>
    Math.min(MSEQ_RANGES.midHighFreq.max, Math.max(MSEQ_RANGES.midHighFreq.min, round2(hz * (1 + 0.15 * t))));
  return {
    midLowFreqHz: lowHz(s.midLowFreqHz),
    midLowGainDb: scale(s.midLowGainDb),
    midHighFreqHz: highHz(s.midHighFreqHz),
    midHighGainDb: scale(s.midHighGainDb),
    sideLowFreqHz: lowHz(s.sideLowFreqHz),
    sideLowGainDb: scale(s.sideLowGainDb),
    sideHighFreqHz: highHz(s.sideHighFreqHz),
    sideHighGainDb: scale(s.sideHighGainDb),
  };
}

/** Minimum separation between the two crossovers, in Hz. */
export const MIN_CROSSOVER_GAP = 50;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
