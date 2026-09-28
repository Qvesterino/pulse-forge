import { describe, it, expect } from "vitest";
import { routeIntentText } from "../src/intent/route";
import {
  parseGrooveIntent,
  applyGrooveIntent,
  applyAutomateIntent,
  applyMarkerIntent,
  applySectionGrooveIntent,
  grooveReadback,
} from "../src/intent/studio-words";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc } from "./fixtures/doc";
import { createScene, setSceneRole } from "../src/commands/commands";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * STUDIO WORDS — groove/swing, gain automation ramps, markers.
 * Route → execute → state → undo, same etiquette as every audit wave.
 */
function freshDoc() {
  return testDoc();
}

function executeMarker(store: ProjectStore, text: string): void {
  const route = routeIntentText(text, store.doc);
  if (route.kind !== "markerIntent") throw new Error("expected marker");
  const command = applyMarkerIntent(store.doc, route.intent);
  if (!command) throw new Error("no marker command");
  store.execute(command);
}

describe("groove intent", () => {
  it("more swing raises swing by one step; undo restores", () => {
    const store = new ProjectStore(freshDoc());
    const route = routeIntentText("more swing", store.doc);
    expect(route.kind).toBe("grooveIntent");
    if (route.kind !== "grooveIntent") throw new Error("expected groove");
    expect(route.intent.direction).toBe("swingUp");

    const command = applyGrooveIntent(store.doc, route.intent);
    store.execute(command);
    expect(store.doc.groove?.swing ?? 0).toBeCloseTo(0.1, 5);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.groove?.swing ?? 0).toBe(0);
  });

  it("SK: viac swingu / menej swingu map to up/down", () => {
    expect(parseGrooveIntent("viac swingu")?.direction).toBe("swingUp");
    expect(parseGrooveIntent("menej swingu")?.direction).toBe("swingDown");
  });

  it("tighter groove lowers swing AND humanize together", () => {
    const doc = freshDoc();
    const loosened = applyGrooveIntent(doc, { direction: "swingUp" }).execute(doc);
    const loosened2 = applyGrooveIntent(loosened, { direction: "humanizeUp" }).execute(loosened);
    const tightened = applyGrooveIntent(loosened2, { direction: "tighter" }).execute(loosened2);
    expect(tightened.groove?.swing ?? 0).toBeCloseTo(0, 5);
    expect(tightened.groove?.humanizeTiming ?? 0).toBeCloseTo(0, 5);
  });

  it("swing 60% sets the absolute value; more human raises humanize", () => {
    const doc = freshDoc();
    const set = applyGrooveIntent(doc, parseGrooveIntent("swing 60%")!).execute(doc);
    expect(set.groove?.swing ?? 0).toBeCloseTo(0.6, 5);
    const human = applyGrooveIntent(doc, parseGrooveIntent("more human")!).execute(doc);
    expect(human.groove?.humanizeTiming ?? 0).toBeCloseTo(0.1, 5);
  });

  it("readback reports the landing values; clamps at the 0..1 walls", () => {
    const doc = freshDoc();
    let cursor = doc;
    for (let i = 0; i < 12; i++) cursor = applyGrooveIntent(cursor, { direction: "swingUp" }).execute(cursor);
    expect(cursor.groove?.swing ?? 0).toBe(1); // clamped at the ceiling
    expect(grooveReadback(cursor)).toContain("swing 100%");
    let floor = cursor;
    for (let i = 0; i < 12; i++) floor = applyGrooveIntent(floor, { direction: "swingDown" }).execute(floor);
    expect(floor.groove?.swing ?? 0).toBe(0);
  });

  it("groove routes before the mix comparatives (tighter ≠ darker mix)", () => {
    const doc = freshDoc();
    expect(routeIntentText("tighter groove", doc).kind).toBe("grooveIntent");
    expect(routeIntentText("more swing please", doc).kind).toBe("grooveIntent");
    expect(routeIntentText("more swing on a dark techno beat", doc).kind).toBe("pattern");
  });
});

describe("automate intent (gain ramp)", () => {
  it("automate the volume from 0 to 100 builds a two-point trackGain lane", () => {
    const store = new ProjectStore(freshDoc());
    const route = routeIntentText("automate the volume from 0 to 100", store.doc);
    expect(route.kind).toBe("automateIntent");
    if (route.kind !== "automateIntent") throw new Error("expected automate");
    expect(route.intent).toMatchObject({ fromPercent: 0, toPercent: 100 });

    executeAutomate(store);
    const lane = store.doc.automation[store.doc.automation.length - 1];
    expect(lane.target).toMatchObject({ kind: "trackGain" });
    expect(lane.points).toHaveLength(2);
    expect(lane.points[0].value).toBe(0);
    expect(lane.points[1].value).toBe(1);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.automation.length).toBe(0);
  });

  it("named track: 'automate the bass volume from 50 to 100' targets the bass lane", () => {
    const store = new ProjectStore(freshDoc());
    const route = routeIntentText("automate the bass volume from 50 to 100", store.doc);
    if (route.kind !== "automateIntent") throw new Error("expected automate");
    expect(route.intent.trackId).toBe("bass");
    executeAutomate(store, "automate the bass volume from 50 to 100");
    const lane = store.doc.automation[store.doc.automation.length - 1];
    expect(lane.points[0].value).toBeCloseTo(0.5, 5);
    expect(lane.points[1].value).toBe(1);
  });

  it("asks without 'automate' never reach this route (drift safety)", () => {
    const doc = freshDoc();
    expect(routeIntentText("the volume was fine", doc).kind).not.toBe("automateIntent");
    expect(routeIntentText("turn the volume up", doc).kind).not.toBe("automateIntent");
  });
});

function executeAutomate(store: ProjectStore, text = "automate the volume from 0 to 100"): void {
  const route = routeIntentText(text, store.doc);
  if (route.kind !== "automateIntent") throw new Error("expected automate");
  const command = applyAutomateIntent(store.doc, route.intent, null);
  if (!command) throw new Error("no lane");
  store.execute(command);
}

describe("marker intents", () => {
  it("add a marker at bar 8 lands a cue at the 1-based bar; undo removes it", () => {
    const store = new ProjectStore(freshDoc());
    const route = routeIntentText("add a marker at bar 8", store.doc);
    expect(route.kind).toBe("markerIntent");
    if (route.kind !== "markerIntent") throw new Error("expected marker");
    expect(route.intent).toMatchObject({ action: "add", bar: 8 });

    executeMarker(store, "add a marker at bar 8");
    expect(store.doc.markers).toHaveLength(1);
    expect(store.doc.markers[0].tick).toBe(7 * 4 * 480);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.markers).toHaveLength(0);
  });

  it("role words in the ask become the marker name ('drop a drop marker')", () => {
    const store = new ProjectStore(freshDoc());
    executeMarker(store, "add a marker at bar 4");
    expect(store.doc.markers[0].name.toLowerCase()).toMatch(/drop|marker/);
  });

  it("delete the marker at bar 8 removes the nearest one; nothing there → explicit null", () => {
    const store = new ProjectStore(freshDoc());
    executeMarker(store, "add a marker at bar 8");
    expect(routeIntentText("delete the marker at bar 8", store.doc).kind).toBe("markerIntent");
    executeMarker(store, "delete the marker at bar 8");
    expect(store.doc.markers).toHaveLength(0);
    // empty again → applyMarkerIntent returns null (nothing within a bar)
    const command = applyMarkerIntent(store.doc, { action: "remove", bar: 8 });
    expect(command).toBeNull();
  });
});

// ─── SECTION GROOVE — swing baked into a named section's pattern ────────────

describe("section groove intents", () => {
  /** house doc + a drop-role scene with its own 16-step pattern. */
  function withDropScene() {
    const doc = freshDoc();
    const drums = doc.tracks.find((t) => t.kind === "drum")!;
    const padId = drums.pads[0].id;
    const scene = createScene(doc, "Drop X").execute(doc);
    const withRole = setSceneRole(scene, scene.scenes[scene.scenes.length - 1].id, "drop").execute(scene);
    const dropScene = withRole.scenes[withRole.scenes.length - 1];
    if (!dropScene) throw new Error("fixture: drop scene was not created");
    const dropPattern = withRole.patterns.find((candidate) => candidate.id === dropScene.patternId);
    if (!dropPattern) throw new Error("fixture: drop scene pattern was not created");
    const patternId = "pattern-drop-x";
    const pattern = {
      ...dropPattern,
      id: patternId,
      name: "Drop Pattern",
      stepCount: 16,
      rows: { [padId]: new Array(16).fill(0).map((_, i) => (i % 2 === 1 ? 0.8 : 0)) },
    };
    return {
      ...withRole,
      patterns: withRole.patterns.map((candidate) => (candidate.id === dropPattern.id ? pattern : candidate)),
      scenes: withRole.scenes.map((candidate) =>
        candidate.id === dropScene.id ? { ...candidate, patternId } : candidate,
      ),
    } as ProjectDocument;
  }

  function executeSectionGroove(store: ProjectStore, text: string): void {
    const route = routeIntentText(text, store.doc);
    if (route.kind !== "sectionGrooveIntent") throw new Error("expected sectionGroove");
    const command = applySectionGrooveIntent(store.doc, route.intent);
    if (!command) throw new Error("no section groove command");
    store.execute(command);
  }

  it("more swing in the drop routes sectionGrooveIntent with role", () => {
    const doc = withDropScene();
    const route = routeIntentText("more swing in the drop", doc);
    expect(route.kind).toBe("sectionGrooveIntent");
    if (route.kind !== "sectionGrooveIntent") throw new Error("expected sectionGroove");
    expect(route.intent.role).toBe("drop");
    expect(route.intent.direction).toBe("swingUp");
  });

  it("bakes microtiming into ODD steps of the section pattern; even steps untouched", () => {
    const store = new ProjectStore(withDropScene());
    executeSectionGroove(store, "more swing in the drop");
    const pattern = store.doc.patterns.find((p) => p.id === "pattern-drop-x")!;
    const padId = Object.keys(pattern.rows)[0] ?? "";
    let oddBaked = 0;
    let evenTouched = false;
    for (let step = 0; step < 16; step++) {
      const micro = pattern.stepMeta?.[padId]?.[step]?.microtiming ?? 0;
      if (step % 2 === 1) {
        if (micro > 0) oddBaked += 1;
      } else if (micro !== 0) evenTouched = true;
    }
    expect(oddBaked).toBeGreaterThan(0);
    expect(evenTouched).toBe(false);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    const restored = store.doc.patterns.find((p) => p.id === "pattern-drop-x")!;
    const restoredPadId = Object.keys(restored.stepMeta ?? {})[0] ?? "";
    expect(restored.stepMeta?.[restoredPadId]?.[1]?.microtiming ?? 0).toBe(0);
  });

  it("set absolute: 'swing 65% in the drop' lands the ×5/3 converted micro", () => {
    const store = new ProjectStore(withDropScene());
    const route = routeIntentText("swing 65% in the drop", store.doc);
    if (route.kind !== "sectionGrooveIntent") throw new Error("expected sectionGroove");
    expect(route.intent.direction).toBe("set");
    expect(route.intent.swingPercent).toBe(65);
    executeSectionGroove(store, "swing 65% in the drop");
    const pattern = store.doc.patterns.find((p) => p.id === "pattern-drop-x")!;
    const padId = Object.keys(pattern.rows)[0] ?? "";
    const expected = Math.min(1, 0.65 * (5 / 3));
    expect(pattern.stepMeta?.[padId]?.[1]?.microtiming).toBeCloseTo(expected, 3);
  });
});
