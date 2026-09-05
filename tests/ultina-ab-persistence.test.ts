import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { projectToYDoc, yDocToProject, applyProjectToYMap } from "../src/collab/YDocAdapter";
import { YDocStore } from "../src/collab/YDocStore";
import { loadEffectAbSlot, loadUltinaAbSlot, setDeviceState, setUltinaParam } from "../src/commands/commands";
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

function flagshipDoc(type: "fxeq" | "ozvena", state?: DeviceState): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument")!;
  track.effects = [
    {
      id: "fx-flagship-ab",
      type,
      bypassed: false,
      params: type === "fxeq" ? { bandCount: 4, "band1.gainDb": 0 } : { "global.inputGainDb": -3 },
      ...(state ? { deviceState: state } : {}),
    },
  ];
  return doc;
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
    for (const raw of [
      { kind: "mystery", data: { x: 1 } },
      { kind: 42, data: {} },
      { kind: "effect-ab-v1", data: [] },
      { kind: "effect-ab-v1", data: { slots: [] } },
      "garbage",
    ]) {
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

  it("allows an active empty B slot while preparing a new variation", () => {
    const doc = ultinaDoc({ kind: "ultina-ab-v1", data: { slots: { A: { x: 1 } }, active: "B" } });
    const normalized = normalizeProject(JSON.parse(JSON.stringify(doc)));
    expect(abEffect(normalized).deviceState?.data.active).toBe("B");
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

describe("flagship A/B persistence — FXEQ and Ozvena", () => {
  it("keeps the shared A/B state through project normalization", () => {
    const state: DeviceState = {
      kind: "effect-ab-v1",
      data: { slots: { A: { "band1.gainDb": -6 } }, active: "A" },
    };
    const normalized = normalizeProject(JSON.parse(JSON.stringify(flagshipDoc("fxeq", state))));
    expect(abEffect(normalized).deviceState?.kind).toBe("effect-ab-v1");
    expect(
      (abEffect(normalized).deviceState!.data.slots as Record<string, Record<string, number>>).A["band1.gainDb"],
    ).toBe(-6);
  });

  it("restores FXEQ against its band-aware schema and drops unknown snapshot keys", () => {
    const doc = flagshipDoc("fxeq", {
      kind: "effect-ab-v1",
      data: {
        slots: { B: { bandCount: 4, "band1.gainDb": 999, "not-a-param": 7 } },
        active: "A",
      },
    });
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    const command = loadEffectAbSlot(doc, trackId, "fx-flagship-ab", "B");
    const next = command.execute(doc);
    expect(abEffect(next).params["band1.gainDb"]).toBe(12);
    expect(abEffect(next).params["not-a-param"]).toBeUndefined();
    expect(abEffect(next).deviceState?.data.active).toBe("B");
    expect(abEffect(command.undo(next)).params["band1.gainDb"]).toBe(0);
  });

  it("restores Ozvena's complete deep state without accepting arbitrary paths", () => {
    const doc = flagshipDoc("ozvena", {
      kind: "effect-ab-v1",
      data: {
        slots: {
          B: {
            "engines.e1.time": 1234,
            "engines.e2.attack": 9999,
            "duck.thresholdDb": -999,
            "preEq.band1.gainDb": 999,
            "evil.nope": 1,
          },
        },
        active: "A",
      },
    });
    const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    const next = loadEffectAbSlot(doc, trackId, "fx-flagship-ab", "B").execute(doc);
    expect(abEffect(next).params["engines.e1.time"]).toBe(250);
    expect(abEffect(next).params["engines.e2.attack"]).toBe(250);
    expect(abEffect(next).params["duck.thresholdDb"]).toBe(-60);
    expect(abEffect(next).params["preEq.band1.gainDb"]).toBe(24);
    expect(abEffect(next).params["evil.nope"]).toBeUndefined();
    expect(abEffect(next).params.schemaVersion).toBeUndefined();
    expect(abEffect(next).params["assistant.step"]).toBeUndefined();
    expect(abEffect(next).params["engines.e2.time"]).toBeDefined();
  });
});
