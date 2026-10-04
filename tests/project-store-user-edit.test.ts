import { describe, expect, it, vi } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { generatePattern } from "../src/ai/generator";
import { setNotesVelocity } from "../src/commands/notes";
import type { Command } from "../src/commands/types";
import type { GenerateOptions } from "../src/ai/types";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * LEARN LOCAL PRODUCER STYLE FROM EDITS — the store boundary.
 *
 * The whole privacy story rests on ONE distinction: only commands that come
 * through `executeUserEdit()` (a human editor gesture) may reach the style
 * observer. Generated, imported, remote and undo/redo commands go through
 * `execute()` and must stay invisible. If that line ever blurs, the DAW would
 * start "learning" from its own output.
 */

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    genre: "techno",
    style: null,
    seed: "store-user-edit",
    stepCount: 32,
    key: null,
    drumTrackId: undefined,
    roles: ["drums", "bass", "chords", "lead"],
    replaceMode: "replace",
    ...overrides,
  } as GenerateOptions;
}

function fixture(): ProjectDocument {
  const doc = createProjectFromTemplate("techno");
  const pattern = generatePattern(doc, options());
  return { ...doc, patterns: [pattern], activePatternId: pattern.id };
}

describe("ProjectStore — user-edit signal for taste learning", () => {
  it("fires onUserPatternEdit for executeUserEdit only", () => {
    const doc = fixture();
    const store = new ProjectStore(doc);
    const seen: string[] = [];
    store.onUserPatternEdit = (next, previous) => seen.push(`${previous.patterns[0].id}->${next.patterns[0].id}`);

    const instrument = doc.tracks.find((track) => track.kind === "instrument")!;
    const note = store.doc.patterns[0].notes[instrument.id]?.[0];
    if (!note) throw new Error("fixture pattern has no note");
    const command = setNotesVelocity(store.doc, instrument.id, [note.id], 0.5);

    // A generated/system command does NOT reach the observer.
    store.execute(command);
    expect(seen).toEqual([]);

    // A human edit does.
    store.executeUserEdit(command);
    expect(seen).toHaveLength(1);
  });

  it("does not fire for a command that is a no-op", () => {
    const doc = fixture();
    const store = new ProjectStore(doc);
    let fired = 0;
    store.onUserPatternEdit = () => {
      fired += 1;
    };
    // The store's no-op guard is REFERENCE identity: a command that returns
    // the same doc produces no history entry and no learning signal.
    store.executeUserEdit({ type: "noop", label: "noop", execute: (current) => current } as Command);
    expect(fired).toBe(0);
  });

  it("hands the observer the PREVIOUS doc, not the already-edited one", () => {
    const doc = fixture();
    const store = new ProjectStore(doc);
    const instrument = doc.tracks.find((track) => track.kind === "instrument")!;
    const note = store.doc.patterns[0].notes[instrument.id]?.[0];
    if (!note) throw new Error("fixture pattern has no note");
    const originalVelocity = note.velocity;

    let observedPrevious: number | null = null;
    let observedNext: number | null = null;
    store.onUserPatternEdit = (next, previous) => {
      observedPrevious = previous.patterns[0].notes[instrument.id]?.find((n) => n.id === note.id)?.velocity ?? null;
      observedNext = next.patterns[0].notes[instrument.id]?.find((n) => n.id === note.id)?.velocity ?? null;
    };
    const target = originalVelocity > 0.5 ? 0.3 : 0.9;
    store.executeUserEdit(setNotesVelocity(store.doc, instrument.id, [note.id], target));
    // The observer must be able to diff: previous carries the OLD value,
    // next carries the new one.
    expect(observedPrevious).toBe(originalVelocity);
    expect(observedNext).toBe(target);
  });

  it("a throwing observer cannot break the edit", () => {
    const doc = fixture();
    const store = new ProjectStore(doc);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.onUserPatternEdit = () => {
      throw new Error("observer exploded");
    };
    const instrument = doc.tracks.find((track) => track.kind === "instrument")!;
    const note = store.doc.patterns[0].notes[instrument.id]?.[0];
    if (!note) throw new Error("fixture pattern has no note");
    expect(() => store.executeUserEdit(setNotesVelocity(store.doc, instrument.id, [note.id], 0.9))).not.toThrow();
    warn.mockRestore();
  });

  it("fires again after undo + redo of a human edit (each is a real state change)", () => {
    const doc = fixture();
    const store = new ProjectStore(doc);
    let fired = 0;
    store.onUserPatternEdit = () => {
      fired += 1;
    };
    const instrument = doc.tracks.find((track) => track.kind === "instrument")!;
    const note = store.doc.patterns[0].notes[instrument.id]?.[0];
    if (!note) throw new Error("fixture pattern has no note");
    store.executeUserEdit(setNotesVelocity(store.doc, instrument.id, [note.id], 0.7));
    expect(fired).toBe(1);
    // Undo/redo go through the store's own path, not executeUserEdit.
    store.undo();
    store.redo();
    expect(fired).toBe(1);
  });
});
