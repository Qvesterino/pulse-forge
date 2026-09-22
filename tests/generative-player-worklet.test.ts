import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface FakePort {
  onmessage: ((event: MessageEvent) => void) | null;
  messages: unknown[];
  postMessage(message: unknown): void;
}

class FakeAudioWorkletProcessor {
  readonly port: FakePort = {
    onmessage: null,
    messages: [],
    postMessage: (message) => this.port.messages.push(message),
  };
}

type Processor = new (options?: { processorOptions?: Record<string, unknown> }) => {
  port: FakePort;
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
};

function loadProcessor(outputSampleRate = 48000): Processor {
  const source = readFileSync(resolve(process.cwd(), "src/audio-worklets/generative-player-processor.js"), "utf8");
  const runtime = globalThis as typeof globalThis & { sampleRate?: number };
  const previousSampleRate = runtime.sampleRate;
  runtime.sampleRate = outputSampleRate;
  let captured: Processor | undefined;
  const host = new Function("registerProcessor", "AudioWorkletProcessor", source) as (
    register: (name: string, processor: Processor) => void,
    base: typeof FakeAudioWorkletProcessor,
  ) => void;
  host((name, processor) => {
    if (name === "generative-player") captured = processor;
  }, FakeAudioWorkletProcessor);
  runtime.sampleRate = previousSampleRate;
  if (!captured) throw new Error("generative player processor was not registered");
  return captured;
}

function send(processor: InstanceType<Processor>, data: Float32Array, sequence: number, channels = 2): void {
  processor.port.onmessage?.({
    data: {
      type: "chunk",
      sequence,
      sampleRate: 48000,
      channels,
      frames: data.length / channels,
      data,
    },
  } as MessageEvent);
}

describe("generative player AudioWorklet", () => {
  it("zero-fills underruns and reports recovery", () => {
    const Processor = loadProcessor();
    const processor = new Processor({ processorOptions: { channels: 2, maxFrames: 4 } });
    send(processor, new Float32Array([1, 10, 2, 20]), 0);
    const left = new Float32Array(3);
    const right = new Float32Array(3);
    processor.process([], [[left, right]]);

    expect([...left]).toEqual([1, 2, 0]);
    expect([...right]).toEqual([10, 20, 0]);
    expect(processor.port.messages).toContainEqual({ type: "underrun", missingFrames: 1 });

    send(processor, new Float32Array([3, 30]), 1);
    expect(processor.port.messages).toContainEqual({ type: "recovered", queuedFrames: 1 });
  });

  it("drops oldest frames at the fixed capacity and reports sequence gaps", () => {
    const Processor = loadProcessor();
    const processor = new Processor({ processorOptions: { channels: 2, maxFrames: 128 } });
    const first = new Float32Array(129 * 2);
    for (let frame = 0; frame < 129; frame++) {
      first[frame * 2] = frame + 1;
      first[frame * 2 + 1] = (frame + 1) * 10;
    }
    send(processor, first, 0);
    send(processor, new Float32Array([130, 1300]), 2);
    const left = new Float32Array(2);
    const right = new Float32Array(2);
    processor.process([], [[left, right]]);

    expect([...left]).toEqual([3, 4]);
    expect([...right]).toEqual([30, 40]);
    expect(processor.port.messages).toContainEqual({ type: "overrun", droppedFrames: 1 });
    expect(processor.port.messages).toContainEqual({ type: "sequence-gap", expected: 1, received: 2 });
  });

  it("duplicates mono provider chunks into the stereo output", () => {
    const Processor = loadProcessor();
    const processor = new Processor({ processorOptions: { channels: 2, maxFrames: 4 } });
    send(processor, new Float32Array([0.25, -0.5]), 0, 1);
    const left = new Float32Array(2);
    const right = new Float32Array(2);
    processor.process([], [[left, right]]);

    expect([...left]).toEqual([0.25, -0.5]);
    expect([...right]).toEqual([0.25, -0.5]);
  });

  it("adapts 48 kHz provider frames to the AudioContext sample rate", () => {
    const Processor = loadProcessor(44100);
    const processor = new Processor({ processorOptions: { channels: 2, maxFrames: 8, outputSampleRate: 44100 } });
    send(processor, new Float32Array([0, 0, 1, 1, 2, 2, 3, 3]), 0);
    const left = new Float32Array(3);
    const right = new Float32Array(3);
    processor.process([], [[left, right]]);

    expect(left[0]).toBeCloseTo(0, 6);
    expect(left[1]).toBeGreaterThan(1);
    expect(left[1]).toBeLessThan(1.2);
    expect([...left]).toEqual([...right]);
  });

  it("rejects a provider sample-rate change inside one live session", () => {
    const Processor = loadProcessor();
    const processor = new Processor({ processorOptions: { channels: 2, maxFrames: 8 } });
    send(processor, new Float32Array([0.1, 0.1]), 0);
    processor.port.onmessage?.({
      data: {
        type: "chunk",
        sequence: 1,
        sampleRate: 44100,
        channels: 2,
        frames: 1,
        data: new Float32Array([0.2, 0.2]),
      },
    } as MessageEvent);
    expect(processor.port.messages).toContainEqual({ type: "sample-rate-mismatch", expected: 48000, received: 44100 });
  });
});
