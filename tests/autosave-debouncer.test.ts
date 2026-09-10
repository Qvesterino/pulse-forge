import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosaveDebouncer } from "../src/persistence/autosave-debouncer";

/**
 * Regression tests for the autosave debouncer — the D.1 hardening
 * fix from the Performance / Memory / Churn / Latency recon.
 *
 * Pure helper, no DOM / IndexedDB dependency: the test harness
 * injects `now`, `setTimeout` and `clearTimeout` so we can drive
 * the burst boundaries with `vi.useFakeTimers` and assert against
 * the exact call sequence. Pulse Forge's `services.ts` constructs
 * the debouncer without these overrides; the production wiring is
 * covered indirectly by the existing `services` smoke tests
 * (CollabPanel, new-instruments) — which must still pass after
 * the refactor.
 */

describe("autosave-debouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes once after the debounce window when there is a single edit", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const deb = createAutosaveDebouncer({
      flush,
      debounceMs: 800,
      maxDeferMs: 5000,
      maxArms: 50,
    });
    deb.arm();
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(799);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid re-arms into a single deferred flush (debounce behavior)", async () => {
    // Without the D.1 fix, every arm clears+resets the timer —
    // 60 re-arms per second never let the timer fire. The debouncer
    // must still behave correctly when the burst stays inside the
    // normal debounce window: 50 re-arms in 4 s should commit
    // exactly once, 800 ms after the LAST arm.
    const flush = vi.fn().mockResolvedValue(undefined);
    const deb = createAutosaveDebouncer({
      flush,
      debounceMs: 800,
      maxDeferMs: 5000,
      maxArms: 50,
    });
    for (let i = 0; i < 50; i++) {
      deb.arm();
      await vi.advanceTimersByTimeAsync(80);
    }
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("force-flushes immediately when the burst age crosses maxDeferMs", async () => {
    // Defect D.1: a continuous gesture that runs longer than
    // maxDeferMs without the user pausing MUST commit, otherwise
    // a tab close mid-gesture drops the last 5+ s of edits.
    // debounceMs is set huge here so the debounce timer never
    // expires before the time cap trips — the test asserts the
    // cap path exclusively.
    const flush = vi.fn().mockResolvedValue(undefined);
    const deb = createAutosaveDebouncer({
      flush,
      debounceMs: 1_000_000,
      maxDeferMs: 5000,
      maxArms: 1000, // effectively disable the arm cap
    });
    deb.arm();
    await vi.advanceTimersByTimeAsync(4000);
    // Still inside the time cap and the debounce window.
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1001);
    deb.arm();
    // > 5 s after the first arm. The next arm force-flushes
    // synchronously inside `arm()` — the caller does not need
    // to wait for a timer.
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("force-flushes immediately when the arm count crosses maxArms", async () => {
    // Mirrors the 60 Hz fader drag: within 800 ms the user has
    // re-armed >50 times; the burst is too hot to defer further.
    const flush = vi.fn().mockResolvedValue(undefined);
    const deb = createAutosaveDebouncer({
      flush,
      debounceMs: 800,
      maxDeferMs: 60000, // disable the time cap for this test
      maxArms: 50,
    });
    for (let i = 0; i < 50; i++) {
      deb.arm();
      await vi.advanceTimersByTimeAsync(10);
    }
    // 50 arms still under the cap — defer.
    expect(flush).not.toHaveBeenCalled();
    deb.arm();
    // 51st arm trips the cap.
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("resets the burst counters after a successful flush", async () => {
    // After a force-flush, the next arm must start a fresh burst
    // (firstArmTime reset, armCount back to 0). Without this,
    // every subsequent edit would instantly re-trip the cap and
    // there would be no debounce at all. debounceMs is huge here
    // for the same reason as the time-cap test above — so the
    // debounce timer never expires and only the cap path fires.
    const flush = vi.fn().mockResolvedValue(undefined);
    const deb = createAutosaveDebouncer({
      flush,
      debounceMs: 1_000_000,
      maxDeferMs: 5000,
      maxArms: 50,
    });
    deb.arm();
    await vi.advanceTimersByTimeAsync(5001);
    deb.arm(); // force-flush (>5 s after the first arm)
    expect(flush).toHaveBeenCalledTimes(1);
    // The burst counters must reset SYNCHRONOUSLY so a follow-up
    // arm starts fresh even before the in-flight flush resolves.
    expect(deb.state.armCount).toBe(0);
    expect(deb.state.firstArmTime).toBeNull();
    deb.arm();
    // The follow-up arm starts a NEW burst — well below the cap
    // and the debounce timer is huge, so no second flush yet.
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("flush() clears the pending timer and force-flushes immediately", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const deb = createAutosaveDebouncer({
      flush,
      debounceMs: 800,
      maxDeferMs: 5000,
      maxArms: 50,
    });
    deb.arm();
    await vi.advanceTimersByTimeAsync(100);
    await deb.flush();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("cancel() clears the timer and resets the burst", () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const deb = createAutosaveDebouncer({
      flush,
      debounceMs: 800,
      maxDeferMs: 5000,
      maxArms: 50,
    });
    deb.arm();
    deb.cancel();
    expect(flush).not.toHaveBeenCalled();
    expect(deb.state.armCount).toBe(0);
    expect(deb.state.firstArmTime).toBeNull();
  });

  it("coalesces a force-flush and a debounce-driven flush when they race", async () => {
    // The 50th arm trips the cap and starts a force-flush. The
    // pending debounce timer is cleared in the same call, so the
    // timer cannot fire a second time after the force-flush
    // resolves. Total flushes must be 1, not 2.
    let resolveFlush!: () => void;
    const flush = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveFlush = res;
        }),
    );
    const deb = createAutosaveDebouncer({
      flush,
      debounceMs: 800,
      maxDeferMs: 5000,
      maxArms: 50,
    });
    for (let i = 0; i < 50; i++) {
      deb.arm();
      await vi.advanceTimersByTimeAsync(10);
    }
    deb.arm(); // trips cap → starts flush
    expect(flush).toHaveBeenCalledTimes(1);
    expect(deb.state.pending).toBe(true);
    resolveFlush();
    // Let the in-flight flush settle.
    await vi.advanceTimersByTimeAsync(0);
    expect(deb.state.pending).toBe(false);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
