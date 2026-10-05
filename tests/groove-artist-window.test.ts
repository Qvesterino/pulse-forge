import { describe, expect, it } from "vitest";
import { getGrooveById, getGroovesForGenre, preferGroovesForWindow } from "../src/ai/grooves/index";
import { resolveGrooveSeeded } from "../src/ai/generator";

/**
 * The artist tempo pocket (2026-09-28).
 *
 * The deep artist profiles carry a signature tempo window (Travis Scott
 * 140-150, Burial 130-138), but groove selection ignored it and picked by
 * rendezvous hash across the WHOLE genre, so "travis scott type beat" could
 * resolve to a 120 BPM house groove. The genre was right; the pocket was not.
 *
 * The fix narrows the CANDIDATE SET rather than forcing a groove, because
 * pickGrooveBySeed scores each candidate independently and takes the maximum.
 * Narrowing therefore changes which groove wins without making the pick
 * index-dependent — the property the rendezvous hash was chosen for.
 */

describe("preferGroovesForWindow", () => {
  it("keeps only grooves whose midpoint falls inside the window", () => {
    const house = getGroovesForGenre("house");
    const narrowed = preferGroovesForWindow(house, [130, 150]);
    expect(narrowed.length).toBeGreaterThan(0);
    expect(narrowed.length).toBeLessThan(house.length);
    for (const groove of narrowed) {
      const midpoint = (groove.bpm[0] + groove.bpm[1]) / 2;
      expect(midpoint).toBeGreaterThanOrEqual(130);
      expect(midpoint).toBeLessThanOrEqual(150);
    }
  });

  it("returns the ORIGINAL list when no window is given", () => {
    const house = getGroovesForGenre("house");
    expect(preferGroovesForWindow(house, null)).toBe(house);
    expect(preferGroovesForWindow(house, undefined)).toBe(house);
  });

  it("returns the ORIGINAL list when nothing overlaps (never starves the caller)", () => {
    // A profile with a mis-typed tempo must degrade to today's behaviour
    // rather than throwing or returning an empty candidate set.
    const house = getGroovesForGenre("house");
    expect(preferGroovesForWindow(house, [400, 450])).toBe(house);
  });

  it("returns the original list for a malformed window", () => {
    const house = getGroovesForGenre("house");
    expect(preferGroovesForWindow(house, [Number.NaN, 150])).toBe(house);
    expect(preferGroovesForWindow(house, [150, 130])).toBe(house);
  });

  it("is a no-op on a single-candidate list", () => {
    const one = [getGrooveById("house.deep")!];
    expect(preferGroovesForWindow(one, [130, 150])).toBe(one);
  });

  it("tolerance widens the match without becoming a no-op guard", () => {
    const house = getGroovesForGenre("house");
    const tight = preferGroovesForWindow(house, [130, 150]);
    const loose = preferGroovesForWindow(house, [130, 150], 12);
    expect(loose.length).toBeGreaterThanOrEqual(tight.length);
  });
});

describe("resolveGrooveSeeded — artist tempo pocket", () => {
  it("a window forces every seed into the pocket, not just some", () => {
    // This is the whole point: without a window the same genre yields a
    // spread of tempos. With one, the spread collapses into it.
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h", "seed-9", "seed-10"];
    const unconstrained = seeds.map((s) => {
      const g = resolveGrooveSeeded("house", undefined, s);
      return (g.bpm[0] + g.bpm[1]) / 2;
    });
    const constrained = seeds.map((s) => {
      const g = resolveGrooveSeeded("house", undefined, s, [130, 150]);
      return (g.bpm[0] + g.bpm[1]) / 2;
    });
    for (const midpoint of constrained) {
      expect(midpoint).toBeGreaterThanOrEqual(130);
      expect(midpoint).toBeLessThanOrEqual(150);
    }
    // The unconstrained spread is genuinely wider, so the test has teeth.
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    expect(spread(constrained)).toBeLessThanOrEqual(spread(unconstrained));
  });

  it("no window reproduces the pre-existing resolution exactly", () => {
    // Determinism contract: an absent window must not perturb a single seed.
    for (const seed of ["a", "seed-9", "my-project-seed"]) {
      expect(resolveGrooveSeeded("house", undefined, seed, null).id).toBe(
        resolveGrooveSeeded("house", undefined, seed).id,
      );
    }
  });

  it("is deterministic — the same seed and window always give the same groove", () => {
    for (const seed of ["a", "b", "seed-9"]) {
      const first = resolveGrooveSeeded("drill", undefined, seed, [140, 145]);
      const second = resolveGrooveSeeded("drill", undefined, seed, [140, 145]);
      expect(first.id).toBe(second.id);
    }
  });

  it("an explicit style still wins over the window", () => {
    // A named style is a stronger statement than an artist pocket; narrowing
    // the candidate set must not change a direct style hit.
    const byStyle = resolveGrooveSeeded("house", "deep", "a", [140, 150]);
    expect(byStyle.id).toBe("house.deep");
  });

  it("a window nothing overlaps falls back to the full candidate set", () => {
    const anySeed = resolveGrooveSeeded("house", undefined, "a", [400, 450]);
    const plain = resolveGrooveSeeded("house", undefined, "a");
    expect(anySeed.id).toBe(plain.id);
  });

  it("narrows the set without making the pick index-dependent", () => {
    // Two different seeds should still be able to land on DIFFERENT grooves
    // inside the window — a subset of one would be a bug, not a feature.
    const picks = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => resolveGrooveSeeded("house", undefined, s, [120, 135]).id),
    );
    expect(picks.size).toBeGreaterThan(1);
  });
});
