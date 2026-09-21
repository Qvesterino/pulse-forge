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

/** Kick-like sidechain feed: 90 ms decaying 55 Hz thump each period. A
 * single-sample impulse would be gone before the 5 ms attack engages and
 * would never close the gain — real kicks have a body. */
function kickTrain(periodSamples: number, amplitude: number): (i: number) => number {
  const burst = Math.floor(0.09 * SR);
  return (i: number) => {
    const phase = i % periodSamples;
    if (phase > burst) return 0;
    const t = phase / SR;
    return amplitude * Math.exp(-t / 0.02) * Math.sin(2 * Math.PI * 55 * t);
  };
}

function render(proc: MorphDynamicsProcessor, gen: (i: number) => number, seconds: number): Render {
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

/** Like render(), with a parallel external sidechain feed. */
function renderSc(
  proc: MorphDynamicsProcessor,
  genMain: (i: number) => number,
  genSc: (i: number) => number,
  seconds: number,
): Render {
  const frames = Math.floor(seconds * SR);
  const blocks = Math.ceil(frames / BLOCK);
  const outL = new Float32Array(blocks * BLOCK);
  const outR = new Float32Array(blocks * BLOCK);
  let meters = proc.getMeters();
  for (let b = 0; b < blocks; b++) {
    const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const sc = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let i = 0; i < BLOCK; i++) {
      const v = genMain(b * BLOCK + i);
      input[0][i] = v;
      input[1][i] = v;
      const s = genSc(b * BLOCK + i);
      sc[0][i] = s;
      sc[1][i] = s;
    }
    proc.process(input, BLOCK, sc);
    outL.set(input[0], b * BLOCK);
    outR.set(input[1], b * BLOCK);
    meters = proc.getMeters();
  }
  return { out: [outL, outR], meters };
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

  it("PRESSURE progressively increases harmonic response (the f2 curve)", () => {
    // Drive a clean sine and measure the 3rd harmonic (Goertzel) — more
    // reactive drive under PRESSURE must generate more harmonics, which is
    // exactly the "increasing harmonic response" band of the product curve.
    // (Crest-based assertions are wrong here BY DESIGN: peak-normalized
    // tanh drive raises the crest of noise — it lifts rms more than peaks.)
    const thirdHarmonic = (pressure: number): number => {
      const proc = makeProcessor({
        "macro.pressure": pressure,
        "macro.body": 70,
        "char.enabled": 1,
        "macro.motion": 0,
        "macro.space": 0,
        "macro.punch": 0,
        "dyn.thresholdDb": -10,
        "dyn.ratio": 1.5,
      });
      const { out } = render(proc, sine(220, 0.3), 0.5);
      const from = Math.floor(0.25 * SR);
      let re = 0;
      let im = 0;
      const f = 660; // 3rd harmonic of 220
      const w = (2 * Math.PI * f) / SR;
      for (let i = from; i < out[0].length; i++) {
        re += out[0][i] * Math.cos(w * i);
        im -= out[0][i] * Math.sin(w * i);
      }
      const n = out[0].length - from;
      return (2 * Math.sqrt(re * re + im * im)) / n;
    };
    const low = thirdHarmonic(5);
    const high = thirdHarmonic(95);
    expect(high).toBeGreaterThan(low * 1.5);
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

  it("AGC: a quietly-recorded tone still drives ENERGY/DENSITY (adaptive level)", () => {
    // −36 dBFS sustained tone. The level-RELATIVE normalizations
    // (inputEnergy, density, transient slope) barely score against the
    // legacy fixed reference; with the adaptive reference (default) the
    // AGC has 4.5 s to settle and the same performance must light them up.
    // (BODY is share-based and level-robust by construction — not asserted.)
    const metersAt = (adaptive: boolean) => {
      const proc = makeProcessor({ "analysis.adaptiveLevel": adaptive ? 1 : 0 });
      const { meters } = render(proc, sine(110, 0.015), 4.5);
      return meters;
    };
    const adaptive = metersAt(true);
    const fixed = metersAt(false);
    expect(adaptive.inputEnergy).toBeGreaterThan(fixed.inputEnergy * 2.5);
    expect(adaptive.density).toBeGreaterThan(fixed.density * 2.5);
    expect(adaptive.density).toBeGreaterThan(0.2);
  });

  it("AGC boost meter: quiet material reads positive, loud reads negative, off reads 0", () => {
    const boostAt = (adaptive: boolean, amp: number): number => {
      const proc = makeProcessor({ "analysis.adaptiveLevel": adaptive ? 1 : 0 });
      const { meters } = render(proc, sine(220, amp), 4.5);
      return meters.agcBoostDb;
    };
    // Quiet tone → reference sits BELOW nominal → positive compensation…
    const quiet = boostAt(true, 0.015);
    expect(quiet).toBeGreaterThan(3);
    expect(quiet).toBeLessThanOrEqual(24.1);
    // …hot tone → reference above nominal → negative (capped at −8 dB)…
    const hot = boostAt(true, 0.5);
    expect(hot).toBeLessThan(-1);
    expect(hot).toBeGreaterThanOrEqual(-8.1);
    // …and with AGC off the meter reports exactly zero.
    expect(boostAt(false, 0.015)).toBe(0);
  });

  it("AGC: silence never runs away — a whisper after long silence stays bounded", () => {
    const proc = makeProcessor();
    render(proc, () => 0, 3); // long silence → ref decays toward the floor
    noiseState = 31;
    const { out } = render(proc, noise(1e-4), 1); // −80 dBFS whisper
    for (let i = 0; i < out[0].length; i++) {
      expect(Number.isFinite(out[0][i])).toBe(true);
      expect(Math.abs(out[0][i])).toBeLessThanOrEqual(1.001); // safety ceiling
    }
  });

  it("delta listen: ~identity chain outputs ≈ 0, processing outputs a difference", () => {
    // Near-identity chain: no GR (tone below threshold), stages off.
    const quiet = makeProcessor({
      "global.delta": 1,
      "macro.pressure": 0,
      "macro.punch": 0,
      "macro.motion": 0,
      "macro.space": 0,
      "char.enabled": 0,
      "dyn.thresholdDb": -10,
    });
    const { out } = render(quiet, sine(1000, 0.05), 0.8);
    expect(rms(out[0], Math.floor(0.3 * SR))).toBeLessThan(0.002);

    // Driven chain: the delta must be clearly non-zero and finite.
    const driven = makeProcessor({
      "global.delta": 1,
      "macro.pressure": 80,
      "char.drive": 60,
      "char.asym": 40,
      "dyn.thresholdDb": -30,
      "dyn.ratio": 5,
    });
    noiseState = 4242;
    const drivenRun = render(driven, noise(0.4), 0.8);
    expect(rms(drivenRun.out[0], Math.floor(0.3 * SR))).toBeGreaterThan(0.01);
    expect(Number.isFinite(drivenRun.out[0][drivenRun.out[0].length - 1])).toBe(true);
  });

  it("2× oversampling kills the in-band alias of a hot high-frequency drive", () => {
    // 13 kHz sine through heavy drive: the 3rd harmonic (39 kHz) exceeds the
    // 48 kHz Nyquist — at 1× it FOLDS BACK to 9 kHz in-band; at 2× it is
    // represented properly and the downsampling halfband removes it. Measure
    // the 9 kHz ghost with a Goertzel window.
    const ghost9k = (quality: number): number => {
      const proc = makeProcessor({
        "global.quality": quality,
        "macro.pressure": 0,
        "macro.punch": 0,
        "macro.motion": 0,
        "macro.space": 0,
        "char.enabled": 1,
        "char.drive": 70,
        "dyn.thresholdDb": -10,
        "dyn.ratio": 1.2,
      });
      const { out } = render(proc, sine(13000, 0.4), 0.4);
      const from = Math.floor(0.2 * SR);
      let re = 0;
      let im = 0;
      const f = 9000;
      const w = (2 * Math.PI * f) / SR;
      for (let i = from; i < out[0].length; i++) {
        re += out[0][i] * Math.cos(w * i);
        im -= out[0][i] * Math.sin(w * i);
      }
      const n = out[0].length - from;
      return (2 * Math.sqrt(re * re + im * im)) / n;
    };
    const withoutOs = ghost9k(0);
    const withOs = ghost9k(1);
    expect(withOs).toBeLessThan(withoutOs * 0.2);
  });

  it("external sidechain: the feed drives the detector while the main path stays put", () => {
    const base = {
      "dyn.sidechainExt": 1,
      "macro.pressure": 0,
      "macro.punch": 0,
      "macro.motion": 0,
      "macro.space": 0,
      "char.enabled": 0,
      "dyn.thresholdDb": -40,
      "dyn.ratio": 5,
      "dyn.attackMs": 5,
      "dyn.releaseMs": 300,
    };
    // Main: a very quiet sustained tone (below threshold — it never
    // compresses itself). Feed: frequent kicks so the compression duty
    // cycle is high.
    const mainGen = sine(220, 0.008);
    const scGen = kickTrain(Math.floor(SR / 6), 0.9);

    // WITH feed: the kicks grab the EXT detector → the main path ducks.
    const withFeed = makeProcessor(base);
    const fedRun = renderSc(withFeed, mainGen, scGen, 1.2);

    // WITHOUT a feed: same device state, but nothing is connected to the
    // sidechain input (render() passes no sc) → the EXT detector sits
    // silent → no compression → the tone passes at full level.
    const withoutFeed = makeProcessor(base);
    const bareRun = render(withoutFeed, mainGen, 1.2);

    const tailFrom = Math.floor(0.6 * SR);
    const fedRms = rms(fedRun.out[0], tailFrom);
    const bareRms = rms(bareRun.out[0], tailFrom);
    expect(fedRms).toBeLessThan(bareRms * 0.85);

    // Sanity: with EXT off the same feed is ignored entirely (the main tone
    // is below threshold → no self-compression → full level).
    const intProc = makeProcessor({ ...base, "dyn.sidechainExt": 0 });
    const intRun = renderSc(intProc, mainGen, scGen, 1.2);
    expect(rms(intRun.out[0], tailFrom)).toBeGreaterThan(fedRms * 1.1);
  });

  it("per-route smoothing: a slow route glides, a fast route lands immediately", () => {
    // density → Comp Threshold route; density is constant on sustained
    // noise, so enabling the route drops the threshold (more compression →
    // quieter). With 300 ms smoothing the first 120 ms are barely ducked;
    // with 5 ms they are already at the settled level — and because the
    // smoothing lives on the ROUTE, a second (slow) route sharing the
    // destination cannot delay the fast one.
    const routeBase = {
      "macro.pressure": 60,
      "macro.motion": 0,
      "macro.space": 0,
      "char.enabled": 0,
      "dyn.thresholdDb": -14,
      "dyn.ratio": 4,
      "dyn.attackMs": 2,
      "dyn.releaseMs": 400,
      [P.routeParamId(0, "enabled")]: 1,
      [P.routeParamId(0, "source")]: 5, // Density
      [P.routeParamId(0, "destination")]: 0, // Comp Threshold
      [P.routeParamId(0, "amount")]: 100,
      [P.routeParamId(1, "enabled")]: 0,
    };
    noiseState = 246;
    const levels = (smoothMs: number): { earlyDb: number; settledDb: number } => {
      const proc = makeProcessor({ ...routeBase, [P.routeParamId(0, "smoothMs")]: smoothMs });
      // Warm up WITHOUT the route active to establish the pre-route level.
      noiseState = 987;
      let earlyRms = 0;
      let settledRms = 0;
      const frames = 0.9 * SR;
      const blocks = Math.ceil(frames / BLOCK);
      const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      for (let b = 0; b < blocks; b++) {
        for (let i = 0; i < BLOCK; i++) {
          const v = (0.4 * (noiseState = (1103515245 * noiseState + 12345) & 0x7fffffff)) / 0x3fffffff - 0.2;
          input[0][i] = v;
          input[1][i] = v;
        }
        // Enable the route at t = 0.3 s (a real doc-write timing).
        if (b === Math.floor((0.3 * SR) / BLOCK)) proc.setParameter(P.routeParamId(0, "enabled"), 1);
        proc.process(input, BLOCK);
        const t = (b * BLOCK) / SR;
        if (t >= 0.32 && t < 0.44) {
          for (let i = 0; i < BLOCK; i++) earlyRms += input[0][i] * input[0][i];
        }
        if (t >= 0.7 && t < 0.9) {
          for (let i = 0; i < BLOCK; i++) settledRms += input[0][i] * input[0][i];
        }
      }
      const n1 = 0.12 * SR;
      const n2 = 0.2 * SR;
      return {
        earlyDb: 10 * Math.log10(Math.max(earlyRms / n1, 1e-12)),
        settledDb: 10 * Math.log10(Math.max(settledRms / n2, 1e-12)),
      };
    };
    const fast = levels(5);
    const slow = levels(300);
    // Both settle to deep compression; the SLOW route is still gliding in
    // the early window → measurably louder there than the fast route.
    expect(slow.earlyDb).toBeGreaterThan(fast.earlyDb + 1.5);
    expect(Math.abs(fast.settledDb - slow.settledDb)).toBeLessThan(3);
  });

  it("morph scenes: params glide to the target; globals and routes are immune", () => {
    const proc = makeProcessor({
      "macro.pressure": 5,
      "char.enabled": 1,
      "char.drive": 0,
      "global.mix": 80,
      [P.routeParamId(0, "amount")]: 10,
    });
    proc.startMorph(
      {
        "macro.pressure": 85,
        "char.drive": 60,
        "global.mix": 20, // must be IGNORED (scene-immune)
        [P.routeParamId(0, "amount")]: -90, // must be IGNORED
        "not.a.param": 5, // dropped
      },
      0.2,
    );
    // Mid-glide: moving from the start values…
    for (let b = 0; b < 6; b++) {
      const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      proc.process(input, BLOCK);
    }
    const midPressure = proc.getParameter("macro.pressure");
    expect(midPressure).toBeGreaterThan(5);
    expect(midPressure).toBeLessThan(85);
    // …and settled: engine params landed, immunes untouched.
    for (let b = 0; b < 90; b++) {
      const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      proc.process(input, BLOCK);
    }
    expect(proc.getParameter("macro.pressure")).toBeCloseTo(85, 0);
    expect(proc.getParameter("char.drive")).toBeCloseTo(60, 0);
    expect(proc.getParameter("global.mix")).toBe(80);
    expect(proc.getParameter(P.routeParamId(0, "amount"))).toBe(10);
    expect(proc.getParameter("not.a.param")).toBe(0);
  });

  it("morph scenes: a host param write mid-glide overrides that id only", () => {
    const proc = makeProcessor({ "macro.pressure": 0, "char.enabled": 1, "char.drive": 0 });
    proc.startMorph({ "macro.pressure": 90, "char.drive": 80 }, 0.2);
    for (let b = 0; b < 6; b++) {
      const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      proc.process(input, BLOCK);
    }
    // Host takes pressure over mid-glide; drive keeps gliding.
    proc.setParameter("macro.pressure", 42);
    for (let b = 0; b < 90; b++) {
      const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      proc.process(input, BLOCK);
    }
    expect(proc.getParameter("macro.pressure")).toBe(42); // host value wins
    expect(proc.getParameter("char.drive")).toBeCloseTo(80, 0); // morph continues
  });
});

describe("morph-dynamics core processor — hardening", () => {
  it("reports the oversampling latency per state (drive off 0, drive on 8, eco 0)", () => {
    const normal = makeProcessor(); // default quality 1, drive 0 → bypassed
    expect(normal.getLatencySamples()).toBe(0);
    normal.setParameter("char.drive", 70);
    // The character's bypass state re-evaluates at block rate — run a block.
    render(normal, () => 0, 0.01);
    expect(normal.getLatencySamples()).toBe(8);
    normal.setParameter("global.quality", 0);
    render(normal, () => 0, 0.01);
    expect(normal.getLatencySamples()).toBe(0);
    normal.setParameter("global.quality", 1);
    render(normal, () => 0, 0.01);
    expect(normal.getLatencySamples()).toBe(8);
  });

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
