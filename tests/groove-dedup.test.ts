/**
 * Groove library near-duplicate guard.
 *
 * Two parallel sessions once added `house.reggaeton` + `house.afrobeats` for
 * lanes another session had already filled with `house.dembow` +
 * `house.afropop`, leaving two of the four unreachable. See dedup.ts for why
 * "similar BPM" is NOT a defect (619 such pairs exist on purpose) and why
 * these two rules are narrow instead.
 */
import { describe, expect, it } from "vitest";
import { GROOVE_LIBRARY, getGrooveById } from "../src/ai/grooves/index";
import { findGrooveDuplicates, windowOverlap } from "../src/ai/grooves/dedup";
import { parseIntentText } from "../src/intent/text-parser";
import type { GrooveData } from "../src/ai/types";

describe("groove library integrity", () => {
  it("every groove id is unique", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const g of GROOVE_LIBRARY) {
      if (seen.has(g.id)) dupes.push(g.id);
      seen.add(g.id);
    }
    expect(dupes).toEqual([]);
  });

  it("every groove carries a usable tempo window and a name", () => {
    const bad: string[] = [];
    for (const g of GROOVE_LIBRARY) {
      const [lo, hi] = g.bpm;
      if (!(lo > 0 && hi > lo) || !g.name.trim() || !Number.isFinite(g.swing)) bad.push(g.id);
    }
    expect(bad).toEqual([]);
  });

  it("has no near-duplicate grooves", () => {
    const findings = findGrooveDuplicates();
    // A finding here is always a real editorial question, so the ids and the
    // reason are printed in full rather than collapsed to a count.
    const report = findings.map(
      (f) => `${f.severity}: ${f.a.id} ~ ${f.b.id} — ${f.reason} (${(f.overlap * 100).toFixed(0)}%)`,
    );
    expect(report).toEqual([]);
  });
});

describe("near-duplicate detection rules", () => {
  const groove = (id: string, bpm: [number, number], swing: number, activePads: number[] = [0, 8]): GrooveData =>
    ({ id, genre: "house", name: id, bpm, swing, activePads, patterns: [{}] }) as unknown as GrooveData;

  it("flags an identical window, swing AND kit", () => {
    const findings = findGrooveDuplicates([
      groove("house.a", [120, 126], 0.1, [0, 1, 6]),
      groove("house.b", [120, 126], 0.1, [0, 1, 6]),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toContain("active pads");
  });

  it("does not flag identical tempo when the kit differs", () => {
    // The real shape of house.dancefloor ~ house.progressive and
    // house.basshouse ~ hybrid.techhouse in this library: same tempo, same
    // swing, different pads. Legitimate siblings, not duplicates.
    const findings = findGrooveDuplicates([
      groove("house.dancefloor", [124, 128], 0.04, [0, 1, 6, 8, 10]),
      groove("house.progressive", [124, 128], 0.04, [0, 3, 7, 8, 10, 14]),
    ]);
    expect(findings).toEqual([]);
  });

  it("does not flag identical windows and kit with a different swing", () => {
    // Same tempo and same kit, straight vs swung — a legitimate contrast.
    const findings = findGrooveDuplicates([
      groove("house.a", [120, 126], 0.0, [0, 1, 6]),
      groove("house.b", [120, 126], 0.22, [0, 1, 6]),
    ]);
    expect(findings).toEqual([]);
  });

  it("does not flag cross-genre pairs", () => {
    const a = groove("house.a", [120, 126], 0.1);
    const b = { ...groove("techno.b", [120, 126], 0.1), genre: "techno" } as GrooveData;
    expect(findGrooveDuplicates([a, b])).toEqual([]);
  });

  it("does NOT flag a contained window when the narrower groove is merely unreferenced", () => {
    // Regression lock for a rule that was written, measured, and removed.
    // "Narrow window inside a wide one + no artist preset" sounds like the
    // duplicate signature, but unreferenced is the normal state of a groove
    // that landed before anyone wrote its artists. Measured on the live
    // library that rule produced 40 findings, all of them false positives
    // (house.synthpop and house.amapiano were each flagged against ten wider
    // lanes). A contained unreferenced groove is just a sub-lane.
    const wide = groove("house.wide", [100, 140], 0.1);
    const narrow = groove("house.someunreferencedlane", [120, 126], 0.1);
    expect(findGrooveDuplicates([wide, narrow])).toEqual([]);
  });

  it("still flags a contained window when BOTH grooves are unreferenced twins", () => {
    // Identical window + identical swing is the only shape that counts, and it
    // counts regardless of reachability — the engine cannot tell them apart.
    const a = groove("house.unreferenceda", [120, 126], 0.08);
    const b = groove("house.unreferencedb", [120, 126], 0.08);
    const findings = findGrooveDuplicates([a, b]);
    expect(findings).toHaveLength(1);
    expect(findings[0].bIsUnreferenced).toBe(true);
  });

  it("computes window overlap against the narrower window", () => {
    // Contained entirely → 1.0 regardless of how much wider the other is.
    expect(windowOverlap([100, 140], [120, 126])).toBeCloseTo(1, 6);
    expect(windowOverlap([100, 130], [120, 140])).toBeCloseTo(0.5, 6); // 10 of the narrower 20
    expect(windowOverlap([100, 110], [120, 126])).toBe(0);
  });
});

describe("groove id reachability", () => {
  /**
   * The `trap.reggae` hole: the parser started emitting `style: "reggae"`
   * before the groove existed, so a user typing "reggae" got a random trap
   * pocket instead of a dancehall one. `resolveGroove*` treats an unknown
   * style as "no style" and falls through, so nothing crashes — it just
   * quietly returns the wrong lane. Black-box on purpose: it exercises the
   * public parser rather than a private phrase table, so it stays valid
   * across refactors and needs no export from text-parser.
   */
  const PHRASES = ["reggae", "ska", "shoegaze", "dream pop", "post rock", "synthwave", "boogie", "breakcore"];

  it("every probed phrase resolves to a real groove", () => {
    const dangling: string[] = [];
    for (const text of PHRASES) {
      const { genre, style } = parseIntentText(text).input;
      if (!genre || !style) continue;
      const id = `${genre}.${style.replace(/\s+/g, "")}`;
      if (!getGrooveById(id)) dangling.push(`"${text}" -> ${id}`);
    }
    expect(dangling).toEqual([]);
  });
});
