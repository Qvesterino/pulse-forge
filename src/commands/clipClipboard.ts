/**
 * Clip clipboard — copy / cut / paste for every timeline clip kind.
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
import type {
  ArrangementAutomationClip,
  ArrangementClip,
  AudioClip,
  MidiClip,
  ProjectDocument,
} from "../project-model/types";
import { BAR_TICKS } from "../project-model/types";
import { MAX_ARRANGEMENT_CLIP_TICKS } from "../project-model/schema";
import { clampTargetValue, isAutomationTargetValid } from "../project-model/targets";
import { uid } from "../shared/ids";
import { addAudioClip, deleteAudioClip } from "./audioClips";
import { clipsOverlap, deleteArrangementClip } from "./arrangement";
import { deleteAutomationClip } from "./automationClips";
import { deleteMidiClip } from "./midiClips";

export interface ClipClipboard {
  /** Clip references are valid only in the project they were copied from. */
  projectId: string;
  /** Deep copies in their ORIGINAL coordinates (the anchor maps them on paste). */
  audioClips: AudioClip[];
  arrangementClips: ArrangementClip[];
  midiClips: MidiClip[];
  automationClips: ArrangementAutomationClip[];
  /** Earliest start tick across all systems at capture time. */
  anchorTick: number;
}

/** Resolve one selected timeline id to its persisted clip kind. */
function resolveClip(
  doc: ProjectDocument,
  clipId: string,
):
  | { kind: "audio"; clip: AudioClip }
  | { kind: "arrangement"; clip: ArrangementClip }
  | { kind: "midi"; clip: MidiClip }
  | { kind: "automation"; clip: ArrangementAutomationClip }
  | null {
  const audio = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (audio) return { kind: "audio", clip: audio };
  const arrangement = doc.arrangement.clips.find((c) => c.id === clipId);
  if (arrangement) return { kind: "arrangement", clip: arrangement };
  const midi = (doc.arrangement.midiClips ?? []).find((c) => c.id === clipId);
  if (midi) return { kind: "midi", clip: midi };
  const automation = (doc.arrangement.automationClips ?? []).find((c) => c.id === clipId);
  if (automation) return { kind: "automation", clip: automation };
  return null;
}

/**
 * Snapshot the given clip ids into a clipboard payload. Ids are routed per
 * kind (selections can mix all timeline systems); dead ids are skipped. Returns null when
 * nothing matched — callers treat that as "nothing to copy" and must not
 * clear a previous clipboard over it.
 */
export function buildClipClipboard(doc: ProjectDocument, clipIds: readonly string[]): ClipClipboard | null {
  const audioClips: AudioClip[] = [];
  const arrangementClips: ArrangementClip[] = [];
  const midiClips: MidiClip[] = [];
  const automationClips: ArrangementAutomationClip[] = [];
  let anchorTick = Number.POSITIVE_INFINITY;
  for (const clipId of clipIds) {
    const resolved = resolveClip(doc, clipId);
    if (!resolved) continue;
    const startTick =
      resolved.kind === "audio" || resolved.kind === "arrangement"
        ? resolved.clip.startBar * BAR_TICKS
        : resolved.clip.startTick;
    anchorTick = Math.min(anchorTick, startTick);
    // Deep copy: the payload must not alias the live document — later edits
    // (warp pin drags, fade drags) would silently rewrite clipboard history.
    if (resolved.kind === "audio") audioClips.push(structuredClone(resolved.clip));
    else if (resolved.kind === "arrangement") arrangementClips.push(structuredClone(resolved.clip));
    else if (resolved.kind === "midi") midiClips.push(structuredClone(resolved.clip));
    else automationClips.push(structuredClone(resolved.clip));
  }
  if (!Number.isFinite(anchorTick)) return null;
  return { projectId: doc.id, audioClips, arrangementClips, midiClips, automationClips, anchorTick };
}

/**
 * Remove the given mixed clip selection as ONE undoable entry (the same
 * routing as the context menu's Delete). A cut that matches nothing produces
 * no command — callers guard with buildClipClipboard first.
 */
export function cutClips(doc: ProjectDocument, clipIds: readonly string[]): Command {
  const arrangementIds = new Set(doc.arrangement.clips.map((c) => c.id));
  const audioIds = new Set((doc.arrangement.audioClips ?? []).map((c) => c.id));
  const midiIds = new Set((doc.arrangement.midiClips ?? []).map((c) => c.id));
  const automationIds = new Set((doc.arrangement.automationClips ?? []).map((c) => c.id));
  let next = doc;
  for (const clipId of clipIds) {
    if (arrangementIds.has(clipId)) next = deleteArrangementClip(next, clipId).execute(next);
    else if (audioIds.has(clipId)) next = deleteAudioClip(next, clipId).execute(next);
    else if (midiIds.has(clipId)) next = deleteMidiClip(next, clipId).execute(next);
    else if (automationIds.has(clipId)) next = deleteAutomationClip(next, clipId).execute(next);
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
 * Throws when the clipboard is empty, a referenced source no longer exists,
 * or the document has no track to paste audio onto. A deleted audio routing
 * track falls back to a live track; MIDI lanes and automation targets are not
 * silently reassigned because their track or parameter is part of the content.
 */
export function pasteClips(doc: ProjectDocument, clipboard: ClipClipboard, playheadTick: number): Command {
  const hasAudio = clipboard.audioClips.length > 0;
  const hasArrangement = clipboard.arrangementClips.length > 0;
  const hasMidi = clipboard.midiClips.length > 0;
  const hasAutomation = clipboard.automationClips.length > 0;
  if (!hasAudio && !hasArrangement && !hasMidi && !hasAutomation) throw new Error("Clipboard is empty");
  if (!Number.isFinite(playheadTick)) throw new Error("Paste position must be finite");
  if (clipboard.projectId !== doc.id) {
    throw new Error("Cannot paste — this timeline clipboard belongs to a different project");
  }
  // §30 — the payload outlives the entities it names. An arrangement clip
  // REFERENCES its scene (which references the pattern), so a scene deleted
  // after the copy leaves a clip with no content behind it: it renders, it
  // has a tempo, it looks fine — and `normalizeProject` drops it on the next
  // save/load, so the edit silently evaporates. The audio lane has an exact
  // analogue handled below (a dead trackId falls back to a live track, which
  // is safe because a track is ROUTING and the buffer is the content); a scene
  // is the CONTENT, so re-pointing the copy at an arbitrary live scene would
  // play the wrong material just as silently. Refuse, and say why.
  const deadSceneId = clipboard.arrangementClips.find(
    (clip) => !doc.scenes.some((s) => s.id === clip.sceneId),
  )?.sceneId;
  if (deadSceneId) {
    throw new Error("Cannot paste — the scene this clip came from no longer exists");
  }
  const invalidMidi = clipboard.midiClips.find((clip) => {
    const track = doc.tracks.find((candidate) => candidate.id === clip.trackId);
    return !track || track.kind !== "instrument" || !doc.patterns.some((pattern) => pattern.id === clip.patternId);
  });
  if (invalidMidi) {
    throw new Error("Cannot paste — the MIDI clip's instrument track or source pattern no longer exists");
  }
  const invalidAutomation = clipboard.automationClips.find(
    (clip) =>
      !isAutomationTargetValid(doc, clip.target) ||
      clip.linkedTargets?.some((target) => !isAutomationTargetValid(doc, target)),
  );
  if (invalidAutomation) {
    throw new Error("Cannot paste — an automation clip's target no longer exists");
  }
  const deltaBars = (Math.max(0, playheadTick) - clipboard.anchorTick) / BAR_TICKS;
  const deltaTicks = Math.round(Math.max(0, playheadTick) - clipboard.anchorTick);

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
          pitchSemitones: stored.pitchSemitones,
          reverse: stored.reverse,
          stretchMode: stored.stretchMode,
          loop: stored.loop === true ? true : undefined,
          loopPhaseOffsetSec: stored.loopPhaseOffsetSec,
          muted: stored.muted === true ? true : undefined,
          fadeCurve: stored.fadeCurve === "equal" ? "equal" : undefined,
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

  // ── Instrument MIDI lanes: retain source pattern, phase and lane ──
  if (hasMidi) {
    const midiClips = [...(pasted.arrangement.midiClips ?? [])];
    for (const stored of clipboard.midiClips) {
      const lengthTicks = Math.max(1, Math.min(MAX_ARRANGEMENT_CLIP_TICKS, Math.round(stored.lengthTicks)));
      const startTick = Math.max(
        0,
        Math.min(MAX_ARRANGEMENT_CLIP_TICKS - lengthTicks, Math.round(stored.startTick + deltaTicks)),
      );
      const copy: MidiClip = {
        ...structuredClone(stored),
        id: uid("midiclip"),
        startTick,
        lengthTicks,
      };
      midiClips.push(copy);
    }
    midiClips.sort((a, b) => a.startTick - b.startTick);
    pasted = { ...pasted, arrangement: { ...pasted.arrangement, midiClips } };
  }

  // ── Automation lanes: preserve the curve and parameter target ──
  if (hasAutomation) {
    const automationClips = [...(pasted.arrangement.automationClips ?? [])];
    for (const stored of clipboard.automationClips) {
      const lengthTicks = Math.max(1, Math.min(MAX_ARRANGEMENT_CLIP_TICKS, Math.round(stored.lengthTicks)));
      const startTick = Math.max(
        0,
        Math.min(MAX_ARRANGEMENT_CLIP_TICKS - lengthTicks, Math.round(stored.startTick + deltaTicks)),
      );
      const copy: ArrangementAutomationClip = {
        ...structuredClone(stored),
        id: uid("autoclip"),
        startTick,
        lengthTicks,
        target: { ...stored.target },
        points: stored.points.map((point) => ({
          tick: Math.max(0, Math.min(MAX_ARRANGEMENT_CLIP_TICKS, Math.round(point.tick))),
          value: clampTargetValue(doc, stored.target, point.value),
        })),
      };
      automationClips.push(copy);
    }
    automationClips.sort((a, b) => a.startTick - b.startTick);
    pasted = { ...pasted, arrangement: { ...pasted.arrangement, automationClips } };
  }

  return {
    type: "pasteClips",
    label: "Paste clips",
    execute: () => pasted,
    undo: () => doc,
  };
}

/**
 * Duplicate a mixed timeline selection immediately after its occupied range.
 * It reuses paste's validation and per-kind placement rules, but commits as a
 * single, clearly labelled undo step. Bar-based clips advance by whole bars;
 * a MIDI/automation-only selection keeps its exact tick duration.
 */
export function duplicateClips(doc: ProjectDocument, clipIds: readonly string[]): Command | null {
  const clipboard = buildClipClipboard(doc, [...new Set(clipIds)]);
  if (!clipboard) return null;

  const barBased = clipboard.audioClips.length > 0 || clipboard.arrangementClips.length > 0;
  const endTicks = [
    ...clipboard.audioClips.map((clip) => (clip.startBar + clip.lengthBars) * BAR_TICKS),
    ...clipboard.arrangementClips.map((clip) => (clip.startBar + clip.lengthBars) * BAR_TICKS),
    ...clipboard.midiClips.map((clip) => clip.startTick + clip.lengthTicks),
    ...clipboard.automationClips.map((clip) => clip.startTick + clip.lengthTicks),
  ];
  const latestEnd = Math.max(...endTicks);
  if (!Number.isFinite(latestEnd) || latestEnd <= clipboard.anchorTick) return null;

  const selectionSpan = latestEnd - clipboard.anchorTick;
  const duplicateSpan = barBased ? Math.ceil(selectionSpan / BAR_TICKS) * BAR_TICKS : selectionSpan;
  const command = pasteClips(doc, clipboard, clipboard.anchorTick + duplicateSpan);
  return {
    ...command,
    type: "duplicateClips",
    label: "Duplicate selected clips",
    detail: "Copy placed after the selected clips",
  };
}
