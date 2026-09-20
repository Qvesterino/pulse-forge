import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyEffectIntentProposal, parseEffectIntent, planEffectIntent } from "../src/effect-intent";
import { setProjectName } from "../src/commands/commands";
import { YDocStore } from "../src/collab/YDocStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { EffectInstance, ProjectDocument } from "../src/project-model/types";
import { ProjectStore } from "../src/store/ProjectStore";

function createReverbProject(): { doc: ProjectDocument; trackId: string; fxId: string } {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((candidate) => candidate.kind === "instrument")!;
  const effect: EffectInstance = {
    id: "effect-intent-reverb",
    type: "reverb",
    bypassed: false,
    params: { mix: 0.3, decay: 1.8, tone: 6000 },
  };
  track.effects = [effect];
  return { doc, trackId: track.id, fxId: effect.id };
}

function buildProposal(doc: ProjectDocument, trackId: string, fxId: string) {
  const parsed = parseEffectIntent("more space");
  if (parsed.status !== "ready") throw new Error("Expected the supported space intent to parse");
  const planned = planEffectIntent(doc, { trackId, fxId, effectType: "reverb" }, parsed.intent);
  if (planned.status !== "ready") throw new Error("Expected a reviewed Reverb proposal");
  return planned.proposal;
}

function effectFrom(doc: ProjectDocument, trackId: string, fxId: string): EffectInstance {
  const effect = doc.tracks.find((track) => track.id === trackId)?.effects.find((candidate) => candidate.id === fxId);
  if (!effect) throw new Error("Expected the Reverb target to remain present");
  return effect;
}

describe("Effect Intent apply through real project stores", () => {
  it("creates one ordinary ProjectStore undo entry with exact undo and redo", () => {
    const { doc, trackId, fxId } = createReverbProject();
    const store = new ProjectStore(doc);
    const before = structuredClone(store.doc);
    const proposal = buildProposal(store.doc, trackId, fxId);

    store.execute(applyEffectIntentProposal(store.doc, proposal));
    const after = structuredClone(store.doc);
    expect(store.undoStackLength).toBe(1);
    expect(effectFrom(store.doc, trackId, fxId).params).not.toEqual(effectFrom(before, trackId, fxId).params);

    store.undo();
    expect(store.doc).toEqual(before);
    store.redo();
    expect(store.doc).toEqual(after);
  });

  it("syncs through YDocStore, preserves an unrelated peer edit, and scopes undo/redo to the proposal", () => {
    const { doc, trackId, fxId } = createReverbProject();
    const local = YDocStore.fromDocument(doc);
    const peer = new YDocStore(new Y.Doc());
    const sync = (from: YDocStore, to: YDocStore) => Y.applyUpdate(to.yDocRef, Y.encodeStateAsUpdate(from.yDocRef));
    sync(local, peer);

    // A remote project-name edit arrives after the author opens the FX task.
    peer.execute(setProjectName(peer.doc, "Peer title"));
    sync(peer, local);
    sync(local, peer);
    const proposal = buildProposal(local.doc, trackId, fxId);
    const beforeParams = { ...effectFrom(local.doc, trackId, fxId).params };

    local.execute(applyEffectIntentProposal(local.doc, proposal));
    expect(local.undoStackLength).toBe(1);
    expect(effectFrom(local.doc, trackId, fxId).params).not.toEqual(beforeParams);
    expect(local.doc.name).toBe("Peer title");
    sync(local, peer);
    expect(effectFrom(peer.doc, trackId, fxId).params).toEqual(effectFrom(local.doc, trackId, fxId).params);
    expect(peer.doc.name).toBe("Peer title");

    local.undo();
    expect(effectFrom(local.doc, trackId, fxId).params).toEqual(beforeParams);
    expect(local.doc.name).toBe("Peer title");
    sync(local, peer);
    expect(effectFrom(peer.doc, trackId, fxId).params).toEqual(beforeParams);
    expect(peer.doc.name).toBe("Peer title");

    local.redo();
    expect(effectFrom(local.doc, trackId, fxId).params).not.toEqual(beforeParams);
    sync(local, peer);
    expect(effectFrom(peer.doc, trackId, fxId).params).toEqual(effectFrom(local.doc, trackId, fxId).params);
    expect(peer.doc.name).toBe("Peer title");
  });
});
