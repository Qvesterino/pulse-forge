import type { GrooveData } from "../types";

/**
 * Phonk grooves — memphis swing, dirt-kick backbeat, and the COWBELL riff
 * (pad 15 carries factory.perc.cowbell after the phonk kit swap).
 *
 * Pad indices (default kit): 0 kick(trap), 2 kick alt(deep), 4 snare,
 * 8 hat closed, 15 cowbell.
 */
export const PHONK_GROOVES: GrooveData[] = [
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
        0: [0.95, 0, 0, 0, 0, 0, 0.7, 0, 0, 0, 0.85, 0, 0, 0, 0, 0],
        2: [0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0],
        4: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        8: [0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0.45],
        15: [0.55, 0, 0, 0.5, 0, 0, 0.55, 0, 0, 0.5, 0, 0, 0.55, 0, 0, 0],
      },
      {
        0: [0.95, 0, 0, 0, 0, 0, 0, 0.65, 0.8, 0, 0, 0, 0, 0.7, 0, 0],
        4: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        8: [0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0],
        15: [0.55, 0, 0.5, 0, 0, 0.55, 0, 0, 0.5, 0, 0, 0.55, 0, 0, 0.5, 0],
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
        0: [0.95, 0, 0, 0, 0, 0, 0, 0, 0.85, 0, 0, 0, 0.6, 0, 0, 0],
        4: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0.85, 0, 0, 0],
        8: [0.4, 0, 0, 0, 0.4, 0, 0, 0, 0.4, 0, 0, 0, 0.4, 0, 0.35, 0],
        15: [0.45, 0, 0, 0, 0, 0, 0.45, 0, 0, 0, 0.45, 0, 0, 0, 0, 0],
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
        0: [0.95, 0, 0, 0.6, 0, 0, 0.75, 0, 0.85, 0, 0, 0, 0, 0.6, 0, 0],
        2: [0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0.4],
        8: [0.5, 0.3, 0.45, 0.3, 0.5, 0.3, 0.45, 0.3, 0.5, 0.3, 0.45, 0.3, 0.5, 0.3, 0.45, 0.3],
        15: [0.55, 0, 0.5, 0, 0.55, 0, 0, 0.5, 0, 0.55, 0, 0, 0.5, 0, 0.55, 0],
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
        0: [0.95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0],
        2: [0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0, 0, 0, 0, 0, 0.45, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0.3, 0],
        8: [0.4, 0, 0, 0, 0.35, 0, 0, 0, 0.4, 0, 0, 0, 0.35, 0, 0, 0],
        15: [0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0],
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
        0: [0.95, 0, 0, 0, 0, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0],
        4: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        8: [0.95, 0, 0, 0, 0, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0],
        12: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        14: [0.8, 0, 0, 0, 0.7, 0, 0.8, 0, 0.8, 0, 0.7, 0, 0.8, 0, 0.7, 0],
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
        0: [0.9, 0, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0],
        8: [0, 0, 0, 0, 0, 0, 0, 0, 0.78, 0, 0, 0, 0, 0, 0, 0],
        12: [0.85, 0, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        14: [0.65, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0],
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
        0: [0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0],
        8: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        12: [0, 0, 0, 0, 0.75, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        14: [0.75, 0, 0, 0.6, 0, 0, 0, 0, 0.75, 0, 0.6, 0, 0, 0, 0, 0],
        15: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.55],
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
        0: [0.72, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0],
        8: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        12: [0.68, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        15: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.42],
      },
    ],
  },
];
