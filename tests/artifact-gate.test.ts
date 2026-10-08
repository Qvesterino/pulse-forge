import { describe, expect, it } from "vitest";
import { analyzeArtifacts, logEnvelopeCorrelation, evaluateArtifacts } from "../src/audio-engine/artifactGate";

/**
 * Artifact gate — the numerical defect check that locks the de-click and
 * round-robin work into CI (and runs in the real-browser verifier against
 * actual renders).
 *
 * These tests use SYNTHETIC signals on purpose: each case reproduces exactly
 * one defect class, so a failure names the thing that broke instead of
 * "some render somewhere". The signal is band-limited (a sine) because the
 * click detector is a curvature test — real drum renders are band-limited
 * too, and a naive square wave would trip it by design.
 */

const SR = 44100;

/** A clean band-limited one-shot: sine burst with a real tail fade. */
function oneShot(freq = 220, seconds = 0.3, fadeSeconds = 0.02, amp = 0.8): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const fadeStart = n - Math.floor(fadeSeconds * SR);
  for (let i = 0; i < n; i++) {
    const fade = i >= fadeStart ? 1 - (i - fadeStart) / (n - fadeStart) : 1;
    out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp * fade;
  }
  return out;
}

/** The same one-shot with the tail hard-cut mid-waveform (no fade at all). */
function hardCutOneShot(freq = 220, seconds = 0.3): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  // Cut at a quarter period so the waveform ends at peak, not zero — exactly
  // the case the de-click tail exists to prevent.
  const cut = n - Math.floor(SR / (freq * 4));
  for (let i = 0; i < cut; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.8;
  return out;
}

/** The factory RR derivation: linear resample + gain (micr o-variation). */
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

describe("artifact gate — clean signals pass", () => {
  it("a clean faded one-shot has a clean tail and no clicks", () => {
    const report = analyzeArtifacts([oneShot()]);
    expect(report.finite).toBe(true);
    expect(report.peak).toBeGreaterThan(0.7);
    expect(report.tailStepRatio).toBeLessThan(0.05);
    expect(report.clickIndices).toEqual([]);
    expect(evaluateArtifacts(report).failures).toEqual([]);
  });

  it("does not treat the intentional attack as a click (kick-like onset)", () => {
    // A kick is a full-amplitude instantaneous onset followed by a smooth
    // decay — the loudest "discontinuity" in the whole kit is deliberate.
    const n = Math.floor(0.25 * SR);
    const kick = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const env = Math.exp(-t * 22);
      kick[i] = Math.sin(2 * Math.PI * (150 * Math.exp(-t * 30) + 45) * t) * env;
    }
    const report = analyzeArtifacts([kick]);
    expect(evaluateArtifacts(report).failures).toEqual([]);
  });

  it("does not treat a full-level onset after silence as a mid-body click", () => {
    const onset = new Float32Array(Math.floor(0.25 * SR));
    const start = 100;
    for (let i = start; i < onset.length; i++) {
      const elapsed = (i - start) / SR;
      const tailStart = onset.length - Math.floor(0.02 * SR);
      const fade = i >= tailStart ? (onset.length - i) / (onset.length - tailStart) : 1;
      onset[i] = 0.8 * Math.exp(-elapsed * 8) * fade * Math.cos(2 * Math.PI * 500 * elapsed);
    }

    const report = analyzeArtifacts([onset]);
    expect(report.attackIndex).toBe(start);
    expect(report.clickIndices).toEqual([]);
    expect(evaluateArtifacts(report).failures).toEqual([]);
  });

  it("does not flag a smooth short fade (the de-click tail itself)", () => {
    const report = analyzeArtifacts([oneShot(220, 0.1, 0.002)]);
    expect(report.clickIndices).toEqual([]);
    expect(evaluateArtifacts(report).ok).toBe(true);
  });

  it("does not flag a clean AC signal with a partial final cycle", () => {
    // Regression: the first implementation used a mean for DC, which is never
    // zero for a non-period-aligned signal — every clean render failed.
    const report = analyzeArtifacts([oneShot(220, 0.3007, 0.005)]);
    expect(evaluateArtifacts(report).failures).toEqual([]);
  });
});

describe("artifact gate — each defect class is caught", () => {
  it("catches a hard tail cut that the de-click tail prevents", () => {
    const cut = analyzeArtifacts([hardCutOneShot()]);
    const clean = analyzeArtifacts([oneShot()]);
    expect(clean.tailStepRatio).toBeLessThan(0.05);
    expect(cut.tailStepRatio).toBeGreaterThan(0.05);
    const verdict = evaluateArtifacts(cut);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(" ")).toMatch(/hard tail cut/);
  });

  it("catches an isolated discontinuity mid-decay (a slice cut mid-body)", () => {
    const signal = oneShot(220, 0.4, 0.02);
    // Splice a hard step at 60 % of the duration: the waveform jumps by 0.4
    // and continues — a click, not a fade.
    const at = Math.floor(0.24 * SR);
    for (let i = at; i < signal.length; i++) signal[i] += 0.4;
    const report = analyzeArtifacts([signal]);
    expect(report.clickIndices.length).toBeGreaterThan(0);
    expect(report.clickIndices.some((i) => Math.abs(i - at) <= 2)).toBe(true);
    expect(evaluateArtifacts(report).ok).toBe(false);
  });

  it("can report ambiguous program transients for review without hiding other failures", () => {
    const signal = oneShot(220, 0.4, 0.02);
    const at = Math.floor(0.24 * SR);
    const spliceEnd = at + Math.floor(0.01 * SR);
    for (let i = at; i < spliceEnd; i++) signal[i] += 0.4;
    const report = analyzeArtifacts([signal]);

    const review = evaluateArtifacts(report, { clickSeverity: "review" });
    expect(review.ok).toBe(true);
    expect(review.failures).toEqual([]);
    expect(review.warnings[0]).toMatch(/potential discontinuity candidate/);
    expect(evaluateArtifacts({ ...report, finite: false }, { clickSeverity: "review" }).failures).toContain(
      "non-finite samples",
    );
  });

  it("catches non-finite samples", () => {
    const signal = oneShot();
    signal[100] = Number.NaN;
    const report = analyzeArtifacts([signal]);
    expect(report.finite).toBe(false);
    expect(evaluateArtifacts(report).failures).toContain("non-finite samples");
  });

  it("catches a silent render", () => {
    const report = analyzeArtifacts([new Float32Array(SR)]);
    expect(evaluateArtifacts(report).failures).toContain("silent render");
  });

  it("catches DC offset on sustained material (opt-in, like the browser gate)", () => {
    const n = SR;
    const sustained = new Float32Array(n);
    // Include a real tail fade — an abrupt end is correctly a cut, and this
    // test is about DC, not the tail.
    const fadeStart = n - Math.floor(0.05 * SR);
    for (let i = 0; i < n; i++) {
      const fade = i >= fadeStart ? 1 - (i - fadeStart) / (n - fadeStart) : 1;
      sustained[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5 * fade;
    }
    // A clean sustained tone has no sub-audio content.
    expect(evaluateArtifacts(analyzeArtifacts([sustained]), { dcCeilingDb: -40 }).failures).toEqual([]);

    const leaked = Float32Array.from(sustained, (v) => v + 0.05);
    const dirty = analyzeArtifacts([leaked]);
    expect(dirty.dcOffsetDb).toBeGreaterThan(-40);
    expect(evaluateArtifacts(dirty, { dcCeilingDb: -40 }).failures.join(" ")).toMatch(/DC offset/);
    // DC is not part of the default failure set — a one-shot cannot measure it.
    const defaultFailures = evaluateArtifacts(dirty).failures.join(" ");
    expect(defaultFailures).not.toMatch(/DC offset/);
  });

  it("does not enforce DC on a short one-shot (few cycles is not an offset)", () => {
    // Regression: mean-based implementations read a clean 180 Hz hit as ~-30
    // dB of "DC" and failed every percussive render.
    const report = analyzeArtifacts([oneShot(180, 0.03, 0.005)]);
    expect(evaluateArtifacts(report).failures).toEqual([]);
  });

  it("catches inter-sample peaks above the ceiling", () => {
    // A 45°-phase fs/4 sine is the classic case: sample peak reads −3 dB but
    // the true peak is ~0 dBTP. Render it hot and require the ceiling.
    const n = SR;
    const hot = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      hot[i] = Math.sin((2 * Math.PI * (SR / 4) * i) / SR + Math.PI / 4) * 0.98;
      // Tail fade so the tail check does not dominate the verdict.
      if (i > n - 200) hot[i] *= (n - i) / 200;
    }
    const report = analyzeArtifacts([hot]);
    expect(report.truePeakDb).toBeGreaterThan(report.peakDb);
    const verdict = evaluateArtifacts(report, { ceilingDb: -1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(" ")).toMatch(/true peak/);
  });
});

describe("artifact gate — round-robin similarity metric", () => {
  it("reads an identical hit as 1.0", () => {
    const hit = oneShot(180, 0.15, 0.01);
    expect(logEnvelopeCorrelation(hit, hit)).toBeCloseTo(1, 6);
  });

  it("keeps a factory RR micro-variant near the identical hit", () => {
    // Sample-phase correlation collapses (~0.1) on a 1.018 resample; the
    // log-envelope correlation is phase-blind and stays very high — which is
    // the point: the variant IS the same drum.
    const hit = oneShot(180, 0.15, 0.01);
    const rr2 = resample(hit, 1.018, 1.04);
    const rr3 = resample(hit, 0.984, 0.95);
    for (const variant of [rr2, rr3]) {
      const corr = logEnvelopeCorrelation(hit, variant);
      expect(corr).toBeGreaterThan(0.99);
      expect(corr).toBeLessThanOrEqual(1);
    }
  });

  it("separates a genuinely different sample (decay shape) from a variant", () => {
    const hit = oneShot(180, 0.15, 0.01);
    const shortDecay = oneShot(180, 0.03, 0.005); // a much shorter drum
    const variantCorr = logEnvelopeCorrelation(hit, resample(hit, 1.018, 1.04));
    const differentCorr = logEnvelopeCorrelation(hit, shortDecay);
    expect(differentCorr).toBeLessThan(variantCorr);
    expect(differentCorr).toBeLessThan(0.9);
  });

  it("separates two different drum roles (kick vs snare body)", () => {
    const snare = oneShot(180, 0.15, 0.01);
    const kick = oneShot(60, 0.25, 0.02);
    expect(logEnvelopeCorrelation(snare, kick)).toBeLessThan(0.9);
  });

  it("a pure gain trim reads as the same hit (envelope is scale-invariant)", () => {
    const hit = oneShot(180, 0.15, 0.01);
    const trimmed = Float32Array.from(hit, (v) => v * 1.2);
    expect(logEnvelopeCorrelation(hit, trimmed)).toBeCloseTo(1, 6);
  });
});
