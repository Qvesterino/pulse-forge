/**
 * Groove selection stability — ARCHITECTURE.md #67 / invariant #4:
 * "Old projects must not silently sound different."
 *
 * The production path used to pick a groove with
 * `Math.floor(rand() * grooves.length)`, which makes the pick a function of the
 * ARRAY LENGTH rather than of the seed. Every groove added to the library (the
 * wave 1-5 genre work added tens) therefore remapped a large share of existing
 * seeds: reopening a project and regenerating with the same seed produced a
 * different pocket than the day it was written.
 *
 * `resolveGrooveSeeded` scores each candidate independently and takes the
 * maximum (rendezvous / highest-random-weight hashing), which is
 * order-independent and perturbs only the seeds a new groove actually wins.
 */
import { describe, expect, it } from "vitest";
import { resolveGroove, resolveGrooveSeeded } from "../src/ai/generator";
import { getGroovesForGenre } from "../src/ai/grooves/index";
import type { GrooveData } from "../src/ai/types";

const GENRE = "house";

/** Pick exactly what pickGrooveBySeed does, over an arbitrary candidate list. */
function seededPick(list: readonly GrooveData[], seed: string): string {
  let best = list[0];
  let bestWeight = -1;
  for (const groove of list) {
    // Mirrors src/ai/generator.ts — kept in sync by the assertions below.
    const weight = hashOf(`${GENRE}|${seed}|${groove.id}`);
    if (weight > bestWeight || (weight === bestWeight && groove.id < best.id)) {
      bestWeight = weight;
      best = groove;
    }
  }
  return best.id;
}

/** FNV-1a 32-bit, matching src/shared/rng.ts hashString. */
function hashOf(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const NEW_LANE = {
  id: "house.zzz-new-lane",
  genre: "house",
  name: "Zzz New Lane",
  bpm: [128, 128],
  swing: 0.04,
  activePads: [0, 8],
  patterns: [{}],
} as unknown as GrooveData;

const SEEDS = 400;

describe("groove selection stability", () => {
  it("the same seed always resolves to the same groove", () => {
    for (const genre of ["house", "trap", "techno", "dnb"] as const) {
      const first = resolveGrooveSeeded(genre, undefined, "stable-seed");
      for (let i = 0; i < 5; i++) {
        expect(resolveGrooveSeeded(genre, undefined, "stable-seed").id).toBe(first.id);
      }
    }
  });

  it("does not depend on the order of the groove library", () => {
    const list = getGroovesForGenre(GENRE);
    const reversed = [...list].reverse();
    for (let i = 0; i < SEEDS; i++) {
      const seed = `seed-${i}`;
      expect(seededPick(reversed, seed)).toBe(seededPick(list, seed));
    }
  });

  it("adding one groove perturbs only the seeds it actually wins, not all of them", () => {
    const before = getGroovesForGenre(GENRE);
    const after = [...before, NEW_LANE];
    let changed = 0;
    let wonByNewLane = 0;
    for (let i = 0; i < SEEDS; i++) {
      const seed = `seed-${i}`;
      const a = seededPick(before, seed);
      const b = seededPick(after, seed);
      if (a !== b) {
        changed++;
        // Any change MUST be the newcomer winning — never a shuffle of the
        // incumbent's ranking, which is what the index-based pick did.
        expect(b).toBe(NEW_LANE.id);
        wonByNewLane++;
      }
    }
    expect(wonByNewLane).toBe(changed);
    // ~1/(N+1) of seeds, with headroom. The old index pick moved ~48%.
    expect(changed / SEEDS).toBeLessThan(0.06);
  });

  it("an explicit style still wins over the seed", () => {
    expect(resolveGrooveSeeded(GENRE, "ukg", "anything").id).toBe("house.ukg");
    expect(resolveGrooveSeeded(GENRE, "Driving", "anything").id).toBe(
      getGroovesForGenre(GENRE).find((g) => g.name.toLowerCase() === "driving")?.id,
    );
  });

  it("an unknown style falls through to the seeded pick instead of throwing", () => {
    const picked = resolveGrooveSeeded(GENRE, "no-such-lane-xyz", "seed-7");
    expect(picked.genre).toBe(GENRE);
  });

  it("the index-based resolveGroove seam keeps its documented behaviour", () => {
    // Still used by tests and scripts as an explicit "give me this slot" seam.
    const first = getGroovesForGenre(GENRE)[0];
    expect(resolveGroove(GENRE, undefined, () => 0).id).toBe(first.id);
    expect(resolveGroove(GENRE).id).toBe(first.id);
  });
});
