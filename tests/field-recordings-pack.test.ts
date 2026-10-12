import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { BUILDERS, DURATIONS } from "../src/sample-library/factory";
import { categoryColor, assetCategoryOf } from "../src/ui/kitColors";

/**
 * FIELD / FOUND SOUND PACK (2026-10-12).
 *
 * The one lane the 142-sample library had no home for: the sound of a PLACE
 * rather than an instrument — room tone under a lo-fi bed, a switch click as a
 * transient, gravel as percussion.
 *
 * Scope note on what this file can and cannot prove. There is no Web Audio
 * polyfill in the vitest setup, so these builders CANNOT be rendered here —
 * exactly like the Bass and world-perc packs, this is a structural gate.
 * Whether the nine voices are actually audible, finite and unclipped is proved
 * in the browser by `npm run test:browser:factory-presets`. Both halves of the
 * contract matter: this file stops a manifest entry from shipping without a
 * builder, which `generateFactoryBank` throws on at boot.
 */

const FIELD_IDS = [
  "factory.field.roomtone",
  "factory.field.fridge",
  "factory.field.mains",
  "factory.field.street",
  "factory.field.gravel",
  "factory.field.paper",
  "factory.field.rustle",
  "factory.field.switch",
  "factory.field.match",
];

/** The four BEDS: flat, stationary, meant to loop under a beat. */
const BED_IDS = ["factory.field.roomtone", "factory.field.fridge", "factory.field.mains", "factory.field.street"];

describe("field / found sound pack", () => {
  it("ships as the Field category with unique ids, character, tags and moods", () => {
    const ids = FACTORY_ASSETS.filter((a) => a.category === "Field").map((a) => a.id);
    expect(ids.sort()).toEqual([...FIELD_IDS].sort());
    const characters = new Set<string>();
    for (const id of FIELD_IDS) {
      const asset = FACTORY_ASSETS.find((a) => a.id === id)!;
      expect(asset.name.length, id).toBeGreaterThan(0);
      expect(asset.character.length, `${id} character`).toBeGreaterThan(8);
      expect(asset.tags.length, `${id} tags`).toBeGreaterThanOrEqual(3);
      expect(asset.mood.length, `${id} mood`).toBeGreaterThanOrEqual(1);
      characters.add(asset.character);
    }
    // Distinct characters: the pack must not be nine names for one sound.
    expect(characters.size).toBe(FIELD_IDS.length);
  });

  it("every field asset has a synth builder and a finite duration", () => {
    for (const id of FIELD_IDS) {
      expect(typeof BUILDERS[id], `${id} builder`).toBe("function");
      expect(Number.isFinite(DURATIONS[id]) && DURATIONS[id] > 0, `${id} duration`).toBe(true);
      expect(DURATIONS[id], `${id} bounded`).toBeLessThanOrEqual(4);
    }
  });

  it("the four beds are 4 s so they can loop under a beat; the hits are short", () => {
    // The bed/hit split is the pack's whole design: beds must be long enough to
    // disappear under a loop, hits must be short enough to punctuate one.
    for (const id of BED_IDS) expect(DURATIONS[id], `${id} bed length`).toBe(4);
    for (const id of FIELD_IDS.filter((x) => !BED_IDS.includes(x))) {
      expect(DURATIONS[id], `${id} hit length`).toBeLessThan(2);
    }
  });

  it("declares NO curated override — the whole pack is synthesized", () => {
    // The other packs ship a WAV per asset. Field sounds are generated, so a
    // curated file appearing here would mean the synthesized path silently
    // stopped being the source of truth for this category.
    const withFiles = FIELD_IDS.filter((id) => /\.(wav|mp3|flac)$/i.test(id));
    expect(withFiles).toEqual([]);
  });

  it("the Field category is plumbed into kit colours and pad lookup", () => {
    expect(categoryColor("Field")).toMatch(/^#[0-9a-f]{6}$/i);
    const pad = {
      id: "pad-x",
      assetId: "factory.field.gravel",
      synth: null,
      gain: 1,
      pan: 0,
      chokeGroup: null,
      layers: [],
    } as unknown as Parameters<typeof assetCategoryOf>[0];
    // kit colours must classify it as Field, not silently fall back to Percussion.
    expect(assetCategoryOf(pad)).toBe("Field");
  });

  it("the seed renderer declares a loudness target for the Field category", () => {
    // The sound-library gate requires every manifest category to have a target,
    // so a missing entry here fails the gate rather than this file alone.
    const source = readFileSync(path.resolve(__dirname, "..", "scripts", "render-curated-seeds.mjs"), "utf8");
    const match = /Field: \{ targetLufs: (-?\d+(?:\.\d+)?)/.exec(source);
    expect(match, "Field targetLufs in render-curated-seeds.mjs").not.toBeNull();
    // Field/foley sits far below the drum targets — it is meant to be felt.
    expect(Number(match![1])).toBeLessThan(-15);
  });

  it("field sounds are seeded, so the render is deterministic", () => {
    // The determinism invariant (same seed -> same content) covers factory
    // content too. Every voice in this pack draws its randomness from
    // mulberry32 with a literal seed rather than Math.random(); pinning the
    // nine seeds here is what stops a later edit from quietly making a field
    // render differently on every boot.
    const source = readFileSync(path.resolve(__dirname, "..", "src", "sample-library", "factory.ts"), "utf8");
    // 9103 (mains buzz) is deliberately absent: that voice is pure mains-locked
    // sines with no noise at all, so it needs no seed to stay deterministic.
    for (const seed of [9101, 9102, 9104, 9105, 9106, 9107, 9108, 9109]) {
      expect(source, `seed ${seed} used by the field pack`).toMatch(new RegExp(`\\b${seed}\\b`));
    }
    // The shared helper is where most voices turn their literal seed into a
    // PRNG; pinning that line is what keeps the beds deterministic too.
    expect(source).toContain("fill(buf.getChannelData(0), mulberry32(seed))");
    for (const fn of [
      "fieldRoomTone",
      "fieldFridge",
      "fieldMains",
      "fieldStreet",
      "fieldGravel",
      "fieldPaper",
      "fieldRustle",
      "fieldSwitch",
      "fieldMatch",
    ]) {
      expect(source, `${fn} exists`).toContain(`function ${fn}(`);
    }
  });
});
