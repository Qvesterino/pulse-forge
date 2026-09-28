import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Emo/digicore + the niche long tail — the final wave of the vocabulary
 * gap. Digicore/dariacore ride HYPERPOP (their parent scene), emo rap
 * rides TRAP, the niches land on their closest floors:
 *
 *   digicore    — the Discord-bred bedroom burst: fast, glassy, the kicks
 *                 stutter, 150–170 (ericdoa / glaive).
 *   dariacore   — the hyper-splice: everything pitched, flipped and
 *                 thrown, 160–200 (dariacore is a splice sport).
 *   emorap      — the guitar-loop trap: half-time snare, melancholy
 *                 melodies above, 130–150 (Lil Peep / nothing,nowhere).
 *   dungeonsynth — the cellar fantasy: slow ceremonial percussion, 60–90
 *                 (rides DRONE — the ambient metal tradition).
 *   singeli     — the Tanzanian sprint: frantic 180–220 4-floor with the
 *                 percussion chatter (rides HOUSE with gqom/singeli).
 *   mahraganat  — the Egyptian street: heavy syncopated perc over a
 *                 marching floor, 100–140 (rides HOUSE).
 *   makina      — the Spanish hardcore descendant: 170–185 4-floor with
 *                 offbeat bass (rides TECHNO with gabber).
 *   hardwave    — the hard trap × wave hybrid: half-time snares under
 *                 detuned melancholy, 120–140 (rides HYBRID).
 *   slowcore    — the patient rock: sparse kick 1 & 3, nothing hurries,
 *                 55–75 (rides POSTROCK — its quiet cousin).
 */
export const EMO_NICHE_GROOVES: GrooveData[] = decodeGrooves([
  // ── Digicore ─────────────────────────────────────────────
  {
    id: "hyperpop.digicore",
    genre: "hyperpop",
    name: "Digicore",
    bpm: [150, 170],
    swing: 0,
    activePads: [0, 4, 8, 10, 15],
    patterns: [
      {
        // The bedroom burst: driving kick with the 2-and push, glassy
        // hats, blip stutters between.
        0: "g0L4L6u8LcLeu",
        4: "g4zcz",
        8: "g0q2q4q6q8qaqcqeq",
        10: "g1t3t5t7t9tbtdtft",
        15: "g1l4n7landl",
      },
      {
        // The stutter-drop: kick mutes, the vox-chop blips carry.
        0: "g0K3s4K7s8KbscKfs",
        4: "g4AcA",
        8: "g0r3r6r8rbrer",
        15: "g0p1p3n4p6n8p9pbncpen",
      },
    ],
  },
  // ── Dariacore ────────────────────────────────────────────
  {
    id: "hyperpop.dariacore",
    genre: "hyperpop",
    name: "Dariacore",
    bpm: [160, 200],
    swing: 0,
    activePads: [0, 1, 4, 6, 10, 15],
    patterns: [
      {
        // The hyper-splice: everything at once — kicks, claps, pitched
        // blips flipping every half bar.
        0: "g0O3q4O7q8ObqcOfq",
        1: "g2s6sases",
        4: "g4D7kcDfk",
        6: "g1n4u9ncu",
        10: "g1u5u9udu",
        15: "g0q1n2q5n6q7n9qancqen",
      },
      {
        // The flip-every-bar variant: the pattern itself never settles.
        0: "g0M2q4M7s8MaqcMfs",
        4: "g1q4B6n9qcBen",
        6: "g0s4s8scs",
        15: "g0n2q3n6q8naqbneq",
        10: "g1v3v6v9vbvev",
      },
    ],
  },
  // ── Emo rap ──────────────────────────────────────────────
  {
    id: "trap.emorap",
    genre: "trap",
    name: "Emo Rap",
    bpm: [130, 150],
    swing: 0,
    activePads: [0, 4, 8, 10, 15],
    patterns: [
      {
        // The guitar-loop trap: half-time snare on 3, melodic hats,
        // the blip = the guitar refrain.
        0: "g0L6ucs",
        4: "g8H",
        8: "g0q2q4q6q8qaqcqeq",
        10: "g3ucu",
        15: "g2nan",
      },
      {
        // The sad-drop: sparser, the space hurts more.
        0: "g0Kcu",
        4: "g8F",
        8: "g0n3q6n8nbqen",
        10: "g5sds",
      },
    ],
  },
  // ── Dungeon synth ────────────────────────────────────────
  {
    id: "drone.dungeonsynth",
    genre: "drone",
    name: "Dungeon Synth",
    bpm: [60, 90],
    swing: 0,
    activePads: [0, 3, 12, 13],
    patterns: [
      {
        // The cellar ceremony: slow ceremonial kick on 1, the rim bell
        // tolls, toms circle — the pads carry the fantasy.
        0: "g0y",
        3: "g4kel",
        12: "g2hah",
        13: "g0e6hfe",
      },
      {
        // The march variant: a processional double-step.
        0: "g0z4n8zcn",
        3: "g4lcl",
        12: "g2jaj",
      },
    ],
  },
  // ── Singeli ──────────────────────────────────────────────
  {
    id: "house.singeli",
    genre: "house",
    name: "Singeli",
    bpm: [180, 220],
    swing: 0,
    activePads: [0, 4, 8, 12, 13],
    patterns: [
      {
        // The sprint: relentless 4-floor at 200 with the percussion
        // chatter doubling — the Tanzanian fire.
        0: "g0K4K8KcK",
        4: "g4scs",
        8: "g0n1n2n3n4n5n6n7n8n9nanbncndnenfn",
        12: "g0q2q4q6q8qaqcqeq",
        13: "g1p3p5p7p9pbpdpfp",
      },
      {
        // TheLog-drum variant: the toms carry the melody-chatter.
        0: "g0K4K8KcK",
        4: "g4tct",
        8: "g0l2l4l6l8lalclel",
        12: "g0p1n2p3n4p5n6p7n8p9napbncpdnepfn",
        13: "g0n2n4n6n8nancnen",
      },
    ],
  },
  // ── Mahraganat ───────────────────────────────────────────
  {
    id: "house.mahraganat",
    genre: "house",
    name: "Mahraganat",
    bpm: [100, 140],
    swing: 0.06,
    activePads: [0, 4, 6, 8, 12, 13],
    patterns: [
      {
        // The street march: big kick with the syncopated push, heavy
        // percussion answers — the Egyptian wedding storm.
        0: "g0O4u6y8Kcu",
        4: "g4xcx",
        6: "g3qbq",
        8: "g0n2n4n6n8nancnen",
        12: "g1q4r7q9qcrfq",
        13: "g0p3p7p8pbpfp",
      },
      {
        // The electro-mahragan variant: busier 16th percussion.
        0: "g0M3q4u6x8Kbqcu",
        4: "g4ycy",
        6: "g4s7ncsfn",
        8: "g0p1p2p3p4p5p6p7p8p9papbpcpdpepfp",
        12: "g0q2p4q6p8qapcqep",
        13: "g1o3o5o9obodo",
      },
    ],
  },
  // ── Makina ───────────────────────────────────────────────
  {
    id: "techno.makina",
    genre: "techno",
    name: "Makina",
    bpm: [170, 185],
    swing: 0,
    activePads: [0, 4, 6, 8, 10, 14],
    patterns: [
      {
        // The Spanish hardcore descendant: hard 4-floor, offbeat open
        // hats, the tick rolls driving.
        0: "g0R4R8RcR",
        4: "g4ycy",
        8: "g0q2q4q6q8qaqcqeq",
        10: "g1u3u5u7u9ubudufu",
        14: "g2n6nanen",
      },
      {
        // The anthemic variant: claps join, tick rolls double.
        0: "g0R4R8RcR",
        4: "g4zcz",
        6: "g4scs",
        8: "g0q1q2q3q4q5q6q7q8q9qaqbqcqdqeqfq",
        10: "g1v3v5v7v9vbvdvfv",
      },
    ],
  },
  // ── Hardwave ─────────────────────────────────────────────
  {
    id: "trap.hardwave",
    genre: "trap",
    name: "Hardwave",
    bpm: [120, 140],
    swing: 0,
    activePads: [0, 4, 8, 10, 15],
    patterns: [
      {
        // The trap × wave hybrid: half-time snare on 3, detuned
        // melancholy above (blip), the hats keep the wave motion. Rides TRAP
        // (the hybrid.ts pattern: hybrid lanes ride a real parent genre).
        0: "g0K6wcq",
        4: "g8F",
        8: "g0n2n4n6n8nancnen",
        10: "g3qcq",
        15: "g2kak",
      },
      {
        // The harder drop: kicks busier, the grit pushes.
        0: "g0L3q6waqcs",
        4: "g8G",
        8: "g0p3p6p8pbpep",
        10: "g5rdr",
        15: "g0l4n8lcn",
      },
    ],
  },
  // ── Slowcore ─────────────────────────────────────────────
  {
    id: "postrock.slowcore",
    genre: "postrock",
    name: "Slowcore",
    bpm: [55, 75],
    swing: 0.08,
    activePads: [0, 4, 5, 8],
    patterns: [
      {
        // The patient floor: kick 1 & 3, brushed snare 2 & 4 — at 60 bpm
        // each bar is four long seconds and nothing hurries.
        0: "g0w8u",
        4: "g4lcl",
        5: "g6ded",
        8: "g0c4c8ccc",
      },
      {
        // The Red House Painters variant: even the hats sit out.
        0: "g0x8v",
        4: "g4kck",
        5: "g2cac",
      },
    ],
  },
]);
