import { beforeAll, describe, expect, it } from "vitest";
import { createPolyphaseOversampler } from "../src/effects/ozvena-core/dsp/oversampler.js";

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
const sendParam = (proc: ProcShape, id: string, value: unknown) => proc.port.onmessage?.({ data: { type: "param", id, value } });

describe("quality-switch click probe", () => {
  it("logs os.latencySamples per factor", () => {
    for (const f of [1, 2, 4, 8] as const) {
      const os = createPolyphaseOversampler();
      os.prepare(SR, f);
      console.log(`factor ${f}: latencySamples = ${os.latencySamples}`);
    }
    expect(true).toBe(true);
  });

  it("measures max step at switch on dry 200 Hz sine", () => {
    const proc = new Processor();
    sendParam(proc, "global.dryWet", 0);
    sendParam(proc, "preDelay.enabled", 0);
    sendParam(proc, "smoother.enabled", 0);
    sendParam(proc, "engines.e1.enabled", 0);
    sendParam(proc, "engines.e2.enabled", 0);
    sendParam(proc, "engines.e3.enabled", 0);
    const blocks = Math.ceil((0.5 * SR) / BLOCK);
    const out = new Float32Array(blocks * BLOCK);
    const switchBlock = Math.floor(blocks * 0.6);
    let maxStep = 0;
    let stepAtSwitch = 0;
    let prev = 0;
    for (let b = 0; b < blocks; b++) {
      if (b === switchBlock) sendParam(proc, "global.quality", 2);
      const inL = new Float32Array(BLOCK);
      const inR = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        const s = b * BLOCK + i;
        inL[i] = 0.4 * Math.sin((2 * Math.PI * 200 * s) / SR);
        inR[i] = inL[i];
      }
      const oL = out.subarray(b * BLOCK, b * BLOCK + BLOCK);
      proc.process([[inL, inR]], [[oL, new Float32Array(BLOCK)]]);
      for (let i = 0; i < BLOCK; i++) {
        const step = Math.abs(oL[i] - prev);
        if (step > maxStep) maxStep = step;
        if (b === switchBlock || b === switchBlock + 1) stepAtSwitch = Math.max(stepAtSwitch, step);
        prev = oL[i];
      }
      now = ((b + 1) * BLOCK) / SR;
    }
    console.log("natural slope:", (0.4 * Math.sin((2 * Math.PI * 200) / SR)).toFixed(5));
    console.log("maxStep:", maxStep.toFixed(5), "stepAtSwitch:", stepAtSwitch.toFixed(5));
    expect(true).toBe(true);
  });
});
