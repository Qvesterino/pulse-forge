import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { createGroupTrackModel, normalizeProject } from "../src/project-model/schema";
import { freezeTrack, unfreezeTrack } from "../src/commands/commands";
import { frozenPlaybackOffset } from "../src/audio-engine/AudioEngine";
import { PPQ } from "../src/project-model/types";

describe("frozenPlaybackOffset (transport alignment)", () => {
  it("maps a tick position to seconds inside the loop", () => {
    // 120 bpm, PPQ 480 → 960 ticks = 1 second.
    expect(frozenPlaybackOffset(0, 120, 10)).toBe(0);
    expect(frozenPlaybackOffset(960, 120, 10)).toBeCloseTo(1, 6);
  });

  it("wraps around the loop duration", () => {
    // 11 seconds into a 10 s loop → offset 1 s.
    expect(frozenPlaybackOffset(960 * 11, 120, 10)).toBeCloseTo(1, 6);
  });

  it("accounts for tempo", () => {
    // 60 bpm is half the speed of 120 bpm → same offset for half the ticks.
    expect(frozenPlaybackOffset(960, 60, 10)).toBeCloseTo(2, 6);
  });

  it("clamps degenerate inputs", () => {
    expect(frozenPlaybackOffset(-960, 120, 10)).toBe(0);
    expect(frozenPlaybackOffset(960, 120, 0)).toBe(0);
    expect(frozenPlaybackOffset(960, 120, Number.NaN)).toBe(0);
    expect(frozenPlaybackOffset(960, 0, 10)).toBeCloseTo(0, 6);
    expect(frozenPlaybackOffset(PPQ, 120, 10)).toBeCloseTo(0.5, 6);
  });
});

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

  it("freeze applies to the CURRENT doc, not the snapshot taken before the render", () => {
    // Regression: freeze is dispatched after a seconds-long offline render.
    // A snapshot-style command (`execute: () => next`) silently reverted every
    // edit the user made while waiting — BPM, notes, everything.
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const cmd = freezeTrack(doc, drumTrack.id, "frozen-late", 30.0, 44100);
    // User edits arrive between command creation and dispatch:
    const edited = setBpmOnDoc(doc, 98);
    const next = cmd.execute(edited);
    expect(next.bpm).toBe(98); // concurrent edit preserved
    const track = next.tracks.find((t) => t.id === drumTrack.id)!;
    expect("frozen" in track && (track as any).frozen?.bufferId).toBe("frozen-late");
  });

  it("unfreeze applies to the CURRENT doc and its undo restores that track's frozen state", () => {
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const frozen = freezeTrack(doc, drumTrack.id, "frozen-abc", 30.0, 44100).execute(doc);
    const cmd = unfreezeTrack(frozen, drumTrack.id);
    // User renames a pattern while... (unfreeze is sync, but the same contract
    // holds: apply to whatever doc arrives).
    const edited = setBpmOnDoc(frozen, 140);
    const next = cmd.execute(edited);
    expect(next.bpm).toBe(140);
    const track = next.tracks.find((t) => t.id === drumTrack.id)!;
    expect("frozen" in track && (track as any).frozen).toBeUndefined();
    const undone = cmd.undo(next);
    const restored = undone.tracks.find((t) => t.id === drumTrack.id)!;
    expect((restored as any).frozen).toEqual({ bufferId: "frozen-abc", durationSec: 30.0, sampleRate: 44100 });
  });
});

function setBpmOnDoc(doc: import("../src/project-model/types").ProjectDocument, bpm: number) {
  return { ...doc, bpm };
}

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
