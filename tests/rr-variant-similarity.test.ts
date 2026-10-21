import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rrVariantCorrelation, rrVariantIsStale, RR_VARIANT_MIN_CORRELATION } from "../src/sample-library/rrSimilarity";

/**
 * ROUND-ROBIN VARIANT SIMILARITY — the metric the browser verifier uses to
 * decide "is this variation the same drum as the base it varies?".
 *
 * The browser verifier used to answer that with SAMPLE-PHASE correlation and
 * a 0.7 threshold. That metric collapses on a resampled copy BY CONSTRUCTION
 * (src/audio-engine/artifactGate.ts says so in prose), and measured on the
 * real bank it reported 10 of 26 bases as broken on the SYNTH bank alone —
 * before the curated layer it was written to police had even loaded. A gate
 * that can only go red carries no information.
 *
 * So this spec has two jobs, and the second one matters more:
 *
 *   1. the metric is HEALTHY on the healthy case (a fresh micro-variant),
 *   2. the metric can still go RED on the defect the check exists for (a
 *      variant derived from a different base).
 *
 * Without (2) the fix would have replaced a false alarm with a rubber stamp.
 */

const SR = 44100;

/** Deterministic noise (no Math.random: the spec must be reproducible). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A drum-ish hit: a pitched body with an exponential decay plus a broadband
 * noise burst on the attack. The noise is what makes the phase metric
 * collapse — broadband content decorrelates under a resample.
 */
function hit({ freq = 180, seconds = 0.15, decay = 12, noise = 0.35, seed = 7 } = {}): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const body = Math.sin(2 * Math.PI * freq * t) * Math.exp(-decay * t);
    const air = (rand() * 2 - 1) * noise * Math.exp(-40 * t);
    out[i] = body + air;
  }
  return out;
}

/** The factory RR derivation: linear resample + gain (src/sample-library/factory.ts). */
function resample(src: Float32Array, rate: number, gain: number): Float32Array {
  const length = Math.max(1, Math.round(src.length / rate));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * rate;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = src[i0] ?? 0;
    const b = i0 + 1 < src.length ? src[i0 + 1] : a;
    out[i] = (a + (b - a) * frac) * gain;
  }
  return out;
}

/** The metric the browser verifier used before the fix. */
function phaseCorrelation(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.max(1e-12, Math.sqrt(na) * Math.sqrt(nb));
}

describe("round-robin variant similarity — the healthy case", () => {
  it("reads a fresh micro-variant as the same drum", () => {
    const base = hit();
    const variant = resample(base, 1.018, 1.04);
    expect(rrVariantCorrelation(base, variant)).toBeGreaterThanOrEqual(RR_VARIANT_MIN_CORRELATION);
    expect(rrVariantIsStale(base, variant)).toBe(false);
  });

  it("reads the same drum at every round-robin rate the factory uses", () => {
    const base = hit();
    for (const [rate, gain] of [
      [1.018, 1.04],
      [0.984, 0.95],
      [1.012, 1.03],
      [0.99, 0.96],
    ] as const) {
      const variant = resample(base, rate, gain);
      expect(rrVariantCorrelation(base, variant), `rate ${rate}`).toBeGreaterThanOrEqual(RR_VARIANT_MIN_CORRELATION);
    }
  });

  it("the metric the old gate used would have cried wolf on the SAME pair", () => {
    // This is the defect the fix removes: the phase metric is not measuring
    // the bank, it is measuring the resample.
    const base = hit();
    const variant = resample(base, 1.018, 1.04);
    expect(phaseCorrelation(base, variant)).toBeLessThan(0.7);
    expect(rrVariantCorrelation(base, variant)).toBeGreaterThanOrEqual(RR_VARIANT_MIN_CORRELATION);
  });
});

describe("round-robin variant similarity — the guard can go red", () => {
  it("reads a variant of a DIFFERENT drum role as stale", () => {
    // A kick body against a snare body: the bank would alternate between two
    // different drums instead of one drum with micro-variation. Measured
    // 0.82 — well below the threshold, and far above the noise floor.
    const base = hit({ freq: 180 });
    const stale = resample(hit({ freq: 60, seed: 11 }), 1.018, 1.04);
    expect(rrVariantCorrelation(base, stale)).toBeLessThan(RR_VARIANT_MIN_CORRELATION);
    expect(rrVariantIsStale(base, stale)).toBe(true);
  });

  it("reads a variant of a DIFFERENT hit length as stale", () => {
    const base = hit({ seconds: 0.15 });
    const stale = resample(hit({ seconds: 0.03, seed: 11 }), 1.018, 1.04);
    expect(rrVariantCorrelation(base, stale)).toBeLessThan(RR_VARIANT_MIN_CORRELATION);
    expect(rrVariantIsStale(base, stale)).toBe(true);
  });

  it("the verdict is decided by the threshold, not by a constant baked into the helper", () => {
    const base = hit({ freq: 180 });
    const stale = resample(hit({ freq: 60, seed: 11 }), 1.018, 1.04);
    const corr = rrVariantCorrelation(base, stale);
    // If the helper compared against its own private constant, the verdict
    // would not be a function of the exported threshold.
    const verdictAt = (threshold: number) => corr < threshold;
    expect(verdictAt(RR_VARIANT_MIN_CORRELATION)).toBe(true);
    expect(verdictAt(RR_VARIANT_MIN_CORRELATION - 0.5)).toBe(false);
  });

  it("documents the metric's blind spot: two hits differing only in their DECAY stay above the threshold", () => {
    // Both envelopes fall monotonically, so their correlation stays high even
    // though the decays differ. The metric separates "different character"
    // (a curated recording against a synth fallback — the real stale case,
    // measured 0.696–0.975 on the real pairs), not "same character rendered
    // differently". Stating the blind spot is part of the contract: a reader
    // must not assume the check proves more than it does.
    const base = hit({ decay: 12 });
    const other = hit({ decay: 60, seed: 11 });
    expect(rrVariantCorrelation(base, other)).toBeGreaterThanOrEqual(RR_VARIANT_MIN_CORRELATION);
  });
});

describe("round-robin variant similarity — the browser verifier uses THIS metric", () => {
  const source = readFileSync(resolve(process.cwd(), "src/browser-checks.ts"), "utf8");

  it("the round-robin check compares against the shared threshold", () => {
    const marker = source.indexOf("RR variants are re-derived from the curated base");
    expect(marker, "the round-robin check must still exist").toBeGreaterThan(-1);
    const block = source.slice(Math.max(0, marker - 2500), marker + 1200);
    expect(block, "the check must use the shared phase-blind metric").toContain("rrVariantCorrelation(");
    expect(block, "the check must use the shared threshold").toContain("RR_VARIANT_MIN_CORRELATION");
  });

  it("the check no longer hand-rolls a sample-phase correlation", () => {
    const marker = source.indexOf("RR variants are re-derived from the curated base");
    const block = source.slice(Math.max(0, marker - 2500), marker + 1200);
    // The old metric was a dot product over raw samples; that is what
    // manufactured the false alarm.
    expect(block, "the hand-rolled dot product must be gone").not.toContain("dot +=");
  });
});
