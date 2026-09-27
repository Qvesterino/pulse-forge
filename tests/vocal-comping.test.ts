import { describe, it, expect } from "vitest";
import { planVocalComp, suggestArrangementFromVocal } from "../src/vocal/comping";
import type { VocalProfile, VocalPhrase } from "../src/vocal/types";

/**
 * VOCAL COMPING + ARRANGEMENT DIALOGUE (vocal lane pilot) — pure functions
 * over measured profiles: multi-take segment scoring (the comp) and
 * arrangement suggestions that trace to measured facts. Harmony generation
 * is deliberately absent until pitch extraction exists.
 */

function profile(overrides: {
  bars?: number;
  energy?: (bar: number) => number;
  phrases?: VocalPhrase[];
  snrDb?: number;
  measured?: boolean;
}): VocalProfile {
  const bars = overrides.bars ?? 8;
  const energyCurve = Array.from({ length: bars }, (_, bar) => (overrides.energy ? overrides.energy(bar) : 0.5));
  return {
    version: 1,
    key: null,
    keyConfidence: 0,
    keyMeasured: false,
    tempoBpm: null,
    tempoConfidence: 0,
    tempoMeasured: false,
    energyCurve,
    phrases: overrides.phrases ?? [],
    silenceRatio: 0,
    snrDb: overrides.snrDb ?? 30,
    durationSec: bars * 2,
    bars,
    bpm: 120,
    measured: overrides.measured ?? true,
    profileHash: `hash-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function phrase(startBar: number, endBar: number, peakEnergy = 0.8): VocalPhrase {
  return { startBar, endBar, peakEnergy };
}

describe("planVocalComp", () => {
  it("needs at least two measured takes", () => {
    const one = profile({ phrases: [phrase(0, 3)] });
    expect(planVocalComp([one])).toBeNull();
    const failed = profile({ measured: false });
    expect(planVocalComp([one, failed])).toBeNull();
  });

  it("awards each bar to the take that sings it louder", () => {
    const a = profile({
      phrases: [phrase(0, 3, 0.9)],
      energy: (bar) => (bar <= 3 ? 0.9 : 0),
    });
    const b = profile({
      phrases: [phrase(4, 7, 0.95)],
      energy: (bar) => (bar >= 4 ? 0.95 : 0),
    });
    const plan = planVocalComp([a, b])!;
    expect(plan.bars).toBe(8);
    expect(plan.sungBars).toBe(8);
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0]).toMatchObject({ startBar: 0, endBar: 3, takeIndex: 0 });
    expect(plan.segments[1]).toMatchObject({ startBar: 4, endBar: 7, takeIndex: 1 });
    expect(plan.perTakeBars).toEqual([4, 4]);
  });

  it("merges consecutive same-winner bars into one segment", () => {
    const a = profile({ phrases: [phrase(0, 7, 0.9)], energy: () => 0.9 });
    const b = profile({ phrases: [phrase(0, 2, 0.5)], energy: (bar) => (bar <= 2 ? 0.4 : 0) });
    const plan = planVocalComp([a, b])!;
    expect(plan.segments).toHaveLength(1);
    expect(plan.winner).toBe(0);
    expect(plan.perTakeBars[0]).toBe(8);
  });

  it("keeps gaps honest when nobody sings a bar", () => {
    const a = profile({ phrases: [phrase(0, 2, 0.9)], energy: (bar) => (bar <= 2 ? 0.9 : 0) });
    const b = profile({ phrases: [phrase(6, 7, 0.9)], energy: (bar) => (bar >= 6 ? 0.9 : 0) });
    const plan = planVocalComp([a, b])!;
    expect(plan.sungBars).toBe(5);
    // bars 3-5 are an honest gap — no segment covers them
    const covered = plan.segments.flatMap((s) =>
      Array.from({ length: s.endBar - s.startBar + 1 }, (_, i) => s.startBar + i),
    );
    expect(covered).not.toContain(3);
    expect(covered).not.toContain(5);
  });

  it("is deterministic", () => {
    const a = profile({ phrases: [phrase(0, 5, 0.9)], energy: (bar) => 0.5 + bar * 0.05 });
    const b = profile({ phrases: [phrase(3, 7, 0.8)], energy: (bar) => 0.9 - bar * 0.05 });
    const one = planVocalComp([a, b]);
    const two = planVocalComp([a, b]);
    expect(one).toEqual(two);
  });
});

describe("suggestArrangementFromVocal", () => {
  it("suggests an earlier hook when the climax sits past mid-point", () => {
    const late = profile({ bars: 16, phrases: [phrase(0, 3, 0.5), phrase(10, 15, 0.95)] });
    const suggestions = suggestArrangementFromVocal(late);
    expect(suggestions.some((s) => s.type === "late-hook")).toBe(true);
  });

  it("recognizes an early hook", () => {
    const early = profile({ bars: 16, phrases: [phrase(1, 4, 0.95), phrase(8, 12, 0.6)] });
    const suggestions = suggestArrangementFromVocal(early);
    expect(suggestions.some((s) => s.type === "early-hook")).toBe(true);
  });

  it("finds the silence pocket between phrases", () => {
    const gappy = profile({ bars: 16, phrases: [phrase(0, 2, 0.7), phrase(9, 12, 0.7)] });
    const suggestions = suggestArrangementFromVocal(gappy);
    const pocket = suggestions.find((s) => s.type === "silence-pocket");
    expect(pocket).toBeDefined();
    expect(pocket!.startBar).toBe(3);
    expect(pocket!.endBar).toBe(8);
  });

  it("flags the energy climax bar", () => {
    const climax = profile({
      bars: 8,
      phrases: [phrase(0, 7, 0.9)],
      energy: (bar) => (bar === 5 ? 1 : 0.4),
    });
    const suggestions = suggestArrangementFromVocal(climax);
    const peak = suggestions.find((s) => s.type === "energy-climax");
    expect(peak).toBeDefined();
    expect(peak!.startBar).toBe(5);
  });

  it("admits deafness: unmeasured or phrase-less takes get no suggestions", () => {
    expect(suggestArrangementFromVocal(profile({ measured: false }))).toEqual([]);
    expect(suggestArrangementFromVocal(profile({ phrases: [] }))).toEqual([]);
  });
});
