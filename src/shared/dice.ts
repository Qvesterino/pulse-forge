import { hashString, forkRandom } from "./rng";
import type { IntentControls } from "../intent/types";
import { getStyleNamesForGenre } from "../ai/grooves/index";
import type { GenerateOptions } from "../ai/types";

/**
 * Deterministic dice — pure functions over `rng.ts`.
 * Every throw is replayable from the initial seed.
 */

/** Next seed in a deterministic chain. Same input → same output. */
export function nextSeed(seed: string, salt = "dice"): string {
  const h = hashString(`${seed}|${salt}`);
  // 6-char base36, pad + slice for stable length (a-z0-9).
  return h.toString(36).padStart(6, "0").slice(-6);
}

/** Advance `n` steps from `seed`. */
export function seedAt(seed: string, n: number, salt = "dice"): string {
  let cur = seed;
  for (let i = 0; i < n; i++) cur = nextSeed(cur, salt);
  return cur;
}

/** Initial seed for a fresh dice session — 6 chars, deterministic only if you pass one. */
export function initialSeed(seed?: string): string {
  if (seed && seed.length > 0) return seed.slice(0, 16);
  // Fallback uses current time hashed — still deterministic per-call but not replayable without saving.
  // Prefer passing an explicit seed from the caller (doc state or previous chain).
  return nextSeed(String(Date.now()), "init");
}

/** Jitter engine controls by `amount` (0..1) using a dedicated fork. */
export function jitterControls(seed: string, base: IntentControls, amount: number): IntentControls {
  if (amount <= 0) return { ...base };
  const rnd = forkRandom(seed, "dice.controls");
  const jitter = (range: number) => (rnd() - 0.5) * 2 * range * amount;
  // Ranges chosen to keep musicality: ghost/micro/velVar ±0.3, temp ±0.6 (±30% at amount=1)
  return {
    ghostWeight: clamp01(base.ghostWeight + jitter(0.3)),
    microWeight: clamp01(base.microWeight + jitter(0.3)),
    velocityVariation: clamp01(base.velocityVariation + jitter(0.3)),
    temperature: clamp(0.2, 2, base.temperature + jitter(0.6)),
  };
}

/** Pick a random style for `genre` using `seed`. Returns null if genre has no styles. */
export function pickStyle(seed: string, genre: GenerateOptions["genre"], _current: string | null): string | null {
  const styles = getStyleNamesForGenre(genre);
  if (styles.length === 0) return null;
  const rnd = forkRandom(seed, "dice.style");
  const idx = Math.floor(rnd() * styles.length);
  return styles[idx] ?? null;
}

/** Deterministic dice throw 1..faces. */
export function throwDice(seed: string, faces = 6): { value: number; nextSeed: string } {
  const rnd = forkRandom(seed, "dice.throw");
  const value = 1 + Math.floor(rnd() * faces);
  return { value, nextSeed: nextSeed(seed, `throw:${value}`) };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function clamp(lo: number, hi: number, v: number): number {
  return Math.max(lo, Math.min(hi, v));
}
