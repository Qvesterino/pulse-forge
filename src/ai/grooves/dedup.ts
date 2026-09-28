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
 * So the two rules below are deliberately narrow — they flag only the shapes
 * that are almost certainly copy-paste accidents:
 *
 *  1. `identical`    — identical BPM window AND identical swing. Two grooves
 *                      that cannot be told apart by the generator's own
 *                      parameters.
 *  2. `unreferenced` — one tempo window strictly contains the other AND the
 *                      narrower groove is reachable from no artist preset,
 *                      i.e. nothing can select it. This is exactly the
 *                      613903cc case.
 *
 * Severity `warn` is informational; `dup` is a hard finding.
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

function contains(outer: readonly [number, number], inner: readonly [number, number]): boolean {
  return outer[0] <= inner[0] && outer[1] >= inner[1];
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

      if (sameWindow && sameSwing) {
        findings.push({
          severity: "dup",
          reason: "identical BPM window and swing",
          a: brief(a),
          b: brief(b),
          overlap,
          bIsUnreferenced: isUnreferenced(b, styleCache),
        });
        continue;
      }

      // Containment: one window swallows the other, and the narrower groove is
      // unreachable. This is the "two sessions added the same lane" signature.
      const narrow = a.bpm[1] - a.bpm[0] <= b.bpm[1] - b.bpm[0] ? a : b;
      const wide = narrow === a ? b : a;
      if (contains(wide.bpm, narrow.bpm) && isUnreferenced(narrow, styleCache)) {
        findings.push({
          severity: "dup",
          reason: `narrower window is fully contained and no artist preset selects "${narrow.id.replace(/^.*\./, "")}"`,
          a: brief(a),
          b: brief(b),
          overlap,
          bIsUnreferenced: true,
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
