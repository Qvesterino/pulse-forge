/**
 * Clip clipboard — copy / cut / paste for TIMELINE clips (audio + arrangement).
 *
 * The clipboard PAYLOAD is plain state owned by the UI (App's `useState`, the
 * same pattern as PatternClipboard — a module singleton would leak across
 * project switches). This module owns the pure parts: building the payload
 * from a mixed clip selection, and the two commands (cut = one undoable mixed
 * delete, paste = one undoable multi-add at the playhead).
 *
 * Paste placement contract:
 *  - Audio clips LAYER (the documented overlap contract, clipEditing.ts): the
 *    copy lands at `original + (playhead − anchor)`, rounded/clamped through
 *    addAudioClip like any placement. Take-lane provenance
 *    (takeGroupId/takeId/compSourceTakeId) is deliberately NOT carried — a
 *    pasted copy is a plain clip, never a phantom member of the source comp.
 *  - Arrangement clips keep the no-overlap lane: the target is the same
 *    delta, rounded to whole bars; if the slot is taken the paste walks
 *    forward to the first free slot (the documented duplicateArrangementClip
 *    contract) so paste never throws and relative spacing survives when the
 *    whole group fits.
 *  - Pasted clips get fresh ids and deep-cloned mutable arrays (warpMarkers),
 *    so editing a paste never rewrites the copied originals.
 */
import type { Command } from "./types";
import type { AudioClip, ArrangementClip, ProjectDocument } from "../project-model/types";
import { BAR_TICKS } from "../project-model/types";
import { uid } from "../shared/ids";
import { addAudioClip, deleteAudioClip } from "./audioClips";
import { clipsOverlap, deleteArrangementClip } from "./arrangement";

export interface ClipClipboard {
  /** Deep copies in their ORIGINAL coordinates (the anchor maps them on paste). */
  audioClips: AudioClip[];
  arrangementClips: ArrangementClip[];
  /** Earliest start tick across both systems at capture time. */
  anchorTick: number;
}

/** True when the id names a live arrangement or audio clip. */
function resolveClip(
  doc: ProjectDocument,
  clipId: string,
): { kind: "audio"; clip: AudioClip } | { kind: "arrangement"; clip: ArrangementClip } | null {
  const audio = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (audio) return { kind: "audio", clip: audio };
  const arrangement = doc.arrangement.clips.find((c) => c.id === clipId);
  if (arrangement) return { kind: "arrangement", clip: arrangement };
  return null;
}

/**
 * Snapshot the given clip ids into a clipboard payload. Ids are routed per
 * kind (selections mix both systems); dead ids are skipped. Returns null when
 * nothing matched — callers treat that as "nothing to copy" and must not
 * clear a previous clipboard over it.
 */
export function buildClipClipboard(doc: ProjectDocument, clipIds: readonly string[]): ClipClipboard | null {
  const audioClips: AudioClip[] = [];
  const arrangementClips: ArrangementClip[] = [];
  let anchorTick = Number.POSITIVE_INFINITY;
  for (const clipId of clipIds) {
    const resolved = resolveClip(doc, clipId);
    if (!resolved) continue;
    const startTick =
      resolved.kind === "audio" ? resolved.clip.startBar * BAR_TICKS : resolved.clip.startBar * BAR_TICKS;
    anchorTick = Math.min(anchorTick, startTick);
    // Deep copy: the payload must not alias the live document — later edits
    // (warp pin drags, fade drags) would silently rewrite clipboard history.
    if (resolved.kind === "audio") audioClips.push(structuredClone(resolved.clip));
    else arrangementClips.push(structuredClone(resolved.clip));
  }
  if (!Number.isFinite(anchorTick)) return null;
  return { audioClips, arrangementClips, anchorTick };
}

/**
 * Remove the given mixed clip selection as ONE undoable entry (the same
 * routing as the context menu's Delete). A cut that matches nothing produces
 * no command — callers guard with buildClipClipboard first.
 */
export function cutClips(doc: ProjectDocument, clipIds: readonly string[]): Command {
  const arrangementIds = new Set(doc.arrangement.clips.map((c) => c.id));
  const audioIds = new Set((doc.arrangement.audioClips ?? []).map((c) => c.id));
  let next = doc;
  for (const clipId of clipIds) {
    if (arrangementIds.has(clipId)) next = deleteArrangementClip(next, clipId).execute(next);
    else if (audioIds.has(clipId)) next = deleteAudioClip(next, clipId).execute(next);
  }
  return {
    type: "cutClips",
    label: "Cut clips",
    detail: "Copied to clipboard — Ctrl+V pastes at the playhead",
    execute: () => next,
    undo: () => doc,
  };
}

/**
 * Paste the clipboard at `playheadTick` as ONE undoable entry.
 *
 * Throws when the clipboard is empty or the document has no track to paste
 * onto (an audio clip whose owning track was deleted falls back to the first
 * live track; with no tracks at all there is nowhere to go).
 */
export function pasteClips(doc: ProjectDocument, clipboard: ClipClipboard, playheadTick: number): Command {
  const hasAudio = clipboard.audioClips.length > 0;
  const hasArrangement = clipboard.arrangementClips.length > 0;
  if (!hasAudio && !hasArrangement) throw new Error("Clipboard is empty");
  if (!Number.isFinite(playheadTick)) throw new Error("Paste position must be finite");
  const deltaBars = (Math.max(0, playheadTick) - clipboard.anchorTick) / BAR_TICKS;

  let pasted = doc;

  // ── Audio lane: layer at playhead ──
  if (hasAudio) {
    const fallbackTrackId = doc.tracks[0]?.id;
    if (!fallbackTrackId) throw new Error("No track to paste onto");
    for (const stored of clipboard.audioClips) {
      const trackId = doc.tracks.some((t) => t.id === stored.trackId) ? stored.trackId : fallbackTrackId;
      pasted = addAudioClip(
        pasted,
        trackId,
        stored.bufferId,
        Math.max(0, stored.startBar + deltaBars),
        stored.lengthBars,
        {
          offsetSec: stored.offsetSec,
          trimStart: stored.trimStart,
          trimEnd: stored.trimEnd,
          gain: stored.gain,
          fadeIn: stored.fadeIn,
          fadeOut: stored.fadeOut,
          stretchRate: stored.stretchRate,
          reverse: stored.reverse,
          stretchMode: stored.stretchMode,
          loop: stored.loop === true ? true : undefined,
          loopPhaseOffsetSec: stored.loopPhaseOffsetSec,
          muted: stored.muted === true ? true : undefined,
          sourceChannel: stored.sourceChannel,
          warpMarkers: stored.warpMarkers,
        },
      ).execute(pasted);
    }
  }

  // ── Arrangement lane: no-overlap, first free slot from the target ──
  if (hasArrangement) {
    for (const stored of clipboard.arrangementClips) {
      let startBar = Math.max(0, Math.round(stored.startBar + deltaBars));
      // First-free-slot walk (duplicateArrangementClip contract): against the
      // working document INCLUDING previously pasted siblings, so a free
      // stretch of timeline preserves the copied group's relative layout.
      while (clipsOverlap(pasted.arrangement.clips, null, startBar, stored.lengthBars)) {
        startBar += stored.lengthBars;
      }
      const copy: ArrangementClip = {
        ...structuredClone(stored),
        id: uid("clip"),
        startBar,
      };
      pasted = {
        ...pasted,
        arrangement: { ...pasted.arrangement, clips: [...pasted.arrangement.clips, copy] },
      };
    }
  }

  return {
    type: "pasteClips",
    label: "Paste clips",
    execute: () => pasted,
    undo: () => doc,
  };
}
