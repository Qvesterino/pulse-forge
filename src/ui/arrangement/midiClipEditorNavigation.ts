import type { MidiClip } from "../../project-model/types";

export const MIDI_CLIP_EDITOR_NAVIGATION_EVENT = "pf-open-midi-clip-editor";

export interface MidiClipEditorNavigationRequest {
  clipId: MidiClip["id"];
  trackId: MidiClip["trackId"];
  patternId: MidiClip["patternId"];
  /** Absolute arrangement tick used to place the transport at this clip. */
  startTick: MidiClip["startTick"];
  /** Pattern-relative source position visible at the clip's left edge. */
  phaseOffsetTicks: number;
}

export function requestMidiClipEditorNavigation(clip: MidiClip): void {
  if (typeof window === "undefined") return;
  const detail: MidiClipEditorNavigationRequest = {
    clipId: clip.id,
    trackId: clip.trackId,
    patternId: clip.patternId,
    startTick: clip.startTick,
    phaseOffsetTicks: clip.phaseOffsetTicks ?? 0,
  };
  window.dispatchEvent(new CustomEvent(MIDI_CLIP_EDITOR_NAVIGATION_EVENT, { detail }));
}
