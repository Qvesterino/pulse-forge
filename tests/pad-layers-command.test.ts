import { describe, expect, it } from "vitest";
import { setPadParams } from "../src/commands/commands";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { FACTORY_SNARE_RR } from "../src/sample-library/velocity-layers";
import type { DrumTrack, ProjectDocument } from "../src/project-model/types";

/**
 * `setPadParams` is the only write path for pad layer sets (the UI's pad
 * editor and the undo baseline both go through it). The subtle contract is
 * the DELETE case: `{ layers: undefined }` must clear the field on execute
 * and on undo, which a plain object spread cannot express because
 * Object.entries drops undefined values.
 */

function doc(): { doc: ProjectDocument; padId: string } {
  const base = createProjectFromTemplate("empty");
  const drum = base.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
  return { doc: base, padId: drum.pads[4].id };
}

function padOf(doc: ProjectDocument, padId: string) {
  return (doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!).pads.find((p) => p.id === padId)!;
}

describe("setPadParams — pad layer sets", () => {
  it("adds a layer set and undo removes it again", () => {
    const { doc: base, padId } = doc();
    const command = setPadParams(base, padId, { layers: FACTORY_SNARE_RR });
    const applied = command.execute(base);
    expect(padOf(applied, padId).layers).toEqual(FACTORY_SNARE_RR);

    const undone = command.undo(applied);
    expect(padOf(undone, padId).layers).toBeUndefined();
    // Undo restores the WHOLE pad, not just the field.
    expect(padOf(undone, padId)).toEqual(padOf(base, padId));
  });

  it("explicitly clearing an existing set works in both directions", () => {
    const { doc: base, padId } = doc();
    const seeded = setPadParams(base, padId, { layers: FACTORY_SNARE_RR }).execute(base);
    const clear = setPadParams(seeded, padId, { layers: undefined });
    const cleared = clear.execute(seeded);
    expect(padOf(cleared, padId).layers).toBeUndefined();
    const restored = clear.undo(cleared);
    expect(padOf(restored, padId).layers).toEqual(FACTORY_SNARE_RR);
  });

  it("does not disturb other pad fields when only layers change", () => {
    const { doc: base, padId } = doc();
    const before = padOf(base, padId);
    const applied = setPadParams(base, padId, { layers: FACTORY_SNARE_RR }).execute(base);
    const after = padOf(applied, padId);
    expect(after.gain).toBe(before.gain);
    expect(after.pitch).toBe(before.pitch);
    expect(after.assetId).toBe(before.assetId);
    expect(after.chokeGroup).toBe(before.chokeGroup);
  });

  it("keeps layers through a normalize round-trip (persist → reload)", async () => {
    const { doc: base, padId } = doc();
    const { normalizeProject } = await import("../src/project-model/schema");
    const applied = setPadParams(base, padId, { layers: FACTORY_SNARE_RR }).execute(base);
    const reloaded = normalizeProject(JSON.parse(JSON.stringify(applied)) as ProjectDocument);
    expect(padOf(reloaded, padId).layers).toEqual(FACTORY_SNARE_RR);
  });
});
