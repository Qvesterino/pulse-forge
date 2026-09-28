import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Latin grooves — the Afro-Caribbean + South American dance tradition
 * promoted to a first-class genre. The defining quality across all six
 * schools: the drum pattern carries a CLAVE or a two-bar call-and-response
 * cells, and the percussion (conga / timbales / guiro / bongo) is a
 * first-class voice, not a garnish. Hand drums live on the tom pads
 * (12/13), the clave/rim on pad 3, the guiro/shaker on pad 7.
 *
 * Schools (the accepted scene split):
 *   cumbia    — the Colombian + Mexican sonidera lane: the chk-chk kick with
 *               the guiro scrape answering, 85–105.
 *   merengue  — the Dominican 2-feel: tambora march under the sax hook,
 *               120–160.
 *   bachata   — the Dominican bongo-led romance: the right-hand "derecho"
 *               pattern with the syncopated kick, 120–140.
 *   salsa     — the Cuban/NY son and its descendants: the 3-2 son clave on
 *               the rim over the tumbao, 160–200.
 *   mambo     — the big-band mambo (Pérez Prado / Tito Puente): cowbell
 *               on the offbeat, mambo bell, 170–210.
 *   bossa     — the Brazilian bossa nova (João Gilberto / Jobim): the
 *               two-bar rim pattern, brushed, cool, 120–140.
 *
 * Pad indices (default kit): 0 kick, 1 kick punch, 3 rim/clave, 4 snare,
 * 5 snare tight, 6 clap, 7 shaker/guiro, 8 hat closed, 10 hat open,
 * 11 ride, 12 tom low/conga, 13 tom high/timbale, 14 tick, 15 blip.
 */
export const LATIN_GROOVES: GrooveData[] = decodeGrooves([
  // ── Cumbia ──────────────────────────────────────────────
  {
    id: "latin.cumbia",
    genre: "latin",
    name: "Cumbia",
    bpm: [85, 105],
    swing: 0.1,
    activePads: [0, 3, 7, 12, 13, 8],
    patterns: [
      {
        // The chk-chk kick (1 + and-of-2) with the guiro scrape answering.
        0: "g0K6y8Jcy",
        3: "g2q6qaqeq",
        7: "g0k2k4k6k8kakckek",
        12: "g3n7nbnfn",
        13: "g1n5n9ndn",
        8: "g0l4l8lcl",
      },
      {
        // The sonidera variant: congas take the lead, kick pulls back.
        0: "g0J8Hcw",
        3: "g1p5p9pdp",
        7: "g0j2j4j6j8jajcjej",
        12: "g2q6qaqeq",
        13: "g0q3n4q7n8qbncqfn",
        8: "g1k3k5k7k9kbkdkfk",
      },
      {
        // The accordion-led pocket: sparser drums, the melody owns the bar.
        0: "g0K6u8H",
        3: "g1n5n9ndn",
        7: "g0h2h4h6h8hahcheh",
        12: "g3l7lblfl",
        13: "g2p6papep",
        8: "g0k8k",
      },
    ],
  },
  // ── Merengue ────────────────────────────────────────────
  {
    id: "latin.merengue",
    genre: "latin",
    name: "Merengue",
    bpm: [120, 160],
    swing: 0.04,
    activePads: [0, 1, 3, 4, 12, 13],
    patterns: [
      {
        // The tambora march: kick 1+3, snare answer, the güira on 8ths.
        0: "g0N8L",
        1: "g3u7ubufu",
        3: "g0n2n4n6n8nancnen",
        4: "g4KcK",
        12: "g1q5q9qdq",
        13: "g2s6sases",
      },
      {
        // The pambiche variant: the offbeat push that names the style.
        0: "g0N4u8Lcu",
        1: "g3s7sbsfs",
        3: "g1n3n5n7n9nbndnfn",
        4: "g4KcK",
        12: "g0q4q8qcq",
        13: "g3q7qbqfq",
      },
      {
        // The breakdown: güira alone over the bass.
        0: "g0L8K",
        1: "g",
        3: "g0l2l4l6l8lalclel",
        4: "g8J",
        12: "g1p5p9pdp",
        13: "g2r6rarer",
      },
    ],
  },
  // ── Bachata ─────────────────────────────────────────────
  {
    id: "latin.bachata",
    genre: "latin",
    name: "Bachata",
    bpm: [120, 140],
    swing: 0.08,
    activePads: [0, 3, 4, 7, 12, 13],
    patterns: [
      {
        // The derecho: bongo-led with the syncopated kick the footwork marks.
        0: "g0K8H",
        3: "g1q5q9qdq",
        4: "g3s7sbsfs",
        7: "g0l2l4l6l8lalclel",
        12: "g2q6qaqeq",
        13: "g0q4q8qcq",
      },
      {
        // The majao: the busy right hand, kick on all four.
        0: "g0L4K8LcK",
        3: "g1q3q5q7q9qbqdqfq",
        4: "g4scs",
        7: "g0n2n4n6n8nancnen",
        12: "g0p4p8pcp",
        13: "g2r6rarer",
      },
      {
        // The romantic breakdown: bongo and guitar only.
        0: "g0J8F",
        3: "g1n5n9ndn",
        4: "g8q",
        7: "g0j2j4j6j8jajcjej",
        12: "g2n6nanen",
        13: "g0n8n",
      },
    ],
  },
  // ── Salsa ───────────────────────────────────────────────
  {
    id: "latin.salsa",
    genre: "latin",
    name: "Salsa",
    bpm: [160, 200],
    swing: 0.05,
    activePads: [0, 1, 3, 5, 12, 13],
    patterns: [
      {
        // The 3-2 son clave on the rim over the tumbao.
        0: "g0L6y8K",
        1: "g3s7sbsfs",
        3: "g0s3q6q9qbqcq",
        5: "g4HcH",
        12: "g1q5q9qdq",
        13: "g2s6sases",
      },
      {
        // The 2-3 clave answer (the two-bar cell flipped).
        0: "g0L6y8K",
        1: "g3s7sbsfs",
        3: "g2q6q8sdqeq",
        5: "g4HcH",
        12: "g1q5q9qdq",
        13: "g2s6sases",
      },
      {
        // The montuno section: cowbell-adjacent ride, everything cooking.
        0: "g0N4u8Lcu",
        1: "g3s7sbsfs",
        3: "g0s3q6q8sbqeq",
        5: "g4JcJ",
        12: "g0q4q8qcq",
        13: "g2s6sases",
      },
    ],
  },
  // ── Mambo ───────────────────────────────────────────────
  {
    id: "latin.mambo",
    genre: "latin",
    name: "Mambo",
    bpm: [170, 210],
    swing: 0.03,
    activePads: [0, 1, 3, 5, 8, 12],
    patterns: [
      {
        // The big-band mambo: cowbell on the offbeat, the bell pattern.
        0: "g0N4u8Lcu",
        1: "g3u7ubufu",
        3: "g0u2s3q4u6s7q8uasbqcuesfq",
        5: "g4HcH",
        8: "g1s3s5s7s9sbsdsfs",
        12: "g2q6qaqeq",
      },
      {
        // The Pérez Prado stomp: heavy accents on 1 and 3.
        0: "g0P6w8Neu",
        1: "g3u7ubufu",
        3: "g0u2s3q4u6s7q8uasbqcuesfq",
        5: "g4JcJ",
        8: "g0s2s4s6s8sascses",
        12: "g0q4q8qcq",
      },
      {
        // The descarga jam: timbales solo over the vamp.
        0: "g0L6u8K",
        1: "g3s7sbsfs",
        3: "g0q3q6q8qbqeq",
        5: "g4FcF",
        8: "g0q2q4q6q8qaqcqeq",
        12: "g2q4s5q6saqcsdqes",
      },
    ],
  },
  // ── Bossa nova ──────────────────────────────────────────
  {
    id: "latin.bossa",
    genre: "latin",
    name: "Bossa Nova",
    bpm: [120, 140],
    swing: 0.06,
    activePads: [0, 3, 7, 12, 9, 11],
    patterns: [
      {
        // The two-bar rim pattern (João Gilberto's right hand) — brushed.
        0: "g0F6s8Eeq",
        3: "g1n3k6k8nakdkfk",
        7: "g0d2e4d6e8daecdee",
        12: "g2j6jajej",
        9: "g5cdc",
        11: "g0a4a8aca",
      },
      {
        // The second bar of the two-bar cell — the answer phrase.
        0: "g0E6q8Dcq",
        3: "g0l2k5k7l9kckel",
        7: "g0c2d4c6d8cadcced",
        12: "g1i5i9idi",
        9: "g3b7bbbfb",
        11: "g2969a9e9",
      },
      {
        // The cool-jazz bossa: ride-led, sparsest of the six.
        0: "g0D8C",
        3: "g1k5k9kdk",
        7: "g0b2c4b6c8baccbec",
        12: "g3g7gbgfg",
        9: "g2969a9e9",
        11: "g0c2c4c6c8cacccec",
      },
    ],
  },
]);
