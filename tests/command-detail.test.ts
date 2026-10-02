import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import { addEffect, deleteTrack, removeEffect } from "../src/commands/commands";

/**
 * Consequence notes (Command.detail): silent cleanups a command performs
 * beyond its label surface in the command toast. Without this channel a
 * user who deletes an effect or track never learns that dangling
 * automation/modulation references were cleaned up on their behalf.
 */
describe("Command.detail — consequence notes", () => {
  it("removeEffect reports dangling automation references it cleaned", () => {
    const doc = createDefaultProject();
    const trackId = doc.tracks[0].id;
    const fxId = "fx-detail-test";
    const withFx = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === trackId ? { ...t, effects: [...(t.effects ?? []), { id: fxId, type: "eq" as const, bypassed: false, params: {} }] } : t,
      ),
      // A dangling automation lane + LFO pointing at the effect.
      automation: [
        { id: "lane-1", target: { kind: "fxParam" as const, trackId, fxId, paramId: "hpFreq" }, points: [] },
      ],
      lfos: [{ id: "lfo-1", trackId, target: { kind: "fxParam" as const, trackId, fxId, paramId: "hpFreq" }, rate: 1 }],
    };
    const command = removeEffect(withFx, trackId, fxId);
    expect(command.detail).toBe("2 automation/modulation references cleaned up");
  });

  it("removeEffect without dangling references carries no detail", () => {
    const command = removeEffect(createDefaultProject(), "nope", "nope");
    // Stale id — silent no-op command, no detail.
    expect(command.detail).toBeUndefined();
  });

  it("deleteTrack reports the automation lanes it cleaned", () => {
    const doc = createDefaultProject();
    const trackId = doc.tracks[0].id;
    const withLane = {
      ...doc,
      automation: [
        { id: "lane-t", target: { kind: "volume" as const, trackId }, points: [] },
      ],
    };
    const command = deleteTrack(withLane, trackId);
    // The template itself carries additional references on the track — the
    // exact count is template-dependent, the consequence note is not.
    expect(command.detail).toBeDefined();
    expect(command.detail).toContain("automation/modulation reference");
  });

  it("ProjectStore surfaces lastCommandDetail for the toast", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    const fxId = "fx-detail-store";
    const withFx = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === trackId ? { ...t, effects: [...(t.effects ?? []), { id: fxId, type: "eq" as const, bypassed: false, params: {} }] } : t,
      ),
      automation: [
        { id: "lane-2", target: { kind: "fxParam" as const, trackId, fxId, paramId: "hpFreq" }, points: [] },
      ],
    };
    const store2 = new ProjectStore(withFx);
    store2.execute(removeEffect(store2.doc, trackId, fxId));
    expect(store2.lastCommandLabel).toContain("Remove");
    expect(store2.lastCommandDetail).toBe("1 automation/modulation reference cleaned up");
    // A command without a consequence clears the detail (the toast goes
    // single-line again).
    store2.execute(addEffect(store2.doc, trackId, "reverb"));
    expect(store2.lastCommandDetail).toBeNull();
  });
});
