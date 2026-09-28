import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

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
export const POSTROCK_GROOVES: GrooveData[] = decodeGrooves([
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
        0: "g0E6ueq",
        3: "g3q",
        4: "g4y",
        9: "g1d5d9ddd",
        11: "g0d6dcd",
      },
      {
        // The "Spiderland" pattern: displaced kick, snare answers.
        0: "g0E6qbq",
        3: "g2kek",
        4: "g4ydq",
        9: "g0a4a8aca",
        11: "g3dbdfh",
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
        0: "g0E8y",
        4: "g4u",
        8: "g2d6daded",
        11: "g0d8d",
      },
      {
        // The build: tom fills, crash, full density.
        0: "g0K4E8KcE",
        4: "g4HcH",
        8: "g1k3k5k7k9kbkdkfn",
        11: "g0k2d4k6d8kadcked",
        12: "g3ueqfs",
        13: "g7qfq",
      },
      {
        // The peak: wall of sound, full kick + snare + toms.
        0: "g0O4K8OcK",
        4: "g4KcK",
        8: "g0q1h2q3h4q5h6q7h8q9haqbhcqdheqfk",
        11: "g0k2k4k6k8kakckek",
        12: "g2q6qaqeq",
        13: "g3q7qbqfq",
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
        0: "g0yek",
        4: "g4q",
        7: "g0727476787a7c7e7",
        11: "g6d",
        12: "gfk",
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
        0: "g0O6E",
        1: "g0u",
        4: "g4K",
        5: "gen",
        12: "gcs",
        13: "gfq",
      },
      {
        // Double-kick push into the build.
        0: "g0O3q6E8Kbq",
        4: "g4KcK",
        5: "geq",
        12: "g7qfq",
        13: "gcs",
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
        0: "g0K8Heu",
        3: "g2nan",
        4: "g4HcH",
        8: "g1k6k9kek",
        12: "g7q",
        13: "g3q",
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
        0: "g0y",
        3: "g8h",
        9: "g0767c7",
        11: "gfd",
      },
    ],
  },
]);
