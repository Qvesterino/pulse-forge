import { describe, expect, it } from "vitest";
import { extractGroove } from "../src/audio-engine/groove-extract";
import { createDefaultProject } from "../src/project-model/schema";
import { addAudioClip, stealGrooveIntoPattern } from "../src/commands/commands";
import { getDrumTrack } from "../src/project-model/types";

const SR = 44100;

/** Click loop with controllable per-16th timing (in steps) and levels. */
function makeLoop(bpm: number, events: Array<{ step: number; lateSteps?: number; level?: number }>, bars = 1) {
  const steps = bars * 16;
  const stepSec = 60 / bpm / 4;
  const length = Math.floor(bars * 16 * stepSec * SR);
  const out = new Float32Array(length);
  for (const ev of events) {
    const t = (ev.step + (ev.lateSteps ?? 0)) * stepSec * SR;
    const start = Math.floor(t);
    const level = ev.level ?? 0.9;
    for (let i = 0; i < Math.floor(SR * 0.02); i++) {
      const idx = start + i;
      if (idx >= length) break;
      out[idx] = Math.max(out[idx], Math.sin((2 * Math.PI * 800 * i) / SR) * Math.exp(-i / (SR * 0.003)) * level);
    }
  }
  void steps;
  return out;
}

describe("extractGroove", () => {
  it("finds late offbeat hits as positive timing (swung loop)", () => {
    // Straight kicks on beats, swung 8ths off the grid by +0.08 step.
    const loop = makeLoop(120, [
      { step: 0 },
      { step: 4 },
      { step: 8 },
      { step: 12 },
      { step: 2, lateSteps: 0.17, level: 0.5 },
      { step: 6, lateSteps: 0.17, level: 0.5 },
      { step: 10, lateSteps: 0.17, level: 0.5 },
      { step: 14, lateSteps: 0.17, level: 0.5 },
    ]);
    const map = extractGroove(loop, SR, 120, 16);
    expect(map).not.toBeNull();
    // Odd steps carry the late hats; even steps sit on the grid.
    expect(map!.timing[2]).toBeGreaterThan(0.1);
    expect(Math.abs(map!.timing[0])).toBeLessThan(0.3);
    // Accents: kicks (level 0.9) louder than hats (0.5).
    expect(map!.accent[0]).toBeGreaterThan(map!.accent[2]);
    expect(map!.swing).toBeGreaterThan(0);
  });

  it("returns null for silence and too-short input", () => {
    expect(extractGroove(new Float32Array(SR * 4), SR, 120)).toBeNull();
    expect(extractGroove(makeLoop(120, [{ step: 0 }]), SR, 120)).toBeNull(); // a single hit is not a groove
  });
});

describe("stealGrooveIntoPattern", () => {
  function docWithPattern() {
    const doc = createDefaultProject();
    const drum = getDrumTrack(doc);
    const patternId = doc.activePatternId;
    return { doc, drum, patternId };
  }

  it("writes microtiming onto active steps and preserves locks", () => {
    const { doc, drum, patternId } = docWithPattern();
    const kick = drum.pads[0].id;
    // Activate steps 0 and 2 with some velocity.
    const withSteps = {
      ...doc,
      patterns: doc.patterns.map((p) =>
        p.id === patternId ? { ...p, rows: { ...p.rows, [kick]: [0.8, 0, 0.6, 0] } } : p,
      ),
    };
    const map = {
      timing: [0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      accent: [0.2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    const next = stealGrooveIntoPattern(withSteps, patternId, map, { applyVelocity: true }).execute(withSteps);
    const p = next.patterns.find((x) => x.id === patternId)!;
    expect(p.stepMeta?.[kick]?.[0]?.microtiming).toBeCloseTo(0, 4);
    expect(p.stepMeta?.[kick]?.[2]?.microtiming).toBeCloseTo(0.5, 4);
    // Accent 1 on step 2 pushes velocity up; accent 0.2 pulls step 0 down.
    expect(p.rows[kick][2]).toBeCloseTo(0.6, 4);
    expect(p.rows[kick][0]).toBeLessThan(0.8);
    // Inactive step 1 gets no meta row.
    expect(p.stepMeta?.[kick]?.[1]?.microtiming).toBeUndefined();
  });

  it("undo restores the original rows and stepMeta", () => {
    const { doc, drum, patternId } = docWithPattern();
    const kick = drum.pads[0].id;
    const withSteps = {
      ...doc,
      patterns: doc.patterns.map((p) =>
        p.id === patternId ? { ...p, rows: { ...p.rows, [kick]: [0.8, 0, 0, 0] } } : p,
      ),
    };
    const command = stealGrooveIntoPattern(
      withSteps,
      patternId,
      { timing: new Array(16).fill(0.5), accent: new Array(16).fill(1) },
      {},
    );
    const next = command.execute(withSteps);
    const undone = command.undo(next);
    expect(undone.patterns.find((x) => x.id === patternId)!.rows[kick][0]).toBe(0.8);
    expect(undone.patterns.find((x) => x.id === patternId)!.stepMeta?.[kick]?.[0]).toBeUndefined();
  });

  it("throws on a groove-less pattern and an invalid map", () => {
    const empty = createDefaultProject();
    const emptyPatternId = empty.activePatternId;
    const grooveless = {
      ...empty,
      patterns: empty.patterns.map((p) =>
        p.id === emptyPatternId
          ? { ...p, rows: Object.fromEntries(Object.keys(p.rows).map((k) => [k, new Array(16).fill(0)])) }
          : p,
      ),
    };
    const flat = createDefaultProject();
    expect(() =>
      stealGrooveIntoPattern(grooveless, emptyPatternId, {
        timing: new Array(16).fill(0),
        accent: new Array(16).fill(0),
      }),
    ).toThrow(/no active steps/u);
    expect(() => stealGrooveIntoPattern(flat, flat.activePatternId, { timing: [], accent: [] })).toThrow(
      /Invalid groove map/u,
    );
    expect(() => addAudioClip(flat, "t", "", 0, 1)).toThrow(); // sanity: commands still throw normally
  });
});
