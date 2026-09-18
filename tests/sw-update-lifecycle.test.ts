/**
 * Regression tests for `src/sw-update.ts` lifecycle.
 *
 * The module owns a long-lived setInterval (15 min poll) and a global
 * document listener (visibilitychange → check-for-update). Without an
 * idempotent `initSwUpdate` and a paired `disposeSwUpdate`, HMR re-runs of
 * main.tsx would double up both handlers and the poll would keep ticking
 * after the host component unmounts.
 *
 * The module imports `virtual:pwa-register`, which only resolves inside
 * Vite's PWA plugin graph. We mock that module here so the unit tests can
 * exercise the lifecycle without standing up the full plugin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registerSW = vi.fn((_opts?: unknown) => async (_reload?: boolean) => {});
vi.mock("virtual:pwa-register", () => ({ registerSW }));

// Import AFTER the mock so initSwUpdate sees the stubbed registerSW.
const { initSwUpdate, disposeSwUpdate } = await import("../src/sw-update");

const addSpy = vi.spyOn(document, "addEventListener");
const removeSpy = vi.spyOn(document, "removeEventListener");
const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

beforeEach(() => {
  // Reset module state between tests — dispose first in case the previous
  // test left the module initialized, then clear spy state.
  disposeSwUpdate();
  addSpy.mockClear();
  removeSpy.mockClear();
  setIntervalSpy.mockClear();
  clearIntervalSpy.mockClear();
  registerSW.mockClear();
});

afterEach(() => {
  disposeSwUpdate();
  // Remove any visibilitychange listener we may have left on document.body
  // — tests should always clean up; this is a belt-and-braces guard.
  for (const listener of addSpy.mock.calls
    .filter((c) => c[0] === "visibilitychange")
    .map((c) => c[1] as EventListener)) {
    document.removeEventListener("visibilitychange", listener);
  }
});

describe("sw-update lifecycle", () => {
  it("initSwUpdate is idempotent — does not stack intervals or listeners on repeat calls", () => {
    initSwUpdate();
    const addAfterFirst = addSpy.mock.calls.filter((c) => c[0] === "visibilitychange").length;
    const setIntervalAfterFirst = setIntervalSpy.mock.calls.length;

    initSwUpdate();
    initSwUpdate();

    const addAfterAll = addSpy.mock.calls.filter((c) => c[0] === "visibilitychange").length;
    const setIntervalAfterAll = setIntervalSpy.mock.calls.length;

    expect(addAfterFirst).toBe(1);
    expect(setIntervalAfterFirst).toBe(1);
    expect(addAfterAll).toBe(1); // still 1 — second & third calls were no-ops
    expect(setIntervalAfterAll).toBe(1);
  });

  it("disposeSwUpdate clears the poll interval and removes the visibilitychange listener", () => {
    initSwUpdate();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls.filter((c) => c[0] === "visibilitychange")).toHaveLength(1);

    disposeSwUpdate();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy.mock.calls.filter((c) => c[0] === "visibilitychange")).toHaveLength(1);

    // After dispose, initSwUpdate is again able to wire fresh handlers
    // — proves we are not stuck in the initialized state.
    initSwUpdate();
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(addSpy.mock.calls.filter((c) => c[0] === "visibilitychange")).toHaveLength(2);
  });

  it("disposeSwUpdate without prior init is a no-op (does not throw, does not touch timers)", () => {
    expect(() => disposeSwUpdate()).not.toThrow();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    expect(removeSpy.mock.calls.filter((c) => c[0] === "visibilitychange")).toHaveLength(0);
  });

  it("registers exactly one visibilitychange listener per init/dispose cycle", () => {
    initSwUpdate();
    disposeSwUpdate();
    initSwUpdate();
    disposeSwUpdate();
    initSwUpdate();

    // 3 init cycles → 3 setInterval calls and 3 addEventListener calls.
    expect(setIntervalSpy).toHaveBeenCalledTimes(3);
    expect(addSpy.mock.calls.filter((c) => c[0] === "visibilitychange")).toHaveLength(3);
    // 2 dispose cycles → 2 clearInterval calls and 2 removeEventListener
    // calls. The last init cycle has no matching dispose yet.
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy.mock.calls.filter((c) => c[0] === "visibilitychange")).toHaveLength(2);
  });
});
