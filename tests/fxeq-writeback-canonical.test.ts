/**
 * PRISM write-back: the DSP's id and scale must land in the document under
 * the CANONICAL id (audit F-28, Critical).
 *
 * The rack exposes the global wet/dry as `mix` (document 0..1); the vendored
 * core names the same control `globalMix` (core 0..100 percent). The core's
 * own Undo/Redo returns the CORE id and the CORE value, and the PRISM panel
 * writes them straight back into the document.
 *
 * `normalizePluginParams` treats `mix` as the source of truth and re-derives
 * `globalMix` from it — so a write under the core id was silently discarded:
 * the DSP moved, the document did not, a save + reload changed the sound, and
 * the project's undo stack grew a dead step.
 *
 * The fix canonicalises the id AND the value in ONE place
 * (`src/effects/fxeq-param-ids.ts`) before the command writes.
 */
import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";
import { createDrumTrackModel, normalizeProject } from "../src/project-model/schema";
import { addEffectToTracks } from "../src/commands/tracks";
import { setFxEqParam } from "../src/commands/plugins";
import { ProjectStore } from "../src/store/ProjectStore";
import type { ProjectDocument } from "../src/project-model/types";

function docWithFxeq(): { doc: ProjectDocument; trackId: string; fxId: string } {
  const drums = createDrumTrackModel("Drums");
  const doc = {
    schemaVersion: 1,
    id: "fxeq-writeback",
    name: "FxEqWriteback",
    bpm: 124,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [drums],
    patterns: [],
    activePatternId: "",
    scenes: [],
    arrangement: { clips: [] },
    markers: [],
    sceneAutomation: [],
    automation: [],
    lfos: [],
    macros: [],
    returns: [],
    master: { masterGain: 1, ceilingDb: -1, limiterEnabled: false, clipperEnabled: false },
    createdAt: "",
    updatedAt: "",
  } as unknown as ProjectDocument;
  const seeded = addEffectToTracks(doc, [drums.id], "fxeq" as never).execute(doc);
  const fx = seeded.tracks.find((t) => t.id === drums.id)!.effects[0];
  return { doc: seeded, trackId: drums.id, fxId: fx.id };
}

/** A document whose PRISM instance holds the user's MIX choice (rack id, 0..1). */
function docWithMix(mix: number): { doc: ProjectDocument; trackId: string; fxId: string } {
  const { doc: seeded, trackId, fxId } = docWithFxeq();
  const withMix: ProjectDocument = {
    ...seeded,
    tracks: seeded.tracks.map((t) =>
      t.id === trackId
        ? {
            ...t,
            effects: t.effects.map((f) => (f.id === fxId ? { ...f, params: { ...f.params, mix } } : f)),
          }
        : t,
    ),
  };
  return { doc: normalizeProject(withMix), trackId, fxId };
}

describe("PRISM write-back lands under the canonical id (F-28)", () => {
  it("the core's undo entry reaches the document as `mix` in the document's scale", () => {
    // The core (DSP domain): the user drags MIX 1.00 -> 0.30, then undoes.
    const core = createFxEqProcessor({ globalMix: 100 });
    core.prepare(48000, 2, 128);
    core.setParameter("globalMix", 30);
    const entry = core.undo();
    expect(entry).not.toBeNull();
    // The core hands back its OWN id and its OWN scale — 0..100 percent.
    expect(entry!.id).toBe("globalMix");
    expect(entry!.value).toBe(100);

    // The document holds the user's choice: rack id `mix`, 0..1.
    const { doc: before, trackId, fxId } = docWithMix(0.3);
    const fxBefore = before.tracks.find((t) => t.id === trackId)!.effects[0];
    expect(fxBefore.params.mix).toBe(0.3);
    expect(fxBefore.params.globalMix).toBe(0.3);

    // The panel writes the core's id + value back into the document.
    const store = new ProjectStore(before);
    store.execute(setFxEqParam(store.doc, trackId, fxId, entry!.id, entry!.value));
    const fxAfter = store.doc.tracks.find((t) => t.id === trackId)!.effects[0];

    // THE FIX: the write landed under the CANONICAL id, in the document's scale.
    expect(fxAfter.params.mix).toBe(1);
    // ...and the derived core-side field follows it.
    expect(fxAfter.params.globalMix).toBe(1);
  });

  it("the document and the DSP agree, and a save + reload reproduces the sound", () => {
    const core = createFxEqProcessor({ globalMix: 100 });
    core.prepare(48000, 2, 128);
    core.setParameter("globalMix", 30);
    const entry = core.undo();

    const { doc: before, trackId, fxId } = docWithMix(0.3);
    const store = new ProjectStore(before);
    store.execute(setFxEqParam(store.doc, trackId, fxId, entry!.id, entry!.value));
    const fxAfter = store.doc.tracks.find((t) => t.id === trackId)!.effects[0];

    // The live DSP holds the undone value...
    const dspWetDry = core.getParameter("globalMix") / 100;
    expect(dspWetDry).toBe(1);

    // ...and the document now says the same thing.
    const documentWetDry = fxAfter.params.mix;
    expect(documentWetDry).toBe(dspWetDry);

    // A reload rebuilds the effect from the DOCUMENT — and now reproduces it.
    const reloadedCore = createFxEqProcessor({ globalMix: fxAfter.params.globalMix * 100 });
    reloadedCore.prepare(48000, 2, 128);
    expect(reloadedCore.getParameter("globalMix") / 100).toBe(dspWetDry);
  });

  it("the undo step is real — Ctrl+Z restores the previous mix", () => {
    const core = createFxEqProcessor({ globalMix: 100 });
    core.prepare(48000, 2, 128);
    core.setParameter("globalMix", 30);
    const entry = core.undo();

    const { doc: before, trackId, fxId } = docWithMix(0.3);
    const store = new ProjectStore(before);
    store.execute(setFxEqParam(store.doc, trackId, fxId, entry!.id, entry!.value));
    expect(store.undoStackLength).toBe(1);

    store.undo();
    const fxUndone = store.doc.tracks.find((t) => t.id === trackId)!.effects[0];
    // The dead step is gone: Ctrl+Z actually restores the user's 0.30.
    expect(fxUndone.params.mix).toBe(0.3);
    expect(fxUndone.params.globalMix).toBe(0.3);
  });

  it("the rack id path is unchanged — `mix` still writes the document scale", () => {
    const { doc, trackId, fxId } = docWithFxeq();
    const store = new ProjectStore(doc);
    store.execute(setFxEqParam(store.doc, trackId, fxId, "mix", 0.42));
    const fx = store.doc.tracks.find((t) => t.id === trackId)!.effects[0];
    expect(fx.params.mix).toBe(0.42);
    expect(fx.params.globalMix).toBe(0.42);
  });

  it("a deep core id still writes the core scale", () => {
    const { doc, trackId, fxId } = docWithFxeq();
    const store = new ProjectStore(doc);
    store.execute(setFxEqParam(store.doc, trackId, fxId, "band2.gainDb", 3));
    const fx = store.doc.tracks.find((t) => t.id === trackId)!.effects[0];
    expect(fx.params["band2.gainDb"]).toBe(3);
  });

  it("an id outside the schema is still rejected", () => {
    const { doc, trackId, fxId } = docWithFxeq();
    expect(() => setFxEqParam(doc, trackId, fxId, "band9.nope", 1)).toThrow(/not defined/);
  });
});
