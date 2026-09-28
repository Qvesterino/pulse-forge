import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Balkan pop-folk + emo/digicore + niches — the long-tail wave. Balkan
 * rides EURODANCE (the beats literally ARE eurodance under folk melody);
 * digicore/dariacore ride HYPERPOP (their parent scene); emo rap rides
 * TRAP; the niches land on their closest floors.
 *
 *   turbofolk  — the Serbian big-room folk: 4-floor + offbeat hats under
 *                the oriental brass, 100–130 (Ceca / Baja).
 *   chalga     — the Bulgarian cousin: same engine, the percussion
 *                chatter heavier, 100–132 (Gloria / Preslava).
 *   manele     — the Romanian street wedding: swing-light eurodance floor
 *                with the accordion cries, 95–125 (Adi de la Vâlcea).
 */
export const BALKAN_GROOVES: GrooveData[] = decodeGrooves([
  // ── Turbofolk ────────────────────────────────────────────
  {
    id: "eurodance.turbofolk",
    genre: "eurodance",
    name: "Turbofolk",
    bpm: [100, 130],
    swing: 0.02,
    activePads: [0, 4, 6, 8, 10, 12],
    patterns: [
      {
        // The big-room folk engine: 4-floor, clap 2 & 4, offbeat open
        // hats, the tom doubling the brass stabs.
        0: "g0L4L8LcL",
        4: "g4zcz",
        6: "g4wcw",
        8: "g0p2p4p6p8papcpep",
        10: "g1s3s5s7s9sbsdsfs",
        12: "g2q6paqep",
      },
      {
        // The brass-stab variant: kick doubles on the ands, toms roll.
        0: "g0M3q4M7q8MbqcMfq",
        4: "g4AcA",
        8: "g0q2q4q6q8qaqcqeq",
        10: "g1t3t5t7t9tbtdtft",
        12: "g0q3p4q7p8qbpcqfp",
      },
    ],
  },
  // ── Chalga ───────────────────────────────────────────────
  {
    id: "eurodance.chalga",
    genre: "eurodance",
    name: "Chalga",
    bpm: [100, 132],
    swing: 0.04,
    activePads: [0, 4, 6, 8, 12, 13],
    patterns: [
      {
        // The chalga chatter: same eurodance floor with busier percussion
        // answers between the beats.
        0: "g0K4K8KcK",
        4: "g4ycy",
        6: "g4vcv",
        8: "g0n2n4n6n8nancnen",
        12: "g1n4p6n9ncpen",
        13: "g2l6nalen",
      },
      {
        // The payner-ballad lift: half-time feel opening, toms carry.
        0: "g0J8I",
        4: "g4xcx",
        8: "g0l2l4l6l8lalclel",
        12: "g3obo",
        13: "g0m4o8mco",
      },
    ],
  },
  // ── Manele ───────────────────────────────────────────────
  {
    id: "eurodance.manele",
    genre: "eurodance",
    name: "Manele",
    bpm: [95, 125],
    swing: 0.1,
    activePads: [0, 4, 6, 8, 10, 12, 13],
    patterns: [
      {
        // The wedding engine: eurodance floor with the light swing and
        // the violin/accordion syncopation implied on the toms.
        0: "g0K4K8KcK",
        4: "g4xcx",
        6: "g3n4ubncu",
        8: "g0m2m4m6m8mamcmem",
        10: "g1r3r5r7r9rbrdrfr",
        12: "g2o5paodp",
      },
      {
        // The balkan-oriental variant: the 9/8 feel flattened to a
        // lopsided 16 — the kick pushes the offbeat.
        0: "g0J3q4J8JbqcJ",
        4: "g4ycy",
        6: "g4vcv",
        8: "g0o2o4o6o8oaocoeo",
        12: "g1p3p5o9pbpdo",
        13: "g6mem",
      },
    ],
  },
]);
