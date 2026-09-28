import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Drill grooves — half-time backbeat (snare on beat 3), sliding-808 kick
 * syncopation, busy hats. Pair with the drill kit swap (sub808 front kick,
 * dark snare) applied by applySongCommand.
 *
 * Pad indices (default kit): 0 kick(808), 1 kick alt, 4 snare, 8 hat closed,
 * 9 hat soft, 10 hat open.
 */
export const DRILL_GROOVES: GrooveData[] = decodeGrooves([
  // ── UK Drill ──────────────────────────────────────────
  {
    id: "drill.uk",
    genre: "drill",
    name: "UK Drill",
    bpm: [140, 148],
    swing: 0.05,
    activePads: [0, 1, 4, 8, 9],
    patterns: [
      {
        0: "g0O6yaH",
        1: "g5sdq",
        4: "g8K",
        8: "g0q2n4q6n8qancqen",
        9: "g1d3d5d7d9dbdddfh",
      },
      {
        0: "g0O8Edy",
        1: "g2q7s",
        4: "g8K",
        8: "g0q2n3d4q6n8qanbdcqen",
        9: "g1d3d5d7h9dbdddfd",
      },
    ],
  },
  // ── Dark / sparse drill ───────────────────────────────
  {
    id: "drill.dark",
    genre: "drill",
    name: "Dark Drill",
    bpm: [140, 146],
    swing: 0.08,
    activePads: [0, 4, 8],
    patterns: [
      {
        0: "g0OaEfu",
        4: "g8H",
        8: "g0n4n8ncnek",
      },
      {
        0: "g0O3w8Hcu",
        4: "g8H",
        8: "g0n4n6k8ncnfk",
      },
    ],
  },
  // ── Drill bounce (busier hats) ────────────────────────
  {
    id: "drill.bounce",
    genre: "drill",
    name: "Drill Bounce",
    bpm: [142, 148],
    swing: 0.04,
    activePads: [0, 1, 4, 8, 9, 10],
    patterns: [
      {
        0: "g0O5u8Eby",
        1: "g2q7qdq",
        4: "g8K",
        8: "g0s1h2q3h4s5h6q7h8s9haqbhcsdheqfk",
        9: "g1a3a5a7d9abadafd",
        10: "g6k",
      },
    ],
  },
  // ── Sample drill (Bronx/NY sample-driven bounce) ──────
  // Bouncy syncopated 808 pattern with a swung snare accent on the last
  // 16th, chopped-sample feel, punchy open-hat push.
  {
    id: "drill.sample",
    genre: "drill",
    name: "Sample Drill",
    bpm: [140, 150],
    swing: 0.1,
    activePads: [0, 1, 4, 8, 10],
    patterns: [
      {
        0: "g0O3q6y8Hbs",
        1: "g2n7qbn",
        4: "g8Kfn",
        8: "g0s2q4s6q8saqcseqfk",
        10: "g6ncn",
      },
      {
        0: "g0O2n6B8Hbqeq",
        1: "g2n7qcn",
        4: "g8Ken",
        8: "g0s2q4s6q8saqbhcseqfh",
        10: "g6ncn",
      },
    ],
  },

  // ── Hyper drill (NY hyper / Jersey-drill crossover) ───
  // 150-162: aggressive sliding-808 bounce at a pushed tempo, punchy open
  // accents, the hype drill energy from the NY scene.
  {
    id: "drill.hyper",
    genre: "drill",
    name: "Hyper Drill",
    bpm: [150, 162],
    swing: 0.0,
    activePads: [0, 1, 4, 8, 10],
    patterns: [
      {
        0: "g0O2q6w8Kbqeu",
        1: "g2n7qcn",
        4: "g8Keq",
        8: "g0s2q4s6q7h8saqbhcseqfk",
        10: "g6qcq",
      },
      {
        0: "g0O3q7s8Kbqes",
        1: "g2n7qcn",
        4: "g8Keq",
        8: "g0s1h2q3h4s5h6q7h8s9haqbhcsdheqfk",
        10: "g2n6qaneq",
      },
    ],
  },

  // ── Melodic drill (guitar/melodic loops, softer) ──────
  // 138-145: gentler groove for melodic/guitar drill loops — rolling hats,
  // softer snare accents, room for the sample to breathe.
  {
    id: "drill.melodic",
    genre: "drill",
    name: "Melodic Drill",
    bpm: [138, 145],
    swing: 0.12,
    activePads: [0, 1, 4, 8, 9],
    patterns: [
      {
        0: "g0K6u8Ebq",
        1: "g2k7ndk",
        4: "g8Eeh",
        8: "g0q2k4q6k8qakcqek",
        9: "g1d3a5d7a9dbaddfa",
      },
      {
        0: "g0K5q8Ebn",
        1: "g2k7kck",
        4: "g8E",
        8: "g0q2k4q6k8qakcqek",
        9: "g1a3d5a7d9abddafd",
      },
    ],
  },

  // ── Grime (140 eski) ──────────────────────────────────
  // 138-144: nearly straight (no swing), syncopated eski kick stabs,
  // sharp snare answers, the percussion 16ths do the talking.
  {
    id: "drill.grime",
    genre: "drill",
    name: "Grime",
    bpm: [138, 144],
    swing: 0.02,
    activePads: [0, 4, 8, 6, 10],
    patterns: [
      {
        0: "g0K7uaB",
        4: "g4EcE",
        8: "g0q2k4q6k8qakcqek",
        6: "g2hahek",
        10: "g6qeq",
      },
      {
        0: "g0K5saBdq",
        4: "g4E7hcEek",
        8: "g0q2k3h4q6k8qakbhcqek",
        6: "g6hdh",
      },
    ],
  },
  // ── Jerk: the clapping pattern is the identity. Triple-time snare
  // roll on top of a 2-step kick, clap doubled hard on the offbeat.
  {
    id: "drill.jerk",
    genre: "drill",
    name: "Jerk (clap-driven)",
    bpm: [140, 146],
    swing: 0.12,
    activePads: [0, 6, 8, 10, 14],
    patterns: [
      {
        0: "g0L6s",
        2: "g6q",
        4: "g0J6s",
        6: "geh",
        8: "g6r",
        10: "g0K6s",
        12: "g",
        14: "g0y4u8ycu",
      },
    ],
  },
  // ── Brooklyn: the 808 is the whole track. Long gliding sub, sparse
  // hats, snare on the 3 rather than a rolling pattern.
  {
    id: "drill.brooklyn",
    genre: "drill",
    name: "Brooklyn (long glide)",
    bpm: [142, 148],
    swing: 0.06,
    activePads: [0, 4, 8, 10, 15],
    patterns: [
      {
        0: "g0O",
        4: "g4H",
        8: "g8J",
        10: "gan",
        15: "gfq",
      },
    ],
  },
  // ── Chopped hip hop: half-time everything, snares dragged behind the
  // grid, the 808 under a swung loop.
  {
    id: "drill.chopped",
    genre: "drill",
    name: "Chopped hip hop (half-time)",
    bpm: [84, 92],
    swing: 0.18,
    activePads: [0, 5, 8, 12, 14],
    patterns: [
      {
        0: "g0K",
        4: "g8B",
        8: "g8E",
        12: "g0w",
        14: "g4s8u",
      },
    ],
  },
]);
