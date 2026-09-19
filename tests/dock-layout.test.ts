import { describe, expect, it } from "vitest";
import {
  clampDockHeight,
  defaultDockHeight,
  DOCK_MAX_HEIGHT,
  ensurePanelVisible,
  loadDockLayout,
  openInSlotA,
  toggleSlot,
  type DockState,
} from "../src/ui/dockLayout";

describe("defaultDockHeight", () => {
  it("caps at 220 on big screens and scales down on short viewports", () => {
    // The sequencer is the primary writing surface — the dock opens compact
    // (26% of the viewport, ≤220 px) and is dragged taller on demand.
    expect(defaultDockHeight(2000)).toBe(220);
    expect(defaultDockHeight(800)).toBe(208); // 0.26 * 800
    expect(defaultDockHeight(300)).toBe(160); // min height floor
  });
});

const state = (overrides: Partial<DockState> = {}): DockState => ({
  height: 300,
  slotA: "mixer",
  slotB: null,
  ...overrides,
});

describe("clampDockHeight", () => {
  it("clamps into the legal range and respects the viewport ceiling", () => {
    expect(clampDockHeight(50, 800)).toBe(160);
    expect(clampDockHeight(5000, 800)).toBe(DOCK_MAX_HEIGHT); // hard ceiling below the old 800
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
    let s = state({ slotA: "devices", slotB: "arr" });
    s = openInSlotA(s, "arr");
    expect(s.slotA).toBe("arr");
    expect(s.slotB).toBeNull();
  });
});

describe("ensurePanelVisible", () => {
  it("opens the panel in slot A when it is nowhere docked", () => {
    const s = ensurePanelVisible(state({ slotA: "mixer", slotB: null }), "devices");
    expect(s.slotA).toBe("devices");
  });

  it("is a no-op when the panel already sits in slot A (reveal, not toggle)", () => {
    const original = state({ slotA: "devices", slotB: "arr" });
    expect(ensurePanelVisible(original, "devices")).toBe(original);
  });

  it("is a no-op when the panel already sits in the split slot", () => {
    const original = state({ slotA: "mixer", slotB: "devices" });
    expect(ensurePanelVisible(original, "devices")).toBe(original);
  });
});

describe("loadDockLayout", () => {
  it("validates persisted ids and clamps height", () => {
    const raw = JSON.stringify({ height: 99999, slotA: "arr", slotB: "hacked" });
    const dock = loadDockLayout(raw, 700);
    // The persisted height clamps to the dock ceiling even when the viewport
    // would allow more — a huge dock starves the sequencer above it.
    expect(dock.height).toBe(DOCK_MAX_HEIGHT);
    expect(dock.slotA).toBe("arr");
    expect(dock.slotB).toBeNull(); // not a real panel id
  });

  it("falls back on corrupt JSON", () => {
    const dock = loadDockLayout("{oops", 800);
    expect(dock).toEqual({ height: defaultDockHeight(800), slotA: "mixer", slotB: null });
  });

  it("missing height field falls back to the viewport default", () => {
    const dock = loadDockLayout(JSON.stringify({ slotA: "mixer" }), 800);
    expect(dock.height).toBe(defaultDockHeight(800));
  });

  it("accepts null slots (closed dock)", () => {
    const dock = loadDockLayout(JSON.stringify({ height: 200, slotA: null, slotB: null }), 800);
    expect(dock.slotA).toBeNull();
    expect(dock.slotB).toBeNull();
  });
});
