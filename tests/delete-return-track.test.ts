import { describe, expect, it } from "vitest";
import { createReturnTrack, deleteReturnTrack, addAutomationLane, setTrackSend } from "../src/commands/commands";
import { createDrumTrackModel, createInstrumentTrackModel } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * RETURN-TRACK CRUD SEAM (signal-flow audit re-run 2026-10).
 *
 * createReturnTrack existed; deletion was only possible through raw doc edits
 * that relied on the engine's silent send filter — the dead send keys,
 * automation lanes, LFOs, macro mappings and MIDI CC mappings pointing at the
 * removed bus lived in every save. deleteReturnTrack mirrors the deleteTrack
 * cleanup contract: everything routed AT the bus dies WITH the bus, inside
 * one snapshot, so undo restores the bus together with everything that
 * pointed at it. (normalizeProject deliberately does NOT strip send keys for
 * already-deleted returns — collab forward-compat, a peer may re-add the bus.)
 */

function docWithReturn(): { doc: ProjectDocument; returnId: string; drumId: string; leadId: string } {
  const base = createProjectFromTemplate("house");
  const drums = createDrumTrackModel("Drums");
  const lead = createInstrumentTrackModel("analog", 0);
  let doc = { ...base, tracks: [...base.tracks, drums, lead] } as ProjectDocument;
  const create = createReturnTrack(doc, "Space").execute(doc);
  doc = create;
  const returnId = doc.returns[doc.returns.length - 1]!.id;
  return { doc, returnId, drumId: drums.id, leadId: lead.id };
}

describe("deleteReturnTrack", () => {
  it("drops the bus AND every send level into it — one snapshot, undo restores both", () => {
    const { doc, returnId, drumId, leadId } = docWithReturn();
    let next = setTrackSend(doc, drumId, returnId, 0.5).execute(doc);
    next = setTrackSend(next, leadId, returnId, 0.8).execute(next);

    const command = deleteReturnTrack(next, returnId);
    const deleted = command.execute(next);
    expect(deleted.returns.find((r) => r.id === returnId)).toBeUndefined();
    const drums = deleted.tracks.find((t) => t.id === drumId) as { sends?: Record<string, number> };
    expect(drums.sends?.[returnId]).toBeUndefined();
    const lead = deleted.tracks.find((t) => t.id === leadId) as { sends?: Record<string, number> };
    expect(lead.sends?.[returnId]).toBeUndefined();

    const restored = command.undo(deleted);
    expect(restored.returns.find((r) => r.id === returnId)).toBeDefined();
    expect((restored.tracks.find((t) => t.id === drumId) as { sends?: Record<string, number> }).sends?.[returnId]).toBe(
      0.5,
    );
    expect((restored.tracks.find((t) => t.id === leadId) as { sends?: Record<string, number> }).sends?.[returnId]).toBe(
      0.8,
    );
  });

  it("strips automation lanes, LFOs, macros and MIDI CC routed at the bus (dangling-ref contract)", () => {
    const { doc, returnId } = docWithReturn();
    const withLane = addAutomationLane(doc, { kind: "trackGain", trackId: returnId }).execute(doc);
    const lane = withLane.automation[withLane.automation.length - 1]!;
    const withLfo = {
      ...withLane,
      lfos: [
        ...withLane.lfos,
        {
          id: "lfo1",
          trackId: returnId,
          wave: "sine",
          rate: 1,
          amount: 0.2,
          target: { kind: "trackGain", trackId: returnId },
        },
      ],
      macros: [
        { id: "m1", name: "A", value: 1, mappings: [{ id: "x1", trackId: returnId, param: "gain", amount: 0.5 }] },
      ],
      midi: {
        enabled: false,
        deviceId: "",
        drumChannel: 9,
        instrumentChannel: 0,
        ccMappings: [{ id: "cc1", ccNumber: 74, target: { kind: "trackGain", trackId: returnId }, min: 0, max: 1 }],
        drumNoteMap: [],
      },
    } as unknown as ProjectDocument;

    const deleted = deleteReturnTrack(withLfo, returnId).execute(withLfo);
    expect(deleted.automation.find((l) => l.id === lane.id)).toBeUndefined();
    expect(deleted.lfos.find((l) => l.id === "lfo1")).toBeUndefined();
    expect(deleted.macros.find((m) => m.id === "m1")!.mappings).toHaveLength(0);
    expect(deleted.midi!.ccMappings).toHaveLength(0);

    // Undo restores the references together with the bus.
    const restored = deleteReturnTrack(withLfo, returnId).undo(deleted);
    expect(restored.returns.find((r) => r.id === returnId)).toBeDefined();
    expect(restored.automation.find((l) => l.id === lane.id)).toBeDefined();
    expect(restored.macros.find((m) => m.id === "m1")!.mappings).toHaveLength(1);
  });

  it("rejects an unknown return loudly (no silent no-op)", () => {
    const { doc } = docWithReturn();
    expect(() => deleteReturnTrack(doc, "no-such-return")).toThrow(/not found/);
  });

  it("unrelated tracks and other returns survive untouched", () => {
    const { doc, returnId } = docWithReturn();
    let next = createReturnTrack(doc, "Delay").execute(doc);
    const otherReturnId = next.returns.find((r) => r.id !== returnId)!.id;
    next = setTrackSend(next, doc.tracks[0]!.id, otherReturnId, 0.3).execute(next);
    const deleted = deleteReturnTrack(next, returnId).execute(next);
    expect(deleted.returns.find((r) => r.id === otherReturnId)).toBeDefined();
    expect((deleted.tracks[0] as { sends?: Record<string, number> }).sends?.[otherReturnId]).toBe(0.3);
  });
});
