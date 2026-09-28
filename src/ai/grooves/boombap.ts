import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

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
export const BOOMBAP_GROOVES: GrooveData[] = decodeGrooves([
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
        0: "g0O6B8Key",
        1: "g0u",
        4: "g4KcK",
        5: "gek",
        8: "g1u3n5u7n9ubndufn",
        9: "g0d8d",
      },
      {
        // The "Mass Appeal" push: an extra kick on the "and of 2".
        0: "g0O6B8Kbuey",
        1: "g0s",
        4: "g4KcK",
        8: "g1s3q5s7q9sbqdsfq",
        9: "g0a4a8aca",
      },
      {
        // The breakbeat ghost layer: soft snare answers between the backbeats.
        0: "g0O6y8Kew",
        4: "g4KcK",
        5: "g1h6h9hed",
        8: "g1u3n5u7n9ubndufn",
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
        0: "g0H6u8Ees",
        4: "g4EcE",
        5: "ged",
        7: "g0a2a4a6a8aaacaea",
        9: "g0h2d4h6d8hadched",
        11: "g3k6kakek",
      },
      {
        // The "Electric Relaxation" float: rim answers instead of ghost snares.
        0: "g0H6s8Eeq",
        4: "g4EcE",
        7: "g0a2a4a6a8aaacaea",
        9: "g0k2d4k6d8kadcked",
        11: "g3n6nanenfh",
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
        0: "g0K6E8HeB",
        1: "g0q",
        4: "g4HcH",
        5: "g1d6h9dehfa",
        8: "g1q3k5q7k9qbkdqfk",
        9: "g0d4d8dcd",
        14: "g6heh",
      },
      {
        // The "Donuts" stutter: an extra kick pair around the backbeat.
        0: "g0K6H8Hbuey",
        4: "g4HcHeh",
        5: "g1d6d9d",
        8: "g1n3h5n7h9nbhdnfh",
        14: "g2d7dadfd",
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
        0: "g0E8B",
        3: "g4scs",
        5: "ged",
        9: "g0a6a8aea",
        14: "g6d",
      },
      {
        // The "God Don't Make Mistakes" hush: only the sample swings.
        0: "g0B8yeu",
        3: "g3qcq",
        9: "g0d2a4d6a8daacdea",
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
        0: "g0O6y8Kew",
        1: "g0w",
        4: "g4KcK",
        8: "g1u3q5u7q9ubqdufq",
        10: "g6ses",
      },
      {
        0: "g0O6B8Kbseu",
        1: "g0u",
        4: "g4KcKek",
        8: "g1q3k5q7k9qbkdqfk",
        10: "g3q7qbqfs",
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
        0: "g0O6y8Kew",
        1: "g0u",
        4: "g4OcO",
        5: "geh",
        8: "g1s3n5s7n9sbndsfn",
        9: "g0d4d8dcd",
        11: "g3h6haheh",
      },
      {
        // The "WWCD" press: snare doubles into a rolling push.
        0: "g0O6y8Kbseu",
        4: "g4OcOeq",
        5: "g",
        8: "g1q3k5q7k9qbkdqfk",
        11: "g3k6kakekfd",
      },
    ],
  },
]);
