import type { ProjectDocument } from "../project-model/types";
import type { GenerateOptions } from "../ai/types";

/**
 * Genre kit colouring (sound-quality pass): a genre's identity lives in its
 * kick/snare CHARACTER, not only its groove. Pad ids (and therefore patterns,
 * locks, routing) stay untouched — only the asset BEHIND a pad swaps, so the
 * change is pure timbre selection on the existing 16-pad kit.
 *
 * Applied by applySongCommand as part of the ONE song undo step; idempotent
 * (re-applying sets the same values). Pad names only change when the role
 * stays identical under inferPadRole (verified per entry).
 */

export interface GenrePadSwap {
  /** Pad index in the default 16-pad kit (see makeKit in schema.ts). */
  index: number;
  assetId: string;
  name?: string;
}

export const GENRE_KIT_SWAPS: Partial<Record<GenerateOptions["genre"], GenrePadSwap[]>> = {
  drill: [
    // Sliding 808 character: the deep slot becomes a sub-808, the punch slot
    // a shorter trap kick, the techno slot a soft alt. Roles stay "kick".
    { index: 0, assetId: "factory.kick.sub808", name: "Kick 808" },
    { index: 1, assetId: "factory.kick.trap" },
    { index: 2, assetId: "factory.kick.soft", name: "Kick Soft" },
    // Darker, shorter backbeat.
    { index: 4, assetId: "factory.snare.trap" },
  ],
  phonk: [
    // Memphis dirt: trap-style kick up front, deep kick as the alt slot.
    { index: 0, assetId: "factory.kick.trap" },
    { index: 2, assetId: "factory.kick.deep" },
    // THE phonk voice: the fx-role blip slot becomes a cowbell (pad 15 falls
    // back to role "fx" by index either way — generation is unaffected).
    { index: 15, assetId: "factory.perc.cowbell", name: "Cowbell" },
  ],
  jersey: [
    // Club bounce: short punchy kick up front, hard alt, cracking backbeat.
    { index: 0, assetId: "factory.kick.punch" },
    { index: 2, assetId: "factory.kick.techno" },
    { index: 4, assetId: "factory.snare.punch" },
  ],
  dnb: [
    // Two-step character: punchy kick, cracking snare, 16th pedal hat.
    { index: 0, assetId: "factory.kick.punch" },
    { index: 4, assetId: "factory.snare.punch" },
    { index: 9, assetId: "factory.hat.pedal" },
  ],
};

/** Pure: return a doc with genre kit swaps applied to every drum track. */
export function applyGenreKitToDoc(doc: ProjectDocument, genre: GenerateOptions["genre"]): ProjectDocument {
  const swaps = GENRE_KIT_SWAPS[genre];
  if (!swaps || swaps.length === 0) return doc;
  let anyChanged = false;
  const tracks = doc.tracks.map((track) => {
    if (track.kind !== "drum") return track;
    let trackChanged = false;
    const pads = track.pads.map((pad, index) => {
      const swap = swaps.find((s) => s.index === index);
      if (!swap || pad.assetId === swap.assetId) return pad;
      trackChanged = true;
      anyChanged = true;
      return { ...pad, assetId: swap.assetId, ...(swap.name ? { name: swap.name } : {}) };
    });
    return trackChanged ? { ...track, pads } : track;
  });
  return anyChanged ? { ...doc, tracks } : doc;
}
