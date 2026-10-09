import type { GrooveData } from "../types";

/**
 * Rock proper — the backline genre (promoted 2026-10-09 from the alt/indie
 * house lanes). Three engines, each a different demand on the kit:
 *
 *   backbeat  — THE rock engine: kick 1 & 3 (+ the 8th ante), cracking snare
 *               on 2 & 4, driving 8th hats, crash accent on the downbeat,
 *               100–140.
 *   halftime  — the 70–95 heavyweight: half-time feel (snare lands on 3),
 *               tom-heavy fills, the room to breathe between riffs.
 *   punk      — the 150–190 drive: four-on-the-floor kick, snare 2 & 4,
 *               straight 8ths with no swing — the energy IS the arrangement.
 *
 * Swing stays 0 everywhere: rock is the grid-locked genre (the feel comes
 * from velocity dynamics — the kit's RR/dynamic sets — not from timing).
 */
export const ROCK_GROOVES: GrooveData[] = [
  {
    id: "rock.backbeat",
    genre: "rock",
    name: "Backbeat",
    bpm: [100, 140],
    swing: 0,
    activePads: [0, 1, 4, 8, 10, 12, 13],
    patterns: [
      {
        // The canonical engine: kick 1/3 + the "and of 3" push, snare 2 & 4,
        // 8th hats, crash accent on 1, tom pickup into the repeat.
        0: [0.95, 0, 0, 0, 0, 0, 0.62, 0, 0.9, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0.92, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0],
        8: [0.7, 0, 0.5, 0, 0.7, 0, 0.5, 0, 0.7, 0, 0.5, 0, 0.7, 0, 0.55, 0],
        10: [0.85, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.55, 0],
      },
      {
        // The anthem variant: kick doubles the 3rd beat, snare digs in,
        // tom answer on the 4-and.
        0: [0.95, 0, 0, 0, 0, 0, 0.88, 0, 0.9, 0, 0.6, 0, 0, 0, 0, 0],
        4: [0, 0, 0.95, 0, 0, 0, 0, 0, 0, 0, 0.92, 0, 0, 0, 0, 0],
        8: [0.75, 0, 0.55, 0, 0.75, 0, 0.55, 0, 0.75, 0, 0.55, 0, 0.75, 0, 0.6, 0],
        10: [0.85, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        13: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0],
      },
    ],
  },
  {
    id: "rock.halftime",
    genre: "rock",
    name: "Half-Time",
    bpm: [70, 95],
    swing: 0,
    activePads: [0, 1, 4, 8, 12, 13],
    patterns: [
      {
        // The heavyweight pocket: kick 1, snare lands on 3 (half-time),
        // sparse 8th hats, tom chord under the turn.
        0: [0.95, 0, 0, 0, 0, 0, 0, 0, 0.62, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0.95, 0, 0, 0, 0, 0, 0, 0],
        8: [0.62, 0, 0.42, 0, 0.62, 0, 0.42, 0, 0.62, 0, 0.42, 0, 0.62, 0, 0.45, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0, 0, 0, 0, 0],
        13: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0],
      },
      {
        // The fill variant: toms walk the last beat into the repeat.
        0: [0.95, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0.95, 0, 0, 0, 0, 0, 0, 0],
        8: [0.65, 0, 0.45, 0, 0.65, 0, 0.45, 0, 0.65, 0, 0.45, 0, 0.65, 0, 0.5, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0.65, 0],
        13: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.7],
      },
    ],
  },
  {
    id: "rock.punk",
    genre: "rock",
    name: "Punk Drive",
    bpm: [150, 190],
    swing: 0,
    activePads: [0, 1, 4, 8, 10],
    patterns: [
      {
        // Four-on-the-floor kick, snare 2 & 4, straight 8ths all the way.
        0: [0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0],
        4: [0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0],
        8: [0.78, 0, 0.6, 0, 0.78, 0, 0.6, 0, 0.78, 0, 0.6, 0, 0.78, 0, 0.6, 0],
        10: [0.8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
      {
        // The D-beat variant: the doubled kick pushes the offbeats.
        0: [0.9, 0, 0.7, 0, 0.9, 0, 0.7, 0, 0.9, 0, 0.7, 0, 0.9, 0, 0.7, 0],
        4: [0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0],
        8: [0.8, 0, 0.62, 0, 0.8, 0, 0.62, 0, 0.8, 0, 0.62, 0, 0.8, 0, 0.62, 0],
        10: [0.8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
    ],
  },
];
