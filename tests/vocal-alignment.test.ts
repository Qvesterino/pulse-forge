import { describe, expect, it } from "vitest";
import {
  AUTO_ALIGN_MAX_SHIFT_SEC,
  ALIGN_WINDOW_MS,
  autoAlignShiftSec,
  formatShiftMs,
  measurePhraseOnset,
  passAlignShifts,
} from "../src/audio-engine/vocal-alignment";

/**
 * VOCAL-FIRST ALIGNMENT — the measurement.
 *
 * A singer enters a phrase a latency-scale step late; the fix is skipping that
 * leading silence, and this module decides how much. The specs below build the
 * signals by hand so every verdict is checkable: where the phrase starts, where
 * the noise floor sits, and what the module refuses to touch.
 */

const SR = 8_000;
const WINDOW_SEC = ALIGN_WINDOW_MS / 1000;

function phraseChannel(
  options: { seconds?: number; onsetMs?: number; amplitude?: number; noise?: number } = {},
): Float32Array {
  const seconds = options.seconds ?? 0.5;
  const onsetMs = options.onsetMs ?? 0;
  const amplitude = options.amplitude ?? 0.5;
  const noise = options.noise ?? 0;
  const length = Math.round(seconds * SR);
  const channel = new Float32Array(length);
  const onset = Math.round((onsetMs / 1000) * SR);
  // A deterministic pseudo-noise floor so the low-level case is reproducible.
  let seed = 1234567;
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noiseSample = (seed / 0x7fffffff) * 2 - 1;
    const tone = index >= onset ? Math.sin((2 * Math.PI * 220 * (index - onset)) / SR) * amplitude : 0;
    channel[index] = tone + noiseSample * noise;
  }
  return channel;
}

describe("measurePhraseOnset", () => {
  it("finds a phrase that starts a latency step late (window-quantized)", () => {
    const measurement = measurePhraseOnset([phraseChannel({ onsetMs: 42 })], SR);
    expect(measurement).not.toBeNull();
    expect(measurement!.confidence).toBe("high");
    // The scan is window-quantized, so the report is the window the run began in.
    expect(measurement!.onsetSec).toBeGreaterThanOrEqual(42 / 1000 - WINDOW_SEC);
    expect(measurement!.onsetSec).toBeLessThanOrEqual(42 / 1000);
  });

  it("reports zero for a take that begins ON its entry", () => {
    const measurement = measurePhraseOnset([phraseChannel({ onsetMs: 0 })], SR);
    expect(measurement).toMatchObject({ onsetSec: 0, confidence: "high" });
  });

  it("measures through a low-level noise floor (the phrase, not the hiss)", () => {
    const measurement = measurePhraseOnset([phraseChannel({ onsetMs: 60, noise: 0.002 })], SR);
    expect(measurement).not.toBeNull();
    expect(measurement!.onsetSec).toBeGreaterThanOrEqual(60 / 1000 - WINDOW_SEC);
    expect(measurement!.onsetSec).toBeLessThanOrEqual(60 / 1000);
  });

  it("works on a very quiet take (the threshold follows the take's own peak)", () => {
    const measurement = measurePhraseOnset([phraseChannel({ onsetMs: 30, amplitude: 0.02 })], SR);
    expect(measurement).not.toBeNull();
    expect(measurement!.onsetSec).toBeGreaterThanOrEqual(30 / 1000 - WINDOW_SEC);
    expect(measurement!.onsetSec).toBeLessThanOrEqual(30 / 1000);
  });

  it("refuses a burst too short to be a phrase start", () => {
    // 10 ms of tone = two windows; the run needs three.
    const channel = new Float32Array(Math.round(0.5 * SR));
    const start = Math.round(0.02 * SR);
    for (let index = start; index < start + Math.round(0.01 * SR); index += 1) {
      channel[index] = Math.sin((2 * Math.PI * 220 * (index - start)) / SR) * 0.5;
    }
    expect(measurePhraseOnset([channel], SR)).toBeNull();
  });

  it("returns null for silence and for nonsense input", () => {
    expect(measurePhraseOnset([new Float32Array(SR)], SR)).toBeNull();
    expect(measurePhraseOnset([], SR)).toBeNull();
    expect(measurePhraseOnset([phraseChannel({ onsetMs: 40 })], 0)).toBeNull();
    expect(measurePhraseOnset([phraseChannel({ onsetMs: 40 })], Number.NaN)).toBeNull();
  });

  it("returns null when the phrase starts outside the search window", () => {
    // A deliberate late entry (beat 3, a pickup) is not a latency correction.
    expect(measurePhraseOnset([phraseChannel({ seconds: 1, onsetMs: 500 })], SR)).toBeNull();
    expect(
      measurePhraseOnset([phraseChannel({ seconds: 1, onsetMs: 200 })], SR, { searchWindowSec: 0.5 }),
    ).not.toBeNull();
  });
});

describe("autoAlignShiftSec", () => {
  it("applies a confident latency-scale shift", () => {
    expect(autoAlignShiftSec({ onsetSec: 0.08, confidence: "high" })).toBeCloseTo(0.08, 5);
  });

  it("never applies a shift that is only measurement noise", () => {
    expect(autoAlignShiftSec({ onsetSec: 0.002, confidence: "high" })).toBe(0);
  });

  it("never auto-applies a shift larger than a latency correction", () => {
    expect(autoAlignShiftSec({ onsetSec: AUTO_ALIGN_MAX_SHIFT_SEC + 0.01, confidence: "high" })).toBe(0);
    // …unless the caller explicitly raises the ceiling (the manual action).
    expect(autoAlignShiftSec({ onsetSec: 0.2, confidence: "high" }, { maxShiftSec: 0.5 })).toBeCloseTo(0.2, 5);
  });

  it("never acts on a low-confidence measurement", () => {
    expect(autoAlignShiftSec({ onsetSec: 0.08, confidence: "low" })).toBe(0);
  });

  it("does nothing without a measurement", () => {
    expect(autoAlignShiftSec(null)).toBe(0);
  });
});

describe("passAlignShifts", () => {
  it("measures every loop pass inside its OWN window (a singer drifts)", () => {
    const passFrames = SR;
    const first = phraseChannel({ seconds: 1, onsetMs: 40 });
    const second = phraseChannel({ seconds: 1, onsetMs: 80 });
    const joined = new Float32Array(passFrames * 2);
    joined.set(first, 0);
    joined.set(second, passFrames);

    const shifts = passAlignShifts([joined], SR, [
      { startFrame: 0, endFrame: passFrames },
      { startFrame: passFrames, endFrame: passFrames * 2 },
    ]);

    expect(shifts).toHaveLength(2);
    expect(shifts[0]).toBeGreaterThan(0.035);
    expect(shifts[0]).toBeLessThanOrEqual(0.04);
    expect(shifts[1]).toBeGreaterThan(0.075);
    expect(shifts[1]).toBeLessThanOrEqual(0.08);
  });

  it("leaves a pass with no measurable start at zero", () => {
    const shifts = passAlignShifts([phraseChannel({ seconds: 1, onsetMs: 0 })], SR, [
      { startFrame: 0, endFrame: SR },
      { startFrame: 0, endFrame: SR },
    ]);
    expect(shifts[0]).toBe(0); // already on the entry
    expect(shifts[1]).toBe(0);
  });
});

describe("formatShiftMs", () => {
  it("speaks milliseconds with a signed direction", () => {
    expect(formatShiftMs(0.0384)).toBe("+38 ms");
    expect(formatShiftMs(-0.012)).toBe("−12 ms");
    expect(formatShiftMs(0)).toBe("+0 ms");
  });
});
