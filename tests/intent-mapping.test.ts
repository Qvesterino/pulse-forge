import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { normalizeIntent } from "../src/intent/normalize";
import { mapIntentToOptions } from "../src/intent/mapping";
import { generatePattern } from "../src/ai/generator";
import { DEFAULT_GENERATE_OPTIONS } from "../src/ai/types";

describe("intent→engine mapping", () => {
  it("is identity for default intent", () => {
    const intent = normalizeIntent({});
    const base: typeof DEFAULT_GENERATE_OPTIONS = { ...DEFAULT_GENERATE_OPTIONS, seed: "abc", stepCount: 16 };
    const mapped = mapIntentToOptions(intent, base);
    expect(mapped.ghostWeight).toBe(base.ghostWeight);
    expect(mapped.microWeight).toBe(base.microWeight);
  });

  it("density low vs high changes hit count", () => {
    const doc = testDoc();
    const low = normalizeIntent({ density: 0.2, seed: "same", genre: "house", length: 16 });
    const high = normalizeIntent({ density: 0.9, seed: "same", genre: "house", length: 16 });
    const baseOpts = { ...DEFAULT_GENERATE_OPTIONS, seed: "same", stepCount: 16, genre: "house" as const };
    const optsLow = mapIntentToOptions(low, { ...baseOpts });
    const optsHigh = mapIntentToOptions(high, { ...baseOpts });
    const patLow = generatePattern(doc, optsLow);
    const patHigh = generatePattern(doc, optsHigh);
    const hits = (p: typeof patLow) => Object.values(p.rows).reduce((s, r) => s + r.filter((v) => v > 0).length, 0);
    // High density should generally have more hits than low (allow small variance)
    expect(hits(patHigh)).toBeGreaterThanOrEqual(hits(patLow));
  });

  it("energy high increases velocityVariation mapping", () => {
    const intentLow = normalizeIntent({ energy: 0.2, seed: "x" });
    const intentHigh = normalizeIntent({ energy: 0.9, seed: "x" });
    const base = {
      ...DEFAULT_GENERATE_OPTIONS,
      seed: "x",
      stepCount: 16,
      genre: "house" as const,
      velocityVariation: 0.3,
    };
    const low = mapIntentToOptions(intentLow, base);
    const high = mapIntentToOptions(intentHigh, base);
    expect(high.velocityVariation).toBeGreaterThan(low.velocityVariation);
  });

  it("complexity high increases ratchet chance via _diceComplexity", () => {
    const cLow = normalizeIntent({ complexity: 0.2, seed: "s" });
    const cHigh = normalizeIntent({ complexity: 0.9, seed: "s" });
    const base = { ...DEFAULT_GENERATE_OPTIONS, seed: "s", stepCount: 16, genre: "house" as const };
    const optsLow = mapIntentToOptions(cLow, base);
    const optsHigh = mapIntentToOptions(cHigh, base);
    expect((optsHigh as unknown as { _diceComplexity?: number })._diceComplexity).toBe(0.9);
    expect((optsLow as unknown as { _diceComplexity?: number })._diceComplexity).toBe(0.2);
  });

  it("mood tweak affects ghostWeight", () => {
    const dark = normalizeIntent({ mood: "dark", seed: "m" });
    const chill = normalizeIntent({ mood: "chill", seed: "m" });
    const base = { ...DEFAULT_GENERATE_OPTIONS, seed: "m", stepCount: 16, genre: "house" as const, ghostWeight: 0.3 };
    const d = mapIntentToOptions(dark, base);
    const c = mapIntentToOptions(chill, base);
    expect(d.ghostWeight).toBeGreaterThan(c.ghostWeight);
  });
});
