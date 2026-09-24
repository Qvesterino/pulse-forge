import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { projectToYDoc, yDocToProject } from "../src/collab/YDocAdapter";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * GOAL 05 — YDocAdapter drift pin.
 *
 * The Y.Doc codec is the SECOND ProjectDocument serialization path (besides
 * schema.ts) and is hand-maintained: scalar mirror lists, per-entity Y types
 * and JSON blobs must all be kept in lockstep with the model, or fields
 * silently vanish for collab peers (three such episodes are documented
 * in-file: audioClips, generation/assist, master keys).
 *
 * This pin has two nets:
 *  1. COMPILE-TIME: `ALL_TOP_LEVEL_KEYS` must enumerate every
 *     `keyof ProjectDocument` — adding a model key without extending the
 *     codec + this file breaks `tsc --noEmit`.
 *  2. RUNTIME: a rich, fully normalized template doc must round-trip
 *     `projectToYDoc → yDocToProject` with every present top-level key
 *     preserved and deep-equal values.
 */

const ALL_TOP_LEVEL_KEYS: Record<keyof ProjectDocument, true> = {
  schemaVersion: true,
  id: true,
  name: true,
  bpm: true,
  timeSignature: true,
  key: true,
  tags: true,
  lineage: true,
  tracks: true,
  patterns: true,
  activePatternId: true,
  scenes: true,
  arrangement: true,
  markers: true,
  sceneAutomation: true,
  automation: true,
  lfos: true,
  macros: true,
  returns: true,
  master: true,
  groove: true,
  midi: true,
  createdAt: true,
  updatedAt: true,
};

function roundTrip(doc: ProjectDocument): ProjectDocument {
  const yDoc = new Y.Doc();
  const yMap = yDoc.getMap("project");
  projectToYDoc(doc, yMap);
  return yDocToProject(yMap);
}

describe("YDocAdapter drift pin (GOAL 05)", () => {
  it("round-trips the richest stock template deep-equal and key-complete", () => {
    const doc = normalizeProject(createProjectFromTemplate("drill"));
    const restored = roundTrip(doc);

    // Every top-level key present in the doc survives the round trip.
    for (const key of Object.keys(ALL_TOP_LEVEL_KEYS)) {
      if ((doc as unknown as Record<string, unknown>)[key] !== undefined) {
        expect(key in restored, `top-level key lost in Y.Doc round-trip: ${key}`).toBe(true);
      }
    }
    expect(restored).toEqual(doc);
  });

  it("survives a second apply (idempotent targeted diff)", () => {
    const doc = normalizeProject(createProjectFromTemplate("drill"));
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    applyAgain(doc, yMap);
    expect(yDocToProject(yMap)).toEqual(roundTrip(doc));
  });

  it("round-trips the Remix-DNA lineage link (parent/root/depth survive collab)", () => {
    const doc = normalizeProject({
      ...createProjectFromTemplate("drill"),
      lineage: { parentId: "project-parent", rootId: "project-root", depth: 2, prompt: "dark trap 140", seed: "seed-1" },
    });
    const restored = roundTrip(doc);
    expect(restored.lineage).toEqual(doc.lineage);
  });

  it("preserves every master/track/pad scalar key (the historical silent-loss class)", () => {
    const doc = normalizeProject(createProjectFromTemplate("drill"));
    const restored = roundTrip(doc);

    for (const key of Object.keys(doc.master)) {
      expect(key in restored.master, `master scalar lost: ${key}`).toBe(true);
      expect(restored.master[key as keyof typeof restored.master]).toEqual(doc.master[key as keyof typeof doc.master]);
    }
    for (const track of doc.tracks) {
      const restoredTrack = restored.tracks.find((t) => t.id === track.id);
      expect(restoredTrack, `track dropped: ${track.id}`).toBeDefined();
      for (const key of Object.keys(track)) {
        expect(key in (restoredTrack ?? {}), `track scalar lost (${track.kind}): ${key}`).toBe(true);
      }
      const restoredPads = restoredTrack !== undefined && restoredTrack.kind === "drum" ? restoredTrack.pads : [];
      for (const pad of track.kind === "drum" ? track.pads : []) {
        const restoredPad = restoredPads.find((p) => p.id === pad.id);
        expect(restoredPad, `pad dropped: ${track.id}/${pad.id}`).toBeDefined();
        for (const key of Object.keys(pad)) {
          expect(key in (restoredPad ?? {}), `pad scalar lost (${track.id}/${pad.id}): ${key}`).toBe(true);
        }
      }
    }
  });
});

function applyAgain(doc: ProjectDocument, yMap: Y.Map<unknown>): void {
  // Re-apply the same doc through the targeted diff path — must be a no-op.
  projectToYDoc(doc, yMap);
}
