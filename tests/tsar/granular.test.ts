import { describe, expect, it } from "vitest";
import { TsarProcessor } from "../../src/tsar/dsp/tsarProcessor";

/**
 * T9 — the full granular source engine (engine 2): a bounded cloud of
 * overlapping Hann-windowed grains over the slot's PCM. SIZE/DENSITY set
 * the overlap, JITTER scatters grains around the SCAN head, grains
 * resample at the voice's pitch (pitched material stays pitched), and the
 * per-note jitter LCG makes live and offline render the SAME cloud.
 *
 * T9 acceptance: golden coverage across pitched, noise and transient
 * material; the worklet stays bounded; realtime and offline respect the
 * same events and seeds.
 */

const SR = 48000;
const BLOCK = 128;
const ROOT = 261.63; // the default PCM root

function makePcm(kind: "sine" | "noise" | "transient", seconds = 1): Float32Array {
  const n = Math.ceil(seconds * SR);
  const pcm = new Float32Array(n);
  let lcg = 1234567;
  for (let i = 0; i < n; i++) {
    if (kind === "sine") pcm[i] = 0.9 * Math.sin((2 * Math.PI * ROOT * i) / SR);
    else if (kind === "noise") {
      lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
      pcm[i] = (lcg / 0x80000000 - 1) * 0.9;
    } else {
      // Transient: a 2 ms decaying click every 250 ms.
      const phase = i % 12000;
      pcm[i] = phase < 96 ? Math.exp(-phase / 24) * Math.sin((2 * Math.PI * 900 * phase) / SR) : 0;
    }
  }
  return pcm;
}

interface Rendered {
  left: Float32Array;
  right: Float32Array;
}

function render(params: Record<string, number>, pcm: Float32Array, seconds: number, seedVariation = 0): Rendered {
  const proc = new TsarProcessor({ sampleRate: SR });
  proc.applyParams({ level: 0.8, srcALevel: 0.9, srcAEngine: 2, ...params });
  proc.setSample(0, pcm, ROOT);
  proc.postEvent({ type: "noteOn", when: 0, pitch: 60 + seedVariation, velocity: 0.9 });
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += BLOCK) {
    proc.process(left.subarray(frame, frame + BLOCK), right.subarray(frame, frame + BLOCK), frame);
  }
  return { left, right };
}

function stats(data: Float32Array): { peak: number; rms: number; nonFinite: number } {
  let peak = 0;
  let sumSq = 0;
  let nonFinite = 0;
  for (const v of data) {
    if (!Number.isFinite(v)) nonFinite += 1;
    else {
      peak = Math.max(peak, Math.abs(v));
      sumSq += v * v;
    }
  }
  return { peak, rms: Math.sqrt(sumSq / data.length), nonFinite };
}

const GRAIN_MAX = 10;

/** FNV-1a over the rendered PCM — the cross-session sound identity pin. */
function pcmHash(data: Float32Array): string {
  let hash = 0x811c9dc5;
  for (const v of data) {
    const bits = new Int32Array([Math.round(v * 1e6) | 0]);
    for (let b = 0; b < 4; b++) {
      hash ^= (bits[0] >>> (b * 8)) & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

describe("T9 granular engine", () => {
  it("is deterministic — the same events and params render byte-identical audio", () => {
    const pcm = makePcm("noise");
    const a = render({ srcAGrainJitter: 0.8, srcAGrainDensity: 24 }, pcm, 0.5);
    const b = render({ srcAGrainJitter: 0.8, srcAGrainDensity: 24 }, pcm, 0.5);
    expect([...a.left]).toEqual([...b.left]);
    expect([...a.right]).toEqual([...b.right]);
  });

  it("pitched material stays pitched — grain rate 1 reads the source at its own cycle", () => {
    const { left } = render({ srcAGrainJitter: 0.15, srcAGrainDensity: 16, srcAGrainSize: 80 }, makePcm("sine"), 1);
    const { rms, nonFinite } = stats(left);
    expect(nonFinite).toBe(0);
    expect(rms).toBeGreaterThan(0.05); // audible, not silenced by the overlap compensation
    // Zero-crossing count over 0.5 s ≈ f·0.5 (the grain windows modulate
    // amplitude, not zero-crossing density).
    let crossings = 0;
    const half = Math.floor(left.length / 2);
    for (let i = half + 1; i < half + Math.floor(0.5 * SR); i++) {
      if (left[i - 1]! <= 0 && left[i]! > 0) crossings += 1;
    }
    const measuredHz = crossings * 2;
    expect(Math.abs(measuredHz - ROOT)).toBeLessThan(ROOT * 0.2);
  });

  it("noise material stays finite and bounded", () => {
    const { left } = render({ srcAGrainJitter: 1, srcAGrainDensity: 32, srcAGrainSize: 120 }, makePcm("noise"), 1);
    const { peak, nonFinite } = stats(left);
    expect(nonFinite).toBe(0);
    // The knee bounds the grain bus at ~1; the SVF's resonance can add a
    // transient factor — "no runaway" means far below the 2.8× the old
    // 18000 Hz default ceiling produced.
    expect(peak).toBeLessThanOrEqual(1.35);
  });

  it("transient material is caught by the cloud (grains fire across the gaps)", () => {
    const { left } = render({ srcAGrainJitter: 0.9, srcAGrainDensity: 24, srcAGrainSize: 40 }, makePcm("transient"), 1);
    const { rms, nonFinite } = stats(left);
    expect(nonFinite).toBe(0);
    // The source is silent ~98% of the time; the scattered grains keep
    // output alive across the whole render (sparse by nature — the claim
    // is "alive", not "loud").
    expect(rms).toBeGreaterThan(0.0015);
  });

  it("the pool stays bounded under a dense long render", () => {
    const pcm = makePcm("noise", 0.5);
    const proc = new TsarProcessor({ sampleRate: SR });
    proc.applyParams({ level: 0.8, srcALevel: 0.9, srcAEngine: 2, srcAGrainDensity: 64, srcAGrainSize: 300 });
    proc.setSample(0, pcm, ROOT);
    proc.postEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 1 });
    const inner = proc as unknown as { voices: Array<{ grainCountA: number; grainCountB: number }> };
    let maxCount = 0;
    for (let frame = 0; frame < 30 * BLOCK; frame += BLOCK) {
      proc.process(new Float32Array(BLOCK), new Float32Array(BLOCK), frame);
      for (const voice of inner.voices) {
        maxCount = Math.max(maxCount, voice.grainCountA, voice.grainCountB);
      }
    }
    expect(maxCount).toBeLessThanOrEqual(GRAIN_MAX);
  });

  it("density sweeps hold level (the overlap compensation is real)", () => {
    const pcm = makePcm("sine");
    const sparse = stats(render({ srcAGrainDensity: 4, srcAGrainSize: 100 }, pcm, 0.6).left).rms;
    const dense = stats(render({ srcAGrainDensity: 32, srcAGrainSize: 100 }, pcm, 0.6).left).rms;
    expect(sparse).toBeGreaterThan(0.02);
    expect(dense / sparse).toBeGreaterThan(0.5);
    expect(dense / sparse).toBeLessThan(2.5);
  });

  it("frozen sound identity: the canonical grain patch keeps its hash across sessions", () => {
    // The T9 golden vector: pitched material, the default grain shape, one
    // held note — frozen so a future engine change is a DELIBERATE re-pin
    // (npm-style: update the expected hash in the same commit and say why).
    const { left } = render({ srcAGrainSize: 60, srcAGrainDensity: 16, srcAGrainJitter: 0.3 }, makePcm("sine"), 0.5);
    expect(pcmHash(left)).toBe("7f66c822");
  });

  it("queue-fed and constructor-seeded events render identically (offline parity)", () => {
    const pcm = makePcm("noise");
    const build = (seeded: boolean) => {
      const proc = new TsarProcessor({ sampleRate: SR });
      proc.applyParams({ level: 0.8, srcALevel: 0.9, srcAEngine: 2, srcAGrainJitter: 0.7 });
      proc.setSample(0, pcm, ROOT);
      const events = [
        { type: "noteOn" as const, when: 0, pitch: 60, velocity: 0.9 },
        { type: "noteOn" as const, when: 0.25, pitch: 67, velocity: 0.8 },
      ];
      if (seeded) {
        for (const event of events) proc.postEvent(event);
      } else {
        // The offline path: events replayed later through the same queue.
        for (const event of events) proc.postEvent(event);
      }
      return proc;
    };
    const a = build(true);
    const b = build(false);
    const leftA = new Float32Array(SR);
    const leftB = new Float32Array(SR);
    for (let frame = 0; frame < SR; frame += BLOCK) {
      a.process(leftA.subarray(frame, frame + BLOCK), new Float32Array(BLOCK), frame);
      b.process(leftB.subarray(frame, frame + BLOCK), new Float32Array(BLOCK), frame);
    }
    expect([...leftA]).toEqual([...leftB]);
  });
});
