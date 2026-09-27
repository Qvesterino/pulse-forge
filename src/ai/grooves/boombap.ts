import type { GrooveData } from "../types";

/**
 * Boom bap grooves — the sampled-break hip-hop family at 84–100 BPM, with
 * the full school tree (each school is a real production lineage, not a
 * tempo variant):
 *
 *   golden   — the 90s NY breakbeat pocket (DJ Premier / Pete Rock): kick on
 *              1 and the "and" of 3, hard snare on 2 and 4, swung 8th hats.
 *   jazz     — the jazz-rap refinement (A Tribe Called Quest / Guru): lighter
 *              kick, ride cymbal, swung 8ths, room for upright bass.
 *   lofi     — the Dilla / Madlib off-kilter pocket: late kick, ghosted
 *              snares, heavy swing, "drunk" displacement.
 *   drumless — the Alchemist / Griselda school: NO backbeat (or a buried
 *              rim click), the sample carries the rhythm.
 *   trapbap  — the modern hybrid: boom-bap sample bed over 808 sub and
 *              triplet hats at trap-adjacent tempo.
 *   modern   — the current Griselda / Roc Marciano pocket: dusty but tight,
 *              harder snare than golden, cinematic minor-key room.
 *
 * Pad indices (default kit): 0 kick, 1 kick punch, 3 rim, 4 snare, 5 snare
 * tight, 6 clap, 7 shaker, 8 hat closed, 9 hat soft, 10 hat open, 11 ride.
 */
export const BOOMBAP_GROOVES: GrooveData[] = [
  // ── Golden (the 90s NY breakbeat pocket) ────────────────
  {
    id: "boombap.golden",
    genre: "boombap",
    name: "Golden",
    bpm: [86, 96],
    swing: 0.14,
    activePads: [0, 1, 4, 5, 8, 9],
    patterns: [
      {
        // The classic two-bar break feel: kick 1 + "and of 3", snare 2 + 4.
        0: [0.95, 0, 0, 0, 0, 0, 0.75, 0, 0.9, 0, 0, 0, 0, 0, 0.7, 0],
        1: [0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        5: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0],
        8: [0, 0.6, 0, 0.45, 0, 0.6, 0, 0.45, 0, 0.6, 0, 0.45, 0, 0.6, 0, 0.45],
        9: [0.3, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0],
      },
      {
        // The "Mass Appeal" push: an extra kick on the "and of 2".
        0: [0.95, 0, 0, 0, 0, 0, 0.75, 0, 0.9, 0, 0, 0.6, 0, 0, 0.7, 0],
        1: [0.55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        8: [0, 0.55, 0, 0.5, 0, 0.55, 0, 0.5, 0, 0.55, 0, 0.5, 0, 0.55, 0, 0.5],
        9: [0.25, 0, 0, 0, 0.25, 0, 0, 0, 0.25, 0, 0, 0, 0.25, 0, 0, 0],
      },
      {
        // The breakbeat ghost layer: soft snare answers between the backbeats.
        0: [0.95, 0, 0, 0, 0, 0, 0.7, 0, 0.9, 0, 0, 0, 0, 0, 0.65, 0],
        4: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        5: [0, 0.35, 0, 0, 0, 0, 0.35, 0, 0, 0.35, 0, 0, 0, 0, 0.3, 0],
        8: [0, 0.6, 0, 0.45, 0, 0.6, 0, 0.45, 0, 0.6, 0, 0.45, 0, 0.6, 0, 0.45],
      },
    ],
  },
  // ── Jazz (the jazz-rap refinement) ──────────────────────
  {
    id: "boombap.jazz",
    genre: "boombap",
    name: "Jazz",
    bpm: [88, 98],
    swing: 0.18,
    activePads: [0, 4, 5, 7, 9, 11],
    patterns: [
      {
        // Lighter kick, ride-driven: the upright-bass pocket leaves room.
        0: [0.85, 0, 0, 0, 0, 0, 0.6, 0, 0.8, 0, 0, 0, 0, 0, 0.55, 0],
        4: [0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0],
        5: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0],
        7: [0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0],
        9: [0.35, 0, 0.3, 0, 0.35, 0, 0.3, 0, 0.35, 0, 0.3, 0, 0.35, 0, 0.3, 0],
        11: [0, 0, 0, 0.4, 0, 0, 0.4, 0, 0, 0, 0.4, 0, 0, 0, 0.4, 0],
      },
      {
        // The "Electric Relaxation" float: rim answers instead of ghost snares.
        0: [0.85, 0, 0, 0, 0, 0, 0.55, 0, 0.8, 0, 0, 0, 0, 0, 0.5, 0],
        4: [0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0],
        7: [0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0],
        9: [0.4, 0, 0.3, 0, 0.4, 0, 0.3, 0, 0.4, 0, 0.3, 0, 0.4, 0, 0.3, 0],
        11: [0, 0, 0, 0.45, 0, 0, 0.45, 0, 0, 0, 0.45, 0, 0, 0, 0.45, 0.35],
      },
    ],
  },
  // ── Lofi (the Dilla / Madlib off-kilter pocket) ─────────
  {
    id: "boombap.lofi",
    genre: "boombap",
    name: "Lo-Fi",
    bpm: [78, 92],
    swing: 0.26,
    activePads: [0, 1, 4, 5, 8, 9, 14],
    patterns: [
      {
        // The late-kick drunk feel: kick lands ON the swung 8th, not the grid.
        0: [0.9, 0, 0, 0, 0, 0, 0.8, 0, 0.85, 0, 0, 0, 0, 0, 0.75, 0],
        1: [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0.85, 0, 0, 0],
        5: [0, 0.3, 0, 0, 0, 0, 0.35, 0, 0, 0.3, 0, 0, 0, 0, 0.35, 0.25],
        8: [0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4],
        9: [0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0],
        14: [0, 0, 0, 0, 0, 0, 0.35, 0, 0, 0, 0, 0, 0, 0, 0.35, 0],
      },
      {
        // The "Donuts" stutter: an extra kick pair around the backbeat.
        0: [0.9, 0, 0, 0, 0, 0, 0.85, 0, 0.85, 0, 0, 0.6, 0, 0, 0.7, 0],
        4: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0.85, 0, 0.35, 0],
        5: [0, 0.3, 0, 0, 0, 0, 0.3, 0, 0, 0.3, 0, 0, 0, 0, 0, 0],
        8: [0, 0.45, 0, 0.35, 0, 0.45, 0, 0.35, 0, 0.45, 0, 0.35, 0, 0.45, 0, 0.35],
        14: [0, 0, 0.3, 0, 0, 0, 0, 0.3, 0, 0, 0.3, 0, 0, 0, 0, 0.3],
      },
    ],
  },
  // ── Drumless (the Alchemist / Griselda school) ──────────
  {
    id: "boombap.drumless",
    genre: "boombap",
    name: "Drumless",
    bpm: [80, 92],
    swing: 0.12,
    activePads: [0, 3, 5, 9, 14],
    patterns: [
      {
        // No backbeat: a buried rim click and a lone kick anchor the loop.
        0: [0.8, 0, 0, 0, 0, 0, 0, 0, 0.75, 0, 0, 0, 0, 0, 0, 0],
        3: [0, 0, 0, 0, 0.55, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0],
        5: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0],
        9: [0.25, 0, 0, 0, 0, 0, 0.25, 0, 0.25, 0, 0, 0, 0, 0, 0.25, 0],
        14: [0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
      {
        // The "God Don't Make Mistakes" hush: only the sample swings.
        0: [0.75, 0, 0, 0, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0, 0.6, 0],
        3: [0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0],
        9: [0.3, 0, 0.25, 0, 0.3, 0, 0.25, 0, 0.3, 0, 0.25, 0, 0.3, 0, 0.25, 0],
      },
    ],
  },
  // ── Trapbap (the modern hybrid) ─────────────────────────
  {
    id: "boombap.trapbap",
    genre: "boombap",
    name: "Trap Bap",
    bpm: [120, 145],
    swing: 0.1,
    activePads: [0, 1, 4, 8, 10],
    patterns: [
      {
        // Boom-bap sample bed + 808 sub + triplet-hat energy at trap tempo.
        0: [0.95, 0, 0, 0, 0, 0, 0.7, 0, 0.9, 0, 0, 0, 0, 0, 0.65, 0],
        1: [0.65, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        8: [0, 0.6, 0, 0.5, 0, 0.6, 0, 0.5, 0, 0.6, 0, 0.5, 0, 0.6, 0, 0.5],
        10: [0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0, 0, 0, 0, 0, 0.55, 0],
      },
      {
        0: [0.95, 0, 0, 0, 0, 0, 0.75, 0, 0.9, 0, 0, 0.55, 0, 0, 0.6, 0],
        1: [0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0.4, 0],
        8: [0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4],
        10: [0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.55],
      },
    ],
  },
  // ── Modern (the current Griselda / Roc Marciano pocket) ─
  {
    id: "boombap.modern",
    genre: "boombap",
    name: "Modern",
    bpm: [82, 94],
    swing: 0.15,
    activePads: [0, 1, 4, 5, 8, 9, 11],
    patterns: [
      {
        // Dusty but tight: a harder snare than golden, cinematic minor room.
        0: [0.95, 0, 0, 0, 0, 0, 0.7, 0, 0.9, 0, 0, 0, 0, 0, 0.65, 0],
        1: [0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0.95, 0, 0, 0, 0, 0, 0, 0, 0.95, 0, 0, 0],
        5: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.35, 0],
        8: [0, 0.55, 0, 0.45, 0, 0.55, 0, 0.45, 0, 0.55, 0, 0.45, 0, 0.55, 0, 0.45],
        9: [0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0],
        11: [0, 0, 0, 0.35, 0, 0, 0.35, 0, 0, 0, 0.35, 0, 0, 0, 0.35, 0],
      },
      {
        // The "WWCD" press: snare doubles into a rolling push.
        0: [0.95, 0, 0, 0, 0, 0, 0.7, 0, 0.9, 0, 0, 0.55, 0, 0, 0.6, 0],
        4: [0, 0, 0, 0, 0.95, 0, 0, 0, 0, 0, 0, 0, 0.95, 0, 0.5, 0],
        5: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        8: [0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4],
        11: [0, 0, 0, 0.4, 0, 0, 0.4, 0, 0, 0, 0.4, 0, 0, 0, 0.4, 0.3],
      },
    ],
  },
];
