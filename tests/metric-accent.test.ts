import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { generatePattern } from "../src/ai/generator";
import { generateDrumPattern, applyMetricAccents } from "../src/ai/drums";
import { DEFAULT_GENERATE_OPTIONS } from "../src/ai/types";
import type { GenerateOptions } from "../src/ai/types";
import { inferPadRole } from "../src/ai/pad-roles";
import { getGrooveById } from "../src/ai/grooves/index";
import { normalizeIntent } from "../src/intent/normalize";
import { generateOptionsFromIntent, metricAccentFor } from "../src/intent/plan";
import { metricAccentFromVelocityVariation } from "../src/intent/mapping";
import { generateLocalResult } from "../src/intent/pipeline";
import { resolveHitSampleId } from "../src/project-model/groove";
import { FACTORY_SNARE_DYNAMIC, FACTORY_HAT_DYNAMIC } from "../src/sample-library/velocity-layers";
import type { DrumTrack, ProjectDocument } from "../src/project-model/types";

/**
 * METRIC ACCENT — the pass that makes velocity LAYERS musical.
 *
 * The layers (ghost < 0.35, accent ≥ 0.8) select a TIMBRE, so before this pass
 * a soft hat and a hard hat were chosen by chance; measured on the old
 * generator, techno's downbeat came out QUIETER than its off-beats (ratio
 * 0.79) — the bar's hierarchy was inverted. These tests pin the musical
 * contract: the hierarchy must be non-inverted, ghosts must be protected, and
 * a groove written on the off-beats (house) must not be flattened.
 */

const doc = () => createProjectFromTemplate("empty");

function drumOf(d: ProjectDocument): DrumTrack {
  return d.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
}

/** Velocity by metrical position across the beat-carrying pads. */
function byPosition(pattern: ReturnType<typeof generatePattern>, d: ProjectDocument, roles: string[]) {
  const pads = drumOf(d).pads;
  const buckets = new Map<number, number[]>();
  for (const [padId, row] of Object.entries(pattern.rows)) {
    const idx = pads.findIndex((p) => p.id === padId);
    if (idx < 0) continue;
    const role = inferPadRole(pads[idx].name, idx);
    if (!roles.includes(role)) continue;
    for (let step = 0; step < (row as number[]).length; step++) {
      const v = (row as number[])[step];
      if (v <= 0) continue;
      const pos = step % 16;
      const list = buckets.get(pos) ?? [];
      list.push(v);
      buckets.set(pos, list);
    }
  }
  const avg = (list: number[]) => list.reduce((s, v) => s + v, 0) / Math.max(1, list.length);
  return {
    beat: avg([0, 4, 8, 12].flatMap((p) => buckets.get(p) ?? [])),
    off: avg([1, 3, 5, 7, 9, 11, 13, 15].flatMap((p) => buckets.get(p) ?? [])),
    hasBeat: [0, 4, 8, 12].some((p) => (buckets.get(p) ?? []).length > 0),
    hasOff: [1, 3, 5, 7, 9, 11, 13, 15].some((p) => (buckets.get(p) ?? []).length > 0),
  };
}

describe("applyMetricAccents — the pure shaping function", () => {
  it("raises downbeats and lowers 16ths (bar hierarchy)", () => {
    const row = new Array<number>(16).fill(0.6);
    applyMetricAccents(row, "closedHat", 0.5);
    expect(row[0]).toBeGreaterThan(0.6); // downbeat up
    expect(row[8]).toBeGreaterThan(0.6); // backbeat up slightly
    expect(row[1]).toBeLessThan(0.6); // 16th down
    expect(row[0]).toBeGreaterThan(row[4]);
    expect(row[4]).toBeGreaterThan(row[1]);
  });

  it("never lifts a ghost hit — deliberate decoration stays soft", () => {
    const row = new Array<number>(16).fill(0);
    row[0] = 0.2; // ghost placed on a downbeat
    row[1] = 0.9; // hard hit on a 16th
    applyMetricAccents(row, "closedHat", 0.75);
    // The ghost must NOT become an accent (that was the inversion bug).
    expect(row[0]).toBeLessThan(0.35);
    expect(row[0]).toBe(0.2); // untouched
    // A written accent survives, just eased toward the hierarchy.
    expect(row[1]).toBeGreaterThan(0.35);
  });

  it("is bounded — no hit jumps to an extreme", () => {
    const row = new Array<number>(16).fill(0.5);
    applyMetricAccents(row, "closedHat", 1);
    for (const v of row) {
      expect(v).toBeGreaterThan(0.1);
      expect(v).toBeLessThanOrEqual(1);
    }
    // Downbeat lifts, 16th drops, and the 16th keeps a usable level (the
    // ghost band is 0..0.35 — a written 0.5 must not fall through it).
    expect(row[0]).toBeGreaterThan(row[1]);
    expect(row[1]).toBeGreaterThan(0.1);
  });

  it("is role-sensitive: anchors move less than the pulse", () => {
    const hat = new Array<number>(16).fill(0.6);
    const kick = new Array<number>(16).fill(0.6);
    applyMetricAccents(hat, "closedHat", 0.5);
    applyMetricAccents(kick, "kick", 0.5);
    expect(hat[0]).toBeGreaterThan(kick[0]);
    expect(hat[1]).toBeLessThan(kick[1]);
  });

  it("is deterministic and a no-op at strength 0", () => {
    const row = new Array<number>(16).fill(0.6);
    const copy = [...row];
    applyMetricAccents(row, "closedHat", 0);
    expect(row).toEqual(copy);

    const a = new Array<number>(16).fill(0.6);
    const b = new Array<number>(16).fill(0.6);
    applyMetricAccents(a, "closedHat", 0.4);
    applyMetricAccents(b, "closedHat", 0.4);
    expect(a).toEqual(b);
  });
});

describe("metric accent through the intent path", () => {
  it("is absent for a flat velocity ask (legacy random velocity preserved)", () => {
    // velocityVariation ≤ 0.15 → no accent at all: the frozen golden hashes
    // and anyone who asked for "no dynamics" keep the legacy behaviour.
    expect(metricAccentFromVelocityVariation(0.15)).toBe(0);
    expect(metricAccentFromVelocityVariation(0)).toBe(0);
    expect(metricAccentFromVelocityVariation(0.1)).toBe(0);
  });

  it("grows with the dynamics ask and never reaches full strength", () => {
    const low = metricAccentFromVelocityVariation(0.3);
    const high = metricAccentFromVelocityVariation(0.9);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
    expect(metricAccentFromVelocityVariation(1)).toBeLessThanOrEqual(0.75);
  });

  it("survives the default-intent fast path (a plain genre request gets it)", () => {
    // Regression: the accent was first derived in mapIntentToOptions, whose
    // default fast path returns `base` untouched — so a plain "drill" request
    // (a default intent) never received it.
    const plain = generateOptionsFromIntent(normalizeIntent({ genre: "drill", seed: "a" })) as GenerateOptions & {
      _metricAccent?: number;
    };
    expect(plain._metricAccent).toBeGreaterThan(0);
    const energetic = generateOptionsFromIntent(
      normalizeIntent({ genre: "drill", seed: "a", energy: 0.95 }),
    ) as GenerateOptions & { _metricAccent?: number };
    expect(energetic._metricAccent!).toBeGreaterThan(plain._metricAccent!);
  });

  it("scales with energy — the hierarchy is stronger on an energetic ask", () => {
    const calm = metricAccentFor(normalizeIntent({ genre: "trap", seed: "e", energy: 0.4 }));
    const hot = metricAccentFor(normalizeIntent({ genre: "trap", seed: "e", energy: 0.95 }));
    expect(hot).toBeGreaterThan(calm);
  });
});

describe("metric accent end to end — the musical claim", () => {
  it("keeps the bar hierarchy upright on every drum-carrying genre", () => {
    // The regression that started this work: techno's downbeat measured
    // QUIETER than its off-beats (0.79 ratio) — inverted hierarchy.
    for (const genre of ["trap", "drill", "phonk", "jersey", "dnb"] as const) {
      const d = doc();
      const pattern = generatePattern(d, { ...DEFAULT_GENERATE_OPTIONS, genre, seed: `hier-${genre}`, stepCount: 64 });
      const { beat, off, hasBeat, hasOff } = byPosition(pattern, d, ["snare", "closedHat", "clap"]);
      expect(hasBeat && hasOff, `${genre}: needs both positions to measure`).toBe(true);
      expect(beat, `${genre} hierarchy inverted`).toBeGreaterThan(off);
    }
  });

  it("puts hits into BOTH the ghost and the accent layer of a pad", () => {
    // The point of the whole exercise: the layer bands must be reachable by
    // musical position, not only by chance.
    const d = doc();
    const pattern = generatePattern(d, {
      ...DEFAULT_GENERATE_OPTIONS,
      genre: "drill",
      seed: "bands",
      stepCount: 64,
    });
    const pads = drumOf(d).pads;
    let ghost = 0;
    let accent = 0;
    let total = 0;
    for (const [padId, row] of Object.entries(pattern.rows)) {
      const idx = pads.findIndex((p) => p.id === padId);
      if (idx < 0) continue;
      const role = inferPadRole(pads[idx].name, idx);
      if (role !== "snare" && role !== "closedHat") continue;
      const layers = role === "snare" ? FACTORY_SNARE_DYNAMIC : FACTORY_HAT_DYNAMIC;
      for (const v of row as number[]) {
        if (v <= 0) continue;
        total += 1;
        const id = resolveHitSampleId({ assetId: null, layers } as never, v, 0);
        expect(id).toBeTruthy();
        if (v < 0.35) ghost += 1;
        else if (v >= 0.8) accent += 1;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(ghost).toBeGreaterThan(0);
    expect(accent).toBeGreaterThan(0);
  });

  it("does not flatten a groove written on the off-beats (house)", () => {
    // House hats live ON the off-beats — pulling them toward a ghost target
    // would destroy the groove (the first attempt measured 0.72, inverted).
    const d = doc();
    const pattern = generatePattern(d, {
      ...DEFAULT_GENERATE_OPTIONS,
      genre: "house",
      seed: "house-groove",
      stepCount: 64,
    });
    const pads = drumOf(d).pads;
    const hatRow = Object.entries(pattern.rows).find(([padId]) => {
      const idx = pads.findIndex((p) => p.id === padId);
      return idx >= 0 && inferPadRole(pads[idx].name, idx) === "closedHat";
    });
    expect(hatRow).toBeDefined();
    const row = hatRow![1] as number[];
    // Whatever the groove writes, the accent must not silence it: the loudest
    // written hat still reads clearly above the ghost floor.
    const loudest = Math.max(...row);
    expect(loudest).toBeGreaterThan(0.5);
  });

  it("stays deterministic — same seed, same velocities", () => {
    const d = doc();
    const options: GenerateOptions = {
      ...DEFAULT_GENERATE_OPTIONS,
      genre: "drill",
      seed: "det",
      stepCount: 32,
    };
    const first = generatePattern(d, options);
    const second = generatePattern(d, options);
    expect(first.rows).toEqual(second.rows);
  });

  it("applies through the async pipeline used by the product surfaces", () => {
    const d = doc();
    const result = generateLocalResult(d, normalizeIntent({ genre: "drill", seed: "pipe", length: 64 }));
    const pattern = result.proposal!.pattern;
    const { beat, off, hasBeat, hasOff } = byPosition(pattern, d, ["snare", "closedHat"]);
    expect(hasBeat && hasOff).toBe(true);
    expect(beat).toBeGreaterThan(off);
  });
});

describe("metric accent stays opt-in for the frozen generator", () => {
  it("generateDrumPattern without the hint keeps the legacy velocity", () => {
    // The golden fixtures pin byte-exact hashes for the frozen generator; the
    // hint is how the intent path opts in without touching them.
    const groove = getGrooveById("house.minimal")!;
    const options: GenerateOptions = {
      ...DEFAULT_GENERATE_OPTIONS,
      genre: "house",
      seed: "frozen",
      stepCount: 16,
    };
    const base = generateDrumPattern(groove, options, () => 0.5);
    const withHint = generateDrumPattern(groove, { ...options, _metricAccent: 0.5 }, () => 0.5);
    const rowsOf = (r: ReturnType<typeof generateDrumPattern>) =>
      Object.entries(r.rows)
        .map(([k, v]) => `${k}:${(v as number[]).join(",")}`)
        .sort()
        .join("|");
    expect(rowsOf(withHint)).not.toBe(rowsOf(base));
  });
});
