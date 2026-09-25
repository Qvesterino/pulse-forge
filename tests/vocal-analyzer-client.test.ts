import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeVocalTake, resetVocalAnalyzer } from "../src/vocal/analyzer-client";

/**
 * VOCAL ANALYZER CLIENT — failure-path contract (GOAL 04, re-run 4).
 *
 * The client promises: never throw, always answer (worker result OR the
 * pure-DSP synchronous fallback), and — new — a worker that ERRORS is
 * disabled immediately: pending requests fall through to the sync path
 * instead of burning the 20 s timeout, and no new worker is spawned.
 * Before this suite the client had no direct test coverage at all.
 */

const SR = 16000;

function sine(freq: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

let spawnCount = 0;
let fireError: (() => void) | null = null;

class DyingWorker {
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  constructor() {
    spawnCount += 1;
    // The worker dies as soon as it receives work — the class of failure
    // (script load error, uncaught exception) onerror covers.
    fireError = () => this.onerror?.();
  }
  addEventListener() {}
  removeEventListener() {}
  postMessage() {
    // Deliver the death asynchronously, like a real worker error event.
    setTimeout(() => fireError?.(), 0);
  }
  terminate() {
    this.terminated = true;
  }
}

describe("vocal analyzer client — worker failure paths", () => {
  beforeEach(() => {
    resetVocalAnalyzer();
    spawnCount = 0;
    vi.stubGlobal("Worker", DyingWorker as unknown as typeof Worker);
  });

  afterEach(() => {
    resetVocalAnalyzer();
    vi.unstubAllGlobals();
  });

  it("a worker that dies mid-request answers via the sync fallback instead of timing out", async () => {
    const start = Date.now();
    const outcome = await analyzeVocalTake(sine(440, 3), SR, 120);
    const elapsed = Date.now() - start;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // The sync path really analyzed the take — 3 s at 440 Hz is above the
      // key-detection floor (same fixture as the analyze suite).
      expect(outcome.profile.keyMeasured).toBe(true);
    }
    // Fail-fast: the answer must arrive in milliseconds, not after the 20 s
    // ANALYZE_TIMEOUT_MS backstop.
    expect(elapsed).toBeLessThan(5000);
  });

  it("an errored worker is disabled for the session — no respawn on the next call", async () => {
    await analyzeVocalTake(sine(220, 1), SR, 120);
    expect(spawnCount).toBe(1);
    const second = await analyzeVocalTake(sine(220, 1), SR, 120);
    expect(second.ok).toBe(true);
    expect(spawnCount).toBe(1); // disabled, sync path direct
  });

  it("empty input refuses without touching the worker", async () => {
    const outcome = await analyzeVocalTake(new Float32Array(0), SR, 120);
    expect(outcome).toEqual({ ok: false, error: "empty-take" });
    expect(spawnCount).toBe(0);
  });
});
