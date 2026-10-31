import { afterEach, describe, expect, it, vi } from "vitest";
import { PcmPlaybackController } from "../src/audio-engine/pcmPlayback";

type PcmStartRequest = { sab: SharedArrayBuffer; host: string; args: string[] };
type PcmStartResult = { ok: boolean; id?: string; error?: string };
type PcmStart = (request: PcmStartRequest) => Promise<PcmStartResult>;

class FakeAudioWorkletNode {
  readonly port = { postMessage: vi.fn() };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();

  constructor() {
    workletNodes.push(this);
  }
}

const workletNodes: FakeAudioWorkletNode[] = [];

function makeContext(addModule = vi.fn(async () => {})): BaseAudioContext {
  return {
    state: "running",
    sampleRate: 48000,
    destination: {},
    audioWorklet: { addModule },
  } as unknown as BaseAudioContext;
}

function setup(
  start: PcmStart,
  context: BaseAudioContext = makeContext(),
  stop: (id: string) => Promise<unknown> = vi.fn(async (_id: string) => undefined),
) {
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  vi.stubGlobal("kyxDesktop", { pcm: { start, stop } });
  const controller = new PcmPlaybackController(() => context);
  return { controller, context, start, stop };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
  workletNodes.length = 0;
});

describe("PcmPlaybackController lifecycle", () => {
  it("disconnects the worklet and returns to off when the desktop start rejects", async () => {
    const { controller } = setup(async () => {
      throw new Error("host failed");
    });

    await expect(controller.start("pcm-gen")).rejects.toThrow("host failed");

    expect(workletNodes).toHaveLength(1);
    expect(workletNodes[0].disconnect).toHaveBeenCalledOnce();
    expect(controller.active).toBe(false);
    expect(controller.getState()).toBe("off");
  });

  it("stays stopped when Stop races a pending native start", async () => {
    const startResult = deferred<PcmStartResult>();
    const start = vi.fn(() => startResult.promise);
    const { controller, stop } = setup(start);
    const pendingStart = controller.start("pcm-gen");
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const node = workletNodes[0];

    await controller.stop();
    expect(controller.getState()).toBe("off");
    expect(node.disconnect).toHaveBeenCalledOnce();

    startResult.resolve({ ok: true, id: "late-session" });
    await pendingStart;

    expect(stop).toHaveBeenCalledWith("late-session");
    expect(node.connect).not.toHaveBeenCalled();
    expect(controller.active).toBe(false);
    expect(controller.getState()).toBe("off");
  });

  it("serializes overlapping starts and stops the superseded session", async () => {
    const results = [deferred<PcmStartResult>(), deferred<PcmStartResult>()];
    let startIndex = 0;
    const start = vi.fn(() => results[startIndex++].promise);
    const { controller, stop } = setup(start);

    const first = controller.start("pcm-gen");
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const firstNode = workletNodes[0];
    const second = controller.start("asio-host");
    expect(firstNode.disconnect).toHaveBeenCalledOnce();

    results[0].resolve({ ok: true, id: "superseded" });
    await first;
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    const secondNode = workletNodes[1];
    results[1].resolve({ ok: true, id: "current" });
    await second;

    expect(stop).toHaveBeenCalledWith("superseded");
    expect(firstNode.connect).not.toHaveBeenCalled();
    expect(secondNode.connect).toHaveBeenCalledOnce();
    expect(controller.getState()).toBe("on");

    await controller.stop();
    expect(stop).toHaveBeenCalledWith("current");
    expect(secondNode.disconnect).toHaveBeenCalledOnce();
  });

  it("waits for the native Stop request before starting again", async () => {
    const stopResult = deferred<unknown>();
    let startCount = 0;
    const start = vi.fn(async () => ({ ok: true, id: `session-${++startCount}` }));
    const stop = vi.fn(() => stopResult.promise);
    const { controller } = setup(start, makeContext(), stop);
    await controller.start("pcm-gen");

    const stopping = controller.stop();
    const nextStart = controller.start("asio-host");
    await Promise.resolve();
    expect(start).toHaveBeenCalledOnce();

    stopResult.resolve(undefined);
    await stopping;
    await nextStart;

    expect(start).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toBe("on");
  });

  it("does not attach to a context replaced while its worklet module loads", async () => {
    const moduleLoad = deferred<void>();
    const addModule = vi.fn(() => moduleLoad.promise);
    const oldContext = makeContext(addModule);
    const newContext = makeContext();
    let currentContext = oldContext;
    const start = vi.fn(async () => ({ ok: true, id: "should-not-start" }));
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal("kyxDesktop", { pcm: { start, stop: vi.fn(async () => undefined) } });
    const controller = new PcmPlaybackController(() => currentContext);

    const pendingStart = controller.start("pcm-gen");
    await vi.waitFor(() => expect(addModule).toHaveBeenCalledOnce());
    currentContext = newContext;
    moduleLoad.resolve();

    await expect(pendingStart).rejects.toThrow("Audio context changed");
    expect(start).not.toHaveBeenCalled();
    expect(workletNodes).toHaveLength(0);
    expect(controller.getState()).toBe("off");
  });
});
