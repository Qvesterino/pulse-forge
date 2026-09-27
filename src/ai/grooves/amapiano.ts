import type { GrooveData } from "../types";

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
export const AMAPIANO_GROOVES: GrooveData[] = [
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
        0: [0.75, 0, 0, 0, 0.75, 0, 0, 0, 0.75, 0, 0, 0, 0.75, 0, 0, 0],
        7: [0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.28],
        10: [0, 0, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 0, 0, 0, 0.5, 0],
        12: [0, 0, 0, 0.8, 0, 0, 0.55, 0, 0, 0, 0, 0.65, 0, 0, 0.45, 0],
      },
      {
        // The MDU walk: the log climbs across both toms.
        0: [0.75, 0, 0, 0, 0.75, 0, 0, 0, 0.75, 0, 0, 0, 0.75, 0, 0, 0],
        7: [0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.28],
        12: [0, 0, 0.65, 0, 0, 0, 0, 0.5, 0, 0, 0.7, 0, 0, 0, 0, 0],
        13: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0.45],
      },
      {
        // The deep answer: toms trade low-high across the phrase.
        0: [0.75, 0, 0, 0, 0.75, 0, 0, 0, 0.75, 0, 0, 0, 0.75, 0, 0, 0],
        7: [0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.22, 0.3, 0.28],
        12: [0, 0, 0, 0.75, 0, 0, 0, 0.5, 0, 0, 0.6, 0, 0, 0, 0, 0],
        13: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.65, 0, 0.5, 0.4],
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
        0: [0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0],
        3: [0, 0, 0.35, 0, 0, 0, 0.3, 0, 0, 0, 0.35, 0, 0, 0, 0.3, 0],
        7: [0.26, 0.18, 0.26, 0.18, 0.26, 0.18, 0.26, 0.18, 0.26, 0.18, 0.26, 0.18, 0.26, 0.18, 0.26, 0.22],
        10: [0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0.45, 0],
        12: [0, 0, 0, 0.65, 0, 0, 0, 0.45, 0, 0, 0.6, 0, 0, 0, 0, 0],
      },
      {
        // The patient answer: one log phrase, held longer.
        0: [0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0],
        7: [0.26, 0.18, 0.26, 0.18, 0.26, 0.18, 0.26, 0.18, 0.26, 0.18, 0.26, 0.18, 0.26, 0.18, 0.26, 0.22],
        12: [0, 0, 0, 0, 0.55, 0, 0, 0.4, 0, 0, 0, 0.6, 0, 0, 0, 0.35],
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
        0: [0.9, 0, 0, 0, 0.85, 0, 0, 0, 0.9, 0, 0, 0, 0.85, 0, 0, 0],
        1: [0.5, 0, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        7: [0.24, 0.18, 0.24, 0.18, 0.24, 0.18, 0.24, 0.18, 0.24, 0.18, 0.24, 0.18, 0.24, 0.18, 0.24, 0.2],
        12: [0, 0, 0, 0.7, 0, 0, 0.5, 0, 0, 0, 0.7, 0, 0, 0, 0.5, 0],
        14: [0, 0, 0.35, 0, 0, 0, 0.35, 0, 0, 0, 0.35, 0, 0, 0, 0.35, 0],
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
        0: [0.8, 0, 0, 0.55, 0.8, 0, 0, 0, 0.8, 0, 0, 0.5, 0.8, 0, 0, 0],
        3: [0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0],
        7: [0.28, 0.2, 0.28, 0.2, 0.28, 0.2, 0.28, 0.2, 0.28, 0.2, 0.28, 0.2, 0.28, 0.2, 0.28, 0.24],
        11: [0, 0, 0, 0.35, 0, 0, 0.35, 0, 0, 0, 0.35, 0, 0, 0, 0.35, 0],
        12: [0, 0, 0.6, 0, 0, 0, 0, 0.45, 0, 0, 0.55, 0, 0, 0, 0, 0.4],
        14: [0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0],
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
        0: [0.92, 0, 0, 0, 0.88, 0, 0, 0, 0.92, 0, 0, 0, 0.88, 0, 0, 0],
        1: [0.55, 0, 0, 0, 0.5, 0, 0, 0, 0.55, 0, 0, 0, 0.5, 0, 0, 0],
        7: [0.26, 0.2, 0.26, 0.2, 0.26, 0.2, 0.26, 0.2, 0.26, 0.2, 0.26, 0.2, 0.26, 0.2, 0.26, 0.22],
        12: [0, 0, 0, 0.72, 0, 0, 0.55, 0, 0, 0, 0.72, 0, 0, 0, 0.55, 0],
        14: [0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0.25],
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
        0: [0.78, 0, 0, 0, 0.78, 0, 0, 0, 0.78, 0, 0, 0, 0.78, 0, 0, 0],
        3: [0, 0, 0.4, 0, 0, 0, 0.35, 0, 0, 0, 0.4, 0, 0, 0, 0.35, 0],
        7: [0.28, 0.2, 0.28, 0.2, 0.28, 0.2, 0.28, 0.2, 0.28, 0.2, 0.28, 0.2, 0.28, 0.2, 0.28, 0.24],
        10: [0, 0, 0, 0, 0, 0, 0.42, 0, 0, 0, 0, 0, 0, 0, 0.46, 0],
        12: [0, 0, 0.62, 0, 0, 0, 0, 0.48, 0, 0, 0.62, 0, 0, 0, 0, 0],
        13: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0.4, 0.35],
      },
    ],
  },
];
