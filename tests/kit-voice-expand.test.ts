import { describe, it, expect } from "vitest";
import { KIT_PRESETS, getKitPresetsForGenre, resolveKitPreset } from "../src/project-model/kit-presets";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { FACTORY_PRESETS } from "../src/presets/factory";

/**
 * KIT + VOICE EXPAND (2026-10-09) — closes the "asset exists, nothing selects
 * it" gap from the bass/lead/cymbal/world-perc expand waves:
 *
 * - Three genre kits (Latin Percussion / Jazz Combo / Rock Backline) put the
 *   new percussion voices into the dice kit pool, which previously drew from
 *   8 kits that could never select china, jazz ride wash, bongos, timbale,
 *   tabla, cajón, agogô, fast shaker or crash roll.
 * - Thirteen sampler presets give every new melodic bank voice (bass 808
 *   trio, sub sine/square, upright, acid pair, five synth leads) at least one
 *   factory preset that references it — preset-intent and dice resolve BY
 *   preset, so a voice with no preset was unreachable.
 *
 * The tuning-anchor and loudness contracts stay in tests/bass-pack.test.ts
 * and tests/sound-library-gate.test.ts; this spec locks the selection graph.
 */

const NEW_KIT_IDS = ["latin-perc", "jazz-kit", "rock-kit"] as const;

const NEW_KIT_GENRES: Record<(typeof NEW_KIT_IDS)[number], string> = {
  "latin-perc": "latin",
  "jazz-kit": "jazz",
  "rock-kit": "rock",
};

/** The 13 melodic voices the expand waves shipped (8 bass + 5 lead). */
const EXPAND_VOICE_IDS = [
  "factory.bass.808.soft",
  "factory.bass.808.medium",
  "factory.bass.808.hard",
  "factory.bass.subsine",
  "factory.bass.subsquare",
  "factory.bass.upright",
  "factory.bass.acid.fast",
  "factory.bass.acid.slow",
  "factory.lead.saw",
  "factory.lead.supersaw",
  "factory.lead.square",
  "factory.lead.pluck.bright",
  "factory.lead.pluck.dark",
];

describe("kit expand — new genre kits", () => {
  it("ships the three kits and routes them by genre exclusively", () => {
    for (const id of NEW_KIT_IDS) {
      const genre = NEW_KIT_GENRES[id];
      const pool = getKitPresetsForGenre(genre);
      expect(
        pool.map((k) => k.id),
        genre,
      ).toEqual([id]);
    }
  });

  it("does not pollute the established genre pools", () => {
    for (const genre of ["house", "techno", "trap"]) {
      const pool = getKitPresetsForGenre(genre);
      expect(
        pool.some((k) => (NEW_KIT_IDS as readonly string[]).includes(k.id)),
        genre,
      ).toBe(false);
    }
  });

  it("resolveKitPreset stays deterministic for the new genres", () => {
    for (const id of NEW_KIT_IDS) {
      const a = resolveKitPreset("seed-1", NEW_KIT_GENRES[id]);
      const b = resolveKitPreset("seed-1", NEW_KIT_GENRES[id]);
      expect(a.id).toBe(id);
      expect(b.id).toBe(a.id);
    }
  });
});

describe("kit expand — pad graph coherence", () => {
  it("every pad in every kit points at a real factory asset, a synth, or null", () => {
    for (const kit of KIT_PRESETS) {
      expect(kit.pads, kit.id).toHaveLength(16);
      const idxs = new Set(kit.pads.map((p) => p.idx));
      expect(idxs.size, kit.id).toBe(16);
      for (const pad of kit.pads) {
        expect(pad.idx, kit.id).toBeGreaterThanOrEqual(0);
        expect(pad.idx, kit.id).toBeLessThanOrEqual(15);
        if (pad.assetId !== null) {
          expect(
            FACTORY_ASSETS.some((a) => a.id === pad.assetId),
            `${kit.id} pad ${pad.idx} → ${pad.assetId}`,
          ).toBe(true);
        } else {
          expect(pad.synth !== null || pad.gain !== undefined, `${kit.id} pad ${pad.idx} empty slot`).toBe(true);
        }
      }
    }
  });

  it("each new kit actually carries its wave's voices", () => {
    const padIds = (id: (typeof NEW_KIT_IDS)[number]) =>
      new Set(KIT_PRESETS.find((k) => k.id === id)!.pads.map((p) => p.assetId));
    // Latin: the world-perc wave's headline voices.
    for (const asset of [
      "factory.perc.conga.high",
      "factory.perc.bongos",
      "factory.perc.timbale",
      "factory.perc.cajon",
      "factory.perc.agogo",
      "factory.shaker.fast",
    ]) {
      expect(padIds("latin-perc").has(asset), asset).toBe(true);
    }
    // Jazz: the washey ride is THE comping voice of the kit.
    expect(padIds("jazz-kit").has("factory.ride.jazz")).toBe(true);
    // Rock: china + crash roll + full tom set.
    for (const asset of ["factory.crash.china", "factory.crash.roll"]) {
      expect(padIds("rock-kit").has(asset), asset).toBe(true);
    }
  });
});

describe("voice expand — every new bank voice has a factory preset", () => {
  it("each of the 13 expand voices is referenced by at least one sampler preset", () => {
    for (const voiceId of EXPAND_VOICE_IDS) {
      const consumers = FACTORY_PRESETS.filter((p) => p.sampleId === voiceId);
      expect(consumers.length, `${voiceId} has ${consumers.length} preset consumer(s)`).toBeGreaterThanOrEqual(1);
      for (const preset of consumers) {
        expect(preset.instrument, preset.id).toBe("sampler");
      }
    }
  });

  it("the expand sampler presets use the sample's recorded fundamental as root", () => {
    // Playing the root note must play the sample at its own pitch — the
    // builder comment roots: 808 drops to D1, subs at F1, upright E1,
    // acid C2, saw leads A3, plucks A4.
    const roots: Record<string, number> = {
      "factory.sampler.trap.808soft": 26,
      "factory.sampler.trap.808medium": 26,
      "factory.sampler.drill.808hard": 26,
      "factory.sampler.house.subsine": 29,
      "factory.sampler.dnb.subsquare": 29,
      "factory.sampler.score.upright": 28,
      "factory.sampler.techno.acidaccent": 36,
      "factory.sampler.techno.acidline": 36,
      "factory.sampler.house.leadsaw": 57,
      "factory.sampler.house.supersaw": 57,
      "factory.sampler.jersey.leadsquare": 57,
      "factory.sampler.house.plucklead": 69,
      "factory.sampler.score.pluckdark": 69,
    };
    for (const [presetId, root] of Object.entries(roots)) {
      const preset = FACTORY_PRESETS.find((p) => p.id === presetId);
      expect(preset, presetId).toBeDefined();
      expect(preset!.params.root, presetId).toBe(root);
    }
  });

  it("expand sampler presets carry valid genre + mood metadata from the closed unions", () => {
    const GENRES = new Set(["house", "techno", "trap", "ambient", "score", "drill", "phonk", "jersey", "dnb"]);
    const MOODS = new Set(["dark", "bright", "warm", "aggressive", "clean", "deep", "atmosphere"]);
    const expand = FACTORY_PRESETS.filter(
      (p) => typeof p.sampleId === "string" && EXPAND_VOICE_IDS.includes(p.sampleId),
    );
    expect(expand.length).toBeGreaterThanOrEqual(13);
    for (const preset of expand) {
      expect(preset.genre === null || GENRES.has(preset.genre), `${preset.id} genre`).toBe(true);
      for (const mood of preset.mood) {
        expect(MOODS.has(mood), `${preset.id} mood ${mood}`).toBe(true);
      }
    }
  });
});
