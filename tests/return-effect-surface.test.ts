import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc } from "./fixtures/doc";
import { addEffectToTracks, createReturnTrack, removeEffectFromTracks } from "../src/commands/tracks";
import { removeEffect } from "../src/commands/effectInstances";
import { setEffectParam, toggleEffectBypass } from "../src/commands/effectParams";

/**
 * F-07 half 2 — a return bus owns an effect chain, and the per-instance
 * surface must address it like any other owner.
 *
 * `addEffectToTracks` accepted return ids, but `trackEffectsOf` /
 * `withTrackEffects` (the owner-resolution pair behind remove, bypass and
 * param writes) only knew tracks and the master — so removing, bypassing or
 * tuning an effect INSTALLED ON A RETURN was a silent no-op: the UI click
 * did nothing, and the MCP tool answered "no such instance" for an instance
 * that op:list had just shown.
 */

function returnWithEffect() {
  const store = new ProjectStore(testDoc());
  store.execute(createReturnTrack(store.doc, "Wet"));
  const returnId = store.doc.returns[store.doc.returns.length - 1]!.id;
  store.execute(addEffectToTracks(store.doc, [returnId], "delay"));
  const fxId = store.doc.returns.find((r) => r.id === returnId)!.effects[0]!.id;
  return { store, returnId, fxId };
}

describe("the per-instance effect surface reaches return buses", () => {
  it("removeEffect removes a return-owned instance and undo restores it", () => {
    const { store, returnId, fxId } = returnWithEffect();
    const depthBefore = store.undoStackLength;
    store.execute(removeEffect(store.doc, returnId, fxId));

    expect(store.undoStackLength, "the removal must not be a silent no-op").toBeGreaterThan(depthBefore);
    expect(store.doc.returns.find((r) => r.id === returnId)!.effects).toHaveLength(0);

    store.undo();
    expect(store.doc.returns.find((r) => r.id === returnId)!.effects).toHaveLength(1);
  });

  it("toggleEffectBypass flips a return-owned instance", () => {
    const { store, returnId, fxId } = returnWithEffect();
    store.execute(toggleEffectBypass(store.doc, returnId, fxId));

    expect(store.doc.returns.find((r) => r.id === returnId)!.effects[0]!.bypassed).toBe(true);
    store.undo();
    expect(store.doc.returns.find((r) => r.id === returnId)!.effects[0]!.bypassed).toBe(false);
  });

  it("setEffectParam writes a return-owned instance", () => {
    const { store, returnId, fxId } = returnWithEffect();
    store.execute(setEffectParam(store.doc, returnId, fxId, "mix", 0.5));

    expect(store.doc.returns.find((r) => r.id === returnId)!.effects[0]!.params.mix).toBe(0.5);
    store.undo();
    expect(store.doc.returns.find((r) => r.id === returnId)!.effects[0]!.params.mix).not.toBe(0.5);
  });

  it("the type-level remove keeps its existing return behaviour (control)", () => {
    const { store, returnId } = returnWithEffect();
    store.execute(removeEffectFromTracks(store.doc, [returnId], "delay"));

    expect(store.doc.returns.find((r) => r.id === returnId)!.effects).toHaveLength(0);
  });
});
