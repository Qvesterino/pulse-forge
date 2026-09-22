import { describe, expect, it } from "vitest";
import { BUILDERS, DURATIONS, RR_VARIATIONS } from "../src/sample-library/factory";
import { CURATED_SAMPLES } from "../src/sample-library/curated";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { GENRE_KIT_SWAPS } from "../src/intent/genre-kit";
import { KIT_PRESETS } from "../src/project-model/kit-presets";

/**
 * Kick bank coherence (2026-09 expansion 6 → 15 kicks): the manifest is the
 * driver — every Kick asset must have a synth builder, a render duration and
 * (like the rest of the full-kit curation) a curated seed override; every
 * kit/genre reference must point at a real asset. Data-only: the actual
 * audio gate (audible/finite/distinct renders) lives in the real-browser
 * suite (src/browser-checks.ts auditKickBank).
 */

const KICK_IDS = FACTORY_ASSETS.filter((a) => a.category === "Kick").map((a) => a.id);
const ALL_ASSET_IDS = new Set(FACTORY_ASSETS.map((a) => a.id));

describe("kick bank — manifest/builder/duration/curated coherence", () => {
  it("expanded bank: 15 kicks, each with builder + duration + curated seed", () => {
    expect(KICK_IDS).toEqual([
      "factory.kick.deep",
      "factory.kick.punch",
      "factory.kick.techno",
      "factory.kick.sub808",
      "factory.kick.trap",
      "factory.kick.soft",
      "factory.kick.808drive",
      "factory.kick.808pure",
      "factory.kick.drill",
      "factory.kick.phonk",
      "factory.kick.jersey",
      "factory.kick.dnb",
      "factory.kick.lofi",
      "factory.kick.knock",
      "factory.kick.909",
    ]);
    for (const id of KICK_IDS) {
      expect(BUILDERS[id], `${id} builder`).toBeDefined();
      expect(DURATIONS[id], `${id} duration`).toBeGreaterThan(0);
      expect(DURATIONS[id], `${id} duration bounded`).toBeLessThanOrEqual(2);
    }
    const curatedIds = new Set(CURATED_SAMPLES.map((c) => c.id));
    for (const id of KICK_IDS) {
      expect(curatedIds.has(id), `${id} curated seed`).toBe(true);
    }
  });

  it("the nine new kicks target distinct genre pockets", () => {
    const tags = (id: string) => FACTORY_ASSETS.find((a) => a.id === id)?.tags ?? [];
    expect(tags("factory.kick.drill")).toContain("drill");
    expect(tags("factory.kick.phonk")).toContain("phonk");
    expect(tags("factory.kick.jersey")).toContain("jersey");
    expect(tags("factory.kick.dnb")).toContain("dnb");
    expect(tags("factory.kick.808drive")).toContain("808");
    expect(tags("factory.kick.808pure")).toContain("808");
    expect(tags("factory.kick.lofi")).toContain("lofi");
    expect(tags("factory.kick.knock")).toContain("boombap");
    expect(tags("factory.kick.909")).toContain("classic");
    // Moods stay inside the documented vocabulary.
    const moods = new Set(FACTORY_ASSETS.flatMap((a) => a.mood));
    expect(moods.size).toBeLessThanOrEqual(7);
  });

  it("RR variations only reference built kicks with sane rate/gain", () => {
    for (const [base, vars] of Object.entries(RR_VARIATIONS)) {
      expect(BUILDERS[base], `${base} RR base`).toBeDefined();
      for (const v of vars) {
        expect(v.rate).toBeGreaterThan(0.9);
        expect(v.rate).toBeLessThan(1.1);
        expect(v.gain).toBeGreaterThan(0.5);
        expect(v.gain).toBeLessThan(1.5);
      }
    }
    // The punchy new kicks get velocity variation like the originals.
    for (const id of ["factory.kick.jersey", "factory.kick.dnb", "factory.kick.drill", "factory.kick.909"]) {
      expect(RR_VARIATIONS[id], `${id} RR pool`).toBeDefined();
    }
  });
});

describe("kick bank — kit and genre references resolve", () => {
  it("genre kit swaps reference real assets and dedicated kicks up front", () => {
    for (const [genre, swaps] of Object.entries(GENRE_KIT_SWAPS)) {
      for (const swap of swaps ?? []) {
        expect(ALL_ASSET_IDS.has(swap.assetId), `${genre} → ${swap.assetId}`).toBe(true);
      }
    }
    // The dedicated kicks lead their genre kits (expansion's whole point).
    expect(GENRE_KIT_SWAPS.drill?.[0].assetId).toBe("factory.kick.drill");
    expect(GENRE_KIT_SWAPS.phonk?.[0].assetId).toBe("factory.kick.phonk");
    expect(GENRE_KIT_SWAPS.jersey?.[0].assetId).toBe("factory.kick.jersey");
    expect(GENRE_KIT_SWAPS.dnb?.[0].assetId).toBe("factory.kick.dnb");
  });

  it("kit presets only reference real assets — new kicks sit in alt slots", () => {
    for (const kit of KIT_PRESETS) {
      for (const pad of kit.pads) {
        if (pad.assetId !== null) {
          expect(ALL_ASSET_IDS.has(pad.assetId), `${kit.id} pad ${pad.idx} → ${pad.assetId}`).toBe(true);
        }
      }
    }
    const trapKit = KIT_PRESETS.find((k) => k.id === "trap-808")!;
    expect(trapKit.pads[2].assetId).toBe("factory.kick.808pure");
    const rumble = KIT_PRESETS.find((k) => k.id === "dark-rumble")!;
    expect(rumble.pads[1].assetId).toBe("factory.kick.808drive");
    const techno = KIT_PRESETS.find((k) => k.id === "techno-drive")!;
    expect(techno.pads[2].assetId).toBe("factory.kick.909");
  });
});
