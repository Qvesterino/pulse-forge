import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Phonk grooves — memphis swing, dirt-kick backbeat, and the COWBELL riff
 * (pad 15 carries factory.perc.cowbell after the phonk kit swap).
 *
 * Pad indices (default kit): 0 kick(trap), 2 kick alt(deep), 4 snare,
 * 8 hat closed, 15 cowbell.
 */
export const PHONK_GROOVES: GrooveData[] = decodeGrooves([
  // ── Memphis classic ───────────────────────────────────
  {
    id: "phonk.memphis",
    genre: "phonk",
    name: "Memphis",
    bpm: [130, 140],
    swing: 0.18,
    activePads: [0, 2, 4, 8, 15],
    patterns: [
      {
        0: "g0O6yaH",
        2: "g4qds",
        4: "g4KcK",
        8: "g0q2k4q6k8qakcqekfn",
        15: "g0s3q6s9qcs",
      },
      {
        0: "g0O7w8Edy",
        4: "g4KcK",
        8: "g0q2k4q6k8qakcqek",
        15: "g0s2q5s8qbseq",
      },
    ],
  },
  // ── Drift phonk (darker, sparser) ─────────────────────
  {
    id: "phonk.drift",
    genre: "phonk",
    name: "Drift",
    bpm: [132, 142],
    swing: 0.15,
    activePads: [0, 4, 8, 15],
    patterns: [
      {
        0: "g0O8Hcu",
        4: "g4HcH",
        8: "g0k4k8kckeh",
        15: "g0n6nan",
      },
    ],
  },
  // ── Phonk bounce (harder swing, busy cowbell) ─────────
  {
    id: "phonk.bounce",
    genre: "phonk",
    name: "Bounce",
    bpm: [134, 144],
    swing: 0.22,
    activePads: [0, 2, 4, 8, 15],
    patterns: [
      {
        0: "g0O3u6B8Hdu",
        2: "g4qbq",
        4: "g4KcKfk",
        8: "g0q1d2n3d4q5d6n7d8q9danbdcqddenfd",
        15: "g0s2q4s7q9scqes",
      },
    ],
  },
  // ── Horrorcore (Suicideboys — sparse half-time dread) ──
  // The $uicideboy$ corner: HALF-TIME snare (step 8 only), sub-heavy kick
  // with a late syncopation, minimal cowbell lurking in the gaps.
  {
    id: "phonk.horror",
    genre: "phonk",
    name: "Horrorcore",
    bpm: [132, 150],
    swing: 0.1,
    activePads: [0, 2, 4, 8, 15],
    patterns: [
      {
        0: "g0OaE",
        2: "g6sen",
        4: "g8Ked",
        8: "g0k4h8kch",
        15: "g2k9k",
      },
    ],
  },
  // ── Gym: the hard-cut four-on-the-floor. Phonk's most recognisable
  // export; no swing, no cowbell, all four-on-the-floor weight.
  {
    id: "phonk.gym",
    genre: "phonk",
    name: "Gym (four-on-the-floor)",
    bpm: [150, 160],
    swing: 0,
    activePads: [0, 2, 4, 8, 10],
    patterns: [
      {
        0: "g0O8OcO",
        4: "g4H",
        8: "g0O8OcO",
        12: "g4H",
        14: "g0E4y6E8EaycEey",
      },
    ],
  },
  // ── Brazil: swung, tape-worn, a lighter bounce than the Memphis line.
  {
    id: "phonk.brazil",
    genre: "phonk",
    name: "Brazil (swung, tape-worn)",
    bpm: [128, 138],
    swing: 0.2,
    activePads: [0, 6, 8, 10, 14],
    patterns: [
      {
        0: "g0K6n",
        4: "g8E",
        8: "g8D",
        12: "g0H6n",
        14: "g0w8u",
      },
    ],
  },
  // ── Cowbell: the cowbell IS the lead. Memphis family, but the
  // foreground note rather than a background texture.
  {
    id: "phonk.cowbell",
    genre: "phonk",
    name: "Cowbell lead",
    bpm: [132, 142],
    swing: 0.12,
    activePads: [0, 4, 14, 15],
    patterns: [
      {
        0: "g0K",
        4: "g8E",
        8: "g",
        12: "g4B",
        14: "g0B3u8Bau",
        15: "geqfs",
      },
    ],
  },
  // ── Reverb: the whole mix is the plate. Sparse hits, enormous space —
  // the ambient end of the scene rather than its club end.
  {
    id: "phonk.reverb",
    genre: "phonk",
    name: "Reverb (plate-drenched)",
    bpm: [126, 136],
    swing: 0.14,
    activePads: [0, 4, 8, 15],
    patterns: [
      {
        0: "g0z",
        4: "g8u",
        8: "g",
        12: "g0x",
        15: "gfl",
      },
    ],
  },
]);
