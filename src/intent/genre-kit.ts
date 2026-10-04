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
  boombap: [
    // The dusty crate: the knock kick (boom-bap tuned), the ROOMY backbeat —
    // a crate-digger snare has walls around it (the room snare is the only
    // bank snare with a tail) — and the soft hat for the swung 8ths.
    { index: 0, assetId: "factory.kick.knock" },
    { index: 1, assetId: "factory.kick.deep" },
    {
      index: 4,
      assetId: "factory.snare.room",
      layers: roundRobinLayers(["factory.snare.room", "factory.snare.room.rr2", "factory.snare.room.rr3"]),
    },
    { index: 5, assetId: "factory.snare.tight" },
    { index: 8, assetId: "factory.hat.closed.soft" },
  ],
  amapiano: [
    // The log-drum kit: the deep soft kick (the quiet four-floor), the soft
    // closed hat for the semiquaver shaker bed, and the soft shaker up front.
    // The tom pads (12/13) already carry the low/high toms the log-drum
    // answer rides — no swap needed there.
    { index: 0, assetId: "factory.kick.deep" },
    { index: 1, assetId: "factory.kick.soft" },
    { index: 7, assetId: "factory.shaker.soft" },
    { index: 8, assetId: "factory.hat.closed.soft" },
  ],
  trance: [
    // The trance kit: the techno kick up front (the de-emphasised four-floor
    // Wikipedia describes — the bass mask carries the weight), the open hat
    // for the offbeat mask, and the ride for the arp layer.
    { index: 0, assetId: "factory.kick.techno" },
    { index: 1, assetId: "factory.kick.punch" },
    { index: 8, assetId: "factory.hat.closed" },
    // The offbeat mask is a WASH — the long hat rings across the beat
    // (the genre's signature bloom) and varies like the other groove hats.
    {
      index: 10,
      assetId: "factory.hat.wash",
      layers: roundRobinLayers(["factory.hat.wash", "factory.hat.wash.rr2", "factory.hat.wash.rr3"]),
    },
  ],
  detroit: [
    // The machine-funk kit: the 808 pure kick (the Belleville low end), the
    // punch alt, and the hard closed hat for the tick chatter.
    { index: 0, assetId: "factory.kick.808pure" },
    { index: 1, assetId: "factory.kick.808drive" },
    { index: 8, assetId: "factory.hat.closed" },
  ],
  postrock: [
    { index: 0, assetId: "factory.kick.deep" },
    { index: 4, assetId: "factory.snare.main" },
    { index: 8, assetId: "factory.hat.closed.soft" },
    { index: 11, assetId: "factory.ride.ping" },
  ],
  drone: [
    { index: 0, assetId: "factory.kick.soft" },
    { index: 1, assetId: "factory.kick.deep" },
    { index: 4, assetId: "factory.snare.lofi" },
    { index: 7, assetId: "factory.shaker.soft" },
  ],
  chiptune: [
    // The chip kit: a tight punch kick (the 2A03 kick is a short pitched
    // blip, never a deep 808), the tight snare for the noise-channel crack,
    // the chip rim as the signature tick, and the pop clap for the NES
    // "explosion" accents.
    { index: 0, assetId: "factory.kick.punch" },
    { index: 1, assetId: "factory.kick.soft" },
    { index: 4, assetId: "factory.snare.tight" },
    { index: 3, assetId: "factory.rim.chip" },
    { index: 6, assetId: "factory.clap.pop" },
  ],
  eurodance: [
    // The Euro-NRG kit: the 909-style pop kick up front (the 90s floor was
    // a 909 or an M1 kick), punch alt, the tight snare, and the open hat
    // short for the offbeat mask.
    { index: 0, assetId: "factory.kick.pop" },
    { index: 1, assetId: "factory.kick.punch" },
    { index: 4, assetId: "factory.snare.punch" },
    { index: 8, assetId: "factory.hat.closed" },
    { index: 10, assetId: "factory.hat.open.short" },
    { index: 6, assetId: "factory.clap.pop" },
  ],
  latin: [
    // The Latin kit: the warm deep kick (the bass drum role), the soft snare
    // for brushed work, and the soft closed hat where a güira would sit.
    // The hand-drum voice lives on the tom pads (12/13) which the default
    // kit already carries — no swap needed there. The clave lands on the rim
    // pad (3): the latin grooves' son-clave cell is written there, and the
    // dry 3-2 click IS the voice that pattern was written for (the wooden
    // cavity of rim.chip reads as a generic tick under a 200 BPM salsa).
    { index: 0, assetId: "factory.kick.deep" },
    { index: 3, assetId: "factory.perc.clave", name: "Clave" },
    { index: 4, assetId: "factory.snare.main" },
    { index: 7, assetId: "factory.shaker.soft" },
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
  // Boom bap is the humanized genre: sampled breaks are never grid-locked,
  // so timing jitter is the genre's feel (the groove's swing adds on top).
  boombap: { humanizeTiming: 0.14, humanizeVelocity: 0.2 },
  // Amapiano sits between: the shaker bed is tight, the log drum breathes.
  amapiano: { humanizeTiming: 0.09, humanizeVelocity: 0.15 },
  // Trance is the most grid-locked genre in the library — the arp and the
  // kick ARE the machine; a jittered trance read is a broken trance read.
  trance: { humanizeTiming: 0.02, humanizeVelocity: 0.07 },
  // Detroit rides a drum machine — near-zero jitter, the 808 timing is the
  // composition (the "complete mistake" was a sequencer, per Derrick May).
  detroit: { humanizeTiming: 0.03, humanizeVelocity: 0.09 },
  postrock: { humanizeTiming: 0.18, humanizeVelocity: 0.22 },
  // Chiptune is a SEQUENCER, not a drummer - tracker rows land exactly on
  // the grid, and the "humanity" comes from the arpeggio, not timing.
  chiptune: { humanizeTiming: 0.02, humanizeVelocity: 0.07 },
  // Eurodance is programmed dance music - tight, but the offbeat mask
  // breathes a little (the 90s hardware sequencers had slight jitter).
  eurodance: { humanizeTiming: 0.04, humanizeVelocity: 0.09 },
  // Latin is PLAYED by a percussion section - the highest humanize in the
  // library alongside postrock, because the hand drums are the genre.
  latin: { humanizeTiming: 0.14, humanizeVelocity: 0.2 },
  // Drone keeps a steady pulse (Reich-precise) but lets the texture breathe.
  drone: { humanizeTiming: 0.1, humanizeVelocity: 0.16 },
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
