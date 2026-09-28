import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Folk / bluegrass / gospel — the acoustic Americana family riding the
 * HOUSE genre (the countrypop precedent: acoustic traditions take the
 * organic pop floor with their own groove engines).
 *
 *   folk         — the coffeehouse strum: brushed kick 1 & 3, palm snare,
 *                  tambourine 8ths, 90–120.
 *   bluegrass    — the train beat: kick 1 & 3 + the snare "claw" 2 & 4 with
 *                  the galloping 8ths, 108–140 (Monroe/Scruggs energy).
 *   gospel       — the Sunday pocket: shuffle-weighted kick, tambourine
 *                  8ths, hand claps on 2 & 4, 72–96 for the slow-fill
 *                  tradition (the choir provides the rest).
 *
 * Pad indices (default kit): 0 kick, 3 rim, 4 snare, 5 snare tight,
 * 6 clap, 7 shaker/tambourine, 8 hat closed, 12 tom low, 13 tom high.
 */
export const FOLK_GROOVES: GrooveData[] = decodeGrooves([
  // ── Folk ─────────────────────────────────────────────────
  {
    id: "house.folk",
    genre: "house",
    name: "Folk",
    bpm: [90, 120],
    swing: 0.16,
    activePads: [0, 4, 5, 6, 7],
    patterns: [
      {
        // The coffeehouse strum: soft kick 1 & 3, brushed snare 2 & 4,
        // tambourine keeps the 8ths honest.
        0: "g0z8x",
        4: "g4qcq",
        5: "g2e6daeed",
        7: "g0e2e4g6e8eaecgee",
      },
      {
        // The foot-stomp variant (the Lumineers floor): kick + clap only.
        0: "g0E6n8Den",
        6: "g4scs",
        5: "g3dbd",
      },
    ],
  },
  // ── Bluegrass ────────────────────────────────────────────
  {
    id: "house.bluegrass",
    genre: "house",
    name: "Bluegrass",
    bpm: [108, 140],
    swing: 0.08,
    activePads: [0, 4, 5, 8],
    patterns: [
      {
        // The train beat: kick 1 & 3, snare claw 2 & 4, galloping 8ths —
        // the banjo roll is implied by the hat drive.
        0: "g0H8F",
        4: "g4xcx",
        5: "g1k2l5k6l9kaldkel",
        8: "g0n1n2n3n4n5n6n7n8n9nanbncndnenfn",
      },
      {
        // The Monroe cut-time: kick adds the 3-and push, busier snare
        // double on the 4-and.
        0: "g0H6q8E",
        4: "g4y7ncy",
        5: "g1l2n5l6n9landlenfq",
        8: "g0o1o2o3o4o5o6o7o8o9oaobocodoeofo",
      },
    ],
  },
  // ── Gospel ───────────────────────────────────────────────
  {
    id: "house.gospel",
    genre: "house",
    name: "Gospel",
    bpm: [72, 96],
    swing: 0.28,
    activePads: [0, 4, 6, 7, 12],
    patterns: [
      {
        // The Sunday pocket: shuffle kick with the 3-and pickup, claps on
        // 2 & 4, tambourine 8ths — the Hammond leans back.
        0: "g0K6v8Hcq",
        4: "g4scs",
        6: "g4ucu",
        7: "g0l2l4m6l8lalcmel",
        12: "g3lbl",
      },
      {
        // The shout-music lift: everything doubles, the tom roll carries
        // the choir into the modulation.
        0: "g0L2q4u6w8Jaqcuew",
        4: "g1n3n4u6n9nbncuen",
        6: "g4vcv",
        7: "g0m1m2m3m4m5m6m7m8m9mambmcmdmemfm",
        12: "g1n2p3q5n6p9napbqdnep",
      },
    ],
  },
]);
