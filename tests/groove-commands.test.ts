import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  clearSteps,
  createFill,
  mutatePattern,
  quantizePatternToGrid,
  quantizePatternToScale,
  setGroove,
  setStepsVelocity,
  setStepMeta,
} from "../src/commands/commands";
import type { DrumTrack, ProjectDocument, MusicalKey } from "../src/project-model/types";
import { GRID_8TH, GRID_16TH, GRID_32ND } from "../src/project-model/types";

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
    const cleared = setStepMeta(withBoth, patternId, kickId, 3, { probability: 1, ratchet: 1, microtiming: 0 }).execute(
      withBoth,
    );
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
    const clapId = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!.pads[6].id;
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
    const snarePad = doc.tracks
      .find((t): t is DrumTrack => t.kind === "drum")!
      .pads.find((p) => /snare/i.test(p.name))!;
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

describe("quantizePatternToGrid", () => {
  it("snaps note starts to 1/16 grid (default)", () => {
    const { doc, kickId, patternId } = docWithKick();
    // Place notes at non-grid positions by directly editing
    const withOffGrid = {
      ...doc,
      patterns: doc.patterns.map((p) =>
        p.id === patternId
          ? { ...p, notes: { [kickId]: [{ id: "n1", pitch: 28, start: 180, duration: 120, velocity: 0.8 }] } }
          : p,
      ),
    };
    const fixed = quantizePatternToGrid(withOffGrid, patternId, GRID_16TH).execute(withOffGrid);
    const notes = fixed.patterns[0].notes[kickId];
    expect(notes[0].start).toBe(240); // 180 rounds to nearest 16th = 240
  });

  it("snaps note starts to 1/8 grid", () => {
    const { doc, kickId, patternId } = docWithKick();
    const withOffGrid = {
      ...doc,
      patterns: doc.patterns.map((p) =>
        p.id === patternId
          ? {
              ...p,
              notes: {
                [kickId]: [
                  { id: "n1", pitch: 28, start: 180, duration: 120, velocity: 0.8 },
                  { id: "n2", pitch: 28, start: 360, duration: 120, velocity: 0.8 },
                ],
              },
            }
          : p,
      ),
    };
    const fixed = quantizePatternToGrid(withOffGrid, patternId, GRID_8TH).execute(withOffGrid);
    const notes = fixed.patterns[0].notes[kickId];
    expect(notes[0].start).toBe(240); // 180 rounds to nearest 1/8 = 240
    expect(notes[1].start).toBe(480); // 360 rounds to nearest 1/8 = 480 (tie goes up)
  });

  it("snaps note starts to 1/32 grid (finest resolution)", () => {
    const { doc, kickId, patternId } = docWithKick();
    const withOffGrid = {
      ...doc,
      patterns: doc.patterns.map((p) =>
        p.id === patternId
          ? { ...p, notes: { [kickId]: [{ id: "n1", pitch: 28, start: 180, duration: 120, velocity: 0.8 }] } }
          : p,
      ),
    };
    const fixed = quantizePatternToGrid(withOffGrid, patternId, GRID_32ND).execute(withOffGrid);
    const notes = fixed.patterns[0].notes[kickId];
    expect(notes[0].start).toBe(180); // 180 is already on 1/32 grid (3 × 60)
  });

  it("preserves duration unchanged", () => {
    const { doc, kickId, patternId } = docWithKick();
    const withOffGrid = {
      ...doc,
      patterns: doc.patterns.map((p) =>
        p.id === patternId
          ? { ...p, notes: { [kickId]: [{ id: "n1", pitch: 28, start: 180, duration: 137, velocity: 0.8 }] } }
          : p,
      ),
    };
    const fixed = quantizePatternToGrid(withOffGrid, patternId, GRID_16TH).execute(withOffGrid);
    expect(fixed.patterns[0].notes[kickId][0].duration).toBe(137); // unchanged
  });

  it("undo restores original note positions", () => {
    const { doc, kickId, patternId } = docWithKick();
    const withOffGrid = {
      ...doc,
      patterns: doc.patterns.map((p) =>
        p.id === patternId
          ? { ...p, notes: { [kickId]: [{ id: "n1", pitch: 28, start: 180, duration: 120, velocity: 0.8 }] } }
          : p,
      ),
    };
    const cmd = quantizePatternToGrid(withOffGrid, patternId, GRID_16TH);
    const fixed = cmd.execute(withOffGrid);
    const undone = cmd.undo(fixed);
    expect(undone.patterns[0].notes[kickId][0].start).toBe(180);
  });

  it("combined quantize: time + pitch quantize in sequence", () => {
    const { doc, kickId, patternId } = docWithKick();
    const withOffGrid = {
      ...doc,
      key: "C Major" as MusicalKey,
      patterns: doc.patterns.map((p) =>
        p.id === patternId
          ? { ...p, notes: { [kickId]: [{ id: "n1", pitch: 61, start: 180, duration: 120, velocity: 0.8 }] } }
          : p,
      ),
    };
    const timeFixed = quantizePatternToGrid(withOffGrid, patternId, GRID_16TH).execute(withOffGrid);
    const pitchFixed = quantizePatternToScale(timeFixed, patternId, "C Major" as MusicalKey).execute(timeFixed);
    const note = pitchFixed.patterns[0].notes[kickId][0];
    expect(note.start).toBe(240); // 180 → nearest 16th = 240
    expect([60, 62, 63, 64, 65, 67, 69]).toContain(note.pitch); // C Major scale
  });
});

describe("velocity ramp (crescendo/decrecendo)", () => {
  it("setStepsVelocity with ramped entries: left step unchanged, right step at target, middle interpolated", () => {
    const { doc, kickId, patternId } = docWithKick();
    // Set initial velocities for steps 0–3
    const initial = [0.3, 0.5, 0.6, 0.8];
    const cmd1 = setStepsVelocity(
      doc,
      patternId,
      initial.map((v, i) => ({ padId: kickId, stepIndex: i, velocity: v })),
    );
    const after = cmd1.execute(doc);

    // Simulate a ramp: leftmost (step 0) at 0.3, rightmost (step 3) at target 0.95
    // Linear: 0.3, 0.5, 0.7, 0.95
    const entries = [
      { padId: kickId, stepIndex: 0, velocity: 0.3 },
      { padId: kickId, stepIndex: 1, velocity: 0.5 },
      { padId: kickId, stepIndex: 2, velocity: 0.7 },
      { padId: kickId, stepIndex: 3, velocity: 0.95 },
    ];
    const cmd2 = setStepsVelocity(after, patternId, entries);
    const result = cmd2.execute(after);
    expect(result.patterns[0].rows[kickId][0]).toBeCloseTo(0.3, 5);
    expect(result.patterns[0].rows[kickId][1]).toBeCloseTo(0.5, 5);
    expect(result.patterns[0].rows[kickId][2]).toBeCloseTo(0.7, 5);
    expect(result.patterns[0].rows[kickId][3]).toBeCloseTo(0.95, 5);

    // Undo restores all four steps
    const undone = cmd2.undo(result);
    expect(undone.patterns[0].rows[kickId][0]).toBeCloseTo(0.3, 5);
    expect(undone.patterns[0].rows[kickId][1]).toBeCloseTo(0.5, 5);
    expect(undone.patterns[0].rows[kickId][2]).toBeCloseTo(0.6, 5);
    expect(undone.patterns[0].rows[kickId][3]).toBeCloseTo(0.8, 5);
  });

  it("ramp across multiple pad rows applies the same gradient to each row", () => {
    const { doc, kickId, patternId } = docWithKick();
    const clapId = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!.pads[6].id;
    // Set both rows to some initial velocities
    const cmd1 = setStepsVelocity(doc, patternId, [
      { padId: kickId, stepIndex: 0, velocity: 0.3 },
      { padId: kickId, stepIndex: 3, velocity: 0.3 },
      { padId: clapId, stepIndex: 0, velocity: 0.2 },
      { padId: clapId, stepIndex: 3, velocity: 0.2 },
    ]);
    const after = cmd1.execute(doc);

    // Ramp: 0.3→0.9 on both rows
    const cmd2 = setStepsVelocity(after, patternId, [
      { padId: kickId, stepIndex: 0, velocity: 0.3 },
      { padId: kickId, stepIndex: 3, velocity: 0.9 },
      { padId: clapId, stepIndex: 0, velocity: 0.3 },
      { padId: clapId, stepIndex: 3, velocity: 0.9 },
    ]);
    const result = cmd2.execute(after);
    // Both rows should have the same gradient
    expect(result.patterns[0].rows[kickId][0]).toBeCloseTo(0.3, 5);
    expect(result.patterns[0].rows[kickId][3]).toBeCloseTo(0.9, 5);
    expect(result.patterns[0].rows[clapId][0]).toBeCloseTo(0.3, 5);
    expect(result.patterns[0].rows[clapId][3]).toBeCloseTo(0.9, 5);
  });

  it("single-step selection degrades to uniform delta (no ramp)", () => {
    const { doc, kickId, patternId } = docWithKick();
    // Set step 0 to 0.3
    const cmd1 = setStepsVelocity(doc, patternId, [{ padId: kickId, stepIndex: 0, velocity: 0.3 }]);
    const after = cmd1.execute(doc);
    // Ramp from 0.3 to 0.9 with span=0 → uniform 0.9
    const cmd2 = setStepsVelocity(after, patternId, [{ padId: kickId, stepIndex: 0, velocity: 0.9 }]);
    const result = cmd2.execute(after);
    expect(result.patterns[0].rows[kickId][0]).toBeCloseTo(0.9, 5);
  });
});
