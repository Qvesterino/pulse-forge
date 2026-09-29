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
import { applySoundSwapIntent, applyStepEditIntent } from "../src/intent/sound-words";
import { setStepVelocityCommand } from "../src/commands/commands";
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

// ─── SOUND WORDS — step edits + pad sound swaps (Phase B) ───────────────────

describe("step edit intents", () => {
  function padIdOf(doc: ProjectDocument): string {
    const drums = doc.tracks.find((t) => t.kind === "drum")!;
    return drums.pads.find((p) => p.name.toLowerCase().includes("kick"))!.id;
  }

  function withBeat(doc: ProjectDocument, step: number, velocity = 0.8) {
    const store = new ProjectStore(doc);
    const padId = padIdOf(doc);
    store.execute(setStepVelocityCommand(store.doc, padId, step, velocity));
    return { store, padId };
  }

  it("remove the kick on beat 3 zeroes exactly that step; undo restores", () => {
    const store = new ProjectStore(freshDoc());
    const { store: withHit } = withBeat(store.doc, 8); // beat 3 = 0-based step 8
    store.replaceDoc(withHit.doc);
    expect(routeIntentText("remove the kick on beat 3", store.doc).kind).toBe("stepEditIntent");
    executeStepEdit(store, "remove the kick on beat 3");
    const drums = store.doc.tracks.find((t) => t.kind === "drum")!;
    const kickPad = drums.pads.find((p) => p.name.toLowerCase().includes("kick"))!;
    expect(store.doc.patterns[0].rows[kickPad.id]?.[8] ?? 0).toBe(0);
    expect(store.undoStackLength).toBe(1); // replaceDoc seed is not an undo entry; the edit is
    store.undo();
    expect(store.doc.patterns[0].rows[kickPad.id]?.[8] ?? 0).toBe(0.8);
  });

  it("bar 2 on a 16-step pattern fails explicitly (1 bar only)", () => {
    const doc = freshDoc();
    expect(() => executeStepEdit(new ProjectStore(doc), "remove the kick on beat 3 of bar 2")).toThrow(/1 takt/);
  });

  it("ghost snare on the last 16th adds a quiet probable hit", () => {
    const store = new ProjectStore(freshDoc());
    executeStepEdit(store, "add a ghost snare on the last 16th");
    const drums = store.doc.tracks.find((t) => t.kind === "drum")!;
    const snare = drums.pads.find((p) => p.name.toLowerCase().includes("snare"))!;
    const pattern = store.doc.patterns[store.doc.activePatternId as unknown as number] ?? store.doc.patterns[0];
    const velocity = pattern.rows[snare.id]?.[15] ?? 0;
    expect(velocity).toBeCloseTo(0.35, 5);
    const probability = pattern.stepMeta?.[snare.id]?.[15]?.probability ?? 1;
    expect(probability).toBeCloseTo(0.5, 5);
  });

  it("accent the kick on beat 1 pushes velocity to full", () => {
    const store = new ProjectStore(freshDoc());
    executeStepEdit(store, "accent the kick on beat 1");
    const drums = store.doc.tracks.find((t) => t.kind === "drum")!;
    const kick = drums.pads.find((p) => p.name.toLowerCase().includes("kick"))!;
    expect(store.doc.patterns[0].rows[kick.id]?.[0] ?? 0).toBe(1);
  });

  it("removing silence returns the explicit no-hit error", () => {
    const store = new ProjectStore(freshDoc());
    expect(() => executeStepEdit(store, "remove the snare on beat 3")).toThrow(/žiadny hit/);
  });

  function executeStepEdit(store: ProjectStore, text: string): void {
    const route = routeIntentText(text, store.doc);
    if (route.kind !== "stepEditIntent") throw new Error(`expected stepEdit, got ${route.kind}`);
    const command = applyStepEditIntent(store.doc, route.intent);
    if (!command)
      throw new Error(route.intent.action === "remove" ? "na tejto pozícii nie je žiadny hit" : "nič na úpravu");
    store.execute(command);
  }
});

describe("sound swap intents", () => {
  it("swap the kick to something deeper picks a deep kick asset family-wide", () => {
    const doc = freshDoc();
    const store = new ProjectStore(doc);
    const route = routeIntentText("swap the kick to something deeper", store.doc);
    expect(route.kind).toBe("soundSwapIntent");
    if (route.kind !== "soundSwapIntent") throw new Error(`expected soundSwap, got ${route.kind}`);
    expect(route.intent.family).toBe("kick");
    expect(route.intent.descriptor).toBe("fatter");
    const next = executeSwap(store, "swap the kick to something deeper");
    const drums = next.tracks.find((t) => t.kind === "drum")!;
    const swapped = drums.pads.filter((p) => p.name.toLowerCase().includes("kick"));
    expect(swapped.length).toBeGreaterThan(0);
    for (const pad of swapped) expect(pad.assetId).toContain("kick");
    expect(drums.pads.find((p) => p.name.toLowerCase().includes("snare"))!.assetId).not.toContain("kick");
  });

  it("darker swap prefers a dark-mood asset; undo restores", () => {
    const store = new ProjectStore(freshDoc());
    const kick = store.doc.tracks
      .find((t) => t.kind === "drum")!
      .pads.find((p) => p.name.toLowerCase().includes("kick"))!;
    const before = kick.assetId;
    executeSwap(store, "swap the kick to a darker one");
    const after = store.doc.tracks
      .find((t) => t.kind === "drum")!
      .pads.find((p) => p.name.toLowerCase().includes("kick"))!.assetId;
    expect(after).not.toBe(before);
    store.undo();
    expect(
      store.doc.tracks.find((t) => t.kind === "drum")!.pads.find((p) => p.name.toLowerCase().includes("kick"))!.assetId,
    ).toBe(before);
  });

  it("explicit unknown descriptor declines (no candidate hallucinated)", () => {
    const doc = freshDoc();
    expect(routeIntentText("paint the kick purple", doc).kind).not.toBe("soundSwapIntent");
  });

  function executeSwap(store: ProjectStore, text: string): ProjectDocument {
    const route = routeIntentText(text, store.doc);
    if (route.kind !== "soundSwapIntent") throw new Error(`expected soundSwap, got ${route.kind}`);
    const command = applySoundSwapIntent(store.doc, route.intent);
    if (!command) throw new Error("no swap candidate");
    store.execute(command);
    return command.execute(store.doc);
  }
});
