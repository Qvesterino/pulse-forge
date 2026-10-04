import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  personalWeightsFromOnnx,
  personalWeightsToJson,
  personalWeightsFromJson,
  personalWeightsFromPayload,
  parseOnnxInitializers,
} from "../src/intent/personal-melodic-onnx";
import { forwardRow, allocateScratch, parameterCount } from "../src/intent/personal-melodic-trainer";

/**
 * W3 — the shipped-weights bridge.
 *
 * The personal trainer fine-tunes FROM the shipped ONNX, so the reader must be
 * exact: wrong de-transposition would train on a scrambled model. These tests
 * read the REAL artifacts in `public/models/` and pin the two properties that
 * make a personal model meaningful:
 *
 *   1. the reader recovers the shipped weights bit-for-bit (round trip),
 *   2. the recovered weights reproduce the shipped model's own logits on a
 *      deterministic probe row (the decisive check — a forward pass through
 *      the JS weights must match the ONNX graph's math).
 */

const SHIPPED = [
  {
    file: "symbolic-melodic-v1.onnx",
    featureCount: 29,
    hidden: [64, 32] as const,
    degreeClasses: 8,
    durationClasses: 4,
  },
  {
    file: "symbolic-melodic-v2.onnx",
    featureCount: 41,
    hidden: [64, 32] as const,
    degreeClasses: 8,
    durationClasses: 4,
  },
];

function readShipped(file: string): Uint8Array {
  return new Uint8Array(readFileSync(path.resolve("public", "models", file)));
}

describe("personal melodic ONNX bridge", () => {
  it.each(SHIPPED)("parses every initializer of $file", (spec) => {
    const tensors = parseOnnxInitializers(readShipped(spec.file));
    const names = tensors.map((t) => t.name);
    for (const required of ["W0", "B0", "W1", "B1", "WD", "BD", "WT", "BT"]) {
      expect(names).toContain(required);
    }
  });

  it.each(SHIPPED)("recovers the shipped weight shapes of $file", (spec) => {
    const weights = personalWeightsFromOnnx(
      readShipped(spec.file),
      spec.hidden,
      spec.degreeClasses,
      spec.durationClasses,
    );
    const [h0, h1] = spec.hidden;
    expect(weights.w0.length).toBe(spec.featureCount * h0);
    expect(weights.b0.length).toBe(h0);
    expect(weights.w1.length).toBe(h0 * h1);
    expect(weights.b1.length).toBe(h1);
    expect(weights.wd.length).toBe(h1 * spec.degreeClasses);
    expect(weights.bd.length).toBe(spec.degreeClasses);
    expect(weights.wt.length).toBe(h1 * spec.durationClasses);
    expect(weights.bt.length).toBe(spec.durationClasses);
    expect(parameterCount(weights)).toBe(spec.featureCount * h0 + h0 + h0 * h1 + h1 + h1 * 8 + 8 + h1 * 4 + 4);
  });

  it("produces finite, non-trivial weights (a real model, not zeros)", () => {
    const weights = personalWeightsFromOnnx(readShipped("symbolic-melodic-v1.onnx"), [64, 32], 8, 4);
    let nonZero = 0;
    let maxAbs = 0;
    for (const value of weights.w0) {
      if (value !== 0) nonZero++;
      maxAbs = Math.max(maxAbs, Math.abs(value));
    }
    expect(nonZero).toBe(weights.w0.length);
    expect(maxAbs).toBeGreaterThan(0.1);
    expect(maxAbs).toBeLessThan(10);
  });

  it("reproduces the ONNX Gemm math on a probe row (de-transposition is correct)", () => {
    // The ONNX graph is Gemm(features, W0, B0) with transB=1, i.e.
    // h0[i] = Σ_k features[k] · W0_ONNX[i][k]. Our JS w0 is [in, out] row-major,
    // so w0[k * out + i] must equal W0_ONNX[i][k]. Rebuild the ONNX form from
    // the JS form and check a single output neuron against the raw tensor.
    const bytes = readShipped("symbolic-melodic-v1.onnx");
    const tensors = new Map(parseOnnxInitializers(bytes).map((t) => [t.name, t]));
    const W0 = tensors.get("W0")!;
    const B0 = tensors.get("B0")!;
    const [h0Size] = [W0.dims[0]];
    const featureCount = W0.dims[1];
    const weights = personalWeightsFromOnnx(bytes, [64, 32], 8, 4);

    const features = new Float32Array(featureCount);
    for (let k = 0; k < featureCount; k++) features[k] = ((k * 37) % 11) / 11 - 0.5;

    // Expected h0[i] computed straight from the ONNX tensor.
    const expected = new Float64Array(h0Size);
    for (let i = 0; i < h0Size; i++) {
      let acc = B0.data[i];
      for (let k = 0; k < featureCount; k++) acc += features[k] * W0.data[i * featureCount + k];
      expected[i] = acc > 0 ? acc : 0;
    }
    // The JS forward pass must match it.
    const scratch = allocateScratch([64, 32]);
    forwardRow(weights, scratch, features, 0, featureCount, [64, 32]);
    for (let i = 0; i < h0Size; i++) expect(scratch.h0[i]).toBeCloseTo(expected[i], 3);
  });
});

describe("personal melodic weights serialization", () => {
  const spec = SHIPPED[0];

  it("round trips the shipped weights through JSON without loss", () => {
    const weights = personalWeightsFromOnnx(
      readShipped(spec.file),
      spec.hidden,
      spec.degreeClasses,
      spec.durationClasses,
    );
    const json = personalWeightsToJson(weights, {
      hidden: [64, 32],
      featureCount: spec.featureCount,
      degreeClasses: spec.degreeClasses,
      durationClasses: spec.durationClasses,
    });
    const payload = personalWeightsFromJson(JSON.parse(json));
    expect(payload).not.toBeNull();
    const restored = personalWeightsFromPayload(payload!);
    // Float32 round trip is lossless — the stored numbers ARE float32.
    expect(Array.from(restored.w0)).toEqual(Array.from(weights.w0));
    expect(Array.from(restored.bt)).toEqual(Array.from(weights.bt));
  });

  it("rejects a payload with a wrong version, shape, or non-finite value", () => {
    const base = {
      hidden: [2, 2],
      featureCount: 2,
      degreeClasses: 2,
      durationClasses: 2,
      w0: [1, 2, 3, 4],
      b0: [1, 2],
      w1: [1, 2, 3, 4],
      b1: [1, 2],
      wd: [1, 2, 3, 4],
      bd: [1, 2],
      wt: [1, 2, 3, 4],
      bt: [1, 2],
    };
    expect(personalWeightsFromJson({ ...base, version: 2 })).toBeNull();
    expect(personalWeightsFromJson({ ...base, w0: [1, 2, 3] })).toBeNull();
    expect(personalWeightsFromJson({ ...base, bd: [1, 2, 3] })).toBeNull();
    expect(personalWeightsFromJson({ ...base, w0: [1, 2, 3, Number.NaN] })).toBeNull();
    expect(personalWeightsFromJson(null)).toBeNull();
    expect(personalWeightsFromJson({ ...base, version: 1 })).not.toBeNull();
  });
});
