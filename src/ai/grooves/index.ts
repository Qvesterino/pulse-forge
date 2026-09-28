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

/**
 * Narrow a genre's grooves to a set of named lanes.
 *
 * WHY ON TOP OF THE BPM WINDOW: the artist profiles already narrow by tempo
 * (preferGroovesForWindow), but a genre can hold a dozen lanes across the
 * same tempo band. "Metro boomin type beat" wants the orchestral lane, not
 * the hyphy one, and both sit at 130-145. Tempo alone cannot separate them;
 * the lane name is the only signal that does.
 *
 * Behaves like a REFINEMENT, not a replacement: the candidate list arriving
 * here is already tempo-narrowed, and this only intersects it further. Lanes
 * that are not in the list simply do not match, and a lane set that matches
 * NOTHING returns the incoming list unchanged — an artist whose lanes were
 * renamed keeps working on the tempo pocket alone rather than silently
 * losing every groove.
 */
export function preferGroovesByLanes(
  grooves: readonly GrooveData[],
  lanes: readonly string[] | null | undefined,
): readonly GrooveData[] {
  if (!lanes || lanes.length === 0 || grooves.length <= 1) return grooves;
  const wanted = new Set(lanes.map((lane) => lane.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return grooves;
  const within = grooves.filter((groove) => {
    const lane = groove.id.split(".").slice(1).join(".");
    return wanted.has(lane);
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
