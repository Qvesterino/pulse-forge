import type { GrooveData } from "../types";

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
export const DRONE_GROOVES: GrooveData[] = [
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
        0: [0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        3: [0, 0, 0, 0, 0, 0, 0, 0, 0.35, 0, 0, 0, 0, 0, 0, 0],
        7: [0, 0, 0, 0, 0.15, 0, 0, 0, 0, 0, 0, 0, 0.15, 0, 0, 0],
        11: [0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
      {
        0: [0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0],
        3: [0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        7: [0, 0, 0, 0, 0.15, 0, 0, 0, 0, 0, 0, 0, 0.15, 0, 0, 0],
        14: [0, 0, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0],
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
        0: [0.55, 0, 0, 0, 0.55, 0, 0, 0, 0.55, 0, 0, 0, 0.55, 0, 0, 0],
        7: [0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0],
        11: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0],
        14: [0.3, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0],
      },
      {
        // The pattern shifts every 8 bars (Reich phase).
        0: [0.55, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0, 0.55, 0, 0, 0],
        7: [0, 0, 0.2, 0, 0, 0.2, 0, 0, 0, 0, 0.2, 0, 0, 0, 0.2, 0],
        14: [0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0],
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
        0: [0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0],
        4: [0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0],
        7: [0.18, 0, 0.18, 0, 0.18, 0, 0.18, 0, 0.18, 0, 0.18, 0, 0.18, 0, 0.18, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0],
        13: [0, 0, 0, 0.35, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
      {
        // The strings lift — tom answer, harder backbeat.
        0: [0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0.5, 0],
        4: [0, 0, 0, 0, 0.55, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0],
        7: [0.18, 0, 0.18, 0, 0.18, 0, 0.18, 0, 0.18, 0, 0.18, 0, 0.18, 0, 0.18, 0],
        12: [0, 0, 0.4, 0, 0, 0, 0, 0.35, 0, 0, 0, 0, 0, 0, 0, 0],
        13: [0, 0, 0, 0, 0, 0, 0.35, 0, 0, 0, 0, 0, 0, 0, 0, 0.35],
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
        0: [0.65, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        3: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0],
        11: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0],
        14: [0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0],
      },
      {
        0: [0.6, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0, 0, 0, 0, 0],
        3: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.35, 0],
        11: [0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
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
        3: [0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0, 0],
        7: [0, 0.2, 0, 0, 0, 0.2, 0, 0, 0, 0, 0.2, 0, 0, 0, 0.2, 0],
        14: [0.35, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0.35, 0, 0, 0],
        15: [0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0],
      },
      {
        3: [0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0.35, 0, 0, 0, 0, 0, 0],
        14: [0, 0, 0.3, 0, 0, 0, 0, 0.3, 0, 0, 0.3, 0, 0, 0, 0.3, 0],
        15: [0.3, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0],
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
        0: [0.75, 0, 0, 0, 0.75, 0, 0, 0, 0.75, 0, 0, 0, 0.75, 0, 0, 0],
        4: [0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0],
        11: [0.3, 0, 0.25, 0, 0.3, 0, 0.25, 0, 0.3, 0, 0.25, 0, 0.3, 0, 0.25, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0],
        13: [0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
      {
        // The crescendo fill: tom roll into the downbeat.
        0: [0.8, 0, 0, 0, 0.75, 0, 0, 0, 0.8, 0, 0, 0, 0.75, 0, 0, 0],
        4: [0, 0, 0, 0, 0.65, 0, 0, 0, 0, 0, 0, 0, 0.65, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0.45, 0, 0, 0, 0.4, 0],
        13: [0, 0.45, 0, 0.4, 0, 0, 0.35, 0, 0, 0, 0, 0.35, 0, 0, 0, 0],
        11: [0.3, 0, 0.25, 0, 0.3, 0, 0.25, 0, 0.3, 0, 0.25, 0, 0.3, 0, 0.25, 0],
      },
    ],
  },
];
