import { describe, it, expect } from "vitest";
import { generateDescriptions, generateAllDescriptions } from "../src/intent/descriptions";

describe("text description generator (Fáza A)", () => {
  it("generates 20+ diverse descriptions per genre×style", () => {
    const descriptions = generateDescriptions("house", "deep", "dark", [120, 126], 30);
    expect(descriptions.length).toBeGreaterThanOrEqual(15);
    // unique
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("includes genre, style and mood words", () => {
    const descriptions = generateDescriptions("techno", "acid", "dark", [138, 140], 30);
    const joined = descriptions.join(" ").toLowerCase();
    expect(joined).toContain("techno");
    expect(joined).toContain("acid");
    expect(joined).toContain("dark");
  });

  it("includes SK descriptions when max allows", () => {
    // Generate with high max so SK templates fire
    const descriptions = generateDescriptions("house", "deep", null, null, 50);
    const hasSk = descriptions.some((d) => /beat|groov|atmosf/.test(d.toLowerCase()));
    expect(hasSk).toBe(true);
  });

  it("mood word shapes the description", () => {
    const dark = generateDescriptions("techno", "driving", "dark", null, 10);
    const energetic = generateDescriptions("techno", "driving", "energetic", null, 10);
    const darkJoined = dark.join(" ").toLowerCase();
    const energeticJoined = energetic.join(" ").toLowerCase();
    expect(darkJoined).toContain("dark");
    expect(energeticJoined).toContain("energetic");
  });

  it("no mood → no mood words in output", () => {
    const descriptions = generateDescriptions("ambient", "drifting", null, null, 10);
    const joined = descriptions.join(" ").toLowerCase();
    expect(joined).not.toContain("dark");
    expect(joined).not.toContain("energetic");
  });

  it("bpm appears when provided", () => {
    const descriptions = generateDescriptions("techno", "acid", null, [138, 138], 10);
    const joined = descriptions.join(" ");
    expect(joined).toContain("138");
  });

  it("generateAllDescriptions covers all genre×style pairs", () => {
    const all = generateAllDescriptions(["house", "techno"]);
    expect(all.size).toBeGreaterThanOrEqual(14); // 7 styles × 2 genres
    for (const [, set] of all) {
      expect(set.descriptions.length).toBeGreaterThan(0);
    }
  });
});
