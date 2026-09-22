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

function loadProcessor(): Processor {
  const source = readFileSync(resolve(process.cwd(), "src/audio-worklets/generative-player-processor.js"), "utf8");
  let captured: Processor | undefined;
  const host = new Function("registerProcessor", "AudioWorkletProcessor", source) as (
    register: (name: string, processor: Processor) => void,
    base: typeof FakeAudioWorkletProcessor,
  ) => void;
  host((name, processor) => {
    if (name === "generative-player") captured = processor;
  }, FakeAudioWorkletProcessor);
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
});
