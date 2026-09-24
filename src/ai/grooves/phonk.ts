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
];
