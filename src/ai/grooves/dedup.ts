/**
 * Groove near-duplicate detection.
 *
 * Why this exists: on 2026-09-27 two parallel sessions independently added
 * `house.reggaeton` + `house.afrobeats` while another had already landed
 * `house.dembow` (88-100) and `house.afropop` (98-112) for the same two lanes.
 * That left four grooves for two lanes with two unreferenced, and needed a
 * cleanup commit (613903cc "drop duplicate reggaeton + afrobeats grooves").
 * A guard turns that into a heads-up at the moment a groove is added.
 *
 * WHAT THIS IS NOT: a linter that rejects similar BPM windows. Measured on the
 * live library, 619 pairs share ≥60% of their tempo window — boombap's six
 * grooves all sit in 78-98 on purpose (era variations of one pocket), and
 * house's 53 grooves produce 405 such pairs. Similar tempo is normal musical
 * diversity, not a defect.
 *
 * So exactly one rule ships, and it is deliberately narrow: identical BPM
 * window AND identical swing AND identical `activePads` — the three fields
 * together that make the engine pick and shape a pocket. Two grooves agreeing
 * on all three cannot be told apart, so at least one is earning nothing.
 *
 * Two earlier drafts were written, measured against the live library, and
 * removed. Both are recorded here because the reasoning behind them is
 * seductive and wrong:
 *
 *  1. "narrower window contained in a wider one AND the narrower groove is
 *     unreferenced" — looked like the 613903cc signature, produced 40
 *     findings, 40 of them false positives (house.synthpop and house.amapiano
 *     were each reported against ten wider lanes). Unreferenced is the NORMAL
 *     state of a groove between landing and someone writing its artists.
 *  2. "identical window and swing" — produced 2 findings, both legitimate
 *     siblings: house.dancefloor ~ house.progressive and house.basshouse ~
 *     hybrid.techhouse share tempo and feel but play different kits
 *     ([0,1,6,8,10] vs [0,3,7,8,10,14]) with different patterns. Tempo and
 *     swing are not a groove's identity; activePads is the rest of it.
 */
import { GROOVE_LIBRARY } from "./index";
import { ARTIST_PRESETS } from "../../intent/artists";
import type { GrooveData } from "../types";

export type DupSeverity = "dup" | "warn";

export interface DupFinding {
  severity: DupSeverity;
  reason: string;
  a: { id: string; bpm: readonly [number, number]; swing: number };
  b: { id: string; bpm: readonly [number, number]; swing: number };
  /** BPM-window overlap as a fraction of the narrower window. */
  overlap: number;
  /** True when the narrower groove has no artist preset pointing at its style. */
  bIsUnreferenced: boolean;
}

const brief = (g: GrooveData) => ({
  id: g.id,
  bpm: g.bpm,
  swing: g.swing,
});

/** Overlap of two windows, as a fraction of the NARROWER one. */
export function windowOverlap(a: readonly [number, number], b: readonly [number, number]): number {
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  if (hi <= lo) return 0;
  return (hi - lo) / Math.max(1, Math.min(a[1] - a[0], b[1] - b[0]));
}

/** Styles reachable from an artist preset for this genre. */
export function referencedStyles(genre: string): Set<string> {
  const styles = new Set<string>();
  for (const preset of ARTIST_PRESETS) {
    if (preset.genre === genre && preset.style) styles.add(preset.style);
  }
  return styles;
}

/**
 * Scan the library for near-duplicates. Pure — pass a slice in tests, or omit
 * it to scan the live `GROOVE_LIBRARY`.
 */
export function findGrooveDuplicates(library: readonly GrooveData[] = GROOVE_LIBRARY): DupFinding[] {
  const findings: DupFinding[] = [];
  const styleCache = new Map<string, Set<string>>();

  for (let i = 0; i < library.length; i++) {
    for (let j = i + 1; j < library.length; j++) {
      const a = library[i];
      const b = library[j];
      // Cross-genre pairs are not "duplicates" — a house and a techno lane at
      // the same tempo are two different things.
      if (a.genre !== b.genre) continue;

      const overlap = windowOverlap(a.bpm, b.bpm);
      if (overlap <= 0) continue;

      const sameWindow = a.bpm[0] === b.bpm[0] && a.bpm[1] === b.bpm[1];
      const sameSwing = Math.abs(a.swing - b.swing) < 1e-9;
      // Tempo and swing are only half a groove's identity. Measured on the
      // live library, window+swing alone flagged house.dancefloor ~
      // house.progressive and house.basshouse ~ hybrid.techhouse — both pairs
      // are legitimate siblings: same tempo, DIFFERENT kit
      // (dancefloor plays [0,1,6,8,10], progressive [0,3,7,8,10,14]) and
      // different patterns. `activePads` is the part of the signature the
      // generator actually uses to shape the pattern, so it has to match too.
      const sameKit =
        a.activePads.length === b.activePads.length && a.activePads.every((p, i) => p === b.activePads[i]);

      if (sameWindow && sameSwing && sameKit) {
        findings.push({
          severity: "dup",
          reason: "identical BPM window, swing and active pads",
          a: brief(a),
          b: brief(b),
          overlap,
          bIsUnreferenced: isUnreferenced(b, styleCache) && isUnreferenced(a, styleCache),
        });
      }
    }
  }
  return findings;
}

function isUnreferenced(g: GrooveData, cache: Map<string, Set<string>>): boolean {
  let styles = cache.get(g.genre);
  if (!styles) {
    styles = referencedStyles(g.genre);
    cache.set(g.genre, styles);
  }
  const style = g.id.replace(/^.*\./, "");
  // The genre's own name is always resolvable by a bare genre word, so a
  // groove called `<genre>.<genre>` is reachable even with no artist preset.
  return !styles.has(style) && style !== g.genre;
}
