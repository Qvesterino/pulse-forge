/**
 * Reverb + delay parameter contract for the AI bridge.
 *
 * Same whitelist hazard as ./eqSlots.ts, ./sidechainSlots.ts,
 * ./compressorSlots.ts and ./transientSlots.ts: only ids present in the
 * registry defaults survive `normalizeEffects`.
 *
 * Canonical ids (verified in three places):
 *   - src/effects/definitions.ts → `reverbParams` / `delayParams`
 *   - src/effects/registry.ts → the `reverb` and `delayNativeFallback`
 *     `apply()` switches
 *   - src/audio-worklets/reverb-node.ts + stock-delay-processor.js
 *
 * ⚠️ MIXED UNITS — the trap in this file:
 *
 *   reverb `decay`     is in **SECONDS**  (0.1 … 20, default 1.8)
 *   reverb `predelay`  is in **MILLISECONDS** (0 … 250, default 20)
 *   delay  `time`      is in **MILLISECONDS** (30 … 2000, default 375)
 *
 * Two time params on adjacent effects with different units. The registry
 * proves it: `predelay` goes through `smooth(preDelay.delayTime, v / 1000, …)`
 * — it is divided by 1000 on the way to the native DelayNode, so the stored
 * value is ms. `decay` goes straight into `makeImpulseResponse(ctx, decaySec)`
 * as seconds. Writing 1.8 "seconds" of predelay would give a 1.8 ms slap;
 * writing 2.5 "ms" of decay would give an unusable 2.5 ms tail.
 *
 * ⚠️ DELAY `sync` OVERRIDES `time`:
 *
 * `sync` is an INDEX into STOCK_DELAY_DIVISIONS = [0, 1, 0.5, 1/3, 0.25, 1/6]
 * (beats per index; 0 = OFF). In stock-delay-processor.js:
 *
 *     let targetMs = clamp(parameters.time[0]);
 *     if (syncIdx !== 0) targetMs = clamp(DIVISIONS[syncIdx] * (60000 / bpm));
 *
 * So a synced delay IGNORES the stored `time` entirely — the bridge must
 * still write a legal `time` (normalize needs it) but should not claim in a
 * rationale that the written millisecond value is what will sound.
 *
 * ⚠️ `pingPong` is WORKLET-ONLY: the native fallback's `apply()` has
 *     `case "pingPong": break;` — the value is stored and never heard. Same
 *     class of caveat as the compressor's sidechain key.
 */

export type ReverbSpace = "room" | "hall" | "plate" | "spring" | "cathedral";
export type DelaySpace = "slap" | "pingpong" | "eighth" | "sixteenth";

/** `reverbParams` — ranges mirrored from src/effects/definitions.ts. */
export const REVERB_RANGES = {
  /** SECONDS. */
  decay: { min: 0.1, max: 20, default: 1.8 },
  /** MILLISECONDS. */
  predelay: { min: 0, max: 250, default: 20 },
  /** Output brightness, Hz. */
  tone: { min: 200, max: 18000, default: 9000 },
  /** In-loop high-frequency damping, Hz. Lower = darker tail. */
  damping: { min: 200, max: 18000, default: 6000 },
  /** 0…1: how quickly the tail smears out. */
  diffusion: { min: 0, max: 1, default: 0.5 },
  /** 0…1: tail chorus. */
  mod: { min: 0, max: 1, default: 0.35 },
  /** Dry/wet. Insert mix, not a send level. */
  mix: { min: 0, max: 1, default: 0.3 },
} as const;

/** `delayParams` — ranges mirrored from src/effects/definitions.ts. */
export const DELAY_RANGES = {
  /** MILLISECONDS. Ignored while `sync` > 0. */
  time: { min: 30, max: 2000, default: 375 },
  /** Index into STOCK_DELAY_DIVISIONS; 0 = OFF (use `time` instead). */
  sync: { min: 0, max: 5, default: 0 },
  /** 0/1 toggle. Worklet-only — the native fallback stores but ignores it. */
  pingPong: { min: 0, max: 1, default: 0 },
  /** 0…0.9. */
  feedback: { min: 0, max: 0.9, default: 0.35 },
  /** Repeat brightness, Hz. */
  tone: { min: 500, max: 8000, default: 4000 },
  /** Dry/wet. */
  mix: { min: 0, max: 1, default: 0.25 },
} as const;

/** The documented sync divisions, in the worklet's own order. */
export const DELAY_SYNC_DIVISIONS: readonly { index: number; label: string; beats: number }[] = [
  { index: 0, label: "OFF", beats: 0 },
  { index: 1, label: "1/4", beats: 1 },
  { index: 2, label: "1/8", beats: 0.5 },
  { index: 3, label: "1/8T", beats: 1 / 3 },
  { index: 4, label: "1/16", beats: 0.25 },
  { index: 5, label: "1/16T", beats: 1 / 6 },
];

export interface ReverbSpec {
  /** SECONDS. */
  readonly decaySec: number;
  /** MILLISECONDS. */
  readonly predelayMs: number;
  readonly toneHz: number;
  readonly dampingHz: number;
  readonly diffusion: number;
  readonly mod: number;
  readonly mix: number;
}

export interface DelaySpec {
  /** MILLISECONDS — only audible while `sync` is 0. */
  readonly timeMs: number;
  /** 0 = OFF. Any other index makes the worklet recompute time from BPM. */
  readonly sync: number;
  readonly pingPong: 0 | 1;
  readonly feedback: number;
  readonly toneHz: number;
  readonly mix: number;
}

/**
 * Reverb space → numbers, scaled by intensity (0…1).
 *
 * The musical logic behind the numbers:
 *   - ROOM: short, bright, dense. A small live space — tight, keeps the
 *     source in front. Low `predelay` so it does not smear the transient.
 *   - HALL: long, dark, sparse. Big stone room. High `damping` frequency
 *     would be wrong, so it is set LOW to absorb highs the way a real hall
 *     does, and `diffusion` stays low so the tail arrives as distinct
 *     reflections rather than a wash.
 *   - PLATE: bright, dense, metallic, very short predelay. The classic
 *     vocal/snare plate — high diffusion, no modulation artefacts.
 *   - SPRING: springy, bouncy, heavily modulated. Two `mod` bounciness reads
 *     as the characteristic chirp.
 *   - CATHEDRAL: the longest tail, darkest, sparsest, and the highest
 *     predelay so the direct sound stays separate.
 *
 * `intensity` extends the decay and opens the mix — the two knobs a user
 * actually reaches for when they say "more space".
 */
export function reverbSpec(space: ReverbSpace, intensity: number): ReverbSpec | null {
  const t = Math.min(1, Math.max(0, intensity));
  const base: Record<ReverbSpace, ReverbSpec> = {
    room: { decaySec: 0.8, predelayMs: 8, toneHz: 11000, dampingHz: 8000, diffusion: 0.7, mod: 0.15, mix: 0.22 },
    hall: { decaySec: 2.8, predelayMs: 25, toneHz: 7000, dampingHz: 4200, diffusion: 0.5, mod: 0.2, mix: 0.28 },
    plate: { decaySec: 1.4, predelayMs: 4, toneHz: 13000, dampingHz: 9500, diffusion: 0.9, mod: 0.1, mix: 0.25 },
    spring: { decaySec: 1.2, predelayMs: 12, toneHz: 8500, dampingHz: 6500, diffusion: 0.4, mod: 0.8, mix: 0.24 },
    cathedral: { decaySec: 6.5, predelayMs: 45, toneHz: 5000, dampingHz: 2800, diffusion: 0.35, mod: 0.15, mix: 0.32 },
  };
  // Unknown space → null, NOT a silent fallback. A recipe (or an LLM) that
  // invents "infinite-cave" must be rejected by the executor, not quietly
  // served a room. The caller validates the null.
  const s = base[space];
  if (!s) return null;
  return {
    ...s,
    // Longer tail and more wet as intensity rises.
    decaySec: round2(s.decaySec * (1 + 1.2 * t)),
    mix: round2(Math.min(1, s.mix * (1 + 0.9 * t))),
  };
}

/**
 * Delay space → numbers, scaled by intensity (0…1).
 *
 *   - SLAP: 1/16-note feel without sync (kept in ms so it is BPM-proof for
 *     a one-off), minimal feedback, bright repeats.
 *   - PINGPONG: 1/8 synced, alternating L/R, moderate feedback. The classic
 *     wide depth trick — the worklet routes the repeat to the far side.
 *   - EIGHTH: 1/8 synced, mono repeats, the standard tempo delay.
 *   - SIXTEENTH: 1/16 synced, tight and rhythmic.
 *
 * Sync indices come from DELAY_SYNC_DIVISIONS; every synced space also
 * writes a legal `time` because `normalizeEffects` needs a value, and the
 * worklet will override it from BPM.
 */
export function delaySpec(space: DelaySpace, intensity: number): DelaySpec | null {
  const t = Math.min(1, Math.max(0, intensity));
  const base: Record<DelaySpace, DelaySpec> = {
    slap: { timeMs: 90, sync: 0, pingPong: 0, feedback: 0.12, toneHz: 5000, mix: 0.15 },
    pingpong: { timeMs: 250, sync: 2, pingPong: 1, feedback: 0.32, toneHz: 4500, mix: 0.2 },
    eighth: { timeMs: 250, sync: 2, pingPong: 0, feedback: 0.25, toneHz: 4000, mix: 0.18 },
    sixteenth: { timeMs: 125, sync: 4, pingPong: 0, feedback: 0.22, toneHz: 4500, mix: 0.16 },
  };
  const s = base[space];
  if (!s) return null;
  return {
    ...s,
    feedback: round2(Math.min(0.9, s.feedback * (1 + 0.6 * t))),
    mix: round2(Math.min(1, s.mix * (1 + 0.7 * t))),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
