import type { ProjectDocument } from "./types";

/**
 * ADR 0025 — the unified timeline projection. Both clip id sets projected
 * into one view so consumers stop routing by "which array contains this id".
 * The STORAGE stays dual (two arrays, two contracts — see the ADR); this is
 * the read seam where a future merge would land.
 *
 * Ordering note: scene clips come first (document order), then audio clips —
 * this is NOT timeline order. Consumers that need chronological order sort by
 * startBar themselves; consumers that need id→kind lookup use it as a list.
 */
export interface TimelineItem {
  id: string;
  kind: "scene" | "audio";
  startBar: number;
  lengthBars: number;
}

export function timelineItemsOf(doc: Pick<ProjectDocument, "arrangement">): TimelineItem[] {
  return [
    ...doc.arrangement.clips.map((c) => ({
      id: c.id,
      kind: "scene" as const,
      startBar: c.startBar,
      lengthBars: c.lengthBars,
    })),
    ...(doc.arrangement.audioClips ?? []).map((c) => ({
      id: c.id,
      kind: "audio" as const,
      startBar: c.startBar,
      lengthBars: c.lengthBars,
    })),
  ];
}
