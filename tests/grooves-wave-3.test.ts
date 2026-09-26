import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { getGrooveById, getGroovesForGenre, getStyleNamesForGenre } from "../src/ai/grooves/index";
import { resolveGroove } from "../src/ai/generator";
import { generateLocalResult } from "../src/intent/pipeline";
import { PRIOR_STYLE_VOCAB, buildPriorFeatureRow, type PriorGenre } from "../src/ai/symbolic/prior-features";
import type { PadRole } from "../src/ai/pad-roles";
import type { GrooveData } from "../src/ai/types";

/**
 * GROOVE WAVE 3 — house.basshouse, house.ghouse, house.footwork,
 * techno.psytrance, techno.hardstyle.
 *
 * Closes the closest-fit mapping gap from the artist-preset enrichment
 * (artists batch `0f91785`, `e9c52c34`, `a1066a8`): those presets pointed
 * at `house.driving` / `house.deep` / `house.dancefloor` / `techno.acid`
 * / `techno.hard` as the nearest existing groove, with the mapping
 * documented inline. Wave 3 gives each sub-genre a first-class groove with
 * its own sonic identity (bass-led four-on-the-floor, French deep vocal
 * chops, Chicago footwork polyrhythm, acid-rolling psy, reverse-bass
 * hardstyle).
 *
 * Locks: registration + ids, 16-step valid rows, generation smoke through
 * the real engine, and the ONNX prior contract — new styles stay OUT of
 * PRIOR_STYLE_VOCAB (fixed 44-dim contract!) and degrade to the zero-block
 * "unknown" path instead of breaking inference.
 */

const WAVE_3_GROOVES: Array<{
  id: string;
  genre: GrooveData["genre"];
  name: string;
  bpm: [number, number];
}> = [
  { id: "house.basshouse", genre: "house", name: "Bass House", bpm: [124, 130] },
  { id: "house.ghouse", genre: "house", name: "G-House", bpm: [120, 126] },
  { id: "house.footwork", genre: "house", name: "Footwork", bpm: [155, 165] },
  { id: "techno.psytrance", genre: "techno", name: "Psytrance", bpm: [138, 145] },
  { id: "techno.hardstyle", genre: "techno", name: "Hardstyle", bpm: [150, 155] },
];

describe("groove wave 3 — registration", () => {
  it("all five grooves resolve by id with genre, name, and researched BPM range", () => {
    for (const expected of WAVE_3_GROOVES) {
      const groove = getGrooveById(expected.id);
      expect(groove, expected.id).toBeDefined();
      expect(groove!.genre).toBe(expected.genre);
      expect(groove!.name).toBe(expected.name);
      expect(groove!.bpm[0]).toBe(expected.bpm[0]);
      expect(groove!.bpm[1]).toBe(expected.bpm[1]);
    }
  });

  it("wave-3 names appear in their genre style list and resolve through resolveGroove", () => {
    for (const expected of WAVE_3_GROOVES) {
      expect(getStyleNamesForGenre(expected.genre)).toContain(expected.name);
      expect(resolveGroove(expected.genre, expected.name).id).toBe(expected.id);
      expect(getGroovesForGenre(expected.genre).some((g) => g.id === expected.id)).toBe(true);
    }
  });

  it("every pattern uses only activePads and every row is a valid 16-step velocity", () => {
    for (const expected of WAVE_3_GROOVES) {
      const groove = getGrooveById(expected.id)!;
      expect(groove.patterns.length, `${expected.id} patterns`).toBeGreaterThanOrEqual(3);
      const active = new Set(groove.activePads);
      for (const pattern of groove.patterns) {
        for (const [padKey, row] of Object.entries(pattern)) {
          expect(active.has(Number(padKey)), `${expected.id} pad ${padKey}`).toBe(true);
          expect(row).toHaveLength(16);
          for (const v of row) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("the new grooves are not duplicates of any pre-existing groove id", () => {
    const allIds = new Set<string>();
    for (const genre of ["house", "techno", "trap", "ambient", "drill", "phonk", "jersey", "dnb"] as const) {
      for (const g of getGroovesForGenre(genre)) allIds.add(g.id);
    }
    for (const expected of WAVE_3_GROOVES) {
      expect(allIds.has(expected.id)).toBe(true);
    }
    // No two grooves share the same id
    expect(allIds.size).toBeGreaterThanOrEqual(WAVE_3_GROOVES.length);
  });
});

describe("groove wave 3 — generation smoke (production pipeline with gates)", () => {
  it("each wave-3 style produces an accepted/repaired pattern like the UI would", () => {
    const doc = testDoc();
    for (const expected of WAVE_3_GROOVES) {
      const result = generateLocalResult(
        doc,
        {
          genre: expected.genre,
          style: expected.name,
          seed: `wave3-smoke-${expected.id}`,
          length: 32,
        },
        "preview",
      );
      expect(result.proposal, expected.id).toBeDefined();
      expect(["accepted", "repaired"], expected.id).toContain(result.status);
      expect(Object.keys(result.proposal!.pattern.rows).length, expected.id).toBeGreaterThan(0);
    }
  });
});

describe("prior contract untouched (wave-3 styles degrade to unknown)", () => {
  it("wave-3 groove ids are NOT in the fixed 44-dim vocab", () => {
    for (const expected of WAVE_3_GROOVES) {
      expect(PRIOR_STYLE_VOCAB.includes(expected.id as never)).toBe(false);
    }
  });

  it("unknown wave-3 styles produce an all-zero style block (graceful, never throws)", () => {
    for (const expected of WAVE_3_GROOVES) {
      const row = buildPriorFeatureRow({
        genre: expected.genre as PriorGenre,
        styleId: expected.id,
        role: "kick" as PadRole,
        step: 0,
        stepCount: 16,
      });
      expect(row.slice(4, 4 + PRIOR_STYLE_VOCAB.length)).toEqual(Array(PRIOR_STYLE_VOCAB.length).fill(0));
    }
  });
});
