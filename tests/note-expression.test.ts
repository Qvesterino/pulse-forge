import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { TriggerEngine } from "../src/audio-engine/triggerEngine";
import { setNotesExpression } from "../src/commands/notes";
import { projectToYDoc, yDocToProject } from "../src/collab/YDocAdapter";
import { normalizeProject, SCHEMA_VERSION } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import type { InstrumentRuntime } from "../src/instruments/types";
import type { WarpManager } from "../src/audio-engine/warpManager";
import type { NoteEvent } from "../src/project-model/types";

function projectWithNotes(notes: NoteEvent[]) {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((candidate) => candidate.kind === "instrument")!;
  doc.patterns.find((pattern) => pattern.id === doc.activePatternId)!.notes = { [track.id]: notes };
  return { doc, track };
}

function activeNotes(doc: ReturnType<typeof createProjectFromTemplate>, trackId: string): NoteEvent[] {
  return doc.patterns.find((pattern) => pattern.id === doc.activePatternId)!.notes?.[trackId] ?? [];
}

describe("per-note Piano Roll expression", () => {
  it("clamps and preserves supported expression fields through normalization and Yjs", () => {
    const { doc, track } = projectWithNotes([
      {
        id: "expr-normalize",
        pitch: 60,
        start: 0,
        duration: 480,
        velocity: 0.8,
        expression: {
          pan: 4,
          filterCutoffHz: 10,
          filterResonance: 2,
          releaseVelocity: -1,
          pitchOffsetSemitones: 20,
          unknown: 1,
        } as NoteEvent["expression"],
      },
    ]);
    doc.schemaVersion = SCHEMA_VERSION;

    const normalized = normalizeProject(doc);
    const expression = activeNotes(normalized, track.id)[0]!.expression;
    expect(expression).toEqual({
      pan: 1,
      filterCutoffHz: 80,
      filterResonance: 1,
      releaseVelocity: 0,
      pitchOffsetSemitones: 12,
    });

    const ydoc = new Y.Doc();
    projectToYDoc(normalized, ydoc.getMap("project"));
    expect(activeNotes(yDocToProject(ydoc.getMap("project")), track.id)[0]!.expression).toEqual(expression);
    ydoc.destroy();
  });

  it("edits selected note values as one undoable command and restores exact prior values", () => {
    const { doc, track } = projectWithNotes([
      {
        id: "expr-a",
        pitch: 60,
        start: 0,
        duration: 480,
        velocity: 0.8,
      },
      {
        id: "expr-b",
        pitch: 64,
        start: 480,
        duration: 480,
        velocity: 0.8,
        expression: { pitchOffsetSemitones: -0.25 },
      },
    ]);
    const store = new ProjectStore(doc);

    store.execute(setNotesExpression(store.doc, track.id, "pitchOffsetSemitones", { "expr-a": 2, "expr-b": 1 }));
    expect(activeNotes(store.doc, track.id).map((note) => note.expression?.pitchOffsetSemitones)).toEqual([2, 1]);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(activeNotes(store.doc, track.id).map((note) => note.expression?.pitchOffsetSemitones)).toEqual([
      undefined,
      -0.25,
    ]);
    store.redo();
    expect(activeNotes(store.doc, track.id).map((note) => note.expression?.pitchOffsetSemitones)).toEqual([2, 1]);
  });

  it("uses defaults implicitly and treats resetting an unchanged note as a no-op", () => {
    const { doc, track } = projectWithNotes([
      { id: "expr-default", pitch: 60, start: 0, duration: 480, velocity: 0.8 },
    ]);
    const store = new ProjectStore(doc);

    store.execute(setNotesExpression(store.doc, track.id, "pan", { "expr-default": 0 }));
    expect(store.undoStackLength).toBe(0);
    expect(activeNotes(store.doc, track.id)[0]!.expression).toBeUndefined();
  });

  it("adds fine pitch before dispatching the note to its instrument runtime", () => {
    const noteOn = vi.fn();
    const runtime = { noteOn } as unknown as InstrumentRuntime;
    const warp = { isFrozen: () => false } as unknown as WarpManager;
    const engine = new TriggerEngine(
      {
        ctx: () => null,
        doc: () => null,
        bank: () => null,
        currentTime: () => 0,
        trackNodes: new Map(),
        groupNodes: new Map(),
        instrumentStates: new Map([["track", { runtime, pitchBend: 2 }]]),
        warp,
        trackOneShot: vi.fn(),
        releaseOneShot: vi.fn(),
        missAsset: vi.fn(),
      },
      warp,
    );
    const expression = { pitchOffsetSemitones: 1.25 };

    engine.noteOn("track", 60, 0.8, 1, 0.5, undefined, undefined, undefined, undefined, expression);

    expect(noteOn).toHaveBeenCalledWith(63.25, 0.8, 1, 0.5, undefined, expression);
  });
});
