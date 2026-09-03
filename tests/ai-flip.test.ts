import { describe, expect, it } from "vitest";
import { analyzeLoopForFlip, buildFlipOptions, flipSeed } from "../src/ai/flip";
import { createDefaultProject } from "../src/project-model/schema";
import { getDrumTrack } from "../src/project-model/types";
import { generatePatternCommand, stealGrooveIntoPattern } from "../src/commands/commands";

const SR = 44100;

function makeLoop(bpm: number, events: Array<{ step: number; lateSteps?: number; level?: number }>, bars = 2) {
  const stepSec = 60 / bpm / 4;
  const length = Math.floor(bars * 16 * stepSec * SR);
  const out = new Float32Array(length);
  for (const ev of events) {
    const start = Math.floor((ev.step + (ev.lateSteps ?? 0)) * stepSec * SR);
    for (let i = 0; i < Math.floor(SR * 0.02); i++) {
      const idx = start + i;
      if (idx >= length) break;
      out[idx] = Math.max(
        out[idx],
        Math.sin((2 * Math.PI * 800 * i) / SR) * Math.exp(-i / (SR * 0.003)) * (ev.level ?? 0.9),
      );
    }
  }
  return out;
}

const SWUNG_HOUSE = [
  { step: 0 },
  { step: 4 },
  { step: 8 },
  { step: 12 },
  { step: 2, lateSteps: 0.17, level: 0.5 },
  { step: 6, lateSteps: 0.17, level: 0.5 },
  { step: 10, lateSteps: 0.17, level: 0.5 },
  { step: 14, lateSteps: 0.17, level: 0.5 },
];

describe("analyzeLoopForFlip", () => {
  it("detects tempo, suggests bars and extracts a groove from a swung loop", () => {
    const analysis = analyzeLoopForFlip(makeLoop(124, SWUNG_HOUSE, 2), SR);
    expect(analysis).not.toBeNull();
    expect(Math.abs(analysis!.bpm - 124)).toBeLessThanOrEqual(1.5);
    expect(analysis!.bars).toBeGreaterThanOrEqual(1);
    expect(analysis!.bars).toBeLessThanOrEqual(4);
    // Swung offbeats show up as positive timing in the groove map.
    expect(analysis!.groove.timing[2]).toBeGreaterThan(0.1);
  });

  it("returns null for silence", () => {
    expect(analyzeLoopForFlip(new Float32Array(SR * 4), SR)).toBeNull();
  });

  it("flipSeed is deterministic and genre-independent", () => {
    const a = analyzeLoopForFlip(makeLoop(124, SWUNG_HOUSE, 2), SR)!;
    expect(flipSeed(a)).toBe(flipSeed(a));
    expect(flipSeed(a)).toMatch(/^flip-/);
  });
});

describe("buildFlipOptions", () => {
  it("maps analysis onto generator options (new pattern, grid steps)", () => {
    const analysis = analyzeLoopForFlip(makeLoop(124, SWUNG_HOUSE, 2), SR)!;
    const opts = buildFlipOptions(analysis, "techno", "seed-1");
    expect(opts.genre).toBe("techno");
    expect(opts.replaceMode).toBe("new");
    expect(opts.stepCount).toBeGreaterThanOrEqual(16);
    expect(opts.stepCount).toBeLessThanOrEqual(64);
    expect(opts.stepCount % 16).toBe(0);
    expect(opts.seed).toBe("seed-1");
  });
});

describe("flip orchestration (generate + groove overlay)", () => {
  it("generate creates and activates a NEW pattern for the flip", () => {
    const doc = createDefaultProject();
    const analysis = analyzeLoopForFlip(makeLoop(124, SWUNG_HOUSE, 2), SR)!;
    const gen = generatePatternCommand(doc, buildFlipOptions(analysis, "house", "flip-seed"), "Flip 0b");
    const generated = gen.execute(doc);
    expect(generated.activePatternId).not.toBe(doc.activePatternId);
    expect(generated.scenes.some((sc) => sc.patternId === generated.activePatternId)).toBe(true);
  });

  it("groove overlay lands swung timing on matching active steps (deterministic pattern)", () => {
    const doc = createDefaultProject();
    const drum = getDrumTrack(doc);
    const kick = drum.pads[0].id;
    // Quarters on the kick, swung 8th hats on slots 2/6/10/14 — the loop's
    // groove map then re-times exactly those slots.
    const rows: Record<string, number[]> = {
      [kick]: [0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0],
    };
    const hat = drum.pads[8]?.id ?? drum.pads[1].id;
    rows[hat] = [0, 0, 0.6, 0, 0, 0, 0.6, 0, 0, 0, 0.6, 0, 0, 0, 0.6, 0];
    const withRows = {
      ...doc,
      patterns: doc.patterns.map((p) => (p.id === doc.activePatternId ? { ...p, rows } : p)),
    };
    const groove = { timing: [0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0], accent: new Array(16).fill(1) };
    const next = stealGrooveIntoPattern(withRows, doc.activePatternId, groove, { applyVelocity: false }).execute(
      withRows,
    );
    const pattern = next.patterns.find((p) => p.id === doc.activePatternId)!;
    const meta = pattern.stepMeta?.[hat];
    expect(meta?.[2]?.microtiming).toBeCloseTo(0.5, 4);
    expect(meta?.[6]?.microtiming).toBeCloseTo(0.5, 4);
    // Kick quarters sit on the grid — untouched (timing 0 written but harmless).
    expect(pattern.rows[hat][2]).toBeCloseTo(0.6, 4);
  });
});
