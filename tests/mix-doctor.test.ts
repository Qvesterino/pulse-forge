import { describe, expect, it } from "vitest";
import { analyzeMixHealth, deriveMixAutoFix } from "../src/analysis/mixDoctor";

/**
 * MIX DOCTOR — pure analyzer contract. Fixtures are numeric (jsdom has no
 * WebAudio): the "broken" mix replicates the pre-fix audit conditions
 * measured on real KYX renders (trap summing +7.8 dB over full scale with
 * 86 % sub energy and a 4.2 dB crest), the healthy mix mirrors the post-fix
 * measured envelope.
 */

const SR = 44100;

function sine(freq: number, seconds: number, amp: number, phase = 0): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return out;
}

function mix(layers: Float32Array[]): Float32Array {
  const out = new Float32Array(layers[0].length);
  for (const layer of layers) for (let i = 0; i < out.length; i++) out[i] += layer[i];
  return out;
}

/** Post-fix shaped mix: kick transients over a quiet sustained mid bed —
 * real beats carry their crest in the envelopes and their energy across the
 * spectrum (a bare 55 Hz loop measures 83 % low-end and false-flags; hits
 * must fade out or the truncation reads as DC). */
function healthyMix(): Float32Array {
  const seconds = 2;
  const m = mix([
    sine(220, seconds, 0.12),
    sine(300, seconds, 0.1),
    sine(880, seconds, 0.08),
    sine(1500, seconds, 0.07),
    sine(6000, seconds, 0.04),
  ]);
  // Kick transients every 0.5 s: 55 Hz body × exp decay, 5 ms fade-out so
  // the hit never truncates mid-period. The hit is mean-centered before
  // being mixed in — an exp-decayed sine carries a systematic DC shift
  // (envelope-weighted half-waves, ~4 mV here) that real oscillators don't.
  const hitLen = Math.floor(0.25 * SR);
  const fade = Math.floor(0.005 * SR);
  const hit = new Float32Array(hitLen);
  for (let i = 0; i < hitLen; i++) {
    const env = Math.exp(-i / (0.06 * SR)) * (i > hitLen - fade ? (hitLen - i) / fade : 1);
    hit[i] = 0.7 * env * Math.sin((2 * Math.PI * 55 * i) / SR);
  }
  let hitMean = 0;
  for (const v of hit) hitMean += v;
  hitMean /= hitLen;
  for (let i = 0; i < hitLen; i++) hit[i] -= hitMean;
  for (let at = 0; at + hitLen <= m.length; at += Math.floor(0.5 * SR)) {
    for (let i = 0; i < hitLen; i++) m[at + i] += hit[i];
  }
  let peak = 0;
  for (const v of m) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < m.length; i++) m[i] *= 0.85 / peak;
  return m;
}

/** Pre-fix trap replica: a 45 Hz sine at 1.2× full scale, hard-clipped. */
function brokenTrapMix(): Float32Array {
  const m = sine(45, 2, 1.2);
  for (let i = 0; i < m.length; i++) m[i] = Math.max(-1, Math.min(1, m[i]));
  return m;
}

describe("mix doctor — healthy renders pass clean", () => {
  it("post-fix shaped mix: ok, no red flags, readable values", () => {
    const left = healthyMix();
    const right = left.slice();
    const report = analyzeMixHealth([left, right], SR);
    expect(report.ok).toBe(true);
    expect(report.flags.filter((f) => f.severity === "red")).toEqual([]);
    expect(report.clippedSamples).toBe(0);
    expect(report.peak).toBeLessThanOrEqual(1);
    expect(report.crestDb).toBeGreaterThanOrEqual(8);
    expect(report.lowEndShare).toBeGreaterThan(0.3);
    expect(report.lowEndShare).toBeLessThan(0.82);
    expect(report.stereoCorrelation).not.toBeNull();
    expect(report.stereoCorrelation!).toBeGreaterThan(0.99);
    expect(report.integratedLufs).not.toBeNull();
    expect(report.durationSec).toBeCloseTo(2, 2);
  });

  it("every flag the doctor raises is yellow at worst on the healthy mix", () => {
    const report = analyzeMixHealth([healthyMix()], SR);
    for (const flag of report.flags) expect(flag.severity).toBe("yellow");
  });
});

describe("mix doctor — the pre-fix disaster zone is red", () => {
  it("clipped sub-dominant mix: clipping + low-end dominance + crest collapse", () => {
    const report = analyzeMixHealth([brokenTrapMix()], SR);
    expect(report.ok).toBe(false);
    const checks = new Set(report.flags.filter((f) => f.severity === "red").map((f) => f.check));
    expect(checks.has("clipping")).toBe(true);
    expect(checks.has("low-end-dominance")).toBe(true);
    expect(report.lowEndShare).toBeGreaterThan(0.82);
    expect(report.crestDb).toBeLessThan(6);
  });

  it("headroom flag warns before the clip when the render is just hot", () => {
    const hot = sine(220, 1, 0.995);
    const report = analyzeMixHealth([hot], SR);
    // 220 Hz sine: sub share small, crest ~1.5 dB → crest-collapse also fires;
    // the point of this probe is the yellow no-headroom flag existing.
    const yellow = report.flags.filter((f) => f.severity === "yellow").map((f) => f.check);
    expect(yellow).toContain("no-headroom");
  });
});

describe("mix doctor — purity and degenerate inputs", () => {
  it("DC offset is a red flag", () => {
    const left = healthyMix();
    for (let i = 0; i < left.length; i++) left[i] += 0.01;
    const report = analyzeMixHealth([left], SR);
    expect(report.ok).toBe(false);
    expect(report.flags.some((f) => f.check === "dc-offset")).toBe(true);
  });

  it("anti-correlated stereo is a red phase flag", () => {
    const left = healthyMix();
    const right = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) right[i] = -left[i];
    const report = analyzeMixHealth([left, right], SR);
    expect(report.flags.some((f) => f.check === "stereo-phase")).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("near-silent render warns and skips loudness", () => {
    const silence = new Float32Array(SR * 2);
    const report = analyzeMixHealth([silence], SR);
    expect(report.flags.some((f) => f.check === "near-silent")).toBe(true);
    expect(report.integratedLufs).toBeNull();
    expect(report.peak).toBe(0);
  });

  it("under-400 ms render skips loudness without crashing", () => {
    const report = analyzeMixHealth([sine(220, 0.2, 0.5)], SR);
    expect(report.integratedLufs).toBeNull();
    expect(report.durationSec).toBeCloseTo(0.2, 2);
  });

  it("deterministic: identical input → identical report", () => {
    const a = analyzeMixHealth([healthyMix()], SR);
    const b = analyzeMixHealth([healthyMix()], SR);
    expect(a).toEqual(b);
  });

  it("never throws on hostile input", () => {
    expect(() => analyzeMixHealth([], SR)).not.toThrow();
    expect(() => analyzeMixHealth([new Float32Array(1)], 0)).not.toThrow();
    expect(() => analyzeMixHealth([new Float32Array(0), new Float32Array(5)], SR)).not.toThrow();
  });
});

describe("mix doctor — auto-fix derivation", () => {
  it("healthy mix → no fix offered (null, never a no-op button)", () => {
    expect(deriveMixAutoFix(analyzeMixHealth([healthyMix()], SR))).toBeNull();
  });

  it("low-end dominance → dark tilt proportional to the excess, clipped at 4", () => {
    const m = new Float32Array(SR * 2);
    for (let i = 0; i < m.length; i++) m[i] = 0.4 * Math.sin((2 * Math.PI * 45 * i) / SR);
    const report = analyzeMixHealth([m], SR);
    expect(report.lowEndShare).toBeGreaterThan(0.74);
    const fix = deriveMixAutoFix(report);
    expect(fix).not.toBeNull();
    expect(fix!.tiltDb).toBeGreaterThan(0);
    expect(fix!.tiltDb).toBeLessThanOrEqual(4);
    expect(fix!.masterGain).toBe(1);
    expect(fix!.label).toContain("tilt");
  });

  it("clipped mix → master gain pulling the peak to −1 dBFS", () => {
    const report = analyzeMixHealth([brokenTrapMix()], SR);
    const fix = deriveMixAutoFix(report);
    expect(fix).not.toBeNull();
    expect(fix!.masterGain).toBeLessThan(1);
    expect(Math.abs(20 * Math.log10(report.peak * fix!.masterGain) + 1)).toBeLessThan(0.01);
  });

  it("deterministic", () => {
    const r = analyzeMixHealth([brokenTrapMix()], SR);
    expect(deriveMixAutoFix(r)).toEqual(deriveMixAutoFix(r));
  });
});
