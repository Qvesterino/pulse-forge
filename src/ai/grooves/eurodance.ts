import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Eurodance grooves — the pan-European 90s dance tradition promoted to a
 * first-class genre. The defining quality (Wikipedia): a female vocal chorus
 * over a male rap verse, a four-on-the-floor kick, a SYNTH HOOK that carries
 * the drop, and the offbeat "hoover"/stab answer. The 90s pocket sits at
 * ~130–145; the modern revival runs hotter.
 *
 * Schools (the accepted scene split):
 *   classic    — the 90s Euro-NRG core (Snap! / 2 Unlimited / Corona /
 *                La Bouche / Culture Beat): four-floor, offbeat bass stabs,
 *                bright piano/synth hook, 128–140.
 *   happy      — the happy-hardcore-adjacent end (Vengaboys / Sash! /
 *                Alice Deejay / Cascada): faster, supersaw lead, big
 *                euphoric lift, 138–150.
 *   handsup    — the German hands-up scene (Scooter / DJ Bobo / Brooklyn
 *                Bounce): harder kick, pitched-up vocal chops, 140–155.
 *   trancecore — the euro-trance crossover (ATB / Gigi D'Agostino /
 *                Molella / Prezioso): the melody IS the genre, 135–148.
 *   italo      — the Italo-dance lineage (Eiffel 65 / Prezioso / the
 *                Italian 90s floor): autotune vocal hooks, warm bass,
 *                125–138.
 *   hands      — the modern "hands in the air" festival revival: big
 *                build-drop, hardstyle-leaning kick, 150–160.
 *
 * Pad indices (default kit): 0 kick, 1 kick punch, 2 kick techno, 4 snare,
 * 5 snare tight, 6 clap, 8 hat closed, 10 hat open, 11 ride, 14 tick,
 * 15 blip.
 */
export const EURODANCE_GROOVES: GrooveData[] = decodeGrooves([
  // ── Classic Euro-NRG ────────────────────────────────────
  {
    id: "eurodance.nrg",
    genre: "eurodance",
    name: "Classic",
    bpm: [128, 140],
    swing: 0.02,
    activePads: [0, 4, 8, 10, 6],
    patterns: [
      {
        // The four-floor under the offbeat open hat — the genre's spine.
        0: "g0N4N8NcN",
        4: "g4KcK",
        8: "g0q2q4q6q8qaqcqeq",
        10: "g1s3s5s7s9sbsdsfs",
        6: "gcH",
      },
      {
        // The "Rhythm Is a Dancer" push: clap doubles on the last beat.
        0: "g0N4N8NcN",
        4: "g4KcK",
        8: "g0q2q4q6q8qaqcqeq",
        10: "g1q3q5q7q9qbqdqfs",
        6: "g6HcHey",
      },
      {
        // The breakdown verse: kick and hat only, the hook space opens.
        0: "g0K4K8KcK",
        4: "g8J",
        8: "g0p2p4p6p8papcpep",
        10: "g1r3r5r7r9rbrdrfr",
        6: "gcE",
      },
      {
        // The rap-verse pocket: stripped, tick percussion carries the motion.
        0: "g0L4L8LcL",
        4: "g4HcH",
        8: "g0n2n4n6n8nancnen",
        10: "g1p3p5p7p9pbpdpfp",
        6: "g6E",
      },
    ],
  },
  // ── Happy / euphoric ────────────────────────────────────
  {
    id: "eurodance.happy",
    genre: "eurodance",
    name: "Happy",
    bpm: [138, 150],
    swing: 0.01,
    activePads: [0, 2, 4, 8, 10, 6],
    patterns: [
      {
        // Supersaw lift: hard four-floor + clap backbeat + rolled hat.
        0: "g0P4P8PcP",
        2: "g3q7qbqfq",
        4: "g4LcL",
        8: "g0s1q2s3q4s5q6s7q8s9qasbqcsdqesfq",
        10: "g1t3t5t7t9tbtdtft",
        6: "g8JcJ",
      },
      {
        // The Vengaboys bounce: kick doubles on the "and" of 4.
        0: "g0P4P8PcPeu",
        2: "g3q7qbqfq",
        4: "g4LcL",
        8: "g0s1q2s3q4s5q6s7q8s9qasbqcsdqesfq",
        10: "g1s3s5s7s9sbsdsfs",
        6: "g6HaH",
      },
      {
        // The Cascada pocket: dense hats, the drop is imminent.
        0: "g0P4P8PcP",
        2: "g1q3q5q7q9qbqdqfq",
        4: "g4LcL",
        8: "g0u1s2u3s4u5s6u7s8u9saubscudseufs",
        10: "g1u3u5u7u9ubudufu",
        6: "g8KeE",
      },
    ],
  },
  // ── Hands up (German scene) ─────────────────────────────
  {
    id: "eurodance.handsup",
    genre: "eurodance",
    name: "Hands Up",
    bpm: [140, 155],
    swing: 0,
    activePads: [0, 1, 4, 8, 10, 15],
    patterns: [
      {
        // Hard kick + pitched-vocal chop space + offbeat stab answer.
        0: "g0Q4Q8QcQ",
        1: "g3s7sbsfs",
        4: "g4OcO",
        8: "g0t1r2t3r4t5r6t7r8t9ratbrctdretfr",
        10: "g1u3u5u7u9ubudufu",
        15: "g2q6qaqeq",
      },
      {
        // The Scooter relentless variant: kick on every 8th.
        0: "g0Q3u4Q7u8QbucQfu",
        1: "g3s7sbsfs",
        4: "g4OcO",
        8: "g0u2u4u6u8uaucueu",
        10: "g1t3t5t7t9tbtdtft",
        15: "g0q4q8qcq",
      },
      {
        // The Brooklyn Bounce breakdown: kick out, stab carries alone.
        0: "g0O8O",
        1: "g3q7qbqfq",
        4: "g8L",
        8: "g0s2s4s6s8sascses",
        10: "g1s3s5s7s9sbsdsfs",
        15: "g3n7nbnfn",
      },
    ],
  },
  // ── Trancecore (the ATB / Gigi corner) ──────────────────
  {
    id: "eurodance.trancecore",
    genre: "eurodance",
    name: "Trancecore",
    bpm: [135, 148],
    swing: 0.01,
    activePads: [0, 2, 4, 8, 10, 11],
    patterns: [
      {
        // The melody carries it: steady floor, ride sparkle, open-hat mask.
        0: "g0N4N8NcN",
        2: "g3p7pbpfp",
        4: "g4JcJ",
        8: "g0q2q4q6q8qaqcqeq",
        10: "g1s3s5s7s9sbsdsfs",
        11: "g0d2d4d6d8dadcded",
      },
      {
        // The "L'Amour Toujours" pocket: softer kick, brighter ride.
        0: "g0K4K8KcK",
        2: "g3n7nbnfn",
        4: "g4HcH",
        8: "g0p2p4p6p8papcpep",
        10: "g1q3q5q7q9qbqdqfq",
        11: "g0h2h4h6h8hahcheh",
      },
      {
        // The ATB 9PM lift: clap pushes into the phrase turn.
        0: "g0N4N8NcN",
        2: "g3q7qbqfq",
        4: "g4JcJ",
        8: "g0q2q4q6q8qaqcqeq",
        10: "g1s3s5s7s9sbsdsfs",
        11: "g3d7dbdckekfn",
      },
    ],
  },
  // ── Italo dance ─────────────────────────────────────────
  {
    id: "eurodance.italo",
    genre: "eurodance",
    name: "Italo Dance",
    bpm: [125, 138],
    swing: 0.04,
    activePads: [0, 1, 4, 8, 10, 6],
    patterns: [
      {
        // Warm bass, autotune-hook space, softer floor than the German end.
        0: "g0K4K8KcK",
        1: "g3n7nbnfn",
        4: "g4HcH",
        8: "g0p2p4p6p8papcpep",
        10: "g1q3q5q7q9qbqdqfq",
        6: "gcH",
      },
      {
        // The Eiffel 65 pocket: kick push on the "and" of 2.
        0: "g0K4K6s8KcK",
        1: "g3n7nbnfn",
        4: "g4HcH",
        8: "g0p2p4p6p8papcpep",
        10: "g1q3q5q7q9qbqdqfq",
        6: "g6FcF",
      },
      {
        // The Italian floor breakdown: ride pulse, no backbeat.
        0: "g0J4J8JcJ",
        1: "g3l7lblfl",
        4: "g8F",
        8: "g0n2n4n6n8nancnen",
        10: "g1p3p5p7p9pbpdpfp",
        6: "gcE",
      },
    ],
  },
  // ── Modern hands-in-the-air ─────────────────────────────
  {
    id: "eurodance.hands",
    genre: "eurodance",
    name: "Hands",
    bpm: [150, 160],
    swing: 0,
    activePads: [0, 2, 4, 8, 10, 14],
    patterns: [
      {
        // The festival revival: hardstyle-leaning kick, big build space.
        0: "g0R4R8RcR",
        2: "g3u7ubufu",
        4: "g4OcO",
        8: "g0u1s2u3s4u5s6u7s8u9saubscudseufs",
        10: "g1v3v5v7v9vbvdvfv",
        14: "g2n6nanen",
      },
      {
        // The build: 16th hat roll into the drop.
        0: "g0R4R8RcR",
        2: "g3u7ubufu",
        4: "g4OcO",
        8: "g0u1u2u3u4u5u6u7u8u9uaubucudueufu",
        10: "g1u3u5u7u9ubudufu",
        14: "g0n4n8ncn",
      },
      {
        // The outro pocket: kick and hat only.
        0: "g0O4O8OcO",
        2: "g3s7sbsfs",
        4: "g8L",
        8: "g0s2s4s6s8sascses",
        10: "g1t3t5t7t9tbtdtft",
        14: "g",
      },
    ],
  },
  // ── Eurobeat ─────────────────────────────────────────────
  {
    id: "eurodance.eurobeat",
    genre: "eurodance",
    name: "Eurobeat",
    bpm: [148, 160],
    swing: 0,
    activePads: [0, 1, 4, 8, 10, 15],
    patterns: [
      {
        // The Avex/Initial D engine: hard 4-floor, rumble kick doubling,
        // 16th hats, the synth riff implied on the blip.
        0: "g0Q4Q8QcQ",
        1: "g2u6uaueu",
        4: "g4HcH",
        8: "g0t1t2t3t4t5t6t7t8t9tatbtctdtetft",
        10: "g1u3u5u7u9ubudufu",
        15: "g2q5paqdp",
      },
      {
        // The night-drive variant: kick mutes for the riff bars.
        0: "g0Q4Q7s8QcQfs",
        4: "g4IcI",
        8: "g0u1u2u3u4u5u6u7u8u9uaubucudueufu",
        10: "g1v3v5v7v9vbvdvfv",
        15: "g0q3p6q8pbqep",
      },
    ],
  },
  // ── Oldskool rave ────────────────────────────────────────
  {
    id: "eurodance.rave",
    genre: "eurodance",
    name: "Rave",
    bpm: [130, 142],
    swing: 0,
    activePads: [0, 4, 6, 8, 10, 14],
    patterns: [
      {
        // The 92 breakbeat-rave floor: 4-floor kick under the break
        // snare, hoover-era offbeat hats, the stab implied.
        0: "g0M4M8McM",
        4: "g3s4y9qcyfq",
        6: "g4scs",
        8: "g0q2q4q6q8qaqcqeq",
        10: "g1t3t5t7t9tbtdtft",
        14: "g6nen",
      },
      {
        // The hardcore-era push: kick doubles, the break rolls.
        0: "g0N3q4N8NbqcN",
        4: "g2s4z7pasczfp",
        6: "g4tct",
        8: "g0r1r2r3r4r5r6r7r8r9rarbrcrdrerfr",
        10: "g1u3u5u7u9ubudufu",
      },
    ],
  },
  // ── Breakbeat hardcore ───────────────────────────────────
  {
    id: "eurodance.bhc",
    genre: "eurodance",
    name: "Breakbeat Hardcore",
    bpm: [160, 175],
    swing: 0,
    activePads: [0, 4, 5, 8, 10, 14],
    patterns: [
      {
        // The 93 hardcore break: faster breakbeat over the 4-floor,
        // the snare ghost-rolls driving the rush.
        0: "g0O4O8OcO",
        4: "g2u4D7q9scDfs",
        5: "g1n3k6n9nbken",
        8: "g0r2r4r6r8rarcrer",
        10: "g1u3u5u7u9ubudufu",
        14: "g3n6nbnen",
      },
      {
        // The jungle-precursor: the break takes over, kick thins.
        0: "g0L4y8Lcy",
        4: "g2v4E6p9tcEeq",
        5: "g1p3l5n9pbldn",
        8: "g0q2q3q4q6q8qaqbqcqeq",
        10: "g1v5v9vdv",
      },
    ],
  },
]);
