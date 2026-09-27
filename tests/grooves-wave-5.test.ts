import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { getGrooveById, getGroovesForGenre, getStyleNamesForGenre } from "../src/ai/grooves/index";
import { resolveGroove } from "../src/ai/generator";
import { generateLocalResult } from "../src/intent/pipeline";
import { PRIOR_STYLE_VOCAB, buildPriorFeatureRow, type PriorGenre } from "../src/ai/symbolic/prior-features";
import type { PadRole } from "../src/ai/pad-roles";
import type { GrooveData } from "../src/ai/types";

/**
 * GROOVE WAVE 5 — the final closest-fit round.
 *
 * Waves 3 and 4 closed the electronic-depth and club/global lanes. Wave 5
 * closes the remaining seven mappings that the artist-preset batches had
 * documented as "closest fit" in `src/intent/artists.ts`:
 *
 *   future bass   house.broken        → house.futurebass
 *   synthwave     ambient.organic     → ambient.synthwave
 *   k-pop         house.pop           → house.kpop
 *   88rising      trap.lux            → trap.bedroom
 *   dancehall     trap.bounce         → trap.dancehall
 *   trap soul     trap.sparse         → trap.trapsoul
 *
 * Latin urban and afrobeats were already promoted by the parallel session
 * (house.dembow / house.afropop), so this wave does not duplicate them.
 *
 * Locks: registration + ids, 16-step valid rows, swing range, generation
 * smoke through the real engine, and the ONNX prior contract — new styles
 * stay OUT of PRIOR_STYLE_VOCAB (fixed 44-dim contract!) and degrade to the
 * zero-block "unknown" path instead of breaking inference.
 */

const WAVE_5_GROOVES: Array<{
  id: string;
  genre: GrooveData["genre"];
  name: string;
  bpm: [number, number];
}> = [
  { id: "house.futurebass", genre: "house", name: "Future Bass", bpm: [140, 150] },
  { id: "house.kpop", genre: "house", name: "K-Pop", bpm: [100, 120] },
  { id: "ambient.synthwave", genre: "ambient", name: "Synthwave", bpm: [95, 115] },
  { id: "trap.bedroom", genre: "trap", name: "Bedroom Pop", bpm: [80, 110] },
  { id: "trap.dancehall", genre: "trap", name: "Dancehall", bpm: [88, 105] },
  { id: "trap.trapsoul", genre: "trap", name: "Trap Soul", bpm: [78, 95] },
];

describe("groove wave 5 — registration", () => {
  it("all six grooves resolve by id with genre, name, and researched BPM range", () => {
    for (const expected of WAVE_5_GROOVES) {
      const groove = getGrooveById(expected.id);
      expect(groove, expected.id).toBeDefined();
      expect(groove!.genre).toBe(expected.genre);
      expect(groove!.name).toBe(expected.name);
      expect(groove!.bpm[0]).toBe(expected.bpm[0]);
      expect(groove!.bpm[1]).toBe(expected.bpm[1]);
    }
  });

  it("wave-5 names appear in their genre style list and resolve through resolveGroove", () => {
    for (const expected of WAVE_5_GROOVES) {
      expect(getStyleNamesForGenre(expected.genre)).toContain(expected.name);
      expect(resolveGroove(expected.genre, expected.name).id).toBe(expected.id);
      expect(getGroovesForGenre(expected.genre).some((g) => g.id === expected.id)).toBe(true);
    }
  });

  it("every pattern uses only activePads and every row is a valid 16-step velocity", () => {
    for (const expected of WAVE_5_GROOVES) {
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
    for (const expected of WAVE_5_GROOVES) {
      const groove = getGrooveById(expected.id)!;
      expect(groove.swing, `${expected.id} swing`).toBeGreaterThanOrEqual(0);
      expect(groove.swing, `${expected.id} swing`).toBeLessThanOrEqual(1);
    }
  });
});

describe("groove wave 5 — generation smoke (production pipeline with gates)", () => {
  it("each wave-5 style produces an accepted/repaired pattern like the UI would", () => {
    const doc = testDoc();
    for (const expected of WAVE_5_GROOVES) {
      const result = generateLocalResult(
        doc,
        {
          genre: expected.genre,
          style: expected.name,
          seed: `wave5-smoke-${expected.id}`,
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

describe("prior contract untouched (wave-5 styles degrade to unknown)", () => {
  it("wave-5 groove ids are NOT in the fixed 44-dim vocab", () => {
    for (const expected of WAVE_5_GROOVES) {
      expect(PRIOR_STYLE_VOCAB.includes(expected.id as never)).toBe(false);
    }
  });

  it("unknown wave-5 styles produce an all-zero style block (graceful, never throws)", () => {
    for (const expected of WAVE_5_GROOVES) {
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
