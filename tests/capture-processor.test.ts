import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type CaptureMessage = {
  type?: string;
  time?: number;
  frame?: number;
  sampleRate?: number;
  chunkFrames?: number;
  captureFrames?: number;
  startFrame?: number;
  frames?: number;
  left?: Float32Array;
  right?: Float32Array;
};

type CapturePort = {
  onmessage: ((event: { data: CaptureMessage }) => void) | null;
  postMessage(message: CaptureMessage, transfer?: Transferable[]): void;
};

type CaptureProcessor = {
  port: CapturePort;
  process(inputs: Float32Array[][]): boolean;
};

type ProcessorOptions = { processorOptions?: { chunkFrames?: number; captureFrames?: number } };

let Processor: new (options?: ProcessorOptions) => CaptureProcessor;
let messages: CaptureMessage[] = [];

beforeAll(() => {
  const globals = globalThis as unknown as { sampleRate: number; currentTime: number; currentFrame: number };
  globals.sampleRate = 44100;
  const file = join(dirname(fileURLToPath(import.meta.url)), "../src/audio-worklets/capture-processor.js");
  const source = readFileSync(file, "utf8");
  let registered: (new (options?: ProcessorOptions) => CaptureProcessor) | null = null;
  const registerProcessor = (_name: string, processor: new (options?: ProcessorOptions) => CaptureProcessor) => {
    registered = processor;
  };
  class AudioWorkletProcessor {
    port: CapturePort = {
      onmessage: null,
      postMessage(message) {
        messages.push(message);
      },
    };
  }
  new Function("registerProcessor", "AudioWorkletProcessor", source)(
    registerProcessor,
    AudioWorkletProcessor as unknown as object,
  );
  if (!registered) throw new Error("capture-processor did not register");
  Processor = registered;
});

beforeEach(() => {
  messages = [];
  const globals = globalThis as unknown as { sampleRate: number; currentTime: number; currentFrame: number };
  globals.currentFrame = 8192;
  globals.currentTime = globals.currentFrame / globals.sampleRate;
});

describe("parity capture worklet", () => {
  it("starts at the requested audio frame, then flushes the exact final partial chunk", () => {
    const processor = new Processor();
    processor.port.onmessage?.({ data: { type: "arm", chunkFrames: 256, captureFrames: 300, startFrame: 8448 } });
    const left = new Float32Array(128).fill(0.25);
    const right = new Float32Array(128).fill(-0.25);
    const globals = globalThis as unknown as { sampleRate: number; currentTime: number; currentFrame: number };

    for (let block = 0; block < 2; block++) {
      processor.process([[left, right]]);
      globals.currentFrame += 128;
      globals.currentTime += 128 / globals.sampleRate;
    }
    expect(messages).toHaveLength(0);

    for (let block = 0; block < 3; block++) {
      processor.process([[left, right]]);
      globals.currentFrame += 128;
      globals.currentTime += 128 / globals.sampleRate;
    }

    expect(messages[0]).toMatchObject({ type: "capture-start", time: 8448 / 44100, frame: 8448, sampleRate: 44100 });
    const chunks = messages.filter((message) => message.type === "chunk");
    expect(chunks.map((chunk) => chunk.frames)).toEqual([256, 44]);
    expect(chunks.reduce((sum, chunk) => sum + (chunk.frames ?? 0), 0)).toBe(300);
    expect(chunks[0]?.left).toEqual(new Float32Array(256).fill(0.25));
    expect(chunks[0]?.right).toEqual(new Float32Array(256).fill(-0.25));
    expect(messages.at(-1)).toMatchObject({ type: "capture-done", frames: 300 });

    const messageCount = messages.length;
    processor.process([[left, right]]);
    expect(messages).toHaveLength(messageCount);
  });

  it("keeps manual stop compatible when no frame target was requested", () => {
    const processor = new Processor();
    processor.port.onmessage?.({ data: { type: "arm", chunkFrames: 256 } });
    processor.process([[new Float32Array(128).fill(0.5)]]);
    processor.port.onmessage?.({ data: { type: "stop" } });

    const chunk = messages.find((message) => message.type === "chunk");
    expect(chunk?.frames).toBe(128);
    expect(messages.at(-1)).toMatchObject({ type: "capture-done", frames: 128 });
  });
});
