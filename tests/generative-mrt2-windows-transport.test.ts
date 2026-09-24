import { describe, expect, it, vi } from "vitest";
import { createMrt2WindowsProvider, encodeMrt2AudioPacket, type Mrt2ControlMessage } from "../src/generative";

function input() {
  return {
    bpm: 120,
    frameRateHz: 25 as const,
    startTick: 0,
    style: { kind: "text" as const, text: "cinematic pulse" },
    noteFrames: [{ frameIndex: 0, pitchState: new Array<number>(128).fill(0) }],
    drumsMode: "off" as const,
    macros: { energy: 0.5, density: 0.3, variation: 0.2, texture: 0.6 },
  };
}

describe("MRT2 Windows companion transport", () => {
  it("connects only to the Windows desktop bridge and supports capture-only tiers", async () => {
    const listeners = new Set<(event: unknown) => void>();
    let activeTransportId = "";
    const bridge = {
      getAvailability: vi.fn(async () => ({ platform: "win32", status: "available" })),
      openTransport: vi.fn(async () => {
        activeTransportId = "windows-transport-1";
        return activeTransportId;
      }),
      sendControl: vi.fn(async (transportId: string, message: Mrt2ControlMessage) => {
        expect(transportId).toBe(activeTransportId);
        let response: Record<string, unknown> | null = null;
        if (message.type === "hello") {
          response = {
            version: 1,
            type: "hello.ok",
            requestId: message.requestId,
            providerId: "mrt2",
            modelIds: ["mrt2_small"],
            outputSampleRates: [48_000],
            outputChannels: [2],
            supportsRealtime: false,
            supportsCapture: true,
            supportsTextStyle: true,
            supportsNoteConditioning: true,
            supportsAudioStyle: false,
            supportsDrumsMode: true,
            supportsSeed: false,
            maxCaptureSeconds: 120,
            runtimeProfile: {
              backendId: "mrt2-windows-jax",
              executionMode: "capture",
              realtimeFactor: 0.7,
              warning: "benchmark required",
            },
          };
        } else if (message.type === "session.create") {
          response = { version: 1, type: "session.ok", requestId: message.requestId, sessionId: "windows-session" };
        } else if (message.type === "input.update") {
          response = {
            version: 1,
            type: "status",
            requestId: message.requestId,
            sessionId: message.sessionId,
            state: "ready",
          };
        } else if (message.type === "capture.start") {
          const packet = encodeMrt2AudioPacket({
            kind: "output",
            sequence: 0,
            sampleRate: 48_000,
            channels: 2,
            frames: 1,
            data: new Float32Array([0.1, -0.1]),
          });
          queueMicrotask(() => {
            for (const listener of listeners) listener({ transportId, kind: "audio", data: new Uint8Array(packet) });
          });
          response = {
            version: 1,
            type: "capture.ok",
            requestId: message.requestId,
            sessionId: message.sessionId,
            frames: 1,
            durationSec: 1 / 48_000,
            inputHash: "windows-capture",
          };
        }
        if (response) {
          queueMicrotask(() => {
            for (const listener of listeners) listener({ transportId, kind: "control", message: response });
          });
        }
      }),
      sendBinary: vi.fn(),
      closeTransport: vi.fn(async () => undefined),
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    Object.defineProperty(window, "kyxDesktop", { configurable: true, value: { isDesktop: true, mrt2: bridge } });

    const provider = createMrt2WindowsProvider({ timeoutMs: 1_000 });
    const session = await provider.createSession({
      modelId: "mrt2_small",
      outputSampleRate: 48_000,
      outputChannels: 2,
    });
    expect(session.capabilities.runtimeProfile).toMatchObject({
      backendId: "mrt2-windows-jax",
      executionMode: "capture",
    });
    await session.updateInput(input());
    await expect(session.start()).rejects.toThrow(/does not support realtime/u);
    const audio = await session.capture({ input: input(), durationSec: 1 / 48_000 });
    expect(audio).toMatchObject({ frames: 1, inputHash: "windows-capture" });
    await session.dispose();
    expect(bridge.closeTransport).toHaveBeenCalledWith(activeTransportId);
  });

  it("rejects a non-Windows desktop bridge before opening a transport", async () => {
    const openTransport = vi.fn(async () => "wrong-platform");
    Object.defineProperty(window, "kyxDesktop", {
      configurable: true,
      value: { isDesktop: true, mrt2: { getAvailability: async () => ({ platform: "darwin" }), openTransport } },
    });
    const provider = createMrt2WindowsProvider({ timeoutMs: 100 });
    await expect(
      provider.createSession({ modelId: "mrt2_small", outputSampleRate: 48_000, outputChannels: 2 }),
    ).rejects.toThrow(/only on Windows/u);
    expect(openTransport).not.toHaveBeenCalled();
  });
});
