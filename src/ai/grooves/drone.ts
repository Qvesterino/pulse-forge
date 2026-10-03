import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Drone / neo-classical grooves — the texture-over-beat genre promoted from
 * `ambient/drifting`. The drums here are ATMOSPHERE, not groove: patterns are
 * intentionally sparse (the density profile caps at 0.5), and the schools map
 * the Wikipedia tree of texture composition:
 *
 *   drone         — the sustained-tone school (Stars of the Lid / Lustmord /
 *                   Sunn O))): near-silent percussion under the swell, 40–70.
 *   minimalism    — the pulsing school (Steve Reich / Terry Riley / Philip
 *                   Glass): a metronomic soft pulse, 85–130.
 *   neoclassical  — the piano-and-strings school (Max Richter / Einaudi /
 *                   Hans Zimmer): brushed kit, sparse accents, 55–90.
 *   isolationism  — the dark/sparse school (Kammarheit / Biosphere /
 *                   Loscil): one hit, then silence, 45–80.
 *   electroacoustic — the modular-electronic school (Caterina Barbieri /
 *                   Kali Malone / Alessandro Cortini): clicks + ticks only,
 *                   55–95.
 *   score         — the film-score school (Morricone / Badalamenti /
 *                   Jóhann Jóhannsson): timpani-ish toms + cymbal swell,
 *                   55–95.
 *
 * Pad indices (default kit): 0 kick, 1 kick punch, 3 rim, 4 snare, 7 shaker,
 * 11 ride, 12 tom low, 13 tom high, 14 tick, 15 blip.
 */
export const DRONE_GROOVES: GrooveData[] = decodeGrooves([
  // ── Drone (the sustained-tone school) ───────────────────
  {
    id: "drone.drone",
    genre: "drone",
    name: "Drone",
    bpm: [40, 70],
    swing: 0.12,
    activePads: [0, 3, 7, 11],
    patterns: [
      {
        // One kick per bar, a tick, a whisper of shaker — the swell is bass.
        0: "g0u",
        3: "g8h",
        7: "g44c4",
        11: "g07",
      },
      {
        0: "g0uek",
        3: "g3d",
        7: "g44c4",
        14: "g6a",
      },
    ],
  },
  // ── Minimalism (the pulsing school) ─────────────────────
  {
    id: "drone.minimalism",
    genre: "drone",
    name: "Minimalism",
    bpm: [85, 130],
    swing: 0.0,
    activePads: [0, 7, 11, 14],
    patterns: [
      {
        // The metronomic pulse — a soft kick on every beat, nothing else.
        0: "g0s4s8scs",
        7: "g0727476787a7c7e7",
        11: "ged",
        14: "g0d8d",
      },
      {
        // The pattern shifts every 8 bars (Reich phase).
        0: "g0s8scs",
        7: "g2757a7e7",
        14: "g2dad",
      },
    ],
  },
  // ── Neoclassical (the piano-and-strings school) ─────────
  {
    id: "drone.neoclassical",
    genre: "drone",
    name: "Neoclassical",
    bpm: [55, 90],
    swing: 0.05,
    activePads: [0, 4, 7, 12, 13],
    patterns: [
      {
        // Brushed kit: a soft backbeat under the piano line.
        0: "g0y4y8ycy",
        4: "g4qcq",
        7: "g0626466686a6c6e6",
        12: "gek",
        13: "g3h",
      },
      {
        // The strings lift — tom answer, harder backbeat.
        0: "g0y4y8ycyeq",
        4: "g4scs",
        7: "g0626466686a6c6e6",
        12: "g2k7h",
        13: "g6hfh",
      },
    ],
  },
  // ── Isolationism (the dark/sparse school) ───────────────
  {
    id: "drone.isolationism",
    genre: "drone",
    name: "Isolationism",
    bpm: [45, 80],
    swing: 0.08,
    activePads: [0, 3, 11, 14],
    patterns: [
      {
        // One hit, then silence — the room IS the instrument.
        0: "g0w",
        3: "gck",
        11: "gaa",
        14: "g8d",
      },
      {
        0: "g0u8s",
        3: "geh",
        11: "g3d",
      },
    ],
  },
  // ── Electroacoustic (the modular-electronic school) ─────
  {
    id: "drone.electroacoustic",
    genre: "drone",
    name: "Electroacoustic",
    bpm: [55, 95],
    swing: 0.02,
    activePads: [3, 7, 14, 15],
    patterns: [
      {
        // No drums at all — clicks and ticks only (the modular patches ARE
        // the rhythm section).
        3: "g3kbk",
        7: "g1757a7e7",
        14: "g0h6dch",
        15: "g3dad",
      },
      {
        3: "g3k9h",
        14: "g2d7daded",
        15: "g0d8d",
      },
    ],
  },
  // ── Score (the film-score school) ───────────────────────
  {
    id: "drone.score",
    genre: "drone",
    name: "Score",
    bpm: [55, 95],
    swing: 0.06,
    activePads: [0, 4, 11, 12, 13],
    patterns: [
      {
        // Timpani-ish toms + a cymbal swell — the cinematic kit.
<<<<<<< Updated upstream
        0: "g0B4B8BcB",
        4: "g4ucu",
        11: "g0d2a4d6a8daacdea",
        12: "gcq",
        13: "g2k",
=======
        0: [0.75, 0, 0, 0, 0.75, 0, 0, 0, 0.75, 0, 0, 0, 0.75, 0, 0, 0],
        4: [0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0],
        11: [0.3, 0, 0.25, 0, 0.3, 0, 0.25, 0, 0.3, 0, 0.25, 0, 0.3, 0, 0.25, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0],
        13: [0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
>>>>>>> Stashed changes
      },
      {
        // The crescendo fill: tom roll into the downbeat.
        0: "g0E4B8EcB",
        4: "g4wcw",
        12: "g7qanek",
        13: "g1n3k6hbh",
        11: "g0d2a4d6a8daacdea",
      },
    ],
  },
]);
