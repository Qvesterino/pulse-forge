import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

export const TRAP_GROOVES: GrooveData[] = decodeGrooves([
  // ── Classic ──────────────────────────────────────────
  {
    id: "trap.classic",
    genre: "trap",
    name: "Classic",
    bpm: [135, 145],
    swing: 0.1,
    activePads: [0, 1, 5, 8, 10],
    patterns: [
      {
        0: "g0O8Eey",
        1: "g0u",
        5: "g4K",
        8: "g1w3h5w7h9wbhdwfh",
        10: "g6u",
      },
      {
        0: "g0O6y8E",
        1: "g0s",
        5: "g4K",
        8: "g1E3d5E7d9EbddEfd",
        10: "g6weq",
      },
      // Classic with double snare
      {
        0: "g0O8Eeu",
        1: "g0u",
        5: "g4KcH",
        8: "g1q3a5q7a9qbadqfa",
        10: "g6u",
      },
      // Classic with kick variation
      {
        0: "g0O6w8Heq",
        1: "g0s",
        5: "g4K",
        8: "g1y3d5y7d9ybddyfd",
        10: "g6u",
      },
      // Classic sparse
      {
        0: "g0O",
        1: "g0q",
        5: "g4K",
        8: "g3777b7f7",
        10: "g6s",
      },
    ],
  },

  // ── Rolling ──────────────────────────────────────────
  {
    id: "trap.rolling",
    genre: "trap",
    name: "Rolling",
    bpm: [138, 148],
    swing: 0.08,
    activePads: [0, 1, 5, 8, 10, 14],
    patterns: [
      {
        0: "g0O8Heu",
        1: "g0u",
        5: "g4K",
        8: "g1y3d5y7d9ybddyfd",
        10: "g6ues",
        14: "g0d6d8ded",
      },
      {
        0: "g0O8H",
        1: "g0s",
        5: "g4KcH",
        8: "g1E3d5E7d9EbddEfd",
        10: "g6seq",
        14: "g0a3a8aba",
      },
      // Rolling with kick ghost
      {
        0: "g0O6u8Heq",
        1: "g0s",
        5: "g4K",
        8: "g1w3h5w7h9wbhdwfh",
        10: "g6ues",
        14: "g0d6d8ded",
      },
      // Rolling with open hat fills
      {
        0: "g0O8Heu",
        1: "g0u",
        5: "g4K",
        8: "g1y3d5y7d9ybddyfd",
        10: "g6uakes",
        14: "g0d6d8ded",
      },
      // Rolling sparse
      {
        0: "g0O8H",
        1: "g0q",
        5: "g4K",
        8: "g3777b7f7",
        10: "g6s",
        14: "g0a8a",
      },
      // Rolling dense
      {
        0: "g0O6w8Hes",
        1: "g0s",
        5: "g4KcH",
        8: "g1E3a5E7a9EbadEfa",
        10: "g6uakes",
        14: "g0d2a6d8daaed",
      },
    ],
  },

  // ── Sparse ───────────────────────────────────────────
  {
    id: "trap.sparse",
    genre: "trap",
    name: "Sparse",
    bpm: [130, 140],
    swing: 0.05,
    activePads: [0, 5, 8, 3, 6],
    patterns: [
      {
        0: "g0O8E",
        5: "g4K",
        8: "g3d7dbdfd",
        3: "g6qek",
      },
      {
        0: "g0O",
        5: "g4K",
        8: "g3a7abafa",
        3: "g2nan",
      },
      // Sparse with clap accent
      {
        0: "g0O8E",
        5: "g4K",
        8: "g3d7dbdfd",
        3: "g6qek",
        6: "gcB",
      },
      // Sparse with kick variation
      {
        0: "g0O6u",
        5: "g4K",
        8: "g3777b7f7",
        3: "g2nan",
      },
      // Sparse ultra minimal
      {
        0: "g0O",
        5: "g4K",
        8: "g3777b7f7",
      },
    ],
  },

  // ── Bouncy ───────────────────────────────────────────
  {
    id: "trap.bouncy",
    genre: "trap",
    name: "Bouncy",
    bpm: [140, 150],
    swing: 0.15,
    activePads: [0, 5, 6, 8, 10, 7],
    patterns: [
      {
        0: "g0O8Hey",
        5: "g4K",
        6: "gcH",
        8: "g1w3h5w7h9wbhdwfh",
        10: "g6ues",
        7: "g0d2d4d6d8dadcded",
      },
      {
        0: "g0O6w8H",
        5: "g4KcH",
        6: "gcE",
        8: "g1E3a5E7a9EbadEfa",
        10: "g6seq",
        7: "g0a2a4a6a8aaacaea",
      },
      // Bouncy with snare fill
      {
        0: "g0O8Hey",
        5: "g4KcHeyfu",
        6: "gcH",
        8: "g1y3d5y7d9ybddyfd",
        10: "g6ues",
        7: "g0d2d4d6d8dadcded",
      },
      // Bouncy with kick ghost
      {
        0: "g0O6u8Hew",
        5: "g4K",
        6: "gcH",
        8: "g1y3d5y7d9ybddyfd",
        10: "g6ues",
        7: "g0d2d4d6d8dadcded",
      },
      // Bouncy sparse
      {
        0: "g0O8H",
        5: "g4K",
        6: "gcH",
        8: "g3777b7f7",
        10: "g6s",
        7: "g0a2a4a6a8aaacaea",
      },
      // Bouncy with double-time hats
      {
        0: "g0O8Hew",
        5: "g4KcH",
        6: "gcE",
        8: "g1E3a5E7a9EbadEfa",
        10: "g6uakes",
        7: "g0d2d4d6d8dadcded",
      },
    ],
  },
  // ── Lux (Don Toliver — sparse, atmospheric, lush) ────
  {
    id: "trap.lux",
    genre: "trap",
    name: "Lux",
    bpm: [118, 128],
    swing: 0.12,
    activePads: [0, 1, 5, 8, 10],
    patterns: [
      {
        0: "g0K8Bfq",
        1: "g0u7ndq",
        5: "g4EcE",
        8: "g1s5s7h9sdsfd",
        10: "g6qeq",
      },
      {
        0: "g0K6uay",
        1: "g0s9n",
        5: "g4EdE",
        8: "g1q3d5q9qbddqfd",
        10: "g6qcq",
      },
    ],
  },

  // ── Hyper (pop-rap / hyper trap — busy, bright, fast) ─
  {
    id: "trap.hyper",
    genre: "trap",
    name: "Hyper",
    bpm: [140, 160],
    swing: 0.05,
    activePads: [0, 1, 5, 8, 10],
    patterns: [
      {
        0: "g0O3q6u8Kbqeu",
        1: "g0u3k8sbk",
        5: "g4KcKen",
        8: "g0q1q2h3q4q5q6h7q8q9qahbqcqdqehfq",
        10: "g2u6uaueufn",
      },
      {
        0: "g0O2q6w8Kbqes",
        1: "g0u4k8uck",
        5: "g4KcKek",
        8: "g0q1h2q3h4q5h6q7h8q9haqbhcqdheqfh",
        10: "g1u5u9udu",
      },
    ],
  },

  // ── Dubstep (headbang halftime) ───────────────────────
  // 140-152: halftime weight — kick on 1, big snare on the 3rd beat,
  // sparse hats leaving room for the wobble bass to BE the rhythm.
  {
    id: "trap.dubstep",
    genre: "trap",
    name: "Dubstep",
    bpm: [140, 152],
    swing: 0.04,
    activePads: [0, 5, 8, 10],
    patterns: [
      {
        0: "g0O",
        5: "g8K",
        8: "g0q2d6d8qaded",
        10: "gcs",
      },
      // The one-tap version (kick + snare only — pure wobble space)
      {
        0: "g0O",
        5: "g8K",
        8: "g0k3a8kba",
      },
      // Sampi-style kick movement into the second half
      {
        0: "g0O6scu",
        5: "g8Kek",
        8: "g0q2d5d8qaddd",
        10: "gcs",
      },
    ],
  },

  // ── Hip-hop sub-genre sweep (user: all hip-hop variations) ────────────
  // Houston chopped-and-screwed: SLOWED lean — 66-78 BPM, heavy swing,
  // whisper velocities. The groove IS the slowness.
  {
    id: "trap.screwed",
    genre: "trap",
    name: "Screwed",
    bpm: [66, 78],
    swing: 0.24,
    activePads: [0, 5, 8, 10],
    patterns: [
      {
        0: "g0Kay",
        5: "g4scs",
        8: "g0h3a8hea",
        10: "gek",
      },
      {
        0: "g0K6qay",
        5: "g4scueh",
        8: "g0d4d8dcd",
      },
    ],
  },
  // Plugg / pluggnb: light bouncy drums under bell melodies — the drums
  // stay simple and springy so the bells can run.
  {
    id: "trap.plugg",
    genre: "trap",
    name: "Plugg",
    bpm: [140, 160],
    swing: 0.08,
    activePads: [0, 5, 8, 10],
    patterns: [
      {
        0: "g0K7uaB",
        5: "g4EcEeh",
        8: "g0k2h4k6h8kahckehfd",
        10: "g6nen",
      },
      {
        0: "g0K5saBdq",
        5: "g4EcE",
        8: "g0k2d3d4k6d8kadbdcked",
      },
    ],
  },
  // Detroit / Michigan loop rap: offbeat bouncy loop-rap — kick walks
  // between the snare, everything rides the sampled loop's bounce.
  {
    id: "trap.detroit",
    genre: "trap",
    name: "Detroit",
    bpm: [135, 148],
    swing: 0.14,
    activePads: [0, 5, 8, 10],
    patterns: [
      {
        0: "g0K6uaEes",
        5: "g4H7hcH",
        8: "g0n2h4n6h8nahcneh",
        10: "geq",
      },
      {
        0: "g0K3q6uaEdq",
        5: "g4HbhcH",
        8: "g0n2h4n6h7d8nahcneh",
      },
    ],
  },
  // Hyphy (Bay Area): bouncy 96-106 — the stubble-dance pocket, busy hats,
  // kick that never sits still but never rushes.
  {
    id: "trap.hyphy",
    genre: "trap",
    name: "Hyphy",
    bpm: [96, 106],
    swing: 0.18,
    activePads: [0, 5, 8, 10],
    patterns: [
      {
        0: "g0L7uaEeq",
        5: "g4HcH",
        8: "g0q2h3d4q6h7d8qahbdcqehfd",
        10: "g6qeq",
      },
      {
        0: "g0L3q6saEdq",
        5: "g4H7hcHek",
        8: "g0q2h4q6h7d8qahcqehfd",
      },
    ],
  },
  // Crunk: the chant-energy corner — heavy four-to-the-floor-ish kick,
  // hard snare, open-hat shout. Simpler than trap, LOUDER than everything.
  {
    id: "trap.crunk",
    genre: "trap",
    name: "Crunk",
    bpm: [98, 108],
    swing: 0.1,
    activePads: [0, 5, 8, 10],
    patterns: [
      {
        0: "g0O3u8Hbu",
        5: "g4KcK",
        8: "g0s2n4s6n8sancsen",
        10: "geu",
      },
      {
        0: "g0O3s6u8Hbseu",
        5: "g4K7kcK",
        8: "g0s2n4s6n8sancsenfk",
      },
    ],
  },
  // Old school / 80s electro hip-hop: the TR-808 era — thin electro snare,
  // straight 8th/16th hats, kick on the downbeats. 98-110.
  {
    id: "trap.oldschool",
    genre: "trap",
    name: "Old School",
    bpm: [98, 110],
    swing: 0.12,
    activePads: [0, 5, 8, 10],
    patterns: [
      {
        0: "g0K8H",
        5: "g4BcB",
        8: "g0q1h3h4q5h7h8q9hbhcqdhfh",
        10: "gen",
      },
      {
        0: "g0K6s8Hdq",
        5: "g4B7hcB",
        8: "g0q1h3h4q5h7h8q9hbhcqdhfh",
      },
    ],
  },
  // ── Pop (melodic pop-trap — half-time backbeat, airy hats, vocal space) ──
  {
    id: "trap.pop",
    genre: "trap",
    name: "Pop",
    bpm: [135, 150],
    swing: 0.08,
    activePads: [0, 4, 6, 8, 10],
    patterns: [
      {
        0: "g0Kaw",
        4: "g8H",
        6: "g8u",
        8: "g2k6kakek",
        10: "ges",
      },
      {
        0: "g0K6u",
        4: "g8H",
        6: "g8s",
        8: "g2n6nanenfd",
        10: "g6qes",
      },
      {
        0: "g0Hcy",
        4: "g8E",
        8: "g2k6kakek",
        10: "geq",
        6: "g8q",
      },
      {
        0: "g0K8Eeq",
        4: "g8Hek",
        6: "g8u",
        8: "g2k6kaken",
        10: "ges",
      },
    ],
  },
  // ── Bounce (New Orleans bounce — the last unsampled southern style) ──
  // 98-104: the "Triggerman" 3-3-2 answer key lives in the melody; the drums
  // carry it with a bouncing kick, hard backbeat snare and a rim
  // call-and-response (pad 3) Galloping hats stay swung, never straight.
  {
    id: "trap.bounce",
    genre: "trap",
    name: "Bounce",
    bpm: [98, 104],
    swing: 0.18,
    activePads: [0, 3, 5, 8, 10],
    patterns: [
      {
        0: "g0L6uaE",
        3: "g3s6sbses",
        5: "g4KcK",
        8: "g0q2k4q6k7d8qakcqekfd",
        10: "g6ses",
      },
      // Call-and-response: the rim answers the snare on the back half.
      {
        0: "g0L3q6uaEdq",
        3: "g6s9scsfs",
        5: "g4K7kcK",
        8: "g0q2k3d4q6k8qakbdcqek",
        10: "g6sesfk",
      },
    ],
  },
  // ── Miami Bass (booty bass — 808-roll pocket) ────────────────────────
  // 115-125: heavy kick with an 808-style roll into the bar end, hard clap
  // backbeat, driving 16th hats. Louder and straighter than bounce.
  {
    id: "trap.miamibass",
    genre: "trap",
    name: "Miami Bass",
    bpm: [115, 125],
    swing: 0.06,
    activePads: [0, 1, 5, 6, 8, 10],
    patterns: [
      {
        0: "g0O4K8OcKeufs",
        1: "geqfn",
        5: "g4KcK",
        6: "g4ycy",
        8: "g0q1h2q3h4q5h6q7h8q9haqbhcqdheqfh",
        10: "g6ses",
      },
      {
        0: "g0O3s4K8ObscKeufq",
        1: "g6qeqfn",
        5: "g4K7kcKek",
        6: "g4ycy",
        8: "g0q1h2q3h4q5h6q7h8q9haqbhcqdheqfk",
      },
    ],
  },
  // ── Snap (ringtone era — minimal finger-snap) ────────────────────────
  // 80-95: nearly empty drums — sparse kick, light snap backbeat, thin hats.
  // The silence IS the beat; density automation must stay away.
  {
    id: "trap.snap",
    genre: "trap",
    name: "Snap",
    bpm: [80, 95],
    swing: 0.1,
    activePads: [0, 5, 8],
    patterns: [
      {
        0: "g0Kay",
        5: "g4scs",
        8: "g0k3d6kakek",
      },
      {
        0: "g0K6s",
        5: "g4scsfh",
        8: "g0k4k7d8kck",
      },
    ],
  },
  // ── Country Tune (UGK blues + trap drums crossover) ──────────────────
  // 75-90: half-time backbeat (snare on 3 only), loping swung kick, lazy
  // hats with room for a blues-guitar sample to carry the top.
  {
    id: "trap.countrytune",
    genre: "trap",
    name: "Country Tune",
    bpm: [75, 90],
    swing: 0.14,
    activePads: [0, 5, 8, 10],
    patterns: [
      {
        0: "g0L6uaB",
        5: "g8H",
        8: "g0n2h4n6h8nahcneh",
        10: "g6qeq",
      },
      {
        0: "g0L3q6uaBdq",
        5: "g8Heh",
        8: "g0n2h4n6h7d8nahcneh",
        10: "g6qeq",
      },
    ],
  },
  // ── Deep dubstep (the 140 Croydon original — halftime snare on beat 3,
  // sub-heavy space, sparse hats. Skream / Benga / Digital Mystikz pocket;
  // NOT the brostep/riddim side of trap.dubstep) ──
  {
    id: "trap.deepdubstep",
    genre: "trap",
    name: "Deep Dubstep",
    bpm: [138, 142],
    swing: 0.04,
    activePads: [0, 4, 8, 10, 3],
    patterns: [
      {
        0: "g0O6uay",
        3: "g3kbk",
        4: "g8K",
        8: "g0n3h4n7h8nbhcnfh",
        10: "gcq",
      },
      {
        0: "g0O7qawfn",
        3: "g3hbhek",
        4: "g8K",
        8: "g0k2h4k6h8kahckeh",
      },
      // Weight variation — the kick doubles the sub drop
      {
        0: "g0O4saydq",
        3: "g3k7hbk",
        4: "g8Kek",
        8: "g0n3h4n7h8nbhcnfh",
      },
    ],
  },
  // ── Corridos tumbados (Wave 4) — Peso Pluma / Natanael Cano lane ──────
  // The Mexican corridos-tumbados movement (Peso Pluma 'Ella Baila Sola' /
  // Natanael Cano). Trap hi-hats and sub-kick, but the snare lands on 3 and
  // 4 (a march backbeat) instead of trap's 2-and-4, and the low tom (pad 12)
  // carries the tamborazo roll. BPM 90-130, swing 0.14.
  {
    id: "trap.corridos",
    genre: "trap",
    name: "Corridos Tumbados",
    bpm: [90, 130],
    swing: 0.14,
    activePads: [0, 4, 8, 12, 14],
    patterns: [
      {
        0: "g0K4K8K",
        4: "g8HcH",
        8: "g0n2h4n6h8nahcneh",
        12: "gen",
        14: "g2a6aaaea",
      },
      {
        0: "g0K6q8KcK",
        4: "g8HcH",
        8: "g0n2h4n6h8nahcneh",
        12: "gen",
        14: "g2a6aaaea",
      },
      {
        // Tamborazo roll fills the bar-end into the turnaround
        0: "g0K4K8K",
        4: "g8HcH",
        8: "g0n2h4n6h8nahcnehfq",
        12: "gckenfs",
        14: "g2a6aaacaea",
      },
      {
        // Verse strip — snare drops to 4 only, kick carries the pocket
        0: "g0K4K8K",
        4: "gcH",
        8: "g0n2h4n6h8nahcneh",
        12: "gen",
        14: "g2a6aaaea",
      },
    ],
  },
  // ── Bedroom pop (Wave 5) — Joji / Rich Brian / NIKI lane ───────────────
  // The 88rising wave (Joji 'Sanctuary' / Rich Brian 'Dat $tick'). Lush
  // bedroom-R&B / indie-pop: the kick is soft and offbeat-anchored (not a
  // four-on-the-floor), the snare is a rim tap (pad 3) rather than a
  // backbeat, and the whole thing breathes at 80-110. Replaces trap.lux,
  // whose 118-128 tempo was well above the lane's actual range.
  // BPM 80-110, swing 0.18.
  {
    id: "trap.bedroom",
    genre: "trap",
    name: "Bedroom Pop",
    bpm: [80, 110],
    swing: 0.18,
    activePads: [0, 3, 8, 9, 11],
    patterns: [
      {
        0: "g0y6q8yen",
        3: "g4scs",
        8: "g0e2c4e6c8eacceec",
        9: "g46c6",
        11: "g0c4c8ccc",
      },
      {
        0: "g0y4q8yen",
        3: "g4scs",
        8: "g0e2c4e6c8eacceec",
        9: "g2666a6e6",
        11: "g0c4c8ccc",
      },
      {
        // Half-time — the kick drops to 1 and 3, everything doubles in length
        0: "g0z8x",
        3: "gcq",
        8: "g4dcd",
        9: "gc6",
        11: "g8b",
      },
      {
        // Outro — ride and rim only, no kick
        0: "g",
        3: "g4qcq",
        8: "g4ccc",
        9: "gc6",
        11: "g0b4b8bcb",
      },
    ],
  },

  // ── Trap soul (Wave 5) — Bryson Tiller / PartyNextDoor lane ────────────
  // Slow R&B-leaning trap (Bryson Tiller 'TrapSoul' / PartyNextDoor). The
  // kick is the distinguishing feature vs trap.sparse: it lands on 1, the
  // 'and' of 2, 3, and the 'and' of 4 — a limping, syncopated pocket rather
  // than a straight four-on-the-floor. Snare (pad 4) on 4 only, rim (pad
  // 3) doubling it for texture, soft 8th hats. BPM 78-95, swing 0.2.
  {
    id: "trap.trapsoul",
    genre: "trap",
    name: "Trap Soul",
    bpm: [78, 95],
    swing: 0.2,
    activePads: [0, 3, 4, 8, 9],
    patterns: [
      {
        0: "g0E6s8Eeu",
        3: "gcn",
        4: "gcE",
        8: "g0h4h8hch",
        9: "g2767a7e7",
      },
      {
        0: "g0E6s8Eeu",
        3: "gcn",
        4: "gcE",
        8: "g2h6haheh",
        9: "g175797e7",
      },
      {
        // Pre-chorus — the kick straightens out for one bar
        0: "g0E4E8EcE",
        3: "gcn",
        4: "gcE",
        8: "g0h4h8hch",
        9: "g2767a7e7",
      },
      {
        // Bridge — rim and hat only, snare and kick drop out
        0: "g",
        3: "gcn",
        4: "g",
        8: "g0d4d8dcd",
        9: "g2767a7e7",
      },
    ],
  },

  // ── Dancehall (Wave 5) — Sean Paul / Popcaan / Vybz Kartel lane ───────
  // Caribbean dancehall (Sean Paul 'Temperature' / Popcaan). The
  // characteristic is the one-drop: the snare lands on 3 (step 8) with the
  // kick on 1 and the 'and' of 2, leaving a sparse 2-3 window that the
  // toasting vocal rides. The ride (pad 11) and the tick (pad 14) are the
  // skank anchors. BPM 88-105, swing 0.12.
  {
    id: "trap.dancehall",
    genre: "trap",
    name: "Dancehall",
    bpm: [88, 105],
    swing: 0.12,
    activePads: [0, 4, 8, 11, 14],
    patterns: [
      {
        0: "g0J6u8H",
        4: "g8H",
        8: "g0q2n4q6n8qancqen",
        11: "g0k4k8kck",
        14: "g6d",
      },
      {
        0: "g0J6u8H",
        4: "g8H",
        8: "g0n2q4n6q8naqcneq",
        11: "g0k4k8kck",
        14: "g6ded",
      },
      {
        // Skank break — ride doubles in 16ths, kick and snare drop out
        0: "g0J",
        4: "g",
        8: "g0n4n8ncn",
        11: "g0k2k4k6k8kakckekfk",
        14: "g2d6daded",
      },
      {
        // Half-time — the one-drop stretches across two beats
        0: "g0K8H",
        4: "g",
        8: "g0n4n8ncn",
        11: "g0k8k",
        14: "g6d",
      },
    ],
  },

  // ── Bass / brostep (the modern US dubstep family) ──────────────────────
  // Skrillex / Excision / Zomboy / Subtronics lane. The distinction from
  // trap.dubstep (the Croydon 140 deep sound) is AGGRESSION and KICK
  // density: the drop-era kick triplets, a big layered snare on 3, and
  // machine-gun 16th hats. 140-150 BPM, swing 0 (the grid is the point).
  {
    id: "trap.bassdubstep",
    genre: "trap",
    name: "Bass Dubstep",
    bpm: [140, 150],
    swing: 0,
    activePads: [0, 4, 5, 8, 10, 11],
    patterns: [
      {
        // Drop - kick triplet into the halftime snare
        0: "g0R3y4R7y8Rbu",
        4: "g8O",
        5: "g8ues",
        8: "g0q1h2q3h4q5h6q7h8qaqbhcqdheqfh",
        10: "g6ueu",
        11: "g0k8k",
      },
      {
        // Build - the 16th hat roll before the next drop
        0: "g0R4R7w8R",
        4: "g8O",
        5: "g8sbq",
        8: "g0q2q4q6q7q8q9qaqbqcqdqeqfq",
        10: "g6ses",
        11: "g3hbh",
      },
      {
        // Half-time verse (kick + snare breathing room)
        0: "g0R6u",
        4: "g8O",
        5: "g8q",
        8: "g0q2h4q6h8qahcqeh",
        10: "g6qeq",
        11: "g0j6d8jed",
      },
      {
        // Breakdown - sub space, the kick alone
        0: "g0R4R8RcR",
        4: "g8K",
        5: "g",
        8: "g0q4q8qcq",
        10: "g",
        11: "g",
      },
    ],
  },
]);
