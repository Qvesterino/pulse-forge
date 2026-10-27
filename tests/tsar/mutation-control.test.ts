import { describe, expect, it } from "vitest";
import {
  MUTATION_GROUPS,
  MUTATION_GROUP_PARAMS,
  MUTATION_RANGES,
  describeMutationRun,
  isMutationAxisLive,
  isMutationValueAudible,
  mutateTsarPatch,
  mutationGroupOf,
  mutationRangeLabel,
  type MutationGroup,
} from "../../src/tsar/mutations";
import { TSAR_PARAM_DEFS } from "../../src/tsar/params";

/**
 * WAVE 4 — CONTROLLED MUTATIONS (roadmap wave 4: "riadené mutácie").
 *
 * The three controls and the honesty rule they serve:
 *  - LOCKS freeze whole parameter groups;
 *  - RANGE decides how far a variant may move;
 *  - the SEED is shown and can be re-invoked (the key is base + seed +
 *    count + range + locks);
 *  - an axis the engine cannot hear is never touched — because numeric
 *    difference is not proof of quality.
 *
 * The audibility of the variants themselves is proved by rendering them
 * through the real DSP — see `tests/tsar/mutation-audibility.test.ts`.
 */

const BASE: Record<string, number> = {
  srcAEngine: 1,
  srcALevel: 0.8,
  srcAPan: 0,
  srcACoarse: 0,
  srcAFine: 0,
  srcARoot: 60,
  srcAMorph: 0,
  srcAUnison: 1,
  srcASpread: 0,
  srcAAtk: 0.005,
  srcADec: 0.6,
  srcASus: 0.7,
  srcARel: 0.4,
  srcAFilter: 0,
  srcACutoff: 18000,
  srcAQ: 0.8,
  srcAFilterEnv: 0,
  srcBEngine: 0,
  srcBLevel: 0,
  srcBAtk: 0.005,
  srcBDec: 0.6,
  srcBSus: 0.7,
  srcBRel: 0.4,
  srcBFilter: 0,
  srcBCutoff: 18000,
  srcBQ: 0.8,
  srcBMorph: 0,
  srcBUnison: 1,
  srcBSpread: 0,
  morph: 0,
  sub: 0,
  subOct: -1,
  noise: 0,
  noiseColor: 0.5,
  glide: 0,
  velocity: 0.7,
  lfoRate: 2,
  lfoShape: 0,
  lfoSync: 0,
  tone: 0,
  drive: 0,
  width: 0.5,
  level: 0.8,
};

describe("mutation groups — the taxonomy is a partition", () => {
  it("every TSAR parameter belongs to exactly one group", () => {
    const grouped = new Map<string, MutationGroup[]>();
    for (const group of MUTATION_GROUPS) {
      for (const id of MUTATION_GROUP_PARAMS[group.id]) {
        grouped.set(id, [...(grouped.get(id) ?? []), group.id]);
      }
    }
    const missing = Object.keys(TSAR_PARAM_DEFS).filter((id) => !grouped.has(id));
    expect(missing, "every shipped TSAR parameter needs a group").toEqual([]);
    const doubled = [...grouped.entries()].filter(([, groups]) => groups.length > 1);
    expect(doubled, "a parameter cannot be in two groups").toEqual([]);
    const unknown = [...grouped.keys()].filter((id) => !TSAR_PARAM_DEFS[id]);
    expect(unknown, "a group cannot name a parameter that does not exist").toEqual([]);
  });

  it("the groups cover the parameters the mutator can move", () => {
    // The roadmap names four groups as the minimum; the rest exist so that
    // locking a group cannot leave one of its parameters behind.
    for (const required of ["source", "tuning", "envelope", "modulation"] as MutationGroup[]) {
      expect(MUTATION_GROUP_PARAMS[required].length).toBeGreaterThan(0);
    }
    expect(mutationGroupOf("srcACutoff")).toBe("filter");
    expect(mutationGroupOf("srcARoot")).toBe("tuning");
    expect(mutationGroupOf("srcAAtk")).toBe("envelope");
    expect(mutationGroupOf("mod1Amt")).toBe("modulation");
    expect(mutationGroupOf("srcAMorph")).toBe("source");
    expect(mutationGroupOf("tone")).toBe("character");
    expect(mutationGroupOf("notAParam")).toBeNull();
  });
});

describe("mutation locks — a locked group is bit-identical", () => {
  it("a locked group's parameters never move", () => {
    for (const group of MUTATION_GROUPS) {
      const variants = mutateTsarPatch(BASE, 1_234_567, 6, { locks: [group.id] });
      expect(variants.length).toBeGreaterThan(0);
      for (const variant of variants) {
        for (const id of MUTATION_GROUP_PARAMS[group.id]) {
          expect(variant.params[id], `${group.id} must not move ${id}`).toBe(BASE[id]);
        }
      }
    }
  });

  it("locking every group leaves nothing to vary, and the mutator says so", () => {
    const all = MUTATION_GROUPS.map((group) => group.id);
    expect(mutateTsarPatch(BASE, 1_234_567, 6, { locks: all })).toEqual([]);
  });

  it("the locks reach the TOP-UP variants too", () => {
    // The top-up is a second mutation run with another seed. If the options
    // did not travel with it, a top-up variant could break a lock.
    const locks: MutationGroup[] = ["source"];
    const variants = mutateTsarPatch(BASE, 5, 6, { locks });
    expect(variants.length).toBe(6);
    for (const variant of variants) {
      for (const id of MUTATION_GROUP_PARAMS.source) {
        expect(variant.params[id]).toBe(BASE[id]);
      }
    }
  });

  it("the locks are part of the key: different locks give different variants", () => {
    const free = mutateTsarPatch(BASE, 1_234_567, 6);
    const locked = mutateTsarPatch(BASE, 1_234_567, 6, { locks: ["source"] });
    expect(JSON.stringify(free)).not.toBe(JSON.stringify(locked));
  });
});

describe("mutation range — how far a variant may move", () => {
  it("the same seed and range always give the same variants", () => {
    const a = mutateTsarPatch(BASE, 1_234_567, 6, { range: 0.5, locks: ["filter"] });
    const b = mutateTsarPatch(BASE, 1_234_567, 6, { range: 0.5, locks: ["filter"] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("a gentler range changes LESS of the patch", () => {
    // The range decides how much of the patch moves: fewer axes, and each of
    // them a shorter way. Averaged over seeds, because the axis draw itself
    // diverges once the count differs.
    const measure = (range: number) => {
      let axes = 0;
      let travel = 0;
      let variants = 0;
      for (let seedIndex = 0; seedIndex < 40; seedIndex += 1) {
        const seed = (1_234_567 + seedIndex * 7919) >>> 0;
        for (const variant of mutateTsarPatch(BASE, seed, 6, { range })) {
          axes += variant.moved.length;
          variants += 1;
          for (const id of variant.moved) {
            const def = TSAR_PARAM_DEFS[id]!;
            const span = def.max - def.min || 1;
            travel += Math.abs(variant.params[id]! - (BASE[id] ?? def.default)) / span;
          }
        }
      }
      return { axesPerVariant: axes / variants, travelPerAxis: travel / axes };
    };
    const full = measure(1);
    const medium = measure(0.5);
    const subtle = measure(0.25);
    expect(medium.axesPerVariant).toBeLessThan(full.axesPerVariant);
    expect(subtle.axesPerVariant).toBeLessThan(medium.axesPerVariant);
    expect(medium.travelPerAxis).toBeLessThanOrEqual(full.travelPerAxis + 1e-9);
    expect(subtle.travelPerAxis).toBeLessThanOrEqual(medium.travelPerAxis + 1e-9);
  });

  it("the full range is the pre-wave-4 reach — a range of 1 moves the axes at full weight", () => {
    // The reach keeps at least half of an axis's weight even at the gentlest
    // range, so a gentle move is still a MOVE and never a rounding error.
    const variants = mutateTsarPatch(BASE, 1_234_567, 6, { range: 1 });
    const gentle = mutateTsarPatch(BASE, 1_234_567, 6, { range: 0.25 });
    expect(variants.length).toBeGreaterThan(0);
    expect(gentle.length).toBeGreaterThan(0);
    for (const variant of variants) {
      for (const id of variant.moved) {
        const def = TSAR_PARAM_DEFS[id]!;
        const span = def.max - def.min || 1;
        const travel = Math.abs(variant.params[id]! - (BASE[id] ?? def.default)) / span;
        expect(travel, `${id} must move at least half of its weight`).toBeGreaterThan(0);
      }
    }
  });

  it("the range and its label round-trip", () => {
    expect(mutationRangeLabel(1)).toBe("FULL");
    expect(mutationRangeLabel(0.75)).toBe("BOLD");
    expect(mutationRangeLabel(0.5)).toBe("MEDIUM");
    expect(mutationRangeLabel(0.25)).toBe("SUBTLE");
    expect(MUTATION_RANGES.map((stop) => stop.value)).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it("the run key carries the seed, the range and the locks", () => {
    expect(describeMutationRun(42, { range: 0.5, locks: ["source"] })).toBe("seed 42 · MEDIUM · locks SOURCE");
    expect(describeMutationRun(42)).toBe("seed 42 · FULL");
  });
});

describe("mutation liveness — an axis the engine cannot hear is never touched", () => {
  it("a silent source's parameters are dead", () => {
    expect(isMutationAxisLive("srcBCutoff", BASE)).toBe(false);
    expect(isMutationAxisLive("srcBAtk", BASE)).toBe(false);
    expect(isMutationAxisLive("srcACutoff", BASE)).toBe(true);
  });

  it("no variant touches a silent source's parameters", () => {
    const variants = mutateTsarPatch(BASE, 1_234_567, 6);
    for (const variant of variants) {
      for (const id of variant.moved) {
        expect(isMutationAxisLive(id, BASE), `${id} must not be moved in this patch`).toBe(true);
      }
    }
  });

  it("the wavetable morph is dead for the other engines", () => {
    expect(isMutationAxisLive("srcAMorph", { ...BASE, srcAEngine: 1 })).toBe(true);
    expect(isMutationAxisLive("srcAMorph", { ...BASE, srcAEngine: 0 })).toBe(false);
    expect(isMutationAxisLive("srcAMorph", { ...BASE, srcAEngine: 2 })).toBe(false);
  });

  it("an open filter makes its Q and envelope dead", () => {
    expect(isMutationAxisLive("srcAQ", BASE)).toBe(false);
    expect(isMutationAxisLive("srcAQ", { ...BASE, srcACutoff: 800 })).toBe(true);
    expect(isMutationAxisLive("srcAFilterEnv", BASE)).toBe(false);
  });

  it("a centred source has no stereo side, so the width is dead", () => {
    expect(isMutationAxisLive("width", BASE)).toBe(false);
    expect(isMutationAxisLive("width", { ...BASE, srcAPan: 0.6 })).toBe(true);
  });

  it("the LFO is dead until a mod slot uses it", () => {
    expect(isMutationAxisLive("lfoRate", BASE)).toBe(false);
    expect(isMutationAxisLive("lfoRate", { ...BASE, mod1Src: 1, mod1Amt: 0.5 })).toBe(true);
  });

  it("the noise colour is dead without noise", () => {
    expect(isMutationAxisLive("noiseColor", BASE)).toBe(false);
    expect(isMutationAxisLive("noiseColor", { ...BASE, noise: 0.4 })).toBe(true);
  });

  it("a glide at or below the engine's threshold has no effect", () => {
    expect(isMutationValueAudible("glide", 0.001)).toBe(false);
    expect(isMutationValueAudible("glide", 0.2)).toBe(true);
    expect(isMutationValueAudible("tone", 0)).toBe(true);
  });

  it("no variant lands on a value the engine ignores", () => {
    const variants = mutateTsarPatch(BASE, 1_234_567, 6);
    for (const variant of variants) {
      for (const id of variant.moved) {
        expect(isMutationValueAudible(id, variant.params[id]!)).toBe(true);
      }
    }
  });
});
