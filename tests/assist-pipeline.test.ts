import { describe, expect, it } from "vitest";
import { buildAssistPatch, normalizeAssistRequest } from "../src/assist/pipeline";
import { assistBuild, assistFill, assistReplace } from "../src/commands/commands";
import { canonicalizePattern, contentHash } from "../src/ai/evaluation";
import { createDefaultProject } from "../src/project-model/schema";
import { getActivePattern, getDrumTrack, STEP_TICKS } from "../src/project-model/types";
import type { Pattern } from "../src/project-model/types";

function fixture() {
  const doc = createDefaultProject();
  const drumTrack = getDrumTrack(doc);
  const base = getActivePattern(doc);
  const kick = drumTrack.pads.find((pad) => /kick/i.test(pad.name))!;
  const snare = drumTrack.pads.find((pad) => /snare/i.test(pad.name))!;
  const hat = drumTrack.pads.find((pad) => /hat/i.test(pad.name))!;
  const instrument = doc.tracks.find((track) => track.kind === "instrument");
  const rows = {
    ...base.rows,
    [kick.id]: Array.from({ length: base.stepCount }, (_, step) => step % 4 === 0 ? 0.9 : 0),
    [snare.id]: Array.from({ length: base.stepCount }, (_, step) => step % 8 === 4 ? 0.8 : 0),
    [hat.id]: Array.from({ length: base.stepCount }, (_, step) => step % 2 === 0 ? 0.4 : 0),
  };
  const pattern: Pattern = {
    ...base,
    rows,
    notes: instrument
      ? {
        ...base.notes,
        [instrument.id]: [{ id: "source-note", pitch: 36, start: 0, duration: STEP_TICKS, velocity: 0.8 }],
      }
      : base.notes,
    stepMeta: {
      [kick.id]: { 0: { microtiming: 0.1 } },
      [hat.id]: { 1: { probability: 0.4 }, 2: { ratchet: 2 } },
      [snare.id]: { 1: { microtiming: -0.1 } },
    },
  };
  return {
    doc: { ...doc, patterns: doc.patterns.map((candidate) => candidate.id === pattern.id ? pattern : candidate) },
    pattern,
    drumTrack,
    kick,
    snare,
    hat,
    instrument,
  };
}

describe("Assist request and preview pipeline", () => {
  it("normalizes provider/UI input to bounded, style-valid values", () => {
    const request = normalizeAssistRequest({
      operation: "replace",
      seed: "x".repeat(200),
      amount: 99,
      bars: 99,
      target: "not-a-target" as never,
      style: "not-a-style",
    });
    expect(request).toEqual({
      operation: "replace",
      seed: "x".repeat(128),
      amount: 1,
      bars: 16,
      target: "hats",
      style: "house",
    });
  });

  it("builds an identical deterministic preview patch for the same request", () => {
    const { pattern, drumTrack } = fixture();
    const input = { operation: "vary" as const, seed: "preview-seed", amount: 0.7 };
    expect(buildAssistPatch(pattern, drumTrack.pads, input)).toEqual(buildAssistPatch(pattern, drumTrack.pads, input));
  });
});

describe("Assist command integration", () => {
  it("BUILD expands rows, notes, metadata, phrase plan, and provenance as one undoable command", () => {
    const { doc, pattern, drumTrack, instrument } = fixture();
    const command = assistBuild(doc, pattern.id, 4, "build-seed");
    const next = command.execute(doc);
    const built = next.patterns.find((candidate) => candidate.id === pattern.id)!;

    expect(built.stepCount).toBe(64);
    expect(Object.values(built.rows).every((row) => row.length === 64)).toBe(true);
    expect(instrument ? built.notes[instrument.id].map((note) => note.start) : []).toEqual([
      0,
      16 * STEP_TICKS,
      32 * STEP_TICKS,
      48 * STEP_TICKS,
    ]);
    expect(built.phrasePlan?.map((bar) => bar.section)).toEqual(["main", "variation", "drop", "outro"]);
    expect(built.stepMeta?.[drumTrack.pads.find((pad) => /kick/i.test(pad.name))!.id]?.[0]).toEqual({ microtiming: 0.1 });
    expect(built.assist).toMatchObject({ engineId: "pulse-forge.local-assist", engineVersion: "assist-1", operation: "build" });
    expect(built.assist?.sourceContentHash).toBe(contentHash(canonicalizePattern(doc, pattern)));
    expect(built.assist?.outputContentHash).toBe(contentHash(canonicalizePattern(next, built)));
    expect(command.undo(next)).toEqual(doc);
  });

  it("REPLACE changes only the selected pad family and clears its stale metadata", () => {
    const { doc, pattern, kick, hat } = fixture();
    const next = assistReplace(doc, pattern.id, "hats", "house", "replace-seed").execute(doc);
    const replaced = next.patterns.find((candidate) => candidate.id === pattern.id)!;

    expect(replaced.rows[kick.id]).toEqual(pattern.rows[kick.id]);
    expect(replaced.stepMeta?.[hat.id]).toBeUndefined();
    expect(replaced.notes).toEqual(pattern.notes);
    expect(replaced.assist).toMatchObject({ operation: "replace", target: "hats", style: "house" });
  });

  it("FILL clears metadata only in the fill zone and marks the final phrase bar", () => {
    const { doc, pattern, snare } = fixture();
    const next = assistFill(doc, pattern.id, "fill-seed").execute(doc);
    const filled = next.patterns.find((candidate) => candidate.id === pattern.id)!;

    expect(filled.stepMeta?.[snare.id]?.[1]).toBeUndefined();
    expect(filled.phrasePlan?.at(-1)?.section).toBe("fill");
    expect(filled.assist?.operation).toBe("fill");
  });
});
