import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canExportVideo, pickVideoMimeType, recordVideo } from "../../src/export/video";

/**
 * Video export pipeline under jsdom: MediaRecorder, AudioContext, canvas 2D
 * and requestAnimationFrame are all stubbed so the FAILURE paths — the rAF
 * watchdog (hidden-tab hang, fixed in a prior audit but never pinned), the
 * recorder-error rejection, abort semantics and resource cleanup — are
 * exercised deterministically.
 *
 * Note: recordVideo parks on its first await (ctx.resume) before the
 * recorder exists — every test flushes microtasks before touching the fake
 * instances or pumping the frame queue.
 */

class FakeTrack {
  stopped = false;
  constructor(readonly kind: string) {}
  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream {
  tracks: FakeTrack[] = [];
  addTrack(t: FakeTrack): void {
    this.tracks.push(t);
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static supportedTypes = new Set<string>(['video/mp4;codecs="avc1.42E01E,mp4a.40.2"']);
  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supportedTypes.has(type);
  }

  stream: FakeMediaStream;
  opts: { mimeType?: string };
  state: "inactive" | "recording" = "inactive";
  startTimeslice: number | null = null;
  stopped = false;
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(stream: FakeMediaStream, opts?: { mimeType?: string }) {
    this.stream = stream;
    this.opts = opts ?? {};
    FakeMediaRecorder.instances.push(this);
  }
  start(timeslice?: number): void {
    this.state = "recording";
    this.startTimeslice = timeslice ?? null;
  }
  stop(): void {
    this.stopped = true;
    this.state = "inactive";
    // Blob chunks must be visible to onstop — resolve on a microtask like
    // real browsers do (dataavailable fires before stop resolves).
    queueMicrotask(() => this.onstop?.());
  }
  fireError(): void {
    this.onerror?.();
  }
  deliver(size: number): void {
    // Real Blob parts — a plain object part would be stringified by
    // Blob([part]) and corrupt the byte count.
    this.ondataavailable?.({ data: new Blob(["a".repeat(size)]) });
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  audioTracks: FakeTrack[] = [new FakeTrack("audio")];
  sourceStart = vi.fn();
  sourceStop = vi.fn();
  closeCalls = 0;

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {
    this.closeCalls++;
  }
  createMediaStreamDestination(): { stream: FakeMediaStream } {
    const stream = new FakeMediaStream();
    for (const t of this.audioTracks) stream.addTrack(t);
    return { stream };
  }
  createBufferSource(): {
    buffer: unknown;
    connect: () => void;
    start: (t: number) => void;
    stop: (t: number) => void;
  } {
    const self = this;
    return {
      buffer: null,
      connect: () => {},
      start: (t) => self.sourceStart(t),
      stop: (t) => self.sourceStop(t),
    };
  }
}

/** Canvas 2D stub — counts fillRect calls to prove frames were drawn. */
let drawCount = 0;
const fakeCtx2d = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === "canvas") return { width: 1080, height: 1920 };
      if (prop === "measureText") return () => ({ width: 8 });
      if (prop === "createRadialGradient")
        return () => ({
          addColorStop: () => {},
        });
      if (prop === "fillRect") return () => void drawCount++;
      return () => {};
    },
    set: () => true,
  },
);

const fakeBuffer = {
  duration: 3,
  getChannelData: () => new Float32Array(48000),
} as unknown as AudioBuffer;

/** rAF queue — callbacks are stored, never auto-fired (hidden-tab simulation). */
let rafQueue: FrameRequestCallback[] = [];
const flushAsync = async () => {
  // recordVideo parks at `await ctx.resume()` before constructing anything.
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const pumpFrame = () => {
  const cb = rafQueue.shift();
  if (cb) cb(0);
};

let canvasStream: FakeMediaStream | null = null;
// Loaded lazily by the harness so tests can hold a direct reference.
const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.supportedTypes = new Set(['video/mp4;codecs="avc1.42E01E,mp4a.40.2"']);
  FakeAudioContext.instances = [];
  drawCount = 0;
  rafQueue = [];
  canvasStream = null;
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  proto.getContext = () => fakeCtx2d;
  // jsdom has no captureStream at all — define it and remove it in afterEach.
  proto.captureStream = () => {
    const s = new FakeMediaStream();
    s.addTrack(new FakeTrack("video"));
    canvasStream = s;
    return s;
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete proto.captureStream;
  delete proto.getContext;
});

describe("pickVideoMimeType / canExportVideo", () => {
  it("prefers mp4 and falls back through the candidate list", () => {
    expect(pickVideoMimeType()).toBe('video/mp4;codecs="avc1.42E01E,mp4a.40.2"');
    FakeMediaRecorder.supportedTypes = new Set(['video/webm;codecs="vp8,opus"']);
    expect(pickVideoMimeType()).toBe('video/webm;codecs="vp8,opus"');
    FakeMediaRecorder.supportedTypes = new Set();
    expect(pickVideoMimeType()).toBeNull();
    expect(canExportVideo()).toBe(false);
  });

  it("reports unsupported when MediaRecorder is absent entirely", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    expect(canExportVideo()).toBe(false);
    expect(pickVideoMimeType()).toBeNull();
  });
});

describe("recordVideo", () => {
  it("happy path: draws frames, assembles the blob, reports progress, cleans up", async () => {
    const onProgress = vi.fn();
    const promise = recordVideo(fakeBuffer, { title: "Test Beat", bpm: 124, seconds: 1, onProgress });
    await flushAsync();
    const audioCtx = FakeAudioContext.instances[0];
    const recorder = FakeMediaRecorder.instances[0];
    expect(recorder).toBeDefined();
    recorder.deliver(700);
    recorder.deliver(300);

    // Pump the render loop forward in 100 ms steps (integer steps — float
    // accumulation off-by-one leaves the clock one step short of the exit).
    const t0 = 0.06;
    for (let i = 1; i <= 14; i++) {
      audioCtx.currentTime = i * 0.1;
      pumpFrame();
    }
    const result = await promise;

    expect(recorder.startTimeslice).toBe(250);
    expect(drawCount).toBeGreaterThan(0);
    // Audio scheduled relative to the (mocked) audio clock.
    expect(audioCtx.sourceStart).toHaveBeenCalledWith(t0);
    expect(audioCtx.sourceStop).toHaveBeenCalledWith(t0 + 1);
    // Progress reached completion.
    expect(onProgress).toHaveBeenCalledWith(1);
    expect(result.ext).toBe("mp4");
    expect(result.bytes).toBe(1000);
    expect(result.blob.size).toBe(1000);
    // Cleanup: every stream track stopped + audio context closed.
    expect(canvasStream?.getTracks().every((t) => t.stopped)).toBe(true);
    expect(audioCtx.closeCalls).toBe(1);
  });

  it("preserves a requested sub-second export duration", async () => {
    const promise = recordVideo(fakeBuffer, { title: "Stinger", bpm: 124, seconds: 0.5 });
    await flushAsync();
    const audioCtx = FakeAudioContext.instances[0];
    const recorder = FakeMediaRecorder.instances[0];
    expect(recorder).toBeDefined();

    audioCtx.currentTime = 0.9;
    pumpFrame();
    await promise;

    expect(audioCtx.sourceStop).toHaveBeenCalledWith(0.56);
    expect(recorder.stopped).toBe(true);
  });

  it("hidden-tab watchdog: finishes the export when requestAnimationFrame never fires", async () => {
    // Fake ONLY the timer functions — sinon's default toFake would replace
    // the rAF stub too, defeating the hidden-tab simulation.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const promise = recordVideo(fakeBuffer, { title: "T", bpm: 124, seconds: 1 });
    await flushAsync();
    const audioCtx = FakeAudioContext.instances[0];
    const recorder = FakeMediaRecorder.instances[0];
    expect(recorder).toBeDefined();

    // Simulate wall-clock audio time running past the clip while rAF is dead.
    audioCtx.currentTime = 2;
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    // The watchdog (not rAF) ended the loop: recorder.stop still ran, so the
    // export completes instead of hanging forever on a backgrounded tab.
    expect(recorder.stopped).toBe(true);
    expect(rafQueue.length).toBe(1); // the single loop callback never ran
    expect(result.ext).toBe("mp4");
    expect(canvasStream?.getTracks().every((t) => t.stopped)).toBe(true);
  });

  it("a MediaRecorder error rejects the export and still releases resources", async () => {
    const promise = recordVideo(fakeBuffer, { title: "T", bpm: 124, seconds: 1 });
    await flushAsync();
    const audioCtx = FakeAudioContext.instances[0];
    const recorder = FakeMediaRecorder.instances[0];
    audioCtx.currentTime = 0.3;
    pumpFrame();
    recorder.fireError();
    // The rejected `finished` promise is only awaited once the render loop
    // ends — finish the clip so the rejection propagates.
    audioCtx.currentTime = 2;
    pumpFrame();

    await expect(promise).rejects.toThrow(/Video recording failed/);
    expect(canvasStream?.getTracks().every((t) => t.stopped)).toBe(true);
    expect(audioCtx.closeCalls).toBe(1);
  });

  it("an abort signal cancels with AbortError and stops the stream tracks", async () => {
    const controller = new AbortController();
    const promise = recordVideo(fakeBuffer, {
      title: "T",
      bpm: 124,
      seconds: 1,
      signal: controller.signal,
    });
    await flushAsync();
    const audioCtx = FakeAudioContext.instances[0];
    audioCtx.currentTime = 0.3;
    pumpFrame();
    controller.abort();
    pumpFrame(); // loop observes the abort and resolves

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(canvasStream?.getTracks().every((t) => t.stopped)).toBe(true);
    expect(audioCtx.closeCalls).toBe(1);
  });

  it("throws a precise error when video export is unsupported", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    await expect(recordVideo(fakeBuffer, { title: "T", bpm: 124, seconds: 1 })).rejects.toThrow(
      /not supported in this browser/,
    );
  });
});
