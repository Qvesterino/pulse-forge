import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { YDocStore } from "../src/collab/YDocStore";
import { decodeShareCode, encodeShareCode } from "../src/export/shareCode";
import { setBpm, setProjectName } from "../src/commands/commands";

/**
 * Instant Jam seeding mechanics. A jam link (?import=<code>&collab=<room>)
 * makes every peer decode the SAME share code. Since the deferred
 * seed-vs-adopt change (YDocStore.empty + openProject's onFirstSync), a
 * joining peer only writes its initial doc into an EMPTY room; a room that
 * already lives is adopted. These tests pin the invariants:
 *   1. Identical seeds mesh-merge to one converged document.
 *   2. A late joiner adopts the room instead of clobbering a post-seed edit.
 *   3. Concurrent edits on both sides survive the merge.
 */

function encodeDecode(doc: ReturnType<typeof createProjectFromTemplate>) {
  const code = encodeShareCode(doc);
  const decoded = decodeShareCode(code);
  if (!decoded) throw new Error("jam code unreadable");
  return decoded;
}

describe("instant jam seeding", () => {
  it("N peers seeding the same decoded beat converge to one document", () => {
    const beat = { ...createProjectFromTemplate("house"), name: "Gallery Beat" };
    const decoded = encodeDecode(beat);
    const peers = [0, 1, 2].map(() => YDocStore.fromDocument(decoded));

    const updates = peers.map((p) => Y.encodeStateAsUpdate(p.yDocRef));
    peers.forEach((a, i) => {
      updates.forEach((u, j) => {
        if (i !== j) Y.applyUpdate(a.yDocRef, u);
      });
    });

    const docs = peers.map((p) => p.doc);
    for (const d of docs) {
      expect(d.id).toBe(decoded.id);
      expect(d.name).toBe("Gallery Beat");
      expect(d.tracks.length).toBe(decoded.tracks.length);
    }
    expect(new Set(docs.map((d) => JSON.stringify(d.tracks))).size).toBe(1);
  });

  it("empty + hydrate seeds the room; adoptRemote pulls the room state", () => {
    const beat = { ...createProjectFromTemplate("house"), name: "Gallery Beat", bpm: 128 };
    const decoded = encodeDecode(beat);

    // Initiator: empty store + hydrate (the deferred seed path).
    const initiator = YDocStore.empty({ ...decoded, bpm: 120 }); // fallback ≠ seed
    initiator.hydrate(decoded);
    expect(initiator.doc.name).toBe("Gallery Beat");
    expect(initiator.doc.bpm).toBe(128);

    // A joiner with a stale fallback adopts the room state.
    const joiner = YDocStore.empty({ ...decoded, bpm: 90 });
    expect(joiner.doc.bpm).toBe(90); // fallback visible pre-sync
    Y.applyUpdate(joiner.yDocRef, Y.encodeStateAsUpdate(initiator.yDocRef));
    joiner.adoptRemote();
    expect(joiner.doc.name).toBe("Gallery Beat");
    expect(joiner.doc.bpm).toBe(128);
  });

  it("a late joiner on the deferred path cannot clobber a post-seed edit", () => {
    const decoded = encodeDecode(createProjectFromTemplate("house"));
    // Initiator seeds an empty room, then tweaks the jam.
    const initiator = YDocStore.empty(decoded);
    initiator.hydrate(decoded);
    initiator.execute(setBpm(initiator.doc, 141));

    // A late joiner opens the same jam link — deferred seeding: the room has
    // content (hasRemote = true), so the joiner ADOPTS and never writes its
    // own initial doc. The pre-seed edit survives by construction.
    const late = YDocStore.empty(decoded);
    Y.applyUpdate(late.yDocRef, Y.encodeStateAsUpdate(initiator.yDocRef));
    late.adoptRemote();
    expect(late.doc.bpm).toBe(141);

    // The initiator is untouched by the joiner (nothing was written back).
    expect(initiator.doc.bpm).toBe(141);
  });

  it("concurrent edits after adoption both survive the merge", () => {
    // Real jam shape: the initiator seeds; the joiner adopts and never
    // re-seeds (openProject's deferred seed-vs-adopt). A full identical
    // re-seed from the joiner would be an LWW coin-flip against concurrent
    // edits — which is exactly why joiners must not re-seed.
    const decoded = encodeDecode(createProjectFromTemplate("house"));
    const a = YDocStore.empty(decoded);
    a.hydrate(decoded); // initiator seeds the empty room
    const b = YDocStore.empty(decoded);
    Y.applyUpdate(b.yDocRef, Y.encodeStateAsUpdate(a.yDocRef));
    b.adoptRemote(); // joiner adopts the room

    a.execute(setBpm(a.doc, 132));
    b.execute(setProjectName(b.doc, "Renamed Jam"));
    Y.applyUpdate(a.yDocRef, Y.encodeStateAsUpdate(b.yDocRef));
    Y.applyUpdate(b.yDocRef, Y.encodeStateAsUpdate(a.yDocRef));
    expect(a.doc.bpm).toBe(132);
    expect(a.doc.name).toBe("Renamed Jam");
    expect(b.doc.bpm).toBe(132);
    expect(b.doc.name).toBe("Renamed Jam");
  });
});
