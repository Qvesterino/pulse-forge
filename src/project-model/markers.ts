import type { Marker } from "./types";

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
