/**
 * Velocity effects for selections — randomize and humanize.
 *
 * Both preserve silence: values ≤ 0 pass through untouched (a randomize over
 * a step selection must never CREATE notes on empty steps).
 *
 * Determinism (GOAL 09): the randomness is INTENTIONAL (creative rolls), and
 * callers bake the computed values into their commands — so cross-instance
 * replay is already stable. The optional `rng` parameter exists for
 * reproducible contexts (golden harness, tests): pass a seeded generator to
 * make the output a pure function of (input, rng).
 */

const FLOOR = 0.05;

/** Uniform random velocity in [min, max] for every audible value. */
export function randomizeVelocities(current: number[], min = 0.45, max = 1, rng: () => number = Math.random): number[] {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return current.map((v) => (v > 0 ? lo + rng() * (hi - lo) : v));
}

/**
 * Nudge every audible velocity by ±amount (human feel) — the groove keeps its
 * shape, the machine loses its perfection.
 */
export function humanizeVelocities(current: number[], amount = 0.12, rng: () => number = Math.random): number[] {
  const a = Math.max(0, amount);
  return current.map((v) => (v > 0 ? Math.max(FLOOR, Math.min(1, v + (rng() * 2 - 1) * a)) : v));
}
