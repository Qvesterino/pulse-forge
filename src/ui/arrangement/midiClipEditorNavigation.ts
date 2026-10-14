import type { MidiClip } from "../../project-model/types";

export const MIDI_CLIP_EDITOR_NAVIGATION_EVENT = "pf-open-midi-clip-editor";

export interface MidiClipEditorNavigationRequest {
  clipId: MidiClip["id"];
  trackId: MidiClip["trackId"];
  patternId: MidiClip["patternId"];
  startTick: MidiClip["startTick"];
}

export function requestMidiClipEditorNavigation(clip: MidiClip): void {
  if (typeof window === "undefined") return;
  const detail: MidiClipEditorNavigationRequest = {
    clipId: clip.id,
    trackId: clip.trackId,
    patternId: clip.patternId,
    startTick: clip.startTick,
  };
  window.dispatchEvent(new CustomEvent(MIDI_CLIP_EDITOR_NAVIGATION_EVENT, { detail }));
}
