/**
 * AUDIT 17 — the arrangement's bar grid and the scheduler's bar grid are two
 * different lengths, and no single decision has been made about which wins.
 *
 * Reproduced (this spec is the reproduction):
 *
 *   meter  ticksPerBar(doc)  BAR_TICKS  clip @bar2  downbeat @bar3  delta
 *   4/4         1920          1920         3840         3840          0
 *   3/4         1440          1920         3840         2880        960
 *   6/8         1440          1920         3840         2880        960
 *
 * 960 ticks is two beats: on a non-4/4 document an audio clip placed at bar 2
 * plays two beats later than the bar-2 downbeat the metronome clicks.
 *
 * WHY THIS SPEC DOES NOT ASSERT A FIX: there is no safe local one. `BAR_TICKS`
 * is the arrangement's bar unit in ~340 places across ~50 files (ruler
 * drawing, clip placement, loop regions, markers, zoom, selection). The
 * scheduler's `ticksPerBar(doc)` is the musical one. Each convention is
 * defensible; making them agree means either rewriting the arrangement model
 * (an on-disk format decision, ADR territory) or deliberately un-musical
 * metronome clicks. That is a product decision, not a patch.
 *
 * So: the 4/4 agreement is pinned as an INVARIANT (it must hold whatever is
 * decided), and the non-4/4 gap is recorded as a known, quantified hole
 * rather than silently fixed or silently forgotten.
 */
import { describe, expect, it } from "vitest";
import { tickAtBar, ticksPerBar } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { BAR_TICKS } from "../src/project-model/types";
import type { ProjectDocument, TimeSignature } from "../src/project-model/types";

function docWith(sig: TimeSignature): ProjectDocument {
  return { ...createProjectFromTemplate("house"), timeSignature: sig };
}

/** The arrangement places a clip at `startBar * BAR_TICKS` (commands/clipEditing.ts). */
const clipTick = (startBar: number): number => startBar * BAR_TICKS;

describe("AUDIT 17: bar length — arrangement grid vs scheduler grid", () => {
  it("INVARIANT: on 4/4 the two grids agree exactly", () => {
    const doc = docWith({ numerator: 4, denominator: 4 });
    expect(ticksPerBar(doc)).toBe(BAR_TICKS);
    // 0-indexed bar 2 == 1-indexed bar 3.
    expect(clipTick(2)).toBe(tickAtBar(3, doc));
  });

  it("MEASURED: the divergence under a non-4/4 meter is 960 ticks (two beats)", () => {
    for (const sig of [
      { numerator: 3, denominator: 4 },
      { numerator: 6, denominator: 8 },
    ] as TimeSignature[]) {
      const doc = docWith(sig);
      expect(clipTick(2) - tickAtBar(3, doc)).toBe(960);
    }
  });

  it.todo(
    "DECISION PENDING: either the arrangement grid follows the meter " +
      "(rewrite the bar unit in ~340 sites, on-disk format) or the scheduler " +
      "stops using ticksPerBar(doc) (musically wrong for 6/8). Unblocked once " +
      "the meter semantics are decided.",
  );
});
