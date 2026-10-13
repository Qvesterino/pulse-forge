import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { BUILDERS, DURATIONS, RR_VARIATIONS } from "../src/sample-library/factory";
import { GENRES } from "../src/ai/types";
import { KIT_PRESETS, getKitPresetsForGenre, resolveKitPreset } from "../src/project-model/kit-presets";
import { categoryColor, assetCategoryOf } from "../src/ui/kitColors";

/**
 * DUSTY JAZZ / BOOM-BAP FAMILY (2026-10-13).
 *
 * Four voices, chosen by mapping the genre's vocabulary against the bank FIRST.
 * What came back already covered and was therefore deliberately NOT rebuilt:
 * Rhodes and Wurlitzer (tonal.rhodes / tonal.wurli), upright bass
 * (bass.upright), vibraphone (mallet.vibes, which already carries the
 * rotating-disc tremolo), swung hats (hat.closed.soft), shaker, tambourine, the
 * ride wash — and all of the tape, vinyl and 12-bit grit, which is DSP
 * (fxTapeSat / fxVinyl / fxBitcrusher), not content. Vibes nearly made the cut
 * twice on the strength of how often sources name it; the second look showed
 * the asset and its tremolo already exist.
 *
 * What survived as a real gap, each named independently by every source on the
 * style: BRUSHES (absent entirely), the GHOST NOTE (every snare in the bank is
 * a backbeat; the rim family is shell clicks, not snare wires), and the DARK
 * STICK RIDE (all three existing rides are bright, highpassed 5.4-7 kHz).
 *
 * Scope note on what this file can and cannot prove, same as the Field pack:
 * there is no Web Audio polyfill in the vitest setup, so these builders cannot
 * be rendered here. This is a structural gate — it stops a manifest entry from
 * shipping without a builder, which `generateFactoryBank` throws on at boot.
 * Audibility is proved in the browser by `npm run test:browser:factory-presets`.
 */

const BRUSH_IDS = ["factory.brush.tip", "factory.brush.swirl"];
const FAMILY_IDS = [...BRUSH_IDS, "factory.snare.ghost", "factory.ride.ding"];

const pad = (assetId: string) =>
  ({ id: "pad-x", assetId, synth: null, gain: 1, pan: 0, chokeGroup: null, layers: [] }) as unknown as Parameters<
    typeof assetCategoryOf
  >[0];

/** SampleLayer.sampleId and DrumPad.assetId are nullable in the model. A null
 *  id here is a defect, not a case to skip, so narrow loudly rather than with a
 *  silent fallback that would let a broken layer set pass. */
function idOf(value: string | null | undefined): string {
  if (!value) throw new Error(`expected a sample id, got ${String(value)}`);
  return value;
}

describe("dusty jazz / boom-bap family", () => {
  it("ships the four voices with unique ids, character, tags and moods", () => {
    expect(new Set(FAMILY_IDS).size).toBe(FAMILY_IDS.length);
    const characters = new Set<string>();
    for (const id of FAMILY_IDS) {
      const asset = FACTORY_ASSETS.find((a) => a.id === id);
      expect(asset, `${id} is in the manifest`).toBeDefined();
      expect(asset!.name.length, `${id} name`).toBeGreaterThan(0);
      expect(asset!.character.length, `${id} character`).toBeGreaterThan(8);
      expect(asset!.tags.length, `${id} tags`).toBeGreaterThanOrEqual(3);
      expect(asset!.mood.length, `${id} mood`).toBeGreaterThanOrEqual(1);
      characters.add(asset!.character);
    }
    // Four names for one sound is not a family.
    expect(characters.size).toBe(FAMILY_IDS.length);
  });

  it("every family voice has a synth builder and a finite duration", () => {
    for (const id of FAMILY_IDS) {
      expect(typeof BUILDERS[id], `${id} builder`).toBe("function");
      expect(Number.isFinite(DURATIONS[id]) && DURATIONS[id] > 0, `${id} duration`).toBe(true);
    }
  });

  it("Brush is its own category, plumbed into kit colours and pad lookup", () => {
    // A brush head has no metal and no shell, so it is neither a cymbal nor a
    // snare. Sharing a category would make a kit carrying both read as one
    // instrument, and would hide the family from anything keyed on category.
    expect(categoryColor("Brush")).toMatch(/^#[0-9a-f]{6}$/i);
    const brushes = FACTORY_ASSETS.filter((a) => a.category === "Brush").map((a) => a.id);
    expect(brushes.sort()).toEqual([...BRUSH_IDS].sort());
    // Must classify as Brush, not silently fall back to Percussion.
    expect(assetCategoryOf(pad("factory.brush.tip"))).toBe("Brush");
    expect(assetCategoryOf(pad("factory.brush.swirl"))).toBe("Brush");
    // And the family keeps its real categories where they are real.
    expect(assetCategoryOf(pad("factory.snare.ghost"))).toBe("Snare");
    expect(assetCategoryOf(pad("factory.ride.ding"))).toBe("Cymbal");
  });

  it("brush tip is short and the swirl is a swell, not a hit", () => {
    // The genre rests on "dynamic swells": the tip plays time, the swirl plays
    // dynamics. If the swirl were short it would just be a second tip.
    expect(DURATIONS["factory.brush.tip"]).toBeLessThan(0.5);
    expect(DURATIONS["factory.brush.swirl"]).toBeGreaterThan(1);
    expect(DURATIONS["factory.brush.swirl"]).toBeGreaterThan(DURATIONS["factory.brush.tip"] * 2);
    // The ghost note must be short enough to be felt rather than announced.
    expect(DURATIONS["factory.snare.ghost"]).toBeLessThan(0.2);
  });

  it("the swirl has no attack transient and the tip does", () => {
    // This is the physical distinction between the two brushes, and it is what
    // the "dynamic swell" phrasing in every guide describes: the swirl's bristles
    // never leave the head, so it cannot have an attack. Asserted against the
    // source because a one-shot browser render of a 1.1 s buffer would be a much
    // slower way to learn the same thing.
    const source = readFileSync(path.resolve(__dirname, "..", "src", "sample-library", "factory.ts"), "utf8");
    const swirl = source.slice(source.indexOf("function brushSwirl"), source.indexOf("function snareGhost"));
    const tip = source.slice(source.indexOf("function brushTip"), source.indexOf("function brushSwirl"));
    // Swirl: amplitude starts at the floor and is shaped by ramps only.
    expect(swirl).toContain("shape.gain.setValueAtTime(0.0001, t0)");
    expect(swirl).not.toMatch(/env\(ctx, t0/);
    // Tip: a real stroke, so it does use the percussive envelope helper.
    expect(tip).toContain("env(ctx, t0,");
  });

  it("the ghost note is a Snare, not a Rim", () => {
    // A ghost is the snare WIRES with no drum body. A rimshot is the hollow
    // shell. The rim family cannot stand in for it, and filing the ghost under
    // Rim would put it in the wrong pool for every consumer keyed on category.
    const ghost = FACTORY_ASSETS.find((a) => a.id === "factory.snare.ghost")!;
    expect(ghost.category).toBe("Snare");
    const rims = FACTORY_ASSETS.filter((a) => a.category === "Rim").map((a) => a.id);
    expect(rims).not.toContain("factory.snare.ghost");
  });

  it("the dark ride is a lowpassed wash while the existing rides are highpassed", () => {
    // The single musical claim of ride.ding is the inversion: a stick-led ping
    // over a SHORT DARK wash. If it were built like ride.jazz / ping / bell it
    // would be a fourth bright ride, which is the thing that does not exist yet.
    const source = readFileSync(path.resolve(__dirname, "..", "src", "sample-library", "factory.ts"), "utf8");
    const ding = source.slice(source.indexOf("function rideDing"), source.indexOf("function shakerFast"));
    expect(ding).toContain('lp.type = "lowpass"');
    expect(ding).not.toContain('hp.type = "highpass"');
    // Ping-led: the stick contact and the pitched partials must outlast the wash.
    expect(ding).toContain("stickBp");
    expect(ding.indexOf("stickBp")).toBeLessThan(ding.indexOf("lp.type"));
    for (const other of ["function rideBell", "function rideJazz"]) {
      const body = source.slice(source.indexOf(other), source.indexOf("function ", source.indexOf(other) + 12));
      expect(body, `${other} stays bright`).toContain('hp.type = "highpass"');
    }
  });

  it("the dusty backbeat has round-robin variants, so repeated hits are not clones", () => {
    // Without these the swung backbeat machine-guns, which is exactly the
    // artefact RR_VARIATIONS exists to kill.
    expect(RR_VARIATIONS["factory.snare.lofi"], "snare.lofi has RR variations").toBeDefined();
    expect(RR_VARIATIONS["factory.snare.lofi"].length).toBeGreaterThanOrEqual(2);

    // The backbeat set must have the shape the genre describes: a ghost under
    // soft hits, the dusty body (base plus its derived variants) rotating above
    // it, and a room accent on the hardest hits. Checking the whole structure is
    // the point — asserting only "the ids mention lofi" would pass on a set that
    // had no ghost in it at all.
    const kit = KIT_PRESETS.find((k) => k.id === "dusty-jazz-kit")!;
    const backbeat = kit.pads.find((p) => idOf(p.assetId) === "factory.snare.lofi")!;
    const layers = backbeat.layers ?? [];
    const ghost = layers.find((l) => idOf(l.sampleId) === "factory.snare.ghost");
    expect(ghost, "the set's soft zone is the new ghost note").toBeDefined();
    expect(ghost!.max, "the ghost only owns the soft end").toBeLessThanOrEqual(0.35);

    const body = layers.filter((l) => /^factory\.snare\.lofi/.test(idOf(l.sampleId)));
    expect(body.map((l) => idOf(l.sampleId)).sort()).toEqual(
      ["factory.snare.lofi", "factory.snare.lofi.rr2", "factory.snare.lofi.rr3"].sort(),
    );
    // Every RR id the set names must actually be derivable from the variation map.
    for (const l of body) {
      const n = /rr(\d+)$/.exec(idOf(l.sampleId))?.[1];
      if (n)
        expect(
          RR_VARIATIONS["factory.snare.lofi"][Number(n) - 2],
          `${l.sampleId} derives from a map entry`,
        ).toBeDefined();
    }

    const accent = layers.find((l) => idOf(l.sampleId) === "factory.snare.room");
    expect(accent, "the set has a hard accent").toBeDefined();
    expect(accent!.min).toBeGreaterThan(0.7);
  });

  it("boombap resolves to this kit alone, and jazz keeps its own", () => {
    // This is the reason the kit's genre is boombap and not jazz. Measured
    // before the kit existed: "boombap" is in GENRES, no kit claimed it, so
    // getKitPresetsForGenre fell through to its whole-kit fallback — the dice
    // could drop a boom-bap track on trap-808 or techno-drive.
    expect(GENRES).toContain("boombap");
    expect(getKitPresetsForGenre("boombap").map((k) => k.id)).toEqual(["dusty-jazz-kit"]);
    // jazz is unchanged: one kit, as its own pool test requires.
    expect(getKitPresetsForGenre("jazz").map((k) => k.id)).toEqual(["jazz-kit"]);
    // And it is deterministic per seed, like every other kit.
    expect(resolveKitPreset("seed-1", "boombap").id).toBe("dusty-jazz-kit");
    expect(resolveKitPreset("seed-1", "boombap").id).toBe(resolveKitPreset("seed-1", "boombap").id);
  });

  it("the kit actually selects every new voice — no orphan assets", () => {
    const kit = KIT_PRESETS.find((k) => k.id === "dusty-jazz-kit")!;
    const used = new Set<string>();
    for (const p of kit.pads) {
      used.add(idOf(p.assetId));
      for (const l of p.layers ?? []) used.add(idOf(l.sampleId));
    }
    for (const id of FAMILY_IDS) {
      expect(used, `${id} is selected by the kit`).toContain(id);
    }
  });

  it("the seed renderer declares a loudness target for the Brush category", () => {
    // The sound-library gate requires every manifest category to have a target.
    const source = readFileSync(path.resolve(__dirname, "..", "scripts", "render-curated-seeds.mjs"), "utf8");
    const match = /Brush: \{ targetLufs: (-?\d+(?:\.\d+)?)/.exec(source);
    expect(match, "Brush targetLufs in render-curated-seeds.mjs").not.toBeNull();
    expect(Number(match![1])).toBeLessThan(-15);
  });

  it("the family is seeded, so the render is deterministic", () => {
    // The determinism invariant (same seed -> same content) covers factory
    // content. Pinning the literal seeds is what stops a later edit from making
    // a brush render differently on every boot.
    const source = readFileSync(path.resolve(__dirname, "..", "src", "sample-library", "factory.ts"), "utf8");
    for (const seed of [601, 602, 611, 621, 631, 632]) {
      expect(source, `seed ${seed} used by the dusty jazz family`).toMatch(new RegExp(`\\b${seed}\\b`));
    }
    expect(source).not.toMatch(/Math\.random\(\)/);
  });

  /**
   * The defect that started this: `jazz-kit` shipped the description "brushed
   * backbeat" while containing no brush at all. Nothing failed — the description
   * is a free-text string and no test compared it to the pads. This closes that
   * class: any instrument vocabulary word in a kit description must be backed
   * by an asset the kit actually selects, in its own pads or in a layer set.
   *
   * Folds diacritics because the latin kit says "cajón" and "agogô" and the ids
   * say "cajon" / "agogo"; without folding the guard would be useless exactly
   * where the vocabulary is richest.
   */
  const VOCABULARY: Array<[word: string, assetPattern: RegExp]> = [
    ["kick", /factory\.kick\./],
    ["snare", /factory\.snare\./],
    ["hat", /factory\.hat\./],
    ["brush", /factory\.brush\./],
    ["ride", /factory\.ride\./],
    ["bell", /factory\.ride\.bell/],
    ["china", /factory\.crash\.china/],
    ["crash", /factory\.crash\./],
    ["tom", /factory\.tom\./],
    ["clap", /factory\.clap\./],
    ["rim", /factory\.rim\./],
    ["shaker", /factory\.shaker\./],
    ["cowbell", /factory\.perc\.cowbell/],
    ["conga", /factory\.perc\.conga\./],
    ["bongo", /factory\.perc\.bongo/],
    ["timbale", /factory\.perc\.timbale/],
    ["cajon", /factory\.perc\.cajon/],
    ["agogo", /factory\.perc\.agogo/],
  ];

  const fold = (s: string): string =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

  it("every kit description is backed by the assets that kit selects", () => {
    for (const kit of KIT_PRESETS) {
      const used = new Set<string>();
      for (const p of kit.pads) {
        // A null pad assetId is legitimate here and only here: it is a synth
        // pad (DrumSynthConfig, no sample). idOf stays strict for layer sampleIds,
        // where null is a genuine defect.
        if (p.assetId) used.add(p.assetId);
        for (const l of p.layers ?? []) used.add(idOf(l.sampleId));
      }
      const spoken = fold(kit.description);
      for (const [word, assetPattern] of VOCABULARY) {
        // The word has to actually appear as a word or word-part in the
        // description: "brushed"/"hats"/"toms"/"congas" all count, "kick"
        // inside another word would not.
        if (!new RegExp(`\\b${word}`, "i").test(spoken)) continue;
        const ids = [...used];
        expect(
          ids.some((id) => assetPattern.test(id)),
          `"${kit.id}" says "${word}" but selects no matching asset (has: ${ids.join(", ")})`,
        ).toBe(true);
      }
    }
  });

  it("jazz-kit carries the brushes its description promises, without losing the ride", () => {
    const kit = KIT_PRESETS.find((k) => k.id === "jazz-kit")!;
    const ids = kit.pads.map((p) => idOf(p.assetId));
    // The brush family is now genuinely in this kit — the original defect.
    expect(ids).toContain("factory.brush.tip");
    expect(ids).toContain("factory.brush.swirl");
    // And it was NOT bought by deleting something the description also promises:
    // the washey ride comping voice and the dynamic closed hat both stay.
    expect(ids, "washey ride survives").toContain("factory.ride.jazz");
    const closedHat = kit.pads.find((p) => p.assetId === "factory.hat.closed.soft");
    expect(closedHat, "closed hat survives").toBeDefined();
    expect(closedHat!.layers?.length, "closed hat keeps HAT_DYNAMIC").toBeGreaterThan(0);
    // The swirl has to be able to bloom OVER the ride wash, so it must not share
    // the ride's choke group -- choking would silence the comping it swells.
    const swirl = kit.pads.find((p) => p.assetId === "factory.brush.swirl")!;
    expect(swirl.chokeGroup ?? null, "swirl is not choked by the ride").toBeNull();
  });
});
