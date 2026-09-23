import { describe, expect, it, vi } from "vitest";
import { bindGenerativeContextLifecycle, type GenerativeLiveContextSource } from "../src/generative/context-lifecycle";

class FakeAudioContext extends EventTarget {
  constructor(public state: AudioContextState) {
    super();
  }

  setState(state: AudioContextState): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

function makeContextSource(initial: FakeAudioContext | null) {
  let listener: ((context: AudioContext | null) => void) | null = null;
  const source: GenerativeLiveContextSource = {
    subscribeLiveContext(callback) {
      listener = callback;
      callback(initial as unknown as AudioContext | null);
      return () => {
        listener = null;
      };
    },
  };
  return {
    source,
    emit(context: FakeAudioContext | null) {
      listener?.(context as unknown as AudioContext | null);
    },
    subscribed: () => listener !== null,
  };
}

async function flushTransitions(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

describe("generative AudioContext lifecycle", () => {
  it("serializes provider stop before restart when a suspended context resumes", async () => {
    const context = new FakeAudioContext("running");
    const source = makeContextSource(context);
    const transport = { playing: false };
    const calls: string[] = [];
    let finishStop: (() => void) | undefined;
    const runtime = {
      stopAll: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            calls.push("stop:start");
            finishStop = () => {
              calls.push("stop:end");
              resolve();
            };
          }),
      ),
      startAll: vi.fn(async () => {
        calls.push("start");
      }),
    };
    const lifecycle = bindGenerativeContextLifecycle(source.source, runtime, () => transport.playing);
    transport.playing = true;

    context.setState("suspended");
    await flushTransitions();
    expect(calls).toEqual(["stop:start"]);

    context.setState("running");
    await flushTransitions();
    expect(calls).toEqual(["stop:start"]);

    finishStop?.();
    await flushTransitions();
    expect(calls).toEqual(["stop:start", "stop:end", "start"]);
    lifecycle.dispose();
  });

  it("rebinds after context loss and replacement, then restarts the provider", async () => {
    const original = new FakeAudioContext("running");
    const source = makeContextSource(original);
    const transport = { playing: true };
    const runtime = { stopAll: vi.fn(async () => undefined), startAll: vi.fn(async () => undefined) };
    const lifecycle = bindGenerativeContextLifecycle(source.source, runtime, () => transport.playing);

    source.emit(null);
    await flushTransitions();
    expect(runtime.stopAll).toHaveBeenCalledTimes(1);

    source.emit(new FakeAudioContext("running"));
    await flushTransitions();
    original.setState("suspended");
    await flushTransitions();

    expect(runtime.stopAll).toHaveBeenCalledTimes(1);
    expect(runtime.startAll).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
  });

  it("does not restart after transport playback stops during a context interruption", async () => {
    const context = new FakeAudioContext("running");
    const source = makeContextSource(context);
    const transport = { playing: true };
    const runtime = { stopAll: vi.fn(async () => undefined), startAll: vi.fn(async () => undefined) };
    const lifecycle = bindGenerativeContextLifecycle(source.source, runtime, () => transport.playing);

    context.setState("suspended");
    await flushTransitions();
    transport.playing = false;
    context.setState("running");
    await flushTransitions();

    expect(runtime.stopAll).toHaveBeenCalledTimes(1);
    expect(runtime.startAll).not.toHaveBeenCalled();
    lifecycle.dispose();
  });

  it("removes context listeners and ignores later engine notifications on dispose", async () => {
    const context = new FakeAudioContext("running");
    const source = makeContextSource(context);
    const runtime = { stopAll: vi.fn(async () => undefined), startAll: vi.fn(async () => undefined) };
    const lifecycle = bindGenerativeContextLifecycle(source.source, runtime, () => true);

    lifecycle.dispose();
    expect(source.subscribed()).toBe(false);
    context.setState("suspended");
    source.emit(new FakeAudioContext("running"));
    await flushTransitions();

    expect(runtime.stopAll).not.toHaveBeenCalled();
    expect(runtime.startAll).not.toHaveBeenCalled();
  });
});
