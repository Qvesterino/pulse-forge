import { describe, expect, it } from "vitest";
import {
  MATCH_EQ_MAX_GAIN_DB,
  computeMatchEqCurve,
  matchEqCurveForPcm,
  spectrumBandBalance,
} from "../src/intent/match-eq";

/**
 * MATCH EQ — "znej ako ref" (user: "toto bude úplne kľúčové").
 *
 * These pins hold the mathematical contract of the reference match: the
 * curve matches tonal SHAPE (loudness-invariant, de-meanned, never a hidden
 * volume move), points in the right direction (a darker mix than the
 * reference gets positive high gain), and respects mastering-grade safety
 * rails (±6 dB clamp, 1 dB deadzone). Real-render verification of the master
 * stage lives in src/browser-checks.ts (jsdom cannot run OfflineAudioContext).
 */

const SR = 44100;

/** A stationary tone at `hz` for `seconds` (deterministic, any level). */
function tone(hz: number, seconds = 1, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

/** Broadband-ish deterministic noise (seeded LCG). */
function noise(seconds = 1, amp = 0.5, seed = 42): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds));
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amp * ((s / 0x7fffffff) * 2 - 1);
  }
  return out;
}

describe("spectrumBandBalance", () => {
  it("a pure tone lands its energy in the right band — at ANY level", () => {
    for (const amp of [0.9, 0.1, 0.02]) {
      const b = spectrumBandBalance(tone(100, 1, amp), SR); // < 250 Hz → low
      expect(b.low).toBeGreaterThan(-1); // ≈ 0 dB share: all energy in-band
      expect(b.lowMid).toBeLessThan(-20);
      const m = spectrumBandBalance(tone(500, 1, amp), SR); // 250–1000 → lowMid
      expect(m.lowMid).toBeGreaterThan(-1);
      const h = spectrumBandBalance(tone(3000, 1, amp), SR); // 1k–4k → highMid
      expect(h.highMid).toBeGreaterThan(-1);
      const t = spectrumBandBalance(tone(8000, 1, amp), SR); // > 4k → high
      expect(t.high).toBeGreaterThan(-1);
    }
  });

  it("is loudness-invariant: scaling the input does not move the balance", () => {
    const quiet = spectrumBandBalance(noise(1, 0.1), SR);
    const loud = spectrumBandBalance(noise(1, 0.9), SR);
    expect(Math.abs(quiet.low - loud.low)).toBeLessThan(0.1);
    expect(Math.abs(quiet.high - loud.high)).toBeLessThan(0.1);
  });
});

describe("computeMatchEqCurve", () => {
  it("darker mix than the reference → positive high gain, negative low gain", () => {
    const mix = { low: -2, lowMid: -5, highMid: -8, high: -12 }; // dark balance
    const ref = { low: -8, lowMid: -5, highMid: -3, high: -2 }; // bright balance
    const curve = computeMatchEqCurve(mix, ref);
    expect(curve.high).toBeGreaterThan(0);
    expect(curve.low).toBeLessThan(0);
  });

  it("identical balances → the zero curve (deadzone)", () => {
    const same = { low: -6, lowMid: -5, highMid: -5, high: -7 };
    const curve = computeMatchEqCurve(same, { ...same });
    expect(curve).toEqual({ low: 0, lowMid: 0, highMid: 0, high: 0 });
  });

  it("loudness offset cancels: +10 dB on EVERY reference band → same curve", () => {
    const mix = { low: -4, lowMid: -5, highMid: -6, high: -7 };
    const ref = { low: -8, lowMid: -4, highMid: -3, high: -2 };
    const refBoosted = { low: ref.low + 10, lowMid: ref.lowMid + 10, highMid: ref.highMid + 10, high: ref.high + 10 };
    const a = computeMatchEqCurve(mix, ref);
    const b = computeMatchEqCurve(mix, refBoosted);
    expect(b).toEqual(a);
  });

  it("clamps to ±6 dB on pathological gaps", () => {
    const mix = { low: -30, lowMid: -5, highMid: -5, high: -5 };
    const ref = { low: -2, lowMid: -5, highMid: -5, high: -30 };
    const curve = computeMatchEqCurve(mix, ref);
    expect(curve.low).toBeLessThanOrEqual(MATCH_EQ_MAX_GAIN_DB);
    expect(curve.high).toBeGreaterThanOrEqual(-MATCH_EQ_MAX_GAIN_DB);
  });

  it("sub-1 dB residuals floor to zero (don't chase trivia)", () => {
    // After de-meaning, all differences land under the deadzone.
    const mix = { low: -5, lowMid: -5, highMid: -5.4, high: -5 };
    const ref = { low: -5, lowMid: -5, highMid: -5.2, high: -5 };
    const curve = computeMatchEqCurve(mix, ref);
    expect(curve.highMid).toBe(0);
  });
});

describe("matchEqCurveForPcm (end-to-end math)", () => {
  /** Four-band broadband probe with per-band weights (all bands populated). */
  function shaped(amps: [number, number, number, number], seconds = 1.5): Float32Array {
    const hz = [100, 500, 2500, 6000];
    const out = new Float32Array(Math.floor(SR * seconds));
    for (let i = 0; i < out.length; i++) {
      const t = i / SR;
      let v = 0;
      for (let b = 0; b < 4; b++) v += amps[b] * Math.sin(2 * Math.PI * hz[b] * t);
      out[i] = v / 2; // keep peaks sane
    }
    return out;
  }

  it("dark mix vs bright reference: the curve brightens the mix", () => {
    const mixPcm = shaped([0.9, 0.5, 0.2, 0.1]); // low-heavy
    const refPcm = shaped([0.1, 0.2, 0.5, 0.9]); // high-heavy
    const curve = matchEqCurveForPcm(mixPcm, SR, refPcm, SR);
    expect(curve).not.toBeNull();
    expect(curve!.high).toBeGreaterThan(1); // brightens the top
    expect(curve!.low).toBeLessThan(-1); // tames the bottom
  });

  it("declines single-band references (a pure tone carries no matchable balance)", () => {
    // A pure 6 kHz tone leaves 3 bands empty — matching against it would
    // derive "corrections" from noise. The usable-check must reject it.
    expect(matchEqCurveForPcm(shaped([0.25, 0.25, 0.25, 0.25]), SR, tone(6000, 1.5), SR)).toBeNull();
  });

  it("declines unusable inputs: silent or non-finite reference/mix → null (never anti-match)", () => {
    const silent = new Float32Array(SR);
    const nan = new Float32Array(SR).fill(NaN);
    expect(matchEqCurveForPcm(tone(440), SR, silent, SR)).toBeNull();
    expect(matchEqCurveForPcm(tone(440), SR, nan, SR)).toBeNull();
    expect(matchEqCurveForPcm(silent, SR, tone(440), SR)).toBeNull();
  });

  it("bandwidth alignment: the SAME signal measured at 44.1 kHz and 16 kHz gives the same balance", () => {
    // The top window edge is 8 kHz on BOTH sides — without it, the 44.1 kHz
    // side would integrate 8–22 kHz energy the 16 kHz reference can never
    // show and read as systematically darker.
    const at44 = noise(2, 0.5, 123);
    // Deterministic "resample": regenerate the same LCG stream at 16 kHz —
    // identical statistics, different SR (this is the property that matters).
    let s16 = 123;
    const at16 = new Float32Array(16000 * 2);
    for (let i = 0; i < at16.length; i++) {
      s16 = (s16 * 1103515245 + 12345) & 0x7fffffff;
      at16[i] = 0.5 * ((s16 / 0x7fffffff) * 2 - 1);
    }
    const b44 = spectrumBandBalance(at44, SR);
    const b16 = spectrumBandBalance(at16, 16000);
    // White noise spreads energy ∝ bandwidth: shares differ slightly between
    // band layouts at the two SRs, but the DIFFERENCE must be small and —
    // critically — free of the one-sided 8–22 kHz bias (bounded ≤ 3 dB).
    expect(Math.abs(b44.high - b16.high)).toBeLessThan(3);
  });

  it("reference level −20 dB → IDENTICAL curve (the flagship invariant)", () => {
    const mix = noise(1, 0.5, 7);
    const refLoud = noise(1, 0.8, 99);
    const refQuiet = new Float32Array(refLoud.length);
    for (let i = 0; i < refLoud.length; i++) refQuiet[i] = refLoud[i] * 0.1; // −20 dB
    const a = matchEqCurveForPcm(mix, SR, refLoud, SR);
    const b = matchEqCurveForPcm(mix, SR, refQuiet, SR);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.low).toBeCloseTo(a!.low, 6);
    expect(b!.lowMid).toBeCloseTo(a!.lowMid, 6);
    expect(b!.highMid).toBeCloseTo(a!.highMid, 6);
    expect(b!.high).toBeCloseTo(a!.high, 6);
  });
});
