import { describe, expect, it } from "vitest";
import {
  applyAssistPatchToStepSelection,
  classifyPads,
  humanizeNoteSelection,
  thinStepSelection,
  varyPattern,
  expandWithBuild,
  replaceRows,
  makeFill,
  styleNames,
} from "../src/assist/patternOps";
import { assistBuild, assistFill, assistReplace, assistVary } from "../src/commands/commands";
import {
  assistThinSelectionCommand,
  assistVaryNoteSelectionCommand,
  assistVarySelectionCommand,
} from "../src/commands/assistSelectionCommands";
import { parseSelectedStepIntent } from "../src/assist/selected-step-intent";
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

describe("selection-scoped assist", () => {
  it("changes only selected pad cells and retains step metadata outside the selection", () => {
    const { pattern, track, kickPad, snarePad } = setup();
    const withMeta: Pattern = {
      ...pattern,
      stepMeta: {
        [kickPad.id]: { 1: { microtiming: 0.1 }, 8: { microtiming: -0.1 } },
        [snarePad.id]: { 5: { microtiming: 0.05 } },
      },
    };
    const patch = varyPattern(withMeta, track.pads, "selected-seed", 0.6);
    const scope = { padIds: [kickPad.id], from: 0, to: 3 };
    const scoped = applyAssistPatchToStepSelection(withMeta, patch, scope);

    for (const pad of track.pads) {
      for (let step = 0; step < withMeta.stepCount; step++) {
        const selected = pad.id === kickPad.id && step >= scope.from && step <= scope.to;
        expect(scoped.rows[pad.id]?.[step]).toBe(selected ? patch.rows[pad.id]?.[step] : withMeta.rows[pad.id]?.[step]);
      }
    }
    expect(scoped.stepMeta?.[kickPad.id]?.[8]).toEqual(withMeta.stepMeta?.[kickPad.id]?.[8]);
    expect(scoped.stepMeta?.[snarePad.id]).toEqual(withMeta.stepMeta?.[snarePad.id]);
    expect(scoped.notes).toEqual(withMeta.notes);
    expect(scoped.stepCount).toBe(withMeta.stepCount);
    expect(
      applyAssistPatchToStepSelection(withMeta, patch, {
        padIds: [kickPad.id],
        from: withMeta.stepCount,
        to: withMeta.stepCount + 4,
      }),
    ).toBe(withMeta);
  });

  it("parses scoped humanize/thin actions in English and Slovak and rejects mixed requests", () => {
    expect(parseSelectedStepIntent("make selected hats sparser")).toEqual({ operation: "thin", target: "hats" });
    expect(parseSelectedStepIntent("redšie vybrané haty")).toEqual({ operation: "thin", target: "hats" });
    expect(parseSelectedStepIntent("make selected hats less dense")).toEqual({ operation: "thin", target: "hats" });
    expect(parseSelectedStepIntent("humanize these steps")).toEqual({ operation: "humanize", target: null });
    expect(parseSelectedStepIntent("thin hats and snares, then move the drop")).toBeNull();
    expect(parseSelectedStepIntent("make selected hats brighter")).toBeNull();
    expect(parseSelectedStepIntent("make it sparser")).toBeNull();
  });

  it("thins only selected off-beat cells, preserves anchors, and removes metadata for deleted hits", () => {
    const { doc, pattern, track, kickPad } = setup();
    const hatPad = classifyPads(track.pads).hats[0]!;
    const hatRow = Array.from({ length: pattern.stepCount }, (_, step) =>
      step < 8 ? (step % 4 === 0 ? 0.9 : 0.4 + step * 0.02) : 0,
    );
    const source: Pattern = {
      ...pattern,
      rows: { ...pattern.rows, [hatPad.id]: hatRow },
      stepMeta: {
        [hatPad.id]: {
          1: { microtiming: 0.1 },
          2: { locks: { pitch: 3 } },
          10: { microtiming: -0.1 },
        },
      },
    };
    const scope = { padIds: [hatPad.id], from: 0, to: 7 };
    const thinned = thinStepSelection(source, scope);

    expect(thinned.rows[hatPad.id]?.[0]).toBe(0.9);
    expect(thinned.rows[hatPad.id]?.[4]).toBe(0.9);
    expect(thinned.rows[hatPad.id]?.filter((velocity, step) => step < 8 && velocity > 0)).toHaveLength(6);
    expect(thinned.rows[kickPad.id]).toEqual(source.rows[kickPad.id]);
    expect(thinned.rows[hatPad.id]?.slice(8)).toEqual(source.rows[hatPad.id]?.slice(8));
    expect(thinned.stepMeta?.[hatPad.id]?.[1]).toBeUndefined();
    expect(thinned.stepMeta?.[hatPad.id]?.[2]).toBeUndefined();
    expect(thinned.stepMeta?.[hatPad.id]?.[10]).toEqual(source.stepMeta?.[hatPad.id]?.[10]);

    const withSource: typeof doc = {
      ...doc,
      patterns: doc.patterns.map((candidate) => (candidate.id === pattern.id ? source : candidate)),
    };
    const command = assistThinSelectionCommand(withSource, pattern.id, track.id, scope);
    const next = command.execute(withSource);
    expect(command.type).toBe("assistThinSelection");
    expect(command.undo(next)).toEqual(withSource);
    expect(next.patterns.find((candidate) => candidate.id === pattern.id)?.rows[hatPad.id]).toEqual(
      thinned.rows[hatPad.id],
    );
  });

  it("humanizes only selected notes and preserves every other note field and track", () => {
    const { doc, pattern } = setup();
    const targetTrack = doc.tracks.find((track) => track.kind !== "group")!;
    const otherTrack = doc.tracks.find((track) => track.id !== targetTrack.id)!;
    const selectedNote = {
      id: "selected-note",
      pitch: 64,
      start: 480,
      duration: 180,
      velocity: 0.72,
      locks: { cutoff: 0.4 },
    };
    const unselectedNote = { id: "unselected-note", pitch: 67, start: 720, duration: 120, velocity: 0.6 };
    const otherTrackNote = { id: "other-track-note", pitch: 48, start: 240, duration: 240, velocity: 0.8 };
    const withNotes: Pattern = {
      ...pattern,
      notes: {
        ...pattern.notes,
        [targetTrack.id]: [unselectedNote, selectedNote],
        [otherTrack.id]: [otherTrackNote],
      },
    };
    const scope = [{ trackId: targetTrack.id, noteIds: [selectedNote.id] }];
    const varied = humanizeNoteSelection(withNotes, scope, "note-scope-seed", 0.8);
    const repeated = humanizeNoteSelection(withNotes, scope, "note-scope-seed", 0.8);
    const changed = varied.notes[targetTrack.id]!.find((note) => note.id === selectedNote.id)!;

    expect(varied).toEqual(repeated);
    expect(changed).toMatchObject({
      id: selectedNote.id,
      pitch: selectedNote.pitch,
      duration: selectedNote.duration,
      locks: selectedNote.locks,
    });
    expect(varied.notes[targetTrack.id]![0]).toEqual(unselectedNote);
    expect(varied.notes[otherTrack.id]).toEqual([otherTrackNote]);
    expect(humanizeNoteSelection(withNotes, [{ trackId: targetTrack.id, noteIds: ["stale-id"] }], "seed")).toBe(
      withNotes,
    );

    const withDoc: typeof doc = {
      ...doc,
      patterns: doc.patterns.map((candidate) => (candidate.id === pattern.id ? withNotes : candidate)),
    };
    const command = assistVaryNoteSelectionCommand(withDoc, pattern.id, scope, "note-scope-seed", 0.8);
    const next = command.execute(withDoc);
    expect(command.type).toBe("assistVaryNoteSelection");
    expect(command.undo(next)).toEqual(withDoc);
    expect(next.patterns.find((candidate) => candidate.id === pattern.id)?.notes[targetTrack.id]).toEqual(
      varied.notes[targetTrack.id],
    );
  });

  it("round-trips the scoped variation through one command and leaves other roles untouched", () => {
    const { doc, pattern, track, kickPad, snarePad } = setup();
    const command = assistVarySelectionCommand(
      doc,
      pattern.id,
      track.id,
      { padIds: [kickPad.id], from: 0, to: 3 },
      "selected-command-seed",
      0.6,
    );
    const changed = command.execute(doc);
    const changedPattern = changed.patterns.find((candidate) => candidate.id === pattern.id)!;

    expect(command.type).toBe("assistVarySelection");
    expect(command.undo(changed)).toEqual(doc);
    expect(changedPattern.rows[snarePad.id]).toEqual(pattern.rows[snarePad.id]);
    for (let step = 4; step < pattern.stepCount; step++) {
      expect(changedPattern.rows[kickPad.id]?.[step]).toBe(pattern.rows[kickPad.id]?.[step]);
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
