import { beforeAll, describe, expect, it } from "vitest";

/**
 * EQ free surgical bands (free1/free2) — real-DSP verification at the
 * processor level (jsdom has no OfflineAudioContext, so render-level
 * behavior is pinned in browser-checks; here we drive the processor
 * directly, multitap-soak style).
 *
 * These gates catch the two ways a surgical band goes silently dead:
 *  - the cascade slot exists but the coefficient selector never picks the
 *    notch/bell prototype (band always neutral), and
 *  - the type toggle is ignored (notch responds to gain, bell doesn't).
 * A two-tone probe with Goertzel band energy measures the cut/lift at the
 * target tone AND the transparency at a neighbor 2.5 octaves away — the
 * phaser-class "blanket wiring" failure mode shows up as both tones moving
 * together or neither moving.
 */

const SR = 44100;
const BLOCK = 128;

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage(): void {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const registered = new Map<string, new () => unknown>();
type EqProcessor = {
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean;
};

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (
    name: string,
    cls: new () => unknown,
  ) => {
    registered.set(name, cls);
  };
  await import("../src/audio-worklets/eq-processor.js");
});

function makeProcessor(): EqProcessor {
  const cls = registered.get("eq-processor");
  if (!cls) throw new Error("eq-processor did not self-register");
  return new cls() as EqProcessor;
}

/** Full k-rate parameter map — descriptor defaults overridden by `overrides`. */
function fullParams(overrides: Record<string, number>): Record<string, Float32Array> {
  const cls = registered.get("eq-processor") as unknown as {
    parameterDescriptors: Array<{ name: string; defaultValue: number }>;
  };
  const out: Record<string, Float32Array> = {};
  for (const d of cls.parameterDescriptors) {
    out[d.name] = new Float32Array([overrides[d.name] ?? d.defaultValue]);
  }
  return out;
}

/** Two-tone probe, half amplitude each (peak ≤ 1). */
function twoTone(f1: number, f2: number, seconds: number): Float32Array {
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = 0.5 * Math.sin(2 * Math.PI * f1 * t) + 0.5 * Math.sin(2 * Math.PI * f2 * t);
  }
  return out;
}

/** Render the probe through the processor with the given free1 params. */
function renderFree1(probe: Float32Array, params: Record<string, number>): Float32Array {
  const proc = makeProcessor();
  const full = fullParams({
    free1Freq: params.freq ?? 1000,
    free1Gain: params.gain ?? 0,
    free1Q: params.q ?? 2,
    free1Type: params.type ?? 0,
  });
  const out = new Float32Array(probe.length);
  for (let off = 0; off < probe.length; off += BLOCK) {
    const len = Math.min(BLOCK, probe.length - off);
    const inBlock = probe.slice(off, off + len);
    const outBlock = new Float32Array(len);
    proc.process([inBlock.length ? [inBlock] : []], [[outBlock]], full);
    out.set(outBlock, off);
  }
  return out;
}

/** Measurement window: skip the glide/settle head (coefficients converge in ~3 ms). */
const SETTLE_SAMPLES = Math.floor(0.25 * SR);

/** Goertzel magnitude at one frequency over the buffer. */
function goertzel(buf: Float32Array, freq: number): number {
  const w = (2 * Math.PI * freq) / SR;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const s0 = buf[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / (buf.length / 2);
}

/** Goertzel ratio in dB between output and probe, over the settled window. */
function toneRatioDb(out: Float32Array, probe: Float32Array, freq: number): number {
  const o = out.slice(SETTLE_SAMPLES);
  const p = probe.slice(SETTLE_SAMPLES);
  return db(goertzel(o, freq) / goertzel(p, freq));
}

function db(x: number): number {
  return 20 * Math.log10(Math.max(x, 1e-12));
}

describe("eq free surgical bands (real DSP)", () => {
  it("notch at 347 Hz cuts the 347 tone ≥ 20 dB and leaves 3 kHz within 1 dB", () => {
    const probe = twoTone(347, 3000, 1.2);
    const out = renderFree1(probe, { freq: 347, gain: -24, q: 4, type: 1 });
    expect(out.every(Number.isFinite)).toBe(true);
    const cutDb = toneRatioDb(out, probe, 347);
    const neighborDb = toneRatioDb(out, probe, 3000);
    expect(cutDb).toBeLessThanOrEqual(-20);
    expect(Math.abs(neighborDb)).toBeLessThanOrEqual(1);
  });

  it("bell +12 dB at 1 kHz lifts the 1 kHz tone 9–14 dB (gain used in bell mode)", () => {
    const probe = twoTone(1000, 300, 1.2);
    const out = renderFree1(probe, { freq: 1000, gain: 12, q: 2, type: 0 });
    const liftDb = toneRatioDb(out, probe, 1000);
    expect(liftDb).toBeGreaterThanOrEqual(9);
    expect(liftDb).toBeLessThanOrEqual(14);
  });

  it("at gain -12 the type toggle discriminates: notch cuts deeper than the bell by ≥ 6 dB", () => {
    // A bell at -24 dB gain is itself a deep cut, so depth alone doesn't
    // discriminate prototypes — at -12 dB the bell bottoms out at its gain
    // while the notch ignores gain entirely and keeps cutting.
    const probe = twoTone(500, 2000, 1.2);
    const notch = renderFree1(probe, { freq: 500, gain: -12, q: 8, type: 1 });
    const bell = renderFree1(probe, { freq: 500, gain: -12, q: 8, type: 0 });
    const notchDb = toneRatioDb(notch, probe, 500);
    const bellDb = toneRatioDb(bell, probe, 500);
    expect(notchDb).toBeLessThanOrEqual(-20);
    expect(bellDb).toBeGreaterThanOrEqual(-14);
    expect(bellDb).toBeLessThanOrEqual(-10);
    expect(notchDb).toBeLessThan(bellDb - 6);
  });

  it("neutral free bands are transparent — both tones pass within 0.1 dB", () => {
    const probe = twoTone(347, 3000, 1.0);
    const out = renderFree1(probe, { freq: 347, gain: 0, q: 2, type: 0 });
    const a = toneRatioDb(out, probe, 347);
    const b = toneRatioDb(out, probe, 3000);
    expect(Math.abs(a)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(b)).toBeLessThanOrEqual(0.1);
  });

  it("silence after signal converges to exact zero (flush convention, no denormal tail)", () => {
    const proc = makeProcessor();
    const params = fullParams({
      free1Freq: 347,
      free1Gain: 0,
      free1Q: 12,
      free1Type: 1,
    });
    const n = Math.floor(SR * 1.0);
    const flat = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      flat[i] = 0.5 * Math.sin(2 * Math.PI * 347 * t) + 0.5 * Math.sin(2 * Math.PI * 3000 * t);
    }
    // Drive 1 s of signal, then 2 s of silence in BLOCK chunks.
    let subNormalOut = 0;
    let sawSilence = false;
    const totalBlocks = Math.ceil((3.0 * SR) / BLOCK);
    for (let b = 0; b < totalBlocks; b++) {
      const off = b * BLOCK;
      // Always a full BLOCK — a short final slice would read undefined
      // (NaN) in the processor's fixed-size loop.
      const inBlock = new Float32Array(BLOCK);
      if (off < flat.length) inBlock.set(flat.slice(off, off + BLOCK));
      const outBlock = new Float32Array(BLOCK);
      proc.process([[inBlock]], [[outBlock]], params);
      if (off >= flat.length) {
        sawSilence = true;
        for (const v of outBlock) {
          if (v === 0) continue;
          if (Math.abs(v) < 1e-15) subNormalOut++;
          else if (b > totalBlocks - 8) throw new Error(`non-zero audible tail sample ${v} near end`);
        }
      }
    }
    expect(sawSilence).toBe(true);
    expect(subNormalOut).toBe(0);
  });
});
