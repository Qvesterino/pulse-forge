import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

export const TECHNO_GROOVES: GrooveData[] = decodeGrooves([
  // ── Driving ──────────────────────────────────────────
  {
    id: "techno.driving",
    genre: "techno",
    name: "Driving",
    bpm: [130, 138],
    swing: 0.05,
    activePads: [2, 6, 8, 10, 11],
    patterns: [
      {
        2: "g0O4O8OcO",
        6: "g4HcH",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6ueu",
        11: "g0k2k4k6k8kakckek",
      },
      {
        2: "g0O4O8OcO",
        6: "g4HcH",
        8: "g1s3s5s7s9sbsdsfs",
        10: "g6yeyfq",
        11: "g2h6haheh",
      },
      // Driving with heavy ride
      {
        2: "g0O4O8OcO",
        6: "g4HcH",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6wew",
        11: "g0n6n8nen",
      },
      // Driving with offbeat ride
      {
        2: "g0O4O8OcO",
        6: "g4HcH",
        8: "g1s3s5s7s9sbsdsfs",
        10: "g6yey",
        11: "g2kak",
      },
      // Driving sparse — minimal elements
      {
        2: "g0O4O8OcO",
        6: "g4HcH",
        8: "g3q7qbqfq",
        10: "g6ueu",
        11: "g0h8h",
      },
    ],
  },

  // ── Minimal ──────────────────────────────────────────
  {
    id: "techno.minimal",
    genre: "techno",
    name: "Minimal",
    bpm: [126, 132],
    swing: 0.05,
    activePads: [2, 6, 8, 14, 11],
    patterns: [
      {
        2: "g0K4K8KcK",
        6: "g4E",
        8: "g3q7qbqfq",
        14: "g0d6dcd",
      },
      {
        2: "g0K8K",
        6: "g4EcE",
        8: "g3n7nbnfn",
        14: "g0a6a8aea",
      },
      // Minimal with ride
      {
        2: "g0K4K8KcK",
        6: "g4E",
        8: "g3q7qbqfq",
        14: "g0d6dcd",
        11: "g0a8a",
      },
      // Minimal ultra sparse
      {
        2: "g0K",
        6: "g4E",
        8: "g3k7kbkfk",
        14: "g0787",
      },
      // Minimal with ride offbeats
      {
        2: "g0K4K8KcK",
        6: "g4EcE",
        8: "g3q7qbqfq",
        14: "g0a6aca",
        11: "g2dad",
      },
    ],
  },

  // ── Industrial ───────────────────────────────────────
  {
    id: "techno.industrial",
    genre: "techno",
    name: "Industrial",
    bpm: [132, 140],
    swing: 0.03,
    activePads: [2, 4, 6, 8, 10, 12, 13, 11],
    patterns: [
      {
        2: "g0O4O8OcO",
        4: "g4HcH",
        6: "gcE",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6wew",
        12: "gak",
        13: "gbh",
      },
      {
        2: "g0O4O8OcO",
        4: "g4HcH",
        6: "gcE",
        8: "g1n3n5n7n9nbndnfn",
        10: "g6y7qeyfq",
        12: "g2hah",
        13: "g5ddd",
      },
      // Industrial with ride
      {
        2: "g0O4O8OcO",
        4: "g4HcH",
        6: "gcE",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6wew",
        12: "gah",
        13: "gbd",
        11: "g0d8d",
      },
      // Industrial with rim accents
      {
        2: "g0O4O8OcO",
        4: "g4HcH",
        6: "gcE",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6wew",
        12: "g2hah",
        13: "g4dcd",
        11: "g0a8a",
      },
      // Industrial heavy toms
      {
        2: "g0O4O8OcO",
        4: "g4HcH",
        6: "gcE",
        8: "g1n3n5n7n9nbndnfn",
        10: "g6yey",
        12: "g6kek",
        13: "g7hfh",
      },
      // Industrial with ride and rim
      {
        2: "g0O4O8OcO",
        4: "g4HcH",
        6: "gcE",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6wew",
        12: "g2dad",
        11: "g0d6dad",
      },
    ],
  },

  // ── Dub ──────────────────────────────────────────────
  {
    id: "techno.dub",
    genre: "techno",
    name: "Dub",
    bpm: [124, 130],
    swing: 0.1,
    activePads: [2, 6, 8, 10, 11, 7, 12],
    patterns: [
      {
        2: "g0H4H8HcH",
        6: "g4BcB",
        8: "g3n7nbnfn",
        10: "g6ses",
        11: "g0h6hah",
        7: "g0a2a4a6a8aaacaea",
      },
      {
        2: "g0H4H8HcH",
        6: "g4BcB",
        8: "g3k7kbkfk",
        10: "g6ubdeu",
        11: "g0d8d",
        7: "g0727476787a7c7e7",
      },
      // Dub with tom fill
      {
        2: "g0H4H8HcH",
        6: "g4BcB",
        8: "g3n7nbnfn",
        10: "g6ses",
        11: "g0h6hah",
        7: "g0a2a4a6a8aaacaea",
        12: "gad",
      },
      // Dub sparse ride
      {
        2: "g0H4H8HcH",
        6: "g4BcB",
        8: "g3k7kbkfk",
        10: "g6qeq",
        11: "g0dad",
        7: "g0727476787a7c7e7",
      },
      // Dub echo with ride
      {
        2: "g0H4H8HcH",
        6: "g4BcB",
        8: "g3k7kbkfk",
        10: "g6sbdes",
        11: "g0d6ded",
        7: "g0727476787a7c7e7",
        12: "gaa",
      },
    ],
  },

  // ── Acid ─────────────────────────────────────────────
  {
    id: "techno.acid",
    genre: "techno",
    name: "Acid",
    bpm: [130, 138],
    swing: 0.08,
    activePads: [2, 6, 8, 10, 3, 14, 11],
    patterns: [
      {
        2: "g0O4O8OcO",
        6: "g4HcH",
        8: "g1s3s5s7s9sbsdsfs",
        10: "g6yey",
        3: "g2kakfd",
        14: "g0d6dcd",
      },
      {
        2: "g0O4O8OcO",
        6: "g4HcH",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6wew",
        3: "g2h7dah",
        14: "g0a6a8aea",
      },
      // Acid with ride
      {
        2: "g0O4O8OcO",
        6: "g4HcH",
        8: "g1s3s5s7s9sbsdsfs",
        10: "g6yey",
        3: "g2kakfd",
        14: "g0d6dcd",
        11: "g0d8d",
      },
      // Acid squelchy with shifted rim
      {
        2: "g0O4O8OcO",
        6: "g4HcH",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6wew",
        3: "g2h7aah",
        14: "g0a6a8aea",
        11: "g2dad",
      },
      // Acid with rim and ride
      {
        2: "g0O4O8OcO",
        6: "g4HcH",
        8: "g1s3s5s7s9sbsdsfs",
        10: "g6yey",
        3: "g2k7dak",
        14: "g0d6dcd",
        11: "g0a2d8aad",
      },
    ],
  },
  // ── Hard (Klangkuenstler / fast warehouse) ───────────
  // 145-155: rolling kick work between anchors, hammering, punchy stab.
  {
    id: "techno.hard",
    genre: "techno",
    name: "Hard",
    bpm: [145, 155],
    swing: 0.0,
    activePads: [2, 6, 8, 10, 3, 11],
    patterns: [
      {
        2: "g0O3k4O6h8ObkcOehfd",
        6: "g4EcE",
        8: "g1s3s5s7s9sbsdsfs",
        10: "g6yey",
        3: "g2hah",
        11: "g0k4k8kck",
      },
      {
        2: "g0O2d4O7h8ObhcO",
        6: "g4HcH",
        8: "g1s3s5s7s9sbsdsfs",
        10: "g6yey",
        3: "g2k7daked",
        11: "g2k6kakek",
      },
    ],
  },

  // ── Melodic (Ben Bohmer / Sangiuliano melodic) ───────
  // 122-132: softer kick, moving sixteenth arps, airy hats.
  {
    id: "techno.melodic",
    genre: "techno",
    name: "Melodic",
    bpm: [122, 132],
    swing: 0.06,
    activePads: [2, 6, 8, 10, 11, 14],
    patterns: [
      {
        2: "g0K4K8KcK",
        6: "g4BcB",
        8: "g1n3n5n7n9nbndnfn",
        10: "g6ueu",
        11: "g0d3d8dbd",
        14: "g0a2a6aaaea",
      },
      {
        2: "g0K4K8KcK",
        6: "g4BcB",
        8: "g1n3n5n7n9nbndnfn",
        10: "g6ses",
        11: "g2d7dcd",
        14: "g075797d7",
      },
    ],
  },
  // ── Psytrance (Wave 3) — Astrix / Vini Vici 140 lane ────────────────────
  // Acid-driven four-on-the-floor with rolling percussion and psy-style
  // hi-hat offbeat work. The hard psy side of trance. BPM 138-145.
  // Swing 0.05 (slight groove, but straight-grid feel).
  {
    id: "techno.psytrance",
    genre: "techno",
    name: "Psytrance",
    bpm: [138, 145],
    swing: 0.05,
    activePads: [0, 2, 6, 8, 11, 9],
    patterns: [
      {
        0: "g0K4K8KcK",
        2: "g",
        6: "g2B6BaBeB",
        8: "g1s3s5s7s9sbsdsfs",
        11: "g1h3d5h9dbhed",
        9: "g0a4a8aca",
      },
      {
        0: "g0O4O8OcO",
        2: "g2n6nanen",
        6: "g2y6yayey",
        8: "g0s2s4s6s8sascses",
        11: "g2d3d6d7dadbdedfd",
        9: "g2a6aaaea",
      },
      {
        0: "g0K4K8KcK",
        2: "g1n5n9ndn",
        6: "g2B6BaBeB",
        8: "g1q2q4q6q9qaqcqeq",
        11: "g0h3h6h8hbheh",
        9: "g0d4d8dcd",
      },
      {
        0: "g0K4K8KcK",
        2: "g",
        6: "g1y5y9ydy",
        8: "g1s3s5s7s9sbsdsfs",
        11: "g3d6daddd",
        9: "g1a5a9ada",
      },
    ],
  },
  // ── Hardstyle (Wave 3) — Headhunterz / Sound Rush euphoric ─────────────
  // Reverse-bass kick signature: deep kick on beat 1, layered kick alt
  // (pad 2) acting as the iconic reverse-bass tail, offbeat snare, perc
  // stabs. BPM 150-155, swing 0 (grid-locked).
  {
    id: "techno.hardstyle",
    genre: "techno",
    name: "Hardstyle",
    bpm: [150, 155],
    swing: 0,
    activePads: [0, 2, 4, 11, 8],
    patterns: [
      {
        0: "g0O4O8OcO",
        2: "g3s7sbsfs",
        4: "g4HcH",
        11: "g2d6daded",
        8: "g1n3n5n7n9nbndnfn",
      },
      {
        0: "g0O4O8OcO",
        2: "g1s5s9sds",
        4: "g4HcH",
        11: "g0d4d8dcd",
        8: "g1q3q5q7q9qbqdqfq",
      },
      {
        0: "g0O4O8OcO",
        2: "g2s6sases",
        4: "g4HcH",
        11: "g4d6dbdcd",
        8: "g0n2n4n6n8nancnen",
      },
      {
        0: "g0O4O8OcO",
        2: "g4scs",
        4: "g4HcH",
        11: "g1d3d6d9dbded",
        8: "g1n3n5n7n9nbndnfn",
      },
    ],
  },
  // ── Trance (uplifting — the offbeat open hat IS the genre, light clap on
  // 2+4, driving 16th hats, ride sparkle. 136-142 peak) ──
  {
    id: "techno.trance",
    genre: "techno",
    name: "Trance",
    bpm: [136, 142],
    swing: 0.03,
    activePads: [2, 6, 8, 10, 11],
    patterns: [
      {
        2: "g0O4O8OcO",
        6: "g4wcw",
        8: "g0q1d2q3d4q5d6q7d8q9daqbdcqddeqfd",
        10: "g1u3u5u7u9ubudufu",
        11: "g0d2d4d6d8dadcded",
      },
      {
        2: "g0O4O8OcO",
        6: "g4ucuek",
        8: "g0n1d2n3d4n5d6n7d8n9danbdcnddenfh",
        10: "g1u3u5u7u9ubudufs",
      },
      // Supersaw drive — the 16ths open up, offbeat doubles at the bar turn
      {
        2: "g0O4O8OcOeq",
        6: "g4wcw",
        8: "g0q1h2q3h4q5h6q7h8q9haqbhcqdheqfk",
        10: "g1u3u5u7u9ubudufu",
        11: "g2d6d8dbdcd",
      },
    ],
  },
  // ── Electro (classic Detroit electro — machine funk: syncopated 808 kick,
  // tight snare, tom accents. Model 500 / Drexciya / Egyptian Lover pocket;
  // NOT "electro house") ──
  {
    id: "techno.electro",
    genre: "techno",
    name: "Electro",
    bpm: [126, 134],
    swing: 0.08,
    activePads: [0, 5, 8, 12, 13],
    patterns: [
      {
        0: "g0K6y8Heu",
        5: "g4HcH",
        8: "g0q2n3d4q6n8qanbdcqen",
        13: "g8nek",
      },
      {
        0: "g0K3s6y8Hcsfq",
        5: "g4H7kcH",
        8: "g0q2n4q5h6n8qancqdhen",
        12: "g8ken",
      },
      // Machine-funk variation — tom talk between the kicks
      {
        0: "g0K6w7qaEeu",
        5: "g4HcKek",
        8: "g0q2n3d4q6n8q9dancqenfd",
        12: "g2kakfk",
        13: "g7kek",
      },
    ],
  },
  // ── EBM / industrial techno (Wave 4) — Surgeon / Vatican Shadow lane ───
  // The EBM / industrial scene (Surgeon 'Lum' / Vatican Shadow / Ancient
  // Methods). Techno kick on the four, hard snare on 2 and 4, relentless
  // 8th closed hat, and a tick (pad 14) for the machine-gun feel. Nearly
  // zero swing — the drive is mechanical, not humanised. BPM 130-140.
  {
    id: "techno.ebm",
    genre: "techno",
    name: "EBM",
    bpm: [130, 140],
    swing: 0.02,
    activePads: [2, 4, 8, 10, 14],
    patterns: [
      {
        2: "g0K4K8KcK",
        4: "g4KcK",
        8: "g0s2s4s6s8sascsesfs",
        10: "geq",
        14: "g0d6ded",
      },
      {
        // 16th hat roll on the second half
        2: "g0K4K8KcK",
        4: "g4KcK",
        8: "g0s2s4s6s8q9qaqbqcqdqeqfq",
        10: "geq",
        14: "g0d6ded",
      },
      {
        // Kick doubles every 3rd 8th — the lurching industrial stomp
        2: "g0K6u8Keu",
        4: "g4KcK",
        8: "g0s2s4s6s8sascsesfs",
        10: "geq",
        14: "g0d6ded",
      },
      {
        // Peak — open hat every 8th over the full bar
        2: "g0K4K8KcK",
        4: "g4KcK",
        8: "g0s2s4s6s8sascsesfs",
        10: "g1q5q9qeq",
        14: "g2d6daded",
      },
    ],
  },

  // ── Gabber (the hardcore / uptempo family) ──────────────────────────────
  // Angerfist / Miss K8 / Sefa lane. The distorted four-on-the-floor kick IS
  // the genre: every beat is a full kick, the snare answers on 2 and 4 with
  // a hard backbeat, and the offbeat hat keeps the drive. BPM 160-180 (the
  // researched core; docs/VOCABULARY-GAP-RESEARCH.md P1a). swing 0 - the
  // grid is the point, humanising would blur the stomp.
  {
    id: "techno.gabber",
    genre: "techno",
    name: "Gabber",
    bpm: [160, 180],
    swing: 0,
    activePads: [0, 4, 5, 8, 10],
    patterns: [
      {
        0: "g0R4R8RcR",
        4: "g4LcL",
        5: "g1h5d9hdd",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6ueu",
      },
      {
        // Rolling kick - 8th kick doubles under the stomp
        0: "g0R3s4R7s8RbscRfs",
        4: "g4LcL",
        5: "g1k5h9kdh",
        8: "g0q2q4q6q8qaqcqeq",
        10: "g6wew",
      },
      {
        // Offbeat push - the uptempo "stamp" variation
        0: "g0R4R7u8RcR",
        4: "g4LcL",
        5: "g1d3d5d7d9dbdddfd",
        8: "g0q2q4q6q8qaqcqeq",
        10: "g6ses",
      },
      {
        // Breakdown stomp - hats out, the kick carries alone
        0: "g0R4R8RcR",
        4: "g4OcO",
        5: "g",
        8: "g1n3n5n7n9nbndnfn",
        10: "g",
      },
    ],
  },
  // ── Detroit: the original. Funk-meets-machine-futurism, mechanical
  // soul, syncopation (Belleville Three: Atkins, May, Saunderson).
  {
    id: "techno.detroit",
    genre: "techno",
    name: "Detroit",
    bpm: [128, 140],
    swing: 0.1,
    activePads: [0, 2, 4, 8, 10],
    patterns: [
      {
        0: [0.92, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        4: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        8: [0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.88, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        14: [0.75, 0, 0, 0, 0.6, 0, 0, 0, 0.75, 0, 0, 0, 0, 0, 0, 0],
      },
    ],
  },
  // ── Bleep: the British foundation (Yorkshire / Warp, LFO). Sparse synth
  // bleeps over reggae-scale sub. Cold and spare.
  {
    id: "techno.bleep",
    genre: "techno",
    name: "Bleep",
    bpm: [120, 132],
    swing: 0.08,
    activePads: [0, 2, 8, 14, 15],
    patterns: [
      {
        0: [0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0, 0, 0, 0, 0],
        8: [0.88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4],
        14: [0.5, 0, 0, 0, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 0, 0, 0],
      },
    ],
  },
  // ── Tribal: the Polaris rhythm — a rolling conga pattern layered over
  // four-on-the-floor. Drum-heavy, global percussion influence.
  {
    id: "techno.tribal",
    genre: "techno",
    name: "Tribal (Polaris)",
    bpm: [130, 138],
    swing: 0.06,
    activePads: [0, 12, 13, 8, 10],
    patterns: [
      {
        0: [0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.75, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0],
        8: [0.88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.75, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.78, 0, 0, 0],
        14: [0.7, 0, 0, 0.6, 0, 0, 0.7, 0, 0.7, 0, 0, 0, 0, 0, 0, 0],
      },
    ],
  },
  // ── Berlin: the Tresor / Berghain vault sound. Dark, relentless 909,
  // stripped of melody.
  {
    id: "techno.berlin",
    genre: "techno",
    name: "Berlin (vault)",
    bpm: [130, 138],
    swing: 0.04,
    activePads: [2, 3, 8, 9, 10],
    patterns: [
      {
        0: [0.92, 0, 0.92, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.92, 0, 0, 0],
        4: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        8: [0.9, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        12: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        14: [0.72, 0, 0.6, 0, 0.72, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
    ],
  },
  // ── Hypnotic: long loops, subtle evolution, near-static. The sound the
  // name promises — the point is that nothing much happens.
  {
    id: "techno.hypnotic",
    genre: "techno",
    name: "Hypnotic (long loop)",
    bpm: [130, 142],
    swing: 0.04,
    activePads: [0, 4, 8, 15],
    patterns: [
      {
        0: [0.88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.88, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0],
        8: [0.86, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.86, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.78, 0, 0, 0],
        15: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.35],
      },
    ],
  },
  // ── Schranz: Frankfurt, mid-90s. A hard distorted kick looped with
  // no melody at all. The absence of a hook is the genre.
  {
    id: "techno.schranz",
    genre: "techno",
    name: "Schranz (factory)",
    bpm: [145, 160],
    swing: 0,
    activePads: [0, 4, 8, 11],
    patterns: [
      {
        0: [0.95, 0, 0, 0, 0, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0],
        4: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        8: [0.95, 0, 0, 0, 0, 0, 0, 0, 0.95, 0, 0, 0, 0.95, 0, 0, 0],
        12: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        14: [0.78, 0, 0, 0, 0, 0, 0, 0, 0.72, 0, 0, 0, 0, 0, 0, 0],
      },
    ],
  },
  // ── Hardgroove: Ben Sims, late 90s. Rolling percussive loops from a
  // single drum machine, tribal without the hand percussion.
  {
    id: "techno.hardgroove",
    genre: "techno",
    name: "Hardgroove (rolling)",
    bpm: [135, 145],
    swing: 0.08,
    activePads: [0, 3, 8, 10, 13],
    patterns: [
      {
        0: [0.9, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0.88, 0, 0, 0],
        4: [0, 0, 0, 0.45, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0],
        8: [0.88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.86, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0.75, 0, 0, 0, 0, 0, 0, 0],
        14: [0.65, 0, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
    ],
  },

]);
