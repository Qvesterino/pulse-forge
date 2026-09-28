import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Hyperpop grooves — maximalist, glitchy, drop-first. Distorted 808s,
 * stuttering hats, clap stacks. 140–170 BPM (the same lane trap.hyper
 * covered, now first-class).
 *
 * Pad indices (default kit): 0 kick, 1 kick punch, 5 snare tight, 6 clap,
 * 8 hat closed, 10 hat open, 14 tick, 15 blip.
 */
export const HYPERPOP_GROOVES: GrooveData[] = decodeGrooves([
  // ── Hyper (the default hyperpop drop) ───────────────────
  {
    id: "hyperpop.hyper",
    genre: "hyperpop",
    name: "Hyper",
    bpm: [145, 165],
    swing: 0.05,
    activePads: [0, 1, 5, 8, 10, 14, 15],
    patterns: [
      {
        0: "g0O3q6u8Kbqeu",
        1: "g0u3k8sbk",
        5: "g4KcKen",
        8: "g0q1q2h3q4q5q6h7q8q9qahbqcqdqehfq",
        10: "g2u6uaueufn",
        14: "g4qcq",
        15: "g2k5kakdk",
      },
      {
        0: "g0O2q6w8Kbqes",
        1: "g0u4k8uck",
        5: "g4KcKek",
        8: "g0q1h2q3h4q5h6q7h8q9haqbhcqdheqfh",
        10: "g1u5u9udu",
        15: "g0n4n8ncn",
      },
    ],
  },
  // ── Glitch (stutter-forward, sigilkore-adjacent) ────────
  {
    id: "hyperpop.glitch",
    genre: "hyperpop",
    name: "Glitch",
    bpm: [140, 160],
    swing: 0.03,
    activePads: [0, 5, 8, 14, 15],
    patterns: [
      {
        0: "g0O3n5q8Hbnfq",
        5: "g4HcH",
        8: "g0s1d2s3d4s5d6s7d8s9dasbdcsddesfd",
        14: "g2n4k6nancken",
        15: "g0k3h6k8kbhekfq",
      },
    ],
  },
  // ── Rage (the rage-beat dialect: bouncy, distorted) ─────
  {
    id: "hyperpop.rage",
    genre: "hyperpop",
    name: "Rage",
    bpm: [150, 170],
    swing: 0.08,
    activePads: [0, 1, 5, 8, 10],
    patterns: [
      {
        0: "g0O2s5u8Kasdu",
        1: "g0w4q8wcq",
        5: "g4KcK",
        8: "g0q1k2q3k4q5k6q7k8q9kaqbkcqdkeqfn",
        10: "g3s7sbsfu",
      },
    ],
  },
  // ── Deconstructed club (Wave 4) — A.G. Cook / 100 gecs / underscores ──
  // The PC Music maximalist lane (A.G. Cook 'Apple' / 100 gecs 'money
  // machine' / Underscores). Rapid snare rolls on pad 5, tick-stutter
  // artifacts, and a chopped blip counter-line. The glitch is the point:
  // 16th-note hats break into irregular bursts, and the backbeat lands
  // off-grid. BPM 140-160, swing 0.06 (near-grid but unstable).
  {
    id: "hyperpop.decon",
    genre: "hyperpop",
    name: "Decon",
    bpm: [140, 160],
    swing: 0.06,
    activePads: [0, 1, 5, 8, 14, 15],
    patterns: [
      {
        0: "g0K6u8Keu",
        1: "g2uau",
        5: "g4H9ucHfu",
        8: "g0q3n4q8qbncq",
        14: "g1h5h9hdh",
        15: "g2d6daded",
      },
      {
        // Snare roll into the downbeat
        0: "g0K4K8KcK",
        1: "g0u8u",
        5: "g4H6u8u9uaubucH",
        8: "g0q3n4q8qbncq",
        14: "g1h5h9hdh",
        15: "g2daded",
      },
      {
        // Kick stutters — the drop skips
        0: "g0K3u4K7u8Keu",
        1: "geu",
        5: "g4H9ucHfu",
        8: "g0q3n4q8qbncq",
        14: "g1h5h9hdh",
        15: "g0d4d8dcd",
      },
      {
        // Half-time decon — everything halves except the blip
        0: "g0K8K",
        1: "g",
        5: "g4HcH",
        8: "g0q4q8qcq",
        14: "g",
        15: "g2d6daded",
      },
    ],
  },
]);
