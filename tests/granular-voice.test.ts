import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the RAW granular-voice-processor.js (the exact script served to
 * AudioWorklet.addModule) inside Node: `currentTime` comes from a getter on
 * globalThis, the processor gets a mock message port, and audio runs through
 * 128-sample blocks like the real render loop. Same harness pattern as
 * wtvoice.test.ts — no OfflineAudioContext needed.
 */
type Proc = {
  process(inputs: unknown, outputs: Float32Array[][]): boolean;
  handleMessage: (msg: Record<string, unknown>) => void;
};

let Processor: new () => Proc;
let now = 0;
const SR = 44100;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  Object.defineProperty(globalThis, "currentTime", {
    get: () => now,
    configurable: true,
  });
  const file = join(dirname(fileURLToPath(import.meta.url)), "../src/audio-worklets/granular-voice-processor.js");
  const src = readFileSync(file, "utf8");
  let registered: (new () => Proc) | null = null;
  const registerProcessor = (_name: string, cls: new () => Proc) => {
    registered = cls;
  };
  class AudioWorkletProcessor {
    port = { onmessage: null as unknown, postMessage: (_m: unknown) => {} };
  }
  new Function("registerProcessor", "AudioWorkletProcessor", src)(
    registerProcessor,
    AudioWorkletProcessor as unknown as object,
  );
  if (!registered) throw new Error("granular-voice-processor did not register");
  Processor = registered;
});

/** Deterministic pseudo-noise "sample": 0.5 s, sine sweep — structured so grains are audible. */
function makeSample(): { ch0: Float32Array; ch1: Float32Array } {
  const n = Math.floor(SR * 0.5);
  const ch0 = new Float32Array(n);
  const ch1 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = 220 + (440 * i) / n;
    ch0[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / SR);
    ch1[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / SR + Math.PI / 4);
  }
  return { ch0, ch1 };
}

interface RunEvent {
  at: number;
  msg: Record<string, unknown>;
}

/** Render the processor: messages before t=0 up front, others mid-render. */
function run(
  params: Record<string, number>,
  notes: Array<{ pitch: number; velocity: number; when: number; dur: number }>,
  duration: number,
  midEvents: RunEvent[] = [],
): { outL: Float32Array; outR: Float32Array } {
  const proc = new Processor();
  const sample = makeSample();
  now = 0;
  proc.handleMessage({ type: "sample", ch0: sample.ch0, ch1: sample.ch1, sampleRate: SR });
  for (const [name, value] of Object.entries(params)) {
    proc.handleMessage({ type: "param", name, value });
  }
  proc.handleMessage({ type: "bpm", value: 124 });
  for (const n of notes) {
    proc.handleMessage({
      type: "noteOn",
      pitch: n.pitch,
      velocity: n.velocity,
      when: n.when,
      dur: n.dur,
      seed: 12345 + n.pitch,
    });
    proc.handleMessage({ type: "noteOff", pitch: n.pitch, when: n.when + n.dur });
  }
  const deferred = midEvents.map((e) => ({ ...e, done: false }));

  const total = Math.ceil(duration * SR);
  const outL = new Float32Array(total);
  const outR = new Float32Array(total);
  for (let start = 0; start < total; start += BLOCK) {
    const size = Math.min(BLOCK, total - start);
    const blockL = new Float32Array(size);
    const blockR = new Float32Array(size);
    for (const d of deferred) {
      if (!d.done && now >= d.at) {
        d.done = true;
        proc.handleMessage(d.msg);
      }
    }
    proc.process([], [[blockL, blockR]]);
    outL.set(blockL, start);
    outR.set(blockR, start);
    now = (start + BLOCK) / SR;
  }
  return { outL, outR };
}

function peak(data: Float32Array, from = 0, to = data.length): number {
  let v = 0;
  for (let i = from; i < to; i++) v = Math.max(v, Math.abs(data[i]));
  return v;
}

function diff(a: Float32Array, b: Float32Array, from = 0, to = a.length): number {
  let d = 0;
  for (let i = from; i < to && i < b.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

describe("granular voice worklet engine", () => {
  it("renders audible, bounded grains and releases after noteOff", () => {
    const { outL } = run({}, [{ pitch: 60, velocity: 0.9, when: 0.05, dur: 0.4 }], 1.2);
    expect(peak(outL)).toBeGreaterThan(0.001);
    expect(peak(outL)).toBeLessThanOrEqual(2);
    // released: tail decays to (near) silence
    expect(peak(outL, Math.floor(1.05 * SR))).toBeLessThan(0.02);
  });

  it("is deterministic — identical message sequences render bit-identically", () => {
    const notes = [
      { pitch: 60, velocity: 0.9, when: 0.05, dur: 0.3 },
      { pitch: 67, velocity: 0.7, when: 0.1, dur: 0.35 },
    ];
    const a = run({ scan: 0.4, jitter: 0.3, pRand: 5 }, notes, 1.0);
    const b = run({ scan: 0.4, jitter: 0.3, pRand: 5 }, notes, 1.0);
    expect(diff(a.outL, b.outL)).toBe(0);
    expect(diff(a.outR, b.outR)).toBe(0);
  });

  it("LIVE PLAYHEAD: dragging POSITION mid-note steers future grains", () => {
    const notes = [{ pitch: 60, velocity: 0.9, when: 0.05, dur: 0.8 }];
    const base = run({ jitter: 0 }, notes, 1.2);
    const dragged = run({ jitter: 0 }, notes, 1.2, [
      { at: 0.4, msg: { type: "param", name: "position", value: 0.85 } },
    ]);
    // before the drag the renders are identical
    expect(diff(base.outL, dragged.outL, 0, Math.floor(0.4 * SR))).toBe(0);
    // after the drag they differ — the playhead moved mid-note
    expect(diff(base.outL, dragged.outL, Math.floor(0.5 * SR))).toBeGreaterThan(0.001);
  });

  it("RATE change mid-note changes grain density of the held note", () => {
    const notes = [{ pitch: 60, velocity: 0.9, when: 0.05, dur: 0.9 }];
    const base = run({}, notes, 1.4);
    const slowed = run({}, notes, 1.4, [{ at: 0.3, msg: { type: "param", name: "rate", value: 2 } }]);
    expect(diff(base.outL, slowed.outL, Math.floor(0.45 * SR))).toBeGreaterThan(0.001);
  });

  it("pan spreads energy across channels", () => {
    const { outL, outR } = run({ spread: 1 }, [{ pitch: 60, velocity: 0.9, when: 0.05, dur: 0.5 }], 1.0);
    expect(peak(outL)).toBeGreaterThan(0.001);
    expect(peak(outR)).toBeGreaterThan(0.001);
    let same = 0;
    const n = Math.min(outL.length, outR.length);
    for (let i = 0; i < n; i++) if (outL[i] === outR[i]) same++;
    expect(same / n).toBeLessThan(0.9);
  });

  it("panic silences instantly and edge-clamped offsets stay bounded", () => {
    const notes = [{ pitch: 60, velocity: 0.9, when: 0.05, dur: 0.5 }];
    const pannic = run({ position: 0.999 }, notes, 0.6, [{ at: 0.2, msg: { type: "panic" } }]);
    expect(peak(pannic.outL, Math.floor(0.35 * SR))).toBeLessThan(0.001);
    const edge = run({ position: 1 }, notes, 0.8);
    expect(peak(edge.outL)).toBeLessThanOrEqual(2);
  });
});
