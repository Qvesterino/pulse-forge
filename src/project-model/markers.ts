import type { AudioClip, Arrangement, Marker } from "./types";

/**
 * Maps a marker type to the factory FX asset id that should be triggered when
 * the marker is crossed during playback. Returns `null` when the type has no
 * built-in cue (the scorepack export then omits the marker from the cues).
 */
export function markerAssetFor(type: Marker["type"]): string | null {
  switch (type) {
    case "drop":
      return "factory.fx.impact";
    case "buildup":
    case "riser":
      return "factory.fx.riser";
    case "impact":
      return "factory.fx.impact";
    case "cue":
    case "custom":
      return null;
  }
}

/**
 * The track a linked marker's cue preview should be heard on, or undefined to
 * fall back to the global preview bus.
 *
 * Only an AUDIO clip resolves: its lane names one track. A scene clip spans
 * every track its pattern plays, so there is no single "in context" — its
 * markers deliberately stay on the global bus. Unlinking on delete is handled
 * in the delete commands (unlinkMarkersOfClips), so a resolved id is always a
 * live clip.
 */
export function markerCueTrackId(audioClips: Arrangement["audioClips"], marker: Marker): string | undefined {
  if (!marker.linkedClipId) return undefined;
  return (audioClips ?? []).find((clip: AudioClip) => clip.id === marker.linkedClipId)?.trackId;
}
