import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  addEffectToTracks,
  clearAllMutes,
  clearAllSolos,
  removeEffectFromTracks,
  setEffectBypassOnTracks,
} from "../src/commands/commands";
import type { DrumTrack, ProjectDocument } from "../src/project-model/types";

function docWithTracks(): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  // Ensure at least three drum/instrument tracks exist with distinct ids.
  const first = doc.tracks[0] as DrumTrack;
  first.solo = true;
  (doc.tracks[1] as DrumTrack).solo = true;
  (doc.tracks[2] as DrumTrack).mute = true;
  return doc;
}

describe("mixer batch workflow commands", () => {
  it("setEffectBypassOnTracks flips every instance of the type in ONE command", () => {
    const doc = docWithTracks();
    const drum = doc.tracks[0] as DrumTrack;
    drum.effects = [
      { id: "fx-eq-1", type: "eq", bypassed: false, params: {} },
      { id: "fx-delay-1", type: "delay", bypassed: false, params: {} },
    ];
    (doc.tracks[1] as DrumTrack).effects = [{ id: "fx-eq-2", type: "eq", bypassed: false, params: {} }];

    const cmd = setEffectBypassOnTracks(doc, [doc.tracks[0].id, doc.tracks[1].id], "eq", true);
    const next = cmd.execute(doc);
    expect(((next.tracks[0] as DrumTrack).effects[0] as { bypassed: boolean }).bypassed).toBe(true);
    expect(((next.tracks[1] as DrumTrack).effects[0] as { bypassed: boolean }).bypassed).toBe(true);
    // Non-matching types untouched.
    expect(((next.tracks[0] as DrumTrack).effects[1] as { bypassed: boolean }).bypassed).toBe(false);
    // One undo restores every strip.
    const undone = cmd.undo(next);
    expect(((undone.tracks[0] as DrumTrack).effects[0] as { bypassed: boolean }).bypassed).toBe(false);
    expect(((undone.tracks[1] as DrumTrack).effects[0] as { bypassed: boolean }).bypassed).toBe(false);
    // No instances → explicit error, never a silent no-op.
    expect(() => setEffectBypassOnTracks(doc, [doc.tracks[2].id], "eq", true)).toThrow(/No EQ/);
  });

  it("removeEffectFromTracks strips only the given type, one undo restores all", () => {
    const doc = docWithTracks();
    (doc.tracks[0] as DrumTrack).effects = [
      { id: "fx-eq-1", type: "eq", bypassed: false, params: {} },
      { id: "fx-delay-1", type: "delay", bypassed: false, params: {} },
    ];
    (doc.tracks[1] as DrumTrack).effects = [{ id: "fx-eq-2", type: "eq", bypassed: false, params: {} }];

    const cmd = removeEffectFromTracks(doc, [doc.tracks[0].id, doc.tracks[1].id], "eq");
    const next = cmd.execute(doc);
    expect((next.tracks[0] as DrumTrack).effects.map((f) => f.id)).toEqual(["fx-delay-1"]);
    expect((next.tracks[1] as DrumTrack).effects).toHaveLength(0);
    const undone = cmd.undo(next);
    expect((undone.tracks[0] as DrumTrack).effects).toHaveLength(2);
    expect((undone.tracks[1] as DrumTrack).effects).toHaveLength(1);
    expect(() => removeEffectFromTracks(doc, [doc.tracks[2].id], "eq")).toThrow(/No EQ/);
  });

  it("clearAllSolos / clearAllMutes reset every strip in one undo step", () => {
    const doc = docWithTracks(); // 2 soloed, 1 muted
    const soloCmd = clearAllSolos(doc);
    const noSolo = soloCmd.execute(doc);
    expect(noSolo.tracks.every((t) => !t.solo)).toBe(true);
    expect(soloCmd.undo(noSolo).tracks.filter((t) => t.solo)).toHaveLength(2);

    const muteCmd = clearAllMutes(doc);
    const noMute = muteCmd.execute(doc);
    expect(noMute.tracks.every((t) => !t.mute)).toBe(true);

    // Nothing to clear → explicit error (run the clear once, then again).
    const clean = clearAllSolos(doc).execute(doc);
    expect(() => clearAllSolos(clean)).toThrow(/solo/);
  });

  it("batch add + batch bypass + batch remove compose as independent undo steps", () => {
    const doc = docWithTracks();
    const ids = [doc.tracks[0].id, doc.tracks[1].id];
    const add = addEffectToTracks(doc, ids, "chorus");
    const afterAdd = add.execute(doc);
    const bypass = setEffectBypassOnTracks(afterAdd, ids, "chorus", true);
    const afterBypass = bypass.execute(afterAdd);
    const remove = removeEffectFromTracks(afterBypass, ids, "chorus");
    const afterRemove = remove.execute(afterBypass);
    expect((afterRemove.tracks[0] as DrumTrack).effects.some((f) => f.type === "chorus")).toBe(false);
    // Undo the removal → choruses return BYPASSED (state of their step).
    const stepBack = remove.undo(afterRemove);
    expect((stepBack.tracks[0] as DrumTrack).effects.find((f) => f.type === "chorus")?.bypassed).toBe(true);
  });
});
