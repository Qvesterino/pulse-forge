import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Genre hybrids — blend characteristics from two genres.
 * These use pad conventions from both parent genres.
 */

export const HYBRID_GROOVES: GrooveData[] = decodeGrooves([
  // ── Tech House ───────────────────────────────────────
  // House 4-on-the-floor + techno kick and ride, moderate swing
  {
    id: "hybrid.techhouse",
    genre: "house",
    name: "Tech House",
    bpm: [124, 130],
    swing: 0.1,
    activePads: [2, 1, 6, 8, 10, 11, 7],
    patterns: [
      // Techno kick with house hat groove
      {
        2: "g0K4K8KcK",
        1: "g0u8u",
        6: "g4HcH",
        8: "g1u3q5u7q9ubqdufq",
        10: "g6yey",
        11: "g0d8d",
        7: "g0a2a4a6a8aaacaea",
      },
      // Tech house with offbeat ride
      {
        2: "g0K4K8KcK",
        1: "g0u8u",
        6: "g4HcH",
        8: "g1q3w5q7w9qbwdqfw",
        10: "g6BeB",
        11: "g2hah",
        7: "g0d2d4d6d8dadcded",
      },
      // Tech house sparse with ride
      {
        2: "g0K4K8KcK",
        1: "g0s8s",
        6: "g4HcH",
        8: "g3n7nbnfn",
        10: "g6wew",
        11: "g0a8a",
        7: "g0727476787a7c7e7",
      },
      // Tech house bouncy
      {
        2: "g0K4K8KcK",
        1: "g0u8u",
        6: "g4HcH",
        8: "g1y3q5y7q9ybqdyfq",
        10: "g6EeE",
        11: "g0d6dad",
        7: "g0a2a4a6a8aaacaea",
      },
      // Tech house minimal
      {
        2: "g0K4K8KcK",
        1: "g0s8s",
        6: "g4E",
        8: "g3k7kbkfk",
        10: "g6ueu",
        7: "g0727476787a7c7e7",
      },
      // Tech house groovy
      {
        2: "g0K4K8KcK",
        1: "g0u8u",
        6: "g4HcH",
        8: "g1w3q5w7q9wbqdwfq",
        10: "g6yaqey",
        11: "g0d6ded",
        7: "g0d2d4d6d8dadcded",
      },
    ],
  },

  // ── Ambient Techno ───────────────────────────────────
  // Techno kick + ambient percussion, low swing, spacious
  {
    id: "hybrid.ambienttechno",
    genre: "techno",
    name: "Ambient Techno",
    bpm: [118, 126],
    swing: 0.12,
    activePads: [2, 6, 8, 10, 7, 9, 14],
    patterns: [
      // Techno kick with ambient shaker/hat
      {
        2: "g0H4H8HcH",
        6: "g4ycy",
        8: "g3k7kbkfk",
        10: "g6qeq",
        7: "g0a2a4a6a8aaacaea",
        9: "g3777b7f7",
        14: "g076687e6",
      },
      // Ambient techno spacious
      {
        2: "g0H4H8HcH",
        6: "g4ycy",
        8: "g3h7hbhfh",
        10: "g6nen",
        7: "g0727476787a7c7e7",
        9: "g3676b6f6",
        14: "g066486e4",
      },
      // Ambient techno evolving
      {
        2: "g0H4H8HcH",
        6: "g4ycy",
        8: "g3k7kbkfk",
        10: "g6qeq",
        7: "g0826486688a6c8e6",
        9: "f145494d4",
        14: "g066486e4",
      },
      // Ambient techno sparse
      {
        2: "g0H4H8HcH",
        6: "g4w",
        8: "g3d7dbdfd",
        10: "g6kek",
        7: "g0727476787a7c7e7",
        9: "g3474b4f4",
        14: "g046284e2",
      },
      // Ambient techno minimal
      {
        2: "g0H4H8HcH",
        6: "g4y",
        8: "g3h7hbhfh",
        10: "g6nen",
        7: "g0727476787a7c7e7",
        9: "g3676b6f6",
        14: "g066486e4",
      },
      // Ambient techno deep
      {
        2: "g0H4H8HcH",
        6: "g4ycy",
        8: "g3k7kbkfk",
        10: "g6qeq",
        7: "g0a274a678aa7cae7",
        9: "g2666a6e6",
        14: "g076687e6",
      },
    ],
  },

  // ── Lo-fi Trap ───────────────────────────────────────
  // Trap half-time feel with lo-fi swing and organic percussion
  {
    id: "hybrid.lofimap",
    genre: "trap",
    name: "Lo-fi Trap",
    bpm: [80, 95],
    swing: 0.2,
    activePads: [0, 5, 8, 10, 7, 14],
    patterns: [
      // Lo-fi trap with organic shaker
      {
        0: "g0H8Beu",
        5: "g4H",
        8: "g1u3h5u7h9ubhdufh",
        10: "g6q",
        7: "g0a274a678aa7cae7",
        14: "g076687e6",
      },
      // Lo-fi trap spacious
      {
        0: "g0H8y",
        5: "g4H",
        8: "g1q3d5q7d9qbddqfd",
        10: "g6n",
        7: "g0726476687a6c7e6",
        14: "g066486e4",
      },
      // Lo-fi trap bouncy
      {
        0: "g0H6u8Beq",
        5: "g4H",
        8: "g1u3d5u7d9ubddufd",
        10: "g6q",
        7: "g0a274a678aa7cae7",
        14: "g076687e6",
      },
      // Lo-fi trap minimal
      {
        0: "g0H",
        5: "g4H",
        8: "g3a7abafa",
        10: "g6k",
        7: "g0726476687a6c7e6",
        14: "g046284e2",
      },
      // Lo-fi trap evolving
      {
        0: "g0H8Beq",
        5: "g4HcE",
        8: "g1s3d5s7d9sbddsfd",
        10: "g6n",
        7: "g0827486788a7c8e7",
        14: "g066486e4",
      },
      // Lo-fi trap with rim
      {
        0: "g0H8y",
        5: "g4H",
        8: "g1q3d5q7d9qbddqfd",
        10: "g6n",
        7: "g0726476687a6c7e6",
        14: "g066486e4",
      },
    ],
  },
  // ── Nu skool / progressive breaks, 125-140. The defining trait is
  // that the kick is NOT on every quarter note: a swung, fragmented rhythm
  // that bounces rather than stomps. The module's namesake crossover.
  {
    id: "hybrid.breaks",
    genre: "house",
    name: "Breaks (nu skool)",
    bpm: [125, 140],
    swing: 0.18,
    activePads: [0, 4, 8, 10, 12, 14],
    patterns: [
      {
        0: [0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        3: [0, 0, 0, 0, 0, 0, 0, 0, 0.65, 0, 0, 0, 0, 0, 0, 0],
        6: [0.85, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        8: [0, 0, 0, 0, 0.78, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        10: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0],
        12: [0.8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        14: [0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0],
      },
    ],
  },
  // ── UK bass: the post-garage / post-dubstep umbrella at 120-140. Not a
  // single rigid rhythm but a culture: sub weight, syncopated percussion,
  // British club lineage. The most honest "hybrid" of all of them.
  {
    id: "hybrid.ukbass",
    genre: "ukg",
    name: "UK Bass (post-garage)",
    bpm: [120, 140],
    swing: 0.16,
    activePads: [0, 2, 4, 8, 9, 14],
    patterns: [
      {
        0: [0.88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.85, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        6: [0, 0, 0, 0, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0, 0, 0],
        8: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        10: [0.82, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        12: [0, 0, 0, 0, 0.75, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        14: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0],
      },
    ],
  },
  // ── Progressive breaks: the long-form narrative branch, 125-135. The
  // structure is the point — builds that keep developing rather than
  // loop-and-drop.
  {
    id: "hybrid.progbreaks",
    genre: "house",
    name: "Progressive Breaks (narrative)",
    bpm: [125, 135],
    swing: 0.1,
    activePads: [2, 4, 8, 9, 10, 15],
    patterns: [
      {
        0: [0.72, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0, 0, 0, 0, 0],
        8: [0.7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.38],
        14: [0.48, 0, 0, 0, 0, 0, 0, 0, 0.44, 0, 0, 0, 0, 0, 0, 0],
      },
    ],
  },
  // ── Moombah: 100-115, dembow rhythms carrying a halftime feel. The
  // fourth hybrid axis: Latin/dancehall rhythm at bass-music weight.
  {
    id: "hybrid.moombah",
    genre: "latin",
    name: "Moombah (dembow)",
    bpm: [100, 115],
    swing: 0.14,
    activePads: [0, 4, 8, 10, 12, 13],
    patterns: [
      {
        0: [0.85, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        3: [0, 0, 0, 0, 0, 0, 0, 0, 0.75, 0, 0, 0, 0, 0, 0, 0],
        6: [0.8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        8: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        10: [0.82, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        14: [0.7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
    ],
  },
]);
