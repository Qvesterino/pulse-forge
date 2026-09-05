import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDocStore } from "../src/collab/YDocStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { setPadParams, setPadSynth } from "../src/commands/commands";
import type { DrumTrack, ProjectDocument } from "../src/project-model/types";

/**
 * Cross-component contract audit regression: pad commands must resolve the
 * pad across ALL drum tracks. The original implementations scoped their
 * undo baseline and their collab fast path to the FIRST drum track, so in
 * any project with 2+ drum tracks a pad living on a later track silently
 * no-opped in collab and restored wrong values on undo in solo mode.
 */

function multiDrumDoc(): { doc: ProjectDocument; second: DrumTrack } {
  const doc = createProjectFromTemplate("house");
  const first = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
  const second: DrumTrack = {
    ...first,
    id: `${first.id}-b`,
    name: "Drums B",
    pads: first.pads.map((p, i) => ({ ...p, id: `${p.id}-b${i}` })),
  };
  // The second track goes FIRST — the regression is precisely that the old
  // code stopped scanning at the first drum track.
  doc.tracks = [second, ...doc.tracks];
  return { doc, second };
}

describe("setPadParams — multi-drum-track resolution", () => {
  it("solo store: edits and undoes a pad on the SECOND drum track correctly", () => {
    const { doc, second } = multiDrumDoc();
    const store = YDocStore.fromDocument(doc);
    const pad = second.pads[0];
    const before = store.doc.tracks.find((t): t is DrumTrack => t.id === second.id)!.pads.find((p) => p.id === pad.id)!;

    store.execute(setPadParams(store.doc, pad.id, { gain: 0.42, pan: -0.6 }));

    const after = store.doc.tracks.find((t): t is DrumTrack => t.id === second.id)!.pads.find((p) => p.id === pad.id)!;
    expect(after.gain).toBe(0.42);
    expect(after.pan).toBe(-0.6);

    store.undo();
    const restored = store.doc.tracks
      .find((t): t is DrumTrack => t.id === second.id)!
      .pads.find((p) => p.id === pad.id)!;
    expect(restored).toEqual(before);
  });

  it("collab peers receive the fast-path edit for a pad on the second drum track", () => {
    const { doc, second } = multiDrumDoc();
    const a = YDocStore.fromDocument(doc);
    const b = new YDocStore(new Y.Doc());
    const sync = () => {
      Y.applyUpdate(b.yDocRef, Y.encodeStateAsUpdate(a.yDocRef));
      Y.applyUpdate(a.yDocRef, Y.encodeStateAsUpdate(b.yDocRef));
    };
    sync();

    const pad = second.pads[1];
    a.execute(setPadParams(a.doc, pad.id, { gain: 0.7 }));
    sync();

    const seen = b.doc.tracks.find((t): t is DrumTrack => t.id === second.id)!.pads.find((p) => p.id === pad.id)!;
    expect(seen.gain).toBe(0.7);
  });

  it("setPadSynth undo restores the correct pad in a multi-drum-track project", () => {
    const { doc, second } = multiDrumDoc();
    const store = YDocStore.fromDocument(doc);
    const pad = second.pads[2];
    const before = store.doc.tracks.find((t): t is DrumTrack => t.id === second.id)!.pads.find((p) => p.id === pad.id)!;

    store.execute(setPadSynth(store.doc, pad.id, null));

    const after = store.doc.tracks.find((t): t is DrumTrack => t.id === second.id)!.pads.find((p) => p.id === pad.id)!;
    expect(after).toEqual(before); // synth: null on an already-synth-less pad is a no-op write

    // Give the pad a synth, then undo — the restore must hit THIS pad.
    store.execute(setPadSynth(store.doc, pad.id, { type: "kick", decay: 0.3, tone: 0.5, snap: 0, body: 0.5 }));
    const synthed = store.doc.tracks
      .find((t): t is DrumTrack => t.id === second.id)!
      .pads.find((p) => p.id === pad.id)!;
    expect(synthed.synth).not.toBeNull();
    expect(synthed.assetId).toBeNull();

    store.undo();
    const restored = store.doc.tracks
      .find((t): t is DrumTrack => t.id === second.id)!
      .pads.find((p) => p.id === pad.id)!;
    expect(restored).toEqual(before);
  });
});

describe("YDocStore — history surface parity with ProjectStore", () => {
  it("undoStackLength reports the real stack length (CommandToast / history panel change key)", () => {
    const store = YDocStore.fromDocument(createProjectFromTemplate("house"));
    const pad = (store.doc.tracks.find((t) => t.kind === "drum") as DrumTrack).pads[0];
    expect(store.undoStackLength).toBe(0);
    store.execute(setPadParams(store.doc, pad.id, { gain: 0.5 }));
    store.execute(setPadParams(store.doc, pad.id, { gain: 0.6 }));
    expect(store.undoStackLength).toBe(2);
    store.undo();
    expect(store.undoStackLength).toBe(1);
  });

  it("jumpTo lands on the state after entry i (history panel click-to-jump)", () => {
    const store = YDocStore.fromDocument(createProjectFromTemplate("house"));
    const drum = store.doc.tracks.find((t) => t.kind === "drum") as DrumTrack;
    const gains: number[] = [];
    for (let i = 0; i < 3; i++) {
      store.execute(setPadParams(store.doc, drum.pads[i].id, { gain: 0.3 + i * 0.1 }));
      gains.push(store.doc.tracks.find((t) => t.kind === "drum")!.pads[i].gain);
    }
    // Land on the state after entry 0: pad0 = 0.3, pads 1..2 untouched.
    store.jumpTo(0);
    const after = store.doc.tracks.find((t) => t.kind === "drum")!;
    expect(after.pads[0].gain).toBe(0.3);
    expect(after.pads[1].gain).toBe(drum.pads[1].gain);
    expect(after.pads[2].gain).toBe(drum.pads[2].gain);
    // And back to the newest state.
    store.jumpTo(2);
    const latest = store.doc.tracks.find((t) => t.kind === "drum")!;
    expect(latest.pads[2].gain).toBe(gains[2]);
  });

  it("replaceDoc clears the saved watermark (defect 4.2 parity with ProjectStore)", () => {
    const store = YDocStore.fromDocument(createProjectFromTemplate("house"));
    store.setSaveStatus("saved");
    expect(store.lastSavedAt).not.toBeNull();
    store.replaceDoc(createProjectFromTemplate("techno"));
    expect(store.lastSavedAt).toBeNull();
    expect(store.saveStatus).toBe("dirty");
  });
});
