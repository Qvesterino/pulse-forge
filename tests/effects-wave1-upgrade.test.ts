/**
 * Wave-1 effect upgrade probes — drives the CHANGED worklet processors
 * directly under a stubbed AudioWorklet scope (ultina-entry harness
 * pattern) and pins the new behaviors:
 *
 *   gate    — hysteresis stops threshold chatter; look-ahead passes attacks
 *   stutter — step-edge smoothing (no hard gain jumps)
 *   flanger — TZF invert flips the wet polarity
 *   reverb  — TONE (output) and DAMPING (loop) act independently
 *   characterCurve — saturation/distortion engine modes
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CHARACTER_MODE_LABELS, characterCurve, characterTransfer } from "../src/effects/characterCurve";

const SR = 48000;
const BLOCK = 128;

class FakeAudioWorkletProcessor {
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (_msg: unknown) => {},
  };
}

const registry = new Map<string, unknown>();

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: unknown) => {
    registry.set(name, cls);
  };
  // @ts-expect-error raw worklet processor files
  await import("../src/audio-worklets/gate-processor.js");
  // @ts-expect-error raw worklet processor files
  await import("../src/audio-worklets/stutter-processor.js");
  await import("../src/audio-worklets/flanger-processor.js");
  // @ts-expect-error raw worklet processor file (no declaration sibling)
  await import("../src/audio-worklets/reverb-processor.js");
});

type Proc = {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
};

function make(name: string): Proc {
  const Ctor = registry.get(name) as new () => Proc;
  if (!Ctor) throw new Error(`${name} did not register`);
  return new Ctor();
}

function run(proc: Proc, params: Record<string, number>, gen: (i: number) => number, seconds: number): Float32Array {
  const out = new Float32Array(Math.ceil(seconds * SR));
  const blocks = Math.ceil(out.length / BLOCK);
  for (let b = 0; b < blocks; b++) {
    const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let i = 0; i < BLOCK; i++) {
      const v = gen(b * BLOCK + i);
      input[0][i] = v;
      input[1][i] = v;
    }
    const p: Record<string, Float32Array> = {};
    for (const [k, v] of Object.entries(params)) p[k] = new Float32Array([v]);
    // inputs is an ARRAY OF INPUTS — [[L, R]] — not the channel pair itself.
    proc.process([input], [output], p);
    for (let i = 0; i < BLOCK; i++) {
      const idx = b * BLOCK + i;
      if (idx < out.length) out[idx] = output[0][i];
    }
  }
  return out;
}

function meanAbs(buf: Float32Array, from = 0, to = buf.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += Math.abs(buf[i]);
  return s / Math.max(1, to - from);
}

describe("gate hysteresis + look-ahead", () => {
  const base = {
    threshold: -36,
    attack: 0.002,
    hold: 0.001, // short hold — without hysteresis the gate would chatter
    release: 0.08,
    range: -60,
    mix: 1,
    lookahead: 0,
  };

  it("hysteresis keeps the gate open on threshold-hovering signals", () => {
    // Piecewise levels: −30 dB for 50 ms, then −46 dB for 150 ms. The
    // envelope (80 ms release) decays through the OPEN threshold (−36) into
    // the hysteresis band but never below the CLOSE threshold (−48 at full
    // hysteresis): a wide-hysteresis gate holds OPEN through the quiet
    // segment while a zero-hysteresis gate slams shut — measurable deep in
    // the quiet segment.
    const segHigh = 0.0316; // −30 dB
    const segLow = 0.005; // −46 dB
    const cycle = Math.floor(0.4 * SR);
    const highLen = Math.floor(0.05 * SR);
    const gen = (i: number): number => {
      const inCycle = i % cycle;
      const a = inCycle < highLen ? segHigh : segLow;
      return a * Math.sin((2 * Math.PI * 440 * i) / SR);
    };
    const chatter = run(make("gate-processor"), { ...base, hysteresis: 0 }, gen, 1.2);
    const stable = run(make("gate-processor"), { ...base, hysteresis: 1 }, gen, 1.2);
    // Deep inside the second cycle's quiet segment: the 80 ms-release
    // envelope has fully decayed (≈ −46 dB floor), so the zero-hysteresis
    // gate is long CLOSED while the wide-band gate still holds open.
    const from = Math.floor(0.6 * SR);
    const to = Math.floor(0.72 * SR);
    expect(meanAbs(stable, from, to)).toBeGreaterThan(meanAbs(chatter, from, to) * 5);
  });

  it("look-ahead passes the transient at full level", () => {
    // Silence (gate closed) then a 6 ms burst. With a slow 100 ms attack
    // and NO look-ahead the burst is over before the gain opens; with
    // look-ahead the gain opens instantly and the ring delay places that
    // opened gain right where the delayed burst lands.
    const burstGen = (i: number): number => (i >= 0.3 * SR && i < 0.3 * SR + 0.006 * SR ? 1 : 0);
    const withLa = run(make("gate-processor"), { ...base, hysteresis: 0, attack: 0.1, lookahead: 1 }, burstGen, 0.35);
    const withoutLa = run(
      make("gate-processor"),
      { ...base, hysteresis: 0, attack: 0.1, lookahead: 0 },
      burstGen,
      0.35,
    );
    const clickPos = Math.floor(0.3 * SR);
    const windowEnd = clickPos + Math.floor(0.009 * SR);
    const windowLa = Math.max(...Array.from(withLa.slice(clickPos, windowEnd), Math.abs));
    const windowNo = Math.max(...Array.from(withoutLa.slice(clickPos, windowEnd), Math.abs));
    expect(windowLa).toBeGreaterThan(0.7);
    expect(windowLa).toBeGreaterThan(windowNo * 2);
  });
});

describe("stutter step-edge smoothing", () => {
  it("smoothed gate never jumps hard between samples", () => {
    const proc = make("stutter-processor");
    // Alternate 1/0 gate steps via the pattern message.
    (proc as unknown as { port: { onmessage: ((e: { data: unknown }) => void) | null } }).port.onmessage?.({
      data: { type: "pattern", steps: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] },
    });
    const out = run(proc, { division: 4, mix: 1, feedback: 0, smooth: 0.003 }, () => 1, 0.5);
    let maxDelta = 0;
    for (let i = 1; i < out.length; i++) maxDelta = Math.max(maxDelta, Math.abs(out[i] - out[i - 1]));
    expect(maxDelta).toBeLessThan(0.2);
  });
});

describe("flanger TZF invert", () => {
  it("invert=1 flips the wet echo polarity", () => {
    const base = { rate: 0.001, depth: 0, base: 5, feedback: 0, spread: 0, mix: 1, invert: 0 };
    const normal = run(make("flanger-processor"), base, (i) => (i === 10 ? 1 : 0), 0.02);
    const inverted = run(make("flanger-processor"), { ...base, invert: 1 }, (i) => (i === 10 ? 1 : 0), 0.02);
    const echoPos = 10 + Math.round((0.005 * SR) as number);
    const normalEcho = normal[echoPos];
    const invertedEcho = inverted[echoPos];
    expect(normalEcho).toBeGreaterThan(0.5);
    expect(invertedEcho).toBeLessThan(-0.5);
  });
});

describe("reverb damping vs tone split", () => {
  let noiseState = 99;
  const gen = (): number => {
    noiseState = (1103515245 * noiseState + 12345) & 0x7fffffff;
    return 0.5 * (noiseState / 0x3fffffff - 1);
  };
  const hfRatio = (damping: number, tone: number, fromSec: number, toSec: number): number => {
    const proc = make("reverb-processor");
    const out = run(proc, { decay: 1.5, damping, diffusion: 0.6, tone }, gen, 0.5);
    // HF proxy: energy of the first difference (high-frequency content).
    let hf = 0;
    let total = 0;
    const from = Math.floor(fromSec * SR);
    const to = Math.floor(toSec * SR);
    for (let i = from + 1; i < to; i++) {
      hf += (out[i] - out[i - 1]) ** 2;
      total += out[i] ** 2;
    }
    return hf / Math.max(total, 1e-12);
  };

  it("DAMPING (loop) sets how fast the TAIL loses highs", () => {
    const darkTail = hfRatio(800, 12000, 0.3, 0.5);
    const brightTail = hfRatio(12000, 12000, 0.3, 0.5);
    expect(brightTail).toBeGreaterThan(darkTail);
  });

  it("TONE (output) sets the output brightness immediately", () => {
    const darkOut = hfRatio(12000, 800, 0.02, 0.15);
    const brightOut = hfRatio(12000, 12000, 0.02, 0.15);
    expect(brightOut).toBeGreaterThan(darkOut * 1.3);
  });
});

describe("character engine (saturation/distortion curves)", () => {
  const N = 2048;

  it("labels the four stable modes", () => {
    expect(CHARACTER_MODE_LABELS).toEqual(["Warm", "Tube", "Fold", "Hard"]);
  });

  it("keeps every mode's curve bounded and zero at center", () => {
    for (let mode = 0 as 0 | 1 | 2 | 3; mode < 4; mode++) {
      const curve = characterCurve(mode as 0 | 1 | 2 | 3, 0.8, 0.3);
      expect(curve.length).toBe(N);
      for (let i = 0; i < N; i++) {
        expect(Math.abs(curve[i])).toBeLessThanOrEqual(1.0001);
        expect(Number.isFinite(curve[i])).toBe(true);
      }
      // Zero input → zero output (bias DC is removed by construction —
      // exact through the transfer function; the curve grid center sits at
      // x ≈ 0.001, so only assert near-zero there).
      expect(characterTransfer(mode as 0 | 1 | 2 | 3, 0, 0.8, 0.3)).toBe(0);
      expect(Math.abs(curve[N / 2])).toBeLessThan(0.01);
    }
  });

  it("bias breaks odd symmetry (the tube flavor)", () => {
    for (let mode = 0 as 0 | 1 | 2 | 3; mode < 4; mode++) {
      const x = 0.5;
      const pos = characterTransfer(mode as 0 | 1 | 2 | 3, x, 0.6, 0.7);
      const neg = characterTransfer(mode as 0 | 1 | 2 | 3, -x, 0.6, 0.7);
      expect(Math.abs(pos + neg)).toBeGreaterThan(0.02); // f(x) ≠ −f(−x)
    }
  });

  it("fold mode at high drive folds the waveform (multiple extrema)", () => {
    const curve = characterCurve(2, 0.95, 0);
    let extrema = 0;
    for (let i = 1; i < N - 1; i++) {
      const d0 = curve[i] - curve[i - 1];
      const d1 = curve[i + 1] - curve[i];
      if (d0 * d1 < 0) extrema++;
    }
    // A folded transfer swings direction many times across ±1.
    expect(extrema).toBeGreaterThanOrEqual(4);
  });
});
