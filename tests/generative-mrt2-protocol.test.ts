import { describe, expect, it } from "vitest";
import {
  decodeMrt2AudioPacket,
  encodeMrt2AudioPacket,
  parseMrt2ControlMessage,
  serializeMrt2ControlMessage,
  type Mrt2AudioPacket,
  type Mrt2CompanionEvent,
  type Mrt2CompanionTransport,
  type Mrt2ControlMessage,
  Mrt2CompanionProvider,
  isAllowedMrt2CompanionUrl,
} from "../src/generative";

class FakeTransport implements Mrt2CompanionTransport {
  private listener: ((event: Mrt2CompanionEvent) => void) | null = null;
  readonly binary: ArrayBuffer[] = [];
  private sequence = 0;
  bufferDuringCapture = false;
  supportsRealtime = true;
  startState: "starting" | "running" = "running";
  startMetrics?: {
    frameP95Ms: number;
    frameMeanMs: number;
    realtimeFactor: number;
    underrunCount: number;
    generatedFrames: number;
  };

  sendControl(message: Parameters<Mrt2CompanionTransport["sendControl"]>[0]): void {
    queueMicrotask(() => {
      switch (message.type) {
        case "hello":
          this.emit({
            kind: "control",
            message: {
              version: 1,
              type: "hello.ok",
              requestId: message.requestId,
              providerId: "mrt2",
              modelIds: ["mrt2_small"],
              outputSampleRates: [48_000],
              outputChannels: [2],
              supportsRealtime: this.supportsRealtime,
              supportsCapture: true,
              supportsTextStyle: true,
              supportsNoteConditioning: true,
              supportsAudioStyle: true,
              supportsDrumsMode: true,
              supportsSeed: false,
              maxCaptureSeconds: 120,
              runtimeProfile: {
                backendId: "test-companion",
                executionMode: this.supportsRealtime ? "realtime" : "capture",
                runtimeVersion: "test",
                measuredLatencyMs: 42,
                realtimeFactor: this.supportsRealtime ? 1.5 : 0.4,
              },
            },
          });
          break;
        case "session.create":
          this.emit({
            kind: "control",
            message: { version: 1, type: "session.ok", requestId: message.requestId, sessionId: "s1" },
          });
          break;
        case "input.update":
          this.emit({
            kind: "control",
            message: {
              version: 1,
              type: "status",
              requestId: message.requestId,
              sessionId: message.sessionId,
              state: "ready",
            },
          });
          break;
        case "session.start":
          this.emit({
            kind: "control",
            message: {
              version: 1,
              type: "status",
              requestId: message.requestId,
              sessionId: message.sessionId,
              state: this.startState,
              ...(this.startMetrics ? { metrics: this.startMetrics } : {}),
            },
          });
          break;
        case "session.stop":
        case "session.close":
          this.emit({
            kind: "control",
            message: {
              version: 1,
              type: "status",
              requestId: message.requestId,
              sessionId: message.sessionId,
              state: "ready",
            },
          });
          break;
        case "capture.start": {
          if (this.bufferDuringCapture) {
            this.emit({
              kind: "control",
              message: {
                version: 1,
                type: "status",
                sessionId: message.sessionId,
                state: "buffering",
                message: "inference underrun",
              },
            });
          }
          const packet: Mrt2AudioPacket = {
            kind: "output",
            sequence: this.sequence++,
            sampleRate: 48_000,
            channels: 2,
            frames: 2,
            data: new Float32Array([0.1, -0.1, 0.2, -0.2]),
          };
          this.emit({ kind: "audio", packet });
          this.emit({
            kind: "control",
            message: {
              version: 1,
              type: "capture.ok",
              requestId: message.requestId,
              sessionId: message.sessionId,
              frames: 2,
              durationSec: 2 / 48_000,
              inputHash: "capture-hash",
            },
          });
          break;
        }
        default:
          break;
      }
    });
  }

  sendBinary(packet: ArrayBuffer): void {
    this.binary.push(packet);
  }

  subscribe(listener: (event: Mrt2CompanionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  close(): void {
    this.emit({ kind: "closed", reason: "closed" });
  }

  disconnect(reason = "companion stopped"): void {
    this.emit({ kind: "closed", reason });
  }

  emitAudio(packet: unknown): void {
    this.emit({ kind: "audio", packet: packet as Mrt2AudioPacket });
  }

  emitControl(message: unknown): void {
    this.emit({ kind: "control", message: message as Mrt2ControlMessage });
  }

  private emit(event: Mrt2CompanionEvent): void {
    this.listener?.(event);
  }
}

class SilentTransport implements Mrt2CompanionTransport {
  sendControl(_message: Parameters<Mrt2CompanionTransport["sendControl"]>[0]): void {
    // Deliberately leave the request pending so the provider timeout is exercised.
  }

  sendBinary(_packet: ArrayBuffer): void {
    // No-op.
  }

  subscribe(_listener: (event: Mrt2CompanionEvent) => void): () => void {
    return () => undefined;
  }

  close(): void {
    // No-op.
  }
}

class DisconnectingTransport implements Mrt2CompanionTransport {
  private listener: ((event: Mrt2CompanionEvent) => void) | null = null;

  sendControl(_message: Parameters<Mrt2CompanionTransport["sendControl"]>[0]): void {
    queueMicrotask(() => this.listener?.({ kind: "closed", reason: "companion stopped" }));
  }

  sendBinary(_packet: ArrayBuffer): void {
    // No-op.
  }

  subscribe(listener: (event: Mrt2CompanionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  close(): void {
    this.listener = null;
  }
}

function input(style: "text" | "audio" = "text") {
  return {
    bpm: 120,
    frameRateHz: 25 as const,
    startTick: 0,
    style:
      style === "text"
        ? ({ kind: "text" as const, text: "dark atmospheric pad" } as const)
        : ({ kind: "audio" as const, sampleRate: 16_000, channels: [new Float32Array([0.1, 0.2, 0.3, 0.4])] } as const),
    noteFrames: [{ frameIndex: 0, pitchState: new Array<number>(128).fill(0) }],
    drumsMode: "off" as const,
    macros: { energy: 0.5, density: 0.3, variation: 0.2, texture: 0.6 },
  };
}

describe("MRT2 companion protocol", () => {
  it("allows only deliberate localhost companion endpoints", () => {
    expect(isAllowedMrt2CompanionUrl("ws://127.0.0.1:8765")).toBe(true);
    expect(isAllowedMrt2CompanionUrl("wss://localhost:8765/path")).toBe(true);
    expect(isAllowedMrt2CompanionUrl("ws://evil.example:8765")).toBe(false);
    expect(isAllowedMrt2CompanionUrl("ws://user:pass@localhost:8765")).toBe(false);
    expect(isAllowedMrt2CompanionUrl("https://localhost:8765")).toBe(false);
  });

  it("round-trips bounded binary PCM and rejects malformed packets", () => {
    const encoded = encodeMrt2AudioPacket({
      kind: "output",
      sequence: 4,
      sampleRate: 48_000,
      channels: 2,
      frames: 2,
      data: new Float32Array([0.1, -0.1, 0.2, -0.2]),
    });
    const decoded = decodeMrt2AudioPacket(encoded);
    expect(decoded).toMatchObject({ kind: "output", sequence: 4, sampleRate: 48_000, channels: 2, frames: 2 });
    expect([...decoded.data]).toEqual([0.1, -0.1, 0.2, -0.2].map((value) => expect.closeTo(value, 6)));
    expect(() => decodeMrt2AudioPacket(encoded.slice(0, -1))).toThrow(/size|truncated|trailing/u);
    expect(() =>
      encodeMrt2AudioPacket({
        kind: "output",
        sequence: 0,
        sampleRate: 192_001,
        channels: 2,
        frames: 1,
        data: new Float32Array([0, 0]),
      }),
    ).toThrow(/sampleRate/u);
    expect(() =>
      encodeMrt2AudioPacket({
        kind: "output",
        sequence: 0,
        sampleRate: 48_000,
        channels: 2,
        frames: 1,
        data: new Float32Array([Number.NaN, 0]),
      }),
    ).toThrow(/non-finite/u);
    expect(() =>
      encodeMrt2AudioPacket({
        kind: "output",
        sequence: 0,
        sampleRate: 48_000,
        channels: 2,
        frames: 0,
        data: new Float32Array(),
      }),
    ).toThrow(/at least one frame/u);
  });

  it("validates versioned control messages before returning them", () => {
    const message = {
      version: 1 as const,
      type: "session.start" as const,
      requestId: "r1",
      sessionId: "s1",
    };
    expect(parseMrt2ControlMessage(serializeMrt2ControlMessage(message))).toEqual(message);
    expect(() => parseMrt2ControlMessage('{"version":99,"type":"status","state":"ready"}')).toThrow(/version/u);
    expect(() => parseMrt2ControlMessage('{"version":1,"type":"unknown"}')).toThrow(/Unsupported/u);
    expect(() =>
      parseMrt2ControlMessage(
        JSON.stringify({
          version: 1,
          type: "input.update",
          requestId: "r1",
          sessionId: "s1",
          input: {
            bpm: 120,
            frameRateHz: 25,
            startTick: 0,
            style: { kind: "text", text: "pad" },
            noteFrames: [{ frameIndex: 0, pitchState: [0, 1] }],
            drumsMode: "off",
            macros: { energy: 0.5, density: 0.5, variation: 0.5, texture: 0.5 },
          },
        }),
      ),
    ).toThrow(/pitchState/u);
  });

  it("validates bounded live-stream inference metrics", () => {
    const status = {
      version: 1 as const,
      type: "status" as const,
      state: "running" as const,
      metrics: {
        frameP95Ms: 28.4,
        frameMeanMs: 21.6,
        realtimeFactor: 1.7,
        underrunCount: 0,
        generatedFrames: 250,
        deviceBytesInUse: 1024,
        deviceBytesReserved: 4096,
        devicePeakBytesReserved: 4096,
      },
    };
    expect(parseMrt2ControlMessage(JSON.stringify(status))).toEqual(status);
    expect(() =>
      parseMrt2ControlMessage(JSON.stringify({ ...status, metrics: { ...status.metrics, underrunCount: -1 } })),
    ).toThrow(/underrunCount/u);
    expect(() =>
      parseMrt2ControlMessage(JSON.stringify({ ...status, metrics: { ...status.metrics, frameP95Ms: Number.NaN } })),
    ).toThrow(/frameP95Ms/u);
    expect(() =>
      parseMrt2ControlMessage(
        JSON.stringify({ ...status, metrics: { ...status.metrics, deviceBytesReserved: Number.MAX_SAFE_INTEGER + 1 } }),
      ),
    ).toThrow(/deviceBytesReserved/u);
  });

  it("validates optional runtime capability diagnostics", () => {
    const message = parseMrt2ControlMessage({
      version: 1,
      type: "hello.ok",
      requestId: "hello-1",
      providerId: "mrt2",
      modelIds: ["mrt2_small"],
      outputSampleRates: [48_000],
      outputChannels: [2],
      supportsRealtime: true,
      supportsCapture: true,
      supportsTextStyle: true,
      supportsNoteConditioning: true,
      supportsAudioStyle: false,
      supportsDrumsMode: true,
      supportsSeed: false,
      maxCaptureSeconds: 120,
      runtimeProfile: {
        backendId: "mrt2-windows-cuda",
        executionMode: "near-realtime",
        measuredLatencyMs: 210,
        frameP95Ms: 28,
        realtimeFactor: 1.1,
        warning: "experimental backend",
      },
    });
    expect(message).toMatchObject({
      type: "hello.ok",
      runtimeProfile: {
        backendId: "mrt2-windows-cuda",
        executionMode: "near-realtime",
        frameP95Ms: 28,
        realtimeFactor: 1.1,
      },
    });
    expect(() =>
      parseMrt2ControlMessage({
        version: 1,
        type: "hello.ok",
        requestId: "hello-2",
        providerId: "mrt2",
        modelIds: ["mrt2_small"],
        outputSampleRates: [48_000],
        outputChannels: [2],
        supportsRealtime: true,
        supportsCapture: true,
        supportsTextStyle: true,
        supportsNoteConditioning: true,
        supportsAudioStyle: false,
        supportsDrumsMode: true,
        supportsSeed: false,
        maxCaptureSeconds: 120,
        runtimeProfile: { backendId: "mrt2-windows-cuda", executionMode: "invalid" },
      }),
    ).toThrow(/runtimeProfile.executionMode/u);
  });

  it("accepts the full provider lifecycle state vocabulary", () => {
    for (const state of ["loading", "downloading", "buffering", "reconnecting"] as const) {
      expect(parseMrt2ControlMessage({ version: 1, type: "status", state, message: `state:${state}` })).toMatchObject({
        type: "status",
        state,
      });
    }
  });

  it("validates optional capture inference metrics from a companion", () => {
    expect(
      parseMrt2ControlMessage({
        version: 1,
        type: "capture.ok",
        requestId: "capture-1",
        sessionId: "session-1",
        frames: 48_000,
        durationSec: 1,
        inputHash: "a".repeat(64),
        frameP95Ms: 41.2,
        frameMeanMs: 22.5,
        realtimeFactor: 0.8,
      }),
    ).toMatchObject({ frameP95Ms: 41.2, frameMeanMs: 22.5, realtimeFactor: 0.8 });
    expect(() =>
      parseMrt2ControlMessage({
        version: 1,
        type: "capture.ok",
        requestId: "capture-2",
        sessionId: "session-1",
        frames: 48_000,
        durationSec: 1,
        inputHash: "a".repeat(64),
        frameP95Ms: "fast",
      }),
    ).toThrow(/frameP95Ms/u);
  });

  it("keeps style PCM on the binary plane and exposes capture as GeneratedAudio", async () => {
    const transport = new FakeTransport();
    const provider = new Mrt2CompanionProvider({ transportFactory: async () => transport, timeoutMs: 1000 });
    const session = await provider.createSession({
      modelId: "mrt2_small",
      outputSampleRate: 48_000,
      outputChannels: 2,
    });
    await session.updateInput(input("audio"));
    expect(transport.binary).toHaveLength(1);
    expect(decodeMrt2AudioPacket(transport.binary[0]!).kind).toBe("style");
    await session.start();
    const audio = await session.capture({ input: input("audio"), durationSec: 2 / 48_000 });
    expect(audio).toMatchObject({ sampleRate: 48_000, channels: 2, frames: 2, inputHash: "capture-hash" });
    expect([...audio.data]).toEqual([0.1, -0.1, 0.2, -0.2].map((value) => expect.closeTo(value, 6)));
    await session.dispose();
  });

  it("continues collecting capture PCM across a buffering status transition", async () => {
    const transport = new FakeTransport();
    transport.bufferDuringCapture = true;
    const provider = new Mrt2CompanionProvider({ transportFactory: async () => transport, timeoutMs: 1000 });
    const session = await provider.createSession({
      modelId: "mrt2_small",
      outputSampleRate: 48_000,
      outputChannels: 2,
    });
    await session.updateInput(input("text"));
    await session.start();
    const statuses: string[] = [];
    session.subscribeStatus((status) => statuses.push(status.state));

    const audio = await session.capture({ input: input("text"), durationSec: 2 / 48_000 });

    expect(statuses).toContain("buffering");
    expect(audio.frames).toBe(2);
    expect([...audio.data]).toEqual([0.1, -0.1, 0.2, -0.2].map((value) => expect.closeTo(value, 6)));
    await session.dispose();
  });

  it("supports capture-only companions without pretending that live playback works", async () => {
    const transport = new FakeTransport();
    transport.supportsRealtime = false;
    const provider = new Mrt2CompanionProvider({ transportFactory: async () => transport, timeoutMs: 1000 });
    const session = await provider.createSession({
      modelId: "mrt2_small",
      outputSampleRate: 48_000,
      outputChannels: 2,
    });
    expect(session.capabilities.supportsRealtime).toBe(false);
    expect(session.capabilities.runtimeProfile).toMatchObject({ executionMode: "capture" });
    expect(provider.getCapabilities().supportsRealtime).toBe(false);
    await session.updateInput(input("text"));
    await expect(session.start()).rejects.toThrow(/does not support realtime/u);
    const audio = await session.capture({ input: input("text"), durationSec: 2 / 48_000 });
    expect(audio.frames).toBe(2);
    await session.dispose();
  });

  it("preserves asynchronous live startup state and refreshes host-local stream metrics", async () => {
    const transport = new FakeTransport();
    transport.startState = "starting";
    transport.startMetrics = {
      frameP95Ms: 27.4,
      frameMeanMs: 20.2,
      realtimeFactor: 1.6,
      underrunCount: 0,
      generatedFrames: 250,
    };
    const provider = new Mrt2CompanionProvider({ transportFactory: async () => transport, timeoutMs: 1000 });
    const session = await provider.createSession({
      modelId: "mrt2_small",
      outputSampleRate: 48_000,
      outputChannels: 2,
    });

    await session.start();

    expect(session.getStatus().state).toBe("starting");
    expect(session.capabilities.runtimeProfile).toMatchObject({ frameP95Ms: 27.4, realtimeFactor: 1.6 });
    await session.dispose();
  });

  it("rejects unsupported seed control before sending it to the companion", async () => {
    const transport = new FakeTransport();
    const provider = new Mrt2CompanionProvider({ transportFactory: async () => transport, timeoutMs: 1000 });
    const session = await provider.createSession({
      modelId: "mrt2_small",
      outputSampleRate: 48_000,
      outputChannels: 2,
    });
    await expect(session.updateInput({ ...input("text"), seed: "must-not-cross-boundary" })).rejects.toThrow(
      /seed control/u,
    );
    await session.dispose();
  });

  it("surfaces disconnect and timeout instead of leaving the runtime pending", async () => {
    const disconnecting = new Mrt2CompanionProvider({
      transportFactory: async () => new DisconnectingTransport(),
      timeoutMs: 50,
    });
    await expect(
      disconnecting.createSession({ modelId: "mrt2_small", outputSampleRate: 48_000, outputChannels: 2 }),
    ).rejects.toThrow(/stopped|disconnected/u);

    const silent = new Mrt2CompanionProvider({ transportFactory: async () => new SilentTransport(), timeoutMs: 5 });
    await expect(
      silent.createSession({ modelId: "mrt2_small", outputSampleRate: 48_000, outputChannels: 2 }),
    ).rejects.toThrow(/timed out/u);
  });

  it("exposes a recoverable disconnect state without silently retrying", async () => {
    const transport = new FakeTransport();
    const provider = new Mrt2CompanionProvider({ transportFactory: async () => transport, timeoutMs: 1000 });
    const session = await provider.createSession({
      modelId: "mrt2_small",
      outputSampleRate: 48_000,
      outputChannels: 2,
    });
    transport.disconnect();
    expect(session.getStatus()).toEqual({
      state: "reconnecting",
      message: "companion stopped; stop and play to reconnect",
    });
    await session.dispose();
  });

  it("terminates the session when a direct transport emits invalid PCM", async () => {
    const transport = new FakeTransport();
    const provider = new Mrt2CompanionProvider({ transportFactory: async () => transport, timeoutMs: 1000 });
    const session = await provider.createSession({
      modelId: "mrt2_small",
      outputSampleRate: 48_000,
      outputChannels: 2,
    });
    transport.emitAudio({
      kind: "output",
      sequence: 0,
      sampleRate: 48_000,
      channels: 2,
      frames: 1,
      data: new Float32Array([Number.NaN, 0]),
    });
    expect(session.getStatus()).toMatchObject({ state: "error" });
    await expect(session.start()).rejects.toThrow(/Invalid MRT2 audio packet/u);
    await session.dispose();
  });

  it("bounds capture PCM to the requested frames and rejects malformed direct control events", async () => {
    const transport = new FakeTransport();
    const provider = new Mrt2CompanionProvider({ transportFactory: async () => transport, timeoutMs: 1000 });
    const session = await provider.createSession({
      modelId: "mrt2_small",
      outputSampleRate: 48_000,
      outputChannels: 2,
    });
    await expect(session.capture({ input: input("text"), durationSec: 1 / 48_000 })).rejects.toThrow(
      /requested frame limit/u,
    );
    expect(session.getStatus().state).toBe("error");
    await session.dispose();

    const controlTransport = new FakeTransport();
    const controlProvider = new Mrt2CompanionProvider({
      transportFactory: async () => controlTransport,
      timeoutMs: 1000,
    });
    const controlSession = await controlProvider.createSession({
      modelId: "mrt2_small",
      outputSampleRate: 48_000,
      outputChannels: 2,
    });
    const start = controlSession.start();
    controlTransport.emitControl({ version: 1, type: "status", state: "future-state" });
    await expect(start).rejects.toThrow(/Invalid MRT2 control message/u);
    expect(controlSession.getStatus().state).toBe("error");
    await controlSession.dispose();
  });
});
