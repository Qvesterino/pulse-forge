import { describe, it, expect } from "vitest";
import { getGrooveById } from "../src/ai/grooves";
import { resolveGroove } from "../src/ai/generator";
import { parseIntentText } from "../src/intent/text-parser";
import { normalizeIntent } from "../src/intent/normalize";
import { planSongForm } from "../src/intent/song";
import { matchArtistPreset } from "../src/intent/artists";

/**
 * METAL / HARDCORE / PUNK / INDIE depth — seven grooves from research:
 * heavy metal (gallop 100-140), thrash (driving 8th kicks 140-180),
 * metalcore (the half-time breakdown at full tempo, 140-170), doom (the
 * slow crush 50-80), hardcore punk (150-190), pop punk (148-175) and indie
 * (garage-groove revival 100-130). All ride the rock-radio song form.
 */

describe("metal/punk/indie grooves", () => {
  const cases: Array<[string, string, [number, number]]> = [
    ["house.metal", "Metal", [100, 140]],
    ["house.thrash", "Thrash", [140, 180]],
    ["house.metalcore", "Metalcore", [140, 170]],
    ["house.doom", "Doom", [50, 80]],
    ["house.hardcorepunk", "Hardcore Punk", [150, 190]],
    ["house.poppunk", "Pop Punk", [148, 175]],
    ["house.indie", "Indie", [100, 130]],
  ];

  it("all seven exist with researched pockets", () => {
    for (const [id, name, bpm] of cases) {
      const groove = getGrooveById(id);
      expect(groove, id).toBeDefined();
      expect(groove!.name, id).toBe(name);
      expect(groove!.bpm, id).toEqual(bpm);
    }
  });

  it("every groove keeps a rock backbeat — 2+4, or half-time for doom", () => {
    for (const [id] of cases) {
      const groove = getGrooveById(id)!;
      const first = groove.patterns[0]!;
      const snareAt = (step: number) => [4, 5, 6].some((pad) => (first[pad]?.[step] ?? 0) > 0);
      if (id === "house.doom") {
        // doom is the half-time crush — the snare lands on beat 3
        expect(snareAt(8), `${id} half-time snare`).toBe(true);
      } else {
        expect(snareAt(4) && snareAt(12), `${id} must hit the 2+4 backbeat`).toBe(true);
      }
    }
  });

  it("metalcore's breakdown pattern is half-time (snare on 3, not 2)", () => {
    const core = getGrooveById("house.metalcore")!;
    const breakdown = core.patterns[1]!;
    // the crush lands the snare on beat 3 (step 8) with beats 2/4 empty
    expect((breakdown[4]?.[8] ?? 0) + (breakdown[5]?.[8] ?? 0)).toBeGreaterThan(0);
    expect((breakdown[4]?.[4] ?? 0) + (breakdown[5]?.[4] ?? 0)).toBe(0);
  });

  it("thrash drives 8th kicks; doom crawls", () => {
    const thrash = getGrooveById("house.thrash")!;
    const doom = getGrooveById("house.doom")!;
    // thrash: every 8th has a kick
    const thrashKick = thrash.patterns[0]![0] ?? [];
    expect([0, 2, 4, 6, 8, 10, 12, 14].every((s) => (thrashKick[s] ?? 0) > 0)).toBe(true);
    // doom: barely anything — the void is the point
    const doomKick = doom.patterns[0]![0] ?? [];
    expect(doomKick.filter((v) => v > 0).length).toBeLessThanOrEqual(2);
  });

  it("styles resolve deterministically", () => {
    for (const style of ["metal", "thrash", "metalcore", "doom", "hardcorepunk", "poppunk", "indie"]) {
      expect(resolveGroove("house", style).id).toBe(`house.${style}`);
    }
  });
});

describe("metal/punk/indie parser", () => {
  it("metal family routes with nu metal protected for rapcore", () => {
    expect(parseIntentText("heavy metal").input.style).toBe("metal");
    expect(parseIntentText("metal").input.style).toBe("metal");
    expect(parseIntentText("thrash").input.style).toBe("thrash");
    expect(parseIntentText("metalcore").input.style).toBe("metalcore");
    expect(parseIntentText("doom metal").input.style).toBe("doom");
    expect(parseIntentText("doom").input.style).toBe("doom");
    // the rapcore alias keeps winning over the bare metal word
    expect(parseIntentText("nu metal").input.style).toBe("rapcore");
  });

  it("punk specifics and indie route", () => {
    expect(parseIntentText("hardcore punk").input).toMatchObject({ genre: "house", style: "hardcorepunk" });
    expect(parseIntentText("hardcore").input.style).toBe("hardcorepunk");
    expect(parseIntentText("pop punk").input).toMatchObject({ genre: "house", style: "poppunk" });
    expect(parseIntentText("indie").input).toMatchObject({ genre: "house", style: "indie" });
    expect(parseIntentText("indie rock").input.style).toBe("indie");
  });

  it("existing lanes stay put", () => {
    expect(parseIntentText("post-punk").input.genre).toBe("techno");
    expect(parseIntentText("synth punk").input.style).toBe("synthpunk");
    expect(parseIntentText("grunge").input.style).toBe("grunge");
    expect(parseIntentText("rapcore").input.style).toBe("rapcore");
  });
});

describe("metal/punk/indie song form", () => {
  it("all seven ride the rock-radio form", () => {
    for (const style of ["metal", "thrash", "metalcore", "doom", "hardcorepunk", "poppunk", "indie"]) {
      const form = planSongForm(normalizeIntent({ genre: "house", style, seed: "metal-form" }));
      const labels = form.sections.map((s) => s.label);
      expect(labels, style).toContain("Pre-Chorus");
      expect(
        labels.some((label) => /DROP/.test(label)),
        style,
      ).toBe(false);
    }
  });
});

describe("metal/punk/indie artists", () => {
  it("thrash / doom / metalcore resolve", () => {
    expect(matchArtistPreset("metallica type beat")?.preset).toMatchObject({ style: "thrash", bpmRange: [110, 175] });
    expect(matchArtistPreset("slayer")?.preset.style).toBe("thrash");
    expect(matchArtistPreset("black sabbath")?.preset).toMatchObject({ style: "doom", bpmRange: [55, 100] });
    expect(matchArtistPreset("bmth")?.preset.style).toBe("metalcore");
  });

  it("hardcore / pop punk / indie resolve", () => {
    expect(matchArtistPreset("black flag")?.preset.style).toBe("hardcorepunk");
    expect(matchArtistPreset("minor threat")?.preset.bpmRange).toEqual([155, 190]);
    expect(matchArtistPreset("green day")?.preset.style).toBe("poppunk");
    expect(matchArtistPreset("blink 182")?.preset.bpmRange).toEqual([148, 174]);
    expect(matchArtistPreset("the strokes")?.preset).toMatchObject({ style: "indie", bpmRange: [105, 130] });
    expect(matchArtistPreset("arctic monkeys")?.preset.style).toBe("indie");
  });
});
