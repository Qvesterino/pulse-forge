import { describe, expect, it, vi } from "vitest";
import { installSaveUnloadGuards } from "../src/persistence/save-lifecycle";

/**
 * Save-lifecycle regression tests.
 *
 * Pulse Forge's IndexedDB saves are debounced (800 ms) and the actual write
 * is async. The browser does not await promises from beforeunload, and iOS
 * Safari terminates tabs without firing beforeunload. The "pagehide" +
 * "beforeunload" + "visibilitychange" listeners are the only safety net
 * between the user closing the tab and the debounced save committing.
 *
 * If `installSaveUnloadGuards` is not idempotent, every project swap
 * (Project Browser → open new project, URL deep-link into a different
 * project, etc.) adds another pair of listeners without removing the old
 * ones. Over time a long-running session accumulates dozens of
 * pagehide+beforeunload handlers, all of which call flushSave() — every
 * one of them is one more await'd microtask before the browser lets the
 * tab terminate. This is a user-data-loss risk: the browser may give up
 * waiting and kill the tab before the final IndexedDB write commits.
 *
 * The fix is idempotent install — calling installSaveUnloadGuards
 * multiple times on the same target returns the same uninstall handler,
 * which removes all listeners in one call.
 */

interface FakeTarget {
  listeners: Map<string, Set<EventListenerOrEventListenerObject>>;
  addEventListener(name: string, handler: EventListenerOrEventListenerObject): void;
  removeEventListener(name: string, handler: EventListenerOrEventListenerObject): void;
  dispatch(name: string, event: Partial<Event>): void;
}

function makeFakeTarget(): FakeTarget {
  const map = new Map<string, Set<EventListenerOrEventListenerObject>>();
  return {
    listeners: map,
    addEventListener(name, handler) {
      let set = map.get(name);
      if (!set) {
        set = new Set();
        map.set(name, set);
      }
      set.add(handler);
    },
    removeEventListener(name, handler) {
      map.get(name)?.delete(handler);
    },
    dispatch(name, event) {
      for (const handler of map.get(name) ?? []) {
        if (typeof handler === "function") handler(event as Event);
        else (handler as EventListenerObject).handleEvent(event as Event);
      }
    },
  };
}

function listenerCount(target: FakeTarget, name: string): number {
  return target.listeners.get(name)?.size ?? 0;
}

describe("installSaveUnloadGuards — listener lifecycle", () => {
  it("attaches exactly one pagehide and one beforeunload handler on first install", () => {
    const target = makeFakeTarget();
    installSaveUnloadGuards({ flushSave: vi.fn(), isDirty: () => false }, target);
    expect(listenerCount(target, "pagehide")).toBe(1);
    expect(listenerCount(target, "beforeunload")).toBe(1);
  });

  it("regression (A08.D1) does NOT accumulate listeners across multiple install() calls (idempotent)", () => {
    // Reproduces the real-world project-swap flow: every time the user
    // picks a different project from the Project Browser, main.tsx's
    // `openDoc` calls `openProject` which calls
    // `installSaveUnloadGuards` again. Without idempotency, after N
    // swaps the target carries N pagehide + N beforeunload listeners
    // — every one of them races to call flushSave() on tab close,
    // multiplying the IndexedDB microtask load the browser has to
    // drain before the tab dies. A long-running session can grow
    // this into dozens of duplicate handlers.
    const target = makeFakeTarget();
    for (let i = 0; i < 5; i++) {
      installSaveUnloadGuards({ flushSave: vi.fn(), isDirty: () => false }, target);
    }
    expect(listenerCount(target, "pagehide")).toBe(1);
    expect(listenerCount(target, "beforeunload")).toBe(1);
  });

  it("the latest uninstall handler is the only one that leaves the target clean", () => {
    // Idempotent-install semantics: each `install` swaps in a new
    // listener pair and returns a fresh uninstall for that pair. The
    // FIRST uninstall was already triggered internally by the second
    // `install` call (it cleared the first pair), so calling it again
    // is a no-op. Only the LAST uninstall handler is live in
    // `installedByTarget` and is the one closeProject must call.
    //
    // In services.ts, closeProject captures `uninstallUnloadGuards`
    // once per openProject() and calls it once. This test pins that
    // contract: only the most recent handler is live and the
    // earlier ones are no-ops.
    const target = makeFakeTarget();
    const uninstalls: Array<() => void> = [];
    for (let i = 0; i < 3; i++) {
      uninstalls.push(installSaveUnloadGuards({ flushSave: vi.fn(), isDirty: () => false }, target));
    }
    // After 3 installs, target has exactly one pair (the most recent).
    expect(listenerCount(target, "pagehide")).toBe(1);
    expect(listenerCount(target, "beforeunload")).toBe(1);
    // The last uninstall is the only one that does real work.
    uninstalls[uninstalls.length - 1]();
    expect(listenerCount(target, "pagehide")).toBe(0);
    expect(listenerCount(target, "beforeunload")).toBe(0);
  });

  it("flushes save on pagehide (the actual safety-net signal)", () => {
    const target = makeFakeTarget();
    const flushSave = vi.fn();
    installSaveUnloadGuards({ flushSave, isDirty: () => true }, target);
    target.dispatch("pagehide", {});
    expect(flushSave).toHaveBeenCalledTimes(1);
  });

  it("beforeunload triggers the browser's Leave-site warning AND flushes save when dirty", () => {
    // Regression: a dirty project means the user's last edit is in
    // the 800 ms debounce window. We must (a) show the Leave-site?
    // dialog and (b) start a best-effort flush. Modern browsers
    // require both `event.preventDefault()` AND `event.returnValue`
    // for the dialog; without them the warning is silently dropped.
    const target = makeFakeTarget();
    const flushSave = vi.fn();
    const evt: { preventDefault: () => void; returnValue?: unknown } = {
      preventDefault: vi.fn(),
    };
    installSaveUnloadGuards({ flushSave, isDirty: () => true }, target);
    target.dispatch("beforeunload", evt as unknown as Event);
    expect((evt.preventDefault as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(evt.returnValue).toBe("");
    expect(flushSave).toHaveBeenCalledTimes(1);
  });

  it("beforeunload skips the warning and still flushes when not dirty", () => {
    // If the project is already saved, we do not need to nag the
    // user — the next session will start from the IndexedDB version.
    // We still fire-and-forget a flush because the in-flight
    // debounced save from the last edit may not have committed yet.
    const target = makeFakeTarget();
    const flushSave = vi.fn();
    const evt: { preventDefault: () => void; returnValue?: unknown } = {
      preventDefault: vi.fn(),
    };
    installSaveUnloadGuards({ flushSave, isDirty: () => false }, target);
    target.dispatch("beforeunload", evt as unknown as Event);
    expect((evt.preventDefault as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(flushSave).toHaveBeenCalledTimes(1);
  });
});
