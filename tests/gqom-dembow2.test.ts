import { describe, it, expect } from "vitest";
import { getGrooveById } from "../src/ai/grooves";
import { resolveGroove } from "../src/ai/generator";
import { parseIntentText } from "../src/intent/text-parser";
import { matchArtistPreset } from "../src/intent/artists";

/**
 * GQOM + DEMBOW 2.0 (researched wave) — the Durban broken-kick mutation
 * (NO four-on-the-floor, pounding log toms) and the two modern dembow lanes:
 * dominicano (same chop, every 16th filled — feels twice as fast) and
 * neoperreo (the DIY deconstructed alias riding the classic chop). The
 * existing footwork/juke lane is pinned untouched.
 */

describe("gqom + dembow 2.0 grooves", () => {
  it("gqom has NO four-on-the-floor kick (the defining feature)", () => {
    const gqom = getGrooveById("house.gqom")!;
    expect(gqom).toBeDefined();
    expect(gqom.bpm).toEqual([115, 128]);
    // every pattern must break the 0/4/8/12 kick grid somewhere
    for (const pattern of gqom.patterns) {
      const kick = pattern[0] ?? [];
      const onFloor = [0, 4, 8, 12].every((step) => (kick[step] ?? 0) > 0);
      expect(onFloor, JSON.stringify(kick)).toBe(false);
    }
    // the log-drum toms carry the answer
    expect(gqom.activePads).toContain(12);
    expect(gqom.activePads).toContain(13);
    expect(resolveGroove("house", "gqom").id).toBe("house.gqom");
  });

  it("dembow dominicano is a faster-feeling chop beside the classic", () => {
    const dom = getGrooveById("house.dembowdom")!;
    const classic = getGrooveById("house.dembow")!;
    expect(dom.bpm![0]).toBeGreaterThan(classic.bpm![0]); // 100 vs 88
    expect(resolveGroove("house", "dembowdom").id).toBe("house.dembowdom");
    expect(resolveGroove("house", "dembow").id).toBe("house.dembow");
  });

  it("both grooves are well-formed over the default kit", () => {
    for (const id of ["house.gqom", "house.dembowdom"]) {
      const groove = getGrooveById(id)!;
      expect(groove.patterns.length, id).toBeGreaterThanOrEqual(3);
      for (const pattern of groove.patterns) {
        for (const [pad, row] of Object.entries(pattern)) {
          expect(Number(pad), id).toBeLessThanOrEqual(15);
          expect(row).toHaveLength(16);
          expect(
            row.some((v) => v > 0),
            id,
          ).toBe(true);
        }
      }
    }
  });
});

describe("gqom + dembow 2.0 parser", () => {
  it("gqom routes to house with its own style", () => {
    expect(parseIntentText("gqom").input).toMatchObject({ genre: "house", style: "gqom" });
  });

  it("dembow dominicano / neoperreo resolve beside the classic chop", () => {
    expect(parseIntentText("dembow dominicano").input).toMatchObject({ genre: "house", style: "dembowdom" });
    expect(parseIntentText("dominican dembow").input.style).toBe("dembowdom");
    // neoperreo = the DIY alias riding the classic chop
    expect(parseIntentText("neoperreo").input).toMatchObject({ genre: "house", style: "dembow" });
    expect(parseIntentText("neo perreo beat").input.style).toBe("dembow");
    // the classic lanes stay put
    expect(parseIntentText("reggaeton").input.style).toBe("dembow");
    expect(parseIntentText("moombahton").input.style).toBe("moombahton");
  });
});

describe("gqom + dembow 2.0 artists", () => {
  it("Durban and Santo Domingo lanes resolve", () => {
    expect(matchArtistPreset("dj lag")?.preset).toMatchObject({ style: "gqom", bpmRange: [115, 128] });
    expect(matchArtistPreset("distruction boyz")?.preset.style).toBe("gqom");
    expect(matchArtistPreset("el alfa")?.preset).toMatchObject({ style: "dembowdom", bpmRange: [100, 112] });
    expect(matchArtistPreset("rochy rd")?.preset.style).toBe("dembowdom");
  });

  it("neoperreo flagships ride the classic chop", () => {
    expect(matchArtistPreset("tomasa del real")?.preset).toMatchObject({ style: "dembow", bpmRange: [88, 100] });
    expect(matchArtistPreset("ms nina")?.preset.style).toBe("dembow");
  });

  it("the existing footwork/juke lane is untouched", () => {
    expect(matchArtistPreset("dj rashad")?.preset).toMatchObject({ style: "footwork", bpmRange: [155, 165] });
    expect(resolveGroove("house", "footwork").id).toBe("house.footwork");
  });
});
