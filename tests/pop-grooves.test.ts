import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { getGrooveById, getGroovesForGenre, getStyleNamesForGenre } from "../src/ai/grooves/index";
import { resolveGroove } from "../src/ai/generator";
import { generateLocalResult } from "../src/intent/pipeline";
import { PRIOR_STYLE_VOCAB, buildPriorFeatureRow, type PriorGenre } from "../src/ai/symbolic/prior-features";
import type { PadRole } from "../src/ai/pad-roles";
import type { GrooveData } from "../src/ai/types";

/**
 * POP GROOVES (Wave 2) — house.pop / house.synthpop / trap.pop / ambient.pop.
 *
 * Locks: registration + ids, 16-step valid rows, generation smoke through
 * the real engine, and the ONNX prior contract — new styles stay OUT of
 * PRIOR_STYLE_VOCAB (fixed 44-dim contract!) and degrade to the zero-block
 * "unknown" path instead of breaking inference.
 */

const POP_GROOVES: Array<{ id: string; genre: GrooveData["genre"]; name: string }> = [
  { id: "house.pop", genre: "house", name: "Pop" },
  { id: "house.synthpop", genre: "house", name: "Synthpop" },
  { id: "trap.pop", genre: "trap", name: "Pop" },
  { id: "ambient.pop", genre: "ambient", name: "Pop" },
];

describe("pop groove registration", () => {
  it("all four grooves resolve by id with genre, name and BPM", () => {
    for (const expected of POP_GROOVES) {
      const groove = getGrooveById(expected.id);
      expect(groove, expected.id).toBeDefined();
      expect(groove!.genre).toBe(expected.genre);
      expect(groove!.name).toBe(expected.name);
      expect(groove!.bpm[0]).toBeGreaterThanOrEqual(60);
      expect(groove!.bpm[1]).toBeLessThanOrEqual(300);
      expect(groove!.bpm[0]).toBeLessThanOrEqual(groove!.bpm[1]);
    }
  });

  it("pop styles are listed per genre and resolve through resolveGroove", () => {
    expect(getStyleNamesForGenre("house")).toContain("Pop");
    expect(getStyleNamesForGenre("house")).toContain("Synthpop");
    expect(resolveGroove("house", "pop").id).toBe("house.pop");
    expect(resolveGroove("trap", "pop").id).toBe("trap.pop");
    expect(resolveGroove("ambient", "pop").id).toBe("ambient.pop");
    for (const genre of ["house", "trap", "ambient"] as const) {
      expect(getGroovesForGenre(genre).some((g) => g.name === "Pop")).toBe(true);
    }
  });

  it("rows are valid 16-step velocities and activePads cover every used pad", () => {
    for (const expected of POP_GROOVES) {
      const groove = getGrooveById(expected.id)!;
      expect(groove.patterns.length).toBeGreaterThanOrEqual(3);
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
});

describe("pop groove generation smoke (production pipeline with gates)", () => {
  it("each pop style produces an accepted/repaired pattern like the UI would", () => {
    const doc = testDoc();
    for (const expected of POP_GROOVES) {
      const result = generateLocalResult(
        doc,
        {
          genre: expected.genre,
          style: expected.name,
          seed: `pop-smoke-${expected.id}`,
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

describe("prior contract untouched (new styles degrade to unknown)", () => {
  it("pop groove ids are NOT in the fixed 44-dim vocab", () => {
    for (const expected of POP_GROOVES) {
      expect(PRIOR_STYLE_VOCAB.includes(expected.id as never)).toBe(false);
    }
  });

  it("unknown pop styles produce an all-zero style block (graceful, never throws)", () => {
    const row = buildPriorFeatureRow({
      genre: "house" as PriorGenre,
      styleId: "house.pop",
      role: "kick" as PadRole,
      step: 0,
      stepCount: 16,
    });
    expect(row.slice(4, 4 + PRIOR_STYLE_VOCAB.length)).toEqual(Array(PRIOR_STYLE_VOCAB.length).fill(0));
  });
});
