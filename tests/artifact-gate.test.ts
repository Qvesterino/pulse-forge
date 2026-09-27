import { describe, expect, it } from "vitest";
import {
  analyzeArtifacts,
  energyCurveCorrelation,
  evaluateArtifacts,
} from "../src/audio-engine/artifactGate";

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
function cleanOneShot(freq = 220, seconds = 0.3, fadeSeconds = 0.02): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const fadeStart = n - Math.floor(fadeSeconds * SR);
  for (let i = 0; i < n; i++) {
    const fade = i >= fadeStart ? 1 - (i - fadeStart) / (n - fadeStart) : 1;
    out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.8 * fade;
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

describe("artifact gate — clean signals pass", () => {
  it("a clean faded one-shot has a clean tail and no clicks", () => {
    const report = analyzeArtifacts([cleanOneShot()]);
    expect(report.finite).toBe(true);
    expect(report.peak).toBeGreaterThan(0.7);
    expect(report.tailStepRatio).toBeLessThan(0.05);
    expect(report.clickIndices).toEqual([]);
    expect(evaluateArtifacts(report).ok).toBe(true);
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

  it("does not flag a smooth short fade (the de-click tail itself)", () => {
    const report = analyzeArtifacts([cleanOneShot(220, 0.1, 0.002)]);
    expect(report.clickIndices).toEqual([]);
    expect(evaluateArtifacts(report).ok).toBe(true);
  });
});

describe("artifact gate — each defect class is caught", () => {
  it("catches a hard tail cut that the de-click tail prevents", () => {
    const cut = analyzeArtifacts([hardCutOneShot()]);
    const clean = analyzeArtifacts([cleanOneShot()]);
    expect(clean.tailStepRatio).toBeLessThan(0.05);
    expect(cut.tailStepRatio).toBeGreaterThan(0.05);
    const verdict = evaluateArtifacts(cut);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(" ")).toMatch(/hard tail cut/);
  });

  it("catches an isolated discontinuity mid-decay (a slice cut mid-body)", () => {
    const signal = cleanOneShot(220, 0.4, 0.02);
    // Splice a hard step at 60 % of the duration: the waveform jumps by 0.4
    // and continues — a click, not a fade.
    const at = Math.floor(0.24 * SR);
    for (let i = at; i < signal.length; i++) signal[i] += 0.4;
    const report = analyzeArtifacts([signal]);
    expect(report.clickIndices.length).toBeGreaterThan(0);
    expect(report.clickIndices.some((i) => Math.abs(i - at) <= 2)).toBe(true);
    expect(evaluateArtifacts(report).ok).toBe(false);
  });

  it("catches non-finite samples", () => {
    const signal = cleanOneShot();
    signal[100] = Number.NaN;
    const report = analyzeArtifacts([signal]);
    expect(report.finite).toBe(false);
    expect(evaluateArtifacts(report).failures).toContain("non-finite samples");
  });

  it("catches a silent render", () => {
    const report = analyzeArtifacts([new Float32Array(SR)]);
    expect(evaluateArtifacts(report).failures).toContain("silent render");
  });

  it("catches DC offset (asymmetric saturation leak)", () => {
    const signal = cleanOneShot();
    for (let i = 0; i < signal.length; i++) signal[i] += 0.05;
    const report = analyzeArtifacts([signal]);
    expect(report.dcOffsetDb).toBeGreaterThan(-60);
    expect(evaluateArtifacts(report).failures.join(" ")).toMatch(/DC offset/);
  });

  it("does not flag a clean AC signal with a partial final cycle", () => {
    // Regression: the first implementation used a GLOBAL mean, which is never
    // zero for a non-period-aligned signal — every clean render failed.
    const report = analyzeArtifacts([cleanOneShot(220, 0.3007, 0.005)]);
    expect(report.dcOffsetDb).toBeLessThan(-60);
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

describe("artifact gate — round-robin / velocity claims", () => {
  it("distinguishes a repeated identical hit from a variant", () => {
    const hit = cleanOneShot(180, 0.15, 0.01);
    // Identical repetition (the machine gun) correlates 1.0.
    expect(energyCurveCorrelation(hit, hit)).toBeCloseTo(1, 6);
    // A micro-variant (resampled + gain, like the factory RR derivation) must
    // still read as the same instrument while dropping below the identical
    // hit. Sample-phase correlation would collapse here (~0.1); the envelope
    // is phase-blind by design.
    const variant = new Float32Array(hit.length);
    for (let i = 0; i < hit.length; i++) {
      const pos = i * 1.018;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = hit[i0] ?? 0;
      const b = i0 + 1 < hit.length ? hit[i0 + 1] : a;
      variant[i] = (a + (b - a) * frac) * 1.04;
    }
    const corr = energyCurveCorrelation(hit, variant);
    expect(corr).toBeLessThan(0.999);
    expect(corr).toBeGreaterThan(0.9);
  });

  it("separates a genuinely different drum from a micro-variant", () => {
    const hit = cleanOneShot(180, 0.15, 0.01);
    // A different sample: much shorter decay (a real timbre change).
    const other = cleanOneShot(180, 0.03, 0.005);
    const variantCorr = energyCurveCorrelation(hit, hit);
    const differentCorr = energyCurveCorrelation(hit, other);
    expect(differentCorr).toBeLessThan(variantCorr);
    // The decay-shape difference pushes it clearly below a micro-variant.
    expect(differentCorr).toBeLessThan(0.9);
  });

  it("flags when consecutive hits are bit-identical (no variation shipped)", () => {
    // A tiny gain difference is NOT enough — the point of a variant is a
    // different waveform, not a level trim. Envelope correlation is
    // scale-invariant, so a pure gain trim reads as identical.
    const hit = cleanOneShot(180, 0.15, 0.01);
    const trimmed = Float32Array.from(hit, (v) => v * 1.2);
    expect(energyCurveCorrelation(hit, trimmed)).toBeCloseTo(1, 6);
  });
});
