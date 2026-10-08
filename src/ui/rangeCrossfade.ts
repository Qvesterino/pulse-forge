import type { Command } from "../commands/types";
import { addArrangementTransition } from "../commands/arrangementShapes";
import { crossfadeAudioClips } from "../commands/clipEditing";
import { updateAudioClip } from "../commands/clipEditing";
import type { AudioClip, ProjectDocument } from "../project-model/types";
import { BAR_TICKS } from "../project-model/types";
import type { SelectionState } from "../store/SelectionStore";

/**
 * Range Tool "X" — crossfade everything under the current time range or clip
 * selection (Cubase convention): audio clips intersecting the range get a
 * short equal fade in/out, and adjacent arrangement-clip pairs inside the
 * range get a transition.
 *
 * ONE KEYPRESS = ONE UNDO ENTRY. The naive shape of this gesture executes one
 * `updateAudioClip` per clip plus one `addArrangementTransition` per adjacent
 * pair, which pushed N history entries for a single X press — Ctrl+Z then
 * undid the crossfade one clip at a time while the user saw one action. The
 * gesture is bracketed in an undo frame instead, with the same ownership
 * contract as the PianoRoll alt-drag duplicate: `beginUndoFrame` returns
 * whether THIS call opened the frame (a frame that was already open — a live
 * MIDI record take — absorbs the commands and is never sealed by us), and an
 * empty frame (nothing changed) leaves no history entry at all.
 *
 * Extracted from App.tsx's keyboard handler so the invariant is unit-testable
 * without mounting the whole app (same pattern as useClipSelectionInvariant).
 */

/** Crossfade fade length in seconds, applied to both edges of every clip in range. */
const CROSSFADE_SEC = 0.08;

/** Minimal store surface — ProjectStore and the collab YDocStore both mirror it. */
export interface CrossfadeStore {
  beginUndoFrame(label?: string): boolean;
  endUndoFrame(): void;
  execute(command: Command): void;
}

/**
 * Apply the crossfade gesture. Returns whether anything changed (the caller
 * uses that to decide `preventDefault`). Commands are built against the
 * caller's document snapshot and land as id-anchored deltas, so executing
 * several of them in sequence composes correctly even though they share the
 * same `doc`.
 */
export function applyRangeCrossfade(
  store: CrossfadeStore,
  doc: ProjectDocument,
  selection: Pick<SelectionState, "timeRange" | "clipIds">,
): boolean {
  if (!selection.timeRange && selection.clipIds.length === 0) return false;
  const openedFrame = store.beginUndoFrame("Crossfade");
  let did = false;
  try {
    const rangeFrom = selection.timeRange?.fromTick ?? 0;
    const rangeTo = selection.timeRange?.toTick ?? 0;
    const hasRange = !!selection.timeRange;
    // PHASE 1 — crossfade OVERLAPPING pairs (same track): the real verb.
    // Each pair gets complementary fades over its overlap span (equal-power),
    // replacing the blanket 0.08 seam for those clips. A clip can join only
    // one crossfade per press (first pair wins, clips sorted by start).
    const crossfaded = new Set<string>();
    const byTrack = new Map<string, AudioClip[]>();
    for (const ac of doc.arrangement.audioClips ?? []) {
      const inRange = hasRange
        ? ac.startBar * BAR_TICKS < rangeTo && (ac.startBar + ac.lengthBars) * BAR_TICKS > rangeFrom
        : selection.clipIds.includes(ac.id);
      if (!inRange) continue;
      const list = byTrack.get(ac.trackId) ?? [];
      list.push(ac);
      byTrack.set(ac.trackId, list);
    }
    for (const list of byTrack.values()) {
      const sorted = [...list].sort((a, b) => a.startBar - b.startBar);
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        if (crossfaded.has(a.id) || crossfaded.has(b.id)) continue;
        const aEnd = (a.startBar + a.lengthBars) * BAR_TICKS;
        const bStart = b.startBar * BAR_TICKS;
        if (aEnd <= bStart) continue; // adjacent or gapped — not an overlap
        try {
          store.execute(crossfadeAudioClips(doc, a.id, b.id));
          crossfaded.add(a.id);
          crossfaded.add(b.id);
          did = true;
        } catch {}
      }
    }
    // PHASE 2 — seam fades for clips that got no crossfade (unchanged behavior).
    for (const ac of doc.arrangement.audioClips ?? []) {
      if (crossfaded.has(ac.id)) continue;
      const cFrom = ac.startBar * BAR_TICKS;
      const cTo = (ac.startBar + ac.lengthBars) * BAR_TICKS;
      const inRange = hasRange ? cFrom < rangeTo && cTo > rangeFrom : selection.clipIds.includes(ac.id);
      // A clip already carrying exactly the crossfade pair is skipped: the
      // identical patch would push an empty history entry and make repeated
      // X presses pile dead Ctrl+Z steps onto the stack.
      if (inRange && !(ac.fadeIn === CROSSFADE_SEC && ac.fadeOut === CROSSFADE_SEC)) {
        try {
          store.execute(updateAudioClip(doc, ac.id, { fadeIn: CROSSFADE_SEC, fadeOut: CROSSFADE_SEC }));
          did = true;
        } catch {}
      }
    }
    if (hasRange) {
      const clips = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
      for (let i = 0; i < clips.length - 1; i++) {
        const a = clips[i];
        const b = clips[i + 1];
        const aEnd = (a.startBar + a.lengthBars) * BAR_TICKS;
        const bStart = b.startBar * BAR_TICKS;
        const gap = bStart - aEnd;
        if (Math.abs(gap) < BAR_TICKS * 0.5 && aEnd >= rangeFrom && bStart <= rangeTo) {
          const exists = doc.arrangement.transitions?.some((t) => t.fromClipId === a.id && t.toClipId === b.id);
          if (!exists) {
            try {
              store.execute(addArrangementTransition(doc, a.id, b.id, "custom", 1));
              did = true;
            } catch {}
          }
        }
      }
    }
  } finally {
    if (openedFrame) store.endUndoFrame();
  }
  return did;
}
