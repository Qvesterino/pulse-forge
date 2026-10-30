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
 *   BEFORE the curated registry: 55 actions, 24 of 48 representative
 *   CAPABILITY queries returned ZERO matches. Among them: record, freeze,
 *   quantize, automation, macro, marker, crossfade, silence, consolidate,
 *   stem, warp, chord, groove, velocity, effect, plugin, waveform, sample,
 *   tempo, humanize, swing, reference, bounce, midi clip.
 *
 *   AFTER: 79 actions, 9 of 48 return zero, and TWELVE of the previously
 *   unreachable capabilities became genuinely findable (freeze, quantize,
 *   macro, marker, crossfade, chord, groove, velocity, effect, plugin,
 *   humanize, swing) — the gate below pins each one by its exact action.
 *
 *   CF-12 (2026-10-29) added two more routes to the SAME dialogs the audio
 *   clip's context menu already had (Time & pitch, Spectral edit), so the
 *   count moved 75 -> 77; CF-15 added the cut-tool chip and the V/C registry
 *   verbs, so it moved 77 -> 79. The count is pinned on purpose: a palette
 *   that grows past this line has to be a decision, not a side effect.
 *
 * The count alone would have flattered the result: "record" and "tempo" and
 * "stem" also stopped being zero, but by coincidence of the subsequence
 * matcher ("record" lands on "Conform the selected clips to the chord
 * track"), NOT because the capability is reachable. The recording family is
 * still unreachable from the palette — `armedTrackId` and the recorder state
 * are local React state inside the arrangement panel, so exposing them is the
 * P-2 proposal (one address for the recording surface), not a registry entry.
 *
 * This spec PINS the baseline as a CEILING, so:
 *   - a change that makes the palette WORSE fails here (zero hits grow, or a
 *     recovered capability stops being findable);
 *   - a change that makes it BETTER never fails here — the ceiling is a
 *     floor of ambition, not a target to hit.
 *
 * It also caps the action count, so the palette cannot silently grow into a
 * command dump. The proposed P-1 ceiling is 100; until that scope is
 * approved this spec holds the line at today's number + a small headroom.
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
    // 55 before the curated registry (51 registry-derived + 4 extras),
    // 75 after it (+20 curated commands), 77 after CF-12 added the two
    // audio-clip transformation routes, 79 after CF-15's two tool routes,
    // 80 after P-2 added the recording arm — the last family the palette
    // could not reach, because the arm was local React state. The proposed
    // P-1 scope caps it at 100 — so this spec must be updated DELIBERATELY
    // when an approved scope lands, never by a change that grew the palette
    // quietly.
    expect(actions.length).toBe(80);
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

    // Baseline 2026-10-27: 25 of 47 returned nothing (this set measures 24
    // of 48). The curated registry took it to 9. A ceiling, so improving the
    // palette never breaks this spec and regressing it always does.
    expect(zeroHit.length).toBeLessThanOrEqual(9);
  });

  it("the capabilities the registry was built for stay findable", () => {
    // A query that "hits" is not proof: the fuzzy matcher does subsequence
    // matching, so a query can land on an unrelated title. "record" resolves
    // to "Conform the selected clips to the chord track" — a coincidence, not
    // a capture action. So the gate pins the CAPABILITY (the exact registry
    // action that owns it), not the count.
    const recovered: Record<string, string> = {
      freeze: "cmd:mix.unfreeze",
      quantize: "cmd:pattern.quantizeGrid",
      macro: "cmd:macro.mapGain",
      marker: "cmd:marker.add",
      crossfade: "cmd:clip.crossfade",
      chord: "cmd:chord.conform",
      groove: "cmd:groove.humanize",
      velocity: "cmd:pattern.velocity",
      effect: "cmd:fx.bypass",
      plugin: "cmd:fx.bypass",
      humanize: "cmd:groove.humanize",
      swing: "cmd:groove.swing",
    };
    for (const [query, actionId] of Object.entries(recovered)) {
      const ids = filterActions(actions, query).map((action) => action.id);
      expect(ids, `"${query}" must reach ${actionId}`).toContain(actionId);
    }
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
