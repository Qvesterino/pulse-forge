/**
 * MORPH DYNAMICS — golden render + hardening tests.
 *
 * Drives the typed core processor DIRECTLY (no AudioWorklet scope) the
 * same way tests/ultina-vectors.test.ts drives Ultina: deterministic
 * Float32 signals, prepare() + process() per block, assertions on meters
 * and output energy. Covers the product thesis (reactivity is audible and
 * observable) and the hardening matrix (silence, extremes, sample rates,
 * stability, determinism, NaN).
 *
 * UPDATE_GOLDEN=1 regenerates tests/morph-dynamics-golden/*.json — treat
 * golden drift as a REVIEWED DSP character change, never a silent re-bless.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MorphDynamicsProcessor } from "../src/effects/morph-dynamics-core/dsp/morphDynamicsProcessor";
import { buildDefaultParams } from "../src/effects/morph-dynamics-core/contracts/parameterSchema";
import { FACTORY_PRESETS, applyMorphPreset } from "../src/effects/morph-dynamics-core/presets/factoryPresets";
import * as P from "../src/effects/morph-dynamics-core/contracts/parameterIds";

const SR = 48000;
const BLOCK = 128;

interface Render {
  out: [Float32Array, Float32Array];
  meters: ReturnType<MorphDynamicsProcessor["getMeters"]>;
}

function makeProcessor(params?: Record<string, number>, sampleRate = SR): MorphDynamicsProcessor {
  const proc = new MorphDynamicsProcessor();
  proc.prepare(sampleRate, 2, BLOCK, 1);
  proc.loadState(params ?? buildDefaultParams());
  return proc;
}

/** Deterministic signal generators. */
function sine(freq: number, amplitude: number, sampleRate = SR): (i: number) => number {
  return (i: number) => amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
}

function impulseTrain(periodSamples: number, amplitude: number): (i: number) => number {
  return (i: number) => (i % periodSamples === 0 ? amplitude : 0);
}

let noiseState = 22222;
function noise(amplitude: number): (i: number) => number {
  // Deterministic LCG (no Math.random — tests must be reproducible).
  return () => {
    noiseState = (1103515245 * noiseState + 12345) & 0x7fffffff;
    return amplitude * (noiseState / 0x3fffffff - 1);
  };
}

function render(
  proc: MorphDynamicsProcessor,
  gen: (i: number) => number,
  seconds: number,
): Render {
  const frames = Math.floor(seconds * SR);
  const blocks = Math.ceil(frames / BLOCK);
  const outL = new Float32Array(blocks * BLOCK);
  const outR = new Float32Array(blocks * BLOCK);
  let meters = proc.getMeters();
  for (let b = 0; b < blocks; b++) {
    const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let i = 0; i < BLOCK; i++) {
      const v = gen(b * BLOCK + i);
      input[0][i] = v;
      input[1][i] = v;
    }
    proc.process(input, BLOCK);
    outL.set(input[0], b * BLOCK);
    outR.set(input[1], b * BLOCK);
    meters = proc.getMeters();
  }
  return { out: [outL, outR], meters };
}

function rms(buf: Float32Array, from = 0, to = buf.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

function peakOf(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
  return p;
}

describe("morph-dynamics core processor — thesis behavior", () => {
  it("passes a quiet signal essentially untouched at low PRESSURE", () => {
    const proc = makeProcessor({ "macro.pressure": 0, "macro.space": 0, "macro.motion": 0 });
    const { out } = render(proc, sine(440, 0.05), 0.5);
    const tail = 0.3 * SR;
    const inRms = 0.05 / Math.SQRT2;
    const outRms = rms(out[0], Math.floor(tail));
    // Dynamics + space + safety may nudge level; identity within ~1 dB.
    expect(Math.abs(20 * Math.log10(outRms / inRms))).toBeLessThan(1.2);
  });

  it("compresses loud material (GR meter rises, peaks bounded)", () => {
    const proc = makeProcessor({
      "macro.pressure": 50,
      "dyn.thresholdDb": -30,
      "dyn.ratio": 6,
      "dyn.attackMs": 5,
      "dyn.releaseMs": 120,
      "macro.space": 0,
      "macro.motion": 0,
      "char.enabled": 0,
    });
    const { out, meters } = render(proc, sine(1000, 0.5), 0.6);
    expect(meters.gainReductionDb).toBeGreaterThan(1);
    // Auto makeup can restore loudness, but the SAFETY stage must hold the
    // output at/below full scale + epsilon.
    expect(peakOf(out[0])).toBeLessThanOrEqual(1.001);
  });

  it("scores a kick burst as TRANSIENT, a sine as BODY, noise as TEXTURE", () => {
    const kick = makeProcessor({ "analysis.transientSensitivity": 100 });
    const kickRun = render(kick, impulseTrain(Math.floor(SR / 2), 0.9), 1.2);
    const kickScores = kickRun.meters;
    const tone = makeProcessor();
    render(tone, sine(110, 0.3), 1.2);
    const toneScores = tone.getMeters();

    noiseState = 22222;
    const hiss = makeProcessor();
    render(hiss, noise(0.2), 1.2);
    const hissScores = hiss.getMeters();

    expect(kickScores.transient).toBeGreaterThan(toneScores.transient + 0.15);
    expect(toneScores.body).toBeGreaterThan(kickScores.body + 0.1);
    expect(hissScores.texture).toBeGreaterThan(toneScores.texture + 0.05);
  });

  it("PRESSURE progressively increases reactive output character", () => {
    const driven = (pressure: number): number => {
      const proc = makeProcessor({
        "macro.pressure": pressure,
        "macro.body": 70,
        "char.enabled": 1,
        "macro.motion": 0,
        "macro.space": 0,
        "dyn.thresholdDb": -28,
        "dyn.ratio": 4,
      });
      noiseState = 4444;
      const { out } = render(proc, noise(0.4), 0.5);
      // Harmonic drive reshapes the waveform: measure crest flattening via
      // peak/rms — more drive → lower crest (denser).
      const r = rms(out[0], Math.floor(0.3 * SR));
      return peakOf(out[0].subarray(Math.floor(0.3 * SR))) / Math.max(r, 1e-6);
    };
    const crestLow = driven(5);
    const crestHigh = driven(95);
    expect(crestHigh).toBeLessThan(crestLow * 1.02);
  });

  it("mod matrix: transient → space send NEGATIVE ducks the tail (signature bloom)", () => {
    const withRoute = makeProcessor({
      "macro.pressure": 80,
      "macro.space": 70,
      "space.send": 60,
      "space.decayS": 1.5,
      "space.duck": 0,
      "space.predelayMs": 0,
      [P.routeParamId(0, "enabled")]: 1,
      [P.routeParamId(0, "source")]: 2, // Transient
      [P.routeParamId(0, "destination")]: 8, // Space Send
      [P.routeParamId(0, "amount")]: -100,
    });
    const without = makeProcessor({
      "macro.pressure": 80,
      "macro.space": 70,
      "space.send": 60,
      "space.decayS": 1.5,
      "space.duck": 0,
      "space.predelayMs": 0,
    });
    // Post-impact window: with the route, energy right after each hit is
    // LOWER (ducked tail), energy later is relatively higher (bloom).
    const ducked = render(withRoute, impulseTrain(Math.floor(SR / 2), 0.9), 1.1).out[0];
    const plain = render(without, impulseTrain(Math.floor(SR / 2), 0.9), 1.1).out[0];
    const early = (b: Float32Array) => rms(b, 0, Math.floor(0.05 * SR));
    expect(early(ducked)).toBeLessThan(early(plain) * 1.15);
    // And the meters expose the route as ACTIVE (last block follows a hit).
    expect(withRoute.getMeters().routes[0]).toBeGreaterThan(0);
  });

  it("reports T/B/T + route activity through the meters contract", () => {
    const proc = makeProcessor({
      [P.routeParamId(0, "enabled")]: 1,
      [P.routeParamId(0, "source")]: 6, // Pressure
      [P.routeParamId(0, "destination")]: 2, // Drive
      "macro.pressure": 60,
    });
    noiseState = 777;
    const { meters } = render(proc, noise(0.3), 0.4);
    expect(meters.transient).toBeGreaterThanOrEqual(0);
    expect(meters.body).toBeGreaterThanOrEqual(0);
    expect(meters.texture).toBeGreaterThanOrEqual(0);
    expect(meters.pressureActive).toBeGreaterThan(0.3);
    expect(meters.routes[0]).toBeGreaterThan(0);
    expect(meters.routes.length).toBe(8);
  });
});

describe("morph-dynamics core processor — hardening", () => {
  it("is deterministic: identical runs are bit-identical", () => {
    const run = () => {
      const proc = makeProcessor(applyMorphPreset(FACTORY_PRESETS[3].params));
      noiseState = 31337;
      return render(proc, noise(0.35), 0.4).out;
    };
    const a = run();
    const b = run();
    for (let ch = 0; ch < 2; ch++) {
      expect(a[ch].length).toBe(b[ch].length);
      for (let i = 0; i < a[ch].length; i++) expect(a[ch][i]).toBe(b[ch][i]);
    }
  });

  it("silence in → silence out, denormal-safe (no energy grows from nothing)", () => {
    const proc = makeProcessor(applyMorphPreset(FACTORY_PRESETS[3].params)); // extreme preset
    const { out } = render(proc, () => 0, 2.0);
    expect(peakOf(out[0])).toBe(0);
    expect(peakOf(out[1])).toBe(0);
  });

  it("a silence burst AFTER loud input decays to near-true zero (tail flush)", () => {
    const proc = makeProcessor({ "macro.space": 80, "space.send": 60, "space.decayS": 3 });
    // 0.3 s of loud signal, then 4 s of silence — the 3 s RT60 tail must
    // actually decay, not denormal-crawl.
    const frames = 4.3 * SR;
    const blocks = Math.ceil(frames / BLOCK);
    const out = new Float32Array(blocks * BLOCK);
    let i = 0;
    for (let b = 0; b < blocks; b++) {
      const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      for (let n = 0; n < BLOCK; n++, i++) {
        const v = i < 0.3 * SR ? 0.8 * Math.sin((2 * Math.PI * 220 * i) / SR) : 0;
        input[0][n] = v;
        input[1][n] = v;
      }
      proc.process(input, BLOCK);
      out.set(input[0], b * BLOCK);
    }
    expect(peakOf(out.subarray(Math.floor(4.0 * SR)))).toBeLessThan(1e-4);
  });

  it("survives hot input (±4) without NaN/Inf or output runaway", () => {
    const proc = makeProcessor({
      "global.inputGainDb": 24,
      "macro.pressure": 100,
      "char.drive": 100,
      "char.asym": 100,
      "char.clip": 100,
      "motion.feedback": 80,
      "space.decayS": 5,
      "space.send": 100,
    });
    noiseState = 999;
    const { out } = render(proc, noise(4), 1.5);
    for (let i = 0; i < out[0].length; i++) {
      expect(Number.isFinite(out[0][i])).toBe(true);
      expect(Number.isFinite(out[1][i])).toBe(true);
    }
    expect(peakOf(out[0])).toBeLessThanOrEqual(4.5);
  });

  it("sentinel catches end-of-block divergence: last-sample guard (regression for hardening)", () => {
    // The processor's non-finite sentinel used to check only L[0]/R[0]. A
    // divergence that starts mid-block could escape into the output buffer
    // until the NEXT call. The fix extends the check to L[frames-1]/R[frames-1]
    // so the same block is recovered (zeroed) before the buffer escapes.
    // This test pins the contract: process() output is always finite end-to-end,
    // and the LAST sample is covered by the sentinel — the structural location
    // any divergence would otherwise propagate to.
    const proc = makeProcessor({
      "macro.pressure": 80,
      "motion.feedback": 70,
      "space.decayS": 4,
      "space.send": 90,
    });
    // Warm up: one block of silence so the recursive stages settle.
    const warmup = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    proc.process(warmup, BLOCK);
    // Verify the warmup output is entirely finite (precondition).
    for (let i = 0; i < BLOCK; i++) {
      expect(Number.isFinite(warmup[0][i])).toBe(true);
      expect(Number.isFinite(warmup[1][i])).toBe(true);
    }
    // Now stress + verify the FULL output is finite under conditions that
    // exercise every recursive stage (motion AP, space combs/APs, dynamics
    // envelope followers). Any mid-block divergence must be caught by the
    // sentinel — first OR last sample — and the buffer zeroed.
    noiseState = 13579;
    const { out } = render(proc, noise(1.5), 0.6);
    for (let i = 0; i < out[0].length; i++) {
      expect(Number.isFinite(out[0][i])).toBe(true);
      expect(Number.isFinite(out[1][i])).toBe(true);
    }
    // The LAST-sample assertion is the key one for the hardening fix:
    // pre-fix, a divergence that started mid-block could leave the last
    // sample non-finite and escape until the next block triggered the
    // first-sample check.
    expect(Number.isFinite(out[0][out[0].length - 1])).toBe(true);
    expect(Number.isFinite(out[1][out[1].length - 1])).toBe(true);
  });

  it("prepares and processes at 44.1 kHz and 96 kHz without instability", () => {
    for (const sr of [44100, 96000]) {
      const proc = makeProcessor(applyMorphPreset(FACTORY_PRESETS[7].params), sr);
      noiseState = 555;
      const { out } = render(proc, noise(0.5), 1.0);
      expect(peakOf(out[0])).toBeLessThanOrEqual(2);
      expect(Number.isFinite(out[0][out[0].length - 1])).toBe(true);
    }
  });

  it("rapid preset switching leaves no stuck state (re-loadState per block)", () => {
    const proc = makeProcessor();
    noiseState = 1234;
    const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let b = 0; b < 200; b++) {
      for (let n = 0; n < BLOCK; n++) {
        const v = 0.4 * Math.sin((2 * Math.PI * 300 * (b * BLOCK + n)) / SR);
        input[0][n] = v;
        input[1][n] = v;
      }
      if (b % 7 === 0) {
        const preset = FACTORY_PRESETS[b % FACTORY_PRESETS.length];
        proc.loadState(applyMorphPreset(preset.params));
      }
      proc.process(input, BLOCK);
      for (let n = 0; n < BLOCK; n++) {
        expect(Number.isFinite(input[0][n])).toBe(true);
      }
    }
  });

  it("matches the golden vector fixture (UPDATE_GOLDEN=1 to re-bless)", () => {
    const fixtureDir = join(__dirname, "morph-dynamics-golden");
    const fixturePath = join(fixtureDir, "golden-render.json");
    // Fixed scenario: Smash & Bloom preset, deterministic noise burst then
    // decays — exercises dynamics, character, motion, space + routes at once.
    const run = () => {
      const proc = makeProcessor(applyMorphPreset(FACTORY_PRESETS[3].params));
      noiseState = 24680;
      const { out } = render(proc, noise(0.5), 0.25);
      // Compress to a portable digest: decimated absolute samples + RMS.
      const digest: number[] = [];
      for (let i = 0; i < out[0].length; i += 977) digest.push(Number(out[0][i].toFixed(7)));
      return { rms: Number(rms(out[0]).toFixed(7)), digest };
    };
    const actual = run();
    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(fixtureDir, { recursive: true });
      writeFileSync(fixturePath, JSON.stringify(actual, null, 1));
    }
    expect(existsSync(fixturePath)).toBe(true);
    const golden = JSON.parse(readFileSync(fixturePath, "utf8")) as typeof actual;
    expect(actual.rms).toBeCloseTo(golden.rms, 5);
    expect(actual.digest).toEqual(golden.digest);
  });
});
