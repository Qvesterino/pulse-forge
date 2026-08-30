import { describe, it, expect } from "vitest";
import { nextSeed, seedAt, jitterControls, pickStyle, throwDice } from "../src/shared/dice";
import type { IntentControls } from "../src/intent/types";

describe("dice core", () => {
  it("nextSeed is deterministic", () => {
    expect(nextSeed("abc")).toBe(nextSeed("abc"));
    expect(nextSeed("abc", "dice")).toBe(nextSeed("abc", "dice"));
  });
  it("nextSeed varies with salt and input", () => {
    expect(nextSeed("abc")).not.toBe(nextSeed("abc", "other"));
    expect(nextSeed("abc")).not.toBe(nextSeed("xyz"));
  });
  it("nextSeed produces 6-char base36", () => {
    for (let i = 0; i < 20; i++) {
      const s = nextSeed(`seed-${i}`);
      expect(s).toMatch(/^[0-9a-z]{6}$/);
    }
  });
  it("seedAt advances deterministically", () => {
    expect(seedAt("root", 0)).toBe("root");
    expect(seedAt("root", 1)).toBe(nextSeed("root"));
    expect(seedAt("root", 3)).toBe(nextSeed(nextSeed(nextSeed("root"))));
    // 100-step chain is stable
    const chain: string[] = ["start"];
    for (let i = 0; i < 100; i++) chain.push(nextSeed(chain[chain.length - 1]));
    expect(seedAt("start", 100)).toBe(chain[chain.length - 1]);
  });
  it("jitterControls is identity at 0", () => {
    const base: IntentControls = { ghostWeight: 0.3, microWeight: 0.2, velocityVariation: 0.3, temperature: 1.0 };
    expect(jitterControls("seed", base, 0)).toEqual(base);
  });
  it("jitterControls stays in bounds at amount=1", () => {
    const base: IntentControls = { ghostWeight: 0.5, microWeight: 0.5, velocityVariation: 0.5, temperature: 1.0 };
    for (let i = 0; i < 50; i++) {
      const j = jitterControls(`seed-${i}`, base, 1);
      expect(j.ghostWeight).toBeGreaterThanOrEqual(0);
      expect(j.ghostWeight).toBeLessThanOrEqual(1);
      expect(j.microWeight).toBeGreaterThanOrEqual(0);
      expect(j.microWeight).toBeLessThanOrEqual(1);
      expect(j.velocityVariation).toBeGreaterThanOrEqual(0);
      expect(j.velocityVariation).toBeLessThanOrEqual(1);
      expect(j.temperature).toBeGreaterThanOrEqual(0.2);
      expect(j.temperature).toBeLessThanOrEqual(2);
    }
  });
  it("jitterControls is deterministic", () => {
    const base: IntentControls = { ghostWeight: 0.3, microWeight: 0.2, velocityVariation: 0.3, temperature: 1.0 };
    expect(jitterControls("hello", base, 0.5)).toEqual(jitterControls("hello", base, 0.5));
    expect(jitterControls("hello", base, 0.5)).not.toEqual(jitterControls("world", base, 0.5));
  });
  it("pickStyle is deterministic and valid", () => {
    const s1 = pickStyle("seed1", "house", null);
    const s2 = pickStyle("seed1", "house", null);
    expect(s1).toBe(s2);
    if (s1) expect(typeof s1).toBe("string");
  });
  it("throwDice value in range and deterministic", () => {
    const a = throwDice("seedA", 6);
    const b = throwDice("seedA", 6);
    expect(a.value).toBe(b.value);
    expect(a.value).toBeGreaterThanOrEqual(1);
    expect(a.value).toBeLessThanOrEqual(6);
    expect(a.nextSeed).toBe(nextSeed("seedA", `throw:${a.value}`));
  });
});
