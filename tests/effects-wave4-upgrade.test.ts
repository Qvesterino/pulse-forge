/**
 * Wave-4 effect polish tests — roadmap docs/EFFECT-POLISH-ROADMAP.md:
 *
 *   vowel/svfilter   — coefficient/cutoff GLIDE (no zipper on sweeps)
 *   chorus           — feedback/voices/lfoShape contract + S&H determinism
 *   duckDelay        — pingpong/loopHpf contract; processor crossfeed works
 *   autowah          — direction/drive params flow to the processor
 *   ringMod          — X-mode (unipolar carrier) flips the transfer
 *   bassBuss sub     — ÷2 divider emits HALF the input frequency
 *   registry         — all new params present with correct defaults
 */
import { beforeAll, describe, expect, it } from "vitest";
import { defaultParamsOf } from "../src/effects/registry";

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
  await import("../src/audio-worklets/vowel-processor.js");
  // @ts-expect-error raw worklet processor files
  await import("../src/audio-worklets/svfilter-processor.js");
  await import("../src/audio-worklets/chorus-processor.js");
  await import("../src/audio-worklets/ducking-delay-processor.js");
  // @ts-expect-error raw worklet processor files
  await import("../src/audio-worklets/autowah-processor.js");
  // @ts-expect-error raw worklet processor files
  await import("../src/audio-worklets/ringmod-processor.js");
  // @ts-expect-error raw worklet processor file (no declaration sibling)
  await import("../src/audio-worklets/bassbuss-sub-processor.js");
});

type Proc = {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
  port?: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (msg: unknown) => void };
};

function make(name: string, opts?: unknown): Proc {
  const Ctor = registry.get(name) as new (options?: unknown) => Proc;
  if (!Ctor) throw new Error(`${name} did not register`);
  return new Ctor(opts);
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
    proc.process([input], [output], p);
    for (let i = 0; i < BLOCK; i++) {
      const idx = b * BLOCK + i;
      if (idx < out.length) out[idx] = output[0][i];
    }
  }
  return out;
}

function goertzel(buf: Float32Array, freq: number, from: number, to: number): number {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * freq) / SR;
  for (let i = from; i < to; i++) {
    re += buf[i] * Math.cos(w * i);
    im -= buf[i] * Math.sin(w * i);
  }
  return (2 * Math.sqrt(re * re + im * im)) / (to - from);
}

describe("B1/B2 — parameter glide kills the zipper", () => {
  it("vowel: automated sweep has no hard sample jumps", () => {
    const proc = make("vowel-processor");
    const params = { vowel: new Float32Array([1]), resonance: new Float32Array([0.5]), mix: new Float32Array([1]) };
    // Move vowel mid-render and check the worst sample-to-sample delta.
    let worst = 0;
    const blocks = Math.ceil((0.5 * SR) / BLOCK);
    for (let b = 0; b < blocks; b++) {
      const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      for (let i = 0; i < BLOCK; i++) {
        input[0][i] = 0.5 * Math.sin((2 * Math.PI * 200 * (b * BLOCK + i)) / SR);
        input[1][i] = input[0][i];
      }
      if (b === 40) params.vowel = new Float32Array([3]); // instant param jump
      proc.process([input], [output], params);
      for (let i = 1; i < BLOCK; i++) {
        worst = Math.max(worst, Math.abs(output[0][i] - output[0][i - 1]));
      }
    }
    expect(Number.isFinite(worst)).toBe(true);
    expect(worst).toBeLessThan(0.5); // 0.5-amp input; glide keeps it tame
  });

  it("svfilter: automated cutoff sweep stays smooth and finite", () => {
    const proc = make("svfilter-processor");
    let cutoff = 300;
    let worst = 0;
    for (let b = 0; b < Math.ceil((0.4 * SR) / BLOCK); b++) {
      cutoff = 300 + 3000 * (b / ((0.4 * SR) / BLOCK)); // linear sweep
      const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      for (let i = 0; i < BLOCK; i++) {
        input[0][i] = 0.5 * Math.sin((2 * Math.PI * 300 * (b * BLOCK + i)) / SR);
        input[1][i] = input[0][i];
      }
      proc.process([input], [output], {
        cutoff: new Float32Array([cutoff]),
        resonance: new Float32Array([0.7]),
        mode: new Float32Array([0]),
        drive: new Float32Array([0]),
        mix: new Float32Array([1]),
      });
      for (let i = 1; i < BLOCK; i++) {
        worst = Math.max(worst, Math.abs(output[0][i] - output[0][i - 1]));
        expect(Number.isFinite(output[0][i])).toBe(true);
      }
    }
    expect(worst).toBeLessThan(0.5);
  });
});

describe("C — chorus feedback/voices/shape", () => {
  it("S&H LFO is deterministic for the same seed", () => {
    const renderSh = (): Float32Array => {
      const proc = make("chorus-processor", { processorOptions: { seed: 123 } });
      return run(
        proc,
        { rate: 1, depth: 0.5, spread: 1, mix: 1, feedback: 0.2, voices: 3, lfoShape: 2 },
        (i) => 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR),
        0.3,
      );
    };
    const a = renderSh();
    const b = renderSh();
    for (let i = 0; i < a.length; i += 97) expect(a[i]).toBe(b[i]);
  });

  it("feedback 0.85 with sustained input does not run away", () => {
    const proc = make("chorus-processor", { processorOptions: { seed: 7 } });
    const out = run(
      proc,
      { rate: 1.2, depth: 0.4, spread: 0.8, mix: 1, feedback: 0.85, voices: 2, lfoShape: 0 },
      (i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR),
      1.0,
    );
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(2); // headroom bound, no runaway
  });

  it("voices=4 changes the wet character vs voices=2", () => {
    const wet = (voices: number): Float32Array => {
      const proc = make("chorus-processor", { processorOptions: { seed: 5 } });
      return run(
        proc,
        { rate: 1, depth: 0.5, spread: 1, mix: 1, feedback: 0, voices, lfoShape: 0 },
        (i) => 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR),
        0.3,
      );
    };
    const two = wet(2);
    const four = wet(4);
    // Different modulation → sample-level difference; both stay sane.
    let diff = 0;
    for (let i = 0; i < two.length; i++) diff += Math.abs(two[i] - four[i]);
    diff /= two.length;
    expect(diff).toBeGreaterThan(0.01);
    for (const v of four) expect(Math.abs(v)).toBeLessThanOrEqual(1.5);
  });
});

describe("D1 — duckDelay pingpong crossfeed", () => {
  it("pingpong ON bounces the tail between channels", () => {
    let state = 333;
    const gen = (): number => {
      state = (1103515245 * state + 12345) & 0x7fffffff;
      return 0.5 * (state / 0x3fffffff - 1);
    };
    const runStereo = (pingpong: number): [Float32Array, Float32Array] => {
      const proc = make("ducking-delay-processor");
      const frames = Math.ceil(0.5 * SR);
      const outL = new Float32Array(frames);
      const outR = new Float32Array(frames);
      const blocks = Math.ceil(frames / BLOCK);
      for (let b = 0; b < blocks; b++) {
        const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
        const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
        for (let i = 0; i < BLOCK; i++) {
          const v = gen();
          input[0][i] = v;
          input[1][i] = v;
        }
        const p: Record<string, Float32Array> = {};
        for (const [k, v] of Object.entries({
          time: 120,
          feedback: 0.5,
          tone: 8000,
          duckAmount: 0,
          duckThresh: -60,
          duckAttack: 0.005,
          duckRelease: 0.18,
          mix: 1,
          pingpong,
          loopHpfHz: 40,
        })) {
          p[k] = new Float32Array([v]);
        }
        proc.process([input], [output], p);
        for (let i = 0; i < BLOCK; i++) {
          const idx = b * BLOCK + i;
          if (idx < frames) {
            outL[idx] = output[0][i];
            outR[idx] = output[1][i];
          }
        }
      }
      return [outL, outR];
    };
    const [plainL, plainR] = runStereo(0);
    const [, ppR] = runStereo(1);
    // Sanity: normal mode keeps the tail finite.
    let finiteCount = 0;
    for (const v of plainL) if (Number.isFinite(v)) finiteCount++;
    for (const v of plainR) if (Number.isFinite(v)) finiteCount++;
    expect(finiteCount).toBeGreaterThan(plainL.length);
    const sampleDiff = (a: Float32Array, b: Float32Array): number => {
      let diff = 0;
      let energy = 0;
      const from = Math.floor(0.15 * SR);
      for (let i = from; i < a.length; i++) {
        diff += Math.abs(a[i] - b[i]);
        energy += Math.abs(a[i]) + Math.abs(b[i]);
      }
      return diff / Math.max(energy, 1e-9);
    };
    // The R tails differ between normal and ping-pong mode (bounces land on
    // the other side).
    expect(sampleDiff(plainR, ppR)).toBeGreaterThan(0.1);
  });
});

describe("D2 — bassBuss sub-octave generator", () => {
  it("emits HALF the input frequency (one octave down)", () => {
    const proc = make("bassbuss-sub-processor");
    // Feed a 110 Hz lowpassed-ish sine (sign flips at 110 Hz → sub at 55 Hz).
    const out = run(proc, { amount: 0.9 }, (i) => 0.8 * Math.sin((2 * Math.PI * 110 * i) / SR), 0.5);
    const fundamental = goertzel(out, 55, Math.floor(0.2 * SR), out.length);
    const inputFreqLeak = goertzel(out, 110, Math.floor(0.2 * SR), out.length);
    // Sub voice is dominated by the octave-down component.
    expect(fundamental).toBeGreaterThan(0.05);
    expect(fundamental).toBeGreaterThan(inputFreqLeak * 2);
  });

  it("amount=0 silences the sub voice", () => {
    const proc = make("bassbuss-sub-processor");
    const out = run(proc, { amount: 0 }, (i) => 0.8 * Math.sin((2 * Math.PI * 110 * i) / SR), 0.3);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBe(0);
  });
});

describe("D4 — autowah direction, ringMod X-mode", () => {
  it("autowah down-wah closes the passband on loud sustained input", () => {
    // 2 kHz tone, LP mode: DOWN-wah pulls the corner to ~minFreq (tone
    // attenuated); UP-wah opens toward maxFreq (tone passes).
    const outAt = (direction: number): number => {
      const proc = make("autowah-processor");
      const out = run(
        proc,
        {
          minFreq: 200,
          maxFreq: 4000,
          resonance: 0.5,
          attack: 0.02,
          release: 0.3,
          sensitivity: 1.5,
          mode: 1,
          mix: 1,
          direction,
          drive: 0,
        },
        (i) => 0.8 * Math.sin((2 * Math.PI * 2000 * i) / SR),
        0.4,
      );
      return goertzel(out, 2000, Math.floor(0.3 * SR), out.length);
    };
    const down = outAt(1);
    const up = outAt(0);
    expect(down).toBeLessThan(up * 0.5);
    expect(up).toBeGreaterThan(0.05);
  });

  it("ringMod X-mode keeps the dry tone; ring mode suppresses it", () => {
    const dryLeak = (xmode: number): number => {
      const proc = make("ringmod-processor");
      const out = run(
        proc,
        { frequency: 100, mix: 1, feedback: 0, xmode },
        (i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR),
        0.2,
      );
      return goertzel(out, 440, Math.floor(0.1 * SR), out.length);
    };
    // Bipolar ring mod: output = input × carrier → sidebands only, the
    // 440 Hz dry tone cancels. X-mode adds a unipolar (|carrier|) path that
    // keeps the dry tone audible (that's the "X" character).
    expect(dryLeak(0)).toBeLessThan(0.005);
    expect(dryLeak(1)).toBeGreaterThan(0.05);
  });
});

describe("wave-4 registry contracts", () => {
  it("chorus exposes feedback/voices/lfoShape", () => {
    const params = defaultParamsOf("chorus");
    expect(params["feedback"]).toBe(0);
    expect(params["voices"]).toBe(2);
    expect(params["lfoShape"]).toBe(0);
  });

  it("duckDelay exposes sync/pingpong/loopHpfHz", () => {
    const params = defaultParamsOf("duckDelay");
    expect(params["sync"]).toBe(0);
    expect(params["pingpong"]).toBe(0);
    expect(params["loopHpfHz"]).toBe(40);
  });

  it("autowah exposes direction/drive; ringMod exposes xmode", () => {
    expect(defaultParamsOf("autowah")["direction"]).toBe(0);
    expect(defaultParamsOf("autowah")["drive"]).toBe(0);
    expect(defaultParamsOf("ringMod")["xmode"]).toBe(0);
  });

  it("compressor exposes autoRelease; utility exposes dcBlock", () => {
    expect(defaultParamsOf("compressor")["autoRelease"]).toBe(0);
    expect(defaultParamsOf("utility")["dcBlock"]).toBe(0);
  });

  it("bassBuss exposes subOsc", () => {
    expect(defaultParamsOf("bassBuss")["subOsc"]).toBe(0);
  });
});
