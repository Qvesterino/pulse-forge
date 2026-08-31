import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { registerRaf, unregisterRaf } from "../src/services/rafLoop";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(performance.now()), 16) as unknown as number;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("rafLoop", () => {
  it("calls registered callbacks on each frame", () => {
    const cb = vi.fn();
    registerRaf("test-1", cb);
    vi.advanceTimersByTime(50);
    expect(cb).toHaveBeenCalled();
    unregisterRaf("test-1");
  });

  it("calls multiple callbacks on the same frame", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerRaf("a", a);
    registerRaf("b", b);
    vi.advanceTimersByTime(50);
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    unregisterRaf("a");
    unregisterRaf("b");
  });

  it("stops calling after unregister", () => {
    const cb = vi.fn();
    registerRaf("test-stop", cb);
    vi.advanceTimersByTime(33);
    expect(cb).toHaveBeenCalled();
    cb.mockClear();
    unregisterRaf("test-stop");
    vi.advanceTimersByTime(33);
    expect(cb).not.toHaveBeenCalled();
  });

  it("provides timestamp to callback", () => {
    let receivedTs = -1;
    registerRaf("test-ts", (t) => {
      receivedTs = t;
    });
    vi.advanceTimersByTime(16);
    expect(receivedTs).toBeGreaterThan(0);
    unregisterRaf("test-ts");
  });

  it("replaces callback for same id", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerRaf("test-replace", first);
    registerRaf("test-replace", second);
    vi.advanceTimersByTime(50);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    unregisterRaf("test-replace");
  });
});

describe("rafLoop — failure containment", () => {
  it("a throwing callback is removed and does not freeze the loop for others (regression: one throw killed the rAF chain)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = vi.fn();
    const boom = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("meter exploded");
      })
      .mockImplementation(() => {
        throw new Error("still broken");
      });
    registerRaf("good", good);
    registerRaf("boom", boom);
    vi.advanceTimersByTime(100);
    // The healthy callback keeps receiving frames after the broken one threw.
    expect(good.mock.calls.length).toBeGreaterThanOrEqual(3);
    // The offender is removed instead of throwing every frame forever.
    expect(boom.mock.calls.length).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    unregisterRaf("good");
    errSpy.mockRestore();
  });
});
