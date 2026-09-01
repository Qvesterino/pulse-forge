/**
 * Ultina golden parity — Pulse Forge vendored core vs upstream vectors.
 *
 * Vectors are COPIES of VocalForge_DAW/plugins/ultina's tests/vectors/ and
 * carry the FULL expected output samples. This suite renders the same
 * deterministic cases through the VENDORED UltinaProcessor and validates
 * with the upstream contract: rmsDelta ≤ toleranceDb AND maxSampleError
 * < 0.001 — proving the browser DAW runs the mixing DSP identically.
 *
 * Refresh: re-run scripts/vendor-ultina.mjs after upstream changes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UltinaProcessor } from "../src/effects/ultina-core/dsp/ultinaProcessor.js";
import { buildDefaultParams } from "../src/effects/ultina-core/contracts/parameterSchema.js";

interface GoldenVector {
  id: string;
  description: string;
  sampleRate: number;
  frameCount: number;
  params: Record<string, number>;
  inputRmsDb: number;
  outputRmsDb: number;
  outputChannels: number[][];
  toleranceDb: number;
}

// ── Deterministic signals (byte-faithful ports of upstream harness) ────

function sine(freqHz: number, durationMs: number, sampleRate: number, amplitude = 0.5): Float32Array[] {
  const frameCount = Math.floor((durationMs / 1000) * sampleRate);
  const L = new Float32Array(frameCount);
  const R = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const sample = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    L[i] = sample;
    R[i] = sample;
  }
  return [L, R];
}

function noise(durationMs: number, sampleRate: number, amplitude = 0.3, seed = 42): Float32Array[] {
  const frameCount = Math.floor((durationMs / 1000) * sampleRate);
  const L = new Float32Array(frameCount);
  const R = new Float32Array(frameCount);
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < frameCount; i++) {
    L[i] = amplitude * rand();
    R[i] = amplitude * rand();
  }
  return [L, R];
}

interface TestCase {
  id: string;
  signal: () => Float32Array[];
}

const TEST_CASES: readonly TestCase[] = [
  { id: "passthrough_default", signal: () => sine(440, 100, 48000, 0.5) },
  { id: "input_gain_plus6", signal: () => sine(440, 100, 48000, 0.5) },
  { id: "input_gain_minus6", signal: () => sine(440, 100, 48000, 0.5) },
  { id: "output_gain_plus3", signal: () => sine(1000, 100, 48000, 0.3) },
  { id: "mix_50_percent", signal: () => sine(440, 100, 48000, 0.5) },
  { id: "noise_passthrough", signal: () => noise(200, 48000, 0.3) },
  { id: "low_freq_sine", signal: () => sine(80, 200, 48000, 0.5) },
  { id: "high_freq_sine", signal: () => sine(8000, 100, 48000, 0.3) },
];

function loadVector(id: string): GoldenVector {
  return JSON.parse(readFileSync(join(import.meta.dirname, "ultina-vectors", `${id}.json`), "utf8")) as GoldenVector;
}

function rmsDb(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  return 20 * Math.log10(Math.max(rms, 1e-10));
}

describe("Ultina golden parity (vendored core vs upstream vectors)", () => {
  for (const tc of TEST_CASES) {
    it(`parity: ${tc.id}`, () => {
      const vector = loadVector(tc.id);
      const proc = new UltinaProcessor();
      proc.prepare({
        sampleRate: vector.sampleRate,
        channelCount: 2,
        maxBlockSize: vector.frameCount,
        qualityMode: 1,
      });
      proc.loadState(vector.params);

      const channels = tc.signal().map((ch) => new Float32Array(ch));
      proc.process(channels, vector.frameCount);

      // Upstream contract: rms within tolerance AND sample-exact (< 0.001).
      let maxError = 0;
      const golden = vector.outputChannels[0];
      for (let i = 0; i < golden.length; i++) {
        maxError = Math.max(maxError, Math.abs(golden[i] - channels[0][i]));
      }
      const rmsDelta = Math.abs(rmsDb(channels[0]) - vector.outputRmsDb);
      expect(rmsDelta).toBeLessThanOrEqual(vector.toleranceDb);
      expect(maxError).toBeLessThan(0.001);
      console.log(`[ultina-parity] ${tc.id}: rmsΔ=${rmsDelta.toFixed(4)}dB maxErr=${maxError.toExponential(2)}`);
    });
  }

  it("the parameter schema carries the full module surface", () => {
    const defaults = buildDefaultParams();
    // Headline beatmaking modules present in the parameter space.
    expect(Object.keys(defaults).some((k) => k.startsWith("unmask."))).toBe(true);
    expect(Object.keys(defaults).some((k) => k.startsWith("transient."))).toBe(true);
    expect(Object.keys(defaults).some((k) => k.startsWith("exciter."))).toBe(true);
    expect(Object.keys(defaults).some((k) => k.startsWith("density."))).toBe(true);
  });
});
