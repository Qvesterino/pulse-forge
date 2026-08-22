import { describe, expect, it } from "vitest";
import { isWorkletReady } from "../src/audio-worklets/loader";

describe("AudioWorklet loader", () => {
  it("isWorkletReady returns false before loading", () => {
    expect(isWorkletReady("bitcrusher")).toBe(false);
    expect(isWorkletReady("sidechain")).toBe(false);
  });

  it("isWorkletReady returns correct type", () => {
    // Even before loading, the function should not throw
    expect(typeof isWorkletReady("bitcrusher")).toBe("boolean");
    expect(typeof isWorkletReady("sidechain")).toBe("boolean");
  });
});

describe("Bitcrusher processor (unit logic)", () => {
  it("quantizes values to bit depth levels", () => {
    // Simulate the processor's bit reduction logic
    const bits = 2;
    const levels = Math.max(2, Math.pow(2, Math.max(1, Math.round(bits))));
    const step = 2 / (levels - 1);
    // Input: 0.3 → quantize to nearest level
    const input = 0.3;
    const quantized = Math.round((input + 1) / step) * step - 1;
    expect(quantized).toBeGreaterThanOrEqual(-1);
    expect(quantized).toBeLessThanOrEqual(1);
    // With 2 bits (4 levels), step = 2/3 ≈ 0.667
    // 0.3 → round((0.3+1)/0.667) * 0.667 - 1 = round(1.95) * 0.667 - 1 = 2*0.667 - 1 = 0.333
    expect(quantized).toBeCloseTo(0.333, 2);
  });

  it("downsample holds value for N samples", () => {
    // Simulate sample-and-hold
    let heldValue = 0;
    let counter = 0;
    const downsample = 4;
    const input = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const output: number[] = [];

    for (let i = 0; i < input.length; i++) {
      if (counter === 0) {
        heldValue = input[i];
      }
      output.push(heldValue);
      counter = (counter + 1) % downsample;
    }

    // With downsample=4: hold each value for 4 samples
    expect(output[0]).toBe(0.1); // sample 0 → hold 0.1
    expect(output[1]).toBe(0.1); // sample 1 → still 0.1
    expect(output[2]).toBe(0.1); // sample 2 → still 0.1
    expect(output[3]).toBe(0.1); // sample 3 → still 0.1
    expect(output[4]).toBe(0.5); // sample 4 → new hold 0.5
    expect(output[5]).toBe(0.5); // sample 5 → still 0.5
  });
});

describe("Sidechain processor (unit logic)", () => {
  it("envelope follower tracks peak with attack/release", () => {
    // Simulate asymmetric envelope follower
    const sampleRate = 44100;
    const attack = 0.005;
    const release = 0.2;
    const attackCoef = Math.exp(-1 / (sampleRate * attack));
    const releaseCoef = Math.exp(-1 / (sampleRate * release));

    let env = 0;
    // Simulate a signal with a sharp attack and slow release
    const signal = [0, 0, 0, 0.8, 0.8, 0.8, 0, 0, 0, 0];

    for (let i = 0; i < signal.length; i++) {
      const peak = Math.abs(signal[i]);
      env = peak > env
        ? attackCoef * env + (1 - attackCoef) * peak
        : releaseCoef * env + (1 - releaseCoef) * peak;
    }

    // After the signal drops to 0, env should still be > 0 (release phase)
    expect(env).toBeGreaterThan(0);
    expect(env).toBeLessThan(1);
  });

  it("gain reduction increases with higher ratio", () => {
    const threshold = -18;
    const envDb = -10; // 8 dB above threshold
    const threshDb = threshold;

    const overDb = Math.max(0, envDb - threshDb);

    const lowRatio = 2;
    const highRatio = 10;

    const reductionLow = overDb * (1 - 1 / lowRatio);
    const reductionHigh = overDb * (1 - 1 / highRatio);

    expect(reductionHigh).toBeGreaterThan(reductionLow);
  });
});
