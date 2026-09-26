import { describe, expect, it } from "vitest";
import {
  addArrangementClip,
  addAudioTakeClip,
  compAudioTakeRange,
  setActiveAudioTake,
  setSceneBpm,
} from "../src/commands/commands";
import { audioClipsForPlayback } from "../src/project-model/audio-takes";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { computeRenderTicks } from "../src/rendering/renderer";
import { audioTakeAuditionStartOffsetSec, createAudioTakeAuditionDoc } from "../src/rendering/take-audition";
import { BAR_TICKS, STEP_TICKS } from "../src/project-model/types";
import { migrateProject, normalizeProject, SCHEMA_VERSION } from "../src/project-model/schema";

describe("non-destructive audio take groups", () => {
  it("builds an isolated audition document without mutating the project", () => {
    const doc = createProjectFromTemplate("empty");
    const track = doc.tracks[0];
    const scene = doc.scenes[0];
    if (!track || !scene) throw new Error("empty project fixture missing track or scene");
    const atSceneTempo = setSceneBpm(doc, scene.id, 90).execute(doc);
    const arranged = {
      ...atSceneTempo,
      arrangement: {
        ...atSceneTempo.arrangement,
        clips: [{ id: "audition-tempo-clip", sceneId: scene.id, startBar: 0, lengthBars: 4 }],
      },
    };
    const first = addAudioTakeClip(arranged, "audition-group", "take-a", track.id, "audio.a", 0, 1).execute(arranged);
    const withAlternates = addAudioTakeClip(first, "audition-group", "take-b", track.id, "audio.b", 1, 1).execute(
      first,
    );

    const audition = createAudioTakeAuditionDoc(withAlternates, "audition-group", "take-b");

    expect(audition).not.toBe(withAlternates);
    expect(audition.arrangement.audioClips?.map((clip) => clip.bufferId)).toEqual(["audio.b"]);
    expect(audition.arrangement.takeGroups?.[0]?.activeTakeId).toBe("take-b");
    expect(audition.arrangement.clips).toHaveLength(1);
    expect(audition.arrangement.clips[0]?.lengthBars).toBe(2);
    expect(audioTakeAuditionStartOffsetSec(withAlternates, "audition-group", "take-b")).toBeCloseTo((60 / 90) * 4, 8);
    expect(audition.markers).toEqual([]);
    expect(audition.tracks.find((candidate) => candidate.id === track.id)?.mute).toBe(false);
    expect(
      audition.patterns.every(
        (pattern) => Object.keys(pattern.rows).length === 0 && Object.keys(pattern.notes).length === 0,
      ),
    ).toBe(true);
    expect(withAlternates.arrangement.audioClips).toHaveLength(2);
    expect(withAlternates.arrangement.takeGroups?.[0]?.activeTakeId).not.toBe("take-b");
  });

  it("adds alternate passes and switches the active take through undoable commands", () => {
    const doc = createProjectFromTemplate("empty");
    const track = doc.tracks[0];
    if (!track) throw new Error("empty project track fixture missing");

    const firstCommand = addAudioTakeClip(doc, "take-group-1", "take-1", track.id, "audio.take-1", 0, 1);
    const first = firstCommand.execute(doc);
    const secondCommand = addAudioTakeClip(first, "take-group-1", "take-2", track.id, "audio.take-2", 0, 1);
    const twoTakes = secondCommand.execute(first);
    expect(twoTakes.arrangement.takeGroups).toEqual([
      { id: "take-group-1", trackId: track.id, activeTakeId: "take-1" },
    ]);
    expect(twoTakes.arrangement.audioClips).toHaveLength(2);
    expect(audioClipsForPlayback(twoTakes.arrangement).map((clip) => clip.bufferId)).toEqual(["audio.take-1"]);

    const selectCommand = setActiveAudioTake(twoTakes, "take-group-1", "take-2");
    const selected = selectCommand.execute(twoTakes);
    expect(audioClipsForPlayback(selected.arrangement).map((clip) => clip.bufferId)).toEqual(["audio.take-2"]);
    expect(selectCommand.undo(selected)).toEqual(twoTakes);
    expect(secondCommand.undo(twoTakes)).toEqual(first);
    expect(firstCommand.undo(first)).toEqual(doc);
  });

  it("builds a precise comp from source-pass ranges and restores it with one undo", () => {
    const doc = createProjectFromTemplate("empty");
    const track = doc.tracks[0];
    if (!track) throw new Error("empty project track fixture missing");
    const base = { ...doc, arrangement: { ...doc.arrangement, clips: [], audioClips: [] } };
    const first = addAudioTakeClip(base, "take-comp-group", "take-1", track.id, "audio.take-1", 0, 1).execute(base);
    const both = addAudioTakeClip(first, "take-comp-group", "take-2", track.id, "audio.take-2", 0, 1).execute(first);

    const firstHalfCommand = compAudioTakeRange(both, "take-comp-group", "take-1", 0, BAR_TICKS / 2);
    const firstHalf = firstHalfCommand.execute(both);
    const compTakeId = firstHalf.arrangement.takeGroups?.[0]?.compTakeId;
    expect(compTakeId).toBeTruthy();
    expect(firstHalf.arrangement.takeGroups?.[0]?.activeTakeId).toBe(compTakeId);
    expect(firstHalf.arrangement.audioClips?.filter((clip) => clip.takeId === "take-1")).toHaveLength(1);
    expect(audioClipsForPlayback(firstHalf.arrangement).map((clip) => clip.compSourceTakeId)).toEqual(["take-1"]);

    const secondHalfCommand = compAudioTakeRange(firstHalf, "take-comp-group", "take-2", BAR_TICKS / 2, BAR_TICKS);
    const comped = secondHalfCommand.execute(firstHalf);
    const audible = audioClipsForPlayback(comped.arrangement);
    expect(audible).toHaveLength(2);
    expect(audible.map((clip) => [clip.compSourceTakeId, clip.startBar, clip.lengthBars])).toEqual([
      ["take-1", 0, 0.5],
      ["take-2", 0.5, 0.5],
    ]);
    expect(audible[0]?.fadeOut).toBe(0.003);
    expect(audible[1]?.fadeIn).toBe(0.003);
    expect(comped.arrangement.audioClips?.filter((clip) => clip.takeId === "take-1")).toHaveLength(1);
    expect(comped.arrangement.audioClips?.filter((clip) => clip.takeId === "take-2")).toHaveLength(1);
    expect(computeRenderTicks(comped, "song")).toBe(BAR_TICKS);
    expect(secondHalfCommand.undo(comped)).toEqual(firstHalf);
  });

  it("replaces only the chosen comp interval and retains both outside regions", () => {
    const doc = createProjectFromTemplate("empty");
    const track = doc.tracks[0];
    if (!track) throw new Error("empty project track fixture missing");
    const first = addAudioTakeClip(doc, "replace-group", "take-1", track.id, "audio.one", 0, 1).execute(doc);
    const both = addAudioTakeClip(first, "replace-group", "take-2", track.id, "audio.two", 0, 1).execute(first);
    const wholeFirst = compAudioTakeRange(both, "replace-group", "take-1", 0, BAR_TICKS).execute(both);
    const replaceMiddle = compAudioTakeRange(
      wholeFirst,
      "replace-group",
      "take-2",
      BAR_TICKS * 0.25,
      BAR_TICKS * 0.75,
    ).execute(wholeFirst);

    expect(
      audioClipsForPlayback(replaceMiddle.arrangement).map((clip) => [
        clip.compSourceTakeId,
        clip.startBar,
        clip.lengthBars,
      ]),
    ).toEqual([
      ["take-1", 0, 0.25],
      ["take-2", 0.25, 0.5],
      ["take-1", 0.75, 0.25],
    ]);
  });

  it("keeps sub-quarter-bar comp ranges through project normalization and rejects source gaps", () => {
    const doc = createProjectFromTemplate("empty");
    const track = doc.tracks[0];
    if (!track) throw new Error("empty project track fixture missing");
    const source = addAudioTakeClip(doc, "short-group", "take-1", track.id, "audio.short", 0, 1).execute(doc);
    const command = compAudioTakeRange(source, "short-group", "take-1", 0, BAR_TICKS * 0.1);
    const comped = command.execute(source);
    const reopened = normalizeProject(comped);
    expect(audioClipsForPlayback(reopened.arrangement)).toHaveLength(1);
    expect(audioClipsForPlayback(reopened.arrangement)[0]?.lengthBars).toBeCloseTo(0.1);
    expect(audioClipsForPlayback(reopened.arrangement)[0]?.compSourceTakeId).toBe("take-1");
    const migrated = migrateProject({ ...comped, schemaVersion: 6 });
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(audioClipsForPlayback(migrated.arrangement)[0]?.compSourceTakeId).toBe("take-1");
    expect(() => compAudioTakeRange(source, "short-group", "take-1", BAR_TICKS * 0.9, BAR_TICKS * 1.1)).toThrow(
      /does not cover/u,
    );
  });

  it("maps comp source offsets through scene-tempo changes", () => {
    const doc = createProjectFromTemplate("empty");
    const track = doc.tracks[0];
    const scene = doc.scenes[0];
    if (!track || !scene) throw new Error("empty project fixture missing track or scene");
    const base = {
      ...doc,
      arrangement: { ...doc.arrangement, clips: [], audioClips: [] },
    };
    const atSceneTempo = setSceneBpm(base, scene.id, 60).execute(base);
    const arranged = addArrangementClip(atSceneTempo, scene.id, 0, 1).execute(atSceneTempo);
    const source = addAudioTakeClip(
      arranged,
      "tempo-comp-group",
      "take-at-60-bpm",
      track.id,
      "audio.tempo",
      0,
      1,
    ).execute(arranged);
    const comped = compAudioTakeRange(
      source,
      "tempo-comp-group",
      "take-at-60-bpm",
      BAR_TICKS / 4,
      BAR_TICKS / 2,
    ).execute(source);

    expect(audioClipsForPlayback(comped.arrangement)[0]?.offsetSec).toBeCloseTo(1, 8);
  });

  it("keeps ordinary clips audible if optional take metadata is stale", () => {
    const doc = createProjectFromTemplate("empty");
    const track = doc.tracks[0];
    if (!track) throw new Error("empty project track fixture missing");
    const malformed = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        audioClips: [
          {
            id: "orphan-take-clip",
            trackId: track.id,
            bufferId: "audio.orphan",
            takeGroupId: "missing-group",
            takeId: "take-1",
            startBar: 0,
            lengthBars: 2,
            offsetSec: 0,
            trimStart: 0,
            trimEnd: 0,
            gain: 1,
            fadeIn: 0,
            fadeOut: 0,
            stretchRate: 1,
            reverse: false,
          },
        ],
        takeGroups: [],
      },
    };
    const normalized = normalizeProject(malformed);
    expect(normalized.arrangement.audioClips?.[0]?.takeGroupId).toBeUndefined();
    expect(audioClipsForPlayback(normalized.arrangement).map((clip) => clip.bufferId)).toEqual(["audio.orphan"]);
  });

  it("repairs a missing active-pass reference and migrates v4 projects", () => {
    const doc = createProjectFromTemplate("empty");
    const track = doc.tracks[0];
    if (!track) throw new Error("empty project track fixture missing");
    const one = addAudioTakeClip(doc, "take-group-1", "take-1", track.id, "audio.take-1", 0, 1).execute(doc);
    const two = addAudioTakeClip(one, "take-group-1", "take-2", track.id, "audio.take-2", 0, 1).execute(one);
    const v4 = {
      ...two,
      schemaVersion: 4,
      arrangement: {
        ...two.arrangement,
        takeGroups: [{ id: "take-group-1", trackId: track.id, activeTakeId: "deleted-take" }],
      },
    };

    const migrated = migrateProject(v4);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.arrangement.takeGroups?.[0]?.activeTakeId).toBe("take-1");
    expect(audioClipsForPlayback(migrated.arrangement).map((clip) => clip.bufferId)).toEqual(["audio.take-1"]);
  });

  it("uses the selected take's extent for song export sizing", () => {
    const doc = createProjectFromTemplate("empty");
    const track = doc.tracks[0];
    if (!track) throw new Error("empty project track fixture missing");
    const songWithoutSceneClips = {
      ...doc,
      arrangement: { ...doc.arrangement, clips: [], audioClips: [] },
    };
    const shortTake = addAudioTakeClip(
      songWithoutSceneClips,
      "take-group-1",
      "take-short",
      track.id,
      "audio.short",
      0,
      1,
    ).execute(songWithoutSceneClips);
    const longAlternative = addAudioTakeClip(
      shortTake,
      "take-group-1",
      "take-long",
      track.id,
      "audio.long",
      0,
      8,
    ).execute(shortTake);
    const selectedLong = setActiveAudioTake(longAlternative, "take-group-1", "take-long").execute(longAlternative);

    expect(computeRenderTicks(longAlternative, "song")).toBe(BAR_TICKS);
    expect(computeRenderTicks(selectedLong, "song")).toBe(8 * BAR_TICKS);
    expect(computeRenderTicks(longAlternative, "pattern")).toBe(STEP_TICKS * 16);
  });
});
