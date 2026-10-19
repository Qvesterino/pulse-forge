import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { canStopNativeAudioSession, formatReportedWindowsAudioLatency, IoPanel } from "../../src/ui/IoPanel";
import { renderWithContext, mockServices } from "../helpers";

/**
 * Honest-degradation pins for the Studio I/O panel (jsdom: no setSinkId,
 * no real mediaDevices, no kyxDesktop bridge — exactly the surfaces the
 * panel must describe truthfully instead of failing into).
 */

async function renderPanel() {
  const services = mockServices();
  renderWithContext(<IoPanel />, { services });
  await act(async () => {
    await Promise.resolve();
  });
  return services;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("Studio I/O panel", () => {
  it("keeps an explicit stop action available after native device loss", () => {
    expect(canStopNativeAudioSession("lost", true)).toBe(true);
    expect(canStopNativeAudioSession("error", true)).toBe(true);
    expect(canStopNativeAudioSession("lost", false)).toBe(false);
    expect(canStopNativeAudioSession("idle", false)).toBe(false);
  });

  it("formats endpoint-reported latency without presenting it as a loopback measurement", () => {
    expect(formatReportedWindowsAudioLatency(240, 48_000)).toBe("5.00 ms (240 frames)");
    expect(formatReportedWindowsAudioLatency(undefined, 48_000)).toBe("unavailable");
    expect(formatReportedWindowsAudioLatency(240, 0)).toBe("unavailable");
  });

  it("renders OUTPUT and INPUT sections with honest notes", async () => {
    await renderPanel();
    expect(screen.getByText("OUTPUT")).toBeInTheDocument();
    expect(screen.getByText("INPUT")).toBeInTheDocument();
    // jsdom has no setSinkId — the unsupported note MUST be visible.
    expect(screen.getByText(/cannot switch outputs/)).toBeInTheDocument();
  });

  it("hides the ASIO section without the desktop bridge (web honesty)", async () => {
    await renderPanel();
    expect(screen.queryByText("ASIO DRIVERS")).not.toBeInTheDocument();
  });

  it("changing the input persists the device choice", async () => {
    const user = userEvent.setup();
    // jsdom enumerateDevices stub: one named input.
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: async () => [{ kind: "audioinput", deviceId: "mic-1", label: "UA Volt" }] },
    });
    await renderPanel();
    await waitFor(() => expect(screen.getByRole("option", { name: "UA Volt" })).toBeInTheDocument());
    await user.selectOptions(screen.getAllByRole("combobox")[1], "mic-1");
    expect(window.localStorage.getItem("pf:recording-input-device")).toBe("mic-1");
  });

  it("reapplies the exact saved output when the live audio context is replaced", async () => {
    class FakeAudioContext {}
    const firstSetSinkId = vi.fn(async (_deviceId: string) => {});
    const secondSetSinkId = vi.fn(async (_deviceId: string) => {});
    const firstContext = Object.assign(new FakeAudioContext(), {
      state: "running",
      setSinkId: firstSetSinkId,
    }) as unknown as AudioContext;
    const secondContext = Object.assign(new FakeAudioContext(), {
      state: "running",
      setSinkId: secondSetSinkId,
    }) as unknown as AudioContext;
    vi.stubGlobal("AudioContext", FakeAudioContext);
    window.localStorage.setItem("pf:audio-output-device", "volt-monitor-id");
    const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [{ kind: "audiooutput", deviceId: "volt-monitor-id", label: "UA Volt Monitor" }],
      },
    });

    const services = mockServices();
    let currentContext = firstContext;
    const contextListeners = new Set<(context: AudioContext | null) => void>();
    Object.defineProperty(services.engine, "context", {
      configurable: true,
      get: () => currentContext,
    });
    services.engine.subscribeLiveContext = vi.fn((listener) => {
      contextListeners.add(listener);
      listener(currentContext);
      return () => contextListeners.delete(listener);
    });

    try {
      renderWithContext(<IoPanel />, { services });
      await waitFor(() => expect(firstSetSinkId).toHaveBeenCalledWith("volt-monitor-id"));

      await act(async () => {
        currentContext = secondContext;
        for (const listener of contextListeners) listener(secondContext);
      });
      await waitFor(() => expect(secondSetSinkId).toHaveBeenCalledWith("volt-monitor-id"));
    } finally {
      if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
      else Reflect.deleteProperty(navigator, "mediaDevices");
      vi.unstubAllGlobals();
    }
  });

  it("keeps a missing saved input and output visible without silently selecting defaults", async () => {
    window.localStorage.setItem("pf:audio-output-device", "gone-output");
    window.localStorage.setItem("pf:recording-input-device", "gone-input");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [
          { kind: "audiooutput", deviceId: "available-output", label: "Speakers" },
          { kind: "audioinput", deviceId: "available-input", label: "Microphone" },
        ],
      },
    });

    await renderPanel();

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Saved output unavailable" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Saved input unavailable" })).toBeInTheDocument();
    });
    const selectedDeviceIds = screen.getAllByRole("combobox").map((select) => (select as HTMLSelectElement).value);
    expect(selectedDeviceIds).toEqual(["gone-output", "gone-input"]);
    expect(screen.getByText(/saved output is not currently listed/i)).toBeInTheDocument();
    expect(screen.getByText(/will not switch inputs silently/i)).toBeInTheDocument();
  });

  it("TEST TONE is disabled without a live context — honest gate, no silent click", async () => {
    await renderPanel();
    // jsdom has no AudioContext, so the panel must not pretend the tone can play.
    expect(screen.getByRole("button", { name: "TEST TONE" })).toBeDisabled();
  });

  it("shows the ASIO section when the desktop bridge exists", async () => {
    const bridge = {
      list: vi.fn().mockResolvedValue({
        registry: { status: "ok", names: ["FlexASIO"] },
        details: {
          status: "ok",
          drivers: [{ name: "FlexASIO", inputChannels: 2, outputChannels: 2, sampleRate: 48000 }],
        },
      }),
    };
    (window as { kyxDesktop?: unknown }).kyxDesktop = { asio: bridge };
    try {
      await renderPanel();
      expect(screen.getByText("ASIO DRIVERS")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText("FlexASIO")).toBeInTheDocument());
      expect(screen.getByText(/2in · 2out/)).toBeInTheDocument();
      // The honest matrix note is part of the contract.
      expect(screen.getByText(/Discovery only \(ADR 0017\)/)).toBeInTheDocument();
    } finally {
      delete (window as { kyxDesktop?: unknown }).kyxDesktop;
    }
  });

  it("shows native Windows endpoint discovery with metadata and separate selectors without mixing browser input", async () => {
    const audio = {
      listWindowsEndpoints: vi.fn().mockResolvedValue({
        status: "ok",
        schemaVersion: 2,
        endpoints: [
          {
            id: "opaque-input-id",
            name: "UA Volt Capture",
            flow: "capture",
            state: "active",
            isDefaultConsole: true,
            mixFormat: {
              channels: 2,
              sampleRateHz: 48000,
              bitsPerSample: 32,
              validBitsPerSample: 32,
              floatingPoint: true,
              channelMask: 3,
              sharedPeriods: { defaultFrames: 480, fundamentalFrames: 480, minFrames: 480, maxFrames: 1440 },
            },
          },
          {
            id: "opaque-output-id",
            name: "UA Volt Monitor",
            flow: "render",
            state: "active",
            isDefaultConsole: false,
            mixFormat: {
              channels: 2,
              sampleRateHz: 48000,
              bitsPerSample: 32,
              validBitsPerSample: 32,
              floatingPoint: true,
              channelMask: 3,
              sharedPeriods: { defaultFrames: 480, fundamentalFrames: 480, minFrames: 480, maxFrames: 1440 },
            },
          },
        ],
      }),
    };
    (window as { kyxDesktop?: unknown }).kyxDesktop = { audio };
    try {
      await renderPanel();
      await waitFor(() => expect(screen.getByText("UA Volt Capture")).toBeInTheDocument());
      expect(
        screen.getByText(/capture · active · console default · engine mix: 2 ch \/ 48 kHz \/ 32-bit float/),
      ).toBeInTheDocument();
      expect(screen.getAllByText(/shared period 480–1440 frames \(default 480\)/)).toHaveLength(2);
      expect(screen.getAllByText(/engine mix: 2 ch \/ 48 kHz \/ 32-bit float/)).toHaveLength(2);
      expect(screen.getByRole("option", { name: /UA Volt Capture · active/ })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: /UA Volt Monitor · active/ })).toBeInTheDocument();
      expect(screen.getByText(/Native sessions use the exact selected endpoints in shared mode/)).toBeInTheDocument();
      const browserInput = screen.getAllByLabelText("DEVICE")[1] as HTMLSelectElement;
      expect(Array.from(browserInput.options, (option) => option.value)).not.toContain("opaque-input-id");
      expect(audio.listWindowsEndpoints).toHaveBeenCalledOnce();
    } finally {
      delete (window as { kyxDesktop?: unknown }).kyxDesktop;
    }
  });

  it("shows endpoint-reported stream latency from an existing native connection and labels the loopback limit", async () => {
    const connection = {
      sessionId: "session-latency",
      captureStream: {},
      negotiation: {
        backend: "wasapi-shared",
        inputEndpointId: "capture-id",
        outputEndpointId: "render-id",
        sampleRateHz: 48_000,
        periodFrames: 480,
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
      },
      subscribe: vi.fn(() => () => {}),
      stop: vi.fn(),
    };
    vi.doMock("../../src/audio-engine/windowsAudioIoBridge", () => ({
      getWindowsAudioIoEngineConnection: () => connection,
    }));
    (window as { kyxDesktop?: unknown }).kyxDesktop = {
      audio: {
        listWindowsEndpoints: vi.fn().mockResolvedValue({
          status: "ok",
          schemaVersion: 2,
          endpoints: [
            {
              id: "capture-id",
              name: "UA Volt Capture",
              flow: "capture",
              state: "active",
              isDefaultConsole: true,
              mixFormat: {
                channels: 2,
                sampleRateHz: 48_000,
                bitsPerSample: 32,
                validBitsPerSample: 32,
                floatingPoint: true,
                channelMask: 3,
                sharedPeriods: { defaultFrames: 480, fundamentalFrames: 480, minFrames: 480, maxFrames: 1440 },
              },
            },
            {
              id: "render-id",
              name: "UA Volt Monitor",
              flow: "render",
              state: "active",
              isDefaultConsole: false,
              mixFormat: {
                channels: 2,
                sampleRateHz: 48_000,
                bitsPerSample: 32,
                validBitsPerSample: 32,
                floatingPoint: true,
                channelMask: 3,
                sharedPeriods: { defaultFrames: 480, fundamentalFrames: 480, minFrames: 480, maxFrames: 1440 },
              },
            },
          ],
        }),
      },
    };
    try {
      await renderPanel();
      expect(await screen.findByText(/endpoint-reported stream latency/)).toBeInTheDocument();
      expect(screen.getByText(/5\.00 ms \(240 frames\)/)).toBeInTheDocument();
      expect(screen.getByText(/10\.00 ms \(480 frames\)/)).toBeInTheDocument();
      expect(screen.getByText(/acoustic loopback not measured/)).toBeInTheDocument();
    } finally {
      delete (window as { kyxDesktop?: unknown }).kyxDesktop;
      vi.doUnmock("../../src/audio-engine/windowsAudioIoBridge");
    }
  });

  it("does not connect a native session when Stop wins the pending startup race", async () => {
    class FakeAudioContext {
      state: AudioContextState = "running";
      sampleRate = 48_000;
      resume = vi.fn(async () => {});
    }
    const liveContext = new FakeAudioContext() as unknown as AudioContext;
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const services = mockServices();
    Object.defineProperty(services.engine, "context", { configurable: true, get: () => liveContext });
    Object.defineProperty(services.engine, "getLiveAudioContext", { configurable: true, value: () => liveContext });
    Object.defineProperty(services.engine, "ensureContext", { configurable: true, value: () => liveContext });

    let resolveStart!: (result: { status: "starting"; sessionId: string }) => void;
    const startResponse = new Promise<{ status: "starting"; sessionId: string }>((resolve) => {
      resolveStart = resolve;
    });
    const port = { close: vi.fn() };
    const connectWindowsAudioIoToEngine = vi.fn();
    const waitForWindowsAudioSessionPort = vi.fn(async () => port as unknown as MessagePort);
    const discardWindowsAudioSessionPort = vi.fn(() => port.close());
    vi.doMock("../../src/audio-engine/windowsAudioIoBridge", () => ({
      getWindowsAudioIoEngineConnection: () => null,
      waitForWindowsAudioSessionPort,
      discardWindowsAudioSessionPort,
      connectWindowsAudioIoToEngine,
    }));
    const audio = {
      listWindowsEndpoints: vi.fn().mockResolvedValue({
        status: "ok",
        schemaVersion: 2,
        endpoints: [
          {
            id: "capture-id",
            name: "Capture",
            flow: "capture",
            state: "active",
            isDefaultConsole: true,
            mixFormat: {
              channels: 2,
              sampleRateHz: 48_000,
              bitsPerSample: 32,
              validBitsPerSample: 32,
              floatingPoint: true,
              channelMask: 3,
              sharedPeriods: { defaultFrames: 480, fundamentalFrames: 480, minFrames: 480, maxFrames: 1440 },
            },
          },
          {
            id: "render-id",
            name: "Render",
            flow: "render",
            state: "active",
            isDefaultConsole: true,
            mixFormat: {
              channels: 2,
              sampleRateHz: 48_000,
              bitsPerSample: 32,
              validBitsPerSample: 32,
              floatingPoint: true,
              channelMask: 3,
              sharedPeriods: { defaultFrames: 480, fundamentalFrames: 480, minFrames: 480, maxFrames: 1440 },
            },
          },
        ],
      }),
      startWindowsSession: vi.fn(() => startResponse),
      stopWindowsSession: vi.fn(async () => ({ status: "stopped" as const })),
      onWindowsSessionStage: vi.fn(() => () => {}),
    };
    (window as { kyxDesktop?: unknown }).kyxDesktop = { audio };
    const view = renderWithContext(<IoPanel />, { services });
    const user = userEvent.setup();
    try {
      const startButton = await screen.findByRole("button", { name: "START NATIVE AUDIO" });
      await waitFor(() => expect(startButton).toBeEnabled());
      await user.click(startButton);
      await waitFor(() => expect(audio.startWindowsSession).toHaveBeenCalledOnce());
      await user.click(await screen.findByRole("button", { name: "STOP NATIVE AUDIO" }));
      await waitFor(() => expect(screen.getByText("IDLE")).toBeInTheDocument());

      await act(async () => {
        resolveStart({ status: "starting", sessionId: "late-session" });
      });
      await waitFor(() => expect(audio.stopWindowsSession).toHaveBeenCalledWith("late-session"));
      expect(discardWindowsAudioSessionPort).toHaveBeenCalledWith("late-session");
      expect(port.close).toHaveBeenCalledOnce();
      expect(connectWindowsAudioIoToEngine).not.toHaveBeenCalled();
      expect(screen.getByText("IDLE")).toBeInTheDocument();
    } finally {
      view.unmount();
      delete (window as { kyxDesktop?: unknown }).kyxDesktop;
      vi.doUnmock("../../src/audio-engine/windowsAudioIoBridge");
      vi.unstubAllGlobals();
    }
  });
});
