/**
 * The track-gain automation lane is a MULTIPLIER around unity 1.0, and it has
 * to SAY so (audit F-10).
 *
 * The engine chains fader -> lane -> macro, so the lane's number multiplies
 * the fader's. The lane and the fader share the same 0..1.5 scale, which
 * made the old "Volume" label read as if the lane were the fader's own gain.
 * The fix is presentational: the title says "×", and the neutral point (1.0)
 * is drawn.
 */
import { describe, expect, it } from "vitest";
import { automationLaneTitle, unityLineY } from "../../src/ui/arrangement/AutomationClipLanes";
import type { ProjectDocument } from "../../src/project-model/types";

const docWith = (name: string): ProjectDocument =>
  ({
    tracks: [{ id: "t1", name }],
    returns: [],
  }) as unknown as ProjectDocument;

describe("the track-gain lane presents itself as a multiplier (F-10)", () => {
  it("the title says it is a factor on the fader, not the fader's own gain", () => {
    const title = automationLaneTitle(docWith("Drums"), { kind: "trackGain", trackId: "t1" });
    expect(title).toBe("Drums · Volume ×");
  });

  it("the pan lane keeps its own name — it is absolute, not a multiplier", () => {
    expect(automationLaneTitle(docWith("Drums"), { kind: "trackPan", trackId: "t1" })).toBe("Drums · Pan");
  });

  it("the unity line sits at 1.0 on the lane's 0..1.5 scale", () => {
    // The lane's range IS the fader's range (0..1.5) — the same numbers, a
    // different meaning. Unity (1.0) is two thirds up the lane:
    // y = 23 - (1 / 1.5) * 21 = 9.
    const y = unityLineY({ min: 0, max: 1.5 });
    expect(y).not.toBeNull();
    expect(y).toBeCloseTo(9, 6);
  });

  it("no unity line when unity is outside the visible range", () => {
    expect(unityLineY({ min: 0, max: 0.8 })).toBeNull();
    expect(unityLineY({ min: 1.2, max: 2 })).toBeNull();
  });
});
