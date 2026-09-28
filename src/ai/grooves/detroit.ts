import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

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
export const DETROIT_GROOVES: GrooveData[] = decodeGrooves([
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
        0: "g0K3s6y8Kbqew",
        3: "g4qcq",
        6: "g4HcH",
        12: "g6qen",
        13: "g2s7qasfn",
        15: "g1n5n9ndn",
      },
      {
        // The "Strings of Life" lift: extra kick push into the clap.
        0: "g0K3u6y8Kaqeu",
        6: "g4HcHeq",
        12: "g2s7qas",
        13: "g4q9qfn",
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
        1: "g0O4O8OcO",
        6: "g4KcK",
        8: "g0n1d2n3d4n5d6n7d8n9danbdcnddenfd",
        11: "g0d2d4d6d8dadcded",
        15: "g2q5q9qdqfs",
      },
      {
        // The "Punisher" pattern: dense tick chatter over the floor.
        1: "g0O4O8OcO",
        6: "g4KcK",
        8: "g0q1h2q3h4q5h6q7h8q9haqbhcqdheqfk",
        15: "g0s2q3s5q6s8q9sbqcseqfu",
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
        0: "g0K6y8Kew",
        1: "g0y3q8ybq",
        6: "g4HcH",
        12: "g2u7qaufq",
        15: "g3n7nbnfq",
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
        0: "g0K3u6B8Kbsfu",
        3: "g1n4q9ncq",
        4: "g4EcE",
        8: "g0h2h4h6h8hahchehfk",
        12: "g5qdq",
        13: "g2s7qas",
      },
      {
        // The "Clear" pattern: the classic electro break.
        0: "g0K2q6B8Kaqey",
        4: "g4EcEen",
        8: "g0h2h4h6h8hahchehfk",
        12: "g2q7qasfq",
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
        0: "g0O2u4K6u8OaucKeu",
        1: "g0u8u",
        4: "g4KcK",
        8: "g0n1d2n3d4n5d6n7d8n9danbdcnddenfh",
        10: "g1q3q5q7q9qbqdqfs",
        14: "g0q3q6q8qbqeq",
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
        1: "g0K4K8KcK",
        6: "g4BcB",
        8: "g0d172d374d576d778d97adb7cdd7edf7",
        15: "g3kbkfn",
      },
      {
        1: "g0K4K8KcK",
        6: "g4BcB",
        8: "g0d172d374d576d778d97adb7cdd7edfa",
        15: "g0n4n8ncn",
      },
    ],
  },
]);
