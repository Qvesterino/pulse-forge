/**
 * Guitar-style recipes — the artist-reference case from the original
 * brainstorm, and the first recipes that add a NEW TRACK rather than only
 * retuning an existing one.
 *
 * Two recipes:
 *
 * 1. "add a Daron Malakian style guitar" — the System of a Down guitarist.
 *    High-gain rhythm guitar: drop-D feel, hard clipper, tight low end, and
 *    the mid-range focus that makes palm-muted chugs cut through a mix.
 *    The artist name is an INTENT TAG, not a parameter — the bridge
 *    translates it to numbers, exactly like every other recipe.
 *
 * 2. "add a palm-muted guitar" — the same rig without the extreme gain,
 *    for the much more common case where someone just wants a rhythm part
 *    that sits under a mix.
 *
 * Why add a track at all? Every recipe so far only retunes what exists. But
 * "add a guitar" is a legitimate, frequently requested move, and it is the
 * one that needs the project model rather than the effect rack. The new track
 * is a real `InstrumentTrack` going through the same `withTrack` immutability
 * as everything else, so it is undoable with the rest of the batch.
 *
 * What these recipes deliberately do NOT do:
 *   - Set a tuning. `drop-D` is a guitar fact, not a synthesiser fact, and
 *     KYX's instrument model is a sampler/synth with no string count. Naming
 *     a tuning without an instrument that has strings would be a lie in the
 *     UI. The high-gain CHARACTER and the low pre-HPF get the same musical
 *     result without pretending a string count exists.
 *   - Write notes. Picking a riff is composition, not mixing — that is what
 *     the intent pipeline and AI Bandmate are for. This recipe sets up the
 *     rig and lets the user play.
 */

import type { BridgeCommand, Recipe, RecipeInput } from "../types";
import { uid } from "../../shared/ids";
import type { InstrumentTrack, ProjectDocument } from "../../project-model/types";

const RECIPE_ID = "malakian-guitar";
const PALM_RECIPE_ID = "palm-muted-guitar";

const MALAKIAN_PATTERNS: readonly string[] = [
  "daron.*malakian",
  "malakian",
  "system.*of.*a.*down",
  "soad",
  "gitara.*system",
  "gitara.*malakian",
  "add.*alt.?metal.*guitar",
];

const PALM_PATTERNS: readonly string[] = [
  "gitara.*palm",
  "palm.?muted",
  "palmov",
  "pridaj.*gitara.*tlum",
  "add.*palm.*guitar",
];

export const malakianGuitarRecipe: Recipe = {
  id: RECIPE_ID,
  description:
    "Add a high-gain rhythm guitar with a hard clipper, tight low end and mid focus — the System of a Down / alt-metal rhythm sound.",
  intentPatterns: MALAKIAN_PATTERNS,
  build(input: RecipeInput): BridgeCommand[] {
    const { doc, userPreferences } = input;
    // High-gain is aggressive by definition; the eq-carve weight is read as
    // "how much do you want pushed" the same way it is for the drums recipe.
    const eqWeight = userPreferences.conflictResolution["eq-carve"];
    const total = eqWeight + userPreferences.conflictResolution["sidechain-duck"];
    const push = total > 0 ? eqWeight / total : 0.5;
    const intensity = round2(0.7 + 0.3 * push);
    return guitarChain(doc, "Guitar (High-Gain)", intensity, "high-gain");
  },
};

export const palmMutedGuitarRecipe: Recipe = {
  id: PALM_RECIPE_ID,
  description:
    "Add a palm-muted rhythm guitar — moderate tube drive with an asymmetric bias so muted riffs have bark instead of a flat buzz.",
  intentPatterns: PALM_PATTERNS,
  build(input: RecipeInput): BridgeCommand[] {
    const { doc, userPreferences } = input;
    const eqWeight = userPreferences.conflictResolution["eq-carve"];
    const total = eqWeight + userPreferences.conflictResolution["sidechain-duck"];
    const push = total > 0 ? eqWeight / total : 0.5;
    const intensity = round2(0.4 + 0.4 * push);
    return guitarChain(doc, "Guitar (Palm-Muted)", intensity, "palm-muted");
  },
};

/**
 * Build the whole command batch: create the track, then fill it with the
 * effect chain a guitarist would actually dialling in.
 *
 * Order matters and mirrors how the signal flows:
 *   1. distortion   — the source of the tone
 *   2. EQ           — carve before the amp, boost the mid after
 *   3. compressor   — glue so the chugs sit consistently
 *
 * The EQ comes AFTER the distortion on purpose: cutting 200 Hz before a hard
 * clipper does almost nothing, because the clipper regenerates low
 * harmonics. Cutting it after is what actually keeps the palm-muted part
 * from turning the mix into mud.
 */
function guitarChain(
  doc: ProjectDocument,
  trackName: string,
  intensity: number,
  voice: "high-gain" | "palm-muted",
): BridgeCommand[] {
  const created = createGuitarTrack(doc, trackName);
  if (!created) return [];
  const target = { namePattern: escapeLiteral(trackName), regex: false, preferKind: "any" as const };

  const commands: BridgeCommand[] = [created];
  const isHighGain = voice === "high-gain";

  commands.push({
    kind: "distortion",
    label: isHighGain ? "High-gain distortion" : "Palm-muted distortion",
    rationale: isHighGain
      ? "Hard clipper with a trimmed output — the classic rhythm-guitar sound. The -6 dB trim is what stops 'more distortion' turning into 'louder'."
      : "Tube character with a negative bias, so muted chugs have some bark rather than a flat buzz.",
    target,
    voice,
    intensity,
  });

  // Carve the low-mid mush, lift the mid range the riff lives in.
  commands.push({
    kind: "eq-carve",
    label: isHighGain ? "−3.5 dB @ 220 Hz, +2.5 dB @ 900 Hz" : "−2.5 dB @ 220 Hz, +1.5 dB @ 900 Hz",
    rationale:
      "Cut after the distortion (cutting before a clipper does nothing — it regenerates the harmonics) to keep the chug defined and lift the mid where the riff reads.",
    target,
    band: "lowMid",
    freqHz: 220,
    gainDb: isHighGain ? -3.5 : -2.5,
    q: 0.9,
  });

  commands.push({
    kind: "eq-boost",
    label: isHighGain ? "+2.5 dB @ 900 Hz" : "+1.5 dB @ 900 Hz",
    rationale: "Mid presence is what lets the part cut through without turning the level up.",
    target,
    band: "highMid",
    freqHz: 900,
    gainDb: isHighGain ? 2.5 : 1.5,
    q: 0.8,
  });

  commands.push({
    kind: "compressor",
    label: isHighGain ? "Compressor — glue" : "Compressor — glue",
    rationale: "Keeps the chugs at a consistent level so the part does not jump in and out of the mix.",
    target,
    character: "glue",
    intensity: isHighGain ? 0.55 : 0.4,
  });

  return commands;
}

/**
 * Create a fresh sampler track for the guitar, or return null when one is
 * already there. Re-running the recipe should refine an existing guitar, not
 * leave two identical ones in the project.
 */
function createGuitarTrack(doc: ProjectDocument, trackName: string): BridgeCommand | null {
  const existing = doc.tracks.find((t) => t.name.toLowerCase() === trackName.toLowerCase());
  if (existing) return null;
  const id = uid("track");
  return {
    kind: "create-instrument-track",
    label: `Add "${trackName}"`,
    rationale:
      "New sampler track for the rhythm part. No notes are written — picking a riff is composition, not mixing, so the rig is set up and the part is yours to play.",
    target: { namePattern: escapeLiteral(trackName), regex: false, preferKind: "any" },
    track: { id, name: trackName },
  };
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Re-exported so tests can build a matching doc without duplicating the id shape. */
export function guitarTrackOf(doc: ProjectDocument, name: string): InstrumentTrack | undefined {
  return doc.tracks.find((t): t is InstrumentTrack => t.name === name && t.kind === "instrument");
}
