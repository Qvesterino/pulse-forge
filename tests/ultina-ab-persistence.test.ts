import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { projectToYDoc, yDocToProject, applyProjectToYMap } from "../src/collab/YDocAdapter";
import { YDocStore } from "../src/collab/YDocStore";
import { loadUltinaAbSlot, setDeviceState, setUltinaParam } from "../src/commands/commands";
import type { DeviceState, EffectInstance, InstrumentTrack, ProjectDocument } from "../src/project-model/types";

const AB_STATE: DeviceState = {
  kind: "ultina-ab-v1",
  data: {
    slots: {
      A: { "comp.band0.thresholdDb": -18, "comp.band1.thresholdDb": -14 },
      B: { "comp.band0.thresholdDb": -32, "comp.band1.thresholdDb": -28 },
    },
    active: "A",
  },
};

function ultinaDoc(state?: DeviceState): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument")!;
  track.effects = [
    {
      id: "fx-ab",
      type: "ultina",
      bypassed: false,
      params: { "comp.band0.thresholdDb": -10 },
      ...(state ? { deviceState: state } : {}),
    },
  ];
  return doc;
}

function abEffect(doc: ProjectDocument): EffectInstance {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument")!;
  return track.effects[0];
}

describe("ultina A/B persistence — schema", () => {
  it("keeps a legal device state through normalizeProject", () => {
    const normalized = normalizeProject(JSON.parse(JSON.stringify(ultinaDoc(AB_STATE))));
    const state = abEffect(normalized).deviceState;
    expect(state?.kind).toBe("ultina-ab-v1");
    expect(state?.data).toMatchObject({ active: "A" });
    expect((state!.data.slots as Record<string, Record<string, number>>).A["comp.band0.thresholdDb"]).toBe(-18);
  });

  it("drops unknown kinds and cleans non-finite values inside slots", () => {
    // Unknown kind / broken shape fail closed.
    for (const raw of [{ kind: "mystery", data: { x: 1 } }, { kind: 42, data: {} }, "garbage"]) {
      const doc = ultinaDoc(raw as DeviceState);
      const normalized = normalizeProject(JSON.parse(JSON.stringify(doc)));
      expect(abEffect(normalized).deviceState).toBeUndefined();
    }
    // A partially valid slot survives, but the NaN entry is dropped.
    const dirty = ultinaDoc({
      kind: "ultina-ab-v1",
      data: { slots: { A: { ok: 1, bad: Number.NaN } as unknown as Record<string, number> }, active: "A" },
    });
    const cleaned = normalizeProject(JSON.parse(JSON.stringify(dirty)));
    const slots = abEffect(cleaned).deviceState!.data.slots as Record<string, Record<string, number>>;
    expect(slots.A).toEqual({ ok: 1 });
  });

  it("an active B without a stored B slot falls back to A", () => {
    const doc = ultinaDoc({ kind: "ultina-ab-v1", data: { slots: { A: { x: 1 } }, active: "B" } });
    const normalized = normalizeProject(JSON.parse(JSON.stringify(doc)));
    expect(abEffect(normalized).deviceState?.data.active).toBe("A");
  });
});

describe("ultina A/B persistence — collab round-trip", () => {
  it("survives projectToYDoc → yDocToProject", () => {
    const doc = ultinaDoc(AB_STATE);
    const yDoc = new Y.Doc();
    projectToYDoc(doc, yDoc.getMap("project"));
    const restored = yDocToProject(yDoc.getMap("project"));
    expect(
      restored.tracks.some((t) => (t as InstrumentTrack).effects?.some((f) => f.deviceState?.kind === "ultina-ab-v1")),
    ).toBe(true);
  });

  it("a setDeviceState delta reaches the Y.Doc through applyProjectToYMap", () => {
    const doc = ultinaDoc();
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    const next = setDeviceState(doc, doc.tracks.find((t) => t.kind === "instrument")!.id, "fx-ab", AB_STATE).execute(
      doc,
    );
    applyProjectToYMap(doc, next, yMap);
    const restored = yDocToProject(yMap);
    expect(abEffect(restored).deviceState?.data.active).toBe("A");
  });

  it("YDocStore.execute persists device state and undo rolls it back", () => {
    const doc = ultinaDoc();
    const store = YDocStore.fromDocument(doc);
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    store.execute(setDeviceState(doc, trackId, "fx-ab", AB_STATE));
    expect(abEffect(store.doc).deviceState?.kind).toBe("ultina-ab-v1");
    store.undo();
    expect(abEffect(store.doc).deviceState).toBeUndefined();
  });
});

describe("ultina A/B persistence — commands", () => {
  it("loadUltinaAbSlot restores params AND flips active in ONE command", () => {
    const doc = ultinaDoc(AB_STATE);
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    const cmd = loadUltinaAbSlot(doc, trackId, "fx-ab", "B");
    const next = cmd.execute(doc);
    const fx = abEffect(next);
    // Exact restore: B snapshot values clamped into real params.
    expect(fx.params["comp.band0.thresholdDb"]).toBe(-32);
    expect(fx.deviceState?.data.active).toBe("B");
    // One undo returns BOTH the params and the active flag.
    const undone = cmd.undo(next);
    expect(abEffect(undone).params["comp.band0.thresholdDb"]).toBe(-10);
    expect(abEffect(undone).deviceState?.data.active).toBe("A");
    // Loading an empty slot throws instead of silently doing nothing.
    const empty = ultinaDoc({ kind: "ultina-ab-v1", data: { slots: { A: { x: 1 } }, active: "A" } });
    const emptyTrackId = empty.tracks.find((t) => t.kind === "instrument")!.id;
    expect(() => loadUltinaAbSlot(empty, emptyTrackId, "fx-ab", "B")).toThrow(/empty/);
  });

  it("restored values are clamped to the vendored schema", () => {
    const doc = ultinaDoc({
      kind: "ultina-ab-v1",
      data: { slots: { B: { "comp.band0.thresholdDb": -999 } }, active: "A" },
    });
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    const next = loadUltinaAbSlot(doc, trackId, "fx-ab", "B").execute(doc);
    const threshold = abEffect(next).params["comp.band0.thresholdDb"];
    expect(threshold).toBe(-60); // schema min for comp.band0.thresholdDb
  });

  it("setDeviceState undo restores the previous blob exactly", () => {
    const doc = ultinaDoc(AB_STATE);
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    const cmd = setDeviceState(doc, trackId, "fx-ab", null);
    const next = cmd.execute(doc);
    expect(abEffect(next).deviceState).toBeUndefined();
    const undone = cmd.undo(next);
    expect(abEffect(undone).deviceState?.data.active).toBe("A");
    void setUltinaParam;
    void vi;
  });
});
