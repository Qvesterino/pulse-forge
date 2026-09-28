import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Bass exotics — the mid-2010s bass-music offshoots riding their parent
 * floors: the electro-house lineage (complextro / Melbourne bounce /
 * future funk) on HOUSE, the hip-tempo glitch lineage on DNB.
 *
 *   complextro       — the portamento bass twitch: 4-floor with glitchy
 *                      stutters on the fx pads, 126–132 (Skrillex-era
 *                      electro / Feed Me / Mord Fustang).
 *   melbournebounce  — the offbeat "bounce" bass: kick 1 & 3 with the
 *                      offbeat pogo, 128 flat (Will Sparks / TJR).
 *   futurefunk       — the disco-loop revival: filtered 4-floor, disco
 *                      open hats, clap 2 & 4, 116–122 (Pete Herbert /
 *                      LINDSTRØM-adjacent — the french touch heir).
 *   glitchhop        — the halftime glitch: swaggering 80–100 half-time
 *                      with stutter grain fills (The Glitch Mob /
 *                      Opiuo), rides DNB alongside halftime.
 */
export const BASS_EXOTICS_GROOVES: GrooveData[] = decodeGrooves([
  // ── Complextro ───────────────────────────────────────────
  {
    id: "house.complextro",
    genre: "house",
    name: "Complextro",
    bpm: [126, 132],
    swing: 0,
    activePads: [0, 4, 6, 8, 10, 15],
    patterns: [
      {
        // The twitch floor: 4-floor kick, offbeat open hat, glitchy blip
        // stutters slicing between the beats.
        0: "g0O4O8OcO",
        4: "g4EcE",
        8: "g0q2q4q6q8qaqcqeq",
        10: "g1u3u5u7u9ubudufu",
        15: "g1n3q4n6k9nbqcnek",
      },
      {
        // The bass-twitch drop: kick tightens, the stutters double-time.
        0: "g0P3q4P7q8PbqcPfq",
        4: "g4FcF",
        8: "g0r1n2r3n4r5n6r7n8r9narbncrdnerfn",
        15: "g0p1p3q4p6n7p8p9pbqcpenfp",
        10: "g1v5v9vdv",
      },
    ],
  },
  // ── Melbourne bounce ─────────────────────────────────────
  {
    id: "house.melbournebounce",
    genre: "house",
    name: "Melbourne Bounce",
    bpm: [126, 130],
    swing: 0,
    activePads: [0, 4, 6, 10, 14],
    patterns: [
      {
        // The pogo: kick 1 & 3-and with the characteristic offbeat "bounce"
        // (open hat on EVERY offbeat = the pogo bass figure).
        0: "g0Q4Q6y8QcQey",
        4: "g4DcD",
        10: "g1v3v5v7v9vbvdvfv",
        14: "g2k6kakek",
      },
      {
        // The drop variant: kick every beat, the bounce rides the ands.
        0: "g0Q4Q8QcQ",
        4: "g4EcE",
        6: "g6ses",
        10: "g1w3w5w7w9wbwdwfw",
        14: "g0l3l6l8lblel",
      },
    ],
  },
  // ── Future funk ──────────────────────────────────────────
  {
    id: "house.futurefunk",
    genre: "house",
    name: "Future Funk",
    bpm: [116, 122],
    swing: 0.05,
    activePads: [0, 4, 6, 8, 10, 15],
    patterns: [
      {
        // The disco-loop floor: filtered 4-floor, disco open hats on the
        // offbeats, clap 2 & 4 — the sample rides above.
        0: "g0K4K8KcK",
        4: "g4ycy",
        6: "g4vcv",
        8: "g0n2n4n6n8nancnen",
        10: "g1t3t5t7t9tbtdtft",
        15: "g5ndn",
      },
      {
        // The filter-build variant: hats 16ths, the sweep implied.
        0: "g0K4K8KcK",
        4: "g4zcz",
        8: "g0p1p2p3p4p5p6p7p8p9papbpcpdpepfp",
        10: "g1u3u5u7u9ubudufu",
        6: "g4tct",
      },
    ],
  },
  // ── Glitch hop ───────────────────────────────────────────
  {
    id: "dnb.glitchhop",
    genre: "dnb",
    name: "Glitch Hop",
    bpm: [80, 100],
    swing: 0.04,
    activePads: [0, 1, 4, 8, 10, 15],
    patterns: [
      {
        // The swagger: half-time snare on 3, fat kicks on 1 & the 2-and
        // pickup, glitch grains stuttering the grid.
        0: "g0O5zcq",
        1: "g3s9qen",
        4: "g8J",
        8: "g0n2n4n6n8nancnen",
        15: "g1l2n5k6l7nalbndk",
      },
      {
        // The Opiuo bounce: kick syncopation heavier, hats swing the grid.
        0: "g0N3u6yascp",
        1: "g4r9pfn",
        4: "g8I",
        8: "g0o3o6o8oboeo",
        10: "g2s6sases",
        15: "g0l1l4n5n8l9lcndn",
      },
    ],
  },
]);
