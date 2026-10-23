import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE REFERENCE WORKER PROTOCOL: ONE ERROR TYPE PER LANE, AND A JOB ID THAT
 * IS ACTUALLY CHECKED.
 *
 * Two defects live in this boundary.
 *
 * 1. THE TRANSCRIPTION LANE POSTED THE WRONG ERROR TYPE.
 *    The worker catches a transcription failure and posts
 *    `{ type: "REFERENCE_ERROR" }` — the ANALYSIS lane's type. The
 *    transcription client listens for `TRANSCRIBE_ERROR`, a type the protocol
 *    union did not even declare. So the worker's own explanation was ignored
 *    by the lane it was meant for, and the call waited the FULL 120 s timeout
 *    before it degraded. (The earlier regression test asserted against a
 *    hand-written `TRANSCRIBE_ERROR` message — a shape the worker never
 *    produced — so it guarded the contract instead of the behaviour. This
 *    test drives the REAL worker and reads what it actually posts.)
 *
 * 2. THE `jobId` WAS NEVER COMPARED.
 *    Every worker answer carries the `jobId` of the request it belongs to,
 *    and the client compared none of them — the analysis lane accepted a
 *    result for any job, and the progress handler mirrored stages for any
 *    job. Worse, the id itself was `Date.now() & 0xffff`, which WRAPS every
 *    ~65.5 s: two analyses in different minutes could carry the same id, so
 *    even a comparison would have been ambiguous.
 */

vi.mock("../src/reference/transcribe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/reference/transcribe")>();
  return {
    ...actual,
    transcribeTrack: vi.fn(() => {
      throw new Error("transcription exploded");
    }),
  };
});

const settled = <T>(promise: Promise<T>, ms: number): Promise<"settled" | "still-pending"> =>
  Promise.race([
    promise.then(() => "settled" as const),
    new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), ms)),
  ]);

/** A worker that records what the client posted and can answer with any job id. */
class ScriptedWorker {
  static instances: ScriptedWorker[] = [];

  readonly posted: unknown[] = [];
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  terminated = false;

  constructor() {
    ScriptedWorker.instances.push(this);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== fn),
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
}

const mono = (): Float32Array => {
  const data = new Float32Array(44100);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.sin(index / 40) * 0.2;
  return data;
};

let previousOnMessage: typeof self.onmessage;
let previousPostMessage: typeof self.postMessage;

beforeEach(() => {
  ScriptedWorker.instances = [];
  previousOnMessage = self.onmessage;
  previousPostMessage = self.postMessage;
  vi.resetModules();
});

afterEach(() => {
  self.onmessage = previousOnMessage;
  self.postMessage = previousPostMessage;
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.useRealTimers();
});

describe("the reference worker posts the error type of its own lane", () => {
  it("a transcription failure is reported as TRANSCRIBE_ERROR", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("postMessage", (message: unknown) => {
      posted.push(message);
    });
    vi.resetModules();
    await import("../src/reference/workers/reference.worker");

    const handler = (self as unknown as { onmessage?: (event: MessageEvent) => unknown }).onmessage;
    expect(typeof handler).toBe("function");

    await Promise.resolve(
      handler?.({
        data: { type: "TRANSCRIBE_TRACK", jobId: 11, mono: new Float32Array(1024), sampleRate: 44100 },
      } as unknown as MessageEvent),
    );

    const answer = posted[0] as { type?: unknown; jobId?: unknown; message?: unknown };
    expect(answer?.type, "the transcription lane must post the transcription error type").toBe("TRANSCRIBE_ERROR");
    expect(answer?.jobId).toBe(11);
    expect(answer?.message).toBe("transcription exploded");
  });
});

describe("the reference client only accepts answers for its own job", () => {
  it("ignores a result that belongs to another job", async () => {
    vi.stubGlobal("Worker", ScriptedWorker as unknown as typeof Worker);
    const { analyzeReferenceAsync } = await import("../src/reference/reference-client");

    const stages: string[] = [];
    const pending = analyzeReferenceAsync({
      mono: mono(),
      metadata: { name: "take.wav", size: 44100, duration: 1, sampleRate: 44100, channels: 1 },
      onStage: (stage) => stages.push(stage),
    });

    await vi.waitFor(() => expect(ScriptedWorker.instances).toHaveLength(1));
    const worker = ScriptedWorker.instances[0];
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const { jobId } = worker.posted[0] as { jobId: number };

    // A stage and a result that belong to a DIFFERENT job.
    worker.emitMessage({ type: "PROGRESS_STAGE", jobId: jobId + 1, stage: "analyzing" });
    worker.emitMessage({ type: "REFERENCE_RESULT", jobId: jobId + 1, payload: { bpm: 999 } });

    expect(stages, "a stage of another job must not be mirrored to the caller").toHaveLength(0);
    expect(await settled(pending, 300), "a result of another job must not settle the call").toBe("still-pending");

    // The job's own answer settles it.
    worker.emitMessage({ type: "REFERENCE_RESULT", jobId, payload: { bpm: 120 } });
    expect(await settled(pending, 3000)).toBe("settled");
  });

  it("uses a job id that does not wrap every 65 seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", ScriptedWorker as unknown as typeof Worker);
    const { analyzeReferenceAsync } = await import("../src/reference/reference-client");

    const start = new Date("2026-10-23T12:00:00.000Z").getTime();
    vi.setSystemTime(start);
    const first = analyzeReferenceAsync({
      mono: mono(),
      metadata: { name: "a.wav", size: 44100, duration: 1, sampleRate: 44100, channels: 1 },
    });
    await vi.waitFor(() => expect(ScriptedWorker.instances).toHaveLength(1));
    await vi.waitFor(() => expect(ScriptedWorker.instances[0]?.posted).toHaveLength(1));

    // 65 536 ms later the 16-bit truncation of Date.now() repeats itself.
    vi.setSystemTime(start + 65_536);
    const second = analyzeReferenceAsync({
      mono: mono(),
      metadata: { name: "b.wav", size: 44100, duration: 1, sampleRate: 44100, channels: 1 },
    });
    await vi.waitFor(() => expect(ScriptedWorker.instances).toHaveLength(2));
    await vi.waitFor(() => expect(ScriptedWorker.instances[1]?.posted).toHaveLength(1));

    const firstId = (ScriptedWorker.instances[0]?.posted[0] as { jobId: number }).jobId;
    const secondId = (ScriptedWorker.instances[1]?.posted[0] as { jobId: number }).jobId;
    expect(secondId, "two analyses 65 s apart must not share a job id").not.toBe(firstId);

    // Both calls are still pending; the workers are terminated by the test teardown.
    void first;
    void second;
  });
});
