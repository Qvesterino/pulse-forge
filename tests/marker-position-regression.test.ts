/**
 * Regression: markers are navigation, not arrangement content.
 *
 * `normalizeProject` used to clamp every marker to the project's CURRENT
 * length on every command. On every shipped template that length is 4 bars
 * (one pattern + one clip), so a producer placing cues at bars 8, 16, 24 and
 * 32 silently got all four stacked on bar 4 — no error, no warning, and the
 * four original positions simply gone.
 *
 * Measured before the fix, identical on "empty" and "house":
 *
 *   wanted  1..32 bars -> got  [1, 2, 3, 4, 4, 4, 4, 4, 4, 4]
 *
 * This is the exact bug class that costs a producer their work quietly, which
 * is why it gets a test rather than a code comment.
 *
 * The complementary guarantee is in the LAST describe: shrinking a project on
 * purpose (deleting the scene that owned the tail) must STILL pull markers
 * back, and undo must restore their original ticks. Removing the normalize
 * clamp must not remove the deliberate one.
 */

import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { addMarker, deletePattern, duplicatePattern, setPatternLength } from "../src/commands/commands";
import { normalizeProject, sanitizeMarkers } from "../src/project-model/schema";
import { BAR_TICKS, type ProjectDocument } from "../src/project-model/types";

function withMarkers(ticks: number[]): ProjectDocument {
  const doc = createProjectFromTemplate("empty");
  return ticks.reduce((d, tick, i) => addMarker(d, { tick, customId: `m${i}` }).execute(d), doc);
}

describe("markers — no silent clamp to project end", () => {
  it("keeps markers far past the current arrangement length", () => {
    const store = new ProjectStore(createProjectFromTemplate("empty"));
    // The template's own content ends at 4 bars; these all sit beyond it.
    const bars = [5, 8, 16, 24, 32, 64];
    for (const bar of bars) store.execute(addMarker(store.getDoc(), { tick: bar * BAR_TICKS }));
    const got = store.getDoc().markers.map((m) => m.tick / BAR_TICKS);
    expect(got).toEqual(bars);
  });

  it("survives repeated unrelated commands without drifting", () => {
    // The clamp ran on EVERY normalize pass, so even a command that has
    // nothing to do with markers used to pull them back.
    const store = new ProjectStore(withMarkers([8 * BAR_TICKS, 32 * BAR_TICKS]));
    for (let i = 0; i < 5; i++) {
      store.execute(addMarker(store.getDoc(), { tick: (40 + i) * BAR_TICKS }));
    }
    expect(store.getDoc().markers.map((m) => m.tick / BAR_TICKS)).toEqual([8, 32, 40, 41, 42, 43, 44]);
  });

  it("keeps distinct markers distinct", () => {
    const store = new ProjectStore(createProjectFromTemplate("empty"));
    for (const bar of [8, 16, 24, 32]) store.execute(addMarker(store.getDoc(), { tick: bar * BAR_TICKS }));
    const ticks = store.getDoc().markers.map((m) => m.tick);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it("round-trips a project with far markers through the store unchanged", () => {
    const doc = withMarkers([8 * BAR_TICKS, 48 * BAR_TICKS]);
    const once = normalizeProject(doc);
    const twice = normalizeProject(once);
    expect(twice.markers.map((m) => m.tick)).toEqual(doc.markers.map((m) => m.tick));
  });
});

describe("markers — sanitizeMarkers keeps its own contract", () => {
  it("still clamps to an explicit ceiling for callers that want one", () => {
    // The function's signature is unchanged; only the normalize pass stopped
    // using a project-length ceiling. A caller that explicitly passes a bound
    // still gets it.
    const markers = [
      { id: "a", name: "A", type: "cue" as const, tick: 100 },
      { id: "b", name: "B", type: "riser" as const, tick: 500 },
    ];
    const sanitized = sanitizeMarkers(markers, 400);
    expect(sanitized[0].tick).toBe(100);
    expect(sanitized[1].tick).toBe(400);
  });

  it("still floors negative ticks at zero", () => {
    const sanitized = sanitizeMarkers([{ id: "a", name: "A", type: "cue", tick: -50 }], Number.MAX_SAFE_INTEGER);
    expect(sanitized[0].tick).toBe(0);
  });

  it("still repairs shape (bad type, missing name)", () => {
    const sanitized = sanitizeMarkers([{ id: "a", name: "", type: "not-a-type", tick: 10 }], Number.MAX_SAFE_INTEGER);
    expect(sanitized[0].name).toBe("Marker");
    expect(sanitized[0].type).toBe("cue");
  });
});

describe("markers — deliberate shrink-clamp still runs", () => {
  it("pulls markers back when the pattern that owned the tail is deleted", () => {
    // `markerClampPatch` (commands.ts) is the deliberate shrink path. Its
    // comment says it exists to MIRROR normalize's clamp so the move lands
    // inside the command delta. With normalize no longer clamping, this is
    // the only place markers move on a shrink — which is the correct shape.
    const base = createProjectFromTemplate("house");
    const store = new ProjectStore(base);
    store.execute(duplicatePattern(store.getDoc(), base.patterns[0].id));
    const [short, long] = store.getDoc().patterns;
    // totalProjectTicks is a MAX over patterns, so a same-length duplicate
    // changes nothing. Make the tail pattern genuinely longer, put a marker
    // past its end, then delete it and the project really does shrink.
    store.execute(setPatternLength(store.getDoc(), long.id, short.stepCount * 4));
    const tailTicks = long.stepCount * 4 * 120;
    store.execute(addMarker(store.getDoc(), { tick: tailTicks * 2, name: "tail marker" }));
    const before = store.getDoc().markers.find((m) => m.name === "tail marker")!.tick;
    expect(before).toBeGreaterThan(short.stepCount * 120);

    store.execute(deletePattern(store.getDoc(), long.id));
    const after = store.getDoc().markers.find((m) => m.name === "tail marker")?.tick;
    expect(after).toBeLessThan(before);

    store.undo();
    expect(store.getDoc().markers.find((m) => m.name === "tail marker")?.tick).toBe(before);
  });

  it("keeps unrelated markers when a pattern is deleted", () => {
    const base = createProjectFromTemplate("house");
    const store = new ProjectStore(base);
    store.execute(duplicatePattern(store.getDoc(), base.patterns[0].id));
    const tail = store.getDoc().patterns[store.getDoc().patterns.length - 1];
    store.execute(addMarker(store.getDoc(), { tick: 2 * BAR_TICKS, name: "keep me" }));
    store.execute(deletePattern(store.getDoc(), tail.id));
    expect(store.getDoc().markers.some((m) => m.name === "keep me")).toBe(true);
  });
});
