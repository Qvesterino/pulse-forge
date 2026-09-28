import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * UKG (UK garage) grooves — the swung 2-step shuffle with the snare landing
 * on the 2nd 16th of the backbeat, chopped-vocal space, sub-bass wobble.
 * 128–140 BPM (the lane house.ukg covered, now first-class).
 *
 * Pad indices (default kit): 0 kick, 1 kick punch, 4 snare, 6 clap,
 * 7 shaker, 8 hat closed, 10 hat open.
 */
export const UKG_GROOVES: GrooveData[] = decodeGrooves([
  // ── UK Garage (the classic shuffle) ─────────────────────
  {
    id: "ukg.ukg",
    genre: "ukg",
    name: "UK Garage",
    bpm: [130, 138],
    swing: 0.3,
    activePads: [0, 1, 4, 6, 7, 8, 10],
    patterns: [
      {
        0: "g0K4K8KcK",
        1: "g0w",
        4: "g4HcH",
        6: "gcEeu",
        7: "g0d2d4d6d8dadcded",
        8: "g1s3q5s7q9sbqdsfq",
        10: "g6yey",
      },
      {
        0: "g0K4K6q8KcK",
        1: "g0u",
        4: "g4HcH",
        6: "gcE",
        7: "g0a2a4a6a8aaacaea",
        8: "g1q3s5q7s9qbsdqfs",
        10: "g6wew",
      },
      {
        0: "g0K4K8KcK",
        1: "g0w",
        4: "g4HcH",
        6: "gcEeu",
        7: "g0d2d4d6d8dadcded",
        8: "g1u3n5u7n9ubndufn",
        10: "g6yey",
      },
    ],
  },
  // ── Bassline (sub-forward, harder shuffle) ──────────────
  {
    id: "ukg.bassline",
    genre: "ukg",
    name: "Bassline",
    bpm: [132, 140],
    swing: 0.26,
    activePads: [0, 1, 4, 6, 8, 10],
    patterns: [
      {
        0: "g0O4K8OcK",
        1: "g0y6q",
        4: "g4KcK",
        6: "gcHew",
        8: "g1q3n5q7n9qbndqfn",
        10: "g6weu",
      },
    ],
  },
  // ── Deep (heartbeat-adjacent, the emotional lane) ───────
  {
    id: "ukg.deep",
    genre: "ukg",
    name: "Deep",
    bpm: [130, 136],
    swing: 0.24,
    activePads: [0, 4, 6, 7, 8],
    patterns: [
      {
        0: "g0K6u8KcHes",
        4: "g4HcH",
        6: "gcBes",
        7: "g0a2a4a6a8aaacaea",
        8: "g1q3n5q7n9qbndqfn",
      },
    ],
  },
]);
