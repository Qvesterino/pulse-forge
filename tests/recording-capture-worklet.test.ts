import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "public/recording-capture-worklet.js"), "utf8");

function createProcessor() {
  let Processor: new (options: unknown) => any;
  let frame = 0;
  class FakeAudioWorkletProcessor {
    port: {
      onmessage: ((event: { data: unknown }) => void) | null;
      postMessage: (message: any, transfer?: Transferable[]) => void;
    };
    messages: any[] = [];

    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (message) => this.messages.push(message),
      };
    }
  }
  const sandbox = {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    sampleRate: 48_000,
    registerProcessor: (_name: string, processor: new (options: unknown) => any) => {
      Processor = processor;
    },
  };
  Object.defineProperty(sandbox, "currentFrame", { get: () => frame });
  runInNewContext(source, sandbox);
  const instance = new Processor!({ processorOptions: { chunkFrames: 128 } });
  instance.setCurrentFrame = (nextFrame: number) => {
    frame = nextFrame;
  };
  return instance;
}

function renderQuantum(processor: any, input: Float32Array) {
  const output = [new Float32Array(128), new Float32Array(128)];
  const activeInput = input.length === 128 ? input : new Float32Array(128);
  const keepAlive = processor.process([[activeInput]], [output]);
  return { output, keepAlive };
}

describe("recording AudioWorklet PCM protocol", () => {
  it("emits exact transferred float blocks and a final partial block while its output stays silent", () => {
    const processor = createProcessor();
    const silence = new Float32Array(128).fill(1);
    const input = new Float32Array(128).map((_, index) => index / 64 - 1);

    renderQuantum(processor, silence);
    expect(processor.messages[0]).toMatchObject({ type: "ready", channels: 1, sampleRate: 48_000 });
    processor.port.onmessage!({ data: { type: "start" } });
    const first = renderQuantum(processor, input);
    expect(first.output.every((channel: Float32Array) => channel.every((sample) => sample === 0))).toBe(true);
    expect(processor.messages[1]).toMatchObject({ type: "chunk", sequence: 0, frames: 128 });
    expect(Array.from(new Float32Array(processor.messages[1].channels[0])).slice(0, 4)).toEqual([
      -1, -0.984375, -0.96875, -0.953125,
    ]);

    processor.port.onmessage!({ data: { type: "ack", sequence: 0 } });
    const partialInput = new Float32Array(32).fill(0.375);
    processor.process([[partialInput]], [[new Float32Array(128), new Float32Array(128)]]);
    processor.port.onmessage!({ data: { type: "stop" } });
    expect(processor.messages[2]).toMatchObject({ type: "chunk", sequence: 1, frames: 32 });
    expect(Array.from(new Float32Array(processor.messages[2].channels[0])).every((sample) => sample === 0.375)).toBe(
      true,
    );
    expect(processor.messages[3]).toMatchObject({ type: "stopped", sequence: 2 });
  });

  it("bounds unacknowledged chunks and reports backpressure instead of growing memory without limit", () => {
    const processor = createProcessor();
    renderQuantum(processor, new Float32Array(128)); // initializes channel contract
    processor.port.onmessage!({ data: { type: "start" } });
    for (let i = 0; i < 4; i++) {
      const result = renderQuantum(processor, new Float32Array(128).fill(i));
      if (i < 3) expect(result.keepAlive).toBe(true);
      else expect(result.keepAlive).toBe(false);
    }
    expect(processor.messages.filter((message: any) => message.type === "chunk")).toHaveLength(3);
    expect(
      processor.messages.some((message: any) => message.type === "error" && /could not keep up/i.test(message.reason)),
    ).toBe(true);
  });

  it("stops instead of clamping a loop boundary that arrived after its audio frame", () => {
    const processor = createProcessor();
    renderQuantum(processor, new Float32Array(128));
    processor.port.onmessage!({ data: { type: "start", loopCapture: true } });
    processor.setCurrentFrame(256);

    processor.port.onmessage!({ data: { type: "take-boundary", atTime: 128 / 48_000 } });

    expect(processor.messages.find((message: any) => message.type === "error")?.reason).toMatch(/reached .* too late/i);
    expect(processor.stopped).toBe(true);
    expect(processor.takeBoundaryFrames).toEqual([0]);
  });

  it("retracts a queued loop boundary before the capture frame reaches it", () => {
    const processor = createProcessor();
    renderQuantum(processor, new Float32Array(128));
    processor.port.onmessage!({ data: { type: "start", loopCapture: true } });
    processor.port.onmessage!({ data: { type: "take-boundary", atTime: 1 } });
    processor.port.onmessage!({ data: { type: "cancel-take-boundary", atTime: 1 } });

    expect(processor.takeBoundaryFrames).toEqual([0]);
    expect(processor.messages.some((message: any) => message.type === "error")).toBe(false);
  });

  it("flushes and stops at the exact punch-out frame inside a render quantum", () => {
    const processor = createProcessor();
    renderQuantum(processor, new Float32Array(128));
    processor.port.onmessage!({ data: { type: "start", punchInNow: true } });
    renderQuantum(processor, new Float32Array(128).fill(0.25));
    processor.port.onmessage!({ data: { type: "stop-at", atTime: 200 / 48_000 } });
    processor.setCurrentFrame(128);

    const result = renderQuantum(processor, new Float32Array(128).fill(0.5));
    const chunks = processor.messages.filter((message: any) => message.type === "chunk");
    const stopped = processor.messages.find((message: any) => message.type === "stopped");

    expect(result.keepAlive).toBe(false);
    expect(chunks.map((chunk: any) => chunk.frames)).toEqual([128, 72]);
    expect(chunks.reduce((total: number, chunk: any) => total + chunk.frames, 0)).toBe(200);
    expect(chunks[0]?.takeBoundaries).toEqual([0]);
    expect(chunks[1]?.punchOut).toBe(true);
    expect(stopped).toMatchObject({ reason: "punch-out", sequence: 2 });
  });

  it("cancels a queued punch-out before its target frame", () => {
    const processor = createProcessor();
    renderQuantum(processor, new Float32Array(128));
    processor.port.onmessage!({ data: { type: "start" } });
    processor.port.onmessage!({ data: { type: "stop-at", atTime: 1 } });
    processor.port.onmessage!({ data: { type: "cancel-stop-at", atTime: 1 } });

    expect(processor.stopAtFrame).toBeNull();
    expect(processor.messages.some((message: any) => message.type === "error")).toBe(false);
  });
});
