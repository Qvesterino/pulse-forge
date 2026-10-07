import { describe, expect, it } from "vitest";
import { addStemTracksCommand } from "../src/commands/stemTracks";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { AudioClip } from "../src/project-model/types";

/**
 * STEM TRACK IMPORT — the separation→mastering last mile: stem buffers
 * become named lanes (Vocals/Drums/Bass/Other) grouped into one STEMS bus,
 * one undoable snapshot. After this, kyx_master op:stems matches the lanes
 * by role name and masters them.
 */

function stemDoc() {
  return createProjectFromTemplate("house");
}

describe("addStemTracksCommand", () => {
  it("creates role-named lanes in a STEMS bus with a full-length clip each — ONE snapshot", () => {
    const doc = stemDoc();
    const command = addStemTracksCommand(doc, [
      { role: "vocals", bufferId: "buf-v", durationSec: 15.2 },
      { role: "drums", bufferId: "buf-d", durationSec: 14.9 },
      { role: "bass", bufferId: "buf-b", durationSec: 15.0 },
      { role: "other", bufferId: "buf-o", durationSec: 15.1 },
    ]);
    const next = command.execute(doc);
    const bus = next.tracks.find((t) => t.kind === "group" && t.name === "STEMS");
    expect(bus).toBeTruthy();
    for (const role of ["Vocals", "Drums", "Bass", "Other"]) {
      // The house template may carry same-named lanes — the stem lane is the
      // SAMPLER instrument one we appended last.
      const lane = next.tracks.filter((t) => t.name === role && (t as { kind?: string }).kind === "instrument").at(-1);
      expect(lane, role).toBeTruthy();
      expect(lane && "groupId" in lane ? lane.groupId : undefined).toBe(bus!.id);
    }
    // Clips: one per stem, at bar 0, covering the buffer (15.2 s at 124 BPM
    // ≈ 7.9 bars → rounded up to 8).
    const clips = next.arrangement.audioClips ?? [];
    const byBuffer = new Map(clips.map((c: AudioClip) => [c.bufferId, c]));
    expect(byBuffer.get("buf-v")!.startBar).toBe(0);
    expect(byBuffer.get("buf-v")!.lengthBars).toBe(8);
    expect(byBuffer.get("buf-d")!.lengthBars).toBeGreaterThanOrEqual(7);
    expect(clips.filter((c) => ["buf-v", "buf-d", "buf-b", "buf-o"].includes(c.bufferId)).length).toBe(4);
    // ONE undoable step.
    const undone = command.undo(next);
    expect(undone.tracks.find((t) => t.name === "STEMS")).toBeUndefined();
    expect(undone.tracks.find((t) => t.name === "Vocals")).toBeUndefined();
    expect((undone.arrangement.audioClips ?? []).filter((c) => c.bufferId === "buf-v").length).toBe(0);
  });

  it("validates loudly: no stems, missing bufferId, non-finite duration", () => {
    const doc = stemDoc();
    expect(() => addStemTracksCommand(doc, [])).toThrow(/no stems/);
    expect(() => addStemTracksCommand(doc, [{ role: "bass", bufferId: "", durationSec: 5 }])).toThrow(/bufferId/);
    expect(() => addStemTracksCommand(doc, [{ role: "bass", bufferId: "b", durationSec: Number.NaN }])).toThrow(
      /non-finite/,
    );
  });
});
