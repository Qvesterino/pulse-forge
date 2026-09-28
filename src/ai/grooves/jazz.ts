import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Jazz proper + turntablism — the swing tradition riding the BOOMBAP genre
 * (boom bap IS jazz-break culture; the dusty kit is the shared instrument).
 *
 *   bebop        — the 200+ club floor: feathered kick, comping snare,
 *                  the ride carries everything, 200–260.
 *   swing        — the big-band 4: the Basie ride, kick on 1 & 3, hat
 *                  stomps 2 & 4, 120–180.
 *   bigband      — the full section shout: denser comping, tom fills,
 *                  the 2-beat engine under the saxes, 130–190.
 *   turntablism  — the scratch crew floor: boom-bap skeleton with the
 *                  transformer flares and chirps on the fx pads, 85–100.
 *
 * The ride pattern is the genre's spine: swung 8ths with the skip
 * (1, 2-and, 3, 4-and → steps 0, 3, 4/5, 7, 8/9, 11, 12/13, 15 at swing).
 */
export const JAZZ_GROOVES: GrooveData[] = decodeGrooves([
  // ── Bebop ────────────────────────────────────────────────
  {
    id: "boombap.bebop",
    genre: "boombap",
    name: "Bebop",
    bpm: [200, 260],
    swing: 0.58,
    activePads: [0, 4, 5, 11],
    patterns: [
      {
        // The bop floor: ride swung 8ths with the skip, feathered kick
        // quarter notes, snare comping accents.
        11: "g0s2n3l4s6n7l8sanblcsenfl",
        0: "g0k4j8kcj",
        4: "g6k9nel",
        5: "g1h7edh",
      },
      {
        // The Max Roach variant: snare comping denser, kick drops bombs.
        11: "g0t2p3n4t6p7n8tapbnctepfn",
        0: "g0l6n8kcp",
        4: "g2l4n7kalcnfk",
        5: "g0j3h6j8hbjeh",
      },
    ],
  },
  // ── Swing ────────────────────────────────────────────────
  {
    id: "boombap.swing",
    genre: "boombap",
    name: "Swing",
    bpm: [120, 180],
    swing: 0.62,
    activePads: [0, 4, 8, 11],
    patterns: [
      {
        // The Basie 4: ride 8ths, hat stomp 2 & 4 (closed hat), kick light
        // on 1 & 3 — the dancer's engine.
        11: "g0r2l3k4r6l7k8ralbkcrelfk",
        8: "g4qcq",
        0: "g0n8l",
        4: "g4lcl",
      },
      {
        // The shuffle variant: the triplet ride pushes harder.
        11: "g0s2p3l4s6p7l8sapblcsepfl",
        8: "g4rcr",
        0: "g0p6k8nek",
        4: "g2k4nakcn",
      },
    ],
  },
  // ── Big band ─────────────────────────────────────────────
  {
    id: "boombap.bigband",
    genre: "boombap",
    name: "Big Band",
    bpm: [130, 190],
    swing: 0.6,
    activePads: [0, 4, 8, 11, 12, 13],
    patterns: [
      {
        // The section shout: 2-beat kick (1 & 3), snare backbeat, tom
        // section punches, ride driving underneath.
        0: "g0u8t",
        4: "g4scs",
        8: "g4pcp",
        11: "g0q2k3j4q6k7j8qakbjcqekfj",
        12: "g5ndp",
        13: "g3lbl",
      },
      {
        // The shout chorus: kicks double, tom fills roll, full energy.
        0: "g0v3k6q8ubkeq",
        4: "g2n4t7kanctfk",
        8: "g4qcq",
        11: "g0r2n3k4r6n7k8ranbkcrenfk",
        12: "g1n2p3q5n6p9napbqdnep",
        13: "g0p4q8pcq",
      },
    ],
  },
  // ── Turntablism ──────────────────────────────────────────
  {
    id: "boombap.turntablism",
    genre: "boombap",
    name: "Turntablism",
    bpm: [85, 100],
    swing: 0.12,
    activePads: [0, 1, 4, 5, 8, 14, 15],
    patterns: [
      {
        // The crew floor: boom-bap skeleton with transformer flares on the
        // fx pads between the drum anchors.
        0: "g0K6y8Jes",
        1: "g3qbq",
        4: "g4EcE",
        8: "g0l2l4l6l8lalclel",
        15: "g1k2n3k6l7j9kanelfj",
        14: "g5ldn",
      },
      {
        // The battle routine: chirp triplets, the beat drops out for the
        // scratch showcase bar.
        0: "g0J8H",
        4: "g4DcD",
        15: "g0n1n2q3n5p6p8n9naqdpep",
        5: "g2j7iajfi",
        14: "g1k3k6l9kbkel",
      },
    ],
  },
]);
