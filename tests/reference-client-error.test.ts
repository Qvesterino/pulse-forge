import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeReferenceAsync, transcribeTrackAsync } from "../src/reference/reference-client";

/**
 * A WORKER THAT REPORTS ITS OWN FAILURE MUST SETTLE THE CALLER.
 *
 * The reference worker catches everything it can and posts the reason back
 * (REFERENCE_ERROR / TRANSCRIBE_ERROR). The client only listened for
 * REFERENCE_RESULT / TRANSCRIBE_RESULT, so the error message was DROPPED: the
 * promise stayed pending until the 120 s timeout fired, and only then did the
 * client run the synchronous fallback — two minutes of silence followed by a
 * main-thread freeze, for a failure the worker had already explained.
 *
 * The test drives the real client with a fake worker that reports the error.
 * The assertion is about the WAIT: the call must settle now, not in two
 * minutes.
 */

class ScriptedWorker {
  static last: ScriptedWorker | null = null;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
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

  postMessage(): void {
    /* the client sends; the fake has nothing to do with the payload */
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    for (const fn of this.listeners.get("message") ?? []) fn({ data });
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
          super((worker) => worker.emitMessage({ type: "REFERENCE_ERROR", jobId: 1, message: "boom" }));
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
          super((worker) => worker.emitMessage({ type: "TRANSCRIBE_ERROR", jobId: 2, message: "boom" }));
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
          super((worker) => worker.emitMessage({ type: "REFERENCE_ERROR", jobId: 3, message: "boom" }));
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
