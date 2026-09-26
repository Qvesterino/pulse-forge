import type { ProjectDocument } from "../project-model/types";
import type { GenerateOptions } from "../ai/types";
import { FACTORY_SNARE_RR, FACTORY_HAT_CLOSED_RR, roundRobinLayers } from "../sample-library/velocity-layers";

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
  /**
   * Optional round-robin / velocity variant set for the swapped pad. The
   * variants (`.rr2`, `.rr3`) ship in the factory bank for the genre drums, so
   * repeated hits stop reading as one machine-gun sample.
   */
  layers?: import("../project-model/types").SampleLayer[];
}

export const GENRE_KIT_SWAPS: Partial<Record<GenerateOptions["genre"], GenrePadSwap[]>> = {
  drill: [
    // Sliding 808 character: the deep slot becomes the dedicated drill 808
    // (tight growl body), the punch slot a shorter trap kick, the techno
    // slot a soft alt. Roles stay "kick".
    { index: 0, assetId: "factory.kick.drill", name: "Kick 808" },
    { index: 1, assetId: "factory.kick.trap" },
    { index: 2, assetId: "factory.kick.soft", name: "Kick Soft" },
    // Darker, shorter backbeat — the dedicated drill crack.
    { index: 4, assetId: "factory.snare.drill", layers: roundRobinLayers([
      "factory.snare.drill",
      "factory.snare.drill.rr2",
      "factory.snare.drill.rr3",
    ]) },
  ],
  phonk: [
    // Memphis dirt: the crunchy vintage thump up front, the distorted 808
    // as the alt slot.
    { index: 0, assetId: "factory.kick.phonk" },
    { index: 2, assetId: "factory.kick.808drive", name: "Kick 808 Drive" },
    // Dusty memphis backbeat joins the genre kit colouring.
    { index: 4, assetId: "factory.snare.phonk" },
    // THE phonk voice: the fx-role blip slot becomes a cowbell (pad 15 falls
    // back to role "fx" by index either way — generation is unaffected).
    { index: 15, assetId: "factory.perc.cowbell", name: "Cowbell" },
  ],
  jersey: [
    // Club bounce: the clicky jersey kick up front, hard alt, cracking
    // backbeat. Kicks and the backbeat rotate through their variant sets —
    // jersey's 8th-note kick churn is where the machine-gun read is loudest.
    { index: 0, assetId: "factory.kick.jersey", layers: roundRobinLayers([
      "factory.kick.jersey",
      "factory.kick.jersey.rr2",
      "factory.kick.jersey.rr3",
    ]) },
    { index: 2, assetId: "factory.kick.techno" },
    { index: 4, assetId: "factory.snare.jersey" },
  ],
  dnb: [
    // Two-step character: the rolling dnb punch, cracking snare, 16th pedal
    // hat. The breakbeat is the definition of repetition — RR is mandatory.
    { index: 0, assetId: "factory.kick.dnb", layers: roundRobinLayers([
      "factory.kick.dnb",
      "factory.kick.dnb.rr2",
      "factory.kick.dnb.rr3",
    ]) },
    { index: 4, assetId: "factory.snare.dnb", layers: roundRobinLayers([
      "factory.snare.dnb",
      "factory.snare.dnb.rr2",
      "factory.snare.dnb.rr3",
    ]) },
    { index: 9, assetId: "factory.hat.pedal" },
  ],
};

/**
 * Genre-independent default: the beat-critical drums of the STOCK kit rotate
 * through their variant sets, so a beat that never asks for a genre kit still
 * varies its snare and closed hats. Only pads whose ACTIVE asset is the set's
 * base are touched (verified per entry), so this can never change a pad's
 * sound — it only adds variation to a hit that already played that sample.
 */
export const DEFAULT_BEAT_RR: ReadonlyArray<{ index: number; layers: import("../project-model/types").SampleLayer[] }> = [
  // Stock kit pad 4 = factory.snare.main; pad 8 = factory.hat.closed.
  { index: 4, layers: FACTORY_SNARE_RR },
  { index: 8, layers: FACTORY_HAT_CLOSED_RR },
];

/** Pure: return a doc with genre kit swaps applied to every drum track. */
export function applyGenreKitToDoc(doc: ProjectDocument, genre: GenerateOptions["genre"]): ProjectDocument {
  const swaps = GENRE_KIT_SWAPS[genre];
  let anyChanged = false;
  const tracks = doc.tracks.map((track) => {
    if (track.kind !== "drum") return track;
    let trackChanged = false;
    const pads = track.pads.map((pad, index) => {
      const swap = swaps?.find((s) => s.index === index);
      // Variant set: the swap's own layers when the genre defines one, else
      // the stock-kit default for that pad. Idempotent — re-applying the same
      // values leaves the pad reference untouched.
      const defaultLayers = DEFAULT_BEAT_RR.find((entry) => entry.index === index)?.layers;
      const nextLayers = swap?.layers ?? defaultLayers;
      if (swap && pad.assetId !== swap.assetId) {
        trackChanged = true;
        anyChanged = true;
        const next = { ...pad, assetId: swap.assetId, ...(swap.name ? { name: swap.name } : {}) };
        return nextLayers ? { ...next, layers: nextLayers } : next;
      }
      if (nextLayers && pad.layers !== nextLayers) {
        // A default-set pad whose asset is not the layer base would switch
        // sound — only layer pads whose active sample IS the set's base.
        const baseId = nextLayers[0]?.sampleId;
        if (pad.assetId !== baseId) return pad;
        trackChanged = true;
        anyChanged = true;
        return { ...pad, layers: nextLayers };
      }
      return pad;
    });
    return trackChanged ? { ...track, pads } : track;
  });
  return anyChanged ? { ...doc, tracks } : doc;
}
