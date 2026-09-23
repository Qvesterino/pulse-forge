import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testDoc } from "./fixtures/doc";
import pcaReference from "../scripts/data/pca-embedding-projection.json";
import {
  V2_FEATURE_COUNT,
  V2_ROLE_VOCAB,
  V2_SEMANTIC_DIMS,
  buildPriorV2FeatureRow,
  buildPriorV2GridRows,
} from "../src/ai/symbolic/prior-features-v2";
import { projectEmbedding, pcaInputDims, pcaOutputDims, pcaVersion } from "../src/ai/symbolic/pca-projection";
import { runPriorGrid, runPriorGridV2, runPriorGridV3 } from "../src/ai/symbolic/prior-client";
import { buildPriorV3FeatureRow, V3_FEATURE_COUNT, V3_SEMANTIC_DIMS } from "../src/ai/symbolic/prior-features-v3";
import { buildPriorFeatureRow, PRIOR_FEATURE_COUNT } from "../src/ai/symbolic/prior-features";
import { resetSemanticConditioning, semanticConditioning } from "../src/intent/semantic-conditioning";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { symbolicPriorProvider } from "../src/intent/providers/symbolic";

// The prior worker is an ORT/Web-Worker runtime — unit tests stub the client.
// The REAL v2 artifact is validated by scripts/validate-symbolic-prior.mjs v2.
const priorFlagState = vi.hoisted(() => ({ value: "off" as "off" | "on" }));
vi.mock("../src/ai/symbolic/prior-client", () => ({
  priorMode: vi.fn(() => "on" as const),
  embeddingConditionedMode: vi.fn(() => priorFlagState.value),
  runPriorGrid: vi.fn(),
  runPriorGridV2: vi.fn(),
  runPriorGridV3: vi.fn(),
  runMelodicNext: vi.fn(async () => ({ ok: false, degree: null, duration: null, source: "fallback" as const })),
  resetPriorClient: vi.fn(),
  currentPriorManifest: vi.fn(() => null),
}));

// The semantic WORKER is the real MiniLM runtime — stub the embed call; the
// REAL conditioning chain (flag gate → cache → PCA projection) stays live.
vi.mock("../src/ai/semantic/semantic-client", () => ({
  semanticMode: vi.fn(() => "on" as const),
  semanticAvailable: vi.fn(async () => true),
  embedTexts: vi.fn(async () => null),
  resetSemanticClient: vi.fn(),
}));

import { embedTexts } from "../src/ai/semantic/semantic-client";

const embedTextsMock = vi.mocked(embedTexts);
const runPriorGridMock = vi.mocked(runPriorGrid);
const runPriorGridV2Mock = vi.mocked(runPriorGridV2);
const runPriorGridV3Mock = vi.mocked(runPriorGridV3);

const FLAG = "pf:embedding-conditioned";

/** Deterministic pseudo-random vector (LCG) — stable across runs. */
function deterministicVector(dims: number, seed = 42): Float32Array {
  const out = new Float32Array(dims);
  let state = seed >>> 0;
  for (let index = 0; index < dims; index++) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    out[index] = (state / 0xffffffff) * 2 - 1;
  }
  return out;
}

beforeEach(() => {
  localStorage.setItem(FLAG, "off"); // default is ON since the v3 gate passed — off-scenarios set it explicitly
  priorFlagState.value = "off";
  resetSemanticConditioning();
  runPriorGridMock.mockReset();
  runPriorGridV2Mock.mockReset();
  runPriorGridV3Mock.mockReset();
  embedTextsMock.mockReset();
  embedTextsMock.mockResolvedValue(null);
});

afterEach(() => {
  localStorage.removeItem(FLAG);
});

describe("prior-features-v2 contract", () => {
  const SEMANTIC = Array.from({ length: V2_SEMANTIC_DIMS }, (_, index) => (index - 8) / 16);

  it("produces 35-dim rows: semantic(16) + role(9) + step(5) + frame(3) + flags(2)", () => {
    expect(V2_FEATURE_COUNT).toBe(35);
    const row = buildPriorV2FeatureRow({ semantic: SEMANTIC, role: "kick", step: 0, stepCount: 16 });
    expect(row.length).toBe(V2_FEATURE_COUNT);
    // semantic projection copied verbatim
    expect(row.slice(0, V2_SEMANTIC_DIMS)).toEqual(SEMANTIC);
    // role one-hot right after the semantic block
    const roleOffset = V2_SEMANTIC_DIMS;
    expect(row.slice(roleOffset, roleOffset + V2_ROLE_VOCAB.length).filter((v) => v !== 0)).toEqual([1]);
    expect(row[roleOffset + V2_ROLE_VOCAB.indexOf("kick")]).toBe(1);
    // step-in-bar encoding: step 0 → phase 0
    const stepOffset = roleOffset + V2_ROLE_VOCAB.length;
    expect(row[stepOffset]).toBeCloseTo(0);
    expect(row[stepOffset + 1]).toBeCloseTo(0); // sin(0)
    expect(row[stepOffset + 2]).toBeCloseTo(1); // cos(0)
    // frame position
    expect(row[stepOffset + 5]).toBeCloseTo(0);
    // downbeat flag set, backbeat clear
    expect(row[stepOffset + 8]).toBe(1);
    expect(row[stepOffset + 9]).toBe(0);
  });

  it("builds pad-major grid rows deterministically", () => {
    const padRoles = ["kick", "snare", "closedHat"];
    const stepCount = 16;
    const rows = buildPriorV2GridRows({ semantic: SEMANTIC, padRoles, stepCount });
    expect(rows.length).toBe(padRoles.length * stepCount);
    expect(rows.map((row) => row.length).every((length) => length === V2_FEATURE_COUNT)).toBe(true);
    const again = buildPriorV2GridRows({ semantic: SEMANTIC, padRoles, stepCount });
    expect(rows).toEqual(again);
    // second pad block starts at padRoles[1]
    expect(rows[stepCount].slice(V2_SEMANTIC_DIMS, V2_SEMANTIC_DIMS + V2_ROLE_VOCAB.length).indexOf(1)).toBe(
      V2_ROLE_VOCAB.indexOf("snare"),
    );
  });
});

describe("pca-projection module", () => {
  it("matches the full-precision reference projection within quantization error", () => {
    expect(pcaVersion()).toBe(pcaReference.version);
    expect(pcaInputDims()).toBe(pcaReference.inputDims);
    expect(pcaOutputDims()).toBe(pcaReference.outputDims);

    const vector = deterministicVector(pcaReference.inputDims);
    const projected = projectEmbedding(vector);
    expect(projected).not.toBeNull();
    // full-precision reference: components @ (vector − mean)
    const reference = pcaReference.components.map((component) =>
      component.reduce((sum, weight, dim) => sum + weight * (vector[dim] - pcaReference.mean[dim]), 0),
    );
    for (let dim = 0; dim < pcaOutputDims(); dim++) {
      expect(Math.abs((projected as number[])[dim] - reference[dim])).toBeLessThan(0.05);
    }
  });

  it("rejects wrong-dim and non-finite input; deterministic", () => {
    expect(projectEmbedding(new Float32Array(383))).toBeNull();
    const withNaN = deterministicVector(384);
    withNaN[7] = Number.NaN;
    expect(projectEmbedding(withNaN)).toBeNull();
    const vector = deterministicVector(384, 7);
    expect(projectEmbedding(vector)).toEqual(projectEmbedding(vector));
  });
});

describe("semantic-conditioning gate", () => {
  it("flag off → null without touching the embedder", async () => {
    const result = await semanticConditioning("dark rainy berlin techno", embedTextsMock);
    expect(result).toBeNull();
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it("flag on + 384-dim embed → 16-dim finite conditioning, memoized per text", async () => {
    localStorage.setItem(FLAG, "on");
    priorFlagState.value = "on";
    embedTextsMock.mockResolvedValue([deterministicVector(384)]);
    const first = await semanticConditioning("dark rainy berlin techno", embedTextsMock);
    expect(first).not.toBeNull();
    expect(first?.length).toBe(16);
    expect(first?.every((value) => Number.isFinite(value))).toBe(true);
    const second = await semanticConditioning("dark rainy berlin techno", embedTextsMock);
    expect(second).toEqual(first);
    expect(embedTextsMock).toHaveBeenCalledTimes(1);
  });

  it("unavailable embedder → null (v1 fallback); blank text → null without embed", async () => {
    localStorage.setItem(FLAG, "on");
    priorFlagState.value = "on";
    expect(await semanticConditioning("deep house", embedTextsMock)).toBeNull();
    expect(embedTextsMock).toHaveBeenCalledTimes(1); // the probe above
    expect(await semanticConditioning("   ", embedTextsMock)).toBeNull();
    expect(embedTextsMock).toHaveBeenCalledTimes(1); // blank text never embeds
  });
});

describe("client flag", () => {
  it("defaults ON since the v3 gate; explicit off; garbage falls back to ON", async () => {
    const actual = await vi.importActual<typeof import("../src/ai/symbolic/prior-client")>(
      "../src/ai/symbolic/prior-client",
    );
    localStorage.removeItem(FLAG); // default = empty storage
    expect(actual.embeddingConditionedMode()).toBe("on");
    localStorage.setItem(FLAG, "off");
    expect(actual.embeddingConditionedMode()).toBe("off");
    localStorage.setItem(FLAG, "garbage");
    expect(actual.embeddingConditionedMode()).toBe("on");
  });
});

describe("provider embedding-conditioned path", () => {
  function planFor() {
    const doc = testDoc();
    const intent = normalizeIntent({
      genre: "house",
      seed: "embedding-conditioned",
      candidateCount: 0,
      symbolicCandidates: 1,
      text: "dark rainy berlin techno",
      roles: ["drums", "bass", "chords", "lead"],
    });
    return { doc, plan: planGeneration(intent, doc) };
  }

  it("flag on + semantic answer → 60-dim batch through the v3 hybrid, '+sem' name", async () => {
    priorFlagState.value = "on";
    const { doc, plan } = planFor();
    const embedding = deterministicVector(384);
    const expectedProjection = projectEmbedding(embedding) as number[];
    runPriorGridV3Mock.mockImplementation(async (batch: Float32Array, rowCount: number) => {
      expect(batch.length).toBe(rowCount * V3_FEATURE_COUNT);
      // semantic block = the REAL PCA projection of the stubbed embedding
      // (Float32-truncated by the batch — compare loosely)
      const rowSemantic = Array.from(batch.slice(0, V3_SEMANTIC_DIMS));
      rowSemantic.forEach((value, dim) => expect(value).toBeCloseTo(expectedProjection[dim], 6));
      // v3 = semantic ++ the FULL v1 row (the one-hot block follows)
      const sampleV3 = buildPriorV3FeatureRow({
        semantic: expectedProjection,
        genre: "house",
        styleId: "house.deep",
        role: "kick",
        step: 0,
        stepCount: 16,
      });
      expect(sampleV3.length).toBe(V3_FEATURE_COUNT);
      expect(V3_FEATURE_COUNT).toBe(V3_SEMANTIC_DIMS + PRIOR_FEATURE_COUNT);
      return { ok: true, probs: new Array(rowCount).fill(0.4), source: "model" as const };
    });
    embedTextsMock.mockResolvedValue([embedding]);

    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      0,
    );
    expect(embedTextsMock).toHaveBeenCalledTimes(1);
    expect(runPriorGridV3Mock).toHaveBeenCalled();
    expect(runPriorGridV2Mock).not.toHaveBeenCalled(); // v3 answered — no v2 needed
    expect(runPriorGridMock).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
    expect(entries.length).toBe(1);
    expect(entries[0].pattern.name).toContain("+sem");
    expect(entries[0].pattern.name).toContain("prior");
  });

  it("v3 and v2 unavailable → v1 one-hot fallback keeps the candidate alive", async () => {
    priorFlagState.value = "on";
    const { doc, plan } = planFor();
    runPriorGridV3Mock.mockResolvedValue({ ok: false, probs: null, source: "fallback" });
    runPriorGridV2Mock.mockResolvedValue({ ok: false, probs: null, source: "fallback" });
    runPriorGridMock.mockImplementation(async (batch: Float32Array, rowCount: number) => {
      expect(batch.length).toBe(rowCount * 44); // v1 width
      return { ok: true, probs: new Array(rowCount).fill(0.4), source: "model" as const };
    });
    embedTextsMock.mockResolvedValue([deterministicVector(384)]);

    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      0,
    );
    expect(runPriorGridV3Mock).toHaveBeenCalledTimes(1); // no re-probe per seed
    expect(runPriorGridV2Mock).toHaveBeenCalledTimes(1);
    expect(runPriorGridMock).toHaveBeenCalled();
    expect(failures).toContain("candidate-0:prior-v3-fallback");
    expect(failures).toContain("candidate-0:prior-v2-fallback");
    expect(entries.length).toBe(1);
    expect(entries[0].pattern.name).not.toContain("+sem");
  });

  it("v3 unavailable but v2 alive → v2 answers with the 35-dim batch", async () => {
    priorFlagState.value = "on";
    const { doc, plan } = planFor();
    runPriorGridV3Mock.mockResolvedValue({ ok: false, probs: null, source: "fallback" });
    runPriorGridV2Mock.mockImplementation(async (batch: Float32Array, rowCount: number) => {
      expect(batch.length).toBe(rowCount * V2_FEATURE_COUNT);
      return { ok: true, probs: new Array(rowCount).fill(0.4), source: "model" as const };
    });
    embedTextsMock.mockResolvedValue([deterministicVector(384)]);

    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      0,
    );
    expect(runPriorGridV3Mock).toHaveBeenCalledTimes(1);
    expect(runPriorGridV2Mock).toHaveBeenCalled();
    expect(failures).toContain("candidate-0:prior-v3-fallback");
    expect(entries.length).toBe(1);
    expect(entries[0].pattern.name).toContain("+sem");
  });

  it("flag off → pure v1 path (no embed, no v2 call)", async () => {
    const { doc, plan } = planFor();
    runPriorGridMock.mockImplementation(async (_batch: Float32Array, rowCount: number) => ({
      ok: true,
      probs: new Array(rowCount).fill(0.4),
      source: "model" as const,
    }));

    const { entries, failures } = await symbolicPriorProvider.collectCandidates(
      plan,
      { project: doc, mode: "apply" },
      0,
    );
    expect(embedTextsMock).not.toHaveBeenCalled();
    expect(runPriorGridV2Mock).not.toHaveBeenCalled();
    expect(runPriorGridV3Mock).not.toHaveBeenCalled();
    expect(runPriorGridMock).toHaveBeenCalled();
    expect(failures).toEqual([]);
    expect(entries.length).toBe(1);
    expect(entries[0].pattern.name).not.toContain("+sem");
  });
});
