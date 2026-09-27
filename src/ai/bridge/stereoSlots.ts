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
 * 2. `msEq.soloLow` / `soloMid` / `soloHigh` — a solo mutes two of the three
 *    bands, so the effect becomes a band-pass test rather than an EQ. Every
 *    solo is a solo with 0/1 params, so it is indistinguishable from a valid
 *    "reduce the low band" intent. The bridge only ever writes 0.
 *
 * Both are enforced in the `*Spec` constructors below AND asserted in the
 * tests, because "the bridge quietly set a solo" is the kind of change a
 * user undoes without understanding why it sounded like a filter sweep.
 *
 * ---------------------------------------------------------------------------
 * `msEq` CROSSOVER ORDERING
 * ---------------------------------------------------------------------------
 *
 * `lowFreq` is 80…800 Hz and `highFreq` is 800…8000 Hz. They share a boundary
 * at 800 Hz, so a recipe that asks for low=800 / high=800 produces a
 * degenerate crossover with a zero-width mid band. `msEqSpec` enforces
 * `highFreq > lowFreq` and reports it, rather than writing a value the
 * splitter cannot render.
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

/** `msEqParams`. */
export const MSEQ_RANGES = {
  /** Low/mid crossover, Hz. */
  lowFreq: { min: 80, max: 800, default: 200 },
  /** Mid/high crossover, Hz. Must be > lowFreq. */
  highFreq: { min: 800, max: 8000, default: 2000 },
  /** dB on the low band. */
  lowGain: { min: -12, max: 12, default: 0 },
  /** dB on the mid band. */
  midGain: { min: -12, max: 12, default: 0 },
  /** dB on the high band. */
  highGain: { min: -12, max: 12, default: 0 },
  /** 0…1 downward band compression. */
  comp: { min: 0, max: 1, default: 0 },
  /** 0/1 band solo. The bridge NEVER sets 1 — see the file header. */
  soloLow: { min: 0, max: 1, default: 0 },
  soloMid: { min: 0, max: 1, default: 0 },
  soloHigh: { min: 0, max: 1, default: 0 },
  /** Dry/wet. */
  mix: { min: 0, max: 1, default: 1 },
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
  readonly lowFreqHz: number;
  readonly highFreqHz: number;
  readonly lowGainDb: number;
  readonly midGainDb: number;
  readonly highGainDb: number;
  readonly comp: number;
  /** Always 0 from the bridge. */
  readonly soloLow: 0;
  readonly soloMid: 0;
  readonly soloHigh: 0;
  readonly mix: number;
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
 *   - SCOOPED: low cut, mid cut, high lift — the modern "wide and thin" mix.
 *   - VOCAL-FOCUS: low cut, mid BOOST, high cut. Puts the mid band forward
 *     and keeps the sibilance out, which is what a vocal actually needs.
 *   - BRIGHT: high lift only, mid slightly down so the lift does not turn
 *     into harshness.
 *   - BALANCED: crossover moves with no gain change — a way to re-focus the
 *     bands without touching the tone, useful as a neutral starting point.
 *
 * The crossover pair is forced apart by MIN_CROSSOVER_GAP so the mid band can
 * never be given zero width.
 */
export function midSideSpec(shape: MidSideShape, intensity: number): MidSideSpec | null {
  const t = Math.min(1, Math.max(0, intensity));
  const base: Record<MidSideShape, MidSideSpec> = {
    scooped: { lowFreqHz: 240, highFreqHz: 2400, lowGainDb: -3, midGainDb: -2, highGainDb: 2, comp: 0.2, soloLow: 0, soloMid: 0, soloHigh: 0, mix: 1 },
    "vocal-focus": { lowFreqHz: 180, highFreqHz: 3200, lowGainDb: -4, midGainDb: 2.5, highGainDb: -2, comp: 0.3, soloLow: 0, soloMid: 0, soloHigh: 0, mix: 1 },
    bright: { lowFreqHz: 200, highFreqHz: 2000, lowGainDb: 0, midGainDb: -1, highGainDb: 3, comp: 0.1, soloLow: 0, soloMid: 0, soloHigh: 0, mix: 1 },
    balanced: { lowFreqHz: 200, highFreqHz: 2000, lowGainDb: 0, midGainDb: 0, highGainDb: 0, comp: 0, soloLow: 0, soloMid: 0, soloHigh: 0, mix: 1 },
  };
  const s = base[shape];
  if (!s) return null;
  const scale = (db: number): number => round2(db * (1 + 0.35 * t));
  const lowFreqHz = round2(s.lowFreqHz * (1 - 0.15 * t));
  const highFreqHz = Math.max(
    MSEQ_RANGES.highFreq.min,
    round2(s.highFreqHz * (1 + 0.15 * t)),
  );
  return {
    ...s,
    lowGainDb: scale(s.lowGainDb),
    midGainDb: scale(s.midGainDb),
    highGainDb: scale(s.highGainDb),
    lowFreqHz,
    // Enforce ordering — the splitter cannot render a zero-width mid band.
    highFreqHz: Math.max(highFreqHz, lowFreqHz + MIN_CROSSOVER_GAP),
  };
}

/** Minimum separation between the two crossovers, in Hz. */
export const MIN_CROSSOVER_GAP = 50;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
