import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeReferenceAsync, transcribeTrackAsync } from "../src/reference/reference-client";

/**
 * A WORKER THAT REPORTS ITS OWN FAILURE MUST SETTLE THE CALLER.
 *
 * The reference worker catches everything it can and posts the reason back
 * (REFERENCE_ERROR for the analysis lane, TRANSCRIBE_ERROR for the
 * transcription lane). The client only listened for REFERENCE_RESULT /
 * TRANSCRIBE_RESULT, so the error message was DROPPED: the promise stayed
 * pending until the 120 s timeout fired, and only then did the client run the
 * synchronous fallback — two minutes of silence followed by a main-thread
 * freeze, for a failure the worker had already explained.
 *
 * The test drives the real client with a fake worker that reports the error.
 * The assertion is about the WAIT: the call must settle now, not in two
 * minutes.
 *
 * The job id is ECHOED, because the real worker echoes it and the client
 * checks it. The wire format itself is pinned by
 * `tests/reference-job-correlation.test.ts`, which drives the REAL worker and
 * reads what it actually posts — this test alone could not catch a worker
 * that reported the wrong error type.
 */

class ScriptedWorker {
  static last: ScriptedWorker | null = null;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  /** What the client posted — the worker echoes the job id of its request. */
  readonly posted: unknown[] = [];
  terminated = false;

  constructor(private readonly script: (worker: ScriptedWorker) => void) {
    ScriptedWorker.last = this;
    // Deliver the scripted message on the next tick, like a real worker.
    setTimeout(() => this.script(this), 0);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== fn),
    );
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    for (const fn of this.listeners.get("message") ?? []) fn({ data });
  }

  /** The job id the client sent — the worker answers with the same one. */
  get jobId(): number {
    return (this.posted[0] as { jobId: number }).jobId;
  }
}

const settled = <T>(promise: Promise<T>, ms: number): Promise<"settled" | "still-pending"> =>
  Promise.race([
    promise.then(() => "settled" as const),
    new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), ms)),
  ]);

afterEach(() => {
  vi.unstubAllGlobals();
  ScriptedWorker.last = null;
});

describe("the reference client settles on the worker's own error", () => {
  it("REFERENCE_ERROR resolves the analysis immediately", async () => {
    vi.stubGlobal(
      "Worker",
      class extends ScriptedWorker {
        constructor() {
          super((worker) => worker.emitMessage({ type: "REFERENCE_ERROR", jobId: worker.jobId, message: "boom" }));
        }
      },
    );

    const mono = new Float32Array(44100);
    for (let i = 0; i < mono.length; i += 1) mono[i] = Math.sin(i / 40) * 0.2;

    const promise = analyzeReferenceAsync({
      mono,
      metadata: { name: "take.wav", size: mono.byteLength, duration: 1, sampleRate: 44100, channels: 1 },
    });

    expect(await settled(promise, 3000), "the call must not wait for the 120 s timeout").toBe("settled");
    const output = await promise;
    expect(output).toBeTruthy();
  });

  it("TRANSCRIBE_ERROR resolves the transcription immediately", async () => {
    vi.stubGlobal(
      "Worker",
      class extends ScriptedWorker {
        constructor() {
          super((worker) => worker.emitMessage({ type: "TRANSCRIBE_ERROR", jobId: worker.jobId, message: "boom" }));
        }
      },
    );

    const pcm = new Float32Array(44100);
    const promise = transcribeTrackAsync(pcm, 44100);

    expect(await settled(promise, 3000), "the call must not wait for the 120 s timeout").toBe("settled");
    const output = await promise;
    expect(output).toBeTruthy();
  });

  it("the worker is terminated once the error settled the call", async () => {
    vi.stubGlobal(
      "Worker",
      class extends ScriptedWorker {
        constructor() {
          super((worker) => worker.emitMessage({ type: "REFERENCE_ERROR", jobId: worker.jobId, message: "boom" }));
        }
      },
    );

    const mono = new Float32Array(44100);
    await analyzeReferenceAsync({
      mono,
      metadata: { name: "take.wav", size: mono.byteLength, duration: 1, sampleRate: 44100, channels: 1 },
    });

    expect(ScriptedWorker.last?.terminated, "a settled worker must be terminated").toBe(true);
  });
});
