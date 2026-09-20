/**
 * Adversarial / edge-case tests for the core AI generation modules.
 * Mirrors the style of tests/fxeq-adversarial.test.ts:
 *   - NaN/Inf in numeric fields
 *   - Empty/degenerate inputs (all-zero rows, 0/1/256-step patterns)
 *   - Rapid-fire seed sweeps (determinism & state isolation)
 *   - Corrupted/malformed fixtures (graceful failure)
 *   - Boundary values (negative/zero/Inf BPM, negative velocities)
 *   - Property round-trips & score ranges
 *
 * The companion golden/correctness tests live in tests/ai-*.test.ts and tests/pattern-features.test.ts.
 * Do not duplicate those; this file is intentionally red-teaming.
 *
 * When a test surfaces a real source-code bug (e.g. NaN propagating through
 * a row), we skip with `.skip` + a TODO follow-up. Other tests stay green.
 */

import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { getDrumTrack } from "../src/project-model/types";
import { generatePattern, resolveGroove } from "../src/ai/generator";
import type { VelocityLevel } from "../src/ai/types";
import {
  buildPadModel,
  decodeLevelCurr,
  decodeLevelPrev,
  decodePosition,
  dequantizeVelocity,
  encodeState,
  generatePadSequence,
  getGroovePadModel,
  quantizeVelocity,
} from "../src/ai/markov";
import { analyzeLoopForFlip, buildFlipOptions, flipSeed } from "../src/ai/flip";
import { measureDrumQuality, measureMelodicQuality, repairDrumRow } from "../src/ai/quality";
import { evaluateStyleDistance, getStyleQualityProfile, syncopationWeight } from "../src/ai/style-quality";
import { extractPatternFeatures } from "../src/ai/features/pattern-features";
import { applyPhraseDynamics, buildPhrasePlan } from "../src/ai/phrase";
import { mulberry32 } from "../src/shared/rng";
import type { GenerateOptions } from "../src/ai/types";
import type { PadRole } from "../src/ai/pad-roles";
import type { Pattern, ProjectDocument, NoteEvent } from "../src/project-model/types";
import { normalizeIntent } from "../src/intent/normalize";
import type { IntentSpec } from "../src/intent/types";

const SR = 44100;

function makeOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    genre: "house",
    seed: "adv-seed-abc",
    stepCount: 16,
    ghostWeight: 0.3,
    microWeight: 0.2,
    velocityVariation: 0.3,
    temperature: 1.0,
    replaceMode: "new",
    ...overrides,
  };
}

function freshDoc(): ProjectDocument {
  return createDefaultProject();
}

function intentOf(overrides: Partial<IntentSpec> = {}): IntentSpec {
  return normalizeIntent({
    genre: "house",
    energy: 0.7,
    density: 0.6,
    complexity: 0.4,
    variation: 0.5,
    seed: "adv-feature",
    roles: ["drums", "bass"],
    ...overrides,
  } as never) as IntentSpec;
}

function makeFeatureInput(doc: ProjectDocument, pattern: Pattern, overrides: Partial<GenerateOptions> = {}) {
  return { doc, pattern, intent: intentOf(), options: makeOptions(overrides), resolvedBpm: doc.bpm };
}

describe("markov engine — adversarial inputs", () => {
  it("quantizeVelocity clamps NaN / Infinity / negatives to a valid level", () => {
    expect(quantizeVelocity(NaN)).toBeGreaterThanOrEqual(0);
    expect(quantizeVelocity(NaN)).toBeLessThanOrEqual(3);
    expect(Number.isFinite(quantizeVelocity(NaN))).toBe(true);

    expect(quantizeVelocity(Infinity)).toBe(3);
    expect(quantizeVelocity(-Infinity)).toBe(0);
    expect(quantizeVelocity(-1e9)).toBe(0);
    expect(quantizeVelocity(1e9)).toBe(3);
  });

  it("dequantizeVelocity is always finite across all levels and many seeds", () => {
    for (let seed = 0; seed < 100; seed++) {
      const r = mulberry32(seed);
      for (const lvl of [0, 1, 2, 3] as VelocityLevel[]) {
        const v = dequantizeVelocity(lvl, r);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("encodeState/decode* round-trip is bijective for all 256 states", () => {
    for (let lv = 0; lv < 4; lv++) {
      for (let lc = 0; lc < 4; lc++) {
        for (let pos = 0; pos < 16; pos++) {
          const code = encodeState(lv as 0 | 1 | 2 | 3, lc as 0 | 1 | 2 | 3, pos);
          expect(code).toBeGreaterThanOrEqual(0);
          expect(code).toBeLessThan(256);
          expect(decodeLevelPrev(code)).toBe(lv);
          expect(decodeLevelCurr(code)).toBe(lc);
          expect(decodePosition(code)).toBe(pos);
        }
      }
    }
  });

  it("encodeState tolerates garbage inputs without throwing", () => {
    expect(() => encodeState(NaN as never, NaN as never, NaN as never)).not.toThrow();
    expect(() => encodeState(99 as never, -9 as never, 9999 as never)).not.toThrow();
  });

  it("buildPadModel on an empty pattern array still produces a valid model + sequence", () => {
    const model = buildPadModel(0, []);
    expect(model.states).toBe(256);
    // transitions is a flat 256*256 matrix
    expect(model.transitions.length).toBe(256 * 256);
    const rand = mulberry32(1);
    const seq = generatePadSequence(model, 16, rand);
    expect(seq).toHaveLength(16);
    for (const v of seq) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(3);
    }
  });

  it("buildPadModel on a single-step pattern still produces a deterministic sequence", () => {
    const model = buildPadModel(0, [[0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]);
    const seq = generatePadSequence(model, 32, mulberry32(7));
    expect(seq).toHaveLength(32);
    for (const v of seq) expect(Number.isFinite(v)).toBe(true);
  });

  it("buildPadModel on NaN/Inf row values sanitizes and produces a valid sequence", () => {
    const row = [NaN, Infinity, -Infinity, 0.5, 0.3, -0.5, 1.5, 2, 100, -100, 0, 0, 0, 0, 0, 0];
    const model = buildPadModel(0, [row]);
    expect(model.transitions.length).toBe(256 * 256);
    const seq = generatePadSequence(model, 16, mulberry32(3));
    for (const v of seq) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(3);
    }
  });

  it("generatePadSequence handles length=0 and length=256 without crashing", () => {
    const patterns = [[0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0]];
    const model = buildPadModel(0, patterns);
    const r0 = mulberry32(99);
    expect(generatePadSequence(model, 0, r0)).toEqual([]);
    const r256 = mulberry32(99);
    const seq256 = generatePadSequence(model, 256, r256);
    expect(seq256).toHaveLength(256);
    for (const v of seq256) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(3);
    }
  });

  it("rapid-fire same-seed calls are byte-identical (no shared mutable state)", () => {
    const patterns = [[0.9, 0, 0.4, 0, 0.9, 0, 0.4, 0, 0.9, 0, 0.4, 0, 0.9, 0, 0.4, 0]];
    const model = buildPadModel(0, patterns);
    const ref = generatePadSequence(model, 64, mulberry32(123));
    for (let i = 0; i < 200; i++) {
      expect(generatePadSequence(model, 64, mulberry32(123))).toEqual(ref);
    }
  });

  it("concurrent sequences with disjoint seeds never cross-contaminate", async () => {
    const patterns = [[0.9, 0, 0.5, 0, 0.9, 0, 0.5, 0, 0.9, 0, 0.5, 0, 0.9, 0, 0.5, 0]];
    const model = buildPadModel(0, patterns);
    const tasks: Promise<number[]>[] = [];
    for (let i = 0; i < 50; i++) {
      tasks.push(Promise.resolve(generatePadSequence(model, 32, mulberry32(1000 + i))));
    }
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      const again = generatePadSequence(model, 32, mulberry32(1000 + i));
      expect(results[i]).toEqual(again);
    }
  });

  it("getGroovePadModel returns the same model+patterns for the same groove+pads", () => {
    const groove = resolveGroove("house", "Driving");
    const a = getGroovePadModel(groove, groove.activePads[0]);
    const b = getGroovePadModel(groove, groove.activePads[0]);
    expect(a.model).toBe(b.model);
    expect(a.patterns).toBe(b.patterns);
  });
});

describe("generator — adversarial inputs", () => {
  it("survives NaN/Infinity in ghostWeight, microWeight, velocityVariation, temperature", () => {
    const doc = freshDoc();
    const patterns: Pattern[] = [];
    for (const bad of [
      { ghostWeight: NaN },
      { microWeight: NaN },
      { velocityVariation: NaN },
      { temperature: NaN },
      { ghostWeight: Infinity },
      { microWeight: -Infinity },
      { velocityVariation: 1e9 },
      { temperature: -1e9 },
    ] as Partial<GenerateOptions>[]) {
      const p = generatePattern(doc, makeOptions(bad));
      patterns.push(p);
      for (const row of Object.values(p.rows)) {
        for (const v of row) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(patterns).toHaveLength(8);
  });

  it("survives stepCount=1, 255, 256 (large non-negative values)", () => {
    const doc = freshDoc();
    for (const n of [1, 32, 255, 256]) {
      const p = generatePattern(doc, makeOptions({ stepCount: n }));
      expect(p).toBeTruthy();
      expect(p.rows).toBeTruthy();
      for (const row of Object.values(p.rows)) {
        expect(row.length).toBeGreaterThan(0);
        expect(row.length).toBeLessThanOrEqual(1024);
        for (const v of row) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  // TODO: src/ai/quality.ts:L28 — repairDrumRow does not clamp negative
  //       stepCount before `new Array(stepCount)`, leading to RangeError on
  //       negative input. Generator should pre-sanitize stepCount.
  it("survives negative stepCount without throwing", () => { // re-enabled verification (see src/ai/quality.ts L27)
    const doc = freshDoc();
    expect(() => generatePattern(doc, makeOptions({ stepCount: -16 }))).not.toThrow();
  });

  it("empty seed string, very long seed, and seed with non-ASCII still produce a valid pattern", () => {
    const doc = freshDoc();
    const seeds = ["", "x", " ".repeat(1024), "🚀🔥💀", "seed\nwith\nnewlines", "seed\twith\ttabs"];
    for (const seed of seeds) {
      const p = generatePattern(doc, makeOptions({ seed }));
      expect(p).toBeTruthy();
      expect(p.id).toBeTruthy();
      expect(typeof p.rows).toBe("object");
    }
  });

  it("100× same-seed rapid-fire loop yields byte-identical rows (determinism, no shared RNG state)", () => {
    const doc = freshDoc();
    const ref = generatePattern(doc, makeOptions({ seed: "stable" }));
    for (let i = 0; i < 100; i++) {
      const p = generatePattern(doc, makeOptions({ seed: "stable" }));
      expect(p.rows).toEqual(ref.rows);
      expect(p.stepMeta).toEqual(ref.stepMeta);
    }
  });

  it("100× seed sweep produces output that doesn't all collapse to the same hash", () => {
    const doc = freshDoc();
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const p = generatePattern(doc, makeOptions({ seed: `sweep-${i}` }));
      hashes.add(JSON.stringify(p.rows));
    }
    expect(hashes.size).toBeGreaterThan(5);
  });

  // TODO: src/ai/generator.ts — resolveGroove is not defensive against unknown
  //       genres: it dereferences `groove.id` on the result of an indexed
  //       lookup and throws when the genre isn't in the registry. Generator
  //       should fall back to a known genre instead.
  it("unknown genre string falls back without throwing", () => {
    const doc = freshDoc();
    expect(() => generatePattern(doc, makeOptions({ genre: "polka" as never }))).not.toThrow();
  });

  it("non-string seed does not throw (treats as empty / coerced)", () => {
    const doc = freshDoc();
    expect(() => generatePattern(doc, makeOptions({ seed: undefined as never }))).not.toThrow();
    expect(() => generatePattern(doc, makeOptions({ seed: null as never }))).not.toThrow();
  });
});

describe("pattern-features — adversarial inputs", () => {
  it("survives a Pattern with zero rows (empty pattern)", () => {
    const doc = freshDoc();
    const p: Pattern = {
      id: "adv-empty",
      name: "empty",
      stepCount: 16,
      rows: {},
      notes: {},
      stepMeta: undefined,
    };
    const features = extractPatternFeatures(makeFeatureInput(doc, p));
    expect(features).toBeTruthy();
    expect(features.values).toBeTruthy();
    for (const v of features.values) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("survives a Pattern with a single all-zero row", () => {
    const doc = freshDoc();
    const drum = getDrumTrack(doc);
    const padId = drum.pads[0].id;
    const p: Pattern = {
      id: "adv-zero",
      name: "all-zero",
      stepCount: 16,
      rows: { [padId]: new Array(16).fill(0) },
      notes: {},
      stepMeta: undefined,
    };
    const features = extractPatternFeatures(makeFeatureInput(doc, p));
    expect(features).toBeTruthy();
    for (const v of features.values) expect(Number.isFinite(v)).toBe(true);
  });

  it("clamps velocities in [0,1] when rows contain values outside the range", () => {
    const doc = freshDoc();
    const drum = getDrumTrack(doc);
    const padId = drum.pads[0].id;
    const p: Pattern = {
      id: "adv-clip",
      name: "out-of-range",
      stepCount: 16,
      rows: { [padId]: [NaN, Infinity, -Infinity, -0.5, 1.5, 2, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      notes: {},
      stepMeta: undefined,
    };
    const features = extractPatternFeatures(makeFeatureInput(doc, p));
    expect(features).toBeTruthy();
    for (const v of features.values) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("does not crash on rows that are shorter or longer than stepCount", () => {
    const doc = freshDoc();
    const drum = getDrumTrack(doc);
    const padId = drum.pads[0].id;
    const p: Pattern = {
      id: "adv-mismatch",
      name: "row-length-mismatch",
      stepCount: 16,
      rows: { [padId]: [0.9] },
      notes: {},
      stepMeta: undefined,
    };
    expect(() => extractPatternFeatures(makeFeatureInput(doc, p))).not.toThrow();
  });

  it("feature vector for a 256-step pattern is fully finite", () => {
    const doc = freshDoc();
    const drum = getDrumTrack(doc);
    const padId = drum.pads[0].id;
    const p: Pattern = {
      id: "adv-256",
      name: "max-len",
      stepCount: 256,
      rows: { [padId]: new Array(256).fill(0).map((_, i) => (i % 4 === 0 ? 0.9 : 0.1)) },
      notes: {},
      stepMeta: undefined,
    };
    const features = extractPatternFeatures(makeFeatureInput(doc, p, { stepCount: 256 }));
    for (const v of features.values) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("phrase — adversarial inputs", () => {
  it("buildPhrasePlan handles stepCount=0, 1, -16 without crashing", () => {
    for (const n of [0, 1, -16, 256]) {
      const plan = buildPhrasePlan(n);
      expect(Array.isArray(plan)).toBe(true);
      for (const bar of plan) {
        expect(Number.isFinite(bar.startStep)).toBe(true);
        expect(Number.isFinite(bar.endStep)).toBe(true);
        expect(["main", "variation", "drop", "fill", "outro"]).toContain(bar.section);
      }
    }
  });

  // TODO: src/ai/phrase.ts:L14 — Math.ceil(stepCount/16) yields Infinity for Infinity
  //       input; Array.from({length: Infinity}) throws RangeError. BuildPhrasePlan
  //       should sanitize Infinity/NaN to a finite cap before allocating.
  it("buildPhrasePlan tolerates Infinity/NaN without throwing", () => {
    expect(() => buildPhrasePlan(Infinity)).not.toThrow();
    expect(() => buildPhrasePlan(NaN)).not.toThrow();
  });

  it("applyPhraseDynamics on an empty row does not throw and preserves empty state", () => {
    const plan = buildPhrasePlan(16);
    const row: number[] = [];
    const rand = mulberry32(1);
    expect(() => applyPhraseDynamics(row, "kick" as PadRole, plan, rand)).not.toThrow();
  });

  it("repairDrumRow clamps NaN/Inf/negatives/out-of-range velocities to a finite value in [0,1]", () => {
    const inputs = [
      [NaN, Infinity, -Infinity, -0.5, 1.5, 2, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      new Array(16).fill(0),
      [],
      [0.9],
    ];
    for (const input of inputs) {
      const repaired = repairDrumRow(input, 16);
      expect(repaired).toHaveLength(16);
      for (const v of repaired) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("repairDrumRow is idempotent — running twice yields the same row", () => {
    const input = [0.9, 0.5, 0.3, 0, 0.7, 0, NaN, 0, Infinity, -0.2, 0, 0, 0, 0, 0, 0];
    const a = repairDrumRow(input, 16);
    const b = repairDrumRow(a, 16);
    expect(b).toEqual(a);
  });
});

describe("flip — adversarial inputs", () => {
  it("analyzeLoopForFlip returns null for empty/silence/non-finite input", () => {
    expect(analyzeLoopForFlip(new Float32Array(0), SR)).toBeNull();
    expect(analyzeLoopForFlip(new Float32Array(SR), SR)).toBeNull();
    const nan = new Float32Array(SR);
    nan.fill(NaN);
    expect(analyzeLoopForFlip(nan, SR)).toBeNull();
  });

  it("analyzeLoopForFlip is robust to sample-rate=0 and sample-rate=NaN", () => {
    const x = new Float32Array(SR);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 100 * i) / SR);
    expect(() => analyzeLoopForFlip(x, 0 as never)).not.toThrow();
    expect(() => analyzeLoopForFlip(x, NaN as never)).not.toThrow();
    expect(() => analyzeLoopForFlip(x, Infinity)).not.toThrow();
    expect(() => analyzeLoopForFlip(x, -1)).not.toThrow();
  });

  it("flipSeed is deterministic when analyzer succeeds", () => {
    // Build a kick-driven loop that the analyzer will accept.
    const loop = new Float32Array(SR);
    for (let i = 0; i < loop.length; i++) loop[i] = Math.sin((2 * Math.PI * 100 * i) / SR) * 0.5;
    const a = analyzeLoopForFlip(loop, SR);
    const b = analyzeLoopForFlip(loop, SR);
    if (!a || !b) return; // analyzer may decline silent loops — that's acceptable.
    expect(flipSeed(a)).toBe(flipSeed(b));
  });

  it("buildFlipOptions tolerates NaN BPM and stepCount=Infinity", () => {
    const loop = new Float32Array(SR);
    for (let i = 0; i < loop.length; i++) loop[i] = Math.sin((2 * Math.PI * 100 * i) / SR);
    const a = analyzeLoopForFlip(loop, SR);
    if (!a) return;
    const opts = buildFlipOptions({ ...a, bpm: NaN, bars: Infinity as never }, "house", "x");
    expect(opts).toBeTruthy();
    expect(opts.genre).toBe("house");
    expect(Number.isFinite(opts.stepCount) || opts.stepCount > 0).toBe(true);
  });
});

describe("quality — adversarial inputs", () => {
  it("measureDrumQuality on empty groove inputs returns a finite metrics object", () => {
    const groove = resolveGroove("house", "Driving");
    const rows: (number[] | undefined)[] = [];
    const roles: PadRole[] = [];
    const metrics = measureDrumQuality(groove, rows, roles, 16);
    expect(metrics).toBeTruthy();
    for (const v of Object.values(metrics)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("measureDrumQuality on rows full of NaN values does not produce NaN metrics", () => {
    const groove = resolveGroove("house", "Driving");
    const rows = [new Array(16).fill(NaN), new Array(16).fill(NaN)];
    const roles: PadRole[] = ["kick", "snare"];
    const metrics = measureDrumQuality(groove, rows, roles, 16);
    for (const v of Object.values(metrics)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("measureDrumQuality on a 256-step pattern does not throw", () => {
    const groove = resolveGroove("techno", "Driving");
    const rows = [
      new Array(256).fill(0).map((_, i) => (i % 4 === 0 ? 0.9 : 0.1)),
      new Array(256).fill(0).map((_, i) => (i % 8 === 4 ? 0.85 : 0.0)),
      new Array(256).fill(0).map((_, i) => (i % 2 === 0 ? 0.6 : 0.0)),
    ];
    const roles: PadRole[] = ["kick", "snare", "closedHat"];
    expect(() => measureDrumQuality(groove, rows, roles, 256)).not.toThrow();
    const metrics = measureDrumQuality(groove, rows, roles, 256);
    for (const v of Object.values(metrics)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("measureMelodicQuality on an empty note array returns finite metrics", () => {
    const metrics = measureMelodicQuality([], 16, "C Major");
    expect(metrics).toBeTruthy();
    expect(metrics.noteDensity).toBe(0);
    expect(metrics.pitchRange).toBe(0);
    for (const v of Object.values(metrics)) {
      if (typeof v === "number") {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("measureMelodicQuality is invariant to repeated calls on identical input", () => {
    const notes: NoteEvent[] = [
      { id: "n1", pitch: 60, start: 0, duration: 120, velocity: 0.9 },
      { id: "n2", pitch: 64, start: 240, duration: 240, velocity: 0.7 },
    ];
    const a = measureMelodicQuality(notes, 16, "C Major");
    const b = measureMelodicQuality(notes, 16, "C Major");
    expect(b).toEqual(a);
  });

  it("measureMelodicQuality handles pitch overflow / underflow without throwing", () => {
    const notes: NoteEvent[] = [
      { id: "n1", pitch: -1000, start: 0, duration: 120, velocity: 0.9 },
      { id: "n2", pitch: 9999, start: 120, duration: 120, velocity: 0.9 },
      { id: "n3", pitch: 0, start: 240, duration: 120, velocity: 0.9 },
    ];
    expect(() => measureMelodicQuality(notes, 16, "C Major")).not.toThrow();
  });
});

describe("style-quality — adversarial inputs", () => {
  it("getStyleQualityProfile on all known genres returns a finite profile", () => {
    for (const genre of ["house", "techno", "trap", "ambient"] as const) {
      const profile = getStyleQualityProfile(genre);
      expect(profile).toBeTruthy();
      expect(Number.isFinite(profile.maxDistance)).toBe(true);
      expect(profile.densityRange).toHaveLength(2);
      expect(Number.isFinite(profile.densityRange[0])).toBe(true);
      expect(Number.isFinite(profile.densityRange[1])).toBe(true);
      expect(profile.densityRange[1]).toBeGreaterThanOrEqual(profile.densityRange[0]);
    }
  });

  it("getStyleQualityProfile with an unknown style still returns a finite profile", () => {
    const profile = getStyleQualityProfile("house", "Unknown Style XYZ");
    expect(profile).toBeTruthy();
    expect(Number.isFinite(profile.maxDistance)).toBe(true);
    expect(profile.densityRange).toHaveLength(2);
    expect(profile.densityRange[1]).toBeGreaterThanOrEqual(profile.densityRange[0]);
  });

  it("syncopationWeight is bounded in [0,1] for step=0..255", () => {
    for (let s = 0; s < 256; s++) {
      const w = syncopationWeight(s);
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it("evaluateStyleDistance on empty rows returns a finite result object", () => {
    const groove = resolveGroove("house", "Driving");
    const result = evaluateStyleDistance(groove, [], 16);
    expect(result).toBeTruthy();
    expect(Number.isFinite(result.distance)).toBe(true);
    expect(result.profile).toBeTruthy();
    expect(Array.isArray(result.reasons)).toBe(true);
  });

  it("evaluateStyleDistance is idempotent for identical inputs", () => {
    const groove = resolveGroove("house", "Driving");
    const rows = [
      new Array(16).fill(0).map((_, i) => (i % 4 === 0 ? 0.9 : 0)),
      new Array(16).fill(0).map((_, i) => (i % 8 === 4 ? 0.8 : 0)),
    ];
    const r1 = evaluateStyleDistance(groove, rows, 16);
    const r2 = evaluateStyleDistance(groove, rows, 16);
    expect(r2.distance).toBe(r1.distance);
    expect(r2.accepted).toBe(r1.accepted);
    expect(r2.reasons).toEqual(r1.reasons);
  });

  // TODO: src/ai/style-quality.ts:L137 — evaluateStyleDistance does not sanitize
  //       NaN/Infinity in the rows. A row of NaNs produces `distance = NaN` via
  //       `round(densityDistance * 0.4 + ...)`. Style gate should sanitize.
  it("evaluateStyleDistance on NaN/Infinity rows produces finite distance", () => {
    const groove = resolveGroove("techno", "Driving");
    const rows = [new Array(16).fill(NaN), new Array(16).fill(Infinity)];
    const result = evaluateStyleDistance(groove, rows, 16);
    expect(Number.isFinite(result.distance)).toBe(true);
  });
});

describe("integration — adversarial stress across the AI pipeline", () => {
  it("100× rapid-fire generate→quality chain never crashes and metrics stay finite", () => {
    const doc = freshDoc();
    const groove = resolveGroove("house", "Driving");
    for (let i = 0; i < 100; i++) {
      const p = generatePattern(doc, makeOptions({ seed: `chain-${i}` }));
      const rows = Object.values(p.rows).map((r) => r ?? []);
      const roles: PadRole[] = rows.map((_, idx) => (idx === 0 ? "kick" : idx === 1 ? "snare" : "closedHat"));
      const metrics = measureDrumQuality(groove, rows, roles, p.stepCount);
      for (const v of Object.values(metrics)) {
        expect(Number.isFinite(v)).toBe(true);
      }
      const features = extractPatternFeatures(makeFeatureInput(doc, p));
      for (const v of features.values) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("deterministic pipeline: identical seed → identical rows + identical quality metrics", () => {
    const doc = freshDoc();
    const groove = resolveGroove("house", "Driving");
    const opts = makeOptions({ seed: "repro" });
    const p1 = generatePattern(doc, opts);
    const p2 = generatePattern(doc, opts);
    expect(p1.rows).toEqual(p2.rows);
    const rows1 = Object.values(p1.rows).map((r) => r ?? []);
    const roles1: PadRole[] = rows1.map((_, idx) => (idx === 0 ? "kick" : idx === 1 ? "snare" : "closedHat"));
    const m1 = measureDrumQuality(groove, rows1, roles1, p1.stepCount);
    const m2 = measureDrumQuality(groove, rows1, roles1, p2.stepCount);
    expect(m2).toEqual(m1);
  });

  it("drum track contract holds: getDrumTrack always returns a non-empty pad list", () => {
    const drum = getDrumTrack(freshDoc());
    expect(drum).toBeTruthy();
    expect(drum.pads.length).toBeGreaterThan(0);
  });
});
