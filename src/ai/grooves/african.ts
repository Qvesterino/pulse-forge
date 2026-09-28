import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * African-roots grooves — the foundational West/Central African + Indian
 * Ocean popular traditions, riding the HOUSE genre (the established route:
 * afrobeats, afropop and kuduro already live there — these are their
 * ancestors, not electronic offshoots).
 *
 *   highlife      — the Ghanaian guitar-band highlife: bell-driven,
 *                   syncopated, bright, 110–130 (E.T. Mensah / Osibisa).
 *   soukous       — the Congolese rumba engine: 4-floor kick under flying
 *                   sebene guitar, shaker 8ths, 115–140 (Kanda Bongo Man,
 *                   Diblo Dibala).
 *   zouk          — the Antillean kassav groove: mid-tempo, syncopated
 *                   kick with the gwo-ka layer, 95–112.
 *   kizomba       — the Angolan slow groove: heavy sensual kick, sparse
 *                   percussion, everything sways, 90–108.
 *   coupledecale  — the Ivorian/Paris boucant: bumpy syncopated kick,
 *                   percussive and proud, 105–122 (Douk Saga / Borosangui).
 *
 * Pad indices (default kit): 0 kick, 1 kick punch, 3 rim/clave, 4 snare,
 * 5 snare tight, 6 clap, 7 shaker/guiro, 8 hat closed, 10 hat open,
 * 11 ride, 12 tom low/conga, 13 tom high/timbale, 14 tick, 15 blip.
 */
export const AFRICAN_GROOVES: GrooveData[] = decodeGrooves([
  // ── Highlife ────────────────────────────────────────────
  {
    id: "house.highlife",
    genre: "house",
    name: "Highlife",
    bpm: [110, 130],
    swing: 0.12,
    activePads: [0, 3, 7, 8, 12, 13, 15],
    patterns: [
      {
        // The guitar-band engine: light kick 1 & 3+, the gankogui bell
        // (12-bar bell pattern compressed to one bar), congas answer.
        0: "g0F4q7n8Ecqes",
        3: "g0q3q6q8qbqeq",
        7: "g0n2n4n6n8nancnen",
        12: "g2q4s7qaqcsfq",
        13: "g1n4q7n9qcn",
        8: "g0k3l6k8kblek",
      },
      {
        // The palm-wine variant: lighter, the guitar (blip) carries.
        0: "g0D7k8Ben",
        3: "g0n4n8ncn",
        7: "g0k2k4k6k8kakckek",
        12: "g1l3n5l9lbndl",
        13: "g2l6nalen",
        15: "g1k4n9kcn",
      },
      {
        // The burger-highlife lift: disco-flavored, busier hats.
        0: "g0H4q7q8Hcqeq",
        3: "g0p3p6p8pbpep",
        7: "g0l1l2l3l4l5l6l7l8l9lalblcldlelfl",
        8: "g0n2n4n6n8nancnen",
        12: "g2q6qaqeq",
        13: "g0n4q8ncq",
      },
    ],
  },
  // ── Soukous ──────────────────────────────────────────────
  {
    id: "house.soukous",
    genre: "house",
    name: "Soukous",
    bpm: [115, 140],
    swing: 0.08,
    activePads: [0, 4, 5, 7, 8, 12, 13],
    patterns: [
      {
        // The rumba engine: steady kick, light snare 2+4, shaker 8ths,
        // conga tumba — the guitars fly above.
        0: "g0J6q8Jeq",
        4: "g4vcv",
        5: "g2k6kakek",
        7: "g0q1q2q3q4q5q6q7q8q9qaqbqcqdqeqfq",
        8: "g0l2l4l6l8lalclel",
        12: "g1n4q7n9ncqfn",
      },
      {
        // The sebene sprint: everything doubles, the dance climax.
        0: "g0K3n6q8Kbneq",
        4: "g2s4x7kascxfk",
        7: "g0r1r2r3r4r5r6r7r8r9rarbrcrdrerfr",
        8: "g0n1n2n3n4n5n6n7n8n9nanbncndnenfn",
        12: "g0p2n4q6p8naqcpen",
        13: "g1l3p5l7p9lbpdlfp",
      },
      {
        // The slower rumba-odém opening: half-time feel, patient.
        0: "g0H8F",
        4: "g4scs",
        7: "g0k2k4k6k8kakckek",
        8: "g0j4j8jcj",
        12: "g2n6nanen",
      },
    ],
  },
  // ── Zouk ─────────────────────────────────────────────────
  {
    id: "house.zouk",
    genre: "house",
    name: "Zouk",
    bpm: [95, 112],
    swing: 0.1,
    activePads: [0, 3, 4, 6, 7, 12, 13],
    patterns: [
      {
        // The kassav engine: the syncopated kick with the ti-bwa layer
        // (the ka chinka on the toms), clap on the backbeat.
        0: "g0K4s7k8Hcqfn",
        4: "g4ucu",
        6: "g4scs",
        7: "g0k2k4k6k8kakckek",
        12: "g1n5n9ndn",
        13: "g2l6nalen",
      },
      {
        // The zouklove slow-dance variant: airier, rim clicks.
        0: "g0H4q8Fcn",
        3: "g1k4l9kcl",
        6: "g4qcq",
        7: "g0j2j4j6j8jajcjej",
        12: "g2l6lalel",
      },
    ],
  },
  // ── Kizomba ──────────────────────────────────────────────
  {
    id: "house.kizomba",
    genre: "house",
    name: "Kizomba",
    bpm: [90, 108],
    swing: 0.14,
    activePads: [0, 3, 7, 12, 13],
    patterns: [
      {
        // The Angolan sway: heavy kick 1 & the 3-and pickup, everything
        // else sparse — the body provides the motion.
        0: "g0O8Beu",
        3: "g2jaj",
        7: "g0e2e4e6e8eaeceee",
        12: "g3kbk",
        13: "g5kdk",
      },
      {
        // The tarraxinha pocket: tighter, the percussive body-roll.
        0: "g0L6s8Dfq",
        3: "g2h6haheh",
        12: "g1j5j9jdj",
        13: "g3i7ibifi",
        7: "g0d4d8dcd",
      },
    ],
  },
  // ── Coupé-décalé ─────────────────────────────────────────
  {
    id: "house.coupledecale",
    genre: "house",
    name: "Coupé-Décalé",
    bpm: [105, 122],
    swing: 0.06,
    activePads: [0, 4, 6, 7, 8, 12, 13],
    patterns: [
      {
        // The boucant: the bumpy syncopated kick (1, 2-and, 4), percussive
        // snaps, proud and loud — the travail au bord energy.
        0: "g0L3s6y8Hcu",
        4: "g4u7ncu",
        6: "g3nbn",
        7: "g0l2l4l6l8lalclel",
        8: "g0k2k4k6k8kakckek",
        13: "g1n4q9ncq",
      },
      {
        // The atalakou variant: call-and-response toms drive.
        0: "g0K3q6w8Jbqcs",
        4: "g4tct",
        6: "g6qeq",
        12: "g0p2p5q8papdq",
        13: "g1n3n7p9nbnfp",
        7: "g0k2k4k6k8kakckek",
      },
    ],
  },
]);
