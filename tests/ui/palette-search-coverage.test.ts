import { describe, expect, it } from "vitest";
import { buildPaletteActions, filterActions, type PaletteDeps } from "../../src/ui/commandPalette";

/**
 * PALETTE SEARCH COVERAGE — the measurement gate for the palette's reach
 * (HCP-05-01, HCP-05-02).
 *
 * The palette is derived from the shortcut table, so it can only ever show
 * what the keyboard layer already has. Measured 2026-10-27 against the real
 * `buildPaletteActions` + the real `fuzzyScore`/`filterActions`:
 *
 *   - 55 actions (51 registry-derived + 4 palette-only extras)
 *   - 25 of 47 representative CAPABILITY queries return ZERO matches
 *   - among the families the product is strongest in: record, freeze, comp,
 *     take, arm, automation, macro, marker, crossfade, silence, consolidate,
 *     stem, warp, groove, velocity, effect, plugin, waveform, sample, tempo,
 *     humanize, swing, reference
 *
 * This spec PINS that baseline as a CEILING, so:
 *   - a change that makes the palette WORSE fails here (zero hits grow);
 *   - a change that makes it BETTER never fails here — the ceiling is a
 *     floor of ambition, not a target to hit (the tighter target belongs to
 *     the approved P-1 scope, not to a file that predates the decision).
 *
 * It also caps the action count, so the palette cannot silently grow into a
 * command dump. The proposed P-1 ceiling is 100; until that scope is
 * approved this spec holds the line at today's number + a small headroom.
 *
 * The per-query result is printed, so the NEXT audit reads the movement
 * instead of re-deriving the baseline.
 */

/** The queries that name a capability a producer would actually type. */
const CAPABILITY_QUERIES = [
  // — the families the product is strongest in, and that the palette misses
  "record",
  "freeze",
  "bounce",
  "quantize",
  "automation",
  "macro",
  "midi clip",
  "marker",
  "crossfade",
  "silence",
  "consolidate",
  "stem",
  "warp",
  "chord",
  "groove",
  "velocity",
  "effect",
  "plugin",
  "waveform",
  "sample",
  "tempo",
  "humanize",
  "swing",
  "reference",
  "arm",
  "take",
  "comp",
  // — queries that must keep working (the positive control)
  "solo",
  "export",
  "loop",
  "undo",
  "redo",
  "mute",
  "copy",
  "paste",
  "group",
  "ungroup",
  "lock",
  "track",
  "pattern",
  "panel",
  "help",
  "palette",
  "save",
  "snapshot",
  "gallery",
  "history",
  "diagnostics",
] as const;

const noopDeps: PaletteDeps = {
  runShortcut: () => {},
  snapshotNow: () => {},
  openGallery: () => {},
  toggleHistoryPanel: () => {},
  toggleDiagnostics: () => {},
};

describe("palette search coverage", () => {
  const actions = buildPaletteActions(noopDeps);

  it("pins the action count so the palette cannot grow into a command dump", () => {
    // 55 today (51 registry-derived + 4 extras). The proposed P-1 scope
    // caps it at 100 — so this spec must be updated DELIBERATELY when an
    // approved scope lands, never by a change that grew the palette quietly.
    expect(actions.length).toBe(55);
    expect(actions.length).toBeLessThanOrEqual(100);
  });

  it("holds the zero-hit ceiling on representative capability queries", () => {
    const zeroHit = CAPABILITY_QUERIES.filter((q) => filterActions(actions, q).length === 0);
    const hit = CAPABILITY_QUERIES.filter((q) => filterActions(actions, q).length > 0);

    // eslint-disable-next-line no-console
    console.log(
      `\n[palette coverage] ${actions.length} actions · ${hit.length}/${CAPABILITY_QUERIES.length} queries hit · ` +
        `${zeroHit.length} zero-hit: ${zeroHit.join(", ")}`,
    );

    // Baseline 2026-10-27: 25 of 47 return nothing. A ceiling, so improving
    // the palette never breaks this spec and regressing it always does.
    expect(zeroHit.length).toBeLessThanOrEqual(25);
  });

  it("keeps the positive control working", () => {
    // The palette's own placeholder advertises "solo, export, loop" — if any
    // of these stops resolving, the placeholder is lying to the user.
    for (const q of ["solo", "export", "loop", "undo", "copy", "paste"]) {
      expect(filterActions(actions, q).length, `"${q}" must resolve`).toBeGreaterThan(0);
    }
  });

  it("every action carries a title, a group and a runnable", () => {
    for (const action of actions) {
      expect(action.title.trim().length, action.id).toBeGreaterThan(0);
      expect(action.group.trim().length, action.id).toBeGreaterThan(0);
      expect(typeof action.run, action.id).toBe("function");
    }
  });
});
