import { describe, expect, it } from "vitest";
import { generateLocalResult } from "../src/intent/pipeline";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { Pattern } from "../src/project-model/types";

function activePattern(patterns: readonly Pattern[], id: string): Pattern {
  const pattern = patterns.find((candidate) => candidate.id === id);
  if (!pattern) throw new Error(`Missing active pattern ${id}`);
  return pattern;
}

describe("generation preserves explicit source roles", () => {
  it("carries the active pattern's bass into the audition candidate when bass is protected", () => {
    const project = createProjectFromTemplate("house");
    const source = activePattern(project.patterns, project.activePatternId);
    const bass = project.tracks.find(
      (track) =>
        track.kind === "instrument" && (track.name.toLowerCase().includes("bass") || track.instrument === "808"),
    );
    expect(bass?.kind).toBe("instrument");
    if (!bass || bass.kind !== "instrument") throw new Error("House fixture has no bass track");
    const sourceNotes = source.notes[bass.id];
    expect(sourceNotes?.length).toBeGreaterThan(0);

    const result = generateLocalResult(
      project,
      {
        genre: "house",
        seed: "preserve-bass-audition",
        length: source.stepCount,
        roles: ["drums", "bass"],
        preserve: ["bass"],
        candidateCount: 1,
      },
      "preview",
    );

    expect(result.proposal).toBeDefined();
    expect(result.plan.preserveSourcePatternId).toBe(source.id);
    const auditionNotes = result.proposal?.pattern.notes[bass.id] ?? [];
    expect(auditionNotes).toHaveLength(sourceNotes?.length ?? 0);
    for (const note of sourceNotes ?? []) {
      expect(
        auditionNotes.some(
          (candidate) =>
            candidate.pitch === note.pitch &&
            candidate.start === note.start &&
            candidate.duration === note.duration &&
            candidate.velocity === note.velocity,
        ),
      ).toBe(true);
    }
  });

  it("carries the active pattern's drum rows and step metadata when drums are protected", () => {
    const project = createProjectFromTemplate("house");
    const source = activePattern(project.patterns, project.activePatternId);
    const drum = project.tracks.find((track) => track.kind === "drum");
    expect(drum?.kind).toBe("drum");
    if (!drum || drum.kind !== "drum") throw new Error("House fixture has no drum track");
    const sourceRows = Object.fromEntries(
      drum.pads.flatMap((pad) => (source.rows[pad.id] ? [[pad.id, source.rows[pad.id]]] : [])),
    );
    expect(Object.keys(sourceRows).length).toBeGreaterThan(0);

    const result = generateLocalResult(
      project,
      {
        genre: "house",
        seed: "preserve-drums-audition",
        length: source.stepCount,
        roles: ["drums", "bass"],
        preserve: ["drums"],
        candidateCount: 1,
      },
      "preview",
    );

    expect(result.proposal).toBeDefined();
    expect(result.plan.preserveSourcePatternId).toBe(source.id);
    for (const [padId, row] of Object.entries(sourceRows)) {
      expect(result.proposal?.pattern.rows[padId]).toEqual(row);
    }
    expect(result.proposal?.pattern.stepMeta).toEqual(source.stepMeta);
  });
});
