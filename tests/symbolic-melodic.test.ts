import { describe, it, expect, vi, beforeEach } from "vitest";
import { testDoc } from "./fixtures/doc";
import { MELODIC_BY_GENRE } from "../src/ai/grooves/melodic-data";
import {
  MELODIC_FEATURE_COUNT,
  buildMelodicFeatureRow,
  contourClass,
  durationClass,
} from "../src/ai/symbolic/melodic-features";
import { planGeneration } from "../src/intent/plan";
import { normalizeIntent } from "../src/intent/normalize";
import { symbolicPriorProvider } from "../src/intent/providers/symbolic";
import { snapToScale } from "../src/project-model/scales";

// Drums answer deterministically; melodic answers with a fixed distribution
// pair (root-favoring degree head, 8th-note-favoring duration head).
vi.mock("../src/ai/symbolic/prior-client", () => ({
  runPriorGrid: vi.fn(),
  runMelodicNext: vi.fn(),
  priorMode: vi.fn(() => "on" as const),
  resetPriorClient: vi.fn(),
  currentPriorManifest: vi.fn(() => null),
}));

import { runMelodicNext, runPriorGrid } from "../src/ai/symbolic/prior-client";

const runPriorGridMock = vi.mocked(runPriorGrid);
const runMelodicNextMock = vi.mocked(runMelodicNext);

beforeEach(() => {
  runPriorGridMock.mockReset();
  runPriorGridMock.mockImplementation(async (batch: Float32Array, rowCount: number) => ({
    ok: batch.length === rowCount * 44,
    probs: new Array(rowCount).fill(0.3),
    source: "model" as const,
  }));
  runMelodicNextMock.mockReset();
  runMelodicNextMock.mockImplementation(async (batch: Float32Array, rowCount: number) => {
    if (batch.length !== rowCount * 29) return { ok: false, degree: null, duration: null, source: "fallback" as const };
    const degree: number[] = [];
    const duration: number[] = [];
    for (let row = 0; row < rowCount; row++) {
      degree.push(0.15, 0.4, 0.1, 0.1, 0.1, 0.1, 0.03, 0.02);
      duration.push(0.1, 0.7, 0.1, 0.1);
    }
    return { ok: true, degree, duration, source: "model" as const };
  });
});

describe("melodic-features contract", () => {
  it("melodic library covers all four genres with all three roles", () => {
    for (const genre of ["house", "techno", "trap", "ambient"]) {
      const roles = (MELODIC_BY_GENRE[genre] ?? []).map((pattern) => pattern.role).sort();
      expect(roles).toEqual(["bass", "chord", "lead"]);
    }
  });

  it("produces deterministic fixed-width rows with correct one-hots", () => {
    const input = {
      genre: "house" as const,
      role: "bass" as const,
      startStep: 4,
      prevDegree: 0,
      prevDuration: 2,
      prevPrevDegree: 4,
    };
    const a = buildMelodicFeatureRow(input);
    const b = buildMelodicFeatureRow(input);
    expect(a).toEqual(b);
    expect(a.length).toBe(MELODIC_FEATURE_COUNT);
    expect(a[0]).toBe(1); // house
    expect(a[4]).toBe(1); // bass
    // prev degree 0 → class 1 (offset 4+3+5=12)
    expect(a[12 + 1]).toBe(1);
    // prev duration 2 → class 1 (offset 12+8=20)
    expect(a[20 + 1]).toBe(1);
    // contour prev(0) - prevPrev(4) = -4 → big-down (offset 24)
    expect(a[24]).toBe(1);
    for (const value of a) expect(Number.isFinite(value)).toBe(true);
  });

  it("clamps durations to the nearest class and rests to class 0", () => {
    expect(durationClass(1)).toBe(0);
    expect(durationClass(3)).toBe(1); // closer to 2 than 4
    expect(durationClass(16)).toBe(3);
    const restRow = buildMelodicFeatureRow({
      genre: "trap",
      role: "lead",
      startStep: 0,
      prevDegree: -1,
      prevDuration: 4,
      prevPrevDegree: -1,
    });
    expect(restRow[12]).toBe(1); // prev degree rest → class 0
    expect(restRow[20 + 2]).toBe(1); // duration 4 → class 2
  });

  it("maps contour intervals to the five buckets", () => {
    expect(contourClass(-5)).toBe(0);
    expect(contourClass(-2)).toBe(1);
    expect(contourClass(0)).toBe(2);
    expect(contourClass(2)).toBe(3);
    expect(contourClass(4)).toBe(4);
  });
});

describe("melodic prior sampling in the provider", () => {
  const intent = normalizeIntent({
    genre: "house",
    seed: "melodic-test",
    length: 16,
    candidateCount: 0,
    symbolicCandidates: 1,
    key: "C Natural Minor",
    roles: ["drums", "bass", "chords", "lead"],
  });
  const doc = testDoc();

  it("produces prior-sampled notes that are in-key by construction", async () => {
    const plan = planGeneration(intent, doc);
    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      0,
    );
    expect(failures).toEqual([]);
    expect(entries.length).toBe(1);
    const notes = Object.values(entries[0].pattern.notes ?? {}).flat();
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note.pitch).toBe(snapToScale(note.pitch, "C Natural Minor"));
      expect(note.velocity).toBeGreaterThan(0);
      expect(note.duration).toBeGreaterThan(0);
    }
    // name marks the melodic prior participation
    expect(entries[0].pattern.name).toContain("+melody");
  });

  it("is deterministic for the same plan and stubbed distributions", async () => {
    const plan = planGeneration(intent, doc);
    const first = await symbolicPriorProvider.collectCandidates(plan, { project: doc, mode: "apply" }, 0);
    const second = await symbolicPriorProvider.collectCandidates(plan, { project: doc, mode: "apply" }, 0);
    const stripIds = (notes: unknown) => JSON.stringify(notes, (key, value) => (key === "id" ? undefined : value));
    expect(stripIds(first.entries[0].pattern.notes)).toBe(stripIds(second.entries[0].pattern.notes));
    expect(first.entries[0].pattern.rows).toEqual(second.entries[0].pattern.rows);
  });

  it("falls back to template melody when the melodic prior is unavailable", async () => {
    runMelodicNextMock.mockResolvedValue({ ok: false, degree: null, duration: null, source: "fallback" });
    const plan = planGeneration(intent, doc);
    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      0,
    );
    expect(failures).toEqual([]); // melodic fallback is NOT a failure — candidate stays
    expect(entries.length).toBe(1);
    expect(entries[0].pattern.name).not.toContain("+melody");
    const notes = Object.values(entries[0].pattern.notes ?? {}).flat();
    expect(notes.length).toBeGreaterThan(0); // template melody preserved
  });
});
