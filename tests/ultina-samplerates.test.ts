/**
 * Ultina sample-rate robustness — the plugin must behave identically at any
 * device-provided rate (44.1 kHz Bluetooth headsets, 48 kHz desktops, 96 kHz
 * interfaces). All DSP coefficients derive from sampleRate; these tests prove
 * the two user-audible invariants hold across rates:
 *
 *  1. LR4/hybrid crossover bands still sum allpass-flat (split+sum keeps a
 *     steady tone's amplitude at 2-band, 3-band, and after a 3→2 switch).
 *  2. The full processor passes a −23 dBFS stereo tone through at −23 LUFS
 *     (K-weighting chain calibrated at the rendered rate), and a configured
 *     compressor still compresses.
 */
import { describe, expect, it } from "vitest";
import { CrossoverNetwork } from "../src/effects/ultina-core/dsp/multiband.js";
import { UltinaProcessor } from "../src/effects/ultina-core/dsp/ultinaProcessor.js";
import { registerCoreModules } from "../src/effects/ultina-core/dsp/moduleFactories.js";

const RATES = [44100, 48000, 96000] as const;
const BLOCK = 128;

describe("CrossoverNetwork allpass sum across sample rates", () => {
  for (const sr of RATES) {
    it(`${sr} Hz: 2-band and 3-band sums keep a steady tone's amplitude`, () => {
      for (const bandCount of [2, 3] as const) {
        for (const mode of ["analog", "hybrid"] as const) {
          const xover = new CrossoverNetwork();
          xover.prepare(2, bandCount, BLOCK);
          xover.setCrossoverMode(mode);
          xover.setFrequency(0, 250, sr);
          xover.setFrequency(1, 2500, sr);

          const bandOut: Float32Array[][] = Array.from({ length: 3 }, () => [
            new Float32Array(BLOCK),
            new Float32Array(BLOCK),
          ]);
          const sum = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
          const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];

          const seconds = 1.0;
          const blocks = Math.round((seconds * sr) / BLOCK);
          const tailBlocks = Math.round((0.025 * sr) / BLOCK);
          let peak = 0;
          for (let b = 0; b < blocks; b++) {
            for (let ch = 0; ch < 2; ch++) {
              for (let i = 0; i < BLOCK; i++) {
                input[ch][i] = 0.5 * Math.sin((2 * Math.PI * 1000 * (b * BLOCK + i)) / sr);
              }
            }
            xover.split(input, bandOut, BLOCK, sr);
            xover.sum(bandOut, sum, BLOCK);
            if (b >= blocks - tailBlocks) {
              for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(sum[0][i]));
            }
          }
          const label = `${sr} Hz / ${bandCount}-band / ${mode}`;
          expect(peak, label).toBeCloseTo(0.5, 1);
        }
      }
    });

    it(`${sr} Hz: 3-band → 2-band switch keeps the LR4 sum allpass`, () => {
      const xover = new CrossoverNetwork();
      xover.prepare(2, 3, BLOCK);
      xover.setFrequency(0, 250, sr);
      xover.setFrequency(1, 2500, sr);
      // settle 3-band, then the exact switch the modules perform
      xover.setBandCount(2);

      const bandOut: Float32Array[][] = Array.from({ length: 3 }, () => [
        new Float32Array(BLOCK),
        new Float32Array(BLOCK),
      ]);
      const sum = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      const blocks = Math.round((1.0 * sr) / BLOCK);
      const tailBlocks = Math.round((0.025 * sr) / BLOCK);
      let peak = 0;
      for (let b = 0; b < blocks; b++) {
        for (let ch = 0; ch < 2; ch++) {
          for (let i = 0; i < BLOCK; i++) {
            input[ch][i] = 0.5 * Math.sin((2 * Math.PI * 3000 * (b * BLOCK + i)) / sr);
          }
        }
        xover.split(input, bandOut, BLOCK, sr);
        xover.sum(bandOut, sum, BLOCK);
        if (b >= blocks - tailBlocks) {
          for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(sum[0][i]));
        }
      }
      expect(peak, `${sr} Hz 3→2 switch`).toBeCloseTo(0.5, 1);
    });
  }
});

describe("UltinaProcessor loudness + dynamics across sample rates", () => {
  function makeProc(sr: number): UltinaProcessor {
    const proc = new UltinaProcessor();
    registerCoreModules(proc);
    proc.prepare({ sampleRate: sr, maxBlockSize: BLOCK, channelCount: 2, qualityMode: 1 });
    return proc;
  }

  for (const sr of RATES) {
    it(`${sr} Hz: −23 dBFS stereo tone reads ≈ −23 LUFS through the full processor`, () => {
      const proc = makeProc(sr);
      const amplitude = Math.pow(10, -23 / 20);
      const blocks = Math.round((4.0 * sr) / BLOCK);
      const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      for (let b = 0; b < blocks; b++) {
        for (let i = 0; i < BLOCK; i++) {
          const v = amplitude * Math.sin((2 * Math.PI * 1000 * (b * BLOCK + i)) / sr);
          input[0][i] = v;
          input[1][i] = v;
        }
        proc.process(input, BLOCK);
      }
      const reading = proc.getLufsReading();
      expect(reading.shortTermLufs).toBeGreaterThan(-24.2);
      expect(reading.shortTermLufs).toBeLessThan(-21.8);
      // True-peak must agree with the known intersample truth for a sine.
      expect(reading.truePeakDb).toBeGreaterThan(-23.6);
      expect(reading.truePeakDb).toBeLessThan(-21.5);
    });

    it(`${sr} Hz: a configured compressor still compresses`, () => {
      const proc = makeProc(sr);
      proc.getGraphRuntime().setModuleEnabled("comp", true);
      proc.loadState({
        "comp.enabled": 1,
        "comp.thresholdDb": -40,
        "comp.band0.thresholdDb": -40,
        "comp.band1.thresholdDb": -40,
        "comp.band2.thresholdDb": -40,
        "comp.ratio": 20,
        "comp.detectionMode": 0,
        "comp.attackMs": 5,
        "comp.releaseMs": 120,
      });
      const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      let outSq = 0;
      let inSq = 0;
      let n = 0;
      const blocks = Math.round((0.8 * sr) / BLOCK);
      for (let b = 0; b < blocks; b++) {
        for (let i = 0; i < BLOCK; i++) {
          const v = 0.158 * Math.sin((2 * Math.PI * 1000 * (b * BLOCK + i)) / sr);
          input[0][i] = v;
          input[1][i] = v;
        }
        proc.process(input, BLOCK);
        if (b >= blocks - 16) {
          for (let i = 0; i < BLOCK; i++) {
            outSq += input[0][i] * input[0][i];
            inSq += 0.158 * 0.158 * Math.sin((2 * Math.PI * 1000 * (b * BLOCK + i)) / sr) ** 2;
            n++;
          }
        }
      }
      const ratio = Math.sqrt(outSq / n) / Math.sqrt(inSq / n);
      expect(ratio, `${sr} Hz compression`).toBeLessThan(0.3);
    });
  }
});
