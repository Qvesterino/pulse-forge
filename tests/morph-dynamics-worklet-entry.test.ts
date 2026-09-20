import { beforeAll, describe, expect, it } from "vitest";
import { FeatureExtractor } from "../src/effects/morph-dynamics-core/dsp/analysis";
import { GLOBAL_INPUT_GAIN_DB_ID } from "../src/effects/morph-dynamics-core/contracts/parameterIds";

interface MorphMeters {
  inputPeakDb: number;
  outputPeakDb: number;
  inputEnergy: number;
}

interface PostedMessage {
  type?: string;
}

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: PostedMessage[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message as PostedMessage);
  }
}

class FakeAudioWorkletProcessor {
  port = new FakePort();
}

interface MorphWorklet {
  port: FakePort;
  proc: { getMeters(): MorphMeters };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type MorphWorkletCtor = new (options?: { processorOptions?: { params?: Record<string, number> } }) => MorphWorklet;

let Processor!: MorphWorkletCtor;
let workletTime = 0;

beforeAll(async () => {
  const scope = globalThis as typeof globalThis & {
    sampleRate: number;
    AudioWorkletProcessor: unknown;
    registerProcessor: unknown;
  };
  scope.sampleRate = 48_000;
  scope.AudioWorkletProcessor = FakeAudioWorkletProcessor;
  scope.registerProcessor = (_name: string, ctor: MorphWorkletCtor) => {
    Processor = ctor;
  };
  Object.defineProperty(globalThis, "currentTime", {
    get: () => workletTime,
    configurable: true,
  });
  // @ts-expect-error worklet entry is JavaScript bundled for AudioWorkletGlobalScope
  await import("../src/effects/morph-dynamics-worklet.entry.js");
  if (!Processor) throw new Error("morphdynamics-processor did not register");
});

const BLOCK = 128;

function processSine(proc: MorphWorklet, sampleRate: number, blocks: number, amplitude = 0.2): number {
  let outputEnergy = 0;
  let outputSamples = 0;
  for (let block = 0; block < blocks; block++) {
    const inputL = new Float32Array(BLOCK);
    const inputR = new Float32Array(BLOCK);
    const outputL = new Float32Array(BLOCK);
    const outputR = new Float32Array(BLOCK);
    for (let frame = 0; frame < BLOCK; frame++) {
      const time = (block * BLOCK + frame) / sampleRate;
      const sample = amplitude * Math.sin(2 * Math.PI * 440 * time);
      inputL[frame] = sample;
      inputR[frame] = sample;
    }
    proc.process([[inputL, inputR]], [[outputL, outputR]]);
    for (let frame = 0; frame < BLOCK; frame++) {
      expect(Number.isFinite(outputL[frame])).toBe(true);
      expect(Number.isFinite(outputR[frame])).toBe(true);
      outputEnergy += outputL[frame] ** 2 + outputR[frame] ** 2;
      outputSamples += 2;
    }
    workletTime = ((block + 1) * BLOCK) / sampleRate;
  }
  return Math.sqrt(outputEnergy / Math.max(1, outputSamples));
}

function analyzeSingleChannel(frequency: number, channel: "left" | "right"): { body: number; texture: number } {
  const extractor = new FeatureExtractor();
  extractor.prepare(48_000, 1);
  let signals = extractor.processFrame(0, 0);
  for (let frame = 0; frame < 12_000; frame++) {
    const sample = 0.5 * Math.sin((2 * Math.PI * frequency * frame) / 48_000);
    signals = extractor.processFrame(channel === "left" ? sample : 0, channel === "right" ? sample : 0);
  }
  return { body: signals.body, texture: signals.texture };
}

describe("Morph Dynamics worklet and analysis", () => {
  it.each([44_100, 48_000, 96_000])("initializes finite DSP at the host sample rate (%i Hz)", (sampleRate) => {
    (globalThis as typeof globalThis & { sampleRate: number }).sampleRate = sampleRate;
    workletTime = 0;
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: "setMeters", enabled: true } });

    const rms = processSine(proc, sampleRate, 24);

    expect(rms).toBeGreaterThan(0.02);
    expect(proc.proc.getMeters().inputPeakDb).toBeGreaterThan(-25);
  });

  it("keeps control analysis live while skipping closed-panel meter work", () => {
    (globalThis as typeof globalThis & { sampleRate: number }).sampleRate = 48_000;
    workletTime = 0;
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: "setMeters", enabled: false } });

    processSine(proc, 48_000, 24);

    expect(proc.proc.getMeters().inputEnergy).toBeGreaterThan(0);
    expect(proc.proc.getMeters().inputPeakDb).toBe(-100);
    expect(proc.port.posted.some((message) => message.type === "meters")).toBe(false);
  });

  it("glides an input-gain change at the audio block rate instead of snapping", () => {
    (globalThis as typeof globalThis & { sampleRate: number }).sampleRate = 48_000;
    workletTime = 0;
    const proc = new Processor();
    proc.port.onmessage?.({ data: { type: "setMeters", enabled: true } });
    proc.port.onmessage?.({ data: { type: "param", id: GLOBAL_INPUT_GAIN_DB_ID, value: -60 } });

    processSine(proc, 48_000, 1);

    // The 30 ms smoother should still be near unity after its first 2.67 ms
    // update. A missing control-rate initialization snaps this below −70 dB.
    expect(proc.proc.getMeters().inputPeakDb).toBeGreaterThan(-25);
  });

  it("analyzes body and texture equally when audio is isolated to either channel", () => {
    const lowLeft = analyzeSingleChannel(180, "left");
    const lowRight = analyzeSingleChannel(180, "right");
    const highLeft = analyzeSingleChannel(8_000, "left");
    const highRight = analyzeSingleChannel(8_000, "right");

    expect(lowLeft.body).toBeGreaterThan(0.05);
    expect(lowRight.body).toBeCloseTo(lowLeft.body, 5);
    expect(highLeft.texture).toBeGreaterThan(0.05);
    expect(highRight.texture).toBeCloseTo(highLeft.texture, 5);
  });
});
