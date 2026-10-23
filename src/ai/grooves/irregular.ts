import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * THE IRREGULAR GROOVE LIBRARY (ADR 0057 Stage 2j).
 *
 * The library was 4/4 material: 258 grooves, every row sixteen sixteenth
 * steps, written for a bar with four beats. A 7/8 document therefore played a
 * 4/4 groove read at the metrical bar — the metrical view re-voiced the kick
 * and the snare onto the irregular metre's groups (Stage 2i), but the GHOST
 * NOTES, the hat rhythm and the percussion were still a 4/4 groove's, and no
 * groove in the library was WRITTEN in an odd metre.
 *
 * This file is that material. A groove here DECLARES its metre
 * (`timeSignature`), and its rows are that metrical bar long — fourteen
 * sixteenths for 7/8, ten for 5/8. The declared metre is what makes the
 * groove a candidate for a document in the same metre and keeps it out of a
 * 4/4 one, so a 4/4 document still hashes over exactly the candidate set it
 * always did.
 *
 * ## The grouping is written into the music, not inferred
 *
 * - **7/8 = 2+2+3** — the eighths "1-2 | 3-4 | 5-6-7"; the group downbeats
 *   are the steps 0, 4 and 8, and the accent group is the long one at step 8.
 * - **5/8 = 3+2** — the eighths "1-2-3 | 4-5"; the group downbeats are the
 *   steps 0 and 6, and the accent group is the second one at step 6.
 *
 * Both are DECLARED (ADR 0057 Stage 2i): the signature does not say which
 * grouping a bar uses, and the product does not guess one.
 *
 * ## What a row here may assume
 *
 * The metrical view re-voices the kick onto the group downbeats and the
 * backbeat onto the accent group. So a groove written in the metre is ALREADY
 * in the metre: the kick sits on the groups, the clap on the accent, and the
 * view moves nothing. `tests/adr0057-irregular-library.test.ts` proves that
 * for every row here.
 *
 * The rules the rows obey:
 *
 * 1. The KICK lanes ride the GROUP downbeats — one hit per group, in order.
 * 2. The CLAP / SNARE sits on the ACCENT group — ONE hit. An irregular bar has
 *    one accent besides its downbeat.
 * 3. The closed hat rides the off-beat sixteenths (the house shuffle) or the
 *    eighths (the rock pocket).
 * 4. The open hat sits two sixteenths before the accent and two before the
 *    bar line — the 4/4 house rule (6 and 14) carried into the odd bar.
 * 5. The shaker rides the eighths; the toms answer at the end of the long
 *    group.
 *
 * AUTHORED BY `scratch/author-irregular.mts` — the numeric source, encoded
 * with the library's own compact codec.
 */
export const IRREGULAR_GROOVES: GrooveData[] = decodeGrooves([
  {
    id: "house.seven8",
    genre: "house",
    name: "Seven Eight",
    bpm: [120, 128],
    swing: 0.12,
    timeSignature: { numerator: 7, denominator: 8 },
    activePads: [0, 1, 6, 7, 8, 10],
    patterns: [
      {
        0: "e0K4H8J",
        1: "e0y4w8x",
        6: "e8E",
        7: "e0d2d4d6d8dadcd",
        8: "e1q3n5q7n9qbndq",
        10: "e6ucu",
      },
      {
        0: "e0K4H8J",
        1: "e0y4w8x",
        6: "e8E",
        7: "e0h2d4h6d8hadch",
        8: "e1n3q5n7q9nbqdn",
        10: "e6wcw",
      },
      {
        0: "e0K4H8J",
        1: "e0y4w8x",
        6: "e8E",
        7: "e0d2d4d6d8dadcd",
        8: "e1q3n5q7n9qbn",
        10: "e6ucs",
      },
    ],
  },
  {
    id: "house.five8",
    genre: "house",
    name: "Five Eight",
    bpm: [122, 130],
    swing: 0.1,
    timeSignature: { numerator: 5, denominator: 8 },
    activePads: [0, 1, 6, 7, 8, 10],
    patterns: [
      {
        0: "a0K6J",
        1: "a0y6x",
        6: "a6E",
        7: "a0d2d4d6d8d",
        8: "a1q3n5q7n9q",
        10: "a4u8u",
      },
      {
        0: "a0K6J",
        1: "a0y6x",
        6: "a6E",
        7: "a0h2d4h6d8h",
        8: "a1n3q5n7q9n",
        10: "a4w8w",
      },
      {
        0: "a0K6J",
        1: "a0y6x",
        6: "a6E",
        7: "a0d2d4d6d8d",
        8: "a1q3n5q7n9q",
        10: "a4u8s",
      },
    ],
  },
  {
    id: "techno.seven8",
    genre: "techno",
    name: "Seven Eight",
    bpm: [128, 136],
    swing: 0.02,
    timeSignature: { numerator: 7, denominator: 8 },
    activePads: [0, 6, 8, 10],
    patterns: [
      {
        0: "e0L4J8L",
        6: "e8E",
        8: "e1q3q5q7q9qbqdq",
        10: "e6scs",
      },
      {
        0: "e0L4J8L",
        6: "e8E",
        8: "e1n3n5n7n9nbndn",
        10: "e6ucu",
      },
      {
        0: "e0L4J8L",
        6: "e8E",
        8: "e1s3s5s7s9sbsds",
        10: "e6scq",
      },
    ],
  },
  {
    id: "eurodance.balkan78",
    genre: "eurodance",
    name: "Balkan 7/8",
    bpm: [110, 128],
    swing: 0.04,
    timeSignature: { numerator: 7, denominator: 8 },
    activePads: [0, 1, 6, 7, 12],
    patterns: [
      {
        0: "e0K4H8J",
        1: "e0y4w8x",
        6: "e8E",
        7: "e0c2c4c6c8caccc",
        12: "ebndq",
      },
      {
        0: "e0K4H8J",
        1: "e0y4w8x",
        6: "e8E",
        7: "e0929496989a9c9",
        12: "ebndn",
      },
      {
        0: "e0K4H8J",
        1: "e0y4w8x",
        6: "e8E",
        7: "e0d294d698da9cd",
        12: "ebqdq",
      },
    ],
  },
  {
    id: "eurodance.balkan58",
    genre: "eurodance",
    name: "Balkan 5/8",
    bpm: [112, 130],
    swing: 0.04,
    timeSignature: { numerator: 5, denominator: 8 },
    activePads: [0, 1, 6, 7, 12],
    patterns: [
      {
        0: "a0K6J",
        1: "a0y6x",
        6: "a6E",
        7: "a0c2c4c6c8c",
        12: "a9n",
      },
      {
        0: "a0K6J",
        1: "a0y6x",
        6: "a6E",
        7: "a0929496989",
        12: "a9n",
      },
      {
        0: "a0K6J",
        1: "a0y6x",
        6: "a6E",
        7: "a0d294d698d",
        12: "a9q",
      },
    ],
  },
  {
    id: "rock.seven8",
    genre: "rock",
    name: "Seven Eight",
    bpm: [96, 112],
    swing: 0.06,
    timeSignature: { numerator: 7, denominator: 8 },
    activePads: [0, 4, 6, 8, 12],
    patterns: [
      {
        0: "e0K4H8J",
        4: "e8E",
        6: "e8B",
        8: "e0s2s4s6s8sascs",
        12: "ebndq",
      },
      {
        0: "e0K4H8J",
        4: "e8E",
        6: "e8B",
        8: "e0q2q4q6q8qaqcq",
        12: "ebndn",
      },
      {
        0: "e0K4H8J",
        4: "e8D",
        6: "e8B",
        8: "e0s2s4s6s8sascs",
        12: "ebqdq",
      },
    ],
  },
]);
