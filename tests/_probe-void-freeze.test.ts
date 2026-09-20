import { beforeAll, describe, expect, it } from "vitest";

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: unknown[] = [];
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}
interface ProcShape {
  port: FakePort;
  state: {
    global: Record<string, unknown>;
    engines: { e2: Record<string, unknown>; e3: Record<string, unknown> };
    [key: string]: unknown;
  };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcCtor = new (options?: unknown) => ProcShape;

let Processor: ProcCtor;
let now = 0;
beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (_n: string, cls: ProcCtor) => {
    Processor = cls;
  };
  Object.defineProperty(globalThis, "currentTime", { get: () => now, configurable: true });
  await import("../src/effects/ozvena-worklet.entry.js");
});

const SR = 48000;
const BLOCK = 128;

function makeRng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function render(proc: ProcShape, seconds: number, seed = 0x5eed): Float32Array[] {
  const rng = makeRng(seed);
  const blocks = Math.ceil((seconds * SR) / BLOCK);
  const outL = new Float32Array(blocks * BLOCK);
  const outR = new Float32Array(blocks * BLOCK);
  for (let b = 0; b < blocks; b++) {
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    if (b * BLOCK < 0.3 * SR) {
      inL[0] = (rng() * 2 - 1) * 0.5;
      inR[0] = (rng() * 2 - 1) * 0.5;
    }
    proc.process(
      [[inL, inR]],
      [[outL.subarray(b * BLOCK, b * BLOCK + BLOCK), outR.subarray(b * BLOCK, b * BLOCK + BLOCK)]],
    );
    now = ((b + 1) * BLOCK) / SR;
  }
  return [outL, outR];
}

function rms(chans: Float32Array[], fromSec: number, toSec: number): number {
  const from = Math.floor(fromSec * SR);
  const to = Math.min(chans[0].length, Math.floor(toSec * SR));
  let sum = 0;
  let n = 0;
  for (const ch of chans)
    for (let i = from; i < to; i++) {
      sum += ch[i] * ch[i];
      n++;
    }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

function peak(chans: Float32Array[], fromSec: number, toSec: number): number {
  const from = Math.floor(fromSec * SR);
  const to = Math.min(chans[0].length, Math.floor(toSec * SR));
  let m = 0;
  for (const ch of chans) for (let i = from; i < to; i++) m = Math.max(m, Math.abs(ch[i]));
  return m;
}

const sendParam = (proc: ProcShape, id: string, value: unknown) => proc.port.onmessage?.({ data: { type: "param", id, value } });

describe("VØID freeze runaway", () => {
  it("E2 freeze with bassDecay 2 holds instead of pinning the limiter", () => {
    const proc = new Processor();
    sendParam(proc, "engines.e1.enabled", 0);
    sendParam(proc, "engines.e2.enabled", 1);
    sendParam(proc, "engines.e3.enabled", 0);
    sendParam(proc, "engines.e2.bassDecay", 2);
    sendParam(proc, "engines.e2.time", 1400);
    sendParam(proc, "engines.e2.mix", 100);
    sendParam(proc, "blendPad.x", 0);
    sendParam(proc, "blendPad.y", 0);
    sendParam(proc, "preDelay.ms", 0);
    sendParam(proc, "global.freeze", 1);
    const out = render(proc, 6);
    console.log("E2 freeze rms 2-3s:", rms(out, 2, 3).toFixed(4));
    console.log("E2 freeze rms 5-6s:", rms(out, 5, 6).toFixed(4));
    console.log("E2 freeze peak:", peak(out, 0, 6).toFixed(4));
    expect(countNonFinite(out)).toBe(0);
  });

  it("E3 freeze with bassDecay 4 holds", () => {
    const proc = new Processor();
    sendParam(proc, "engines.e1.enabled", 0);
    sendParam(proc, "engines.e2.enabled", 0);
    sendParam(proc, "engines.e3.enabled", 1);
    sendParam(proc, "engines.e3.bassDecay", 4);
    sendParam(proc, "engines.e3.time", 5000);
    sendParam(proc, "engines.e3.mix", 100);
    sendParam(proc, "blendPad.x", 1);
    sendParam(proc, "blendPad.y", 1);
    sendParam(proc, "preDelay.ms", 0);
    sendParam(proc, "global.freeze", 1);
    const out = render(proc, 6);
    console.log("E3 freeze rms 2-3s:", rms(out, 2, 3).toFixed(4));
    console.log("E3 freeze rms 5-6s:", rms(out, 5, 6).toFixed(4));
    console.log("E3 freeze peak:", peak(out, 0, 6).toFixed(4));
    expect(countNonFinite(out)).toBe(0);
  });
});

function countNonFinite(chans: Float32Array[]): number {
  let bad = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) bad++;
  return bad;
}
