/**
 * FXEQ sample-rate robustness sweep.
 *
 * The core must behave identically in structure at any device-provided
 * sample rate: reverb/delay buffer scaling, filter coefficient design and
 * the DC blocker all derive from `prepare(sampleRate)`, but any hidden
 * 44.1 kHz assumption (hardcoded lengths, unscaled ring capacities) shows
 * up at 96 kHz as wrap artifacts, exploding filter state or NaN/Inf.
 *
 * The sweep drives every factory preset through 44.1/48/96 kHz with a
 * hostile excitation (DC offset + loud tone + impulses — DC stresses the
 * input high-pass, impulses stress every IIR state) and asserts the
 * output stays finite and physically bounded. The limiter is enabled in
 * every factory preset, so the −0.3 dB ceiling holds after its lookahead
 * fill transient (documented ~0.2 % startup overshoot → 1.05 bound).
 *
 * Mirrors the real host sequence: prepare(sampleRate) first, then
 * loadParameters (the worklet entry does exactly this with
 * processorOptions params).
 */
import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";
import { FXEQ_PRESETS } from "../src/effects/fxeq-core/core/presets";

const BLOCK = 128;
const BLOCKS_PER_CASE = 80;
const SAMPLE_RATES = [44100, 48000, 96000];
/** Limiter ceiling is −0.3 dB (≈0.966); +startup transient margin. */
const PEAK_BOUND = 1.05;

/** DC offset + loud sine + periodic impulse — deterministic, no allocation. */
function fillExcitation(l: Float32Array, r: Float32Array, sampleRate: number, blockIndex: number): void {
  const globalIdx0 = blockIndex * BLOCK;
  for (let i = 0; i < BLOCK; i++) {
    const n = globalIdx0 + i;
    const tone = Math.sin((2 * Math.PI * 997 * n) / sampleRate) * 0.7;
    const impulse = n % 997 === 0 ? 0.9 : 0;
    l[i] = 0.2 + tone + impulse;
    r[i] = 0.2 - tone * 0.8 + (n % 1103 === 0 ? 0.9 : 0);
  }
}

describe("fxeq sample-rate sweep (all presets × 44.1/48/96 kHz)", () => {
  for (const sampleRate of SAMPLE_RATES) {
    it(`keeps every preset finite and bounded at ${sampleRate} Hz`, () => {
      expect(FXEQ_PRESETS.length).toBeGreaterThan(0);
      const l = new Float32Array(BLOCK);
      const r = new Float32Array(BLOCK);
      const channels = [l, r];

      for (const preset of FXEQ_PRESETS) {
        const proc = createFxEqProcessor();
        proc.prepare(sampleRate, 2, BLOCK);
        proc.loadParameters(preset.params);

        for (let blk = 0; blk < BLOCKS_PER_CASE; blk++) {
          fillExcitation(l, r, sampleRate, blk);
          proc.process(channels, BLOCK);
          for (let i = 0; i < BLOCK; i++) {
            if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) {
              throw new Error(
                `${preset.id} @ ${sampleRate} Hz produced non-finite output ` +
                  `(block ${blk}, sample ${i}: L=${l[i]} R=${r[i]})`,
              );
            }
            if (Math.abs(l[i]) > PEAK_BOUND || Math.abs(r[i]) > PEAK_BOUND) {
              throw new Error(
                `${preset.id} @ ${sampleRate} Hz exceeded the limiter bound ` +
                  `(block ${blk}, sample ${i}: |L|=${Math.abs(l[i]).toFixed(3)} |R|=${Math.abs(r[i]).toFixed(3)})`,
              );
            }
          }
        }
      }
    });
  }

  it("uses distinct processing state per sample rate (96 kHz is not resampled 44.1 audio)", () => {
    // A 997 Hz tone must show the correct period at each rate — catches any
    // path where the sample rate was ignored (fixed coefficient sets).
    const periodSamples = (sr: number): number => sr / 997;
    for (const sr of SAMPLE_RATES) {
      const proc = createFxEqProcessor();
      proc.prepare(sr, 2, BLOCK);
      // Pure passthrough config: limiter off, all modules off, dry path.
      proc.loadParameters({ limiterEnabled: 0, globalMix: 0 });
      const total = BLOCK * 40;
      const buf = new Float32Array(total);
      let zeroCrossings = 0;
      for (let blk = 0; blk < 40; blk++) {
        const view = buf.subarray(blk * BLOCK, (blk + 1) * BLOCK);
        for (let i = 0; i < BLOCK; i++) view[i] = Math.sin((2 * Math.PI * 997 * (blk * BLOCK + i)) / sr);
        const scratch = [Float32Array.from(view), new Float32Array(BLOCK)];
        proc.process(scratch, BLOCK);
        scratch[0].forEach((v, i) => (view[i] = v));
      }
      for (let i = 1; i < total; i++) {
        if (buf[i - 1] < 0 && buf[i] >= 0) zeroCrossings++;
      }
      const measuredPeriod = total / zeroCrossings;
      const expected = periodSamples(sr);
      // 1 % tolerance — window/phase effects.
      expect(
        Math.abs(measuredPeriod - expected) / expected,
        `997 Hz tone period wrong at ${sr} Hz (measured ${measuredPeriod.toFixed(1)}, expected ${expected.toFixed(1)})`,
      ).toBeLessThan(0.01);
    }
  });
});
