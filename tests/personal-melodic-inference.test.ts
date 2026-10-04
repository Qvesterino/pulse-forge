import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  personalWeightsFromOnnx,
  personalWeightsToJson,
  personalWeightsFromJson,
} from "../src/intent/personal-melodic-onnx";
import { personalInferenceFromPayload, runPersonalNext } from "../src/intent/personal-melodic-inference";
import { PERSONAL_DEGREE_CLASSES, PERSONAL_DURATION_CLASSES } from "../src/intent/personal-melodic-trainer";

/**
 * W3 — personal inference overlay.
 *
 * The overlay must answer with the SAME distribution shape the shipped ONNX
 * session produces, so the provider cannot tell which model answered. The
 * decisive check: running the shipped weights through the overlay must match
 * the ONNX Gemm math (same de-transposition proof as the reader test, now at
 * the full inference boundary including both softmax heads).
 */

const HIDDEN = [64, 32] as const;

function shippedPayload() {
  const bytes = new Uint8Array(readFileSync(path.resolve("public", "models", "symbolic-melodic-v1.onnx")));
  const weights = personalWeightsFromOnnx(bytes, HIDDEN, PERSONAL_DEGREE_CLASSES, PERSONAL_DURATION_CLASSES);
  const json = personalWeightsToJson(weights, {
    hidden: [HIDDEN[0], HIDDEN[1]],
    featureCount: 29,
    degreeClasses: PERSONAL_DEGREE_CLASSES,
    durationClasses: PERSONAL_DURATION_CLASSES,
  });
  const payload = personalWeightsFromJson(JSON.parse(json));
  if (!payload) throw new Error("fixture payload failed validation");
  return payload;
}

function probeRow(count: number, width: number): Float32Array {
  const values = new Float32Array(count * width);
  let seed = 4242;
  for (let i = 0; i < values.length; i++) {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    values[i] = ((seed >>> 0) / 0xffffffff) * 0.8 - 0.4;
  }
  return values;
}

describe("personal inference overlay", () => {
  it("produces ready-to-use softmax distributions per row", () => {
    const model = personalInferenceFromPayload(shippedPayload());
    const features = probeRow(3, 29);
    const result = runPersonalNext(model, features, 3);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.degree).toHaveLength(3);
    expect(result.duration).toHaveLength(3);
    for (const row of result.degree) {
      expect(row).toHaveLength(PERSONAL_DEGREE_CLASSES);
      const sum = row.reduce((total, value) => total + value, 0);
      expect(sum).toBeCloseTo(1, 3);
      for (const value of row) expect(value).toBeGreaterThanOrEqual(0);
    }
    for (const row of result.duration) {
      expect(row).toHaveLength(PERSONAL_DURATION_CLASSES);
      expect(row.reduce((total, value) => total + value, 0)).toBeCloseTo(1, 3);
    }
  });

  it("is deterministic for the same row", () => {
    const model = personalInferenceFromPayload(shippedPayload());
    const features = probeRow(1, 29);
    const a = runPersonalNext(model, features, 1);
    const b = runPersonalNext(model, features, 1);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });

  it("refuses a batch whose width does not match the model", () => {
    const model = personalInferenceFromPayload(shippedPayload());
    // 2 rows × 41 (the v2 width) against a 29-wide model.
    expect(runPersonalNext(model, new Float32Array(2 * 41), 2)).toBeNull();
    expect(runPersonalNext(model, new Float32Array(29), 3)).toBeNull();
  });

  it("handles a zero-row batch without throwing", () => {
    const model = personalInferenceFromPayload(shippedPayload());
    const result = runPersonalNext(model, new Float32Array(0), 0);
    expect(result).toEqual({ degree: [], duration: [] });
  });

  it("matches the shipped ONNX logits on a probe row (both heads)", () => {
    // This is the decisive parity check: read the raw ONNX tensors and compute
    // the exact Gemm+ReLU+softmax by hand, then compare to the overlay output.
    const bytes = new Uint8Array(readFileSync(path.resolve("public", "models", "symbolic-melodic-v1.onnx")));
    const weights = personalWeightsFromOnnx(bytes, HIDDEN, PERSONAL_DEGREE_CLASSES, PERSONAL_DURATION_CLASSES);
    const model = personalInferenceFromPayload(shippedPayload());
    const features = probeRow(1, 29);
    const result = runPersonalNext(model, features, 1)!;

    const softmax = (logits: number[]): number[] => {
      const max = Math.max(...logits);
      const exp = logits.map((v) => Math.exp(v - max));
      const sum = exp.reduce((t, v) => t + v, 0);
      return exp.map((v) => v / sum);
    };

    // Hand-computed h0 = relu(w0^T x + b0) from the reader's tensors.
    const x = Array.from(features);
    const h0 = new Array<number>(HIDDEN[0]).fill(0);
    for (let i = 0; i < HIDDEN[0]; i++) {
      let acc = weights.b0[i];
      for (let k = 0; k < 29; k++) acc += x[k] * weights.w0[k * HIDDEN[0] + i];
      h0[i] = Math.max(0, acc);
    }
    const h1 = new Array<number>(HIDDEN[1]).fill(0);
    for (let i = 0; i < HIDDEN[1]; i++) {
      let acc = weights.b1[i];
      for (let k = 0; k < HIDDEN[0]; k++) acc += h0[k] * weights.w1[k * HIDDEN[1] + i];
      h1[i] = Math.max(0, acc);
    }
    const degreeLogits = new Array<number>(PERSONAL_DEGREE_CLASSES).fill(0);
    for (let i = 0; i < PERSONAL_DEGREE_CLASSES; i++) {
      let acc = weights.bd[i];
      for (let k = 0; k < HIDDEN[1]; k++) acc += h1[k] * weights.wd[k * PERSONAL_DEGREE_CLASSES + i];
      degreeLogits[i] = acc;
    }
    const durationLogits = new Array<number>(PERSONAL_DURATION_CLASSES).fill(0);
    for (let i = 0; i < PERSONAL_DURATION_CLASSES; i++) {
      let acc = weights.bt[i];
      for (let k = 0; k < HIDDEN[1]; k++) acc += h1[k] * weights.wt[k * PERSONAL_DURATION_CLASSES + i];
      durationLogits[i] = acc;
    }
    const expectedDegree = softmax(degreeLogits);
    const expectedDuration = softmax(durationLogits);
    for (let c = 0; c < PERSONAL_DEGREE_CLASSES; c++) {
      expect(result.degree[0][c]).toBeCloseTo(expectedDegree[c], 4);
    }
    for (let c = 0; c < PERSONAL_DURATION_CLASSES; c++) {
      expect(result.duration[0][c]).toBeCloseTo(expectedDuration[c], 4);
    }
  });
});
