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
}

export function publishTimelineGroupDragPreview(
  doc: ProjectDocument,
  groupId: string,
  clipIds: readonly string[],
): void {
  if (typeof window === "undefined") return;
  const memberIds = new Set(clipIds);
  const startTicks = Object.fromEntries(
    timelineItemsOf(doc)
      .filter((item) => memberIds.has(item.id))
      .map((item) => [item.id, item.startBar * ticksPerBar(doc)]),
  );
  const detail: TimelineGroupDragPreview = {
    projectId: doc.id,
    groupId,
    clipIds: [...memberIds],
    startTicks,
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
        detail.startTicks === null
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
