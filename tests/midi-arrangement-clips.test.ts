import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addMidiClip,
  deleteMidiClip,
  deletePattern,
  deleteTrack,
  addNote,
  makeMidiClipUnique,
  moveMidiClip,
  resizeMidiClip,
  setMidiClipLocked,
  setMidiClipMuted,
  splitMidiClipAtTick,
  trimMidiClipStart,
} from "../src/commands/commands";
import { projectToYDoc, yDocToProject } from "../src/collab/YDocAdapter";
import { midiClipEventsInWindow, noteEventsInWindow } from "../src/project-model/events";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { migrateProject, normalizeProject, SCHEMA_VERSION } from "../src/project-model/schema";
import { BAR_TICKS, STEP_TICKS } from "../src/project-model/types";

function projectWithMelody() {
  const source = createProjectFromTemplate("house");
  const track = source.tracks.find((candidate) => candidate.kind === "instrument");
  if (!track || track.kind !== "instrument") throw new Error("house template needs an instrument track");
  const pattern = source.patterns.find((candidate) => candidate.id === source.activePatternId)!;
  const doc = normalizeProject({
    ...source,
    patterns: source.patterns.map((candidate) =>
      candidate.id === pattern.id
        ? {
            ...candidate,
            notes: {
              ...candidate.notes,
              [track.id]: [
                { id: "note-a", pitch: 36, start: 0, duration: STEP_TICKS * 8, velocity: 0.8 },
                { id: "note-b", pitch: 43, start: STEP_TICKS * 8, duration: STEP_TICKS * 4, velocity: 0.7 },
              ],
            },
          }
        : candidate,
    ),
  });
  return { doc, trackId: track.id, patternId: pattern.id };
}

describe("independent MIDI arrangement clips", () => {
  it("repeats one instrument's source notes and truncates note tails at the clip edge", () => {
    const { doc, trackId, patternId } = projectWithMelody();
    const placed = addMidiClip(doc, trackId, patternId, BAR_TICKS, BAR_TICKS + 240);
    const next = placed.execute(doc);
    const clip = next.arrangement.midiClips![0]!;
    const events = midiClipEventsInWindow(next, clip, 0, clip.startTick + clip.lengthTicks);

    expect(events.map(({ trackId: eventTrack, tick, note }) => [eventTrack, tick, note.duration])).toEqual([
      [trackId, BAR_TICKS, STEP_TICKS * 8],
      [trackId, BAR_TICKS + STEP_TICKS * 8, STEP_TICKS * 4],
      [trackId, BAR_TICKS * 2, 240],
    ]);
    expect(midiClipEventsInWindow(next, { ...clip, muted: true }, 0, BAR_TICKS * 8)).toEqual([]);
  });

  it("keeps a 12-bar 808 sustain beyond the step grid and grows its MIDI clip undoably", () => {
    const { doc, trackId, patternId } = projectWithMelody();
    const withClip = addMidiClip(doc, trackId, patternId, 0, BAR_TICKS).execute(doc);
    const command = addNote(withClip, trackId, {
      pitch: 36,
      start: 0,
      duration: BAR_TICKS * 12,
      velocity: 0.9,
    });
    const extended = command.execute(withClip);
    const clip = extended.arrangement.midiClips![0]!;
    const pattern = extended.patterns.find((candidate) => candidate.id === patternId)!;
    const longNote = pattern.notes[trackId].find((note) => note.pitch === 36 && note.duration === BAR_TICKS * 12)!;

    expect(longNote.duration).toBe(BAR_TICKS * 12);
    expect(clip.lengthTicks).toBe(BAR_TICKS * 12);
    expect(midiClipEventsInWindow(extended, clip, 0, clip.lengthTicks)).toContainEqual(
      expect.objectContaining({ tick: 0, note: expect.objectContaining({ pitch: 36, duration: BAR_TICKS * 12 }) }),
    );
    expect(
      noteEventsInWindow(pattern, 0, 0, BAR_TICKS * 12).filter((event) => event.note.id === longNote.id),
    ).toHaveLength(1);
    expect(
      noteEventsInWindow(pattern, 0, BAR_TICKS * 12, BAR_TICKS * 13).filter((event) => event.note.id === longNote.id),
    ).toHaveLength(1);
    expect(command.undo(extended).arrangement.midiClips![0]!.lengthTicks).toBe(BAR_TICKS);
  });

  it("keeps duration when moving near the end cap and preserves phase through trim and split", () => {
    const { doc, trackId, patternId } = projectWithMelody();
    const add = addMidiClip(doc, trackId, patternId, 0, BAR_TICKS * 2);
    const first = add.execute(doc);
    const clip = first.arrangement.midiClips![0]!;
    const moved = moveMidiClip(first, clip.id, Number.MAX_SAFE_INTEGER).execute(first);
    expect(moved.arrangement.midiClips![0]).toMatchObject({
      startTick: 15_728_640 - BAR_TICKS * 2,
      lengthTicks: BAR_TICKS * 2,
    });

    const source = { ...clip, startTick: 120, phaseOffsetTicks: 240 };
    const withPhase = { ...first, arrangement: { ...first.arrangement, midiClips: [source] } };
    const before = midiClipEventsInWindow(withPhase, source, source.startTick, source.startTick + source.lengthTicks);
    const trimmed = trimMidiClipStart(withPhase, source.id, source.startTick + 360).execute(withPhase);
    const trimClip = trimmed.arrangement.midiClips![0]!;
    const afterTrim = midiClipEventsInWindow(
      trimmed,
      trimClip,
      trimClip.startTick,
      trimClip.startTick + trimClip.lengthTicks,
    );
    expect(afterTrim).toEqual(before.filter((event) => event.tick >= trimClip.startTick));

    const splitAt = source.startTick + BAR_TICKS;
    const split = splitMidiClipAtTick(withPhase, source.id, splitAt).execute(withPhase);
    const splitEvents = split.arrangement.midiClips!.flatMap((part) =>
      midiClipEventsInWindow(split, part, part.startTick, part.startTick + part.lengthTicks),
    );
    expect(splitEvents.map((event) => event.tick)).toEqual(before.map((event) => event.tick));
    expect(splitEvents.find((event) => event.tick === 1800)?.note.duration).toBe(splitAt - 1800);
  });

  it("resizes and makes a clip unique without changing other clips' source", () => {
    const { doc, trackId, patternId } = projectWithMelody();
    const first = addMidiClip(doc, trackId, patternId, 0, BAR_TICKS).execute(doc);
    const clip = first.arrangement.midiClips![0]!;
    const resized = resizeMidiClip(first, clip.id, BAR_TICKS * 3).execute(first);
    const unique = makeMidiClipUnique(resized, clip.id).execute(resized);
    const newClip = unique.arrangement.midiClips![0]!;
    expect(newClip.patternId).not.toBe(patternId);
    expect(unique.patterns.find((pattern) => pattern.id === newClip.patternId)?.notes[trackId]).toHaveLength(2);
    expect(unique.arrangement.midiClips![0]!.lengthTicks).toBe(BAR_TICKS * 3);
  });

  it("normalizes legacy schema documents and round-trips MIDI clips through Yjs", () => {
    const { doc, trackId, patternId } = projectWithMelody();
    const withClip = addMidiClip(doc, trackId, patternId, BAR_TICKS * 3, BAR_TICKS * 5).execute(doc);
    const legacy = { ...withClip, schemaVersion: 25, arrangement: { ...withClip.arrangement, midiClips: undefined } };
    expect(migrateProject(legacy).schemaVersion).toBe(SCHEMA_VERSION);
    const longNote = { id: "legacy-long-note", pitch: 36, start: 0, duration: BAR_TICKS * 12, velocity: 0.9 };
    const v27 = {
      ...withClip,
      schemaVersion: 27,
      patterns: withClip.patterns.map((pattern) =>
        pattern.id === patternId
          ? { ...pattern, notes: { ...pattern.notes, [trackId]: [...pattern.notes[trackId], longNote] } }
          : pattern,
      ),
    };
    expect(migrateProject(v27).patterns.find((pattern) => pattern.id === patternId)?.notes[trackId]).toContainEqual(
      longNote,
    );
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(withClip, yMap);
    expect(yDocToProject(yMap).arrangement.midiClips).toEqual(withClip.arrangement.midiClips);
  });

  it("deletes a clip as an undoable document change", () => {
    const { doc, trackId, patternId } = projectWithMelody();
    const added = addMidiClip(doc, trackId, patternId, 0).execute(doc);
    const clipId = added.arrangement.midiClips![0]!.id;
    const command = deleteMidiClip(added, clipId);
    const deleted = command.execute(added);
    expect(deleted.arrangement.midiClips).toEqual([]);
    expect(command.undo(deleted).arrangement.midiClips).toEqual(added.arrangement.midiClips);
  });

  it("enforces clip locks while allowing mute and removes dependent clips with their pattern or track", () => {
    const { doc, trackId, patternId } = projectWithMelody();
    const added = addMidiClip(doc, trackId, patternId, 0).execute(doc);
    const clip = added.arrangement.midiClips![0]!;
    const muted = setMidiClipMuted(added, clip.id, true).execute(added);
    expect(midiClipEventsInWindow(muted, muted.arrangement.midiClips![0]!, 0, BAR_TICKS)).toEqual([]);
    const locked = setMidiClipLocked(muted, clip.id, true).execute(muted);
    expect(() => moveMidiClip(locked, clip.id, BAR_TICKS)).toThrow(/locked/i);

    const withoutTrack = deleteTrack(added, trackId).execute(added);
    expect(withoutTrack.arrangement.midiClips).toEqual([]);
    expect(deleteTrack(added, trackId).undo(withoutTrack).arrangement.midiClips).toEqual(added.arrangement.midiClips);

    if (added.patterns.length > 1) {
      const withoutPattern = deletePattern(added, patternId).execute(added);
      expect(withoutPattern.arrangement.midiClips).toEqual([]);
      expect(deletePattern(added, patternId).undo(withoutPattern).arrangement.midiClips).toEqual(
        added.arrangement.midiClips,
      );
    }
  });
});
