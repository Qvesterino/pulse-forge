import { describe, expect, it } from "vitest";
import { getGroovesForGenre, preferGroovesByLanes, preferGroovesForWindow } from "../src/ai/grooves/index";
import { getArtistProfile } from "../src/intent/artist-profiles";
import { ARTIST_PROFILES } from "../src/intent/artist-profiles";
import { resolveGrooveSeeded } from "../src/ai/generator";

/**
 * Artist groove lanes (2026-09-28).
 *
 * The tempo window already narrows WHICH tempos an artist's pocket can
 * occupy, but a genre holds a dozen lanes inside one tempo band — trap
 * alone has 26, house 52. "Metro boomin type beat" wants the orchestral
 * lane and "DJ mustard type beat" the bounce, both at 130-145 BPM, so
 * tempo alone cannot separate them. The lane name is the only signal
 * that does.
 */

describe("preferGroovesByLanes", () => {
  it("keeps only grooves in the requested lanes", () => {
    const trap = getGroovesForGenre("trap");
    const lanes = preferGroovesByLanes(trap, ["lux", "rolling"]);
    expect(lanes.length).toBeGreaterThan(0);
    expect(lanes.length).toBeLessThan(trap.length);
    for (const groove of lanes) {
      expect(["lux", "rolling"]).toContain(groove.id.split(".")[1]);
    }
  });

  it("returns the input unchanged for a null or empty lane set", () => {
    const trap = getGroovesForGenre("trap");
    expect(preferGroovesByLanes(trap, null)).toBe(trap);
    expect(preferGroovesByLanes(trap, [])).toBe(trap);
    expect(preferGroovesByLanes(trap, ["", "  "])).toBe(trap);
  });

  it("returns the input unchanged when NO lane matches", () => {
    // A renamed lane must cost the artist their groove, not their tempo
    // pocket — the fallback has to survive a library rename.
    const trap = getGroovesForGenre("trap");
    expect(preferGroovesByLanes(trap, ["no-such-lane-anywhere"])).toBe(trap);
  });

  it("refines a tempo window rather than replacing it", () => {
    // Both filters compose: the lanes only ever see candidates that
    // already survived the tempo filter.
    const trap = getGroovesForGenre("trap");
    const byTempo = preferGroovesForWindow(trap, [130, 145]);
    const byBoth = preferGroovesByLanes(byTempo, ["lux", "rolling"]);
    expect(byBoth.length).toBeLessThanOrEqual(byTempo.length);
    for (const groove of byBoth) {
      const mid = (groove.bpm[0] + groove.bpm[1]) / 2;
      expect(mid).toBeGreaterThanOrEqual(130);
      expect(mid).toBeLessThanOrEqual(145);
    }
  });

  it("is case and whitespace insensitive", () => {
    const trap = getGroovesForGenre("trap");
    expect(preferGroovesByLanes(trap, ["  LUX  "])).toEqual(preferGroovesByLanes(trap, ["lux"]));
  });
});

describe("every profile declares lanes that exist in the groove library", () => {
  it("no profile references a lane the library cannot produce", () => {
    // A lane id that does not exist is dead data: it would silently never
    // match and quietly cost that artist their lane preference forever.
    const known = new Set<string>();
    for (const genre of [
      "house",
      "trap",
      "techno",
      "ambient",
      "hybrid",
      "dnb",
      "boombap",
      "drill",
      "phonk",
      "jersey",
      "ukg",
      "westcoast",
      "amapiano",
      "hyperpop",
      "detroit",
      "postrock",
      "trance",
    ] as const) {
      for (const groove of getGroovesForGenre(genre as never)) known.add(groove.id.split(".")[1]);
    }
    for (const [slug, profile] of Object.entries(ARTIST_PROFILES)) {
      expect(profile.grooveLanes.length, `${slug} must declare lanes`).toBeGreaterThan(0);
      for (const lane of profile.grooveLanes) {
        expect(known.has(lane), `${slug} -> unknown lane "${lane}"`).toBe(true);
      }
    }
  });

  it("a known artist resolves to the lanes its profile claims", () => {
    const profile = getArtistProfile("travis-scott")!;
    expect(profile.grooveLanes).toContain("lux");
  });
});

describe("resolveGrooveSeeded — lane preference keeps the artist in its pocket", () => {
  const seeds = ["a", "b", "c", "d", "e", "f", "g", "h", "s9", "s10", "s11", "s12"];

  it("every seed resolves inside the requested lanes", () => {
    for (const seed of seeds) {
      const groove = resolveGrooveSeeded("trap", undefined, seed, null, ["lux", "rolling"]);
      expect(["lux", "rolling"]).toContain(groove.id.split(".")[1]);
    }
  });

  it("different lanes give different pockets for the same seed", () => {
    // The whole point: two artists at the same tempo must not land on the
    // same groove just because their windows overlap.
    const orchestral = new Set(
      seeds.map((s) => resolveGrooveSeeded("trap", undefined, s, null, ["lux", "rolling"]).id),
    );
    const hyphy = new Set(seeds.map((s) => resolveGrooveSeeded("trap", undefined, s, null, ["hyphy", "crunk"]).id));
    const overlap = [...orchestral].filter((id) => hyphy.has(id));
    expect(overlap).toEqual([]);
  });

  it("no lanes reproduces the pre-existing resolution exactly", () => {
    for (const seed of ["a", "seed-9", "my-project-seed"]) {
      expect(resolveGrooveSeeded("house", undefined, seed, null, null).id).toBe(
        resolveGrooveSeeded("house", undefined, seed).id,
      );
    }
  });

  it("is deterministic — same seed, window and lanes, same groove", () => {
    for (const seed of ["a", "b", "s9"]) {
      const first = resolveGrooveSeeded("trap", undefined, seed, [130, 145], ["lux", "rolling"]);
      const second = resolveGrooveSeeded("trap", undefined, seed, [130, 145], ["lux", "rolling"]);
      expect(first.id).toBe(second.id);
    }
  });

  it("an explicit style still wins over lanes", () => {
    const byStyle = resolveGrooveSeeded("trap", "bouncy", "a", null, ["lux", "rolling"]);
    expect(byStyle.id).toBe("trap.bouncy");
  });

  it("an unknown lane set falls back to the tempo pocket alone", () => {
    const withBadLanes = resolveGrooveSeeded("trap", undefined, "a", [130, 145], ["nope"]);
    const tempoOnly = resolveGrooveSeeded("trap", undefined, "a", [130, 145]);
    expect(withBadLanes.id).toBe(tempoOnly.id);
  });
});
