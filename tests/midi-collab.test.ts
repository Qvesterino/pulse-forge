import { describe, expect, it } from "vitest";
import { applyMidiCreativeTool } from "../src/commands/commands";
import { YDocStore } from "../src/collab/YDocStore";
import { createProjectFromTemplate } from "../src/project-model/templates";

describe("MIDI creativity collaboration", () => {
  it("round-trips materialized notes through YDoc and undo", () => {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((value) => value.kind === "instrument")!;
    const pattern = doc.patterns.find((value) => value.id === doc.activePatternId)!;
    const seeded = {
      ...doc,
      key: "C Major" as const,
      patterns: doc.patterns.map((value) =>
        value.id === pattern.id
          ? {
              ...value,
              notes: {
                ...value.notes,
                [track.id]: [{ id: "collab-note", pitch: 61, start: 0, duration: 120, velocity: 0.8 }],
              },
            }
          : value,
      ),
    };
    const store = YDocStore.fromDocument(seeded);
    store.execute(
      applyMidiCreativeTool(seeded, {
        trackId: track.id,
        operation: { kind: "snap-scale", key: "C Major" },
      }),
    );

    const changed = store.doc.patterns.find((value) => value.id === pattern.id)!.notes[track.id];
    expect(changed[0].pitch).toBe(60);
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(store.doc.patterns.find((value) => value.id === pattern.id)!.notes[track.id][0].pitch).toBe(61);
  });

  it("shares generated arpeggio NoteEvents with a remote document", () => {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((value) => value.kind === "instrument")!;
    const pattern = doc.patterns.find((value) => value.id === doc.activePatternId)!;
    const seeded = {
      ...doc,
      patterns: doc.patterns.map((value) =>
        value.id === pattern.id
          ? {
              ...value,
              notes: {
                ...value.notes,
                [track.id]: [
                  { id: "collab-c", pitch: 60, start: 0, duration: 480, velocity: 0.8 },
                  { id: "collab-e", pitch: 64, start: 0, duration: 480, velocity: 0.8 },
                  { id: "collab-g", pitch: 67, start: 0, duration: 480, velocity: 0.8 },
                ],
              },
            }
          : value,
      ),
    };
    const store = YDocStore.fromDocument(seeded);
    store.execute(
      applyMidiCreativeTool(seeded, {
        trackId: track.id,
        operation: {
          kind: "arpeggiate",
          options: { mode: "up", rateTicks: 120, octaveRange: 0, gate: 1, seed: "collab" },
          scaleLock: false,
        },
      }),
    );

    const generated = store.doc.patterns.find((value) => value.id === pattern.id)!.notes[track.id];
    expect(generated.map((value) => value.pitch)).toEqual([60, 64, 67, 60]);
    expect(store.canUndo).toBe(true);
  });
});
