/**
 * AUDIT 17 — a transport sentinel is not a position.
 *
 * `Transport.setLoop` deliberately keeps `end === 0` when no loop end was set
 * (`safeEnd = end > 0 ? … : 0`), and `Scheduler.resolveLoopEnd` expands that 0
 * to "the end of the current content". So `loopEnabled === true` with
 * `loopEnd === 0` is a first-class, supported state — the default state, in
 * fact.
 *
 * `ArrangementPanel` read that same 0 as a literal tick position and pushed
 * `loopEnd / BAR_TICKS` (= 0) into the audio-clip snap targets. Enabling the
 * loop without an explicit end therefore made every dragged audio clip snap to
 * the very top of the arrangement while playback looped the whole song.
 *
 * SCOPE HONESTY: these specs guard the extracted RULE, not the pointer
 * gesture. A DOM-level version was attempted and abandoned: in jsdom the drag
 * could not be landed reliably inside the 8 px snap window around bar 0 —
 * a drag short of it did not register as a move at all, and one long enough to
 * register was floored at bar 0 by the clip's own "cannot cross bar 0" rule,
 * which masks the difference. A spec that passes with and without the defect is
 * worse than no spec, so this one pins the rule that actually decides it and
 * says so out loud.
 */
import { describe, expect, it } from "vitest";
import { loopSnapTargetBars } from "../../src/ui/ArrangementPanel";
import { BAR_TICKS } from "../../src/project-model/types";
import { ticksPerBarFor } from "../../src/project-model/schema";

describe("AUDIT 17: loopEnd 0 is a sentinel, not bar 0", () => {
  // The snap targets are BAR positions, so the helper reads ticks in the
  // document's own meter (ADR 0056): 4/4 = 1920 ticks, 6/8 = 1440.
  const FOUR_FOUR = ticksPerBarFor({ numerator: 4, denominator: 4 });
  const SIX_EIGHT = ticksPerBarFor({ numerator: 6, denominator: 8 });

  it("never offers bar 0 as a snap target when the loop has no explicit end", () => {
    // A loop start of 8 keeps the assertion unambiguous — a start at bar 0 is
    // a legitimate position and would otherwise collide with the sentinel.
    const targets = loopSnapTargetBars(true, 8, 0, FOUR_FOUR);
    // THE NEGATIVE ASSERTION. Pre-fix this returned [8 / BAR_TICKS, 0].
    expect(targets).not.toContain(0);
    expect(targets).toEqual([8 / BAR_TICKS]);
  });

  it("offers the loop end when one IS set", () => {
    const targets = loopSnapTargetBars(true, 8, 32, FOUR_FOUR);
    expect(targets).toEqual([8 / BAR_TICKS, 32 / BAR_TICKS]);
  });

  it("offers nothing when the loop is off", () => {
    expect(loopSnapTargetBars(false, 8, 32, FOUR_FOUR)).toEqual([]);
  });

  it("keeps a loop start at bar 0 — that one IS a position", () => {
    // The guard must not over-reach: looping FROM the top of the arrangement
    // is legitimate, and its start must stay snappable.
    expect(loopSnapTargetBars(true, 0, 32, FOUR_FOUR)).toContain(0);
  });

  it("reads the loop position in the document's meter (6/8)", () => {
    // Bar 8 of a 6/8 project is tick 8 * 1440; the snap target must be bar 8,
    // not bar 6 (which a fixed 4/4 bar would have produced).
    const targets = loopSnapTargetBars(true, 8 * SIX_EIGHT, 0, SIX_EIGHT);
    expect(targets).toEqual([8]);
    // The same ticks in a 4/4 reading are bar 6 — the meter decides.
    expect(loopSnapTargetBars(true, 8 * SIX_EIGHT, 0, FOUR_FOUR)).toEqual([6]);
  });
});
