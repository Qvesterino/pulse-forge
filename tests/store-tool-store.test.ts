import { describe, expect, it, vi } from "vitest";
import { ToolStore, type Tool } from "../src/store/ToolStore";

/**
 * ToolStore — the third pub/sub store of the architecture triad
 * (ProjectStore / SelectionStore / ToolStore). Tiny, but it is the single
 * owner of the editing tool state: the arrangement subscribes to it, so
 * notification discipline (no spurious emits, unsubscribe safety,
 * listener-throw containment) is architectural, not cosmetic.
 *
 * The union is DELIBERATELY "select" | "cut" — the other four names were
 * aspirational dead entries for months (nothing consumed them; their
 * gestures shipped as Alt-modifiers instead). See the ToolStore header for
 * the full story. Keyboard shortcuts live in App.tsx (V select, C cut), not
 * in this store — the old `shortcutForKey` map here was the dead-map
 * anti-pattern.
 */

const ALL_TOOLS: Tool[] = ["select", "cut"];

describe("ToolStore — state", () => {
  it("defaults to select", () => {
    expect(new ToolStore().getTool()).toBe("select");
  });

  it("setTool switches the tool", () => {
    const store = new ToolStore();
    for (const tool of ALL_TOOLS) {
      store.setTool(tool);
      expect(store.getTool()).toBe(tool);
    }
  });

  it("setting the SAME tool does not emit (no spurious re-renders)", () => {
    const store = new ToolStore();
    store.setTool("cut");
    const listener = vi.fn();
    store.subscribe(listener);
    store.setTool("cut");
    expect(listener).not.toHaveBeenCalled();
    store.setTool("select");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("ToolStore — pub/sub discipline", () => {
  it("notifies every subscriber on change", () => {
    const store = new ToolStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.setTool("cut");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops notifications; double-unsubscribe is safe", () => {
    const store = new ToolStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    unsub();
    unsub(); // idempotent — Set.delete returns false the second time
    store.setTool("cut");
    expect(listener).not.toHaveBeenCalled();
  });

  it("a listener unsubscribing ITSELF during emit does not break the loop", () => {
    const store = new ToolStore();
    const selfRemoving = vi.fn(() => unsub());
    const later = vi.fn();
    const unsub = store.subscribe(selfRemoving);
    store.subscribe(later);
    store.setTool("cut"); // selfRemoving unsubscribes mid-emit
    expect(selfRemoving).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1); // Set iteration survives mid-loop delete
    store.setTool("select");
    expect(selfRemoving).toHaveBeenCalledTimes(1); // stays unsubscribed
    expect(later).toHaveBeenCalledTimes(2);
  });

  it("a THROWING listener propagates: later subscribers miss that emit, state still commits", () => {
    const store = new ToolStore();
    const bad = vi.fn(() => {
      throw new Error("listener exploded");
    });
    const good = vi.fn();
    const unsubBad = store.subscribe(bad);
    store.subscribe(good);
    // PINNED ACTUAL CONTRACT: emit does not contain listener throws — the
    // exception propagates out of setTool, so subscribers after the thrower
    // miss this notification (the UI throws inside React's batch). State is
    // committed BEFORE emit, so the tool still switched. If containment is
    // ever wanted (try/catch in emit), this pin fails — make it deliberate.
    expect(() => store.setTool("cut")).toThrow("listener exploded");
    expect(good).not.toHaveBeenCalled();
    expect(store.getTool()).toBe("cut");
    // Recovery: once the thrower is gone, notifications flow normally again.
    unsubBad();
    store.setTool("select");
    expect(good).toHaveBeenCalledTimes(1);
  });
});
