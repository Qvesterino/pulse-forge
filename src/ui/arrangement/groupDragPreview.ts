import { useEffect, useState } from "react";
import { ticksPerBar } from "../../project-model/schema";
import type { ProjectDocument } from "../../project-model/types";
import { timelineItemsOf } from "../../project-model/timeline";

const GROUP_DRAG_PREVIEW_EVENT = "pf-arrangement-group-drag-preview";

export interface TimelineGroupDragPreview {
  projectId: string;
  groupId: string;
  clipIds: string[];
  /** Planned start positions in ticks, as returned by the real nudge command. */
  startTicks: Record<string, number>;
  /**
   * The bar unit the ticks were computed with — the document's metre at
   * publish time. The ticks are meaningless without it: the consumer used to
   * divide them by the LIVE bar unit, so a metre change between the publish
   * and the read moved the preview away from the place the commit would put
   * the block.
   */
  barUnit: number;
}

/**
 * A CLIP'S START IN BARS, from a group-drag preview.
 *
 * The conversion is made with the unit the ticks were computed with, so the
 * preview cannot disagree with itself. A clip that is not part of the preview
 * has no previewed position; a malformed preview falls back to the clip's own
 * start rather than to a guess.
 */
export function groupDragPreviewStartBar(
  preview: TimelineGroupDragPreview,
  clipId: string,
  fallbackStartBar: number,
): number | undefined {
  if (!preview.clipIds.includes(clipId)) return undefined;
  const unit = preview.barUnit;
  if (!Number.isFinite(unit) || unit <= 0) return fallbackStartBar;
  const ticks = preview.startTicks[clipId];
  if (typeof ticks !== "number" || !Number.isFinite(ticks)) return fallbackStartBar;
  return ticks / unit;
}

export function publishTimelineGroupDragPreview(
  doc: ProjectDocument,
  groupId: string,
  clipIds: readonly string[],
): void {
  if (typeof window === "undefined") return;
  const memberIds = new Set(clipIds);
  const barUnit = ticksPerBar(doc);
  const startTicks = Object.fromEntries(
    timelineItemsOf(doc)
      .filter((item) => memberIds.has(item.id))
      .map((item) => [item.id, item.startBar * barUnit]),
  );
  const detail: TimelineGroupDragPreview = {
    projectId: doc.id,
    groupId,
    clipIds: [...memberIds],
    startTicks,
    barUnit,
  };
  window.dispatchEvent(new CustomEvent<TimelineGroupDragPreview>(GROUP_DRAG_PREVIEW_EVENT, { detail }));
}

export function clearTimelineGroupDragPreview(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TimelineGroupDragPreview | null>(GROUP_DRAG_PREVIEW_EVENT, { detail: null }));
}

export function useTimelineGroupDragPreview(): TimelineGroupDragPreview | null {
  const [preview, setPreview] = useState<TimelineGroupDragPreview | null>(null);
  useEffect(() => {
    const receive = (event: Event): void => {
      const detail = (event as CustomEvent<TimelineGroupDragPreview | null>).detail;
      if (detail === null) {
        setPreview(null);
        return;
      }
      if (
        !detail ||
        typeof detail.projectId !== "string" ||
        typeof detail.groupId !== "string" ||
        !Array.isArray(detail.clipIds) ||
        typeof detail.startTicks !== "object" ||
        detail.startTicks === null ||
        typeof detail.barUnit !== "number" ||
        !Number.isFinite(detail.barUnit) ||
        detail.barUnit <= 0
      ) {
        return;
      }
      const clipIds = detail.clipIds.filter((id): id is string => typeof id === "string");
      const startTicks: Record<string, number> = {};
      for (const id of clipIds) {
        const value = detail.startTicks[id];
        if (Number.isFinite(value)) startTicks[id] = value;
      }
      setPreview({ ...detail, clipIds, startTicks });
    };
    window.addEventListener(GROUP_DRAG_PREVIEW_EVENT, receive);
    return () => window.removeEventListener(GROUP_DRAG_PREVIEW_EVENT, receive);
  }, []);
  return preview;
}
