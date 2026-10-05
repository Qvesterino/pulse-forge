import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Drum & Bass grooves — the 174 BPM two-step break: kick on 1, snare on 3,
 * syncopated second kick, ghost snares. Hats pedal 16ths for drive.
 *
 * Pad indices (default kit): 0 kick, 2 kick alt, 4 snare, 5 snare tight,
 * 8 hat closed, 9 hat soft, 10 hat open.
 */
export const DNB_GROOVES: GrooveData[] = decodeGrooves([
  // ── Two-step (classic) ────────────────────────────────
  {
    id: "dnb.twostep",
    genre: "dnb",
    name: "Two-Step",
    bpm: [172, 178],
    swing: 0.02,
    activePads: [0, 2, 4, 5, 8],
    patterns: [
      {
        0: "g0OaH",
        2: "geq",
        4: "g4OcO",
        5: "g3d7hdd",
        8: "g0n2k4n6k8nakcnek",
      },
      {
        0: "g0O9uaH",
        2: "g4n",
        4: "g4OcOeh",
        8: "g0n2k4n6k8nakcnek",
      },
    ],
  },
  // ── Liquid (lusher, open hats, softer ghosts) ──────────
  {
    id: "dnb.liquid",
    genre: "dnb",
    name: "Liquid",
    bpm: [170, 176],
    swing: 0.06,
    activePads: [0, 4, 5, 8, 10],
    patterns: [
      {
        0: "g0KaE",
        4: "g4HcK",
        5: "g2a7dba",
        8: "g0k4k8kck",
        10: "g2h6haheh",
      },
    ],
  },
  // ── Jump-up (sparser kick, rowdier snare) ─────────────
  {
    id: "dnb.jumpup",
    genre: "dnb",
    name: "Jump-Up",
    bpm: [174, 180],
    swing: 0.0,
    activePads: [0, 2, 4, 8, 9],
    patterns: [
      {
        0: "g0OaKfu",
        2: "g6q",
        4: "g4O7kcO",
        8: "g0q2n4q6n8qancqenfk",
        9: "g1a3a5a7a9abadafd",
      },
    ],
  },
  // ── Roller (Macky Gee / dancefloor rollers) ────────────
  // The rolling feel: extra syncopated kick work between the two-step
  // anchors, busier ghost snares, open-hat offbeats carrying momentum.
  {
    id: "dnb.roller",
    genre: "dnb",
    name: "Roller",
    bpm: [172, 178],
    swing: 0.04,
    activePads: [0, 2, 4, 5, 8, 10],
    patterns: [
      {
        0: "g0O6qaKdk",
        2: "g7neq",
        4: "g4O7h9acOfd",
        5: "g1d3a6daaed",
        8: "g0q2n4q6n7h8qancqenfh",
        10: "g2d6dadedfh",
      },
    ],
  },
  // ── Amen chop (breakbeat heritage) ─────────────────────
  // Busiest ghost-snare surface in the vocab — the chopped-break feel.
  {
    id: "dnb.amen",
    genre: "dnb",
    name: "Amen Chop",
    bpm: [170, 178],
    swing: 0.08,
    activePads: [0, 2, 4, 5, 8],
    patterns: [
      {
        0: "g0O3naK",
        2: "g4q9kfn",
        4: "g2d4O6h9dcOek",
        5: "g1h3a5d7a8daaddfa",
        8: "g0n2k4n6k8nakcnekfk",
      },
    ],
  },
  // ── Dancefloor (Chase & Status / Baddadan festival) ───
  // 172-176: BIG punchy kick, double snare accent, festival vocal-friendly
  // structure — the Baddadan/Selecta sound.
  {
    id: "dnb.dancefloor",
    genre: "dnb",
    name: "Dancefloor",
    bpm: [172, 176],
    swing: 0.0,
    activePads: [0, 2, 4, 5, 8, 10],
    patterns: [
      {
        0: "g0O3q6u8Kcufq",
        2: "g4ncq",
        4: "g4O7ncOfk",
        5: "g1h5d7hbddh",
        8: "g0q2n4q6n8qancqenfk",
        10: "g6dcd",
      },
      {
        0: "g0O3s6s8Obqeu",
        2: "g4kan",
        4: "g4O7qcOen",
        5: "g1d3d6d9dcded",
        8: "g0q2n4q6n7h8qancqenfh",
        10: "g2h6hahehfk",
      },
    ],
  },

  // ── Neuro (rolling bass neurofunk) ────────────────────
  // 172-176: tighter two-step skeleton, intricate ghost-snare work, sparse
  // kick — the bass CARRIES this style.
  {
    id: "dnb.neuro",
    genre: "dnb",
    name: "Neuro",
    bpm: [172, 178],
    swing: 0.0,
    activePads: [0, 4, 5, 8, 9],
    patterns: [
      {
        0: "g0K6qaH",
        4: "g4K7hcKed",
        5: "g1d3a5d7a9abddafd",
        8: "g0n2k4n6k8nakcnek",
        9: "g1a3a5a7a9abadafd",
      },
      {
        0: "g0K3h6qaHdh",
        4: "g4K7dcKeh",
        5: "g1a3d5a8daadd",
        8: "g0n2k4n6k8nakcnek",
        9: "g1d3a5d7a9dbaddfa",
      },
    ],
  },
  // ── Jungle (the 1994 sound-system original — chopped time-stretched breaks
  // with ghost-snare chops, deep reggae sub, ragga pressure. Congo Natty /
  // Shy FX 'Original Nuttah' pocket, 155-170) ──
  {
    id: "dnb.jungle",
    genre: "dnb",
    name: "Jungle",
    bpm: [155, 170],
    swing: 0.06,
    activePads: [0, 3, 4, 5, 8],
    patterns: [
      {
        0: "g0K6saB",
        3: "g2kakfh",
        4: "g4KcH",
        5: "g3d7dbdedfh",
        8: "g0n2k4n6k8nakcnek",
      },
      {
        0: "g0K6q8Heq",
        3: "g2k6hakeh",
        4: "g4HcKfk",
        5: "g3hbded",
        8: "g0n2k4n6k8nakcnekfh",
      },
      // Chop variation — the ghost snares roll into the bar turn
      {
        0: "g0K6saEdn",
        3: "g2kak",
        4: "g4KcK",
        5: "g3d7dbdddedfh",
        8: "g0n2k4n6k8nakcnek",
      },
    ],
  },
  // ── Techstep (the 1997 dark blueprint — metallic two-step, sparse and
  // sci-fi. Ed Rush & Optical / No U-Turn / Metalheadz dark side, 170-176.
  // The SOUND is the bass and the reverb tail; drums stay clipped and dry.) ──
  {
    id: "dnb.techstep",
    genre: "dnb",
    name: "Techstep",
    bpm: [170, 176],
    swing: 0.0,
    activePads: [0, 2, 4, 5, 8, 9],
    patterns: [
      {
        0: "g0O6saK",
        2: "g4n7k",
        4: "g4OcO",
        5: "g1d5d9dddfh",
        8: "g0q2l4q6l8qalcqelfh",
        9: "g1838587898b8d8fa",
      },
      {
        0: "g0O3q6saKdq",
        2: "g2k7k",
        4: "g4OcOfk",
        5: "g1c3c5c7c9cbcdcfe",
        8: "g0q2l4q6l8qalcqelfd",
      },
    ],
  },
  // ── Ragga jungle (dancehall vocal pressure over chopped breaks — the
  // reggae side of the 94 scene. Congo Natty / General Levy / Remarc,
  // 160-170. More space between hits than plain jungle so the vocal sits.) ──
  {
    id: "dnb.ragga",
    genre: "dnb",
    name: "Ragga Jungle",
    bpm: [160, 170],
    swing: 0.08,
    activePads: [0, 3, 4, 5, 8],
    patterns: [
      {
        0: "g0K6qay",
        3: "g2n7nan",
        4: "g4KcH",
        5: "g7dbdfh",
        8: "g0k2h4k6h8kahckeh",
      },
      {
        0: "g0K6q8Edn",
        3: "g3kanek",
        4: "g4HcKfk",
        5: "g3d6dbded",
        8: "g0k2h4k6h8kahckehfd",
      },
    ],
  },
  // ── Sambass (Brazilian liquid — DJ Marky / S.P.Y school, 172-176. Rollers
  // with bossa phrasing: soft ghost snares, shaker-style hat motion, lots of
  // air so the melodic sample leads.) ──
  {
    id: "dnb.sambass",
    genre: "dnb",
    name: "Sambass",
    bpm: [172, 176],
    swing: 0.1,
    activePads: [0, 2, 4, 5, 8, 10],
    patterns: [
      {
        0: "g0K6qaE",
        2: "g4k7kek",
        4: "g4KcK",
        5: "g1d3c5d7c9dbcddfd",
        8: "g0l2d4l6d7a8ladcled",
        10: "g3h7hbhfh",
      },
      {
        0: "g0K3n6qaE",
        2: "g4j9j",
        4: "g4K7dcKeh",
        5: "g1c3a5c7a9cbadc",
        8: "g0l2d4l6d8ladbacled",
        10: "g2d6daded",
      },
    ],
  },
  // ── Halftime (the 85-87 BPM feel at 170 — snare on beat 3 only, huge gaps,
  // bass carries the rhythm. Ivy Lab / Alix Perez / halftime DnB, 168-174.
  // This is the dnb lane that reads "trap" to newcomers.) ──
  {
    id: "dnb.halftime",
    genre: "dnb",
    name: "Halftime",
    bpm: [168, 174],
    swing: 0.04,
    activePads: [0, 2, 4, 8, 9],
    patterns: [
      {
        0: "g0O6uay",
        2: "geq",
        4: "g8O",
        8: "g0k4k8kckeh",
        9: "g7d",
      },
      {
        0: "g0O7saB",
        2: "gcq",
        4: "g8Oeh",
        8: "g0k2d4k6d8kadcked",
      },
    ],
  },
  // ── Crossbreed / darkcore (the dnb-hardcore border — kick-led, distorted,
  // relentless. The Outside Agency / Death Grips' dnb side, 175-185.) ──
  {
    id: "dnb.crossbreed",
    genre: "dnb",
    name: "Crossbreed",
    bpm: [175, 185],
    swing: 0.0,
    activePads: [0, 2, 4, 5, 8],
    patterns: [
      {
        0: "g0R3B6y8Kbyew",
        2: "g3s7sbsfs",
        4: "g4O7qcOfq",
        5: "g1h5h9hdh",
        8: "g0s1d2q3d4s5d6q7d8s9daqbdcsddeqfh",
      },
    ],
  },
  // ── Minimal / autonomic dnb (the stripped late-2000s lane — DBridge /
  // Instra:mental. Almost no hat churn, one ghost snare, the SPACE is the
  // style. 170-174.) ──
  {
    id: "dnb.minimal",
    genre: "dnb",
    name: "Minimal",
    bpm: [170, 174],
    swing: 0.02,
    activePads: [0, 2, 4, 8],
    patterns: [
      {
        0: "g0L6qaB",
        2: "gen",
        4: "g4KcK",
        8: "g0k4k8kck",
      },
      {
        0: "g0L3k8E",
        4: "g4K7dcK",
        8: "g0k2d4k6d8kadcked",
      },
    ],
  },
  // ── Atmospheric: LTJ Bukem / Good Looking. The reaction AGAINST the
  // darkening hardstep trend, so the bass recedes and the space leads.
  {
    id: "dnb.atmospheric",
    genre: "dnb",
    name: "Atmospheric (intelligent)",
    bpm: [165, 175],
    swing: 0.1,
    activePads: [0, 4, 8, 9, 15],
    patterns: [
      {
        0: [0.8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0.65, 0, 0, 0, 0, 0, 0, 0],
        8: [0.78, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4],
        14: [0.5, 0, 0, 0, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 0, 0, 0],
      },
    ],
  },
  // ── Drumfunk: Photek / Paradox. The break IS the track — bass and
  // melody are stripped back so the editing reads.
  {
    id: "dnb.drumfunk",
    genre: "dnb",
    name: "Drumfunk (Photek)",
    bpm: [170, 178],
    swing: 0.04,
    activePads: [0, 3, 4, 5, 8, 10, 12, 13],
    patterns: [
      {
        0: [0.9, 0, 0, 0.55, 0, 0, 0, 0, 0, 0, 0, 0, 0.7, 0, 0, 0],
        2: [0, 0, 0, 0, 0.8, 0.75, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0.85, 0, 0.6, 0, 0, 0, 0, 0],
        8: [0.88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.72, 0, 0, 0],
        10: [0, 0, 0, 0, 0.78, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        14: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0],
      },
    ],
  },
  // ── Darkstep: the heavy branch between techstep and neurofunk.
  // Aggressive breaks, distorted bass, ominous rather than clinical.
  {
    id: "dnb.darkstep",
    genre: "dnb",
    name: "Darkstep",
    bpm: [170, 178],
    swing: 0.05,
    activePads: [0, 2, 4, 5, 8, 9],
    patterns: [
      {
        0: [0.92, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        4: [0, 0, 0, 0, 0.85, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        8: [0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.88, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0.82, 0, 0, 0, 0, 0, 0, 0],
        14: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 0],
      },
    ],
  },
  // ── Forest dnb: the 1990s rootsy end. Deep, dubby, sparse — the sound
  // dnb drifted away from before the mid-2000s rewrite.
  {
    id: "dnb.forest",
    genre: "dnb",
    name: "Forest (rootsy)",
    bpm: [165, 174],
    swing: 0.12,
    activePads: [0, 3, 4, 8, 14],
    patterns: [
      {
        0: [0.85, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        4: [0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0],
        8: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        12: [0, 0, 0, 0, 0, 0, 0, 0, 0.72, 0, 0, 0, 0, 0, 0, 0],
        14: [0.45, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0],
      },
    ],
  },
]);
