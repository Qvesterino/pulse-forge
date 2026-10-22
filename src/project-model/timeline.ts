import type { AudioClip, ArrangementClip, ProjectDocument } from "./types";
import { ticksPerBar } from "./schema";

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

export function timelineItemsOf(doc: Pick<ProjectDocument, "arrangement" | "timeSignature">): TimelineItem[] {
  // Tick-based clips (MIDI, automation) are projected into the document's
  // musical bar space (ADR 0056) — a 6/8 bar is three quarter notes, so their
  // bar positions must be read against the same bar the rest of the timeline
  // draws.
  const barUnit = ticksPerBar(doc);
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
      startBar: c.startTick / barUnit,
      lengthBars: c.lengthTicks / barUnit,
    })),
    ...(doc.arrangement.automationClips ?? []).map((c) => ({
      id: c.id,
      kind: "automation" as const,
      startBar: c.startTick / barUnit,
      lengthBars: c.lengthTicks / barUnit,
    })),
  ];
}

// ── Timeline-span + lane write seams (ADR 0025 decision #5: the adapter
//    where timeline-wide operations meet the dual storage) ──────────────────

/** A scene clip's tick span on its integer-bar lane (barUnit follows the
 * meter — ADR 0056). The one home for the `startBar * barUnit` math that
 * time-range operations previously repeated 13 times with drift risk. */
export function sceneSpanTicks(
  clip: Pick<ArrangementClip, "startBar" | "lengthBars">,
  barUnit: number,
): { from: number; to: number } {
  return { from: clip.startBar * barUnit, to: (clip.startBar + clip.lengthBars) * barUnit };
}

/** An audio clip's float-bar span on its free-overlap lane. */
export function audioSpanBars(clip: Pick<AudioClip, "startBar" | "lengthBars">): {
  fromBar: number;
  toBar: number;
} {
  return { fromBar: clip.startBar, toBar: clip.startBar + clip.lengthBars };
}

/** The audio lane; `[]` for documents predating the field. */
export function audioLaneOf(arrangement: ProjectDocument["arrangement"]): AudioClip[] {
  return arrangement.audioClips ?? [];
}

/**
 * Audio-lane write-back that PRESERVES field absence: a document predating
 * the audio lane never gains the field from a range operation. Writing an
 * empty lane into such a document silently changed its persistence shape —
 * the audit-01 "consolidate loses audioClips" bug class. Ops that computed
 * no audio changes simply never call this.
 */
export function withAudioLane(doc: ProjectDocument, clips: AudioClip[]): ProjectDocument {
  if (doc.arrangement.audioClips === undefined) return doc;
  return { ...doc, arrangement: { ...doc.arrangement, audioClips: clips } };
}
