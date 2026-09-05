import { describe, expect, it, vi } from "vitest";
import { installSaveUnloadGuards } from "../src/persistence/save-lifecycle";

/**
 * Minimal event-target stub — captures the listeners the helper installs
 * and lets the test dispatch them as if they came from the browser.
 */
function makeTarget() {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  return {
    listeners,
    addEventListener(name: string, listener: EventListenerOrEventListenerObject) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    },
    removeEventListener(name: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(name)?.delete(listener);
    },
    dispatch(name: string, event: Event) {
      for (const listener of listeners.get(name) ?? []) {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      }
    },
  };
}

describe("installSaveUnloadGuards", () => {
  it("flushes on pagehide (the iOS-safe path)", () => {
    const flush = vi.fn();
    // The default target is `window`; install on the stub for isolation
    // so we don't leak listeners on the real window.
    const stub = makeTarget();
    const uninstall = installSaveUnloadGuards({ flushSave: flush, isDirty: () => false }, stub as unknown as Window);
    stub.dispatch("pagehide", new Event("pagehide"));
    expect(flush).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it("flushes on beforeunload even when the project is not dirty", () => {
    const flush = vi.fn();
    const stub = makeTarget();
    const uninstall = installSaveUnloadGuards({ flushSave: flush, isDirty: () => false }, stub as unknown as Window);
    stub.dispatch("beforeunload", new Event("beforeunload"));
    expect(flush).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it("asks the browser to confirm close when the project is dirty", () => {
    // Regression: beforeunload used to fire-and-forget flushSave() but
    // never asked the browser to warn the user about unsaved changes.
    // Modern browsers fire the "Leave site?" dialog when the listener
    // calls preventDefault() (Chrome 60+) and additionally writes a
    // string to `event.returnValue` (older browsers). The helper sets
    // both — the assertion below is the modern-contract half.
    const flush = vi.fn();
    const stub = makeTarget();
    const uninstall = installSaveUnloadGuards({ flushSave: flush, isDirty: () => true }, stub as unknown as Window);
    // cancelable: true is required for preventDefault() to have any
    // effect on a synthetic event (jsdom enforces the DOM contract).
    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    stub.dispatch("beforeunload", event);
    expect(event.defaultPrevented).toBe(true);
    // The legacy returnValue string is the older half of the contract.
    // jsdom may or may not have a setter; the helper uses
    // Object.defineProperty as a defensive fallback, so reading it
    // back here exercises that path.
    expect(event.returnValue).toBe("");
    expect(flush).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it("does NOT ask the browser to confirm close when the project is saved", () => {
    // Regression guard: a saved project must not pop a "Leave site?"
    // dialog on every close — that would make the app annoying to use.
    const flush = vi.fn();
    const stub = makeTarget();
    const uninstall = installSaveUnloadGuards({ flushSave: flush, isDirty: () => false }, stub as unknown as Window);
    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    stub.dispatch("beforeunload", event);
    expect(event.defaultPrevented).toBe(false);
    // The helper must NOT have touched returnValue on a clean project.
    // jsdom's default BeforeUnloadEvent has returnValue === true; the
    // helper must not have overwritten it with the dialog string.
    expect(event.returnValue).not.toBe("");
    expect(flush).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it("uninstall removes both event listeners", () => {
    const flush = vi.fn();
    const stub = makeTarget();
    const uninstall = installSaveUnloadGuards({ flushSave: flush, isDirty: () => false }, stub as unknown as Window);
    uninstall();
    stub.dispatch("pagehide", new Event("pagehide"));
    stub.dispatch("beforeunload", new Event("beforeunload"));
    expect(flush).not.toHaveBeenCalled();
  });
});
