import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: Array<{ message: unknown; transfer: unknown[] }> = [];
  started = false;

  postMessage(message: unknown, transfer: unknown[] = []) {
    this.posted.push({ message, transfer });
  }

  start() {
    this.started = true;
  }
}

describe("Windows audio I/O worklet bridge", () => {
  it("batches stereo render at the requested period and plays bounded native capture packets", () => {
    const source = readFileSync(resolve(process.cwd(), "public/windows-audio-io-bridge.js"), "utf8");
    let Processor: new (options: Record<string, unknown>) => {
      port: FakePort;
      process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
      receiveNative(message: unknown): void;
      counters(): { freeRenderBuffers: number };
    };
    const registered = new Map<string, new (options: Record<string, unknown>) => unknown>();
    const audioWorkletBase = class {
      port = new FakePort();
    };
    const scope = {
      AudioWorkletProcessor: audioWorkletBase,
      ArrayBuffer,
      Float32Array,
      Number,
      Math,
      registerProcessor: (name: string, processor: new (options: Record<string, unknown>) => unknown) =>
        registered.set(name, processor),
      sampleRate: 48_000,
      currentFrame: 0,
    };
    runInNewContext(source, scope);
    const Registered = registered.get("kyx-windows-audio-io-bridge");
    if (!Registered) throw new Error("Windows audio worklet did not register");
    Processor = Registered as typeof Processor;
    const processor = new Processor({
      processorOptions: { sessionId: "session-1", periodFrames: 480, captureChannels: 2, poolSize: 4 },
    });
    const nativePort = new FakePort();
    processor.port.onmessage?.({ data: { type: "attach", port: nativePort } });
    expect(nativePort.posted[0]?.message).toEqual({ type: "bridge-ready", sessionId: "session-1" });
    nativePort.onmessage?.({
      data: {
        type: "ready",
        sessionId: "session-1",
        sampleRateHz: 48_000,
        periodFrames: 480,
        captureChannels: 2,
        renderChannels: 2,
        negotiation: { sampleRateHz: 48_000 },
      },
    });

    for (let quantum = 0; quantum < 4; quantum++) {
      const left = new Float32Array(128).fill(quantum + 1);
      const right = new Float32Array(128).fill(-(quantum + 1));
      const outputs = [
        [new Float32Array(128), new Float32Array(128)],
        [new Float32Array(128), new Float32Array(128)],
      ];
      expect(processor.process([[left, right]], outputs)).toBe(true);
      expect(outputs[0]?.every((channel) => channel.every((sample) => sample === 0))).toBe(true);
      scope.currentFrame += 128;
    }

    const render = nativePort.posted.find((entry) => (entry.message as { type?: string }).type === "render")
      ?.message as { sequence: number; frames: number; channels: number; samples: ArrayBuffer } | undefined;
    expect(render).toMatchObject({ sequence: 0, frames: 480, channels: 2 });
    expect(nativePort.posted.find((entry) => (entry.message as { type?: string }).type === "render")?.transfer).toEqual(
      [],
    );
    const rendered = new Float32Array(render!.samples);
    expect(rendered[0]).toBe(1);
    expect(rendered[rendered.length - 1]).toBe(-4);
    processor.receiveNative({ type: "recycle-render", sessionId: "session-1", sequence: render!.sequence });
    expect(processor.counters().freeRenderBuffers).toBe(3);

    const captureBuffer = new ArrayBuffer(480 * 2 * Float32Array.BYTES_PER_ELEMENT);
    const captureSamples = new Float32Array(captureBuffer);
    captureSamples.set([0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1, -1]);
    nativePort.onmessage?.({
      data: { type: "capture", sessionId: "session-1", sequence: 0, frames: 4, samples: captureBuffer },
    });
    const captureOutputs = [
      [new Float32Array(128), new Float32Array(128)],
      [new Float32Array(128), new Float32Array(128)],
    ];
    processor.process([[new Float32Array(128), new Float32Array(128)]], captureOutputs);
    expect(Array.from(captureOutputs[1]![0]!.slice(0, 4))).toEqual([0.25, 0.5, 0.75, 1]);
    expect(Array.from(captureOutputs[1]![1]!.slice(0, 4))).toEqual([-0.25, -0.5, -0.75, -1]);
    const returned = nativePort.posted.find((entry) => (entry.message as { type?: string }).type === "recycle-capture");
    expect(returned?.message).toEqual({ type: "recycle-capture", sessionId: "session-1", sequence: 0 });
    expect(returned?.transfer).toEqual([]);
  });

  it("rejects a capture packet from another session and reports a stale native heartbeat", () => {
    const source = readFileSync(resolve(process.cwd(), "public/windows-audio-io-bridge.js"), "utf8");
    const registered = new Map<string, new (options: Record<string, unknown>) => unknown>();
    class WorkletBase {
      port = new FakePort();
    }
    const scope = {
      AudioWorkletProcessor: WorkletBase,
      ArrayBuffer,
      Float32Array,
      Number,
      Math,
      registerProcessor: (name: string, processor: new (options: Record<string, unknown>) => unknown) =>
        registered.set(name, processor),
      sampleRate: 48_000,
      currentFrame: 0,
    };
    runInNewContext(source, scope);
    const Registered = registered.get("kyx-windows-audio-io-bridge");
    if (!Registered) throw new Error("Windows audio worklet did not register");
    const processor = new (
      Registered as new (options: Record<string, unknown>) => {
        port: FakePort;
        process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
        receiveNative(message: unknown): void;
      }
    )({ processorOptions: { sessionId: "session-2", periodFrames: 480, captureChannels: 1, poolSize: 2 } });
    const nativePort = new FakePort();
    processor.port.onmessage?.({ data: { type: "attach", port: nativePort } });
    processor.receiveNative({
      type: "ready",
      sessionId: "session-2",
      sampleRateHz: 48_000,
      periodFrames: 480,
      captureChannels: 1,
      renderChannels: 2,
      negotiation: {},
    });
    const wrongSession = new ArrayBuffer(480 * Float32Array.BYTES_PER_ELEMENT);
    processor.receiveNative({ type: "capture", sessionId: "old-session", frames: 480, samples: wrongSession });
    expect(processor.port.posted.some((entry) => (entry.message as { type?: string }).type === "error")).toBe(false);
    scope.currentFrame = 48_001 * 2;
    processor.process(
      [[new Float32Array(128), new Float32Array(128)]],
      [[new Float32Array(128), new Float32Array(128)], [new Float32Array(128)]],
    );
    expect(
      processor.port.posted.some((entry) => (entry.message as { message?: string }).message?.includes("two seconds")),
    ).toBe(true);
  });
});
