import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import type { EffectInstance, ProjectDocument } from "../src/project-model/types";
import { ProjectStore } from "../src/store/ProjectStore";
import { addEffect, removeEffect, removeEffectFromTracks, setEffectParam } from "../src/commands/commands";

/**
 * AUDIT 05 — Plugins & Effects regression invariants
 * (prompts/daw_qa_reliability_vault/05-plugins-effects-audit.md).
 *
 * Pins the lifecycle fixes: removing an effect prunes its automation/LFO/
 * macro/MIDI references INSIDE the command (so Ctrl+Z restores the device
 * together with its routings — the deleteTrack bug class), and the batch
 * removal does the same across tracks and returns.
 */

function effectFixture() {
  const base = createProjectFromTemplate("house");
  const track = base.tracks.find((t) => t.kind === "instrument")!;
  const store = new ProjectStore(base);
  store.execute(addEffect(base, track.id, "delay"));
  const doc = store.getDoc();
  const fx = (doc.tracks.find((t) => t.id === track.id) as { effects: EffectInstance[] }).effects[0]!;
  return { store, trackId: track.id, fx };
}

/** Decorate the fixture doc with every reference kind targeting the effect. */
function withReferences(doc: ProjectDocument, trackId: string, fxId: string): ProjectDocument {
  return normalizeProject({
    ...doc,
    automation: [
      {
        id: "lane-1",
        target: { kind: "fxParam" as const, trackId, fxId, paramId: "time" },
        points: [{ tick: 0, value: 0.3 }],
      },
    ],
    lfos: [
      {
        id: "lfo-1",
        trackId,
        param: "gain" as const,
        target: { kind: "fxParam" as const, trackId, fxId, paramId: "feedback" },
        amount: 0.4,
      },
    ],
    macros: doc.macros.map((m, i) =>
      i === 0
        ? {
            ...m,
            mappings: [
              ...m.mappings,
              { id: "map-1", trackId, param: "mix", target: { kind: "fxParam" as const, trackId, fxId, paramId: "mix" }, amount: 0.5 },
            ],
          }
        : m,
    ),
    midi: doc.midi
      ? {
          ...doc.midi,
          ccMappings: [
            {
              id: "cc-1",
              ccNumber: 21,
              target: { kind: "fxParam" as const, trackId, fxId, paramId: "mix" },
              min: 0,
              max: 1,
            },
          ],
        }
      : doc.midi,
  });
}

describe("removeEffect — cross-reference pruning (audit 05)", () => {
  it("removes the device AND its automation/LFO/macro/CC references, undo restores BOTH", () => {
    const fixture = effectFixture();
    const doc = withReferences(fixture.store.getDoc(), fixture.trackId, fixture.fx.id);
    const store = new ProjectStore(doc);
    store.execute(removeEffect(doc, fixture.trackId, fixture.fx.id));
    const after = store.getDoc();

    expect(after.automation ?? []).toHaveLength(0);
    expect(after.lfos ?? []).toHaveLength(0);
    expect(after.macros[0]!.mappings.find((m) => m.id === "map-1")).toBeUndefined();
    expect(after.midi?.ccMappings ?? []).toHaveLength(0);
    const owner = after.tracks.find((t) => t.id === fixture.trackId) as { effects: EffectInstance[] };
    expect(owner.effects.find((f) => f.id === fixture.fx.id)).toBeUndefined();

    // THE invariant: undo restores the device WITH its routings.
    store.undo();
    const restored = store.getDoc();
    const ownerBack = restored.tracks.find((t) => t.id === fixture.trackId) as { effects: EffectInstance[] };
    expect(ownerBack.effects.find((f) => f.id === fixture.fx.id)).toBeDefined();
    expect(restored.automation?.find((l) => l.id === "lane-1")).toBeDefined();
    expect(restored.lfos?.find((l) => l.id === "lfo-1")).toBeDefined();
    expect(restored.macros[0]!.mappings.find((m) => m.id === "map-1")).toBeDefined();
    expect(restored.midi?.ccMappings.find((m) => m.id === "cc-1")).toBeDefined();
  });

  it("references to OTHER effects survive the removal", () => {
    let fixture = effectFixture();
    const store = fixture.store;
    store.execute(addEffect(store.getDoc(), fixture.trackId, "chorus"));
    const doc = store.getDoc();
    const effects = (doc.tracks.find((t) => t.id === fixture.trackId) as { effects: EffectInstance[] }).effects;
    const chorus = effects.find((f) => f.type === "chorus")!;
    const referenced = normalizeProject({
      ...doc,
      automation: [
        {
          id: "lane-keep",
          target: { kind: "fxParam" as const, trackId: fixture.trackId, fxId: chorus.id, paramId: "mix" },
          points: [{ tick: 0, value: 0.5 }],
        },
      ],
    });
    const store2 = new ProjectStore(referenced);
    store2.execute(removeEffect(referenced, fixture.trackId, fixture.fx.id));
    expect(store2.getDoc().automation?.find((l) => l.id === "lane-keep")).toBeDefined();
    void fixture;
  });

  it("a stale fx id is a no-op without a dead undo entry", () => {
    const fixture = effectFixture();
    const before = fixture.store.getDoc();
    const beforeDepth = fixture.store.undoStackLength;
    fixture.store.execute(removeEffect(before, fixture.trackId, "fx-does-not-exist"));
    expect(fixture.store.getDoc()).toBe(before);
    expect(fixture.store.undoStackLength).toBe(beforeDepth);
  });
});

describe("removeEffectFromTracks — batch reference pruning (audit 05)", () => {
  it("prunes references for every removed instance across tracks", () => {
    const fixture = effectFixture();
    const doc = withReferences(fixture.store.getDoc(), fixture.trackId, fixture.fx.id);
    const store = new ProjectStore(doc);
    store.execute(removeEffectFromTracks(doc, [fixture.trackId], "delay"));
    const after = store.getDoc();
    expect(after.automation ?? []).toHaveLength(0);
    expect(after.midi?.ccMappings ?? []).toHaveLength(0);
    store.undo();
    const restored = store.getDoc();
    expect(restored.automation?.find((l) => l.id === "lane-1")).toBeDefined();
  });
});

describe("setEffectParam — boundary still clamps (audit 05 regression guard)", () => {
  it("non-finite param writes fall back to the definition default", () => {
    const fixture = effectFixture();
    const doc = fixture.store.getDoc();
    fixture.store.execute(setEffectParam(doc, fixture.trackId, fixture.fx.id, "time", Number.NaN));
    const fx = (
      fixture.store.getDoc().tracks.find((t) => t.id === fixture.trackId) as { effects: EffectInstance[] }
    ).effects.find((f) => f.id === fixture.fx.id)!;
    expect(Number.isFinite(fx.params.time as number)).toBe(true);
  });
});
