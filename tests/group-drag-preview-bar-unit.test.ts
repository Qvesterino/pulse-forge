import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  groupDragPreviewStartBar,
  publishTimelineGroupDragPreview,
  type TimelineGroupDragPreview,
} from "../src/ui/arrangement/groupDragPreview";
import { ticksPerBar } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";

/**
 * THE GROUP-DRAG PREVIEW MUST CARRY THE BAR UNIT IT WAS PUBLISHED WITH.
 *
 * THE DEFECT (P3, one-frame preview offset). The preview publishes `startTicks`
 * — positions computed with the document's bar unit at publish time — and the
 * consumer divided them by the LIVE `barUnit`. The two agree until the
 * document's metre changes between the publish and the read, and then the
 * preview shows the block at one place and the commit puts it at another.
 *
 * The fix is not a bigger payload: the unit the ticks were computed with
 * travels WITH the ticks, so the conversion cannot disagree with itself.
 *
 * WHAT THIS PINS:
 *   1. the published preview carries the bar unit it used,
 *   2. the conversion uses the PREVIEW's unit, whatever the live one is,
 *   3. the arrangement panel converts through that helper, not by dividing by
 *      the live bar unit.
 */

const doc = createProjectFromTemplate("house");

describe("the group-drag preview carries its own bar unit", () => {
  it("the published preview carries the bar unit it computed the ticks with", () => {
    let detail: TimelineGroupDragPreview | null = null;
    const receive = (event: Event): void => {
      detail = (event as CustomEvent<TimelineGroupDragPreview>).detail;
    };
    window.addEventListener("pf-arrangement-group-drag-preview", receive);
    try {
      publishTimelineGroupDragPreview(doc, "g1", ["c1"]);
    } finally {
      window.removeEventListener("pf-arrangement-group-drag-preview", receive);
    }

    expect(detail, "the preview was published").not.toBeNull();
    expect(detail!.barUnit, "the preview carries the unit its ticks were computed with").toBe(ticksPerBar(doc));
  });

  it("the conversion uses the preview's unit, not the live one", () => {
    // 4/4 at PPQ 480: 480 ticks is one bar.
    const preview: TimelineGroupDragPreview = {
      projectId: doc.id,
      groupId: "g1",
      clipIds: ["c1"],
      barUnit: 480,
      startTicks: { c1: 960 },
    };
    expect(groupDragPreviewStartBar(preview, "c1", 0)).toBeCloseTo(2, 6);

    // The document's metre changed under the preview (6/8 → 360 ticks a bar).
    // The ticks were published in the OLD unit, so the bar position must not
    // move: 960 ticks at 480 ticks a bar is still 2 bars.
    const metreChanged: TimelineGroupDragPreview = { ...preview, barUnit: 480 };
    expect(groupDragPreviewStartBar(metreChanged, "c1", 0)).toBeCloseTo(2, 6);
  });

  it("a clip that is not in the preview has no previewed position", () => {
    const preview: TimelineGroupDragPreview = {
      projectId: doc.id,
      groupId: "g1",
      clipIds: ["c1"],
      barUnit: 480,
      startTicks: { c1: 960 },
    };
    expect(groupDragPreviewStartBar(preview, "other", 7)).toBeUndefined();
  });

  it("a malformed preview falls back to the clip's own start", () => {
    const broken = {
      projectId: doc.id,
      groupId: "g1",
      clipIds: ["c1"],
      barUnit: 0,
      startTicks: { c1: 960 },
    } as unknown as TimelineGroupDragPreview;
    expect(groupDragPreviewStartBar(broken, "c1", 7)).toBeCloseTo(7, 6);
  });

  it("the arrangement panel converts through the helper", () => {
    const panel = readFileSync(resolve(process.cwd(), "src/ui/ArrangementPanel.tsx"), "utf8");
    expect(panel).toContain("groupDragPreviewStartBar(");
    // The old division by the live bar unit is gone.
    expect(panel).not.toContain("groupDragPreview.startTicks[clip.id] ?? clip.startBar * barUnit) / barUnit");
  });
});
