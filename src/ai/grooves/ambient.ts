import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

export const AMBIENT_GROOVES: GrooveData[] = decodeGrooves([
  // ── Drifting ─────────────────────────────────────────
  {
    id: "ambient.drifting",
    genre: "ambient",
    name: "Drifting",
    bpm: [70, 85],
    swing: 0.2,
    activePads: [7, 9, 14, 15],
    patterns: [
      {
        7: "g0d6a8dea",
        9: "g27a7f4",
        14: "g07a7",
        15: "g34b4",
      },
      {
        7: "g0a8a",
        9: "g36b6",
        14: "g24a4",
        15: "g42c2",
      },
      // Drifting with ride shimmer
      {
        7: "g0a678ae7",
        9: "g26a6f4",
        14: "g0686",
        15: "g32b2",
      },
      // Drifting with hat soft texture
      {
        7: "g076687e6",
        9: "g147294f2",
        14: "g046284e2",
        15: "g21a1",
      },
      // Drifting ultra sparse
      {
        7: "g0787",
        9: "g34b4",
        14: "g0484",
        15: "g41c1",
      },
    ],
  },

  // ── Glitch ───────────────────────────────────────────
  {
    id: "ambient.glitch",
    genre: "ambient",
    name: "Glitch",
    bpm: [80, 95],
    swing: 0.05,
    activePads: [3, 7, 14, 15, 8],
    patterns: [
      {
        3: "g0d3a8dba",
        7: "g176797e7",
        14: "g0a478ac7",
        15: "g2472a4f2",
        8: "g3474b4f4",
      },
      {
        3: "g0a278aa7",
        7: "g2646a6c6",
        14: "g075487d4",
        15: "g32b2",
        8: "g126292e2",
      },
      // Glitch with rim stutters
      {
        3: "g0d2a4a8daaca",
        7: "g2674a6f4",
        14: "g074687c6",
        15: "g22a2",
        8: "g3272b2f2",
      },
      // Glitch with hat clicks
      {
        3: "g0a378ab7",
        7: "g166696e6",
        14: "g074487c4",
        15: "g2271a2f1",
        8: "g047284f2",
      },
      // Glitch sparse
      {
        3: "g0787",
        7: "g24a4",
        14: "g0686",
        15: "g31b1",
        8: "g3171b1f1",
      },
      // Glitch dense micro-rhythms
      {
        3: "g0d2a478daac7",
        7: "g17344797b4c7",
        14: "g08466488c6e4",
        15: "g2271a2f1",
        8: "g114191c1",
      },
    ],
  },

  // ── Organic ──────────────────────────────────────────
  {
    id: "ambient.organic",
    genre: "ambient",
    name: "Organic",
    bpm: [75, 90],
    swing: 0.25,
    activePads: [7, 9, 11, 14, 15],
    patterns: [
      {
        7: "g0d274d678da7cde7",
        9: "g175797d7",
        11: "g0787",
        14: "g26a6",
        15: "g44c4",
      },
      {
        7: "g0a274a678aa7cae7",
        9: "g3676b6f6",
        11: "g0686",
        14: "g24a4",
        15: "g32b2",
      },
      // Organic with ride shimmer
      {
        7: "g0c264c668ca6cce6",
        9: "g165696d6",
        11: "g087688f6",
        14: "g25a5",
        15: "g43c3",
      },
      // Organic with hat soft layer
      {
        7: "g0d274d678da7cde7",
        9: "g185898d8",
        11: "g0787",
        14: "g26a6",
        15: "g44c4",
      },
      // Organic sparse
      {
        7: "g0a4a8aca",
        9: "g3474b4f4",
        11: "g0686",
        14: "g24a4",
        15: "g42c2",
      },
      // Organic dense shuffling
      {
        7: "g0e284e688ea8cee8",
        9: "g1734577497b4d7f4",
        11: "g076687e6",
        14: "g066486e4",
        15: "g2271a2f1",
      },
    ],
  },

  // ── Future Garage (Burial school) ─────────────────────
  // 130-140: heavy shuffle, 2-step kick with the push on the 'and', skittery
  // ghost hats at whisper velocities, reversed-vocal atmosphere space.
  // Restraint IS the groove — the vinyl-ghost feeling comes from the gaps.
  {
    id: "ambient.futuregarage",
    genre: "ambient",
    name: "Future Garage",
    bpm: [130, 140],
    swing: 0.22,
    activePads: [0, 4, 8, 10, 6],
    patterns: [
      {
        0: "g0K7qaB",
        4: "g4scw",
        8: "g0d273a5d778da7baddf7",
        10: "geq",
        6: "g6deh",
      },
      {
        0: "g0K7qdu",
        4: "g4s7dcwfd",
        8: "g0a2d475a7d8aadc7dafd",
        10: "ges",
      },
      // Burial push: the late syncopated kick pair
      {
        0: "g0K7s9u",
        4: "g4ucy",
        8: "g0d273d5a7d8da7bddafd",
        6: "g6ddh",
      },
    ],
  },
  // ── Pop (bedroom ballad — halftime pulse, soft kit, airy hats) ──
  {
    id: "ambient.pop",
    genre: "ambient",
    name: "Pop",
    bpm: [70, 95],
    swing: 0.12,
    activePads: [0, 3, 7, 9, 10],
    patterns: [
      {
        0: "g0u8s",
        3: "g8q",
        7: "g2868a8e8",
        9: "g4aca",
        10: "gen",
      },
      {
        0: "g0u6k8s",
        3: "g8qed",
        7: "g2868a8e8",
        9: "g8a",
        10: "g6ken",
      },
      {
        0: "g0scq",
        3: "g8n",
        7: "g074787c7",
        9: "g2868a8e8",
        10: "gek",
      },
      {
        0: "g0u8s",
        3: "g8q",
        7: "g2868a8e8f7",
        9: "g4aca",
        10: "gen",
      },
    ],
  },
  // ── Sad Chill (the lo-fi/emo beat room, 70-90) ──────────────────────────
  // Swung kick with the late ghost, dusty snare backbeat, soft closed hats
  // and a rim tick — the "sad chill beat to cry to" pocket. Everything is
  // quiet; the melodic layer carries the emotion.
  {
    id: "ambient.sadchill",
    genre: "ambient",
    name: "Sad Chill",
    bpm: [70, 90],
    swing: 0.24,
    activePads: [0, 3, 4, 7, 9, 14],
    patterns: [
      {
        0: "g0B6k8y",
        3: "g9d",
        4: "g5ubs",
        7: "g0837487788b7c8f7",
        9: "g2665a6e5",
        14: "ged",
      },
      {
        0: "g0B5h8y",
        3: "g9ceb",
        4: "g5ubs",
        7: "g0736477687b6c7f6",
        9: "g2564a5e4",
        14: "gec",
      },
      // Emo push - the snare doubles into the turnaround
      {
        0: "g0B6k8ydd",
        3: "g9d",
        4: "g5ubseqfn",
        7: "g0837487788b7c8f7",
        9: "g2665a6e5",
      },
    ],
  },
  // ── Dirty Ambient (the corroded/tape-degraded floor, 60-90) ─────────────
  // Sparse, dragged kick, hissing shaker, unstable rim — the room sounds
  // like it is decaying. Sits between dark ambient and lo-fi industrial;
  // the grit comes from the FX chain (vinyl / tape / bitcrush presets).
  {
    id: "ambient.dirtyambient",
    genre: "ambient",
    name: "Dirty Ambient",
    bpm: [60, 90],
    swing: 0.14,
    activePads: [0, 3, 7, 9, 10, 15],
    patterns: [
      {
        0: "g0u7hdd",
        3: "g4caa",
        7: "g0726476687a6c7e6",
        9: "g3574b5f4",
        10: "g8k",
        15: "g48d7",
      },
      {
        0: "g0u6hcd",
        3: "g4cba",
        7: "g0625466586a5c6e5",
        9: "g3473b4f3",
        10: "g6jel",
        15: "g47d6",
      },
      // Corroded breakdown - percussion almost disappears
      {
        0: "g0sdc",
        3: "g4aa8",
        7: "g0534457485b4c5f4",
        15: "g46d5",
      },
    ],
  },
  // ── City pop (Wave 4) — Anri / Tatsuro / Mariya Takeuchi lane ───────────
  // The 1980s Japanese studio-pop movement (Anri 'Last Summer Whisper' /
  // Tatsuro Yamashita / Mariya Takeuchi 'Plastic Love'). Lush AOR
  // production: the rim-shot backbeat (pad 3) on 2 and 4 is the signature,
  // not a snare. Soft hats, generous ride, gentle kick sitting well back.
  // BPM 100-125, swing 0.12.
  {
    id: "ambient.citypop",
    genre: "ambient",
    name: "City Pop",
    bpm: [100, 125],
    swing: 0.12,
    activePads: [0, 3, 4, 8, 9, 11],
    patterns: [
      {
        0: "g0y8y",
        3: "g4ycy",
        4: "g4dcd",
        8: "g0h2d4h6d8hadched",
        9: "g064686c6",
        11: "g0d4d8dcd",
      },
      {
        0: "g0y4y8y",
        3: "g4ycy",
        4: "gcd",
        8: "g0h2d4h6d8hadched",
        9: "g2666a6e6",
        11: "g0d4d8dcd",
      },
      {
        // Funk-leaning AOR — the kick doubles the 'and' of 2
        0: "g0y4s7k8y",
        3: "g4ycy",
        4: "g4dcd",
        8: "g0h2d4h6d8hadched",
        9: "g064686c6",
        11: "g0d4d8dcd",
      },
      {
        // Bridge — percussion drops to ride + rim only
        0: "g0u",
        3: "g4ucu",
        8: "g4dcd",
        9: "g46c6",
        11: "g0d4d8dcd",
      },
    ],
  },
  // ── Synthwave (Wave 5) — Kavinsky / The Midnight / FM-84 lane ───────────
  // 80s-style analog synth leads with a driving four-on-the-floor. The
  // distinguishing feature vs ambient.organic is tempo: synthwave sits at
  // 95-115 with a real kick and a gated snare (pad 5) on 2 and 4, plus the
  // driving toms (pad 12) that punctuate the sweep. Not ambient at all —
  // it is 4/4 with analog-synth colour. BPM 95-115, swing 0.05.
  {
    id: "ambient.synthwave",
    genre: "ambient",
    name: "Synthwave",
    bpm: [95, 115],
    swing: 0.05,
    activePads: [0, 5, 8, 10, 12],
    patterns: [
      {
        0: "g0J4J8JcJ",
        5: "g4HcH",
        8: "g0q2n4q6n8qancqen",
        10: "geq",
        12: "g0k8k",
      },
      {
        0: "g0J4J8JcJ",
        5: "g4HcH",
        8: "g0q2q4q6q8qaqcqeq",
        10: "gfs",
        12: "g6ken",
      },
      {
        // Outrun — the toms carry a fill instead of the snare
        0: "g0J4J8JcJ",
        5: "g4H",
        8: "g0q2n4q6n8qancqen",
        10: "gfq",
        12: "gckenfq",
      },
      {
        // Breakdown - kick and hat only, snare and toms drop out
        0: "g0H4H8HcH",
        5: "g",
        8: "g0n2k4n6k8nakcnek",
        10: "g",
        12: "g",
      },
    ],
  },

  // ── Trip-hop (the downtempo halftime family) ───────────────────────────
  // Bonobo / DJ Shadow / Tricky / Portishead lane. The signature is the
  // HEAVY halftime snare on beat 3 plus a dusty kick pattern that never
  // settles into a grid - the drums are sampled, so the pocket breathes.
  // Sparse dusty hats, rim tick for the crate-digger texture. BPM 80-100
  // (docs/VOCABULARY-GAP-RESEARCH.md P1a). swing 0.22 - the humanised drag
  // IS the genre.
  {
    id: "ambient.triphop",
    genre: "ambient",
    name: "Trip-Hop",
    bpm: [80, 100],
    swing: 0.22,
    activePads: [0, 4, 5, 8, 14],
    patterns: [
      {
        0: "g0K6u8H",
        4: "g8O",
        5: "g1d6c9ddb",
        8: "g0n2k4n6k8nakcnek",
        14: "g0d6dec",
      },
      {
        // Dusty drag - the kick lands late on the 'and'
        0: "g0K7s8H",
        4: "g8O",
        5: "g1c3b5c7b9cbbdcfb",
        8: "g0l2j4l6j8lajclejfk",
        14: "g4bcb",
      },
      {
        // Breakdown - the half-time stretch, kick and rim only
        0: "g0K8H",
        4: "g8O",
        5: "g",
        8: "g0k6h8keh",
        14: "g0c",
      },
      {
        // Sample-flip - ghost kick conversation
        0: "g0K3q6s8Hcq",
        4: "g8O",
        5: "g1d5b9ddb",
        8: "g0n2k4n6k7h8nakcnek",
        14: "g0b296b8ba9eb",
      },
    ],
  },
  // ── Drone: sustained tones, no rhythm at all. The baseline ambient
  // form — a pad that never resolves and never repeats.
  {
    id: "ambient.drone",
    genre: "ambient",
    name: "Drone",
    bpm: [60, 80],
    swing: 0,
    activePads: [2, 9, 15],
    patterns: [
      {
        0: [0.6, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        8: [0.58, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        15: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.35],
      },
    ],
  },
  // ── Space / kosmische: the Berlin-school counterpart to drone. Tempo
  // present, everything smeared.
  {
    id: "ambient.space",
    genre: "ambient",
    name: "Space (kosmische)",
    bpm: [90, 110],
    swing: 0,
    activePads: [0, 8, 11, 15],
    patterns: [
      {
        0: [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0.42, 0, 0, 0, 0, 0, 0, 0],
        8: [0.48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.38, 0, 0, 0, 0, 0],
        15: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3],
      },
    ],
  },
  // ── New age: harp and bells, no percussion, warm and devotional. A
  // real and still-produced ambient lineage (Kitaro, Deuter).
  {
    id: "ambient.newage",
    genre: "ambient",
    name: "New Age (harp)",
    bpm: [70, 90],
    swing: 0,
    activePads: [9, 11, 14, 15],
    patterns: [
      {
        0: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0],
        8: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.35, 0.4],
      },
    ],
  },
  // ── Noise / harsh ambient: the industrial edge. Harsh, granular,
  // deliberately uncomfortable in the way health-and-safety ambient is.
  {
    id: "ambient.noise",
    genre: "ambient",
    name: "Noise (harsh)",
    bpm: [60, 90],
    swing: 0,
    activePads: [3, 7, 13, 14],
    patterns: [
      {
        0: [0.55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        3: [0, 0, 0, 0.45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        6: [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        9: [0, 0, 0, 0, 0, 0, 0.42, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        13: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0],
      },
    ],
  },
  // ── Environmental: field recordings as the music. Leaves, water, rooms —
  // the city-listening ambient that Brian Eno documented.
  {
    id: "ambient.environmental",
    genre: "ambient",
    name: "Environmental (field)",
    bpm: [70, 95],
    swing: 0,
    activePads: [7, 9, 15],
    patterns: [
      {
        0: [0.4, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0.35, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        8: [0.38, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0.32, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        15: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3],
      },
    ],
  },
]);
