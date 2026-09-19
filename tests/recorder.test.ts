import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionForMime, LiveRecorder, pickMimeType } from "../src/audio-engine/recorder";

function makeRecorderDeps(tap: AudioNode | null = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode) {
  const destination = { stream: {} } as unknown as MediaStreamAudioDestinationNode;
  const ctx = {
    currentTime: 12,
    createMediaStreamDestination: vi.fn(() => destination),
  } as unknown as AudioContext;
  return {
    ctx,
    destination,
    deps: {
      ctx,
      getTapNode: vi.fn(() => tap),
      mimeCandidates: ["audio/webm"],
      isTypeSupported: vi.fn(() => true),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pickMimeType", () => {
  it("returns the first supported candidate in order", () => {
    const picked = pickMimeType(["audio/webm;codecs=opus", "audio/mp4"], (type) => type.startsWith("audio/webm"));
    expect(picked).toBe("audio/webm;codecs=opus");
  });

  it("skips unsupported entries", () => {
    const picked = pickMimeType(["audio/webm", "audio/ogg;codecs=opus"], (type) => type.includes("ogg"));
    expect(picked).toBe("audio/ogg;codecs=opus");
  });

  it("returns null when nothing is supported", () => {
    expect(pickMimeType(["audio/webm", "audio/mp4"], () => false)).toBeNull();
  });
});

describe("extensionForMime", () => {
  it("maps recorder mime types onto file extensions", () => {
    expect(extensionForMime("audio/webm;codecs=opus")).toBe(".webm");
    expect(extensionForMime("audio/ogg;codecs=opus")).toBe(".ogg");
    expect(extensionForMime("audio/mp4")).toBe(".m4a");
    expect(extensionForMime("audio/mpeg")).toBe(".mp3");
    expect(extensionForMime("")).toBe(".webm");
  });
});

describe("LiveRecorder failure cleanup", () => {
  it("cleans partial wiring when a source tap is unavailable", async () => {
    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const { deps } = makeRecorderDeps(null);
    const recorder = new LiveRecorder(deps);

    await expect(recorder.start({ kind: "master" })).rejects.toThrow("Master audio not loaded");
    expect(recorder.state).toBe("idle");
    expect((recorder as unknown as { dest: unknown }).dest).toBeNull();
  });

  it("does not hang when MediaRecorder.stop() throws", async () => {
    class ThrowingStopRecorder {
      static isTypeSupported() {
        return true;
      }
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start() {}
      stop() {
        throw new Error("already inactive");
      }
    }
    vi.stubGlobal("MediaRecorder", ThrowingStopRecorder);
    const { deps } = makeRecorderDeps();
    const recorder = new LiveRecorder(deps);
    await recorder.start({ kind: "master" });

    await expect(recorder.stop()).resolves.toBeNull();
    expect(recorder.state).toBe("idle");
    expect((recorder as unknown as { dest: unknown }).dest).toBeNull();
  });

  it("cancels a pending microphone permission request without adopting its late stream", async () => {
    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }
      start() {}
      stop() {}
    }
    const tracks = [{ stop: vi.fn() }];
    let resolveMic!: (stream: MediaStream) => void;
    const micPromise = new Promise<MediaStream>((resolve) => {
      resolveMic = resolve;
    });
    const originalMediaDevices = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(() => micPromise) },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    try {
      const { ctx, deps } = makeRecorderDeps();
      (ctx as unknown as { createMediaStreamSource: () => AudioNode }).createMediaStreamSource = () =>
        ({ connect: vi.fn(), disconnect: vi.fn() }) as unknown as AudioNode;
      const recorder = new LiveRecorder(deps);
      const pending = recorder.start({ kind: "mic" });
      await Promise.resolve();
      await expect(recorder.start({ kind: "mic" })).rejects.toThrow("Already starting");
      recorder.cancel();
      resolveMic({ getTracks: () => tracks } as unknown as MediaStream);

      await expect(pending).rejects.toThrow("cancelled");
      expect(tracks[0].stop).toHaveBeenCalledTimes(1);
      expect(recorder.state).toBe("idle");
      expect((recorder as unknown as { dest: unknown }).dest).toBeNull();
    } finally {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: originalMediaDevices });
    }
  });
});
