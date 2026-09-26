import { describe, expect, it } from "vitest";
import { applyVocalHookCommand } from "../src/vocal/adapt";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { DrumTrack, InstrumentTrack, ProjectDocument } from "../src/project-model/types";
import type { VocalProfile } from "../src/vocal/types";

/**
 * VLNA 3 — "urob hook z môjho hlasu": the recorded take becomes a pitched-up
 * vocalchop track whose notes follow the measured phrases. One undo step;
 * re-apply reuses the track and replaces the notes; the vocalchop runtime
 * resolves the sampleId from the bank at play time.
 */

function profileWith(overrides?: Partial<VocalProfile>): VocalProfile {
  return {
    version: 1,
    key: null,
    keyConfidence: 0,
    keyMeasured: false,
    tempoBpm: null,
    tempoMeasured: false,
    phrases: [
      { startBar: 0, endBar: 1, peakEnergy: 0.9 },
      { startBar: 3, endBar: 3, peakEnergy: 0.4 },
    ],
    profileHash: "hook-test-hash",
    ...overrides,
  } as VocalProfile;
}

function docWithoutVocalchops(): ProjectDocument {
  return createProjectFromTemplate("house");
}

describe("applyVocalHookCommand — the hero path", () => {
  it("creates a vocalchop track pointing at the take and plants phrase notes", () => {
    const doc = docWithoutVocalchops();
    const cmd = applyVocalHookCommand(doc, { bufferId: "take:abc123", profile: profileWith() });
    const next = cmd.execute(doc);

    const hook = next.tracks.find((t): t is InstrumentTrack => t.name === "Hook — voice");
    expect(hook).toBeDefined();
    expect(hook!.instrument).toBe("vocalchop");
    expect(hook!.sampleId).toBe("take:abc123");

    const pattern = next.patterns.find((p) => p.id === next.activePatternId)!;
    const notes = pattern.notes[hook!.id]!;
    expect(notes).toHaveLength(2);
    // Phrases ordered by their position on the analysis grid.
    expect(notes[0]!.start).toBeLessThan(notes[1]!.start);
    // Louder phrase → higher velocity.
    expect(notes[0]!.velocity).toBeGreaterThan(notes[1]!.velocity);
    // Notes live inside the pattern.
    const maxTicks = pattern.stepCount * 120; // STEP_TICKS
    for (const note of notes) {
      expect(note.start).toBeGreaterThanOrEqual(0);
      expect(note.start + note.duration).toBeLessThanOrEqual(maxTicks);
    }
  });

  it("one undo removes both the track and its notes", () => {
    const doc = docWithoutVocalchops();
    const cmd = applyVocalHookCommand(doc, { bufferId: "take:abc123", profile: profileWith() });
    const next = cmd.execute(doc);
    const hook = next.tracks.find((t): t is InstrumentTrack => t.name === "Hook — voice")!;

    const restored = cmd.undo(next);
    expect(restored.tracks.find((t) => t.id === hook.id)).toBeUndefined();
    const pattern = restored.patterns.find((p) => p.id === restored.activePatternId)!;
    expect(pattern.notes[hook.id]).toBeUndefined();
  });

  it("re-applying the same take reuses the track and replaces the notes", () => {
    let doc = docWithoutVocalchops();
    doc = applyVocalHookCommand(doc, { bufferId: "take:abc123", profile: profileWith() }).execute(doc);
    const afterFirst = doc.tracks.filter((t) => t.name === "Hook — voice").length;
    doc = applyVocalHookCommand(doc, { bufferId: "take:abc123", profile: profileWith() }).execute(doc);

    expect(doc.tracks.filter((t) => t.name === "Hook — voice")).toHaveLength(afterFirst);
    const hook = doc.tracks.find((t): t is InstrumentTrack => (t as InstrumentTrack).sampleId === "take:abc123")!;
    const pattern = doc.patterns.find((p) => p.id === doc.activePatternId)!;
    expect(pattern.notes[hook.id]).toHaveLength(2); // replaced, not duplicated
  });

  it("a phrase-less profile still plants a single usable hook note", () => {
    const doc = docWithoutVocalchops();
    const next = applyVocalHookCommand(doc, {
      bufferId: "take:abc123",
      profile: profileWith({ phrases: [] }),
    }).execute(doc);
    const hook = next.tracks.find((t): t is InstrumentTrack => t.name === "Hook — voice")!;
    const pattern = next.patterns.find((p) => p.id === next.activePatternId)!;
    expect(pattern.notes[hook.id]).toHaveLength(1);
  });

  it("refuses honestly: no buffer pointer, no active pattern", () => {
    const doc = docWithoutVocalchops();
    expect(() => applyVocalHookCommand(doc, { bufferId: "", profile: profileWith() })).toThrow(/not staged/);

    const noActive: ProjectDocument = {
      ...doc,
      activePatternId: "missing-pattern",
    };
    expect(() => applyVocalHookCommand(noActive, { bufferId: "take:x", profile: profileWith() })).toThrow(
      /No active pattern/,
    );
  });

  it("does not disturb drum rows or other tracks' notes", () => {
    const doc = docWithoutVocalchops();
    const drum = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    const before = doc.patterns.find((p) => p.id === doc.activePatternId)!;
    const rowsBefore = JSON.stringify(before.rows);
    const next = applyVocalHookCommand(doc, { bufferId: "take:abc123", profile: profileWith() }).execute(doc);
    const after = next.patterns.find((p) => p.id === doc.activePatternId)!;
    expect(JSON.stringify(after.rows)).toBe(rowsBefore);
    expect(after.rows).toEqual(before.rows);
    expect(drum.pads.length).toBeGreaterThan(0);
  });
});
