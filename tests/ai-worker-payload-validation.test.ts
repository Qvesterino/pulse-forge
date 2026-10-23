import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE WORKER BOUNDARY MUST NOT TRUST `event.data`.
 *
 * The repository's own rule (AGENTS.md → "Defensive parsing"): every worker
 * `onmessage` validates `event.data` before using it, with
 * `src/intent/model-worker.ts` as the reference shape for a request/response
 * worker: an unshaped payload is dropped SILENTLY, because there is no
 * requestId to answer with.
 *
 * Four AI workers did not do that. They took the payload as-is and used it
 * INSIDE the catch block:
 *
 *   const request = event.data;
 *   try { … } catch (error) {
 *     const response = { type: request.type, requestId: request.requestId, … };
 *   }
 *
 * Two defects live in that shape:
 *
 * 1. `event.data === null` → `handle(null)` throws, and then the CATCH block
 *    throws too (reading `.type` of null). The response is never posted, so
 *    the caller waits for its FULL timeout before it gives up: 400 ms (ranker
 *    score), 500 ms (prior run), 3 s (both loads), 20 s (audio classify).
 *    The worker is not "killed" by the throw — it is deafened: it never
 *    answers, and the failure is mis-attributed to the model.
 *
 * 2. The `handle()` fall-through treats every type it does not know as
 *    "dispose". An unknown message type therefore RELEASES the loaded model
 *    (the prior worker releases EVERY kind's session), and the next request
 *    answers "model not loaded" — the whole lane silently degrades to the
 *    heuristic fallback.
 *
 * The assertions below are about the worker's OUTPUT (what it posts and what
 * it throws), not about its internal state: a guard that cannot see the
 * defect's shape is not a guard.
 */

type WorkerHandler = (event: MessageEvent) => unknown;

const WORKERS = [
  { name: "ranker", load: () => import("../src/ai/ranking/ranker-worker") },
  { name: "audio", load: () => import("../src/ai/audio/audio-worker") },
  { name: "semantic", load: () => import("../src/ai/semantic/semantic-worker") },
  { name: "prior", load: () => import("../src/ai/symbolic/prior-worker") },
] as const;

let previousOnMessage: typeof self.onmessage;
let previousPostMessage: typeof self.postMessage;

beforeEach(() => {
  previousOnMessage = self.onmessage;
  previousPostMessage = self.postMessage;
});

afterEach(() => {
  self.onmessage = previousOnMessage;
  self.postMessage = previousPostMessage;
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Mount a worker module and capture everything it posts back to the main thread. */
async function mountWorker(load: () => Promise<unknown>): Promise<{ handler: WorkerHandler; posted: unknown[] }> {
  const posted: unknown[] = [];
  vi.stubGlobal("postMessage", (message: unknown) => {
    posted.push(message);
  });
  vi.resetModules();
  await load();
  const handler = (self as unknown as { onmessage?: WorkerHandler }).onmessage;
  expect(typeof handler, "the worker must install an onmessage handler").toBe("function");
  return { handler: handler as WorkerHandler, posted };
}

describe.each(WORKERS)("the $name worker validates the payload", ({ name, load }) => {
  it("survives a null payload and answers nothing", async () => {
    const { handler, posted } = await mountWorker(load);

    await expect(
      Promise.resolve(handler({ data: null } as unknown as MessageEvent)),
      `${name}: a null payload must not take the worker down`,
    ).resolves.toBeUndefined();

    expect(posted, `${name}: there is no requestId to answer with — the payload must be dropped`).toHaveLength(0);
  });

  it("survives a payload that is not an object", async () => {
    const { handler, posted } = await mountWorker(load);

    for (const garbage of [undefined, "score", 42, true]) {
      await expect(
        Promise.resolve(handler({ data: garbage } as unknown as MessageEvent)),
        `${name}: a non-object payload must not take the worker down`,
      ).resolves.toBeUndefined();
    }

    expect(posted, `${name}: an unrecognisable payload must be dropped`).toHaveLength(0);
  });

  it("does not treat an unknown message type as a request", async () => {
    const { handler, posted } = await mountWorker(load);

    await expect(
      Promise.resolve(handler({ data: { type: "not-a-real-type", requestId: 7 } } as unknown as MessageEvent)),
      `${name}: an unknown type must not take the worker down`,
    ).resolves.toBeUndefined();

    expect(
      posted,
      `${name}: an unknown type must not be answered — the dispose fall-through would release the model`,
    ).toHaveLength(0);
  });

  it("answers a request it can correlate, even when the body is broken", async () => {
    const { handler, posted } = await mountWorker(load);

    const broken: Record<string, unknown> = { requestId: 7 };
    // A body that the type-specific handler rejects, but a request that still
    // carries the requestId the caller is waiting for.
    if (name === "ranker") broken.type = "score";
    else if (name === "audio") broken.type = "classify";
    else if (name === "semantic") broken.type = "embed";
    else broken.type = "run";

    await expect(
      Promise.resolve(handler({ data: broken } as unknown as MessageEvent)),
      `${name}: a broken body must not take the worker down`,
    ).resolves.toBeUndefined();

    expect(posted, `${name}: a request with a requestId must be answered`).toHaveLength(1);
    const answer = posted[0] as { requestId?: unknown; ok?: unknown };
    expect(answer.requestId, `${name}: the answer must carry the requestId the caller waits for`).toBe(7);
    expect(answer.ok, `${name}: a broken body is a controlled failure, not a success`).toBe(false);
  });
});
