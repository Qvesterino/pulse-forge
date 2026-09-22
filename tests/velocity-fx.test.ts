/**
 * Velocity FX — randomize/humanize helpers for selections.
 * Contract: silence stays silent, values stay in [0.05, 1].
 */
import { describe, expect, it } from "vitest";
import { humanizeVelocities, randomizeVelocities } from "../src/shared/velocityFx";

describe("randomizeVelocities", () => {
  it("spreads audible velocities across 0.45–1", () => {
    const out = randomizeVelocities([0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8]);
    expect(out).toHaveLength(8);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0.44);
      expect(v).toBeLessThanOrEqual(1.0001);
    }
    // effectively random: not all identical
    expect(new Set(out.map((v) => v.toFixed(3))).size).toBeGreaterThan(1);
  });

  it("silence stays silent — randomize never creates notes", () => {
    const out = randomizeVelocities([0.9, 0, 0, 0.7]);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it("respects a custom range", () => {
    const out = randomizeVelocities([0.5, 0.5, 0.5], 0.2, 0.3);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0.19);
      expect(v).toBeLessThanOrEqual(0.31);
    }
  });
});

describe("humanizeVelocities", () => {
  it("stays within ±amount of the original", () => {
    const out = humanizeVelocities([0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6], 0.12);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0.48);
      expect(v).toBeLessThanOrEqual(0.72);
    }
  });

  it("keeps the groove shape — relative order never changes by more than amount", () => {
    const groove = [0.4, 0.9, 0.6, 0.5];
    const out = humanizeVelocities(groove, 0.08);
    for (let i = 0; i < groove.length; i++) {
      expect(Math.abs(out[i] - groove[i])).toBeLessThanOrEqual(0.0801);
    }
  });

  it("silence stays silent and values clamp into [0.05, 1]", () => {
    const out = humanizeVelocities([0.03, 0, 0.99], 0.2);
    expect(out[0]).toBeGreaterThanOrEqual(0.05);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeLessThanOrEqual(1);
  });
});

// ── GOAL 09: seeded determinism contract ────────────────────────────────────
// With an injected rng the output is a pure function of (input, rng). UI
// callers keep the Math.random default (intentional creative rolls — the
// computed values are baked into their commands, so replay is stable anyway).

import { mulberry32 } from "../src/shared/rng";

const CURRENT = [0, 0.5, 0.8, 0, 1, 0.3];

describe("velocityFx determinism (GOAL 09)", () => {
  it("same seed → identical output (pure function of input + rng)", () => {
    expect(randomizeVelocities(CURRENT, 0.45, 1, mulberry32(42))).toEqual(
      randomizeVelocities(CURRENT, 0.45, 1, mulberry32(42)),
    );
    expect(humanizeVelocities(CURRENT, 0.12, mulberry32(7))).toEqual(humanizeVelocities(CURRENT, 0.12, mulberry32(7)));
  });

  it("different seeds produce different rolls", () => {
    expect(randomizeVelocities(CURRENT, 0.45, 1, mulberry32(1))).not.toEqual(
      randomizeVelocities(CURRENT, 0.45, 1, mulberry32(2)),
    );
  });
});
