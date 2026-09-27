import { describe, it, expect } from "vitest";
import { getGrooveById } from "../src/ai/grooves";
import { resolveGroove } from "../src/ai/generator";
import { parseIntentText } from "../src/intent/text-parser";
import { matchArtistPreset } from "../src/intent/artists";

/**
 * GHETTOTECH + ALTÉ (researched wave) — Detroit's torqued-up Miami bass
 * (banging 808 bounce at 130-140, slower than the juke/footwork floor) and
 * the Lagos alternative lane (R&B/soul-tinged afrobeats riding the afropop
 * pocket). Afro tech maps onto the organic groove as its harder cousin.
 */

describe("ghettotech groove", () => {
  it("is the banging 808 pocket, slower than the juke floor", () => {
    const gt = getGrooveById("house.ghettotech")!;
    const footwork = getGrooveById("house.footwork")!;
    expect(gt).toBeDefined();
    expect(gt.bpm).toEqual([130, 140]);
    expect(gt.bpm![0]).toBeLessThan(footwork.bpm![0]); // ghettotech < footwork tempo
    expect(resolveGroove("house", "ghettotech").id).toBe("house.ghettotech");
  });

  it("carries the booty-bounce pickups and hard claps", () => {
    const gt = getGrooveById("house.ghettotech")!;
    expect(gt.activePads).toContain(6); // claps
    expect(gt.activePads).toContain(1); // kick punch double
    for (const pattern of gt.patterns) {
      const kick = pattern[0] ?? [];
      // syncopated pickups off the 0/8 grid (the Miami bass bounce)
      expect([3, 6, 7, 10, 11, 14, 15].some((step) => (kick[step] ?? 0) > 0)).toBe(true);
    }
  });

  it("is well-formed over the default kit", () => {
    const gt = getGrooveById("house.ghettotech")!;
    expect(gt.patterns.length).toBeGreaterThanOrEqual(3);
    for (const pattern of gt.patterns) {
      for (const [pad, row] of Object.entries(pattern)) {
        expect(Number(pad)).toBeLessThanOrEqual(15);
        expect(row).toHaveLength(16);
        expect(row.some((v) => v > 0)).toBe(true);
      }
    }
  });
});

describe("ghettotech + alte parser", () => {
  it("ghettotech / afro tech / alte resolve to their lanes", () => {
    expect(parseIntentText("ghettotech").input).toMatchObject({ genre: "house", style: "ghettotech" });
    expect(parseIntentText("ghetto tech").input.style).toBe("ghettotech");
    expect(parseIntentText("afro tech").input).toMatchObject({ genre: "house", style: "organic" });
    expect(parseIntentText("alte").input).toMatchObject({ genre: "house", style: "afropop" });
  });

  it("neighbours stay put", () => {
    expect(parseIntentText("g-house").input.style).toBe("ghouse");
    expect(parseIntentText("afro house").input.style).toBe("afro");
    expect(parseIntentText("footwork").input.style).toBe("footwork");
    // "alternative" never hijacks the alté word
    const alt = parseIntentText("alternative vibe");
    expect(alt.input.style).not.toBe("afropop");
  });
});

describe("ghettotech + alte artists", () => {
  it("the Detroit floor resolves", () => {
    expect(matchArtistPreset("dj godfather")?.preset).toMatchObject({
      style: "ghettotech",
      bpmRange: [130, 140],
    });
    expect(matchArtistPreset("dj assault")?.preset.style).toBe("ghettotech");
    expect(matchArtistPreset("dj funk")?.preset.bpmRange).toEqual([128, 140]);
  });

  it("the Lagos alternative lane resolves", () => {
    expect(matchArtistPreset("odunsi")?.preset).toMatchObject({ style: "afropop", bpmRange: [90, 105] });
    expect(matchArtistPreset("lady donli")?.preset.style).toBe("afropop");
    expect(matchArtistPreset("santi")?.preset.mood).toBe("chill");
  });
});
