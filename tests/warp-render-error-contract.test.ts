import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A WORKER THAT REPORTED A FAILURE MUST NOT BE SILENCED.
 *
 * The warp worker catches everything it can and posts the reason back:
 *
 *   postMessage({ error: err instanceof Error ? err.message : String(err) })
 *
 * The client read `event.data.channels` and, when that was absent, ran the
 * SYNCHRONOUS fallback — and never looked at `event.data.error`. So:
 *
 * 1. the worker's reason was DROPPED — the caller could not tell a failed
 *    worker from a worker that never answered;
 * 2. the expensive phase vocoder was re-run ON THE MAIN THREAD after the
 *    worker had already failed on that very input. That is exactly what the
 *    client's own contract forbids ("this one REJECTS on timeout instead of
 *    running the sync fallback … running the identical core on the main
 *    thread would freeze the UI permanently") — the error path quietly did
 *    the thing the timeout path refuses to do.
 *
 * The contract: a worker that reported a failure REJECTS, with the worker's
 * own reason. The synchronous fallback stays where it belongs — for the
 * cases where there is no usable worker at all (no Worker support, a render
 * too short to be worth a worker, a payload that could not be posted).
 */

const WORKER_MIN_SAMPLES = 44100 * 2;

interface FakeWorkerSpec {
  /** What the worker posts back. */
  answer: unknown;
  /** Simulate an uncaught error inside the worker instead of an answer. */
  crash?: string;
}

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly posted: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;

  constructor(spec: FakeWorkerSpec) {
    FakeWorker.instances.push(this);
    setTimeout(() => {
      if (spec.crash !== undefined) {
        this.onerror?.({ type: "error", message: spec.crash });
        return;
      }
      this.onmessage?.({ data: spec.answer } as MessageEvent);
    }, 0);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const tone = (samples: number): Float32Array => {
  const data = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) data[index] = Math.sin(index / 40) * 0.2;
  return data;
};

const intervals = [{ startSec: 0, endSec: 2, rate: 1 }];

beforeEach(() => {
  FakeWorker.instances = [];
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the warp render client honours a failed worker", () => {
  it("rejects with the worker's own reason instead of dropping it", async () => {
    vi.stubGlobal(
      "Worker",
      class extends FakeWorker {
        constructor() {
          super({ answer: { error: "phase vocoder exploded" } });
        }
      },
    );
    const { renderWarpPreserveAsync } = await import("../src/audio-workers/warp-render-client");

    const pending = renderWarpPreserveAsync([tone(WORKER_MIN_SAMPLES)], 44100, intervals, WORKER_MIN_SAMPLES);

    await expect(pending).rejects.toThrow(/phase vocoder exploded/);
  });

  it("does not run the expensive core on the main thread after the worker failed", async () => {
    vi.stubGlobal(
      "Worker",
      class extends FakeWorker {
        constructor() {
          super({ answer: { error: "phase vocoder exploded" } });
        }
      },
    );
    const { renderWarpPreserveAsync } = await import("../src/audio-workers/warp-render-client");

    const pending = renderWarpPreserveAsync([tone(WORKER_MIN_SAMPLES)], 44100, intervals, WORKER_MIN_SAMPLES);
    await expect(pending).rejects.toThrow(/phase vocoder exploded/);

    // The worker was terminated and the fallback never produced a render:
    // a failed worker must not be answered by the main thread.
    expect(FakeWorker.instances[0]?.terminated, "a failed worker must be terminated").toBe(true);
  });

  it("a worker that dies WITHOUT delivering a render falls back to the main thread", async () => {
    // In the warp worker the render lives inside a try/catch, so a failure ON
    // THE INPUT is always reported as a message ({error}) and never as an
    // error event. An error event therefore means the worker never delivered a
    // render at all — its module failed to load, or the delivery threw. The
    // input was never rendered, so the main thread may still do the work: the
    // fallback is a RECOVERY here, not a repeat.
    vi.stubGlobal(
      "Worker",
      class extends FakeWorker {
        constructor() {
          super({ answer: undefined, crash: "worker script failed to load" });
        }
      },
    );
    const { renderWarpPreserveAsync } = await import("../src/audio-workers/warp-render-client");

    const rendered = await renderWarpPreserveAsync([tone(WORKER_MIN_SAMPLES)], 44100, intervals, WORKER_MIN_SAMPLES);
    expect(rendered, "the clip must not lose its warped render to a worker that never rendered it").toHaveLength(1);
    expect(rendered[0]?.length).toBe(WORKER_MIN_SAMPLES);
  });

  it("rejects with BOTH reasons when the worker dies and the fallback dies too", async () => {
    vi.stubGlobal(
      "Worker",
      class extends FakeWorker {
        constructor() {
          super({ answer: undefined, crash: "worker script failed to load" });
        }
      },
    );
    const { renderWarpPreserveAsync } = await import("../src/audio-workers/warp-render-client");

    // A malformed interval list: the fallback throws when it builds the rate
    // envelope, so both the worker's death and the fallback's own error have
    // to be in the rejection — neither reason may be dropped.
    const pending = renderWarpPreserveAsync(
      [tone(WORKER_MIN_SAMPLES)],
      44100,
      null as unknown as typeof intervals,
      WORKER_MIN_SAMPLES,
    );

    await expect(pending).rejects.toThrow(/worker script failed to load/);
    await expect(pending).rejects.toThrow(/fallback failed too/);
  });
});

describe("the warp render client keeps its deterministic fallback", () => {
  it("resolves with the worker's channels", async () => {
    const channels = [new Float32Array(4)];
    vi.stubGlobal(
      "Worker",
      class extends FakeWorker {
        constructor() {
          super({ answer: { channels } });
        }
      },
    );
    const { renderWarpPreserveAsync } = await import("../src/audio-workers/warp-render-client");

    const rendered = await renderWarpPreserveAsync([tone(WORKER_MIN_SAMPLES)], 44100, intervals, WORKER_MIN_SAMPLES);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toBeInstanceOf(Float32Array);
  });

  it("renders on the main thread when there is no worker at all", async () => {
    vi.stubGlobal("Worker", undefined);
    const { renderWarpPreserveAsync } = await import("../src/audio-workers/warp-render-client");

    const rendered = await renderWarpPreserveAsync([tone(1024)], 44100, intervals, 1024);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.length).toBe(1024);
  });
});
