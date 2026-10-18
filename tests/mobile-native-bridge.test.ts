import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getNativeAudioSessionBridge,
  getNativeFilesBridge,
  getNativeMidiBridge,
  nativeCapabilities,
} from "../src/mobile/nativeBridge";
import { createNativeMidiAccess, installNativeMidiShim } from "../src/midi/nativeMidi";
import { MidiOutput } from "../src/midi/MidiOutput";
import { downloadBlob } from "../src/export/download";
import { pickNativeFiles } from "../src/mobile/nativeFiles";
import {
  acquireMobileAudio,
  getMobileAudioState,
  releaseAllMobileAudio,
  releaseMobileAudio,
  subscribeMobileAudioFocus,
} from "../src/mobile/audioSession";
import type { NativeMidiBridge } from "../src/mobile/nativeBridge";

function setBridge(value: unknown): void {
  (window as unknown as { kyxNative?: unknown }).kyxNative = value;
}

function resetMidi(): void {
  delete (navigator as unknown as { requestMIDIAccess?: unknown }).requestMIDIAccess;
  delete (navigator as unknown as { __kyxNativeMidiShim?: unknown }).__kyxNativeMidiShim;
}

afterEach(() => {
  releaseAllMobileAudio();
  setBridge(undefined);
  resetMidi();
  delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
  vi.restoreAllMocks();
});

describe("native bridge shape validation", () => {
  it("treats a missing or malformed bridge as absent", () => {
    expect(getNativeMidiBridge()).toBeNull();
    expect(getNativeFilesBridge()).toBeNull();
    expect(getNativeAudioSessionBridge()).toBeNull();
    setBridge({ platform: "android", midi: {} });
    expect(getNativeMidiBridge()).toBeNull();
    expect(nativeCapabilities()).toEqual({ midi: false, files: false, audioSession: false });
  });

  it("exposes only complete feature surfaces", () => {
    setBridge({
      platform: "android",
      midi: {
        listInputs: async () => [],
        listOutputs: async () => [],
        send: () => {},
        subscribe: () => () => {},
      },
      files: { pickDocuments: async () => [], saveDocument: async () => ({ saved: true }) },
      audioSession: { acquire: () => {}, release: () => {} },
    });
    expect(nativeCapabilities()).toEqual({ midi: true, files: true, audioSession: true });
  });
});

describe("native MIDI shim", () => {
  function midiHarness() {
    const sent: Array<{ outputId: string | null; data: number[] }> = [];
    let emit: ((event: { inputId: string; data: number[] }) => void) | null = null;
    const stateListeners = new Set<() => void>();
    let inputs: Array<{ id: string; name?: string; manufacturer?: string }> = [
      { id: "in-1", name: "Keys", manufacturer: "K" },
      { id: "in-2", name: "Pads" },
    ];
    const midi: NativeMidiBridge = {
      listInputs: async () => inputs,
      listOutputs: async () => [{ id: "out-1", name: "Synth" }],
      send: (outputId, data) => {
        sent.push({ outputId, data });
      },
      subscribe: (listener) => {
        emit = listener;
        return () => {
          emit = null;
        };
      },
      onStateChange: (listener) => {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
    };
    return {
      midi,
      sent,
      emit: (event: { inputId: string; data: number[] }) => emit?.(event),
      addInput: (port: { id: string; name?: string }) => {
        inputs = [...inputs, port];
        for (const listener of stateListeners) listener();
      },
    };
  }

  it("prefers Web MIDI when it exists and installs only as a fallback", () => {
    const { midi } = midiHarness();
    setBridge({ platform: "android", midi });
    const native = vi.fn(async () => ({}) as unknown as MIDIAccess);
    Object.defineProperty(navigator, "requestMIDIAccess", { configurable: true, value: native });
    expect(installNativeMidiShim(midi)).toBe(false);
    resetMidi();
    expect(installNativeMidiShim(midi)).toBe(true);
  });

  it("exposes inputs/outputs, dispatches note bytes and sends output", async () => {
    const harness = midiHarness();
    const access = await createNativeMidiAccess(harness.midi);
    expect(access.inputs.size).toBe(2);
    expect(access.outputs.get("out-1")?.name).toBe("Synth");

    const input = access.inputs.get("in-1")!;
    let received: number[] = [];
    input.addEventListener("midimessage", (event: MIDIMessageEvent) => {
      received = event.data ? Array.from(event.data) : [];
    });
    harness.emit({ inputId: "in-1", data: [0x90, 60, 100] });
    expect(received).toEqual([0x90, 60, 100]);

    access.outputs.get("out-1")!.send([0x80, 60, 0]);
    expect(harness.sent).toEqual([{ outputId: "out-1", data: [0x80, 60, 0] }]);
  });

  it("ignores malformed bytes and unknown inputs", async () => {
    const harness = midiHarness();
    const access = await createNativeMidiAccess(harness.midi);
    const input = access.inputs.get("in-1")!;
    let received = 0;
    input.addEventListener("midimessage", () => {
      received += 1;
    });
    harness.emit({ inputId: "in-1", data: [0x90, 999] });
    harness.emit({ inputId: "missing", data: [0x90, 60, 1] });
    expect(received).toBe(0);
  });

  it("re-lists ports when the shell reports a device change", async () => {
    const harness = midiHarness();
    const access = await createNativeMidiAccess(harness.midi);
    const states: string[] = [];
    access.onstatechange = (event) => {
      const port = (event as unknown as { port?: { id?: string; state?: string } }).port;
      states.push(`${port?.id}:${port?.state}`);
    };
    harness.addInput({ id: "in-3", name: "New" });
    await vi.waitFor(() => expect(access.inputs.has("in-3")).toBe(true));
    expect(states).toContain("in-3:connected");
  });

  it("is consumed by the existing MidiOutput through the lazy shim install", async () => {
    const harness = midiHarness();
    setBridge({ platform: "android", midi: harness.midi });
    const output = new MidiOutput();
    expect(await output.requestAccess()).toBe(true);
    output.setDevice("out-1");
    output.send(new Uint8Array([0x90, 64, 127]));
    expect(harness.sent).toContainEqual({ outputId: "out-1", data: [0x90, 64, 127] });
    output.dispose();
  });
});

describe("SAF bridge", () => {
  it("saves through the shell and only falls back on cancel/failure", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const saved: Array<{ name: string; type: string; bytes: number[] }> = [];
    let result = { saved: true };
    setBridge({
      platform: "android",
      files: {
        pickDocuments: async () => [],
        saveDocument: async (payload: { name: string; mimeType?: string; bytes: Uint8Array }) => {
          saved.push({ name: payload.name, type: payload.mimeType ?? "", bytes: Array.from(payload.bytes) });
          return result;
        },
      },
    });

    downloadBlob(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "mix.wav");
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ name: "mix.wav", type: "audio/wav", bytes: [1, 2, 3] });
    expect(click).not.toHaveBeenCalled();

    result = { saved: false };
    downloadBlob(new Blob([new Uint8Array([4])], { type: "audio/wav" }), "cancel.wav");
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  });

  it("uses the browser download unchanged without a bridge", () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    downloadBlob(new Blob(["x"]), "x.txt");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("maps picked SAF payloads to File objects", async () => {
    setBridge({
      platform: "android",
      files: {
        pickDocuments: async () => [
          { name: "kick.wav", mimeType: "audio/wav", bytes: new Uint8Array([1, 2]) },
          { name: "", bytes: new Uint8Array([3]) },
          { name: "bad.bin", bytes: "no" as unknown as Uint8Array },
        ],
        saveDocument: async () => ({ saved: true }),
      },
    });
    const files = await pickNativeFiles({ multiple: true });
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("kick.wav");
    expect(files[0].type).toBe("audio/wav");
    expect(files[0].size).toBe(2);
  });
});

describe("mobile audio session", () => {
  it("refcounts reasons and calls the native shell only on first/last", () => {
    const acquire = vi.fn();
    const release = vi.fn();
    setBridge({ platform: "android", audioSession: { acquire, release } });

    acquireMobileAudio("playback");
    acquireMobileAudio("playback");
    acquireMobileAudio("recording");
    expect(acquire.mock.calls).toEqual([["playback"], ["recording"]]);
    expect(getMobileAudioState()).toMatchObject({ playback: 2, recording: 1, native: true });

    releaseMobileAudio("playback");
    expect(release).not.toHaveBeenCalled();
    releaseMobileAudio("playback");
    expect(release).toHaveBeenCalledWith("playback");
    expect(getMobileAudioState()).toMatchObject({ playback: 0, recording: 1 });

    releaseAllMobileAudio();
    expect(release).toHaveBeenCalledWith("recording");
    expect(getMobileAudioState()).toMatchObject({ playback: 0, recording: 0 });
  });

  it("falls back to a screen wake lock and releases it with the last reason", async () => {
    const sentinel = { release: vi.fn(async () => {}), addEventListener: vi.fn() };
    const request = vi.fn(async () => sentinel);
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });

    acquireMobileAudio("playback");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
    await vi.waitFor(() => expect(getMobileAudioState().wakeLock).toBe(true));
    releaseMobileAudio("playback");
    expect(sentinel.release).toHaveBeenCalled();
    expect(getMobileAudioState().wakeLock).toBe(false);
  });

  it("does not hold a wake lock on the desktop profile", async () => {
    document.documentElement.setAttribute("data-mobile-profile", "desktop");
    const request = vi.fn(async () => ({ release: vi.fn(async () => {}) }));
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    acquireMobileAudio("playback");
    await Promise.resolve();
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    document.documentElement.removeAttribute("data-mobile-profile");
  });

  it("forwards shell audio-focus changes to subscribers", () => {
    let focusListener: ((focused: boolean) => void) | null = null;
    setBridge({
      platform: "android",
      audioSession: {
        acquire: () => {},
        release: () => {},
        subscribeFocus: (listener: (focused: boolean) => void) => {
          focusListener = listener;
          return () => {
            focusListener = null;
          };
        },
      },
    });
    const seen: boolean[] = [];
    const detach = subscribeMobileAudioFocus((focused) => seen.push(focused));
    const emitFocus = (focused: boolean) => {
      (focusListener as ((focused: boolean) => void) | null)?.(focused);
    };
    emitFocus(false);
    emitFocus(true);
    expect(seen).toEqual([false, true]);
    detach();
    expect(focusListener).toBeNull();
  });
});
