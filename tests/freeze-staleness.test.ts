import { beforeEach, describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import { freezeTrack, unfreezeTrack } from "../src/commands/freeze";
import { addMarker } from "../src/commands/markers";
import {
  canonicalJson,
  clearFreezeSignatures,
  forgetFreezeSignature,
  freezeSignature,
  freezeStaleness,
  hydrateFreezeSignatures,
  peekFreezeSignature,
  rememberFreezeSignature,
} from "../src/rendering/freezeSignature";

/**
 * WAVE 2/D — FREEZE STALENESS.
 *
 * The defect this pins: a frozen track keeps playing its rendered buffer while
 * the document accepts edits (inaudible until unfreeze), and the EXPORT
 * re-renders the frozen track instead of using the buffer. So after an edit
 * the user hears one thing and exports another, with nothing on screen saying
 * so. The signature is what makes that state detectable.
 */

beforeEach(() => {
  clearFreezeSignatures();
});

function newStore(): ProjectStore {
  return new ProjectStore(createDefaultProject());
}

function firstFreezableTrackId(store: ProjectStore): string {
  const track = store.doc.tracks.find((candidate) => candidate.kind !== "group");
  if (!track) throw new Error("fixture has no freezable track");
  return track.id;
}

describe("canonicalJson", () => {
  it("is order-independent for objects and order-sensitive for arrays", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ nested: { z: 1, a: [true, null] } })).toBe('{"nested":{"a":[true,null],"z":1}}');
    expect(canonicalJson({ skip: undefined, keep: 1 })).toBe('{"keep":1}');
  });
});

describe("freezeSignature", () => {
  it("ignores the frozen flag itself (the render does)", async () => {
    const store = newStore();
    const before = await freezeSignature(store.doc);
    expect(before).toMatch(/^[0-9a-f]{64}$/);

    store.execute(freezeTrack(store.doc, firstFreezableTrackId(store), "frozen-1", 4, 44100));
    expect(await freezeSignature(store.doc)).toBe(before);

    store.execute(unfreezeTrack(store.doc, firstFreezableTrackId(store)));
    expect(await freezeSignature(store.doc)).toBe(before);
  });

  it("changes when the project content changes", async () => {
    const store = newStore();
    const before = await freezeSignature(store.doc);
    store.execute(addMarker(store.doc, { tick: 0, name: "drop" }));
    const after = await freezeSignature(store.doc);
    expect(after).not.toBe(before);
  });

  it("memoizes per document version (one hash per edit, not per strip)", async () => {
    const store = newStore();
    const doc = store.doc;
    expect(freezeSignature(doc)).toBe(freezeSignature(doc));
  });
});

describe("freezeStaleness", () => {
  it("reports unknown without a remembered signature (never a guess)", async () => {
    const store = newStore();
    expect(await freezeStaleness(store.doc, "frozen-1")).toBe("unknown");
  });

  it("goes stale after an edit and fresh again after a re-freeze", async () => {
    const store = newStore();
    const trackId = firstFreezableTrackId(store);
    store.execute(freezeTrack(store.doc, trackId, "frozen-1", 4, 44100));
    rememberFreezeSignature("frozen-1", (await freezeSignature(store.doc))!);
    expect(await freezeStaleness(store.doc, "frozen-1")).toBe("fresh");

    store.execute(addMarker(store.doc, { tick: 960, name: "verse" }));
    expect(await freezeStaleness(store.doc, "frozen-1")).toBe("stale");

    // A re-freeze stamps the CURRENT document — the strip returns to fresh.
    rememberFreezeSignature("frozen-1", (await freezeSignature(store.doc))!);
    expect(await freezeStaleness(store.doc, "frozen-1")).toBe("fresh");
  });

  it("stays fresh when only the frozen flag changes again", async () => {
    const store = newStore();
    const trackId = firstFreezableTrackId(store);
    store.execute(freezeTrack(store.doc, trackId, "frozen-1", 4, 44100));
    rememberFreezeSignature("frozen-1", (await freezeSignature(store.doc))!);
    store.execute(unfreezeTrack(store.doc, trackId));
    expect(await freezeStaleness(store.doc, "frozen-1")).toBe("fresh");
  });
});

describe("signature registry", () => {
  it("hydrates persisted signatures and clears them", async () => {
    const repo = { listSignatures: async () => [{ id: "frozen-1", signature: "sig-1" }] };
    expect(await hydrateFreezeSignatures(repo)).toBe(1);
    expect(peekFreezeSignature("frozen-1")).toBe("sig-1");

    forgetFreezeSignature("frozen-1");
    expect(peekFreezeSignature("frozen-1")).toBeNull();

    await hydrateFreezeSignatures({ listSignatures: async () => [{ id: "frozen-2", signature: "" }] });
    expect(peekFreezeSignature("frozen-2")).toBeNull(); // empty signature is not a claim

    await hydrateFreezeSignatures({
      listSignatures: async () => {
        throw new Error("store unavailable");
      },
    });
    expect(peekFreezeSignature("frozen-2")).toBeNull();
  });
});
