import type { GrooveData } from "../types";

/**
 * Post-rock grooves — the texture-over-melody genre promoted to first-class.
 * The defining quality per Wikipedia: dramatic dynamics (quiet → loud
 * crescendo), non-traditional structures, "minimalist patterns that prioritize
 * mood over groove", motorik influence from krautrock, and the second wave's
 * "climactic endings alongside buildups of textures and timbres".
 *
 * Schools (Wikipedia-documented):
 *   textured   — first wave (Slint / Talk Talk / Bark Psychosis): irregular
 *                tempos, bass-driven grooves, mood over groove, 70–90.
 *   crescendo  — second wave cinematic (Explosions in the Sky / Mogwai / Mono):
 *                the dramatic build, 80–110.
 *   orchestral — Montreal chamber (Godspeed You! Black Emperor / Silver Mt.
 *                Zion): strings + musique concrète, long-form, 60–90.
 *   postmetal  — the heavy fusion (Cult of Luna / Isis / Russian Circles):
 *                slow doom riffs + wall of sound, 60–90.
 *   math       — the Slint / Don Caballero angularity: irregular meters,
 *                displaced kicks, 90–120.
 *   ambient    — the spacey side (Labradford / Stars of the Lid / Kranky):
 *                droning, sparse, 60–85.
 *
 * Pad indices (default kit): 0 kick, 1 kick punch, 3 rim, 4 snare, 5 snare
 * tight, 6 clap, 7 shaker, 8 hat closed, 9 hat soft, 10 hat open, 11 ride,
 * 12 tom low, 13 tom high.
 */
export const POSTROCK_GROOVES: GrooveData[] = [
  // ── Textured (the first wave) ───────────────────────────
  {
    id: "postrock.textured",
    genre: "postrock",
    name: "Textured",
    bpm: [70, 90],
    swing: 0.06,
    activePads: [0, 3, 4, 9, 11],
    patterns: [
      {
        // Sparse, irregular, mood over groove — rim clicks + soft ride.
        0: [0.8, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0.5, 0],
        3: [0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        9: [0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0],
        11: [0.3, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0.3, 0, 0, 0],
      },
      {
        // The "Spiderland" pattern: displaced kick, snare answers.
        0: [0.8, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0],
        3: [0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0],
        4: [0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0],
        9: [0.25, 0, 0, 0, 0.25, 0, 0, 0, 0.25, 0, 0, 0, 0.25, 0, 0, 0],
        11: [0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0.35],
      },
    ],
  },
  // ── Crescendo (the second wave cinematic build) ─────────
  {
    id: "postrock.crescendo",
    genre: "postrock",
    name: "Crescendo",
    bpm: [80, 110],
    swing: 0.04,
    activePads: [0, 4, 8, 11, 12, 13],
    patterns: [
      {
        // The quiet start: sparse ride + kick, room for the build.
        0: [0.8, 0, 0, 0, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        8: [0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0],
        11: [0.3, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0],
      },
      {
        // The build: tom fills, crash, full density.
        0: [0.9, 0, 0, 0, 0.8, 0, 0, 0, 0.9, 0, 0, 0, 0.8, 0, 0, 0],
        4: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0.85, 0, 0, 0],
        8: [0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0, 0.45],
        11: [0.4, 0, 0.3, 0, 0.4, 0, 0.3, 0, 0.4, 0, 0.3, 0, 0.4, 0, 0.3, 0],
        12: [0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.55],
        13: [0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5],
      },
      {
        // The peak: wall of sound, full kick + snare + toms.
        0: [0.95, 0, 0, 0, 0.9, 0, 0, 0, 0.95, 0, 0, 0, 0.9, 0, 0, 0],
        4: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        8: [0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.4],
        11: [0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0],
        12: [0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0],
        13: [0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5],
      },
    ],
  },
  // ── Orchestral (the Montreal chamber school) ────────────
  {
    id: "postrock.orchestral",
    genre: "postrock",
    name: "Orchestral",
    bpm: [60, 90],
    swing: 0.08,
    activePads: [0, 4, 7, 11, 12],
    patterns: [
      {
        // Strings carry the piece — drums barely exist.
        0: [0.7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0],
        4: [0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        7: [0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0],
        11: [0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4],
      },
    ],
  },
  // ── Post-metal (the heavy fusion) ───────────────────────
  {
    id: "postrock.postmetal",
    genre: "postrock",
    name: "Post-Metal",
    bpm: [60, 90],
    swing: 0.03,
    activePads: [0, 1, 4, 5, 12, 13],
    patterns: [
      {
        // Slow doom riffs + wall of sound — heavy kick, big snare, toms.
        0: [0.95, 0, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        1: [0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        5: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.45, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0],
        13: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5],
      },
      {
        // Double-kick push into the build.
        0: [0.95, 0, 0, 0.5, 0, 0, 0.8, 0, 0.9, 0, 0, 0.5, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        5: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5],
        13: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0],
      },
    ],
  },
  // ── Math (the Slint / Don Caballero angularity) ─────────
  {
    id: "postrock.math",
    genre: "postrock",
    name: "Math",
    bpm: [90, 120],
    swing: 0.02,
    activePads: [0, 3, 4, 8, 12, 13],
    patterns: [
      {
        // Angular displacement: kick falls where you don't expect.
        0: [0.9, 0, 0, 0, 0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0.6, 0],
        3: [0, 0, 0.45, 0, 0, 0, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0.85, 0, 0, 0],
        8: [0, 0.4, 0, 0, 0, 0, 0.4, 0, 0, 0.4, 0, 0, 0, 0, 0.4, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0],
        13: [0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
    ],
  },
  // ── Ambient (the spacey side — Kranky label) ────────────
  {
    id: "postrock.ambient",
    genre: "postrock",
    name: "Ambient",
    bpm: [60, 85],
    swing: 0.1,
    activePads: [0, 3, 9, 11],
    patterns: [
      {
        // Barely there: one kick, a whisper of ride.
        0: [0.7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        3: [0, 0, 0, 0, 0, 0, 0, 0, 0.35, 0, 0, 0, 0, 0, 0, 0],
        9: [0.2, 0, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 0, 0.2, 0, 0, 0],
        11: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3],
      },
    ],
  },
];
