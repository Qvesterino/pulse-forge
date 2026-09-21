/**
 * MORPH DYNAMICS — BODY Harmonizer (Experiment #1) tests.
 *
 * Drives the typed core processor DIRECTLY (same convention as
 * morph-dynamics-golden.test.ts): deterministic signals, prepare() +
 * process() per block. Covers the experiment contract: schema bounds,
 * bit-exact bypass when disabled, Harmony Mix = 0 behavior, voice
 * enable/interval/detune/pan handling, pitch content, the BODY-vs-FULL
 * A/B claim (transient material stays clean in BODY mode), the
 * BODY → Harmony Mix modulation route (Harmonic Bloom hook), gain safety,
 * silence/NaN hardening, serialization, latency reporting and sample-rate
 * robustness.
 */
import { describe, expect, it } from "vitest";

import { MorphDynamicsProcessor } from "../src/effects/morph-dynamics-core/dsp/morphDynamicsProcessor";
import { BodyHarmonizer, HARM_VOICE_COUNT } from "../src/effects/morph-dynamics-core/dsp/harmony";
import {
  buildDefaultParams,
  clampParam,
  PARAM_BY_ID,
} from "../src/effects/morph-dynamics-core/contracts/parameterSchema";
import * as P from "../src/effects/morph-dynamics-core/contracts/parameterIds";
import { DEST_INDEX, MOD_SOURCES, SOURCE_INDEX } from "../src/effects/morph-dynamics-core/contracts/modulation";

const SR = 48000;
const BLOCK = 128;

/** Default state with overrides (applyMorphPreset semantics minus presets). */
function state(overrides: Record<string, number>): Record<string, number> {
  return { ...buildDefaultParams(), ...overrides };
}

function makeProcessor(params?: Record<string, number>, sampleRate = SR): MorphDynamicsProcessor {
  const proc = new MorphDynamicsProcessor();
  proc.prepare(sampleRate, 2, BLOCK, 1);
  proc.loadState(params ?? buildDefaultParams());
  return proc;
}

type Source = (i: number) => number;

function sine(freq: number, amplitude: number, sampleRate = SR): Source {
  return (i: number) => amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
}

let noiseState = 777;
function noise(amplitude: number): Source {
  // Deterministic LCG (no Math.random — tests must be reproducible). The
  // state RESETS per generator instance: two renders of the same scenario
  // must hear the SAME noise, or an A-vs-B "difference" would just measure
  // two uncorrelated signals (found by the BODY-vs-FULL comparison).
  noiseState = 777;
  return () => {
    noiseState = (1103515245 * noiseState + 12345) & 0x7fffffff;
    return amplitude * (noiseState / 0x3fffffff - 1);
  };
}

/** Broadband click train: 3 ms noise bursts every 0.25 s — pure transient
 * material (the experiment's drum-loop stress case, concentrated). */
function clickTrain(amplitude: number, sampleRate = SR): Source {
  const burstLen = Math.round(0.003 * sampleRate);
  const period = Math.round(0.25 * sampleRate);
  const gen = noise(amplitude);
  return (i: number) => (i % period < burstLen ? gen(i) : 0);
}

function render(
  proc: MorphDynamicsProcessor,
  source: Source,
  seconds: number,
  sampleRate = SR,
): [Float32Array, Float32Array] {
  const total = Math.round(seconds * sampleRate);
  const outL = new Float32Array(total);
  const outR = new Float32Array(total);
  const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  let n = 0;
  while (n < total) {
    const frames = Math.min(BLOCK, total - n);
    for (let i = 0; i < frames; i++) {
      const v = source(n + i);
      input[0][i] = v;
      input[1][i] = v; // mono material on both channels
    }
    proc.process(input, frames);
    for (let i = 0; i < frames; i++) {
      outL[n + i] = input[0][i];
      outR[n + i] = input[1][i];
    }
    n += frames;
  }
  return [outL, outR];
}

function rmsOf(x: Float32Array, from = 0, to = x.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

function peakOf(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

function maxAbsDiff(a: Float32Array, b: Float32Array, from = 0, to = a.length): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** Hysteretic zero-crossing frequency estimate (skips crossings below the
 * noise floor so grain artifact jitter does not inflate the count). */
function zeroCrossFreq(x: Float32Array, threshold = 0.02, sampleRate = SR): number {
  let crossings = 0;
  let sign = 0;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) < threshold) continue;
    const s = x[i] > 0 ? 1 : -1;
    if (sign !== 0 && s !== sign) crossings++;
    sign = s;
  }
  return crossings / 2 / (x.length / sampleRate);
}

/** Harmony-only content: output minus the identical render with the module
 * disabled (everything else identical → the difference IS the harmony).
 * Sources are FACTORIES: each arm must render from a freshly-reset source,
 * never a shared closure whose RNG state advanced during the first arm. */
function harmonyDifference(params: Record<string, number>, makeSource: () => Source, seconds: number) {
  const wet = makeProcessor(state({ ...params, [P.HARM_ENABLED_ID]: 1 }));
  const dry = makeProcessor(state({ ...params, [P.HARM_ENABLED_ID]: 0 }));
  const [wl, wr] = render(wet, makeSource(), seconds);
  const [dl, dr] = render(dry, makeSource(), seconds);
  const diffL = new Float32Array(wl.length);
  const diffR = new Float32Array(wl.length);
  for (let i = 0; i < wl.length; i++) {
    diffL[i] = wl[i] - dl[i];
    diffR[i] = wr[i] - dr[i];
  }
  return { diffL, diffR };
}

/** Standard sustained configuration: module on, voice A +7 st, mix wide. */
const SUSTAINED: Record<string, number> = {
  [P.HARM_ENABLED_ID]: 1,
  [P.HARM_MIX_ID]: 100,
  [P.HARM_BODY_AMOUNT_ID]: 100,
  [P.harmVoiceParamId(0, "on")]: 1,
  [P.harmVoiceParamId(0, "interval")]: 7,
  [P.harmVoiceParamId(0, "level")]: 100,
};

describe("morph-dynamics harmony schema", () => {
  it("defines harm.* params with the experiment's ranges and defaults", () => {
    const enabled = PARAM_BY_ID.get(P.HARM_ENABLED_ID)!;
    expect(enabled.defaultValue).toBe(0); // OFF by default — no silent behavior change
    expect(enabled.automatable).toBe(false);

    const bodyAmount = PARAM_BY_ID.get(P.HARM_BODY_AMOUNT_ID)!;
    expect([bodyAmount.minValue, bodyAmount.maxValue]).toEqual([0, 100]);
    expect(bodyAmount.defaultValue).toBe(100); // dry untouched by default

    const mix = PARAM_BY_ID.get(P.HARM_MIX_ID)!;
    expect([mix.minValue, mix.maxValue]).toEqual([0, 100]);
    expect(mix.automatable).toBe(true); // mod destination (Harmonic Bloom)

    expect(PARAM_BY_ID.get(P.HARM_DEV_FULL_SIGNAL_ID)).toBeDefined();

    for (let v = 0; v < HARM_VOICE_COUNT; v++) {
      const interval = PARAM_BY_ID.get(P.harmVoiceParamId(v, "interval"))!;
      expect([interval.minValue, interval.maxValue]).toEqual([-24, 24]);
      const level = PARAM_BY_ID.get(P.harmVoiceParamId(v, "level"))!;
      expect([level.minValue, level.maxValue]).toEqual([0, 150]);
      const pan = PARAM_BY_ID.get(P.harmVoiceParamId(v, "pan"))!;
      expect([pan.minValue, pan.maxValue]).toEqual([-100, 100]);
      const detune = PARAM_BY_ID.get(P.harmVoiceParamId(v, "detune"))!;
      expect([detune.minValue, detune.maxValue]).toEqual([-50, 50]);
      // Only voice A ships enabled.
      expect(PARAM_BY_ID.get(P.harmVoiceParamId(v, "on"))!.defaultValue).toBe(v === 0 ? 1 : 0);
    }
    expect(clampParam(P.harmVoiceParamId(0, "interval"), 99)).toBe(24);
    expect(clampParam(P.harmVoiceParamId(0, "detune"), NaN)).toBe(0);
  });

  it("rejects out-of-bounds voice slots in the id helper", () => {
    expect(P.isHarmVoiceParamId("harm.voice.0.interval")).toBe(true);
    expect(P.isHarmVoiceParamId("harm.voice.3.detune")).toBe(true);
    expect(P.isHarmVoiceParamId("harm.voice.4.interval")).toBe(false);
    expect(P.isHarmVoiceParamId("harm.voice.x.interval")).toBe(false);
    expect(P.isHarmVoiceParamId("harm.enabled")).toBe(false);
  });
});

describe("morph-dynamics harmony bypass", () => {
  it("is bit-exact when disabled — harm.* values are ignored entirely", () => {
    const src = sine(220, 0.5);
    const plain = makeProcessor();
    const [pl, pr] = render(plain, src, 0.5);
    const touched = makeProcessor(
      state({
        [P.HARM_BODY_AMOUNT_ID]: 5,
        [P.HARM_MIX_ID]: 90,
        [P.HARM_DEV_FULL_SIGNAL_ID]: 1,
        [P.harmVoiceParamId(0, "interval")]: -12,
        [P.harmVoiceParamId(1, "on")]: 1,
        [P.harmVoiceParamId(2, "level")]: 150,
        [P.harmVoiceParamId(3, "pan")]: -100,
      }),
    );
    const [tl, tr] = render(touched, src, 0.5);
    expect(maxAbsDiff(pl, tl)).toBe(0);
    expect(maxAbsDiff(pr, tr)).toBe(0);
  });

  it("adds no latency to the reported chain latency", () => {
    const off = makeProcessor();
    const on = makeProcessor(state(SUSTAINED));
    // Warm both up (latency is static, but prove it survives processing).
    render(off, sine(220, 0.5), 0.2);
    render(on, sine(220, 0.5), 0.2);
    expect(on.getLatencySamples()).toBe(off.getLatencySamples());
    expect(on.getLatencySamples()).toBeGreaterThan(0); // character halfband still reported
  });
});

describe("morph-dynamics harmony recombination", () => {
  it("with Harmony Mix = 0 the output returns to the dry chain after settle", () => {
    const src = sine(220, 0.5);
    const wet = makeProcessor(state({ ...SUSTAINED, [P.HARM_MIX_ID]: 0 }));
    const dry = makeProcessor();
    const [wl, wr] = render(wet, src, 2.0);
    const [dl, dr] = render(dry, src, 2.0);
    // Skip the first second (bus smoother glide), compare the steady state.
    const from = Math.round(1.0 * SR);
    expect(maxAbsDiff(wl, dl, from)).toBeLessThan(1e-6);
    expect(maxAbsDiff(wr, dr, from)).toBeLessThan(1e-6);
  });

  it("shifts sustained tonal material by the voice interval (+7 st)", () => {
    const { diffL } = harmonyDifference(SUSTAINED, () => sine(220, 0.5), 1.5);
    // Harmony-only content measured over the settled second half.
    const from = Math.round(0.75 * SR);
    const tail = diffL.slice(from);
    expect(rmsOf(tail)).toBeGreaterThan(0.01);
    const expected = 220 * Math.pow(2, 7 / 12); // ≈ 329 Hz
    const measured = zeroCrossFreq(tail);
    expect(Math.abs(measured - expected) / expected).toBeLessThan(0.2);
  });

  it("keeps panned harmony out of the opposite channel (dry stays stereo)", () => {
    const params = { ...SUSTAINED, [P.harmVoiceParamId(0, "pan")]: -100 };
    const { diffL, diffR } = harmonyDifference(params, () => sine(220, 0.5), 1.0);
    const from = Math.round(0.5 * SR);
    expect(rmsOf(diffL, from)).toBeGreaterThan(0.01);
    // The add point sits BEFORE the space stage, whose width processing
    // (M/S) legitimately leaks a little of a hard-panned add into R — but
    // the harmony must remain overwhelmingly in the panned channel.
    expect(rmsOf(diffR, from)).toBeLessThan(rmsOf(diffL, from) * 0.35);
  });

  it("voice enable/disable and interval changes stay finite and bounded", () => {
    const proc = makeProcessor(
      state({
        ...SUSTAINED,
        [P.harmVoiceParamId(1, "on")]: 1,
        [P.harmVoiceParamId(1, "interval")]: -5,
      }),
    );
    let n = 0;
    const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    let prevL = 0;
    let maxStep = 0;
    for (let b = 0; b < 400; b++) {
      for (let i = 0; i < BLOCK; i++, n++) {
        const v = 0.5 * Math.sin((2 * Math.PI * 220 * n) / SR);
        input[0][i] = v;
        input[1][i] = v;
      }
      // Flip voice B and sweep voice A's interval mid-stream.
      if (b === 100) proc.setParameter(P.harmVoiceParamId(1, "on"), 0);
      if (b === 200) proc.setParameter(P.harmVoiceParamId(0, "interval"), 12);
      if (b === 300) proc.setParameter(P.harmVoiceParamId(1, "on"), 1);
      proc.process(input, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(input[0][i])).toBe(true);
        maxStep = Math.max(maxStep, Math.abs(input[0][i] - prevL));
        prevL = input[0][i];
      }
    }
    // Click-free parameter handling: no single-sample step above the audio
    // band's plausible slew for a 0.5 sine (grain fades smooth the rest).
    expect(maxStep).toBeLessThan(0.35);
  });

  it("determines identical output for identical input (offline parity)", () => {
    const src = sine(220, 0.5);
    const a = makeProcessor(state(SUSTAINED));
    const b = makeProcessor(state(SUSTAINED));
    const [al] = render(a, src, 0.5);
    const [bl] = render(b, src, 0.5);
    expect(maxAbsDiff(al, bl)).toBe(0);
  });
});

describe("morph-dynamics harmony: the experiment's sonic claim", () => {
  it("BODY mode keeps transient material far cleaner than FULL-signal mode", () => {
    const base = {
      [P.HARM_MIX_ID]: 100,
      [P.harmVoiceParamId(0, "on")]: 1,
      [P.harmVoiceParamId(0, "interval")]: 7,
      [P.harmVoiceParamId(0, "level")]: 100,
    };
    const body = harmonyDifference({ ...base, [P.HARM_BODY_AMOUNT_ID]: 100 }, () => clickTrain(0.8), 1.2);
    const full = harmonyDifference({ ...base, [P.HARM_DEV_FULL_SIGNAL_ID]: 1 }, () => clickTrain(0.8), 1.2);
    // Same voice config, same material: harmonizing ONLY the body leaves
    // the clicks (almost) untouched while full-signal shifting smears them.
    const bodyRms = rmsOf(body.diffL);
    const fullRms = rmsOf(full.diffL);
    expect(fullRms).toBeGreaterThan(0.005); // the FULL arm actually shifts
    expect(bodyRms).toBeLessThan(fullRms * 0.7);
  });

  it("sustained tone opens the mask; a quiet click over it never feeds the grains", () => {
    const FULL_VOICES = [
      { enabled: true, interval: 7, detune: 0, level: 1, pan: 0 },
      { enabled: false, interval: -5, detune: 0, level: 0.7, pan: 0.25 },
      { enabled: false, interval: 12, detune: 0, level: 0.6, pan: -0.6 },
      { enabled: false, interval: -12, detune: 0, level: 0.6, pan: 0.6 },
    ];
    const makeHarm = (fullSignal: boolean) => {
      const harm = new BodyHarmonizer();
      harm.prepare(SR);
      harm.setParams({
        enabled: true,
        bodyAmount: 1,
        mix: 1,
        fullSignal,
        spread: 1,
        width: 1,
        diffusion: 0,
        space: 0,
        voices: FULL_VOICES,
      });
      return harm;
    };
    // Three arms: RING = tone then silence (the grain engine's natural
    // decay), BODY = tone then a quiet click (consonant after a vowel),
    // FULL = same with the naive full-signal switch. The click's own
    // contribution per arm = sqrt(rms² − ringRms²).
    const ring = makeHarm(false);
    const body = makeHarm(false);
    const full = makeHarm(true);
    const oRing = { l: 0, r: 0, dry: 1 };
    const oBody = { l: 0, r: 0, dry: 1 };
    const oFull = { l: 0, r: 0, dry: 1 };
    const clickLen = Math.round(SR * 0.003);
    const runLen = Math.round(SR * 0.52);
    const clickAt = Math.round(SR * 0.5);
    let maskAtSustain = 0;
    let ringRms = 0;
    let bodyRms = 0;
    let fullRms = 0;
    let count = 0;
    for (let i = 0; i < runLen; i++) {
      const sineV = 0.45 * Math.sin((2 * Math.PI * 220 * i) / SR);
      const clickV = i >= clickAt && i < clickAt + clickLen ? 0.3 * ((i % 7) * 0.12 - 0.4) : 0;
      ring.processFrame(sineV, sineV, oRing);
      body.processFrame(clickV === 0 ? sineV : clickV, clickV === 0 ? sineV : clickV, oBody);
      full.processFrame(clickV === 0 ? sineV : clickV, clickV === 0 ? sineV : clickV, oFull);
      if (i === clickAt - 1) maskAtSustain = body.getMask();
      if (i >= clickAt && i < clickAt + Math.round(SR * 0.02)) {
        ringRms += oRing.l * oRing.l;
        bodyRms += oBody.l * oBody.l;
        fullRms += oFull.l * oFull.l;
        count++;
      }
    }
    // The sustained tone right before the click IS body — the mask is open
    // for it (this is the material the harmony is FOR).
    expect(maskAtSustain).toBeGreaterThan(0.5);
    const ringRmsVal = Math.sqrt(ringRms / count);
    const extraBody = Math.sqrt(Math.max(0, bodyRms / count - ringRmsVal * ringRmsVal));
    const extraFull = Math.sqrt(Math.max(0, fullRms / count - ringRmsVal * ringRmsVal));
    // The FULL arm shifts the click outright; the BODY arm's extra energy
    // (what its grains made of the click) must stay far below that.
    expect(extraFull).toBeGreaterThan(0.01);
    expect(extraBody).toBeLessThan(extraFull * 0.5);
  });
});

describe("morph-dynamics harmony: Harmonic Bloom hook", () => {
  it("BODY → Harmony Mix route opens the harmony on sustained material", () => {
    const base = {
      [P.HARM_ENABLED_ID]: 1,
      [P.HARM_MIX_ID]: 0, // base mix closed — only the route opens it
      [P.harmVoiceParamId(0, "on")]: 1,
      [P.harmVoiceParamId(0, "interval")]: 7,
      [P.harmVoiceParamId(0, "level")]: 100,
      [P.routeParamId(0, "enabled")]: 1,
      [P.routeParamId(0, "source")]: 3, // Body
      [P.routeParamId(0, "destination")]: DEST_INDEX.harmonyMix,
      [P.routeParamId(0, "amount")]: 100,
      [P.routeParamId(0, "smoothMs")]: 40,
    };
    const withRoute = harmonyDifference(base, () => sine(220, 0.5), 1.5);
    const without = harmonyDifference({ ...base, [P.routeParamId(0, "enabled")]: 0 }, () => sine(220, 0.5), 1.5);
    const from = Math.round(0.75 * SR);
    expect(rmsOf(withRoute.diffL, from)).toBeGreaterThan(rmsOf(without.diffL, from) * 3);
  });
});

describe("morph-dynamics harmony hardening", () => {
  it("silence in → silence out (enabled, full mix)", () => {
    const [ol] = render(makeProcessor(state(SUSTAINED)), () => 0, 1.0);
    expect(peakOf(ol)).toBeLessThan(1e-5);
  });

  it("survives every extreme parameter combination finitely", () => {
    const extremes: Record<string, number>[] = [
      { [P.harmVoiceParamId(0, "interval")]: 24, [P.harmVoiceParamId(0, "detune")]: 50 },
      { [P.harmVoiceParamId(0, "interval")]: -24, [P.harmVoiceParamId(0, "detune")]: -50 },
      { [P.harmVoiceParamId(0, "pan")]: 100, [P.harmVoiceParamId(0, "level")]: 150 },
      { [P.HARM_BODY_AMOUNT_ID]: 0, [P.HARM_DEV_FULL_SIGNAL_ID]: 1 },
    ];
    for (const ext of extremes) {
      const params = {
        ...SUSTAINED,
        ...ext,
        [P.harmVoiceParamId(1, "on")]: 1,
        [P.harmVoiceParamId(2, "on")]: 1,
        [P.harmVoiceParamId(3, "on")]: 1,
      };
      const [ol, or] = render(makeProcessor(state(params)), noise(0.9), 1.0);
      for (let i = 0; i < ol.length; i++) {
        expect(Number.isFinite(ol[i])).toBe(true);
        expect(Number.isFinite(or[i])).toBe(true);
      }
      expect(peakOf(ol)).toBeLessThanOrEqual(1.05); // chain soft ceiling holds
    }
  });

  it("four voices at maximum level stay gain-safe on hot material", () => {
    const params = state({
      [P.HARM_ENABLED_ID]: 1,
      [P.HARM_MIX_ID]: 100,
      [P.harmVoiceParamId(0, "on")]: 1,
      [P.harmVoiceParamId(1, "on")]: 1,
      [P.harmVoiceParamId(2, "on")]: 1,
      [P.harmVoiceParamId(3, "on")]: 1,
      [P.harmVoiceParamId(0, "level")]: 150,
      [P.harmVoiceParamId(1, "level")]: 150,
      [P.harmVoiceParamId(2, "level")]: 150,
      [P.harmVoiceParamId(3, "level")]: 150,
    });
    const [ol] = render(makeProcessor(params), sine(110, 0.9), 1.5);
    expect(peakOf(ol)).toBeLessThanOrEqual(1.05);
  });

  it("serializes and clamps harm state through loadState/getParameter", () => {
    const proc = makeProcessor(
      state({
        [P.HARM_ENABLED_ID]: 1,
        [P.HARM_MIX_ID]: 80,
        [P.harmVoiceParamId(0, "interval")]: 30, // → clamped 24
        [P.harmVoiceParamId(0, "level")]: 999, // → clamped 150
      }),
    );
    expect(proc.getParameter(P.HARM_ENABLED_ID)).toBe(1);
    expect(proc.getParameter(P.HARM_MIX_ID)).toBe(80);
    expect(proc.getParameter(P.harmVoiceParamId(0, "interval"))).toBe(24);
    expect(proc.getParameter(P.harmVoiceParamId(0, "level"))).toBe(150);
    // NaN values fall back to the DEFAULT (never into the DSP).
    proc.setParameter(P.harmVoiceParamId(0, "detune"), Number.NaN);
    expect(proc.getParameter(P.harmVoiceParamId(0, "detune"))).toBe(0);
  });

  it("prepares and renders at 44.1 / 48 / 96 kHz with pitch intact", () => {
    for (const sr of [44100, 48000, 96000]) {
      const [ol] = render(makeProcessor(state(SUSTAINED), sr), sine(220, 0.5, sr), 1.5, sr);
      const from = Math.round(0.75 * sr);
      const tail = ol.slice(from);
      expect(rmsOf(tail)).toBeGreaterThan(0.005);
      const expected = 220 * Math.pow(2, 7 / 12);
      const measured = zeroCrossFreq(tail, 0.02, sr);
      expect(Math.abs(measured - expected) / expected).toBeLessThan(0.25);
    }
  });

  it("handles non-power-of-two block sizes", () => {
    const proc = makeProcessor(state(SUSTAINED));
    const frames = 99;
    const input = [new Float32Array(frames), new Float32Array(frames)];
    for (let b = 0; b < 40; b++) {
      for (let i = 0; i < frames; i++) {
        const n = b * frames + i;
        input[0][i] = 0.5 * Math.sin((2 * Math.PI * 220 * n) / SR);
        input[1][i] = input[0][i];
      }
      proc.process(input, frames);
      for (let i = 0; i < frames; i++) expect(Number.isFinite(input[0][i])).toBe(true);
    }
  });
});

/** Per-sample side-channel RMS of the harmony-only content (spread/width
 * move energy BETWEEN channels; the side signal measures exactly that). */
function sideRmsOf(diffL: Float32Array, diffR: Float32Array, from = 0, to = diffL.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) {
    const s = diffL[i] - diffR[i];
    sum += s * s;
  }
  return Math.sqrt(sum / Math.max(1, to - from));
}

describe("morph-dynamics spatial bloom (Experiment #3)", () => {
  /** Sustained config with one voice parked half left. The chain's own
   * SPACE stage is disabled: its per-channel decorrelated combs would put
   * a stereo floor under EVERY add and mask the harmony's own symmetry. */
  const PAN_NED: Record<string, number> = {
    ...SUSTAINED,
    [P.harmVoiceParamId(0, "pan")]: -50,
    [P.SPACE_ENABLED_ID]: 0,
  };

  it("defines spatial params with identity defaults", () => {
    const bloom = PARAM_BY_ID.get(P.HARM_BLOOM_ID)!;
    expect([bloom.minValue, bloom.maxValue, bloom.defaultValue]).toEqual([0, 100, 0]);
    const spread = PARAM_BY_ID.get(P.HARM_SPREAD_ID)!;
    expect([spread.minValue, spread.maxValue, spread.defaultValue]).toEqual([0, 200, 100]);
    const width = PARAM_BY_ID.get(P.HARM_WIDTH_ID)!;
    expect([width.minValue, width.maxValue, width.defaultValue]).toEqual([0, 200, 100]);
    const diffusion = PARAM_BY_ID.get(P.HARM_DIFFUSION_ID)!;
    expect([diffusion.minValue, diffusion.maxValue, diffusion.defaultValue]).toEqual([0, 100, 0]);
    const space = PARAM_BY_ID.get(P.HARM_SPACE_ID)!;
    expect([space.minValue, space.maxValue, space.defaultValue]).toEqual([0, 100, 0]);
    expect(MOD_SOURCES[SOURCE_INDEX.bloom]).toBe("Bloom");
  });

  it("spread pulls voices toward center at 0 and outward past 100", () => {
    const centered = harmonyDifference({ ...PAN_NED, [P.HARM_SPREAD_ID]: 0 }, () => sine(220, 0.5), 1.0);
    const base = harmonyDifference(PAN_NED, () => sine(220, 0.5), 1.0);
    const wide = harmonyDifference({ ...PAN_NED, [P.HARM_SPREAD_ID]: 200 }, () => sine(220, 0.5), 1.0);
    const from = Math.round(0.5 * SR);
    // Spread 0: the voice sits center — harmony content is mono.
    expect(maxAbsDiff(centered.diffL, centered.diffR, from)).toBeLessThan(1e-5);
    // Spread 100 → pan −50; spread 200 → clamped at hard left: the side
    // energy grows monotonically with the spread control.
    const sideBase = sideRmsOf(base.diffL, base.diffR, from);
    const sideWide = sideRmsOf(wide.diffL, wide.diffR, from);
    expect(sideWide).toBeGreaterThan(sideBase * 1.3);
    expect(sideWide).toBeGreaterThan(0.01);
  });

  it("width 0 folds the harmony bus toward mono without killing it", () => {
    const wide = harmonyDifference(PAN_NED, () => sine(220, 0.5), 1.0);
    const mono = harmonyDifference({ ...PAN_NED, [P.HARM_WIDTH_ID]: 0 }, () => sine(220, 0.5), 1.0);
    const from = Math.round(0.5 * SR);
    expect(rmsOf(mono.diffL, from)).toBeGreaterThan(0.005);
    expect(sideRmsOf(mono.diffL, mono.diffR, from)).toBeLessThan(sideRmsOf(wide.diffL, wide.diffR, from) * 0.2);
  });

  it("diffusion audibly softens the voices while staying bounded", () => {
    const src = () => sine(220, 0.5);
    const dry = harmonyDifference({ ...PAN_NED, [P.HARM_DIFFUSION_ID]: 0 }, src, 1.0);
    const diff = harmonyDifference({ ...PAN_NED, [P.HARM_DIFFUSION_ID]: 100 }, src, 1.0);
    const from = Math.round(0.5 * SR);
    expect(rmsOf(diff.diffL, from)).toBeGreaterThan(0.005);
    expect(maxAbsDiff(dry.diffL, diff.diffL, from)).toBeGreaterThan(0.002);
    expect(peakOf(diff.diffL)).toBeLessThanOrEqual(1.05);
  });

  it("space send blooms a decaying tail that the plain harmony never gets", () => {
    const stop = 1.2;
    const gated = () => (i: number) => (i < stop * SR ? 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) : 0);
    const base = harmonyDifference({ ...PAN_NED, [P.HARM_SPACE_ID]: 0 }, gated, 2.4);
    const spaced = harmonyDifference({ ...PAN_NED, [P.HARM_SPACE_ID]: 90 }, gated, 2.4);
    const earlyFrom = Math.round((stop + 0.05) * SR);
    const earlyTo = Math.round((stop + 0.35) * SR);
    const lateFrom = Math.round((stop + 1.0) * SR);
    // Just after the phrase ends, the spaced arm carries a tail the plain
    // harmony does not — and the tail decays rather than accumulating.
    const earlySpaced = rmsOf(spaced.diffL, earlyFrom, earlyTo);
    const earlyBase = rmsOf(base.diffL, earlyFrom, earlyTo);
    expect(earlySpaced).toBeGreaterThan(earlyBase * 1.5);
    expect(earlySpaced).toBeGreaterThan(rmsOf(spaced.diffL, lateFrom) * 2);
  });

  it("the BLOOM macro scales the spatial routes (0 = no reactive spatial)", () => {
    const route = {
      [P.routeParamId(0, "enabled")]: 1,
      [P.routeParamId(0, "source")]: SOURCE_INDEX.bloom,
      [P.routeParamId(0, "destination")]: DEST_INDEX.voiceSpread,
      [P.routeParamId(0, "amount")]: 100,
      [P.routeParamId(0, "smoothMs")]: 40,
    };
    const gated = harmonyDifference({ ...PAN_NED, ...route, [P.HARM_BLOOM_ID]: 0 }, () => sine(220, 0.5), 1.2);
    const bloomed = harmonyDifference({ ...PAN_NED, ...route, [P.HARM_BLOOM_ID]: 90 }, () => sine(220, 0.5), 1.2);
    const from = Math.round(0.6 * SR);
    // With BLOOM at 0 the route contributes nothing (identity spread); at
    // 90 the sustained tone drives the voice outward — side energy grows
    // (constant-power pan law: −50 → −66 gives a ≈1.3× side ratio).
    expect(sideRmsOf(bloomed.diffL, bloomed.diffR, from)).toBeGreaterThan(
      sideRmsOf(gated.diffL, gated.diffR, from) * 1.15,
    );
  });

  it("survives the full spatial stack open: finite, mono-safe, gain-safe", () => {
    const worst = state({
      ...SUSTAINED,
      [P.harmVoiceParamId(1, "on")]: 1,
      [P.harmVoiceParamId(2, "on")]: 1,
      [P.harmVoiceParamId(3, "on")]: 1,
      [P.harmVoiceParamId(0, "pan")]: -100,
      [P.harmVoiceParamId(1, "pan")]: 100,
      [P.harmVoiceParamId(2, "pan")]: -100,
      [P.harmVoiceParamId(3, "pan")]: 100,
      [P.HARM_SPREAD_ID]: 200,
      [P.HARM_WIDTH_ID]: 200,
      [P.HARM_DIFFUSION_ID]: 100,
      [P.HARM_SPACE_ID]: 100,
    });
    const [ol, or] = render(makeProcessor(worst), noise(0.9), 2.0);
    for (let i = 0; i < ol.length; i++) {
      expect(Number.isFinite(ol[i])).toBe(true);
      expect(Number.isFinite(or[i])).toBe(true);
    }
    expect(peakOf(ol)).toBeLessThanOrEqual(1.05);
    // Mono sum keeps most of the energy (§12: no destructive collapse).
    const from = Math.round(1.0 * SR);
    let monoSum = 0;
    let stereo = 0;
    for (let i = from; i < ol.length; i++) {
      monoSum += (ol[i] + or[i]) * (ol[i] + or[i]);
      stereo += ol[i] * ol[i] + or[i] * or[i];
    }
    expect(Math.sqrt(monoSum / 2)).toBeGreaterThan(Math.sqrt(stereo / 2) * 0.5);
  });

  it("stays deterministic and finite at 96 kHz with spatial open", () => {
    const params = state({
      ...SUSTAINED,
      [P.HARM_SPREAD_ID]: 150,
      [P.HARM_WIDTH_ID]: 160,
      [P.HARM_DIFFUSION_ID]: 60,
      [P.HARM_SPACE_ID]: 50,
    });
    const a = makeProcessor(params, 96000);
    const b = makeProcessor(params, 96000);
    const [al, ar] = render(a, sine(220, 0.5, 96000), 1.0, 96000);
    const [bl] = render(b, sine(220, 0.5, 96000), 1.0, 96000);
    expect(maxAbsDiff(al, bl)).toBe(0);
    for (let i = 0; i < ar.length; i++) {
      expect(Number.isFinite(al[i])).toBe(true);
      expect(Number.isFinite(ar[i])).toBe(true);
    }
  });
});
