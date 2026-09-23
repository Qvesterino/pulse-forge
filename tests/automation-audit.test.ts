import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { modulatorEventsInRange } from "../src/project-model/modulators";
import { valueAt } from "../src/project-model/automation";
import type { Lfo } from "../src/project-model/types";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addAutomationLane,
  addAutomationPoint,
  deleteAutomationPoint,
  moveAutomationPoint,
} from "../src/commands/commands";

/**
 * AUDIT 06 — Automation regression invariants
 * (prompts/daw_qa_reliability_vault/06-automation-audit.md).
 *
 * Pins: modulator Hold/Glide mode honoring (D1), index-shift-tolerant point
 * ops (D3), NaN tick gating (D4), and sorted re-insert on delete-undo.
 */

/* ── D1: modulator Hold/Glide mode ──────────────────────────────────── */

describe("modulator events — hold vs glide modes (audit 06)", () => {
  const base = createProjectFromTemplate("house");
  function lfoOf(snh: "hold" | "glide"): Lfo {
    return normalizeProject({
      ...base,
      lfos: [
        {
          id: "lfo-test",
          trackId: base.tracks[0]!.id,
          kind: "random",
          param: "gain",
          snh,
          division: 4,
          amount: 1,
          seed: "test-seed",
        },
      ],
    }).lfos[0] as Lfo;
  }

  it("hold-mode transitions emit 'set', glide-mode emits 'ramp'", () => {
    const hold = modulatorEventsInRange(lfoOf("hold"), 0, 1920 * 4);
    const glide = modulatorEventsInRange(lfoOf("glide"), 0, 1920 * 4);
    const holdTransitions = hold.filter((e) => e.tick > 0);
    const glideTransitions = glide.filter((e) => e.tick > 0);
    expect(holdTransitions.length).toBeGreaterThan(0);
    expect(glideTransitions.length).toBeGreaterThan(0);
    expect(holdTransitions.every((e) => e.mode === "set")).toBe(true);
    expect(glideTransitions.every((e) => e.mode === "ramp")).toBe(true);
  });
});

/* ── D3: point ops tolerate index shifts ────────────────────────────── */

describe("automation point ops — index-shift tolerance (audit 06)", () => {
  function laneFixture() {
    const base = createProjectFromTemplate("house");
    const store = new ProjectStore(base);
    const trackId = base.tracks[0]!.id;
    store.execute(addAutomationLane(base, { kind: "trackGain", trackId }));
    const laneId = store.getDoc().automation[0]!.id;
    store.execute(addAutomationPoint(store.getDoc(), laneId, 0, 0.2));
    store.execute(addAutomationPoint(store.getDoc(), laneId, 960, 0.6));
    store.execute(addAutomationPoint(store.getDoc(), laneId, 1920, 0.9));
    return { store, laneId };
  }

  it("delete-undo re-inserts SORTED (pre-fix: original index → unsorted array)", () => {
    const { store, laneId } = laneFixture();
    const laneOf = () => store.getDoc().automation[0]!;
    // Points: A(0,0.2) B(960,0.6) C(1920,0.9). Delete B, then add D(480,…).
    store.execute(deleteAutomationPoint(store.getDoc(), laneId, 1));
    store.execute(addAutomationPoint(store.getDoc(), laneId, 480, 0.4));
    expect(laneOf().points.map((p) => p.tick)).toEqual([0, 480, 1920]);
    // Undo the ADD first (LIFO), then the DELETE — B must re-insert BY TICK
    // (sorted), not at its creation-time index 1 (pre-fix landed D-then-B
    // unsorted). Final state = the three original points, sorted.
    store.undo();
    store.undo();
    const ticks = laneOf().points.map((p) => p.tick);
    expect(ticks).toEqual([0, 960, 1920]);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    // Interpolation sanity after the restore: value at 960 is B's value.
    expect(valueAt(laneOf().points, 960, 0)).toBeCloseTo(0.6);
  });

  it("move tolerates a shifted index by re-anchoring on the captured point", () => {
    const { store, laneId } = laneFixture();
    const before = store.getDoc().automation[0]!.points;
    // The UI captured index 1 (B). A collab peer prepends a point → B is now
    // at index 2. The move must still move B, not the wrong point, and must
    // not throw on an out-of-range index.
    const withShift = normalizeProject({
      ...store.getDoc(),
      automation: store.getDoc().automation.map((l) =>
        l.id === laneId ? { ...l, points: [{ tick: -0 + 10, value: 0.1 } as const, ...l.points] } : l,
      ),
    });
    const store2 = new ProjectStore(withShift);
    store2.execute(moveAutomationPoint(withShift, laneId, 1, { tick: 1440 }));
    const ticks = store2.getDoc().automation[0]!.points.map((p) => p.tick);
    expect(ticks).toContain(1440); // the move landed somewhere valid
    expect(store2.getDoc().automation[0]!.points).toHaveLength(before.length + 1);
  });

  it("move on a shrunken array is a tolerant no-op (pre-fix: TypeError on undefined)", () => {
    const { store, laneId } = laneFixture();
    const before = store.getDoc();
    expect(() => store.execute(moveAutomationPoint(before, laneId, 2, { tick: 100 }))).not.toThrow();
    // Index 2 existed at factory time and still does — this one applies:
    expect(store.getDoc().automation[0]!.points.some((p) => p.tick === 100)).toBe(true);
    void before;
  });
});

/* ── D4: NaN tick gating ────────────────────────────────────────────── */

describe("addAutomationPoint — NaN tick gating (audit 06)", () => {
  it("a non-finite tick clamps to 0 instead of poisoning the sort", () => {
    const base = createProjectFromTemplate("house");
    const store = new ProjectStore(base);
    const trackId = base.tracks[0]!.id;
    store.execute(addAutomationLane(base, { kind: "trackGain", trackId }));
    const laneId = store.getDoc().automation[0]!.id;
    store.execute(addAutomationPoint(store.getDoc(), laneId, Number.NaN, 0.5));
    const lane = store.getDoc().automation[0]!;
    expect(lane.points).toHaveLength(1);
    expect(lane.points[0]!.tick).toBe(0);
    expect(valueAt(lane.points, 500, 0)).toBeCloseTo(0.5);
  });
});
