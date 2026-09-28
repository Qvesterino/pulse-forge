import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Amapiano grooves — the South African log-drum genre, promoted from
 * `house.amapiano` to a first-class genre with its Wikipedia-documented
 * school tree:
 *
 *   yanos     — the core sound (Kabza De Small / MDU aka TRP): quiet
 *               four-on-the-floor deep-house kick, busy semiquaver shaker,
 *               syncopated rounded log-drum bass answering on the toms, 110–116.
 *   soulful   — "private school piano" (Kelvin Momo): sparser log drum, mellow
 *               shaker, progressive jazz chords with room for live instruments,
 *               108–114.
 *   sgija     — the S'gija school: the stripped gqom-adjacent pocket — fewer
 *               elements, harder kick, one hypnotic log phrase, 112–118.
 *   bacardi   — new-age bacardi (Mellow & Sleazy "Trust Fund"): the slowed
 *               Pretoria bacardi mutation, raw synth stabs + cowbell-ish tick,
 *               108–114.
 *   quantum   — Quantum Sound (RealShaunMusiq / Sizwe Nineteen / Nandipha808):
 *               gqom-2.0 re-edit energy — the taxi kick, 112–120.
 *   popiano   — the pop-facing variant (Tyla "Water"): the log drum under a
 *               pop-adjacent vocal pocket, cleaner and brighter, 108–116.
 *
 * Pad indices (default kit): 0 kick, 1 kick punch, 3 rim, 7 shaker, 10 hat
 * open, 11 ride, 12 tom low, 13 tom high, 14 tick.
 */
export const AMAPIANO_GROOVES: GrooveData[] = decodeGrooves([
  // ── Yanos (the core log-drum sound) ─────────────────────
  {
    id: "amapiano.yanos",
    genre: "amapiano",
    name: "Yanos",
    bpm: [110, 116],
    swing: 0.08,
    activePads: [0, 7, 10, 12, 13],
    patterns: [
      {
        // The canonical Kabza pocket: quiet floor + the log-drum answer.
        0: "g0B4B8BcB",
        7: "g0d182d384d586d788d98adb8cdd8edfc",
        10: "g6neq",
        12: "g3E6sbwen",
      },
      {
        // The MDU walk: the log climbs across both toms.
        0: "g0B4B8BcB",
        7: "g0d182d384d586d788d98adb8cdd8edfc",
        12: "g2w7qay",
        13: "gcufn",
      },
      {
        // The deep answer: toms trade low-high across the phrase.
        0: "g0B4B8BcB",
        7: "g0d182d384d586d788d98adb8cdd8edfc",
        12: "g3B7qau",
        13: "gcweqfk",
      },
    ],
  },
  // ── Soulful / private school piano (Kelvin Momo) ────────
  {
    id: "amapiano.soulful",
    genre: "amapiano",
    name: "Soulful",
    bpm: [108, 114],
    swing: 0.1,
    activePads: [0, 3, 7, 10, 12],
    patterns: [
      {
        // Sparser log drum, mellow shaker, room for the jazz chords.
        0: "g0y4y8ycy",
        3: "g2h6dahed",
        7: "g0b162b364b566b768b96abb6cbd6ebf8",
        10: "g6ken",
        12: "g3w7nau",
      },
      {
        // The patient answer: one log phrase, held longer.
        0: "g0y4y8ycy",
        7: "g0b162b364b566b768b96abb6cbd6ebf8",
        12: "g4s7kbufh",
      },
    ],
  },
  // ── S'gija (the stripped gqom-adjacent pocket) ──────────
  {
    id: "amapiano.sgija",
    genre: "amapiano",
    name: "S'gija",
    bpm: [112, 118],
    swing: 0.05,
    activePads: [0, 1, 7, 12, 14],
    patterns: [
      {
        // Harder kick, one hypnotic log phrase, tick instead of open hat.
        0: "g0K4H8KcH",
        1: "g0q6n",
        7: "g09162936495669768996a9b6c9d6e9f7",
        12: "g3y6qayeq",
        14: "g2h6haheh",
      },
    ],
  },
  // ── Bacardi (new-age bacardi, the slowed Pretoria mutation) ─
  {
    id: "amapiano.bacardi",
    genre: "amapiano",
    name: "Bacardi",
    bpm: [108, 114],
    swing: 0.12,
    activePads: [0, 3, 7, 11, 12, 14],
    patterns: [
      {
        // Raw synth-stab energy: the rim carries the "stab" tick, ride swings.
        0: "g0E3s4E8EbqcE",
        3: "g4kck",
        7: "g0c172c374c576c778c97acb7ccd7ecf9",
        11: "g3h6haheh",
        12: "g2u7nasfk",
        14: "g1d5d9ddd",
      },
    ],
  },
  // ── Quantum Sound (gqom 2.0 / taxi-kick re-edits) ───────
  {
    id: "amapiano.quantum",
    genre: "amapiano",
    name: "Quantum",
    bpm: [112, 120],
    swing: 0.04,
    activePads: [0, 1, 7, 12, 14],
    patterns: [
      {
        // The taxi kick: doubled punch on the floor, driving tick pattern.
        0: "g0L4J8LcJ",
        1: "g0s4q8scq",
        7: "g0b172b374b576b778b97abb7cbd7ebf8",
        12: "g3z6sazes",
        14: "g0d2d4d6d8dadcdedfa",
      },
    ],
  },
  // ── Popiano (the pop-facing variant — Tyla "Water") ─────
  {
    id: "amapiano.popiano",
    genre: "amapiano",
    name: "Popiano",
    bpm: [108, 116],
    swing: 0.09,
    activePads: [0, 3, 7, 10, 12, 13],
    patterns: [
      {
        // Cleaner + brighter: the log drum still leads, the top is open.
        0: "g0D4D8DcD",
        3: "g2k6hakeh",
        7: "g0c172c374c576c778c97acb7ccd7ecf9",
        10: "g6leo",
        12: "g2v7pav",
        13: "gcqekfh",
      },
    ],
  },
]);
