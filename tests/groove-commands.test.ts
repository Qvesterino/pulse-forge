import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  clearSteps,
  createFill,
  mutatePattern,
  setGroove,
  setStepMeta,
  setStepsVelocity,
} from "../src/commands/commands";
import type { DrumTrack, ProjectDocument } from "../src/project-model/types";

function docWithKick(): { doc: ProjectDocument; kickId: string; patternId: string } {
  const doc = createProjectFromTemplate("house");
  const drums = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
  return { doc, kickId: drums.pads[0].id, patternId: doc.patterns[0].id };
}

describe("setGroove", () => {
  it("merges partial groove settings and undoes to the previous state", () => {
    const { doc } = docWithKick();
    const withSwing = setGroove(doc, { swing: 0.5 }).execute(doc);
    expect(withSwing.groove?.swing).toBe(0.5);
    expect(withSwing.groove?.humanizeTiming ?? 0).toBe(0);

    const withHumanize = setGroove(withSwing, { humanizeVelocity: 0.3 }).execute(withSwing);
    expect(withHumanize.groove?.swing).toBe(0.5);
    expect(withHumanize.groove?.humanizeVelocity).toBe(0.3);

    const command = setGroove(withHumanize, { swing: 0 });
    const undone = command.undo(command.execute(withHumanize));
    expect(undone.groove?.swing).toBe(0.5);
  });
});

describe("setStepMeta", () => {
  it("merges meta fields and prunes entries that return to defaults", () => {
    const { doc, kickId, patternId } = docWithKick();
    const withProb = setStepMeta(doc, patternId, kickId, 3, { probability: 0.5 }).execute(doc);
    expect(withProb.patterns[0].stepMeta?.[kickId]?.[3].probability).toBe(0.5);

    const withBoth = setStepMeta(withProb, patternId, kickId, 3, { ratchet: 2 }).execute(withProb);
    const meta = withBoth.patterns[0].stepMeta?.[kickId]?.[3];
    expect(meta?.probability).toBe(0.5);
    expect(meta?.ratchet).toBe(2);

    // Returning everything to defaults removes the entry entirely.
    const cleared = setStepMeta(withBoth, patternId, kickId, 3, { probability: 1, ratchet: 1, microtiming: 0 }).execute(withBoth);
    expect(cleared.patterns[0].stepMeta).toBeUndefined();
  });

  it("undoes back to the previous meta entry", () => {
    const { doc, kickId, patternId } = docWithKick();
    const command = setStepMeta(doc, patternId, kickId, 0, { microtiming: 0.4 });
    const next = command.execute(doc);
    expect(next.patterns[0].stepMeta?.[kickId]?.[0].microtiming).toBe(0.4);
    const undone = command.undo(next);
    expect(undone.patterns[0].stepMeta).toBeUndefined();
  });
});

describe("clearSteps", () => {
  it("clears velocities and step meta in the range, undo restores both", () => {
    const { doc, kickId, patternId } = docWithKick();
    const withMeta = setStepMeta(doc, patternId, kickId, 0, { ratchet: 2 }).execute(doc);
    const activeBefore = withMeta.patterns[0].rows[kickId].filter((v) => v > 0).length;
    expect(activeBefore).toBeGreaterThan(0);

    const command = clearSteps(withMeta, patternId, [kickId], 0, 15);
    const cleared = command.execute(withMeta);
    expect(cleared.patterns[0].rows[kickId].every((v) => v === 0)).toBe(true);
    expect(cleared.patterns[0].stepMeta).toBeUndefined();

    const restored = command.undo(cleared);
    expect(restored.patterns[0].rows[kickId]).toEqual(withMeta.patterns[0].rows[kickId]);
    expect(restored.patterns[0].stepMeta?.[kickId]?.[0].ratchet).toBe(2);
  });
});

describe("setStepsVelocity", () => {
  it("batch-updates velocities and undoes per-entry", () => {
    const { doc, kickId, patternId } = docWithKick();
    const clapId = (doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!).pads[6].id;
    const entries = [
      { padId: kickId, stepIndex: 0, velocity: 0.42 },
      { padId: clapId, stepIndex: 4, velocity: 0.77 },
    ];
    const command = setStepsVelocity(doc, patternId, entries);
    const next = command.execute(doc);
    expect(next.patterns[0].rows[kickId][0]).toBeCloseTo(0.42, 5);
    expect(next.patterns[0].rows[clapId][4]).toBeCloseTo(0.77, 5);
    const undone = command.undo(next);
    expect(undone.patterns[0].rows[kickId][0]).toBeCloseTo(doc.patterns[0].rows[kickId][0], 5);
    expect(undone.patterns[0].rows[clapId][4]).toBeCloseTo(doc.patterns[0].rows[clapId][4], 5);
  });
});

describe("mutatePattern", () => {
  it("changes velocities but keeps the grid shape, undo restores exactly", () => {
    const { doc, patternId } = docWithKick();
    const command = mutatePattern(doc, patternId);
    const mutated = command.execute(doc);
    const before = doc.patterns[0].rows;
    const after = mutated.patterns[0].rows;
    expect(Object.keys(after)).toEqual(Object.keys(before));
    let changed = false;
    for (const padId of Object.keys(before)) {
      expect(after[padId]).toHaveLength(before[padId].length);
      for (let i = 0; i < before[padId].length; i++) {
        expect(after[padId][i]).toBeGreaterThanOrEqual(0);
        expect(after[padId][i]).toBeLessThanOrEqual(1);
        if (after[padId][i] !== before[padId][i]) changed = true;
      }
    }
    expect(changed).toBe(true);
    const undone = command.undo(mutated);
    expect(undone.patterns[0].rows).toEqual(before);
  });

  it("two mutations produce different variations", () => {
    const { doc, patternId } = docWithKick();
    const a = mutatePattern(doc, patternId).execute(doc);
    const b = mutatePattern(doc, patternId).execute(doc);
    expect(a.patterns[0].rows).not.toEqual(b.patterns[0].rows);
  });
});

describe("createFill", () => {
  it("duplicates as '<name> Fill' with a rising snare roll over the last beat", () => {
    const { doc, patternId } = docWithKick();
    const snarePad = (doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!).pads.find((p) => /snare/i.test(p.name))!;
    const command = createFill(doc, patternId);
    const next = command.execute(doc);

    expect(next.patterns).toHaveLength(doc.patterns.length + 1);
    const fill = next.patterns[next.patterns.length - 1];
    expect(fill.name).toBe(`${doc.patterns[0].name} Fill`);
    expect(next.activePatternId).toBe(fill.id);

    const roll = fill.rows[snarePad.id].slice(-4);
    expect(roll).toEqual([0.45, 0.6, 0.78, 0.95]);
    expect(fill.stepMeta?.[snarePad.id]?.[fill.stepCount - 1]?.ratchet).toBe(2);
    // Original pattern untouched.
    expect(next.patterns[0].rows).toEqual(doc.patterns[0].rows);

    const undone = command.undo(next);
    expect(undone.patterns).toHaveLength(doc.patterns.length);
    expect(undone.activePatternId).toBe(doc.activePatternId);
  });
});
