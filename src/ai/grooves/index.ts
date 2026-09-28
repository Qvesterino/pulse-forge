import type { GrooveData } from "../types";
import { HOUSE_GROOVES } from "./house";
import { TECHNO_GROOVES } from "./techno";
import { TRAP_GROOVES } from "./trap";
import { AMBIENT_GROOVES } from "./ambient";
import { HYBRID_GROOVES } from "./hybrid";
import { DRILL_GROOVES } from "./drill";
import { PHONK_GROOVES } from "./phonk";
import { JERSEY_GROOVES } from "./jersey";
import { DNB_GROOVES } from "./dnb";
import { WESTCOAST_GROOVES } from "./westcoast";
import { HYPERPOP_GROOVES } from "./hyperpop";
import { UKG_GROOVES } from "./ukg";
import { BOOMBAP_GROOVES } from "./boombap";
import { AMAPIANO_GROOVES } from "./amapiano";
import { TRANCE_GROOVES } from "./trance";
import { DETROIT_GROOVES } from "./detroit";
import { POSTROCK_GROOVES } from "./postrock";
import { CHIPTUNE_GROOVES } from "./chiptune";
import { EURODANCE_GROOVES } from "./eurodance";
import { LATIN_GROOVES } from "./latin";
import { DRONE_GROOVES } from "./drone";

export const GROOVE_LIBRARY: readonly GrooveData[] = [
  ...HOUSE_GROOVES,
  ...TECHNO_GROOVES,
  ...TRAP_GROOVES,
  ...WESTCOAST_GROOVES,
  ...AMBIENT_GROOVES,
  ...HYBRID_GROOVES,
  ...DRILL_GROOVES,
  ...PHONK_GROOVES,
  ...JERSEY_GROOVES,
  ...DNB_GROOVES,
  ...HYPERPOP_GROOVES,
  ...UKG_GROOVES,
  ...BOOMBAP_GROOVES,
  ...AMAPIANO_GROOVES,
  ...TRANCE_GROOVES,
  ...DETROIT_GROOVES,
  ...POSTROCK_GROOVES,
  ...CHIPTUNE_GROOVES,
  ...EURODANCE_GROOVES,
  ...LATIN_GROOVES,
  ...DRONE_GROOVES,
];

/** Get all groove styles for a genre */
export function getGroovesForGenre(genre: GrooveData["genre"]): readonly GrooveData[] {
  return GROOVE_LIBRARY.filter((g) => g.genre === genre);
}

/**
 * Narrow a genre's grooves to the ones whose tempo window overlaps a
 * requested one.
 *
 * WHY (measured 2026-09-28): the artist profiles carry a signature tempo
 * window (Travis Scott 140-150, Burial 130-138), but groove selection used
 * to ignore it and pick by rendezvous hash over the WHOLE genre, so
 * "travis scott type beat" could resolve to a 120 BPM house groove. The
 * genre stayed right, the pocket did not.
 *
 * WHY A SUBSET AND NOT A PICK: `pickGrooveBySeed` scores each candidate
 * independently and takes the maximum, so narrowing the candidate set
 * changes WHICH groove wins without making the choice index-dependent. A
 * seed that lands on a 140 BPM drill groove keeps landing there; only the
 * seeds that would have resolved outside the window move. That preserves
 * the insertion-tolerance property the rendezvous hash was chosen for.
 *
 * Returns the ORIGINAL list when nothing overlaps, so a window that cannot
 * be honoured never starves the caller — a profile with a mis-typed tempo
 * degrades to today's behaviour instead of throwing or returning empty.
 */
export function preferGroovesForWindow(
  grooves: readonly GrooveData[],
  window: readonly [number, number] | null | undefined,
  tolerance = 0,
): readonly GrooveData[] {
  if (!window || grooves.length <= 1) return grooves;
  const [lo, hi] = window;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return grooves;
  const within = grooves.filter((groove) => {
    const [gLo, gHi] = groove.bpm;
    if (!Number.isFinite(gLo) || !Number.isFinite(gHi)) return false;
    const midpoint = (gLo + gHi) / 2;
    return midpoint >= lo - tolerance && midpoint <= hi + tolerance;
  });
  return within.length > 0 ? within : grooves;
}

/** Get a specific groove by id */
export function getGrooveById(id: string): GrooveData | undefined {
  return GROOVE_LIBRARY.find((g) => g.id === id);
}

/** Get all style names for a genre */
export function getStyleNamesForGenre(genre: GrooveData["genre"]): string[] {
  return getGroovesForGenre(genre).map((g) => g.name);
}
