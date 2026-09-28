import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * West Coast / G-funk grooves — the laid-back 90s pocket (researched:
 * Still D.R.E. ~93, Nuthin' but a G Thang / Gin and Juice / Regulate ~95)
 * and the modern Dre-era lope. Both ride the trap kit's pad roles
 * (0 kick, 1 kick alt, 5 snare, 8 closed hat, 10 open hat).
 *
 * Feel notes: the head-nod pocket is REST-HEAVY — sparse swung hats, snare
 * landing just behind the beat (low velocity reads as laid-back after the
 * groove's swing), no 16th-hat churn. The lope adds the rolling
 * syncopated-kick drive under the whistle lead.
 */
export const WESTCOAST_GROOVES: GrooveData[] = decodeGrooves([
  // ── Head-nod pocket (classic 90s) ─────────────────────
  {
    id: "trap.headnod",
    genre: "trap",
    name: "headnod",
    bpm: [90, 96],
    swing: 0.16,
    activePads: [0, 1, 5, 8, 10],
    patterns: [
      {
        0: "g0Law",
        1: "g7q",
        5: "g4EcEek",
        8: "g0n2d4n6d8nadcned",
        10: "g6q",
      },
      {
        0: "g0L8ydu",
        1: "g",
        5: "g4EcE",
        8: "g0n2d4n6d8nadcneh",
        10: "g6qen",
      },
      // Lazy ghost-snare fill
      {
        0: "g0Kaw",
        1: "g6n",
        5: "g4E7hcEekfh",
        8: "g0k2d4k6d8kadcked",
        10: "geq",
      },
      // Open-hat answer phrase
      {
        0: "g0Lay",
        5: "g4EcE",
        8: "g0n2d4n6d8nadcn",
        10: "g6seq",
      },
    ],
  },
  // ── G-funk lope (modern west, rolling) ────────────────
  {
    id: "trap.gfunk",
    genre: "trap",
    name: "gfunk",
    bpm: [95, 104],
    swing: 0.12,
    activePads: [0, 1, 5, 8, 10],
    patterns: [
      {
        0: "g0O7yaE",
        1: "g3s",
        5: "g4HbhcH",
        8: "g0q2h4q6h7d8qahcqeh",
        10: "g6s",
      },
      {
        0: "g0O6waEeu",
        1: "g",
        5: "g4HcHek",
        8: "g0q2h4q6h8qahbdcqeh",
        10: "g6seq",
      },
      // Roll into the hook (busier ghost kick + snare answer)
      {
        0: "g0O3s7yaE",
        1: "g8qcq",
        5: "g4H7hcHekfh",
        8: "g0q2h4q6h7d8qahcqehfd",
        10: "g6s",
      },
    ],
  },
]);
