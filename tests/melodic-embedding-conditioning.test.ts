import { describe, it, expect, vi, beforeEach } from "vitest";
import { testDoc } from "./fixtures/doc";
import {
  MELV2_FEATURE_COUNT,
  MELV2_SEMANTIC_DIMS,
  buildMelodicV2FeatureRow,
} from "../src/ai/symbolic/melodic-features-v2";
import { MELODIC_DURATION_CLASSES, MELODIC_DEGREE_CLASSES } from "../src/ai/symbolic/melodic-features";
import { projectEmbedding } from "../src/ai/symbolic/pca-projection";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { symbolicPriorProvider } from "../src/intent/providers/symbolic";

// Provider tests need the melodic ONNX prior to answer, so the worker client
// is stubbed (the REAL v2 artifact is validated by validate-symbolic-melodic.mjs v2).
const priorFlagState = vi.hoisted(() => ({ value: "off" as "off" | "on" }));
vi.mock("../src/ai/symbolic/prior-client", () => ({
  priorMode: vi.fn(() => "on" as const),
  embeddingConditionedMode: vi.fn(() => priorFlagState.value),
  runPriorGrid: vi.fn(),
  runPriorGridV2: vi.fn(),
  runMelodicNext: vi.fn(async () => ({ ok: false, degree: null, duration: null, source: "fallback" as const })),
  runMelodicNextV2: vi.fn(async () => ({ ok: false, degree: null, duration: null, source: "fallback" as const })),
  resetPriorClient: vi.fn(),
  currentPriorManifest: vi.fn(() => null),
}));

// Multi-voice is force-emptied so the melodic ONNX prior path (2nd priority)
// is the one that answers.
const multiVoiceState = vi.hoisted(() => ({ empty: false }));
vi.mock("../src/intent/multi-voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/intent/multi-voice")>();
  return {
    ...actual,
    generateMultiVoice: (...args: Parameters<typeof actual.generateMultiVoice>) =>
      multiVoiceState.empty
        ? { bass: [], chord: [], lead: [], progressionName: "empty", progressionDegree: 0 }
        : actual.generateMultiVoice(...args),
  };
});

// The semantic WORKER is the real MiniLM runtime — stub the embed call; the
// REAL conditioning chain (flag gate → cache → PCA projection) stays live.
vi.mock("../src/ai/semantic/semantic-client", () => ({
  semanticMode: vi.fn(() => "on" as const),
  semanticAvailable: vi.fn(async () => true),
  embedTexts: vi.fn(async () => null),
  resetSemanticClient: vi.fn(),
}));

import {
  runMelodicNext,
  runMelodicNextV2 as runMelodicNextV2Mocked,
  runPriorGrid,
  runPriorGridV2,
} from "../src/ai/symbolic/prior-client";
import { embedTexts } from "../src/ai/semantic/semantic-client";

const embedTextsMock = vi.mocked(embedTexts);
const runMelodicNextMock = vi.mocked(runMelodicNext);
const runMelodicNextV2Mock = vi.mocked(runMelodicNextV2Mocked);
const runPriorGridMock = vi.mocked(runPriorGrid);
const runPriorGridV2Mock = vi.mocked(runPriorGridV2);

/** Dual-head answer: degree 1 ("degree 0") + duration class 1, deterministic. */
function stubMelodicRow(degreeHead: number[], durationHead: number[]) {
  return async (_batch: Float32Array, rowCount: number) => {
    const degree: number[] = [];
    const duration: number[] = [];
    for (let row = 0; row < rowCount; row++) {
      degree.push(...degreeHead);
      duration.push(...durationHead);
    }
    return { ok: true, degree, duration, source: "model" as const };
  };
}

beforeEach(() => {
  priorFlagState.value = "off";
  multiVoiceState.empty = false;
  runMelodicNextMock.mockReset();
  runMelodicNextV2Mock.mockReset();
  embedTextsMock.mockReset();
  embedTextsMock.mockResolvedValue(null);
  runMelodicNextMock.mockResolvedValue({ ok: false, degree: null, duration: null, source: "fallback" });
  runMelodicNextV2Mock.mockResolvedValue({ ok: false, degree: null, duration: null, source: "fallback" });
  // The DRUM branch of the provider runs in every candidate — keep it green so
  // melodic-path assertions are the only thing under test.
  runPriorGridMock.mockReset();
  runPriorGridV2Mock.mockReset();
  runPriorGridMock.mockImplementation(async (_batch: Float32Array, rowCount: number) => ({
    ok: true,
    probs: new Array(rowCount).fill(0.4),
    source: "model" as const,
  }));
  runPriorGridV2Mock.mockImplementation(async (_batch: Float32Array, rowCount: number) => ({
    ok: true,
    probs: new Array(rowCount).fill(0.4),
    source: "model" as const,
  }));
});

describe("melodic-features-v2 contract", () => {
  const SEMANTIC = Array.from({ length: MELV2_SEMANTIC_DIMS }, (_, index) => (index - 8) / 16);

  it("produces 41-dim rows: semantic(16) + role(3) + step(5) + prev_degree(8) + prev_dur(4) + contour(5)", () => {
    expect(MELV2_FEATURE_COUNT).toBe(41);
    expect(MELODIC_DEGREE_CLASSES).toBe(8);
    expect(MELODIC_DURATION_CLASSES).toBe(4);
    const row = buildMelodicV2FeatureRow({
      semantic: SEMANTIC,
      role: "lead",
      startStep: 0,
      prevDegree: -1,
      prevDuration: 2,
      prevPrevDegree: -1,
    });
    expect(row.length).toBe(MELV2_FEATURE_COUNT);
    // semantic projection copied verbatim
    expect(row.slice(0, MELV2_SEMANTIC_DIMS)).toEqual(SEMANTIC);
    // role one-hot: "lead" is index 2
    expect(row[MELV2_SEMANTIC_DIMS + 2]).toBe(1);
    // step phase 0: s16/16=0, sin(0)=0, cos(0)=1
    expect(row[MELV2_SEMANTIC_DIMS + 3]).toBeCloseTo(0);
    expect(row[MELV2_SEMANTIC_DIMS + 4]).toBeCloseTo(0);
    expect(row[MELV2_SEMANTIC_DIMS + 5]).toBeCloseTo(1);
    // prev degree rest → class 0
    expect(row[MELV2_SEMANTIC_DIMS + 8]).toBe(1);
    // contour "same" (sequence start) → class 2 — last block
    expect(row[MELV2_FEATURE_COUNT - 3]).toBe(1);
  });

  it("is deterministic and keeps the autoregressive context blocks", () => {
    const input = {
      semantic: SEMANTIC,
      role: "bass" as const,
      startStep: 6,
      prevDegree: 3,
      prevDuration: 4,
      prevPrevDegree: 1,
    };
    const a = buildMelodicV2FeatureRow(input);
    const b = buildMelodicV2FeatureRow(input);
    expect(a).toEqual(b);
    // prev degree 3 → class 4
    expect(a[MELV2_SEMANTIC_DIMS + 8 + 4]).toBe(1);
    // prev duration 4 steps → class 2
    expect(a[MELV2_SEMANTIC_DIMS + 8 + 8 + 2]).toBe(1);
  });
});

describe("runMelodicNextV2 gating", () => {
  it("flag off → ok:false without any model work (source off)", async () => {
    const actual = await vi.importActual<typeof import("../src/ai/symbolic/prior-client")>(
      "../src/ai/symbolic/prior-client",
    );
    const result = await actual.runMelodicNextV2(new Float32Array(41), 1);
    expect(result.ok).toBe(false);
    expect(result.source).toBe("off");
  });
});

describe("provider melodic v2 path", () => {
  function planFor() {
    const doc = testDoc();
    const intent = normalizeIntent({
      genre: "house",
      seed: "melodic-v2-test",
      candidateCount: 0,
      symbolicCandidates: 1,
      text: "deep rainy berlin house",
      roles: ["drums", "bass", "chords", "lead"],
    });
    return { doc, plan: planGeneration(intent, doc) };
  }

  it("flag on + semantic → v2 41-dim batches, '+melody' name without '+mv'", async () => {
    priorFlagState.value = "on";
    multiVoiceState.empty = true;
    const { doc, plan } = planFor();
    const embedding = new Float32Array(384).fill(0.01);
    const expectedSemantic = projectEmbedding(embedding) as number[];
    embedTextsMock.mockResolvedValue([embedding]);
    runMelodicNextV2Mock.mockImplementation(async (batch: Float32Array, rowCount: number) => {
      expect(batch.length).toBe(rowCount * MELV2_FEATURE_COUNT);
      // semantic block = the REAL PCA projection (Float32-truncated by the batch)
      const rowSemantic = Array.from(batch.slice(0, MELV2_SEMANTIC_DIMS));
      rowSemantic.forEach((value, dim) => expect(value).toBeCloseTo(expectedSemantic[dim], 6));
      return {
        ok: true,
        degree: [0.05, 0.6, 0.1, 0.1, 0.05, 0.05, 0.03, 0.02],
        duration: [0.1, 0.7, 0.1, 0.1],
        source: "model" as const,
      };
    });

    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      0,
    );
    expect(failures).toEqual([]);
    expect(entries.length).toBe(1);
    expect(runMelodicNextV2Mock).toHaveBeenCalled();
    expect(runMelodicNextMock).not.toHaveBeenCalled(); // no v1 fallback on success
    const notes = Object.values(entries[0].pattern.notes ?? {}).flat();
    expect(notes.length).toBeGreaterThan(0);
    expect(entries[0].pattern.name).toContain("+melody"); // melodic prior marker
    expect(entries[0].pattern.name).not.toContain("+mv"); // multi-voice was empty
  });

  it("v2 unavailable → v1 one-hot fallback answers with 29-dim rows", async () => {
    priorFlagState.value = "on";
    multiVoiceState.empty = true;
    const { doc, plan } = planFor();
    runMelodicNextMock.mockImplementation(
      stubMelodicRow([0.05, 0.6, 0.1, 0.1, 0.05, 0.05, 0.03, 0.02], [0.1, 0.7, 0.1, 0.1]),
    );

    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      0,
    );
    expect(failures).toEqual([]);
    expect(entries.length).toBe(1);
    expect(runMelodicNextV2Mock).toHaveBeenCalled(); // tried first
    expect(runMelodicNextMock).toHaveBeenCalled(); // then answered
    const notes = Object.values(entries[0].pattern.notes ?? {}).flat();
    expect(notes.length).toBeGreaterThan(0);
    expect(entries[0].pattern.name).toContain("+melody");
  });

  it("flag off → straight to v1 (no v2 attempt)", async () => {
    multiVoiceState.empty = true;
    const { doc, plan } = planFor();
    runMelodicNextMock.mockImplementation(
      stubMelodicRow([0.05, 0.6, 0.1, 0.1, 0.05, 0.05, 0.03, 0.02], [0.1, 0.7, 0.1, 0.1]),
    );

    const { entries } = await symbolicPriorProvider.collectCandidates(plan, { project: doc, mode: "apply" }, 0);
    expect(runMelodicNextV2Mock).not.toHaveBeenCalled();
    expect(runMelodicNextMock).toHaveBeenCalled();
    expect(entries.length).toBe(1);
  });
});
