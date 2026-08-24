import { describe, expect, it } from "vitest";
import { applyMidiCreativeTool } from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { NoteEvent, ProjectDocument } from "../src/project-model/types";

function documentWithNotes(): { doc: ProjectDocument; trackId: string; notes: NoteEvent[] } {
  const base = createProjectFromTemplate("house");
  const track = base.tracks.find((candidate) => candidate.kind === "instrument");
  if (!track) throw new Error("House template has no instrument track");
  const notes: NoteEvent[] = [
    { id: "a", pitch: 60, start: 0, duration: 120, velocity: 0.8 },
    { id: "b", pitch: 64, start: 240, duration: 120, velocity: 0.7 },
    { id: "keep", pitch: 67, start: 480, duration: 120, velocity: 0.6 },
  ];
  return {
    doc: {
      ...base,
      key: "C Major",
      patterns: base.patterns.map((pattern) =>
        pattern.id === base.activePatternId
          ? { ...pattern, notes: { ...pattern.notes, [track.id]: notes } }
          : pattern,
      ),
    },
    trackId: track.id,
    notes,
  };
}

describe("MIDI creativity command", () => {
  it("changes only the selected notes and keeps one undo step", () => {
    const { doc, trackId } = documentWithNotes();
    const store = new ProjectStore(doc);
    store.execute(applyMidiCreativeTool(doc, {
      trackId,
      noteIds: ["a", "b"],
      operation: {
        kind: "chord",
        options: {
          mode: "explicit",
          quality: "minor",
          voicing: "close",
          inversion: 0,
          seventh: false,
          gate: 1,
          strumTicks: 0,
          strumDirection: "up",
          scaleLock: false,
        },
      },
    }));

    const pattern = store.doc.patterns.find((value) => value.id === store.doc.activePatternId)!;
    const result = pattern.notes[trackId];
    expect(result).toHaveLength(7);
    expect(result.some((value) => value.id === "keep")).toBe(true);
    expect(store.undoStackLength).toBe(1);

    store.undo();
    expect(store.doc).toEqual(doc);
    store.redo();
    expect(store.doc.patterns.find((value) => value.id === store.doc.activePatternId)!.notes[trackId]).toHaveLength(7);
  });

  it("falls back to all notes on the active instrument track", () => {
    const { doc, trackId } = documentWithNotes();
    const command = applyMidiCreativeTool(doc, {
      trackId,
      operation: { kind: "snap-scale", key: "C Major" },
    });
    const next = command.execute(doc);
    const notes = next.patterns.find((value) => value.id === next.activePatternId)!.notes[trackId];
    expect(notes.every((value) => [60, 64, 67].includes(value.pitch))).toBe(true);
  });

  it("rejects a drum track and an empty target", () => {
    const { doc, trackId } = documentWithNotes();
    const drum = doc.tracks.find((value) => value.kind === "drum")!;
    expect(() => applyMidiCreativeTool(doc, {
      trackId: drum.id,
      operation: { kind: "reverse", scaleLock: false },
    })).toThrow(/instrument track/i);
    expect(() => applyMidiCreativeTool(doc, {
      trackId,
      noteIds: ["missing"],
      operation: { kind: "reverse", scaleLock: false },
    })).toThrow(/at least one note/i);
  });
});

