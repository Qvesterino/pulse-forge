import type { ProjectDocument } from "../project-model/types";
import type { GenerateOptions } from "../ai/types";
import { FACTORY_HAT_DYNAMIC, FACTORY_SNARE_DYNAMIC, roundRobinLayers } from "../sample-library/velocity-layers";
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
    {
      index: 4,
      assetId: "factory.snare.drill",
      layers: roundRobinLayers(["factory.snare.drill", "factory.snare.drill.rr2", "factory.snare.drill.rr3"]),
    },
    // The drill tick hat (pad 8 keeps its closed-hat role) gets its own pool —
    // drill's fast 16th ticks are its signature and its repetition read.
    {
      index: 8,
      assetId: "factory.hat.drill",
      layers: roundRobinLayers(["factory.hat.drill", "factory.hat.drill.rr2", "factory.hat.drill.rr3"]),
    },
  ],
  phonk: [
    // Memphis dirt: the crunchy vintage thump up front, the distorted 808
    // as the alt slot.
    {
      index: 0,
      assetId: "factory.kick.phonk",
      layers: roundRobinLayers(["factory.kick.phonk", "factory.kick.phonk.rr2", "factory.kick.phonk.rr3"]),
    },
    { index: 2, assetId: "factory.kick.808drive", name: "Kick 808 Drive" },
    // Dusty memphis backbeat joins the genre kit colouring (with its pool).
    {
      index: 4,
      assetId: "factory.snare.phonk",
      layers: roundRobinLayers(["factory.snare.phonk", "factory.snare.phonk.rr2", "factory.snare.phonk.rr3"]),
    },
    // THE phonk voice: the fx-role blip slot becomes a cowbell (pad 15 falls
    // back to role "fx" by index either way — generation is unaffected).
    { index: 15, assetId: "factory.perc.cowbell", name: "Cowbell" },
    // The dusty memphis hat keeps its 16th dust varied.
    {
      index: 8,
      assetId: "factory.hat.phonk",
      layers: roundRobinLayers(["factory.hat.phonk", "factory.hat.phonk.rr2", "factory.hat.phonk.rr3"]),
    },
  ],
  jersey: [
    // Club bounce: the clicky jersey kick up front, hard alt, cracking
    // backbeat. Kicks and the backbeat rotate through their variant sets —
    // jersey's 8th-note kick churn is where the machine-gun read is loudest.
    {
      index: 0,
      assetId: "factory.kick.jersey",
      layers: roundRobinLayers(["factory.kick.jersey", "factory.kick.jersey.rr2", "factory.kick.jersey.rr3"]),
    },
    { index: 2, assetId: "factory.kick.techno" },
    {
      index: 4,
      assetId: "factory.snare.jersey",
      layers: roundRobinLayers(["factory.snare.jersey", "factory.snare.jersey.rr2", "factory.snare.jersey.rr3"]),
    },
  ],
  dnb: [
    // Two-step character: the rolling dnb punch, cracking snare, 16th pedal
    // hat. The breakbeat is the definition of repetition — RR is mandatory.
    {
      index: 0,
      assetId: "factory.kick.dnb",
      layers: roundRobinLayers(["factory.kick.dnb", "factory.kick.dnb.rr2", "factory.kick.dnb.rr3"]),
    },
    {
      index: 4,
      assetId: "factory.snare.dnb",
      layers: roundRobinLayers(["factory.snare.dnb", "factory.snare.dnb.rr2", "factory.snare.dnb.rr3"]),
    },
    { index: 9, assetId: "factory.hat.pedal" },
  ],
  hyperpop: [
    // Maximalist: the trap kick up front with the tight backbeat and the
    // chip rim as the stutter voice (pad 3 is inactive in the stock kit, so
    // the rim lands as a signature hyperpop tick rather than a stock sound).
    { index: 0, assetId: "factory.kick.trap" },
    { index: 4, assetId: "factory.snare.tight" },
    { index: 3, assetId: "factory.rim.chip" },
  ],
  ukg: [
    // The garage pocket: the deep sub kick, main snare backbeat, and the soft
    // closed hat for the swung 8ths (the shuffle reads on hat dynamics).
    { index: 0, assetId: "factory.kick.deep" },
    { index: 1, assetId: "factory.kick.sub808" },
    { index: 4, assetId: "factory.snare.main" },
    { index: 8, assetId: "factory.hat.closed.soft" },
  ],
};

/**
 * Genre-independent default: the beat-critical drums of the STOCK kit get
 * their DYNAMIC sets — velocity picks the timbre (ghost → body → accent) and
 * the body band rotates through its RR pool. Only pads whose ACTIVE asset is
 * the set's base are touched (verified per entry), so this can never change a
 * pad's sound — it only adds variation + dynamics to a hit that already played
 * that sample.
 */
export const DEFAULT_BEAT_RR: ReadonlyArray<{ index: number; layers: import("../project-model/types").SampleLayer[] }> =
  [
    // Stock kit pad 4 = factory.snare.main; pad 8 = factory.hat.closed.
    { index: 4, layers: FACTORY_SNARE_DYNAMIC },
    { index: 8, layers: FACTORY_HAT_DYNAMIC },
  ];

/**
 * Per-genre feel (humanize defaults). A generated beat previously inherited
 * `groove: { swing: 0, humanize: 0 }` unless the user asked for something —
 * mathematically flat, which is the single biggest "programmed, not played"
 * tell. These land the PROJECT groove at a genre-appropriate pocket:
 *
 * - humanizeTiming/Velocity stay modest (≤ 0.2) — enough to break the grid,
 *   far from sloppy; a machine-gun hat is fixed by the sample layers above,
 *   this only adds the timing/dynamics breath;
 * - swing is 0 here on purpose: the generator already writes the groove's
 *   swing into stepMeta for pattern generation (applyGrooveSettings moves it
 *   to the project), so setting it here too would double the swing. The value
 *   is owned by whichever path generated the notes.
 */
export const GENRE_FEEL: Partial<
  Record<GenerateOptions["genre"], { humanizeTiming: number; humanizeVelocity: number }>
> = {
  trap: { humanizeTiming: 0.06, humanizeVelocity: 0.12 },
  drill: { humanizeTiming: 0.05, humanizeVelocity: 0.1 },
  phonk: { humanizeTiming: 0.12, humanizeVelocity: 0.16 },
  jersey: { humanizeTiming: 0.05, humanizeVelocity: 0.1 },
  house: { humanizeTiming: 0.08, humanizeVelocity: 0.12 },
  techno: { humanizeTiming: 0.04, humanizeVelocity: 0.08 },
  dnb: { humanizeTiming: 0.06, humanizeVelocity: 0.14 },
  // Ambient is deliberately almost flat — drift comes from the pads, not
  // from jittered onsets.
  ambient: { humanizeTiming: 0.15, humanizeVelocity: 0.1 },
  // Hyperpop is deliberately rigid (grid-locked, machine energy); UKG swings
  // hard — the shuffle IS the genre, so timing humanize stays low and the
  // groove's swing carries it.
  hyperpop: { humanizeTiming: 0.02, humanizeVelocity: 0.08 },
  ukg: { humanizeTiming: 0.07, humanizeVelocity: 0.14 },
};
/**
 * Apply a genre's feel to the document groove WITHOUT touching user values:
 * a non-zero humanize the user (or an earlier generation) already set wins,
 * so re-generating never stomps a deliberate pocket. Swing is never written.
 */
export function applyGenreFeelToDoc(doc: ProjectDocument, genre: GenerateOptions["genre"]): ProjectDocument {
  const feel = GENRE_FEEL[genre];
  if (!feel) return doc;
  const current = doc.groove;
  const humanizeTiming =
    current?.humanizeTiming && current.humanizeTiming > 0 ? current.humanizeTiming : feel.humanizeTiming;
  const humanizeVelocity =
    current?.humanizeVelocity && current.humanizeVelocity > 0 ? current.humanizeVelocity : feel.humanizeVelocity;
  if (current?.humanizeTiming === humanizeTiming && current?.humanizeVelocity === humanizeVelocity) return doc;
  return {
    ...doc,
    groove: { swing: current?.swing ?? 0, humanizeTiming, humanizeVelocity },
  };
}

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
        // A default-set pad whose active sample is NOT part of the set would
        // switch sound — only layer pads whose current asset appears in the
        // set (the pad's own timbre is one of the zones).
        const contains = nextLayers.some((layer) => layer.sampleId === pad.assetId);
        if (!contains) return pad;
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
