import { describe, it, expect } from "vitest";
import { getGrooveById } from "../src/ai/grooves";
import { resolveGroove } from "../src/ai/generator";
import { parseIntentText } from "../src/intent/text-parser";
import { matchArtistPreset } from "../src/intent/artists";

/**
 * SPECIFIC SUB-GENRES (researched wave) — UK funky (London soca-bounce,
 * ~130 BPM), Baltimore club (the jersey parent, "Think"-break stomp at
 * 125-135 — NOT the folk-96 myth) and jungle (the 1994 chopped-breaks
 * original at 155-170, distinct from both dnb.roller and dnb.amen).
 */

describe("specific grooves", () => {
  it("uk funky is the soca bounce at ~130", () => {
    const groove = getGrooveById("house.ukfunky");
    expect(groove).toBeDefined();
    expect(groove!.bpm).toEqual([125, 130]);
    expect(groove!.swing).toBeGreaterThan(0.08); // soca lilt
    expect(resolveGroove("house", "ukfunky").id).toBe("house.ukfunky");
  });

  it("baltimore is the break stomp, slower than jersey club", () => {
    const baltimore = getGrooveById("jersey.baltimore");
    const club = getGrooveById("jersey.club");
    expect(baltimore).toBeDefined();
    expect(baltimore!.bpm).toEqual([125, 135]);
    expect(baltimore!.bpm![0]).toBeLessThan(club!.bpm![0]); // the parent is slower
    expect(resolveGroove("jersey", "baltimore").id).toBe("jersey.baltimore");
  });

  it("jungle is the chopped-breaks pocket beside roller and amen", () => {
    const jungle = getGrooveById("dnb.jungle");
    expect(jungle).toBeDefined();
    expect(jungle!.bpm![0]).toBeGreaterThanOrEqual(155);
    // distinct pocket: jungle chops ghost snares, roller rides smooth
    expect(jungle!.patterns.some((p) => p[5]?.some((v) => v > 0))).toBe(true);
    expect(resolveGroove("dnb", "jungle").id).toBe("dnb.jungle");
  });

  it("all three are well-formed over the default kit", () => {
    for (const id of ["house.ukfunky", "jersey.baltimore", "dnb.jungle"]) {
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

describe("specific parser phrases", () => {
  it("uk funky carries its own style (not stolen by \\bfunky\\b)", () => {
    const parsed = parseIntentText("uk funky");
    expect(parsed.input.style).toBe("ukfunky");
    // the funky lane itself is untouched
    expect(parseIntentText("funky house").input.style).toBe("funky");
  });

  it("jungle / ragga jungle ride the jungle groove", () => {
    for (const text of ["jungle", "ragga jungle", "jungle 165"]) {
      const parsed = parseIntentText(text);
      expect(parsed.input.genre, text).toBe("dnb");
      expect(parsed.input.style, text).toBe("jungle");
    }
    // dnb lanes around it stay put
    expect(parseIntentText("liquid dnb").input.style).toBe("liquid");
    expect(parseIntentText("roller").input.style).toBe("roller");
  });

  it("baltimore club rides the stomp groove", () => {
    for (const text of ["baltimore club", "bmore club", "baltimore"]) {
      const parsed = parseIntentText(text);
      expect(parsed.input.genre, text).toBe("jersey");
      expect(parsed.input.style, text).toBe("baltimore");
    }
    // jersey generic unaffected
    expect(parseIntentText("jersey club").input.style).not.toBe("baltimore");
  });
});

describe("specific artists", () => {
  it("uk funky: roska / lil silva resolve on the soca groove", () => {
    expect(matchArtistPreset("roska type beat")?.preset).toMatchObject({
      style: "ukfunky",
      bpmRange: [125, 130],
    });
    expect(matchArtistPreset("lil silva")?.preset.style).toBe("ukfunky");
  });

  it("jungle: remarc / dj hype on the chop; ragga lanes keep amen", () => {
    expect(matchArtistPreset("remarc")?.preset).toMatchObject({ style: "jungle", bpmRange: [155, 165] });
    expect(matchArtistPreset("dj hype")?.preset.style).toBe("jungle");
    expect(matchArtistPreset("congo natty")?.preset.style).toBe("amen");
    expect(matchArtistPreset("shy fx")?.preset.style).toBe("amen");
  });

  it("baltimore lanes upgraded onto the stomp groove", () => {
    expect(matchArtistPreset("k-swift")?.preset.style).toBe("baltimore");
    expect(matchArtistPreset("rod lee")?.preset.style).toBe("baltimore");
  });
});
