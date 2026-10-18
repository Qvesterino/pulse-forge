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

describe("AUDIT 17: loopEnd 0 is a sentinel, not bar 0", () => {
  it("never offers bar 0 as a snap target when the loop has no explicit end", () => {
    // A loop start of 8 keeps the assertion unambiguous — a start at bar 0 is
    // a legitimate position and would otherwise collide with the sentinel.
    const targets = loopSnapTargetBars(true, 8, 0);
    // THE NEGATIVE ASSERTION. Pre-fix this returned [8 / BAR_TICKS, 0].
    expect(targets).not.toContain(0);
    expect(targets).toEqual([8 / BAR_TICKS]);
  });

  it("offers the loop end when one IS set", () => {
    const targets = loopSnapTargetBars(true, 8, 32);
    expect(targets).toEqual([8 / BAR_TICKS, 32 / BAR_TICKS]);
  });

  it("offers nothing when the loop is off", () => {
    expect(loopSnapTargetBars(false, 8, 32)).toEqual([]);
  });

  it("keeps a loop start at bar 0 — that one IS a position", () => {
    // The guard must not over-reach: looping FROM the top of the arrangement
    // is legitimate, and its start must stay snappable.
    expect(loopSnapTargetBars(true, 0, 32)).toContain(0);
  });
});
