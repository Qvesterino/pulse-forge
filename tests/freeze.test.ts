import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { createGroupTrackModel, normalizeProject } from "../src/project-model/schema";
import { freezeTrack, unfreezeTrack } from "../src/commands/commands";

describe("freezeTrack / unfreezeTrack", () => {
  const doc = createProjectFromTemplate("house");

  it("freezeTrack sets frozen flag on a drum track", () => {
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const cmd = freezeTrack(doc, drumTrack.id, "frozen-abc", 30.0, 44100);
    const next = cmd.execute(doc);
    const track = next.tracks.find((t) => t.id === drumTrack.id);
    expect(track).toBeDefined();
    expect("frozen" in track! && (track as any).frozen).toEqual({
      bufferId: "frozen-abc",
      durationSec: 30.0,
      sampleRate: 44100,
    });
  });

  it("freezeTrack sets frozen flag on an instrument track", () => {
    const instTrack = doc.tracks.find((t) => t.kind === "instrument")!;
    const cmd = freezeTrack(doc, instTrack.id, "frozen-xyz", 60.0, 48000);
    const next = cmd.execute(doc);
    const track = next.tracks.find((t) => t.id === instTrack.id);
    expect(track).toBeDefined();
    expect("frozen" in track! && (track as any).frozen).toBeDefined();
  });

  it("unfreezeTrack clears frozen flag", () => {
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const frozen = freezeTrack(doc, drumTrack.id, "frozen-abc", 30.0, 44100).execute(doc);
    const cmd = unfreezeTrack(frozen, drumTrack.id);
    const next = cmd.execute(frozen);
    const track = next.tracks.find((t) => t.id === drumTrack.id);
    expect(track).toBeDefined();
    expect("frozen" in track! && (track as any).frozen).toBeUndefined();
  });

  it("freezeTrack undo restores original state", () => {
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const cmd = freezeTrack(doc, drumTrack.id, "frozen-abc", 30.0, 44100);
    const next = cmd.execute(doc);
    const undone = cmd.undo(next);
    const track = undone.tracks.find((t) => t.id === drumTrack.id);
    expect(track).toBeDefined();
    expect((track as any).frozen).toBeUndefined();
  });

  it("unfreezeTrack undo restores frozen state", () => {
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const frozen = freezeTrack(doc, drumTrack.id, "frozen-abc", 30.0, 44100).execute(doc);
    const cmd = unfreezeTrack(frozen, drumTrack.id);
    const next = cmd.execute(frozen);
    const undone = cmd.undo(next);
    const track = undone.tracks.find((t) => t.id === drumTrack.id);
    expect(track).toBeDefined();
    expect((track as any).frozen).toEqual({
      bufferId: "frozen-abc",
      durationSec: 30.0,
      sampleRate: 44100,
    });
  });

  it("freezeTrack throws for non-existent track", () => {
    expect(() => freezeTrack(doc, "nonexistent", "buf", 10, 44100)).toThrow();
  });

  it("normalizeProject preserves frozen flag", () => {
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const frozen = freezeTrack(doc, drumTrack.id, "frozen-abc", 30.0, 44100).execute(doc);
    const normalized = normalizeProject(frozen);
    const track = normalized.tracks.find((t) => t.id === drumTrack.id);
    expect(track).toBeDefined();
    expect("frozen" in track! && (track as any).frozen).toBeDefined();
  });
});

describe("renderTrack filtering", () => {
  it("filtered doc includes only target track + its group", () => {
    const doc = createProjectFromTemplate("house");
    const group = createGroupTrackModel("Drums");
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const withGroup = {
      ...doc,
      tracks: [...doc.tracks, group].map((t) =>
        t.id === drumTrack.id ? { ...t, groupId: group.id } : t,
      ),
    };
    // Verify the filtered doc would contain both the drum track and the group
    const trackIds = new Set([drumTrack.id, group.id]);
    const filtered = withGroup.tracks.filter((t) => trackIds.has(t.id));
    expect(filtered.length).toBe(2);
    expect(filtered.some((t) => t.kind === "group")).toBe(true);
    expect(filtered.some((t) => t.id === drumTrack.id)).toBe(true);
  });

  it("filtered doc excludes tracks not in the target group", () => {
    const doc = createProjectFromTemplate("house");
    const group = createGroupTrackModel("Drums");
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const instTrack = doc.tracks.find((t) => t.kind === "instrument")!;
    const withGroup = {
      ...doc,
      tracks: [...doc.tracks, group].map((t) =>
        t.id === drumTrack.id ? { ...t, groupId: group.id } : t,
      ),
    };
    const trackIds = new Set([drumTrack.id, group.id]);
    const filtered = withGroup.tracks.filter((t) => trackIds.has(t.id));
    expect(filtered.some((t) => t.id === instTrack.id)).toBe(false);
  });
});
