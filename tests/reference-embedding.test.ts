import { describe, expect, it } from "vitest";
import {
  buildReferenceEmbedding,
  combineReferenceVector,
  featurePoles,
  type ReferenceEmbedInput,
} from "../src/intent/reference-embedding";
import { projectEmbedding } from "../src/ai/symbolic/pca-projection";
import type { EmbedFn } from "../src/intent/reference-embedding";

/**
 * REFERENCE-INFORMED EMBEDDING (T4 depth): the reference conditioning must
 * come from the measured SIGNAL (feature poles) as well as the classifier's
 * label words — an AST that answers nothing must still leave a usable
 * vector, and a stronger label must pull harder than a weak one.
 */

/** Deterministic pseudo-embedding per text (FNV-chained), L2-normalized. */
function vectorFor(text: string): Float32Array {
  const out = new Float32Array(384);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  for (let index = 0; index < 384; index++) {
    hash = Math.imul(hash ^ (index + 1), 16777619);
    out[index] = ((hash >>> 0) / 0xffffffff) * 2 - 1;
  }
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < 384; index++) out[index] /= norm;
  return out;
}

const embed: EmbedFn = (texts) => Promise.resolve(texts.map(vectorFor));

const baseFeatures = { rms: 0.1, peak: 0.5, crestFactor: 5, zeroCrossingRate: 0.05, lowBandRatio: 0.6 };

const input = (overrides: Partial<ReferenceEmbedInput> = {}): ReferenceEmbedInput => ({
  labels: [],
  features: baseFeatures,
  tempo: null,
  ...overrides,
});

const embedCalls = (fn: EmbedFn): { texts: string[][]; wrapped: EmbedFn } => {
  const texts: string[][] = [];
  return {
    texts,
    wrapped: async (batch) => {
      texts.push(batch);
      return fn(batch);
    },
  };
};

describe("featurePoles", () => {
  it("maps features onto pole activations in [0,1]", () => {
    const poles = featurePoles(
      input({ features: { rms: 0.3, peak: 0.9, crestFactor: 10, zeroCrossingRate: 0.2, lowBandRatio: 0.8 } }),
    );
    const byName = new Map(poles.map((pole) => [pole.name, pole.activation]));
    expect(byName.get("energy")).toBe(1);
    expect(byName.get("punch")).toBe(1);
    expect(byName.get("brightness")).toBe(1);
    expect(byName.get("depth")).toBe(1);
  });

  it("a quiet dark sine lands on the low poles", () => {
    const poles = featurePoles(
      input({ features: { rms: 0.001, peak: 0.1, crestFactor: 2, zeroCrossingRate: 0.005, lowBandRatio: 0.9 } }),
    );
    const byName = new Map(poles.map((pole) => [pole.name, pole.activation]));
    expect(byName.get("energy")).toBeLessThan(0.05);
    expect(byName.get("punch")).toBe(0);
    expect(byName.get("brightness")).toBeLessThan(0.1);
  });

  it("the tempo pole is gated by confidence — a guess does not steer semantics", () => {
    const confident = featurePoles(input({ tempo: { bpm: 140, confidence: 0.8 } }));
    expect(confident.find((pole) => pole.name === "tempo")?.activation).toBeGreaterThan(0.5);
    const guessing = featurePoles(input({ tempo: { bpm: 140, confidence: 0.1 } }));
    expect(guessing.find((pole) => pole.name === "tempo")).toBeUndefined();
  });
});

describe("combineReferenceVector", () => {
  const a = vectorFor("techno banger");
  const b = vectorFor("ambient pads");

  it("unit-normalizes the mix", () => {
    const mix = combineReferenceVector(
      [
        { vector: a, weight: 0.9 },
        { vector: b, weight: 0.5 },
      ],
      [{ vector: a, weight: 1 }],
    )!;
    let norm = 0;
    for (const value of mix) norm += value * value;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it("a stronger label score dominates the centroid direction", () => {
    const strongA = combineReferenceVector(
      [
        { vector: a, weight: 0.95 },
        { vector: b, weight: 0.1 },
      ],
      [{ vector: a, weight: 1 }],
    )!;
    const strongB = combineReferenceVector(
      [
        { vector: a, weight: 0.1 },
        { vector: b, weight: 0.95 },
      ],
      [{ vector: a, weight: 1 }],
    )!;
    const cos = (x: ArrayLike<number>, y: ArrayLike<number>) => {
      let dot = 0;
      for (let index = 0; index < x.length; index++) dot += x[index]! * y[index]!;
      return dot;
    };
    expect(cos(strongA, a)).toBeGreaterThan(cos(strongB, a));
  });

  it("no usable inputs → null", () => {
    expect(combineReferenceVector([], [])).toBeNull();
    expect(combineReferenceVector([{ vector: a, weight: 0 }], [])).toBeNull();
    expect(combineReferenceVector([{ vector: a, weight: Number.NaN }], [])).toBeNull();
  });
});

describe("buildReferenceEmbedding", () => {
  it("batches all anchor texts in ONE embed call (labels first, then pole pairs)", async () => {
    const { texts, wrapped } = embedCalls(embed);
    const labels = [
      { label: "Techno", score: 0.9 },
      { label: "Deep", score: 0.4 },
    ];
    await buildReferenceEmbedding(input({ labels, tempo: { bpm: 128, confidence: 0.5 } }), wrapped);
    expect(texts).toHaveLength(1);
    const batch = texts[0]!;
    expect(batch.slice(0, 2)).toEqual(["Techno", "Deep"]);
    // 4 feature poles + gated tempo pole = 5 pairs → 10 phrases after labels
    expect(batch).toHaveLength(2 + 10);
  });

  it("features alone (no labels) still produce a corpus-space conditioning vector", async () => {
    const result = await buildReferenceEmbedding(input(), embed);
    expect(result).not.toBeNull();
    expect(result!.projected).toHaveLength(16);
    expect(result!.text).toContain("poles:");
    // spot-check the corpus space: the projection of the same 384-dim mix
    // recomputed through combineReferenceVector must match exactly
    const poles = featurePoles(input());
    const poleVectors = poles.map((pole) => {
      const low = vectorFor(pole.low);
      const high = vectorFor(pole.high);
      const interpolated = new Float32Array(384);
      for (let index = 0; index < 384; index++)
        interpolated[index] = (1 - pole.activation) * low[index]! + pole.activation * high[index]!;
      return { vector: interpolated, weight: 1 };
    });
    const mix = combineReferenceVector([], poleVectors)!;
    expect(result!.projected).toEqual(projectEmbedding(mix));
  });

  it("is deterministic: same input → identical vector", async () => {
    const labels = [{ label: "Drum and bass", score: 0.7 }];
    const first = await buildReferenceEmbedding(input({ labels, tempo: { bpm: 174, confidence: 0.6 } }), embed);
    const second = await buildReferenceEmbedding(input({ labels, tempo: { bpm: 174, confidence: 0.6 } }), embed);
    expect(first!.projected).toEqual(second!.projected);
  });

  it("unavailable embedder → null (patch channel still degrades independently)", async () => {
    const failing: EmbedFn = async () => null;
    expect(await buildReferenceEmbedding(input({ labels: [{ label: "Techno", score: 0.9 }] }), failing)).toBeNull();
    const shortBatch: EmbedFn = async (texts) => texts.slice(1).map(vectorFor); // wrong count → reject
    expect(await buildReferenceEmbedding(input(), shortBatch)).toBeNull();
  });

  it("never throws on hostile input", async () => {
    const hostile = input({
      labels: [
        { label: "", score: 0.9 },
        { label: "ok", score: Number.NaN },
        { label: "fine", score: -2 },
      ],
      features: {
        rms: Number.NaN,
        peak: 0,
        crestFactor: Number.POSITIVE_INFINITY,
        zeroCrossingRate: 0.1,
        lowBandRatio: 0.5,
      },
      tempo: { bpm: Number.NaN, confidence: 0.5 },
    });
    const result = await buildReferenceEmbedding(hostile, embed);
    // "fine" (finite score filtered) + sanitized poles still form a vector
    expect(result).not.toBeNull();
    expect(result!.projected.every((value) => Number.isFinite(value))).toBe(true);
  });
});
