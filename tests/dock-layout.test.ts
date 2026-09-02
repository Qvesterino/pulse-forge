import { describe, expect, it } from "vitest";
import { clampDockHeight, loadDockLayout, openInSlotA, toggleSlot, type DockState } from "../src/ui/dockLayout";

const state = (overrides: Partial<DockState> = {}): DockState => ({
  height: 300,
  slotA: "mixer",
  slotB: null,
  ...overrides,
});

describe("clampDockHeight", () => {
  it("clamps into the legal range and respects the viewport ceiling", () => {
    expect(clampDockHeight(50, 800)).toBe(160);
    expect(clampDockHeight(5000, 800)).toBe(800);
    expect(clampDockHeight(320, 800)).toBe(320);
    // A short viewport shrinks the ceiling but never below the minimum+40.
    expect(clampDockHeight(500, 150)).toBe(200);
  });
});

describe("toggleSlot", () => {
  it("toggles slot A and never duplicates a panel across slots", () => {
    let s = state({ slotA: "mixer", slotB: "arr" });
    // Opening arr in slot A clears it from slot B.
    s = toggleSlot(s, "arr", 0);
    expect(s.slotA).toBe("arr");
    expect(s.slotB).toBeNull();
    // Toggling again closes it.
    s = toggleSlot(s, "arr", 0);
    expect(s.slotA).toBeNull();
  });

  it("slot B opens split, dedupes slot A, and closes on second toggle", () => {
    let s = state({ slotA: "mixer", slotB: null });
    s = toggleSlot(s, "arr", 1);
    expect(s).toEqual({ height: 300, slotA: "mixer", slotB: "arr" });
    // Same panel into slot B moves it out of slot A.
    s = toggleSlot(s, "mixer", 1);
    expect(s.slotA).toBeNull();
    expect(s.slotB).toBe("mixer");
    // Toggle closes it.
    s = toggleSlot(s, "mixer", 1);
    expect(s.slotB).toBeNull();
  });
});

describe("openInSlotA", () => {
  it("opens in slot A and clears a duplicate from slot B", () => {
    let s = state({ slotA: "fx", slotB: "arr" });
    s = openInSlotA(s, "arr");
    expect(s.slotA).toBe("arr");
    expect(s.slotB).toBeNull();
  });
});

describe("loadDockLayout", () => {
  it("validates persisted ids and clamps height", () => {
    const raw = JSON.stringify({ height: 99999, slotA: "arr", slotB: "hacked" });
    const dock = loadDockLayout(raw, 700);
    expect(dock.height).toBe(700);
    expect(dock.slotA).toBe("arr");
    expect(dock.slotB).toBeNull(); // not a real panel id
  });

  it("falls back on corrupt JSON", () => {
    const dock = loadDockLayout("{oops", 800);
    expect(dock).toEqual({ height: 300, slotA: "mixer", slotB: null });
  });

  it("accepts null slots (closed dock)", () => {
    const dock = loadDockLayout(JSON.stringify({ height: 200, slotA: null, slotB: null }), 800);
    expect(dock.slotA).toBeNull();
    expect(dock.slotB).toBeNull();
  });
});
