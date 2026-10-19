import { describe, expect, it, vi } from "vitest";
import {
  connectWindowsAudioIoToEngine,
  discardWindowsAudioSessionPort,
  waitForWindowsAudioSessionPort,
  type WindowsAudioIoEngineConnection,
} from "../src/audio-engine/windowsAudioIoBridge";
import type { WindowsAudioIoNegotiation, WindowsAudioIoRequest } from "../src/audio-engine/windowsAudioIo";

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: Array<{ message: unknown; transfer: unknown[] }> = [];
  closed = false;

  postMessage(message: unknown, transfer: unknown[] = []) {
    this.posted.push({ message, transfer });
  }

  start() {}
  close() {
    this.closed = true;
  }
}

class FakeMessagePort {
  closed = false;
  close() {
    this.closed = true;
  }
}

class FakeWorkletNode {
  port = new FakePort();
  onprocessorerror: (() => void) | null = null;
  connected: Array<{ destination: unknown; output?: number; input?: number }> = [];
  disconnected = false;
  static last: FakeWorkletNode | null = null;

  constructor(
    readonly context: unknown,
    readonly name: string,
    readonly options: Record<string, unknown>,
  ) {
    FakeWorkletNode.last = this;
  }

  connect(destination: unknown, output?: number, input?: number) {
    this.connected.push({ destination, output, input });
  }

  disconnect() {
    this.disconnected = true;
  }
}

const request: WindowsAudioIoRequest = {
  backend: "wasapi-shared",
  inputEndpointId: "capture-endpoint",
  outputEndpointId: "render-endpoint",
  sampleRateHz: 48_000,
  periodFrames: 480,
  inputChannelMap: [0, 1],
  outputChannelMap: [0, 1],
  exclusiveAcknowledged: false,
};

const negotiation: WindowsAudioIoNegotiation = {
  backend: "wasapi-shared",
  inputEndpointId: request.inputEndpointId,
  outputEndpointId: request.outputEndpointId,
  sampleRateHz: request.sampleRateHz,
  periodFrames: request.periodFrames,
  nativeSampleFormat: "f32le",
  ringSampleFormat: "f32le",
  inputChannelCount: 2,
  outputChannelCount: 2,
  inputChannelMap: [0, 1],
  outputChannelMap: [0, 1],
  inputBufferFrames: 960,
  outputBufferFrames: 960,
  reportedInputLatencyFrames: 240,
  reportedOutputLatencyFrames: 480,
  sharedPeriods: { minFrames: 480, maxFrames: 960, fundamentalFrames: 480 },
};

describe("Windows audio I/O AudioEngine bridge", () => {
  it("rejects a cancelled port wait and closes a port that arrives late", async () => {
    vi.stubGlobal("MessagePort", FakeMessagePort);
    try {
      const waiting = waitForWindowsAudioSessionPort("cancelled-session", 60_000);
      discardWindowsAudioSessionPort("cancelled-session");

      await expect(waiting).rejects.toThrow("cancelled before port transfer");
      const latePort = new FakeMessagePort();
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "kyx:audio:windows-session-port", sessionId: "cancelled-session", port: latePort },
          origin: window.location.origin,
          source: window,
        }),
      );
      expect(latePort.closed).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores the normal master output when the user stops after device loss", async () => {
    const tracks = [{ stop: vi.fn() }];
    const captureDestination = {
      stream: { getTracks: () => tracks },
      disconnect: vi.fn(),
    };
    const context = {
      state: "running",
      sampleRate: 48_000,
      destination: {},
      audioWorklet: { addModule: vi.fn(async () => undefined) },
      createMediaStreamDestination: vi.fn(() => captureDestination),
    };
    const clearLiveAudioOutputSink = vi.fn();
    const engine = {
      getLiveAudioContext: () => context,
      setLiveAudioOutputSink: vi.fn(),
      clearLiveAudioOutputSink,
      subscribeLiveContext: () => () => undefined,
    };
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    FakeWorkletNode.last = null;
    try {
      const connecting = connectWindowsAudioIoToEngine(
        engine as never,
        "session-1",
        new FakePort() as unknown as MessagePort,
        request,
      );
      await vi.waitFor(() => expect(FakeWorkletNode.last).not.toBeNull());
      const node = FakeWorkletNode.last!;
      expect(node.connected).toEqual([
        { destination: context.destination, output: 0, input: 0 },
        { destination: captureDestination, output: 1, input: 0 },
      ]);
      expect(engine.setLiveAudioOutputSink).toHaveBeenCalledWith(node);
      node.port.onmessage?.({ data: { type: "ready", negotiation } });
      const connection: WindowsAudioIoEngineConnection = await connecting;
      expect(connection.negotiation).toEqual(negotiation);
      let observedStatus: unknown = null;
      connection.subscribe((event) => {
        if (event.type === "status") observedStatus = event.snapshot;
      });
      node.port.onmessage?.({
        data: {
          type: "status",
          snapshot: { state: "running" },
          bridge: {
            ready: true,
            renderSequence: 6,
            inFlightRenderPackets: 0,
            captureInvalidPackets: 0,
            processCalls: 23,
          },
        },
      });
      expect(observedStatus).toMatchObject({
        bridgeReady: true,
        bridgeRenderSequence: 6,
        bridgeRenderInFlightPackets: 0,
        bridgeCaptureInvalidPackets: 0,
        bridgeProcessCalls: 23,
      });

      node.port.onmessage?.({ data: { type: "device-lost", message: "USB disconnected" } });
      expect(clearLiveAudioOutputSink).not.toHaveBeenCalled();

      connection.stop();

      expect(clearLiveAudioOutputSink).toHaveBeenCalledWith(node);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects startup and restores output when the AudioWorklet processor crashes", async () => {
    const captureDestination = {
      stream: { getTracks: () => [{ stop: vi.fn() }] },
      disconnect: vi.fn(),
    };
    const context = {
      state: "running",
      sampleRate: 48_000,
      destination: {},
      audioWorklet: { addModule: vi.fn(async () => undefined) },
      createMediaStreamDestination: vi.fn(() => captureDestination),
    };
    const clearLiveAudioOutputSink = vi.fn();
    const engine = {
      getLiveAudioContext: () => context,
      setLiveAudioOutputSink: vi.fn(),
      clearLiveAudioOutputSink,
      subscribeLiveContext: () => () => undefined,
    };
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    FakeWorkletNode.last = null;
    try {
      const connecting = connectWindowsAudioIoToEngine(
        engine as never,
        "processor-crash",
        new FakePort() as unknown as MessagePort,
        request,
      );
      await vi.waitFor(() => expect(FakeWorkletNode.last?.onprocessorerror).toBeTypeOf("function"));
      const node = FakeWorkletNode.last!;
      node.onprocessorerror?.();

      await expect(connecting).rejects.toThrow("AudioWorklet processor failed");
      expect(node.disconnected).toBe(true);
      expect(clearLiveAudioOutputSink).toHaveBeenCalledWith(node);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
