import type { GrooveData } from "../types";

/**
 * Detroit grooves — the machine-funk lineage promoted to a first-class genre
 * (the Detroit techno + electro tradition, unified because the two share the
 * same drum-machine DNA: syncopated 808 kick talk, tom percussion, handclap
 * backbeats, no swing). Schools per the Wikipedia Detroit techno lineage:
 *
 *   belleville — the Belleville Three (Juan Atkins / Derrick May / Kevin
 *                Saunderson): 808 kick syncopation, tom talk, the futuristic
 *                dancefloor, 122–132.
 *   secondwave — Underground Resistance / Jeff Mills / Robert Hood: harder,
 *                stripped, militant, 130–140.
 *   technobass — the Detroit electro-bass school (AUX 88 / DJ Godfather
 *                lineage): 808 bass pressure + machine percussion, 120–135.
 *   electro    — the classic electro line (Cybotron / Egyptian Lover /
 *                Drexciya): the syncopated 808 with vocoder space, 118–132.
 *   ghettotech — the Detroit/Chicago fusion (DJ Assault): fast, raw, booty
 *                cuts, 140–150.
 *   minimal    — the reductionist line (Robert Hood's Minimal Nation, the
 *                Berlin-school descendant): one hypnotic element at a time,
 *                125–134.
 *
 * Pad indices (default kit): 0 kick, 1 kick punch, 2 kick techno, 3 rim,
 * 4 snare, 6 clap, 8 hat closed, 10 hat open, 11 ride, 12 tom low,
 * 13 tom high, 14 tick, 15 blip.
 */
export const DETROIT_GROOVES: GrooveData[] = [
  // ── Belleville (the first wave) ─────────────────────────
  {
    id: "detroit.belleville",
    genre: "detroit",
    name: "Belleville",
    bpm: [122, 132],
    swing: 0.04,
    activePads: [0, 3, 6, 12, 13, 15],
    patterns: [
      {
        // 808 kick syncopation + tom talk under the clap backbeat.
        0: [0.9, 0, 0, 0.55, 0, 0, 0.7, 0, 0.9, 0, 0, 0.5, 0, 0, 0.65, 0],
        3: [0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0],
        6: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0.85, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.45, 0],
        13: [0, 0, 0.55, 0, 0, 0, 0, 0.5, 0, 0, 0.55, 0, 0, 0, 0, 0.45],
        15: [0, 0.45, 0, 0, 0, 0.45, 0, 0, 0, 0.45, 0, 0, 0, 0.45, 0, 0],
      },
      {
        // The "Strings of Life" lift: extra kick push into the clap.
        0: [0.9, 0, 0, 0.6, 0, 0, 0.7, 0, 0.9, 0, 0.5, 0, 0, 0, 0.6, 0],
        6: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0.85, 0, 0.5, 0],
        12: [0, 0, 0.55, 0, 0, 0, 0, 0.5, 0, 0, 0.55, 0, 0, 0, 0, 0],
        13: [0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0.45],
      },
    ],
  },
  // ── Second wave (UR / Mills / Hood) ─────────────────────
  {
    id: "detroit.secondwave",
    genre: "detroit",
    name: "Second Wave",
    bpm: [130, 140],
    swing: 0.02,
    activePads: [1, 6, 8, 11, 15],
    patterns: [
      {
        // Militant and stripped: hard kick, clap backbeat, tick percussion.
        1: [0.95, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0],
        6: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        8: [0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3],
        11: [0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0],
        15: [0, 0, 0.5, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0.55],
      },
      {
        // The "Punisher" pattern: dense tick chatter over the floor.
        1: [0.95, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0],
        6: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        8: [0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.4],
        15: [0.55, 0, 0.5, 0.55, 0, 0.5, 0.55, 0, 0.5, 0.55, 0, 0.5, 0.55, 0, 0.5, 0.6],
      },
    ],
  },
  // ── Techno bass (Detroit electro-bass) ──────────────────
  {
    id: "detroit.technobass",
    genre: "detroit",
    name: "Techno Bass",
    bpm: [120, 135],
    swing: 0.03,
    activePads: [0, 1, 6, 12, 15],
    patterns: [
      {
        // 808 bass pressure: the doubled kick IS the low end.
        0: [0.9, 0, 0, 0, 0, 0, 0.7, 0, 0.9, 0, 0, 0, 0, 0, 0.65, 0],
        1: [0.7, 0, 0, 0.5, 0, 0, 0, 0, 0.7, 0, 0, 0.5, 0, 0, 0, 0],
        6: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0.85, 0, 0, 0],
        12: [0, 0, 0.6, 0, 0, 0, 0, 0.5, 0, 0, 0.6, 0, 0, 0, 0, 0.5],
        15: [0, 0, 0, 0.45, 0, 0, 0, 0.45, 0, 0, 0, 0.45, 0, 0, 0, 0.5],
      },
    ],
  },
  // ── Electro (the classic line) ──────────────────────────
  {
    id: "detroit.electro",
    genre: "detroit",
    name: "Electro",
    bpm: [118, 132],
    swing: 0.06,
    activePads: [0, 3, 4, 8, 12, 13],
    patterns: [
      {
        // The syncopated 808 with snare answers and vocoder space.
        0: [0.9, 0, 0, 0.6, 0, 0, 0.75, 0, 0.9, 0, 0, 0.55, 0, 0, 0, 0.6],
        3: [0, 0.45, 0, 0, 0.5, 0, 0, 0, 0, 0.45, 0, 0, 0.5, 0, 0, 0],
        4: [0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0],
        8: [0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0.4],
        12: [0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0],
        13: [0, 0, 0.55, 0, 0, 0, 0, 0.5, 0, 0, 0.55, 0, 0, 0, 0, 0],
      },
      {
        // The "Clear" pattern: the classic electro break.
        0: [0.9, 0, 0.5, 0, 0, 0, 0.75, 0, 0.9, 0, 0.5, 0, 0, 0, 0.7, 0],
        4: [0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0.45, 0],
        8: [0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0, 0.35, 0.4],
        12: [0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0.55, 0, 0, 0, 0, 0.5],
      },
    ],
  },
  // ── Ghettotech (the Detroit/Chicago fusion) ─────────────
  {
    id: "detroit.ghettotech",
    genre: "detroit",
    name: "Ghettotech",
    bpm: [140, 150],
    swing: 0.05,
    activePads: [0, 1, 4, 8, 10, 14],
    patterns: [
      {
        // Fast and raw: kick churn + snare crack + tick cut-ups.
        0: [0.95, 0, 0.6, 0, 0.9, 0, 0.6, 0, 0.95, 0, 0.6, 0, 0.9, 0, 0.6, 0],
        1: [0.6, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        8: [0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.35],
        10: [0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.55],
        14: [0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0, 0, 0.5, 0],
      },
    ],
  },
  // ── Minimal (the reductionist line) ─────────────────────
  {
    id: "detroit.minimal",
    genre: "detroit",
    name: "Minimal",
    bpm: [125, 134],
    swing: 0.02,
    activePads: [1, 6, 8, 15],
    patterns: [
      {
        // One hypnotic element at a time — the whole point is subtraction.
        1: [0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0],
        6: [0, 0, 0, 0, 0.75, 0, 0, 0, 0, 0, 0, 0, 0.75, 0, 0, 0],
        8: [0.3, 0.2, 0.3, 0.2, 0.3, 0.2, 0.3, 0.2, 0.3, 0.2, 0.3, 0.2, 0.3, 0.2, 0.3, 0.2],
        15: [0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0, 0.45],
      },
      {
        1: [0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0],
        6: [0, 0, 0, 0, 0.75, 0, 0, 0, 0, 0, 0, 0, 0.75, 0, 0, 0],
        8: [0.3, 0.2, 0.3, 0.2, 0.3, 0.2, 0.3, 0.2, 0.3, 0.2, 0.3, 0.2, 0.3, 0.2, 0.3, 0.25],
        15: [0.45, 0, 0, 0, 0.45, 0, 0, 0, 0.45, 0, 0, 0, 0.45, 0, 0, 0],
      },
    ],
  },
];
