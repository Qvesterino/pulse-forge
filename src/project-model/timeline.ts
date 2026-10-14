import type { ProjectDocument } from "./types";
import { BAR_TICKS } from "./types";

/**
 * ADR 0025/0044/0045 — the unified timeline projection. Clip storage remains
 * specialized, and consumers read one projected list for selection/hit testing.
 *
 * Scene, audio, MIDI, and automation clip contracts are projected into one view so
 * consumers stop routing by "which array contains this id". Storage remains
 * specialized by kind; this is the read seam for timeline-wide operations.
 *
 * Ordering note: scene clips come first (document order), then audio, MIDI, and automation clips —
 * this is NOT timeline order. Consumers that need chronological order sort by
 * startBar themselves; consumers that need id→kind lookup use it as a list.
 */
export interface TimelineItem {
  id: string;
  kind: "scene" | "audio" | "midi" | "automation";
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
    ...(doc.arrangement.midiClips ?? []).map((c) => ({
      id: c.id,
      kind: "midi" as const,
      startBar: c.startTick / BAR_TICKS,
      lengthBars: c.lengthTicks / BAR_TICKS,
    })),
    ...(doc.arrangement.automationClips ?? []).map((c) => ({
      id: c.id,
      kind: "automation" as const,
      startBar: c.startTick / BAR_TICKS,
      lengthBars: c.lengthTicks / BAR_TICKS,
    })),
  ];
}
