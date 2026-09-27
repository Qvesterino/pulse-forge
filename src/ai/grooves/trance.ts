import type { GrooveData } from "../types";

/**
 * Trance grooves — promoted from `techno.trance` to a first-class genre with
 * its Wikipedia-documented school tree:
 *
 *   uplifting   — the anthem school (Armin / Above & Beyond / Tiësto): steady
 *                 four-floor, offbeat open-hat bass mask, big breakdown, the
 *                 supersaw lead IS the hook, 136–142.
 *   progressive — the smooth end (Sasha / Digweed / Prydz-era): deeper kick,
 *                 longer phrases, subtler layering, 126–134.
 *   psy         — the Goa lineage (Astrix / Vini Vici): rolling 16th bass,
 *                 driving kick, hypnotic acid-adjacent sequences, 138–148.
 *   tech        — trance × techno (the warehouse crossover): harder kick,
 *                 metallic percussion, less melody, 134–142.
 *   acid        — the 303 school (the shared lane with techno.acid): squelch
 *                 lines over the four-floor, 132–142.
 *   dream       — the Robert Miles "Children" school: soft kick, piano-led
 *                 melodic space, half-energy, 128–136.
 *
 * Pad indices (default kit): 0 kick, 1 kick punch, 2 kick techno, 4 snare,
 * 6 clap, 8 hat closed, 10 hat open, 11 ride, 15 blip.
 */
const TRANCE_KICK = [0.95, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0];

export const TRANCE_GROOVES: GrooveData[] = [
  // ── Uplifting (the anthem school) ───────────────────────
  {
    id: "trance.uplifting",
    genre: "trance",
    name: "Uplifting",
    bpm: [136, 142],
    swing: 0.03,
    activePads: [2, 6, 8, 10, 11],
    patterns: [
      {
        // Four-floor + the offbeat open-hat "bass mask" that defines the genre.
        2: TRANCE_KICK,
        6: [0, 0, 0, 0, 0.65, 0, 0, 0, 0, 0, 0, 0, 0.65, 0, 0, 0],
        8: [0.5, 0.3, 0.5, 0.3, 0.5, 0.3, 0.5, 0.3, 0.5, 0.3, 0.5, 0.3, 0.5, 0.3, 0.5, 0.3],
        10: [0, 0.6, 0, 0.6, 0, 0.6, 0, 0.6, 0, 0.6, 0, 0.6, 0, 0.6, 0, 0.6],
        11: [0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0],
      },
      {
        // The build bar: snare-roll energy into the anthem.
        2: TRANCE_KICK,
        4: [0.7, 0, 0, 0, 0.75, 0, 0, 0, 0.8, 0, 0, 0, 0.85, 0, 0, 0.9],
        8: [0.5, 0.35, 0.5, 0.35, 0.55, 0.4, 0.55, 0.4, 0.6, 0.45, 0.6, 0.45, 0.65, 0.5, 0.7, 0.75],
        10: [0, 0.65, 0, 0.65, 0, 0.65, 0, 0.65, 0, 0.7, 0, 0.7, 0, 0.75, 0, 0.8],
      },
    ],
  },
  // ── Progressive (the smooth end) ────────────────────────
  {
    id: "trance.progressive",
    genre: "trance",
    name: "Progressive",
    bpm: [126, 134],
    swing: 0.05,
    activePads: [0, 6, 8, 10, 15],
    patterns: [
      {
        // Deeper kick, subdued tops, long-phrase patience.
        0: TRANCE_KICK,
        6: [0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0],
        8: [0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25],
        10: [0, 0.45, 0, 0.45, 0, 0.45, 0, 0.45, 0, 0.45, 0, 0.45, 0, 0.45, 0, 0.45],
        15: [0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.35, 0],
      },
      {
        // Extra percussion layer for the second half of the phrase.
        0: TRANCE_KICK,
        8: [0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25],
        10: [0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.55],
        11: [0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0, 0.25, 0, 0.3, 0],
      },
    ],
  },
  // ── Psy (the Goa lineage) ───────────────────────────────
  {
    id: "trance.psy",
    genre: "trance",
    name: "Psy",
    bpm: [138, 148],
    swing: 0.02,
    activePads: [1, 6, 8, 10, 15],
    patterns: [
      {
        // Driving kick + the rolling 16th bass tick (psy's engine).
        1: TRANCE_KICK,
        6: [0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0],
        8: [0.55, 0.4, 0.55, 0.4, 0.55, 0.4, 0.55, 0.4, 0.55, 0.4, 0.55, 0.4, 0.55, 0.4, 0.55, 0.45],
        10: [0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.35, 0.5],
        15: [0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.55],
      },
      {
        // The full-roll variant: every 16th present.
        1: TRANCE_KICK,
        8: [0.55, 0.42, 0.58, 0.42, 0.55, 0.42, 0.58, 0.42, 0.55, 0.42, 0.58, 0.42, 0.55, 0.42, 0.58, 0.5],
        10: [0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.4, 0.55],
        15: [0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0.6],
      },
    ],
  },
  // ── Tech (the warehouse crossover) ──────────────────────
  {
    id: "trance.tech",
    genre: "trance",
    name: "Tech",
    bpm: [134, 142],
    swing: 0.03,
    activePads: [2, 4, 8, 11, 15],
    patterns: [
      {
        // Harder kick, metallic percussion, melody pulled back.
        2: TRANCE_KICK,
        4: [0, 0, 0, 0, 0.75, 0, 0, 0, 0, 0, 0, 0, 0.75, 0, 0, 0],
        8: [0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3],
        11: [0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0],
        15: [0, 0, 0.4, 0, 0, 0.4, 0, 0, 0, 0.4, 0, 0, 0, 0.4, 0, 0],
      },
      {
        2: TRANCE_KICK,
        4: [0, 0, 0, 0, 0.75, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0.5, 0],
        8: [0.45, 0.3, 0.5, 0.3, 0.45, 0.3, 0.5, 0.3, 0.45, 0.3, 0.5, 0.3, 0.45, 0.3, 0.5, 0.35],
        11: [0.35, 0, 0.4, 0, 0.35, 0, 0.4, 0, 0.35, 0, 0.4, 0, 0.35, 0, 0.4, 0.3],
      },
    ],
  },
  // ── Acid (the 303 school) ───────────────────────────────
  {
    id: "trance.acid",
    genre: "trance",
    name: "Acid",
    bpm: [132, 142],
    swing: 0.03,
    activePads: [0, 2, 6, 10, 15],
    patterns: [
      {
        // Squelch over the four-floor — the shared lane with techno.acid.
        0: TRANCE_KICK,
        2: [0, 0, 0.6, 0, 0, 0.55, 0, 0, 0, 0.6, 0, 0, 0, 0.55, 0, 0.5],
        6: [0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0],
        10: [0, 0.55, 0, 0.55, 0, 0.55, 0, 0.55, 0, 0.55, 0, 0.55, 0, 0.55, 0, 0.6],
        15: [0.45, 0, 0, 0.5, 0, 0, 0.45, 0, 0.5, 0, 0, 0.45, 0, 0.5, 0, 0],
      },
    ],
  },
  // ── Dream (the Robert Miles school) ─────────────────────
  {
    id: "trance.dream",
    genre: "trance",
    name: "Dream",
    bpm: [128, 136],
    swing: 0.06,
    activePads: [0, 6, 8, 10],
    patterns: [
      {
        // Soft kick + piano-led space: half the density, all the melody.
        0: [0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0],
        6: [0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0],
        8: [0.35, 0.22, 0.35, 0.22, 0.35, 0.22, 0.35, 0.22, 0.35, 0.22, 0.35, 0.22, 0.35, 0.22, 0.35, 0.25],
        10: [0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0, 0.45],
      },
      {
        0: [0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0],
        6: [0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0.4, 0],
        8: [0.35, 0.22, 0.35, 0.22, 0.35, 0.22, 0.35, 0.22, 0.35, 0.22, 0.35, 0.22, 0.35, 0.22, 0.35, 0.25],
        10: [0, 0.45, 0, 0.45, 0, 0.45, 0, 0.45, 0, 0.45, 0, 0.45, 0, 0.45, 0, 0.5],
      },
    ],
  },
];
