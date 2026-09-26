import { describe, it, expect, afterEach } from "vitest";
import { UnmaskModuleProcessor } from "../src/effects/ultina-core/dsp/modules/unmaskModule.js";
import { SpectralRegistry } from "../src/effects/ultina-core/dsp/spectralRegistry.js";

/**
 * QA-3 UNMASK SWEEP — the VLYX pocket measured, not guessed.
 *
 * Drives the real (vendored, untouched) UnmaskModuleProcessor in Node with a
 * vocal-like masker vs a broadband music bed and records gain reduction per
 * `unmask.amount` step, for BOTH key paths:
 *   1. direct sidechain input (scEnabled + sidechain buffers), and
 *   2. the ecosystem path the vocal pocket actually uses (a publisher
 *      instance feeds SpectralRegistry, the consumer reads the aggregate
 *      masker — no sidechainTrackId wiring involved).
 *
 * Valuable output doubles as documentation: the console table pins what
 * amount=50 (the pocket default) really does on this DSP build.
 */

const SR = 44100;
const SECONDS = 2;
const BLOCK = 256;

function sine(freq: number, length: number, amplitude: number, phase = 0): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return out;
}

function addInto(dst: Float32Array, src: Float32Array): void {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) dst[i] += src[i];
}

/** Vocal-ish masker: formant-clustered energy (250/700/1800/2900 Hz). */
function masker(length: number): Float32Array {
  const out = new Float32Array(length);
  addInto(out, sine(250, length, 0.22));
  addInto(out, sine(700, length, 0.2));
  addInto(out, sine(1800, length, 0.16));
  addInto(out, sine(2900, length, 0.12));
  return out;
}

/** Broadband music bed: spread components, quieter per-band than the masker. */
function musicBed(length: number): Float32Array {
  const out = new Float32Array(length);
  const freqs = [90, 140, 220, 340, 500, 1100, 2500, 4200, 6800, 10500, 14000];
  for (const [i, freq] of freqs.entries()) {
    addInto(out, sine(freq, length, 0.09, i * 0.7));
  }
  return out;
}

function stereo(mono: Float32Array): [Float32Array, Float32Array] {
  return [mono.slice(), mono.slice()];
}

interface SweepPoint {
  amount: number;
  meanGrDb: number;
  maxGrDb: number;
  vocalBandGrDb: number;
}

/** Vocal band slice of the 32 log-spaced 40 Hz..16 kHz bands (≈300 Hz..3 kHz). */
const VOCAL_BANDS: [number, number] = [10, 22];

function runModule(
  music: Float32Array,
  sidechain: Float32Array[] | null,
  params: Record<string, number>,
  instanceId?: string,
): { gr: Float32Array; out: [Float32Array, Float32Array] } {
  const mod = new UnmaskModuleProcessor();
  const ctx = { sampleRate: SR, maxBlockSize: BLOCK, channelCount: 2, qualityMode: 1 };
  mod.prepare(ctx);
  if (instanceId) mod.setInstanceId(instanceId);
  const [left, right] = stereo(music);
  const channels: [Float32Array, Float32Array] = [left, right];
  const blocks = Math.floor(music.length / BLOCK);
  for (let b = 0; b < blocks; b++) {
    const from = b * BLOCK;
    const slice: Float32Array[] = [channels[0].subarray(from, from + BLOCK), channels[1].subarray(from, from + BLOCK)];
    // NOTE: process() mutates the slices in place (they are views).
    mod.process({
      channels: slice,
      frameCount: BLOCK,
      ctx,
      sidechain: sidechain ? sidechain.map((ch) => ch.subarray(from, from + BLOCK)) : null,
      params,
    });
  }
  const meters = mod.getMeters();
  return { gr: Float32Array.from(meters.gainReductionPerBandDb), out: channels };
}

function summarize(gr: Float32Array, amount: number): SweepPoint {
  let sum = 0;
  let max = 0;
  let vocalSum = 0;
  for (let b = 0; b < gr.length; b++) {
    const v = Math.abs(gr[b]);
    sum += v;
    if (v > max) max = v;
    if (b >= VOCAL_BANDS[0] && b <= VOCAL_BANDS[1]) vocalSum += v;
  }
  return {
    amount,
    meanGrDb: sum / gr.length,
    maxGrDb: max,
    vocalBandGrDb: vocalSum / (VOCAL_BANDS[1] - VOCAL_BANDS[0] + 1),
  };
}

const BASE_PARAMS = {
  "unmask.enabled": 1,
  "unmask.maskingThresholdDb": -15,
  "unmask.responseSpeedHz": 5,
  "unmask.channelMode": 0,
};

describe("unmask sweep — direct sidechain path", () => {
  const length = SR * SECONDS;
  const music = musicBed(length);
  const mask = masker(length);
  const sc: [Float32Array, Float32Array] = stereo(mask);

  it("amount 0 is inert; reduction grows monotonically with amount", () => {
    const points: SweepPoint[] = [];
    for (const amount of [0, 30, 50, 70, 100]) {
      const { gr, out } = runModule(music, sc, {
        ...BASE_PARAMS,
        "unmask.sidechainEnabled": 1,
        "unmask.amount": amount,
      });
      for (const ch of out) for (const v of ch) expect(Number.isFinite(v)).toBe(true);
      points.push(summarize(gr, amount));
    }
    console.log(
      "[unmask-sweep/direct]\n" +
        points
          .map(
            (p) =>
              `  amount=${p.amount}: mean=${p.meanGrDb.toFixed(2)}dB max=${p.maxGrDb.toFixed(2)}dB vocal=${p.vocalBandGrDb.toFixed(2)}dB`,
          )
          .join("\n"),
    );
    expect(points[0].maxGrDb).toBeLessThan(0.5);
    // Monotonic with saturation: non-decreasing everywhere, strictly up from silence.
    for (let i = 1; i < points.length; i++) {
      expect(points[i].meanGrDb).toBeGreaterThanOrEqual(points[i - 1].meanGrDb);
    }
    expect(points[points.length - 1].meanGrDb).toBeGreaterThan(points[0].meanGrDb);
    const at50 = points[2];
    expect(at50.vocalBandGrDb).toBeGreaterThan(at50.meanGrDb); // cuts concentrate where the voice is
    // MAX_REDUCTION_DB ceiling (12 dB) engages at high amounts — bounded, never runaway.
    expect(points[points.length - 1].maxGrDb).toBeLessThanOrEqual(12.01);
    expect(points[points.length - 1].maxGrDb).toBeGreaterThan(11.9);
  });
});

describe("unmask sweep — ecosystem path (the vocal pocket)", () => {
  const length = SR * SECONDS;
  const music = musicBed(length);

  afterEach(() => {
    SpectralRegistry.getInstance().unregister("qa3-sweep-consumer");
    SpectralRegistry.getInstance().unregister("qa3-sweep-publisher");
  });

  it("a publisher in the registry drives consumer cuts with no sidechain buffers", () => {
    // Publisher profile: hot vocal bands (dB), quiet elsewhere — as a real
    // vocal-track ultina would publish from updateInputMeters.
    const reg = SpectralRegistry.getInstance();
    reg.register("qa3-sweep-publisher", "Vocal");
    const published = new Float32Array(32).fill(-200);
    for (let b = VOCAL_BANDS[0]; b <= VOCAL_BANDS[1]; b++) published[b] = -12;
    const amounts = [0, 30, 50, 70, 100];
    const vocalCuts: number[] = [];
    for (const amount of amounts) {
      reg.publish("qa3-sweep-publisher", published);
      const { gr } = runModule(
        music,
        null,
        {
          ...BASE_PARAMS,
          "unmask.ecosystemEnabled": 1,
          "unmask.amount": amount,
        },
        "qa3-sweep-consumer",
      );
      let vocalSum = 0;
      for (let b = VOCAL_BANDS[0]; b <= VOCAL_BANDS[1]; b++) vocalSum += Math.abs(gr[b]);
      vocalCuts.push(vocalSum / (VOCAL_BANDS[1] - VOCAL_BANDS[0] + 1));
    }
    console.log(
      "[unmask-sweep/ecosystem] vocal-band mean cut: " +
        amounts.map((a, i) => `${a}→${vocalCuts[i].toFixed(2)}dB`).join(" "),
    );
    expect(vocalCuts[0]).toBeLessThan(0.5); // amount 0 inert
    // Monotonic with saturation (same ceiling as the direct path).
    for (let i = 1; i < vocalCuts.length; i++) {
      expect(vocalCuts[i]).toBeGreaterThanOrEqual(vocalCuts[i - 1]);
    }
    expect(vocalCuts[vocalCuts.length - 1]).toBeGreaterThan(vocalCuts[0]);
    expect(vocalCuts[2]).toBeGreaterThan(0.5); // amount 50 (pocket default) bites
  });
});
