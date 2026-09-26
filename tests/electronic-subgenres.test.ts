import { describe, it, expect } from "vitest";
import { getGrooveById } from "../src/ai/grooves";
import { resolveGroove } from "../src/ai/generator";
import { parseIntentText } from "../src/intent/text-parser";
import { matchArtistPreset } from "../src/intent/artists";

/**
 * ELECTRONIC SUB-GENRES — progressive house, trance, classic (Detroit)
 * electro, big beat, moombahton (house × dembow), slap house and deep
 * dubstep 140. Each lane = dedicated groove + parser phrases (with guards
 * for the ambiguous "electro X" family) + researched artists, and three
 * existing compromised lanes upgraded onto their real grooves.
 */

describe("electronic grooves", () => {
  const cases: Array<[string, string, [number, number]]> = [
    ["house.progressive", "Progressive", [124, 128]],
    ["house.bigbeat", "Big Beat", [104, 128]],
    ["house.moombahton", "Moombahton", [105, 112]],
    ["house.slaphouse", "Slap House", [118, 124]],
    ["techno.trance", "Trance", [136, 142]],
    ["techno.electro", "Electro", [126, 134]],
    ["trap.deepdubstep", "Deep Dubstep", [138, 142]],
  ];

  it("all seven exist with researched tempo pockets", () => {
    for (const [id, name, bpm] of cases) {
      const groove = getGrooveById(id);
      expect(groove, id).toBeDefined();
      expect(groove!.name, id).toBe(name);
      expect(groove!.bpm, id).toEqual(bpm);
    }
  });

  it("patterns are well-formed 16-step rows over kit pads", () => {
    for (const [id] of cases) {
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

  it("styles resolve deterministically to the new grooves", () => {
    expect(resolveGroove("house", "progressive").id).toBe("house.progressive");
    expect(resolveGroove("house", "bigbeat").id).toBe("house.bigbeat");
    expect(resolveGroove("house", "moombahton").id).toBe("house.moombahton");
    expect(resolveGroove("house", "slaphouse").id).toBe("house.slaphouse");
    expect(resolveGroove("techno", "trance").id).toBe("techno.trance");
    expect(resolveGroove("techno", "electro").id).toBe("techno.electro");
    expect(resolveGroove("trap", "deepdubstep").id).toBe("trap.deepdubstep");
  });
});

describe("electronic parser phrases", () => {
  it("progressive house rides its own groove", () => {
    for (const text of ["progressive house", "prog house"]) {
      const parsed = parseIntentText(text);
      expect(parsed.input.genre, text).toBe("house");
      expect(parsed.input.style, text).toBe("progressive");
    }
  });

  it("trance resolves to the dedicated groove; psytrance stays psytrance", () => {
    for (const text of ["trance", "uplifting trance", "vocal trance"]) {
      const parsed = parseIntentText(text);
      expect(parsed.input.genre, text).toBe("techno");
      expect(parsed.input.style, text).toBe("trance");
    }
    expect(parseIntentText("psytrance").input.style).toBe("psytrance");
  });

  it("the electro family: bare = detroit, compounds keep their lanes", () => {
    expect(parseIntentText("electro").input).toMatchObject({ genre: "techno", style: "electro" });
    expect(parseIntentText("electro funk").input).toMatchObject({ genre: "techno", style: "electro" });
    expect(parseIntentText("electro house").input).toMatchObject({ genre: "house", style: "dancefloor" });
    expect(parseIntentText("electro pop").input).toMatchObject({ genre: "house", style: "pop" });
    expect(parseIntentText("electro swing").input).toMatchObject({ genre: "house", style: "funky" });
    expect(parseIntentText("electro hip hop").input).toMatchObject({ genre: "trap", style: "oldschool" });
  });

  it("big beat / moombahton / slap house / deep dubstep route", () => {
    expect(parseIntentText("big beat").input).toMatchObject({ genre: "house", style: "bigbeat" });
    expect(parseIntentText("breakbeat").input).toMatchObject({ genre: "house", style: "bigbeat" });
    expect(parseIntentText("moombahton").input).toMatchObject({ genre: "house", style: "moombahton" });
    expect(parseIntentText("slap house").input).toMatchObject({ genre: "house", style: "slaphouse" });
    expect(parseIntentText("brazilian bass").input).toMatchObject({ genre: "house", style: "slaphouse" });
    expect(parseIntentText("deep dubstep").input).toMatchObject({ genre: "trap", style: "deepdubstep" });
    expect(parseIntentText("140 dubstep").input).toMatchObject({ genre: "trap", style: "deepdubstep" });
    // bare dubstep keeps the brostep/riddim lane
    expect(parseIntentText("dubstep").input).toMatchObject({ genre: "trap", style: "dubstep" });
  });

  it("progressive trance rides the trance groove (trance above progressive)", () => {
    expect(parseIntentText("progressive trance").input).toMatchObject({ genre: "techno", style: "trance" });
  });
});

describe("electronic artists", () => {
  it("progressive + trance quartet resolves", () => {
    expect(matchArtistPreset("eric prydz type beat")?.preset).toMatchObject({
      style: "progressive",
      bpmRange: [124, 128],
    });
    expect(matchArtistPreset("deadmau5")?.preset.style).toBe("progressive");
    expect(matchArtistPreset("john digweed")?.preset.style).toBe("progressive");
    expect(matchArtistPreset("above and beyond")?.preset).toMatchObject({
      style: "trance",
      bpmRange: [132, 138],
    });
    expect(matchArtistPreset("paul van dyk")?.preset.bpmRange).toEqual([134, 142]);
  });

  it("electro / moombahton / slap house / deep dubstep lanes resolve", () => {
    expect(matchArtistPreset("egyptian lover")?.preset).toMatchObject({ style: "electro", bpmRange: [120, 132] });
    expect(matchArtistPreset("dillon francis")?.preset.style).toBe("moombahton");
    expect(matchArtistPreset("major lazer")?.preset.bpmRange).toEqual([100, 112]);
    expect(matchArtistPreset("imanbek")?.preset.style).toBe("slaphouse");
    expect(matchArtistPreset("meduza")?.preset.bpmRange).toEqual([120, 126]);
    expect(matchArtistPreset("skream")?.preset).toMatchObject({ style: "deepdubstep", bpmRange: [138, 142] });
    expect(matchArtistPreset("digital mystikz")?.preset.bpmRange).toEqual([140, 142]);
  });

  it("compromised lanes upgraded onto their real grooves", () => {
    // trance lane was driving techno; electro lanes were driving; big beat
    // was the Overmono broken groove
    expect(matchArtistPreset("tiesto")?.preset.style).toBe("trance");
    expect(matchArtistPreset("juan atkins")?.preset.style).toBe("electro");
    expect(matchArtistPreset("drexciya")?.preset.style).toBe("electro");
    expect(matchArtistPreset("chemical brothers")?.preset.style).toBe("bigbeat");
  });
});
