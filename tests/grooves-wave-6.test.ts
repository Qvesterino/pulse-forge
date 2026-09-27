import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { getGrooveById, getGroovesForGenre, getStyleNamesForGenre } from "../src/ai/grooves/index";
import { resolveGroove } from "../src/ai/generator";
import { generateLocalResult } from "../src/intent/pipeline";
import { PRIOR_STYLE_VOCAB, buildPriorFeatureRow, type PriorGenre } from "../src/ai/symbolic/prior-features";
import type { PadRole } from "../src/ai/pad-roles";
import type { GrooveData } from "../src/ai/types";

/**
 * GROOVE WAVE 6 — the vocabulary-gap lanes.
 *
 * Closes the P1a gaps from `docs/VOCABULARY-GAP-RESEARCH.md`: the five
 * families the engine could not express, each previously mapped to the
 * closest-fit groove with the mapping documented inline in `artists.ts`:
 *
 *   gabber / hardcore techno   techno.hard       → techno.gabber
 *   trip-hop / downtempo       ambient.organic   → ambient.triphop
 *   reggae / ska one-drop      trap.dancehall    → house.reggae
 *   brostep / bass dubstep     trap.dubstep      → trap.bassdubstep
 *   shoegaze / dream pop       house.altrock     → house.shoegaze
 *
 * Locks: registration + ids, 16-step valid rows, swing range, generation
 * smoke through the real engine, and the ONNX prior contract — new styles
 * stay OUT of PRIOR_STYLE_VOCAB (fixed 44-dim contract!) and degrade to the
 * zero-block "unknown" path instead of breaking inference.
 */

const WAVE_6_GROOVES: Array<{
  id: string;
  genre: GrooveData["genre"];
  name: string;
  bpm: [number, number];
}> = [
  { id: "techno.gabber", genre: "techno", name: "Gabber", bpm: [160, 180] },
  { id: "ambient.triphop", genre: "ambient", name: "Trip-Hop", bpm: [80, 100] },
  { id: "house.reggae", genre: "house", name: "Reggae", bpm: [60, 90] },
  { id: "trap.bassdubstep", genre: "trap", name: "Bass Dubstep", bpm: [140, 150] },
  { id: "house.shoegaze", genre: "house", name: "Shoegaze", bpm: [90, 130] },
];

describe("groove wave 6 - registration", () => {
  it("all five grooves resolve by id with genre, name, and researched BPM range", () => {
    for (const expected of WAVE_6_GROOVES) {
      const groove = getGrooveById(expected.id);
      expect(groove, expected.id).toBeDefined();
      expect(groove!.genre).toBe(expected.genre);
      expect(groove!.name).toBe(expected.name);
      expect(groove!.bpm[0]).toBe(expected.bpm[0]);
      expect(groove!.bpm[1]).toBe(expected.bpm[1]);
    }
  });

  it("wave-6 names appear in their genre style list and resolve through resolveGroove", () => {
    for (const expected of WAVE_6_GROOVES) {
      expect(getStyleNamesForGenre(expected.genre)).toContain(expected.name);
      expect(resolveGroove(expected.genre, expected.name).id).toBe(expected.id);
      expect(getGroovesForGenre(expected.genre).some((g) => g.id === expected.id)).toBe(true);
    }
  });

  it("every pattern uses only activePads and every row is a valid 16-step velocity", () => {
    for (const expected of WAVE_6_GROOVES) {
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
    for (const expected of WAVE_6_GROOVES) {
      const groove = getGrooveById(expected.id)!;
      expect(groove.swing, `${expected.id} swing`).toBeGreaterThanOrEqual(0);
      expect(groove.swing, `${expected.id} swing`).toBeLessThanOrEqual(1);
    }
  });

  it("the signature of each lane is present (gabber 4-floor, one-drop empty beat 1, halftime snare)", () => {
    // Gabber: the distorted kick IS the genre — every beat has one.
    const gabber = getGrooveById("techno.gabber")!;
    for (const pattern of gabber.patterns) {
      expect((pattern[0] ?? [])[0] ?? 0, "gabber beat 1").toBeGreaterThan(0.9);
      expect((pattern[0] ?? [])[4] ?? 0, "gabber beat 2").toBeGreaterThan(0.9);
      expect((pattern[0] ?? [])[8] ?? 0, "gabber beat 3").toBeGreaterThan(0.9);
      expect((pattern[0] ?? [])[12] ?? 0, "gabber beat 4").toBeGreaterThan(0.9);
    }
    // One-drop: beat 1 is EMPTY, kick and snare land together on beat 3.
    const reggae = getGrooveById("house.reggae")!;
    for (const pattern of reggae.patterns) {
      expect((pattern[0] ?? [])[0] ?? 0, "one-drop empty beat 1").toBe(0);
      expect((pattern[0] ?? [])[8] ?? 0, "one-drop kick on 3").toBeGreaterThan(0.8);
      expect((pattern[5] ?? [])[8] ?? 0, "one-drop snare on 3").toBeGreaterThan(0.8);
    }
    // Trip-hop: the heavy snare lands on beat 3 (halftime), not 2 and 4.
    const triphop = getGrooveById("ambient.triphop")!;
    for (const pattern of triphop.patterns) {
      expect((pattern[4] ?? [])[8] ?? 0, "trip-hop snare on 3").toBeGreaterThan(0.8);
      expect((pattern[4] ?? [])[4] ?? 0, "trip-hop no snare on 2").toBe(0);
    }
    // Bass dubstep: the snare on 3 plus the machine-gun hat surface.
    const bass = getGrooveById("trap.bassdubstep")!;
    for (const pattern of bass.patterns) {
      expect((pattern[4] ?? [])[8] ?? 0, "bassdubstep snare on 3").toBeGreaterThan(0.8);
    }
    // Shoegaze: the drums are buried — no velocity ever peaks like a club kit.
    const shoegaze = getGrooveById("house.shoegaze")!;
    for (const pattern of shoegaze.patterns) {
      for (const row of Object.values(pattern)) {
        for (const v of row) expect(v, "shoegaze velocity ceiling").toBeLessThanOrEqual(0.8);
      }
    }
  });
});

describe("groove wave 6 - generation smoke (production pipeline with gates)", () => {
  it("each wave-6 style produces an accepted/repaired pattern like the UI would", () => {
    const doc = testDoc();
    for (const expected of WAVE_6_GROOVES) {
      const result = generateLocalResult(
        doc,
        {
          genre: expected.genre,
          style: expected.name,
          seed: `wave6-smoke-${expected.id}`,
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

describe("prior contract untouched (wave-6 styles degrade to unknown)", () => {
  it("wave-6 groove ids are NOT in the fixed 44-dim vocab", () => {
    for (const expected of WAVE_6_GROOVES) {
      expect(PRIOR_STYLE_VOCAB.includes(expected.id as never)).toBe(false);
    }
  });

  it("unknown wave-6 styles produce an all-zero style block (graceful, never throws)", () => {
    for (const expected of WAVE_6_GROOVES) {
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
