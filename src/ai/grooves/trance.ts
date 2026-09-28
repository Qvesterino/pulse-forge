import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Trance grooves — promoted from `techno.trance` to a first-class genre with
 * its Wikipedia-documented school tree:
 *
 *   uplifting   — the anthem school (Armin / Above & Beyond / Tiësto): steady
 *                 four-floor, offbeat open-hat bass mask, big breakdown, the
 *                 supersaw lead IS the hook, 136–142.
 *   progressive — the smooth end (Sasha / Digweed / Prydz-era): deeper kick,
 *                 longer phrases, subtler layering, 126–134.
 *   psy         — the Goa lineage (Astrix / Vini Vici): rolling 16th bass,
 *                 driving kick, hypnotic acid-adjacent sequences, 138–148.
 *   tech        — trance × techno (the warehouse crossover): harder kick,
 *                 metallic percussion, less melody, 134–142.
 *   acid        — the 303 school (the shared lane with techno.acid): squelch
 *                 lines over the four-floor, 132–142.
 *   dream       — the Robert Miles "Children" school: soft kick, piano-led
 *                 melodic space, half-energy, 128–136.
 *
 * Pad indices (default kit): 0 kick, 1 kick punch, 2 kick techno, 4 snare,
 * 6 clap, 8 hat closed, 10 hat open, 11 ride, 15 blip.
 */
const TRANCE_KICK = [0.95, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0];

export const TRANCE_GROOVES: GrooveData[] = decodeGrooves([
  // ── Uplifting (the anthem school) ───────────────────────
  {
    id: "trance.uplifting",
    genre: "trance",
    name: "Uplifting",
    bpm: [136, 142],
    swing: 0.03,
    activePads: [2, 6, 8, 10, 11],
    patterns: [
      {
        // Four-floor + the offbeat open-hat "bass mask" that defines the genre.
        2: TRANCE_KICK,
        6: "g4wcw",
        8: "g0q1d2q3d4q5d6q7d8q9daqbdcqddeqfd",
        10: "g1u3u5u7u9ubudufu",
        11: "g0d2d4d6d8dadcded",
      },
      {
        // The build bar: snare-roll energy into the anthem.
        2: TRANCE_KICK,
        4: "g0y4B8EcHfK",
        8: "g0q1h2q3h4s5k6s7k8u9naubncwdqeyfB",
        10: "g1w3w5w7w9ybydBfE",
      },
    ],
  },
  // ── Progressive (the smooth end) ────────────────────────
  {
    id: "trance.progressive",
    genre: "trance",
    name: "Progressive",
    bpm: [126, 134],
    swing: 0.05,
    activePads: [0, 6, 8, 10, 15],
    patterns: [
      {
        // Deeper kick, subdued tops, long-phrase patience.
        0: TRANCE_KICK,
        6: "g4qcq",
        8: "g0k1a2k3a4k5a6k7a8k9aakbackdaekfa",
        10: "g1n3n5n7n9nbndnfn",
        15: "g2d6dadeh",
      },
      {
        // Extra percussion layer for the second half of the phrase.
        0: TRANCE_KICK,
        8: "g0k1a2k3a4k5a6k7a8k9aakbackdaekfa",
        10: "g1q3q5q7q9qbqdqfs",
        11: "g0a2a4a6a8aaacaed",
      },
    ],
  },
  // ── Psy (the Goa lineage) ───────────────────────────────
  {
    id: "trance.psy",
    genre: "trance",
    name: "Psy",
    bpm: [138, 148],
    swing: 0.02,
    activePads: [1, 6, 8, 10, 15],
    patterns: [
      {
        // Driving kick + the rolling 16th bass tick (psy's engine).
        1: TRANCE_KICK,
        6: "g0y4y8ycy",
        8: "g0s1k2s3k4s5k6s7k8s9kasbkcsdkesfn",
        10: "g0d1n2d3n4d5n6d7n8d9nadbncddnehfq",
        15: "g1q3q5q7q9qbqdqfs",
      },
      {
        // The full-roll variant: every 16th present.
        1: TRANCE_KICK,
        8: "g0s1l2t3l4s5l6t7l8s9latblcsdletfq",
        10: "g0h1q2h3q4h5q6h7q8h9qahbqchdqekfs",
        15: "g0q2q4q6q8qaqcqeqfu",
      },
    ],
  },
  // ── Tech (the warehouse crossover) ──────────────────────
  {
    id: "trance.tech",
    genre: "trance",
    name: "Tech",
    bpm: [134, 142],
    swing: 0.03,
    activePads: [2, 4, 8, 11, 15],
    patterns: [
      {
        // Harder kick, metallic percussion, melody pulled back.
        2: TRANCE_KICK,
        4: "g4BcB",
        8: "g0n1d2n3d4n5d6n7d8n9danbdcnddenfd",
        11: "g0h2h4h6h8hahcheh",
        15: "g2k5k9kdk",
      },
      {
        2: TRANCE_KICK,
        4: "g4BcEeq",
        8: "g0n1d2q3d4n5d6q7d8n9daqbdcnddeqfh",
        11: "g0h2k4h6k8hakchekfd",
      },
    ],
  },
  // ── Acid (the 303 school) ───────────────────────────────
  {
    id: "trance.acid",
    genre: "trance",
    name: "Acid",
    bpm: [132, 142],
    swing: 0.03,
    activePads: [0, 2, 6, 10, 15],
    patterns: [
      {
        // Squelch over the four-floor — the shared lane with techno.acid.
        0: TRANCE_KICK,
        2: "g2u5s9udsfq",
        6: "g4ucu",
        10: "g1s3s5s7s9sbsdsfu",
        15: "g0n3q6n8qbndq",
      },
    ],
  },
  // ── Dream (the Robert Miles school) ─────────────────────
  {
    id: "trance.dream",
    genre: "trance",
    name: "Dream",
    bpm: [128, 136],
    swing: 0.06,
    activePads: [0, 6, 8, 10],
    patterns: [
      {
        // Soft kick + piano-led space: half the density, all the melody.
        0: "g0E4E8EcE",
        6: "g4qcq",
        8: "g0h182h384h586h788h98ahb8chd8ehfa",
        10: "g1k3k5k7k9kbkdkfn",
      },
      {
        0: "g0E4E8EcE",
        6: "g4qcqek",
        8: "g0h182h384h586h788h98ahb8chd8ehfa",
        10: "g1n3n5n7n9nbndnfq",
      },
    ],
  },
]);
