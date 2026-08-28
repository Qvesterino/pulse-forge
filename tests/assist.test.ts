import { describe, expect, it } from "vitest";
import {
  classifyPads,
  varyPattern,
  expandWithBuild,
  replaceRows,
  makeFill,
  styleNames,
} from "../src/assist/patternOps";
import { assistBuild, assistFill, assistReplace, assistVary } from "../src/commands/commands";
import { createDefaultProject } from "../src/project-model/schema";
import { getActivePattern, getDrumTrack } from "../src/project-model/types";
import type { Pattern } from "../src/project-model/types";

function setup(patternOverrides: Partial<Pattern> = {}) {
  const doc = createDefaultProject();
  const track = getDrumTrack(doc);
  const pattern: Pattern = { ...getActivePattern(doc), ...patternOverrides };
  // Give the pattern some content: kick on every beat, snare backbeat.
  const kickPad = track.pads.find((p) => /kick/i.test(p.name))!;
  const snarePad = track.pads.find((p) => /snare/i.test(p.name))!;
  const rows = { ...pattern.rows };
  rows[kickPad.id] = Array.from({ length: pattern.stepCount }, (_, i) => (i % 4 === 0 ? 0.9 : 0));
  rows[snarePad.id] = Array.from({ length: pattern.stepCount }, (_, i) => (i % 8 === 4 ? 0.8 : 0));
  return {
    doc: { ...doc, patterns: doc.patterns.map((p) => (p.id === pattern.id ? { ...pattern, rows } : p)) },
    track,
    pattern: { ...pattern, rows },
    kickPad,
    snarePad,
  };
}

describe("classifyPads", () => {
  it("sorts the factory kit into families", () => {
    const { track } = setup();
    const fams = classifyPads(track.pads);
    expect(fams.kicks.length).toBeGreaterThanOrEqual(2);
    expect(fams.snares.length).toBeGreaterThanOrEqual(2);
    expect(fams.hats.length).toBeGreaterThanOrEqual(2);
    expect(fams.kicks.every((p) => /kick|808/i.test(p.name))).toBe(true);
  });
});

describe("varyPattern", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const { pattern, track } = setup();
    const a1 = varyPattern(pattern, track.pads, "abc");
    const a2 = varyPattern(pattern, track.pads, "abc");
    const b = varyPattern(pattern, track.pads, "xyz");
    expect(a1.rows).toEqual(a2.rows);
    expect(JSON.stringify(a1.rows)).not.toBe(JSON.stringify(b.rows));
  });

  it("keeps hit positions (varies velocities, adds at most ghosts)", () => {
    const { pattern, track, kickPad } = setup();
    const varied = varyPattern(pattern, track.pads, "s1", 0.6);
    const original = pattern.rows[kickPad.id];
    const after = varied.rows[kickPad.id];
    for (let i = 0; i < original.length; i++) {
      if (original[i] > 0)
        expect(after[i]).toBeGreaterThan(0); // never removes kicks (non-snare)
      else if (after[i] > 0) expect(after[i]).toBeLessThanOrEqual(0.35); // only ghost-level additions
    }
  });
});

describe("expandWithBuild", () => {
  it("produces bars×16 steps with a density and energy ramp", () => {
    const { pattern, track } = setup();
    const bars = 4;
    const built = expandWithBuild(pattern, track.pads, bars, "s2");
    expect(built.stepCount).toBe(bars * 16);
    const hats = classifyPads(track.pads).hats;
    // Give hats content in the source so they exist in the build.
    const hatPad = hats[0];
    const withHats: Pattern = {
      ...pattern,
      rows: {
        ...pattern.rows,
        [hatPad.id]: Array.from({ length: pattern.stepCount }, (_, i) => (i % 2 === 0 ? 0.5 : 0)),
      },
    };
    const built2 = expandWithBuild(withHats, track.pads, bars, "s2");
    const hatRow = built2.rows[hatPad.id];
    const energyOf = (bar: number) => {
      let sum = 0;
      for (let i = bar * 16; i < bar * 16 + 16; i++) sum += hatRow[i];
      return sum;
    };
    // Kick plays from bar 0; hats join later — early bars have no hat energy.
    expect(energyOf(0)).toBe(0);
    expect(energyOf(bars - 1)).toBeGreaterThan(0);
    // Energy ramps: last bar at least as hot as the first active one.
    const firstActive = built2.rows[hatPad.id].findIndex((v) => v > 0);
    const firstBar = Math.floor(firstActive / 16);
    expect(energyOf(bars - 1)).toBeGreaterThanOrEqual(energyOf(firstBar));
  });
});

describe("replaceRows", () => {
  it("changes only the target family and tiles the style groove", () => {
    const { pattern, track, kickPad } = setup();
    const kickRowBefore = [...pattern.rows[kickPad.id]];
    const hats = classifyPads(track.pads).hats;
    const withHats: Pattern = {
      ...pattern,
      rows: { ...pattern.rows, [hats[0].id]: Array.from({ length: pattern.stepCount }, () => 0.3) },
    };
    const patch = replaceRows(withHats, track.pads, "hats", "house", "s3");
    // Kick untouched.
    expect(patch.rows[kickPad.id]).toEqual(kickRowBefore);
    // House = offbeat 8ths: steps 2, 6, 10, 14 per bar.
    const hatRow = patch.rows[hats[0].id];
    expect(hatRow[2]).toBeGreaterThan(0.5);
    expect(hatRow[6]).toBeGreaterThan(0.5);
    expect(hatRow[0]).toBe(0);
    expect(hatRow[1]).toBe(0);
    expect(styleNames("hats")).toContain("trap");
    expect(styleNames("kicks")).toContain("four-on-floor");
  });
});

describe("makeFill", () => {
  it("clears and rebuilds only the last bar with a crescendo", () => {
    const { pattern, track, snarePad } = setup();
    const filled = makeFill(pattern, track.pads, "s4");
    const row = filled.rows[snarePad.id];
    const start = pattern.stepCount - 16;
    // Before the fill zone: untouched backbeat.
    for (let i = 0; i < start; i++) expect(row[i]).toBe(pattern.rows[snarePad.id][i]);
    // Inside: crescendo — last hits louder than first hits.
    const early = row[start + 4] ?? 0;
    const final = row[start + 15] ?? 0;
    expect(final).toBeGreaterThan(early);
    expect(final).toBeGreaterThan(0.8);
  });
});

describe("assist commands", () => {
  it("vary/build/replace/fill round-trip through execute + undo", () => {
    const { doc, pattern } = setup();
    const step = (cmd: ReturnType<typeof assistVary>) => {
      const next = cmd.execute(doc);
      const undone = cmd.undo(next);
      return { next, undone };
    };
    expect(step(assistVary(doc, pattern.id, "a", 0.6)).undone).toEqual(doc);
    expect(step(assistBuild(doc, pattern.id, 4, "b")).next.patterns.find((p) => p.id === pattern.id)!.stepCount).toBe(
      64,
    );
    expect(step(assistReplace(doc, pattern.id, "hats", "house", "c")).undone).toEqual(doc);
    expect(step(assistFill(doc, pattern.id, "d")).undone).toEqual(doc);
  });
});
