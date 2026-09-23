import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { applyPatternVerbsCommand } from "../src/commands/commands";
import { parsePatternVerbs, applyVerbRows } from "../src/intent/pattern-verbs";
import type { DrumTrack, Pattern, ProjectDocument } from "../src/project-model/types";

/**
 * PATTERN-DIFF VERBS audit (vibe-code wave 1): "fewer hats", "menej
 * hi-hatov", "denser snare", "add ghosts", "simplify", "swing it" — edit
 * the pattern you're hearing, in place, ONE undo step, deterministic.
 *
 * Invariants:
 *  V1  parser: EN + SK (de-accented), family resolution, junk → null
 *  V2  rows never fully empty (family anchor survives)
 *  V3  ops are deterministic per (pattern, verbs)
 *  V4  swing composes into doc.groove, clamped, rows untouched
 *  V5  one snapshot command: exact undo restore
 *  V6  downbeat anchors survive thin
 */

const docWithPattern = (): { doc: ProjectDocument; pattern: Pattern; drum: DrumTrack } => {
  const doc = createProjectFromTemplate("house");
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId)!;
  const drum = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
  // Deterministic seed pattern: kick on 0/8, hat on 4/12, snare on 8.
  const rows: Record<string, number[]> = {};
  for (const pad of drum.pads) {
    const row = new Array(pattern.stepCount).fill(0);
    const name = pad.name.toLowerCase();
    if (name.includes("kick") || name.includes("808")) {
      row[0] = 0.95;
      row[8] = 0.9;
    } else if (name.includes("hat")) {
      row[4] = 0.8;
      row[12] = 0.75;
    } else if (name.includes("snare") || name.includes("clap")) {
      row[8] = 0.85;
    }
    rows[pad.id] = row;
  }
  const seeded: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) => (p.id === pattern.id ? { ...p, rows } : p)),
  };
  return { doc: seeded, pattern, drum };
};

describe("parsePatternVerbs", () => {
  it("parses EN verbs with family targets", () => {
    const parse = parsePatternVerbs("fewer hats and add ghosts")!;
    expect(parse.verbs).toContainEqual({ kind: "thin", family: "hats" });
    expect(parse.verbs).toContainEqual({ kind: "ghosts", family: "hats" }); // "hats" earlier in the sentence scopes the ghosts
  });

  it("parses SK verbs de-accented (menej hi-hatov, hustejsi snare, hojdat)", () => {
    const parse = parsePatternVerbs("menej hi hatov a hustejsi snare a hojdat")!;
    expect(parse.verbs).toContainEqual({ kind: "thin", family: "hats" });
    expect(parse.verbs).toContainEqual({ kind: "densify", family: "snares" });
    expect(parse.verbs).toContainEqual({ kind: "swing", family: "all" });
  });

  it("thin without any family word → null (too destructive to guess)", () => {
    expect(parsePatternVerbs("fewer things please")).toBeNull();
  });

  it("no verbs → null (generation falls through)", () => {
    expect(parsePatternVerbs("dark rolling techno at 140")).toBeNull();
  });
});

describe("applyVerbRows", () => {
  it("thin removes some non-downbeat hits but keeps the family anchor", () => {
    const { pattern, drum } = docWithPattern();
    const hatPad = drum.pads.find((p) => p.name.toLowerCase().includes("hat"))!;
    const before = pattern.rows[hatPad.id]!.filter((v) => v > 0).length;
    const { rows } = applyVerbRows(pattern, drum.pads, [{ kind: "thin", family: "hats" }], "t1");
    const after = rows[hatPad.id]!.filter((v) => v > 0).length;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(1); // anchor survives
    expect(rows[hatPad.id]![0]).toBe(0); // downbeat stays silent here (was never a hit)
  });

  it("densify adds hits; ghosts add quiet off-beats", () => {
    const { pattern, drum } = docWithPattern();
    const hatPad = drum.pads.find((p) => p.name.toLowerCase().includes("hat"))!;
    const beforeActive = pattern.rows[hatPad.id]!.filter((v) => v > 0).length;
    const densified = applyVerbRows(pattern, drum.pads, [{ kind: "densify", family: "hats" }], "t2");
    const afterActive = densified.rows[hatPad.id]!.filter((v) => v > 0).length;
    expect(afterActive).toBeGreaterThan(beforeActive);
    const ghosted = applyVerbRows(pattern, drum.pads, [{ kind: "ghosts", family: "hats" }], "t3");
    const ghostRow = ghosted.rows[hatPad.id]!;
    const ghosts = ghostRow.filter((v) => v > 0 && v <= 0.35);
    expect(ghosts.length).toBeGreaterThan(0);
  });

  it("is deterministic: same pattern + verbs + seed → identical rows", () => {
    const { pattern, drum } = docWithPattern();
    const a = applyVerbRows(pattern, drum.pads, [{ kind: "ghosts", family: "snares" }], "seed-x");
    const b = applyVerbRows(pattern, drum.pads, [{ kind: "ghosts", family: "snares" }], "seed-x");
    expect(a.rows).toEqual(b.rows);
  });
});

describe("applyPatternVerbsCommand", () => {
  it("edits rows in place as ONE undoable snapshot", () => {
    const { doc, pattern, drum } = docWithPattern();
    const hatPad = drum.pads.find((p) => p.name.toLowerCase().includes("hat"))!;
    const cmd = applyPatternVerbsCommand(doc, pattern.id, [{ kind: "thin", family: "hats" }], "cmd");
    const next = cmd.execute(doc);
    expect(next.patterns.find((p) => p.id === pattern.id)!.rows[hatPad.id]).not.toEqual(
      pattern.rows[hatPad.id],
    );
    expect(cmd.undo(next)).toEqual(doc);
  });

  it("swing composes into doc.groove, clamped at 0.6, rows untouched", () => {
    const { doc, pattern, drum } = docWithPattern();
    const hatPad = drum.pads.find((p) => p.name.toLowerCase().includes("hat"))!;
    const baseSwing = doc.groove?.swing ?? 0;
    const rowsBefore = doc.patterns.find((p) => p.id === pattern.id)!.rows[hatPad.id];
    const cmd = applyPatternVerbsCommand(doc, pattern.id, [{ kind: "swing", family: "all" }], "s");
    const next = cmd.execute(doc);
    const expectedSwing = Math.min(0.6, Math.round((baseSwing + 0.12) * 100) / 100);
    expect(next.groove?.swing).toBeCloseTo(expectedSwing, 5);
    expect(next.patterns.find((p) => p.id === pattern.id)!.rows[hatPad.id]).toEqual(rowsBefore);
  });

  it("unknown pattern throws", () => {
    const { doc } = docWithPattern();
    expect(() =>
      applyPatternVerbsCommand(doc, "pattern-nope", [{ kind: "thin", family: "hats" }]),
    ).toThrow(/not found/);
  });
});
