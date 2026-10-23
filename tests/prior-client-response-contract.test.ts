import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resetPriorClient, runMelodicNextV3 } from "../src/ai/symbolic/prior-client";

/**
 * A SUCCESSFUL WORKER RESPONSE IS NOT A FAILURE.
 *
 * The client checked the worker's answer with
 *
 *     if (!response.ok === false || response.type !== "run" || !response.outputs)
 *
 * `!response.ok === false` parses as `(!response.ok) === false`, which is TRUE
 * exactly when the response was SUCCESSFUL — so the success path took the
 * failure branch and every run degraded to the fallback. The worker was
 * never wrong; the client could not read its own answer.
 *
 * The test fakes the worker and the manifest fetch, so the only thing that
 * can decide the outcome is how the client reads the response.
 *
 * (The v3 melodic model itself is parked — its pre-registered gate did not
 * pass and it has no caller. This test does not switch the model on; it
 * pins the RESPONSE CONTRACT of the lane, which is the same code the live
 * v1/v2 lanes use.)
 */

const MANIFEST = JSON.parse(readFileSync("public/models/symbolic-melodic-v3.manifest.json", "utf8")) as {
  featureCount: number;
  degreeClasses: number;
  durationClasses: number;
  degreeOutputName: string;
  durationOutputName: string;
};

class ScriptedPriorWorker {
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

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

  terminate(): void {
    /* nothing to release */
  }

  postMessage(request: { type: string; requestId: number }): void {
    const reply = (data: unknown) => {
      for (const fn of this.listeners.get("message") ?? []) fn({ data });
    };
    if (request.type === "load") {
      reply({ type: "load", requestId: request.requestId, ok: true });
      return;
    }
    const outputs: Record<string, number[]> = {};
    for (let row = 0; row < 1; row += 1) {
      outputs[`${MANIFEST.degreeOutputName}:${row}`] = new Array(MANIFEST.degreeClasses).fill(0.25);
      outputs[`${MANIFEST.durationOutputName}:${row}`] = new Array(MANIFEST.durationClasses).fill(0.5);
    }
    reply({ type: "run", requestId: request.requestId, ok: true, outputs });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetPriorClient();
});

describe("the prior client reads a successful worker response as a success", () => {
  it("a successful run returns the model's answer, not the fallback", async () => {
    vi.stubGlobal("Worker", ScriptedPriorWorker);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ...MANIFEST, kind: "melodic-v3" }),
      })),
    );

    const values = new Float32Array(MANIFEST.featureCount);
    const result = await runMelodicNextV3(values, 1);

    expect(result.source, "a successful worker answer must not be read as a failure").toBe("model");
    expect(result.ok).toBe(true);
    expect(result.degree).toHaveLength(MANIFEST.degreeClasses);
    expect(result.duration).toHaveLength(MANIFEST.durationClasses);
  });
});
