import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { getGrooveById, getGroovesForGenre, getStyleNamesForGenre } from "../src/ai/grooves/index";
import { resolveGroove } from "../src/ai/generator";
import { generateLocalResult } from "../src/intent/pipeline";
import { PRIOR_STYLE_VOCAB, buildPriorFeatureRow, type PriorGenre } from "../src/ai/symbolic/prior-features";
import type { PadRole } from "../src/ai/pad-roles";
import type { GrooveData } from "../src/ai/types";

/**
 * GROOVE WAVE 4 — house.melodic, house.baile, ambient.citypop,
 * trap.corridos, hyperpop.decon, techno.ebm.
 *
 * Follows Wave 3 (`tests/grooves-wave-3.test.ts`) and closes the second
 * round of closest-fit mappings from the artist-preset enrichment. Wave 3
 * handled the electronic-depth sub-genres; Wave 4 handles the chill /
 * global-pop / club lanes that the artist-preset batches added later.
 *
 * Each new groove replaces a "closest-fit" style that was documented as
 * such in `src/intent/artists.ts`:
 *
 *   melodic house   house.deep          → house.melodic
 *   baile funk      house.dancefloor    → house.baile
 *   city pop        ambient.organic     → ambient.citypop
 *   corridos        trap.countrytune    → trap.corridos
 *   hyperpop wave   hyperpop.hyper      → hyperpop.decon
 *   industrial      techno.industrial   → techno.ebm
 *
 * Locks: registration + ids, 16-step valid rows, generation smoke through
 * the real engine, and the ONNX prior contract — new styles stay OUT of
 * PRIOR_STYLE_VOCAB (fixed 44-dim contract!) and degrade to the zero-block
 * "unknown" path instead of breaking inference.
 */

const WAVE_4_GROOVES: Array<{
  id: string;
  genre: GrooveData["genre"];
  name: string;
  bpm: [number, number];
}> = [
  { id: "house.melodic", genre: "house", name: "Melodic", bpm: [120, 128] },
  { id: "house.baile", genre: "house", name: "Baile Funk", bpm: [130, 150] },
  { id: "ambient.citypop", genre: "ambient", name: "City Pop", bpm: [100, 125] },
  { id: "trap.corridos", genre: "trap", name: "Corridos Tumbados", bpm: [90, 130] },
  { id: "hyperpop.decon", genre: "hyperpop", name: "Decon", bpm: [140, 160] },
  { id: "techno.ebm", genre: "techno", name: "EBM", bpm: [130, 140] },
];

describe("groove wave 4 — registration", () => {
  it("all six grooves resolve by id with genre, name, and researched BPM range", () => {
    for (const expected of WAVE_4_GROOVES) {
      const groove = getGrooveById(expected.id);
      expect(groove, expected.id).toBeDefined();
      expect(groove!.genre).toBe(expected.genre);
      expect(groove!.name).toBe(expected.name);
      expect(groove!.bpm[0]).toBe(expected.bpm[0]);
      expect(groove!.bpm[1]).toBe(expected.bpm[1]);
    }
  });

  it("wave-4 names appear in their genre style list and resolve through resolveGroove", () => {
    for (const expected of WAVE_4_GROOVES) {
      expect(getStyleNamesForGenre(expected.genre)).toContain(expected.name);
      expect(resolveGroove(expected.genre, expected.name).id).toBe(expected.id);
      expect(getGroovesForGenre(expected.genre).some((g) => g.id === expected.id)).toBe(true);
    }
  });

  it("every pattern uses only activePads and every row is a valid 16-step velocity", () => {
    for (const expected of WAVE_4_GROOVES) {
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

  it("swing stays in [0, 1] so groove settings never break the humanize clamp", () => {
    for (const expected of WAVE_4_GROOVES) {
      const groove = getGrooveById(expected.id)!;
      expect(groove.swing, `${expected.id} swing`).toBeGreaterThanOrEqual(0);
      expect(groove.swing, `${expected.id} swing`).toBeLessThanOrEqual(1);
    }
  });
});

describe("groove wave 4 — generation smoke (production pipeline with gates)", () => {
  it("each wave-4 style produces an accepted/repaired pattern like the UI would", () => {
    const doc = testDoc();
    for (const expected of WAVE_4_GROOVES) {
      const result = generateLocalResult(
        doc,
        {
          genre: expected.genre,
          style: expected.name,
          seed: `wave4-smoke-${expected.id}`,
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

describe("prior contract untouched (wave-4 styles degrade to unknown)", () => {
  it("wave-4 groove ids are NOT in the fixed 44-dim vocab", () => {
    for (const expected of WAVE_4_GROOVES) {
      expect(PRIOR_STYLE_VOCAB.includes(expected.id as never)).toBe(false);
    }
  });

  it("unknown wave-4 styles produce an all-zero style block (graceful, never throws)", () => {
    for (const expected of WAVE_4_GROOVES) {
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
