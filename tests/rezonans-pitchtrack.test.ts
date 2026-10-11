import { describe, expect, it } from "vitest";
import { PitchTracker } from "../src/effects/rezonans-core/dsp/pitchTrack";

describe("REZONANS YIN pitch tracking", () => {
  it.each([24000, 44100, 48000])("keeps pitch accuracy at %i Hz sample rate across quality windows", (sampleRate) => {
    for (const fftSize of [1024, 2048, 4096]) {
      for (const frequency of [110, 220, 440, 783.99]) {
        const ring = new Float32Array(fftSize * 2);
        for (let i = 0; i < fftSize; i++) {
          ring[i] = 0.4 * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
        }

        const tracker = new PitchTracker();
        tracker.prepare(sampleRate, fftSize, 70, 800);
        const estimate = tracker.detect(ring, ring.length, fftSize);
        const errorCents = Math.abs(1200 * Math.log2(estimate.hz / frequency));

        const label = `${sampleRate} Hz, ${fftSize} FFT, ${frequency} Hz; estimate ${estimate.hz.toFixed(2)} Hz`;
        expect(estimate.hz, label).toBeGreaterThan(0);
        expect(errorCents, label).toBeLessThan(15);
        expect(estimate.clarity, `${sampleRate} Hz, ${fftSize} FFT, ${frequency} Hz`).toBeGreaterThan(0.9);
      }
    }
  });
});
