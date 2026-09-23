import { describe, expect, it, vi } from "vitest";
import {
  createMrt2ElectronProvider,
  encodeMrt2AudioPacket,
  type Mrt2ControlMessage,
} from "../src/generative";

function input() {
  return {
    bpm: 120,
    frameRateHz: 25 as const,
    startTick: 0,
    style: { kind: "text" as const, text: "dark atmospheric trap" },
    noteFrames: [{ frameIndex: 0, pitchState: new Array<number>(128).fill(0) }],
    drumsMode: "off" as const,
    macros: { energy: 0.5, density: 0.3, variation: 0.2, texture: 0.6 },
  };
}

describe("MRT2 Electron IPC provider transport", () => {
  it("uses the companion contract over a renderer-scoped transport and keeps PCM binary", async () => {
    const listeners = new Set<(event: unknown) => void>();
    const binaryPackets: ArrayBuffer[] = [];
    let activeTransportId = "";
    const bridge = {
      openTransport: vi.fn(async () => {
        activeTransportId = "native-transport-1";
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
            supportsRealtime: true,
            supportsCapture: true,
            supportsTextStyle: true,
            supportsNoteConditioning: true,
            supportsAudioStyle: false,
            supportsDrumsMode: true,
            supportsSeed: false,
            maxCaptureSeconds: 120,
            macroSupport: {
              energy: "unsupported",
              density: "unsupported",
              variation: "unsupported",
              texture: "unsupported",
            },
          };
        } else if (message.type === "session.create") {
          response = { version: 1, type: "session.ok", requestId: message.requestId, sessionId: "native-session" };
        } else {
          response = {
            version: 1,
            type: "status",
            requestId: message.requestId,
            sessionId: "native-session",
            state: "ready",
          };
        }
        if (response) {
          queueMicrotask(() => {
            for (const listener of listeners) {
              listener({ transportId, kind: "control", message: response });
            }
          });
        }
      }),
      sendBinary: vi.fn(async (transportId: string, packet: ArrayBuffer) => {
        expect(transportId).toBe(activeTransportId);
        binaryPackets.push(packet);
      }),
      closeTransport: vi.fn(async (transportId: string) => {
        expect(transportId).toBe(activeTransportId);
      }),
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    Object.defineProperty(window, "kyxDesktop", { configurable: true, value: { isDesktop: true, mrt2: bridge } });

    const provider = createMrt2ElectronProvider({ timeoutMs: 1_000 });
    const session = await provider.createSession({
      modelId: "mrt2_small",
      outputSampleRate: 48_000,
      outputChannels: 2,
    });
    await session.updateInput(input());
    expect(binaryPackets).toHaveLength(0);
    expect(session.capabilities.supportsAudioStyle).toBe(false);
    expect(session.capabilities.macroSupport).toEqual({
      energy: "unsupported",
      density: "unsupported",
      variation: "unsupported",
      texture: "unsupported",
    });
    await expect(
      session.updateInput({
        ...input(),
        style: { kind: "audio", sampleRate: 16_000, channels: [new Float32Array([0.1, -0.1])] },
      }),
    ).rejects.toThrow("does not support audio style conditioning");

    const received: Float32Array[] = [];
    session.subscribeAudio((chunk) => received.push(chunk.data));
    const output = encodeMrt2AudioPacket({
      kind: "output",
      sequence: 7,
      sampleRate: 48_000,
      channels: 2,
      frames: 2,
      data: new Float32Array([0.2, -0.2, 0.4, -0.4]),
    });
    for (const listener of listeners) {
      listener({ transportId: activeTransportId, kind: "audio", data: new Uint8Array(output) });
      listener({ transportId: "another-renderer-transport", kind: "audio", data: new Uint8Array(output) });
    }
    expect(received).toHaveLength(1);
    expect([...received[0]!]).toEqual([0.2, -0.2, 0.4, -0.4].map((sample) => expect.closeTo(sample, 6)));
    await session.dispose();
    expect(bridge.closeTransport).toHaveBeenCalledWith(activeTransportId);
  });
});
