import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

export const HOUSE_GROOVES: GrooveData[] = decodeGrooves([
  // ── Driving ──────────────────────────────────────────
  {
    id: "house.driving",
    genre: "house",
    name: "Driving",
    bpm: [122, 128],
    swing: 0.12,
    activePads: [0, 1, 6, 8, 10, 11],
    patterns: [
      // Pad 1 layered on beat 1 for extra punch
      {
        0: "g0K4K8KcK",
        1: "g0y8y",
        6: "g4HcH",
        8: "g1w3q5w7q9wbqdwfq",
        10: "g6yey",
      },
      {
        0: "g0K4K8KcK",
        1: "g0w8w",
        6: "g4HcH",
        8: "g1q3w5q7w9qbwdqfw",
        10: "g6BeBfq",
      },
      {
        0: "g0K4K8KcK",
        1: "g0y8y",
        6: "g4HcHdu",
        8: "g1y3q5y7q9ybqdyfq",
        10: "g6yey",
      },
      {
        0: "g0K4K8KcK",
        1: "g0w8w",
        6: "g4HcH",
        8: "g1u3n5u7n9ubndufn",
        10: "g6yey",
        11: "g0h8h",
      },
      {
        0: "g0O4K8OcK",
        1: "g0y8y",
        6: "g4HcH",
        8: "g1y3q5y7q9ybqdyfq",
        10: "g6EeE",
      },
      {
        0: "g0K4K8KcK",
        1: "g0u8u",
        6: "g4HcH",
        8: "g3k7kbkfk",
        10: "g6wew",
      },
    ],
  },
  // ── Minimal ──────────────────────────────────────────
  {
    id: "house.minimal",
    genre: "house",
    name: "Minimal",
    bpm: [120, 126],
    swing: 0.08,
    activePads: [0, 6, 8, 7, 9],
    patterns: [
      {
        0: "g0H4H8HcH",
        6: "g4E",
        8: "g3q7qbqfq",
        7: "g1d5d9ddd",
      },
      {
        0: "g0H8H",
        6: "g4EcE",
        8: "g3q7qbqfq",
        7: "g0d2d4d6d8dadcded",
      },
      {
        0: "g0H4H8HcH",
        6: "g4E",
        8: "g3q7qbqfq",
        7: "g1h3a5h7a9hbadhfa",
      },
      {
        0: "g0H4H8HcH",
        6: "g4EcE",
        8: "g3q7qbqfq",
        7: "g1a5a9ada",
        9: "g3777b7f7",
      },
      {
        0: "g0H8H",
        6: "g4E",
        8: "g3n7nbnfn",
        7: "g1737577797b7d7f7",
      },
    ],
  },
  // ── Funky ────────────────────────────────────────────
  {
    id: "house.funky",
    genre: "house",
    name: "Funky",
    bpm: [118, 124],
    swing: 0.25,
    activePads: [0, 4, 6, 8, 10, 7],
    patterns: [
      {
        0: "g0K4K8KcKey",
        4: "g4HcH",
        6: "g4EcE",
        8: "g1s3q5s7q9sbqdsfq",
        10: "g6wew",
        7: "g0d3d6d8dbded",
      },
      {
        0: "g0K4K8KcK",
        4: "g4HaqcH",
        6: "gcE",
        8: "g1u3s5u7s9ubsdufs",
        10: "g6yey",
        7: "g0a2a4a6a8aaacaea",
      },
      {
        0: "g0K4K8KcK",
        4: "g4HcH",
        6: "g4EcE",
        8: "g1q3n5q7n9qbndqfn",
        10: "g6wew",
        7: "g0d2a4d6a8daacdea",
        11: "g0d6dad",
      },
      {
        0: "g0K4K8KcK",
        4: "g4HcH",
        6: "g4EcE",
        8: "g1w3q5w7q9wbqdwfq",
        10: "g6yaqey",
        7: "g0a2a4a6a8aaacaea",
      },
      {
        0: "g0K4K8KcK",
        4: "g4HcH",
        6: "g4EcE",
        8: "g1s3n5s7n9sbndsfn",
        10: "g6wew",
        7: "g0h2h4h6h8hahcheh",
      },
    ],
  },
  // ── Deep ─────────────────────────────────────────────
  {
    id: "house.deep",
    genre: "house",
    name: "Deep",
    bpm: [118, 124],
    swing: 0.15,
    activePads: [0, 6, 8, 10, 7, 9],
    patterns: [
      {
        0: "g0H4H8HcH",
        6: "g4BcB",
        8: "g1q3n5q7n9qbndqfn",
        10: "g6ueu",
        7: "g0h2h4h6h8hahcheh",
        9: "g3d7dbdfd",
      },
      {
        0: "g0H4H8HcH",
        6: "g4BcB",
        8: "g1q3n5q7n9qbndqfn",
        10: "g6wbkew",
        7: "g0d2d4d6d8dadcded",
        9: "g3a7abafa",
      },
      {
        0: "g0H4H8HcH",
        6: "g4BcB",
        8: "g1n3q5n7q9nbqdnfq",
        10: "g6ueu",
        7: "g0k2d3d4k6d7d8kadbdckedfd",
        9: "g3777b7f7",
      },
      {
        0: "g0H4H8HcH",
        6: "g4BcB",
        8: "g1q3n5q7n9qbndqfn",
        10: "g6ueu",
        7: "g0h2h4h6h8hahcheh",
        9: "g3a7abafa",
      },
      {
        0: "g0H4H8HcH",
        6: "g4y",
        8: "g3k7kbkfk",
        10: "g6ses",
        7: "g0d2d4d6d8dadcded",
        9: "g3777b7f7",
      },
    ],
  },
  // ── UK Garage ────────────────────────────────────────
  {
    id: "house.ukg",
    genre: "house",
    name: "UK Garage",
    bpm: [126, 132],
    swing: 0.3,
    activePads: [0, 1, 4, 6, 8, 10, 7, 3],
    patterns: [
      {
        0: "g0K4K8KcK",
        1: "g0w",
        4: "g4HcH",
        6: "gcEeu",
        8: "g1s3q5s7q9sbqdsfq",
        10: "g6yey",
        7: "g0d2d4d6d8dadcded",
      },
      {
        0: "g0K4K6q8KcK",
        1: "g0u",
        4: "g4HcH",
        6: "gcE",
        8: "g1q3s5q7s9qbsdqfs",
        10: "g6wew",
        7: "g0a2a4a6a8aaacaea",
      },
      {
        0: "g0K4K8KcK",
        1: "g0w",
        4: "g4HcH",
        6: "gcEeu",
        8: "g1u3n5u7n9ubndufn",
        10: "g6yey",
        7: "g0d2d4d6d8dadcded",
        11: "g0d6dad",
      },
      {
        0: "g0K4K8KcK",
        1: "g0u",
        4: "g4HcH",
        6: "gcEeu",
        8: "g1s3q5s7q9sbqdsfq",
        10: "g6yey",
        7: "g0d2d4d6d8dadcded",
        3: "g2kak",
      },
      {
        0: "g0K4K6u8KcKeq",
        1: "g0w",
        4: "g4HcH",
        6: "gcE",
        8: "g1q3s5q7s9qbsdqfs",
        10: "g6wew",
        7: "g0a2a4a6a8aaacaea",
      },
    ],
  },
  // ── Afro House ───────────────────────────────────────
  {
    id: "house.afro",
    genre: "house",
    name: "Afro House",
    bpm: [118, 126],
    swing: 0.2,
    activePads: [0, 3, 4, 6, 7, 8, 14, 12],
    patterns: [
      {
        0: "g0H4H8HcH",
        3: "g2uau",
        4: "g4EcE",
        6: "gcB",
        7: "g0k2d4k6d8kadcked",
        8: "g1q3q5q7q9qbqdqfq",
        14: "g0d3d6d8dbded",
      },
      {
        0: "g0H4H8HcH",
        3: "g2q7qaq",
        4: "g4EcE",
        6: "gcB",
        7: "g0h2h4h6h8hahcheh",
        8: "g1n3n5n7n9nbndnfn",
        14: "g2a4aaaca",
      },
      {
        0: "g0H4H8HcH",
        3: "g2qaq",
        4: "g4EcE",
        6: "gcB",
        7: "g0k2d4k6d8kadcked",
        8: "g1q3q5q7q9qbqdqfq",
        14: "g0d3d6d8dbded",
        12: "gah",
      },
      {
        0: "g0H4H8HcH",
        3: "g3q6qbqeq",
        4: "g4EcE",
        6: "gcB",
        7: "g0h2h4h6h8hahcheh",
        8: "g1n3n5n7n9nbndnfn",
        14: "g0a6a8aea",
      },
      {
        0: "g0H4H8HcH",
        3: "g2q7qaq",
        4: "g4EcE",
        6: "gcB",
        7: "g0k2h4k6h8kahckeh",
        8: "g1q3q5q7q9qbqdqfq",
        14: "g0d3d6d8dbded",
      },
    ],
  },
  // ── Dancefloor (Fisher / John Summit festival house) ──
  // 124-128: punchy kick, BIG clap on 2+4, driving open-hat offbeats, extra
  // kick push before the downbeat — built for main-stage systems.
  {
    id: "house.dancefloor",
    genre: "house",
    name: "Dancefloor",
    bpm: [124, 128],
    swing: 0.04,
    activePads: [0, 1, 6, 8, 10],
    patterns: [
      {
        0: "g0O4O8OcOfk",
        1: "g0B8B",
        6: "g4OcOfk",
        8: "g1y3s5y7s9ybsdyfs",
        10: "g6BeBfq",
      },
      {
        0: "g0O3h4O8ObhcO",
        1: "g0B8B",
        6: "g4OcOfn",
        8: "g1y3u5y7u9ybudyfu",
        10: "g6BeBfq",
      },
      // Dancefloor with ride accents
      {
        0: "g0O4O8OcOfh",
        1: "g0E8E",
        6: "g4OcO",
        8: "g1y3u5y7u9ybudyfu",
        10: "g6EeEfs",
        11: "g2n6nanen",
      },
    ],
  },

  // ── Soulful (Defected / warm vocal-house heritage) ────
  // 120-126: warm soft kick, classic clap on 2+4, swung shuffle hats,
  // open-hat breathing — the vocal-house bed.
  {
    id: "house.soulful",
    genre: "house",
    name: "Soulful",
    bpm: [120, 126],
    swing: 0.16,
    activePads: [0, 6, 8, 10, 11],
    patterns: [
      {
        0: "g0H4H8HcH",
        6: "g4EcE",
        8: "g1q2d3q5q6d7q9qadbqdqedfq",
        10: "g6ueufk",
        11: "g0d8d",
      },
      {
        0: "g0H3d4H8HcHeh",
        6: "g4EcEed",
        8: "g1s2d3q5s6d7q9sadbqdsedfq",
        10: "g6wewfn",
      },
      // Soulful with ride shuffle
      {
        0: "g0H4H8HcH",
        6: "g4EcE",
        8: "g1q2d3n5q6d7n9qadbndqedfn",
        10: "g6ueu",
        11: "g1a4a8aca",
      },
    ],
  },

  // ── Heartbeat (Fred-style emotional UKG) ──────────────
  // 126-134: the sparse "lub-dub" kick pulse (beat 1 strong, beat 3 soft)
  // with swung offbeat shaker keeping the pulse — room for a pitched-up
  // vocal chop to BE the melody. Deliberately empty; the silence is the
  // emotional carrier.
  {
    id: "house.heartbeat",
    genre: "house",
    name: "Heartbeat",
    bpm: [126, 134],
    swing: 0.14,
    activePads: [0, 4, 8, 10, 6],
    patterns: [
      {
        0: "g0O5B",
        8: "g1q3k5q7k9qbkdqfk",
        6: "gdk",
      },
      {
        0: "g0O5B8E",
        4: "gcs",
        8: "g1q3k5q7k9qbkdqfk",
        10: "ges",
        6: "gdk",
      },
      // The double-time heartbeat (lub-dub-dub) into the drop
      {
        0: "g0O5y7saB",
        8: "g1s3k5s7k9sbkdsfk",
        10: "geu",
        6: "g2hahdk",
      },
    ],
  },

  // ── Broken (Overmono school — UKG x breakbeat techno) ─
  // 128-138: syncopated broken-beat kick (never 4-on-floor), click
  // percussion on the offbeats, tight snare answers — club pressure with
  // garage DNA.
  {
    id: "house.broken",
    genre: "house",
    name: "Broken",
    bpm: [128, 138],
    swing: 0.1,
    activePads: [0, 4, 8, 10, 6],
    patterns: [
      {
        0: "g0O6uaH",
        4: "g4EcEek",
        8: "g0q2n4q6n8qancqenfk",
        10: "g6seq",
        6: "g1h5h9hdh",
      },
      {
        0: "g0O5uaHds",
        4: "g4EcE",
        8: "g0q2n3k4q6n8qanbkcqen",
        10: "g6qes",
        6: "g1h5h9hdh",
      },
      // Rolling variation — the kick walks
      {
        0: "g0O3q6u9scE",
        4: "g4E7hcHek",
        8: "g0q2n4q6n7k8qancqen",
        10: "g6seq",
      },
    ],
  },
  // ── Pop (dance-pop — four-on-floor + pop clap, hats leave room to sing) ──
  {
    id: "house.pop",
    genre: "house",
    name: "Pop",
    bpm: [118, 124],
    swing: 0.06,
    activePads: [0, 6, 8, 10, 7, 3],
    patterns: [
      {
        0: "g0K4K8KcK",
        6: "g4HcH",
        8: "g2n6nanen",
        10: "geu",
        7: "g2a6aaaea",
      },
      {
        0: "g0K4K8KcK",
        6: "g4H7kcH",
        8: "g2q6qaqeq",
        10: "gaseu",
        3: "g7q",
      },
      {
        0: "g0K4H8KcH",
        6: "g4EcEfq",
        8: "g2k6kakek",
        7: "g0a4a8aca",
        10: "gew",
      },
      {
        0: "g0K4K8KcKek",
        6: "g4HcH",
        8: "g2n6nanenfd",
        10: "geu",
        3: "gcq",
      },
    ],
  },
  // ── Synthpop (80s grid — driving 16th hats, gated snare+clap) ──
  {
    id: "house.synthpop",
    genre: "house",
    name: "Synthpop",
    bpm: [100, 118],
    swing: 0.04,
    activePads: [0, 4, 6, 8, 10],
    patterns: [
      {
        0: "g0K4K8KcK",
        4: "g4HcH",
        6: "g4ucu",
        8: "g0q1d2q3d4q5d6q7d8q9daqbdcqddeqfd",
        10: "g2q6qaqeq",
      },
      {
        0: "g0K4K8KcK",
        4: "g4HcHfk",
        6: "g4ucu",
        8: "g0s1d2s3d4s5d6s7d8s9dasbdcsddesfh",
        10: "g2qaqes",
      },
      {
        0: "g0K8K",
        4: "g4HcH",
        6: "g4scs",
        8: "g0n1a2n3a4n5a6n7a8n9aanbacndaenfa",
        10: "g2n6nanen",
      },
      {
        0: "g0K4K8KcK",
        4: "g4HcKek",
        6: "g4ucu",
        8: "g0q1d2q3d4q5d6q7d8q9daqbdcqddeqfd",
        10: "g2q6qaqeu",
      },
    ],
  },
  // ── Disco (nu-disco / disco-pop — the octave-bass octave pairs over four-
  // on-floor, the open hat ON the offbeats, clap 2+4, the cowbell/various
  // perc sparkle every half bar) ──
  {
    id: "house.disco",
    genre: "house",
    name: "Disco",
    bpm: [112, 124],
    swing: 0.08,
    activePads: [0, 4, 6, 8, 10, 7, 13],
    patterns: [
      {
        0: "g0K4K8KcK",
        4: "g4EcE",
        6: "g4HcH",
        8: "g0q3q4q7q8qbqcqfq",
        10: "g2s6sases",
        7: "g0d4d8dcd",
      },
      {
        0: "g0K4K8KcK",
        4: "g4EcEen",
        6: "g4HcH",
        8: "g0q3q4q7q8qbqcqfs",
        10: "g2s6sasbkes",
        13: "gcq",
      },
      // Octave-bass walk — the kick doubles the bass octave pattern
      {
        0: "g0K3q6u8KcH",
        4: "g4EcE",
        6: "g4H7kcH",
        8: "g0q3n4q7q8qbncqfq",
        10: "g2s6saseu",
        7: "g0d4d8hcded",
      },
      // Syncopated disco-funk — the snare displaces to beat 3, kick drops it
      {
        0: "g0K4KcKeq",
        4: "g4E8BcE",
        6: "g4HcH",
        8: "g0q3q4q7q8qbqcqfq",
        10: "g2s6sasesfk",
      },
    ],
  },
  // ── Afroswing (UK afroswing — between afrobeat and UKG, ~104) ─────────
  // J Hus / MoStack / NSG: four-on-floor with a UKG lilt — swung shaker
  // 16ths, offbeat rim melody, snare answers late (never on the grid).
  {
    id: "house.afroswing",
    genre: "house",
    name: "Afroswing",
    bpm: [100, 108],
    swing: 0.2,
    activePads: [0, 3, 4, 6, 7, 8, 10, 14],
    patterns: [
      {
        0: "g0J4J8JcJ",
        3: "g2s7sas",
        4: "g4EcEfk",
        6: "gcB",
        7: "g0k2h3d4k6h7d8kahbdckehfd",
        8: "g1q3n5q7n9qbndqfn",
        10: "g6ueu",
        14: "g0d3d6d8dbded",
      },
      // Lilt variation: the rim walks, the snare drags behind beat 4.
      {
        0: "g0J4J8JcJek",
        3: "g3s6sbses",
        4: "g4EdE",
        6: "gcB",
        7: "g0k2h3d4k6h7d8kahbdckehfd",
        8: "g1q3n5q7n9qbndqfn",
        10: "g6ueufk",
        14: "g2d4dadcd",
      },
    ],
  },
  // ── Bass house (Wave 3) — Fisher / ACRAZE lane ─────────────────────────
  // Tech-house groove with a layered punch kick, offbeat clap, and busy
  // closed-hat work. The post-2018 Fisher / ACRAZE / Sidepiece bass-led
  // club sound. BPM 124-130, swing 0.10 (straight four-on-the-floor).
  {
    id: "house.basshouse",
    genre: "house",
    name: "Bass House",
    bpm: [124, 130],
    swing: 0.1,
    activePads: [0, 1, 6, 8, 10, 11],
    patterns: [
      {
        0: "g0K4K8KcK",
        1: "g0y4w8ycw",
        6: "g2H6HaHeH",
        8: "g1w3u5w7s9ubwdsfu",
        10: "g0B",
        11: "g3d7hbdfh",
      },
      {
        0: "g0K4K8KcK",
        1: "g0w8w",
        6: "g1H5H9HdH",
        8: "g1u3s5u7q9sbudqfs",
        10: "g8y",
        11: "g1d5d9hdd",
      },
      {
        0: "g0O4K8OcK",
        1: "g0y8y",
        6: "g2H6HaHeH",
        8: "g1y3s5w7s9ybsdwfs",
        10: "g",
        11: "g0d2d5d8daddd",
      },
      {
        0: "g0K4K8KcK",
        1: "g0y4w8ycw",
        6: "g1H5H9HdH",
        8: "g1w3u5w7u9wbudwfu",
        10: "g0B",
        11: "g2d4d7dadcdfd",
      },
    ],
  },
  // ── G-house (Wave 3) — Don Diablo / Tchami French deep ─────────────────
  // French deep vocal-chop tech-house (Don Diablo's "g-house" coinage).
  // Steady four-on-the-floor kick, offbeat clap, open-hat on the 'and',
  // ride for melodic forward motion. BPM 120-126, swing 0.14.
  {
    id: "house.ghouse",
    genre: "house",
    name: "G-House",
    bpm: [120, 126],
    swing: 0.14,
    activePads: [0, 6, 8, 7, 9, 10],
    patterns: [
      {
        0: "g0H4H8HcH",
        6: "g2B6BaBeB",
        8: "g1q3n5q7n9qbndqfn",
        7: "g1s5s9sds",
        9: "g0a4a8aca",
        10: "g0u",
      },
      {
        0: "g0H4H8HcH",
        6: "g2y6yayey",
        8: "g1n3q5n7q9nbqdnfq",
        7: "g2s6sases",
        9: "g3a7abafa",
        10: "g",
      },
      {
        0: "g0H4H8HcH",
        6: "g1B5B9BdB",
        8: "g1q3n5q7n9qbndqfn",
        7: "g1s5s9sds",
        9: "g0a2a4a6a8aaacaea",
        10: "g0u",
      },
      {
        0: "g0H4H8HcH",
        6: "g2y6yayey",
        8: "g1n3n5n7n9nbndnfn",
        7: "g4scs",
        9: "g2a6aaaea",
        10: "g8s",
      },
    ],
  },
  // ── Footwork / juke (Wave 3) — RP Boo / DJ Rashad Chicago lane ──────────
  // The Chicago footwork school: fast 4/4 (155-165) with polyrhythmic kick
  // syncopations against a steady snare, busy hats, and percussion stabs.
  // Swing 0 (straight) — footwork's signature is dead-grid precision.
  {
    id: "house.footwork",
    genre: "house",
    name: "Footwork",
    bpm: [155, 165],
    swing: 0,
    activePads: [0, 2, 4, 8, 11],
    patterns: [
      {
        0: "g0K3s6H8ybueE",
        2: "g1q5s9sdq",
        4: "g4HcH",
        8: "g1k2k4k6k7h9kakckekfh",
        11: "g0d3d6d8dbded",
      },
      {
        0: "g0K1u5s8HbueH",
        2: "g2q6s9qes",
        4: "g4HcH",
        8: "g0k2k5k7kakdkfk",
        11: "g1d4d7daddd",
      },
      {
        0: "g0H3u4H9sbHfs",
        2: "g2q6qaseq",
        4: "g4HcH",
        8: "g1k3k5h7k9kbkdkfk",
        11: "g0d2d5d8daddd",
      },
    ],
  },
  // ── Afropop (afrobeats pop — the 3+3+2 kick cross-rhythm, rim melody,
  // sparse snare. Wizkid 'Essence' / Burna 'Last Last' pocket, NOT the
  // 4-on-floor afro-house pocket above) ──
  {
    id: "house.afropop",
    genre: "house",
    name: "Afropop",
    bpm: [98, 112],
    swing: 0.16,
    activePads: [0, 3, 5, 7, 8, 14],
    patterns: [
      {
        0: "g0H6yaB",
        3: "g2q7naqfk",
        5: "g8B",
        7: "g0h2d4h6d8hadched",
        8: "g1n3n5n7n9nbndnfn",
        14: "g0a3a6a8abacafa",
      },
      {
        0: "g0H6wayds",
        3: "g2n4qaneq",
        5: "g8B",
        7: "g0h2d3d4h6d8hadbdched",
        8: "g1n3k5n7k9nbkdnfk",
        14: "g1a4a7a9aca",
      },
      // Syncopated lift — the kick walks an extra 16th before the loop turns
      {
        0: "g0H6w7qaBes",
        3: "g2q6naqcnfk",
        5: "g8B",
        7: "g0h2d4h6d7d8hadchedfd",
        8: "g1n3n5k7n9nbkdnfn",
      },
    ],
  },
  // ── Dembow (reggaeton / latin pop — the chop: rim-snare on the "and" of
  // 1 and 3 over a half-time kick. Despacito / Hips Don't Lie pocket) ──
  {
    id: "house.dembow",
    genre: "house",
    name: "Dembow",
    bpm: [88, 100],
    swing: 0.06,
    activePads: [0, 3, 5, 7, 8, 10],
    patterns: [
      {
        0: "g0K6w8Keu",
        3: "g3EbE",
        5: "g3dbd",
        7: "g0d2a4d6a8daacdea",
        8: "g1q3q5q7q9qbqdqfq",
      },
      {
        0: "g0K6u8Kewfq",
        3: "g3EbBfn",
        5: "g3aba",
        7: "g0d2a4d6a8daachea",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6qes",
      },
      // Perreo push — doubled dembow chop, kick rides 16th pickups
      {
        0: "g0K4q6w8Kcqeu",
        3: "g3H7nbHfn",
        5: "g3dbd",
        7: "g0d2a4h6a8daachea",
        8: "g1q3q5q7q9qbqdqfq",
      },
    ],
  },
  // ── Country pop (train beat — boom-chicka: kick 1/3, snare backbeat 2/4,
  // shaker 16ths + rim "chicka". Shania / Kacey / Golden Hour pocket) ──
  {
    id: "house.countrypop",
    genre: "house",
    name: "Country Pop",
    bpm: [96, 126],
    swing: 0.1,
    activePads: [0, 3, 4, 7, 8, 10],
    patterns: [
      {
        0: "g0H8H",
        3: "g2k6kakek",
        4: "g4EcE",
        7: "g0k1a2k3a4k5a6k7a8k9aakbackdaekfd",
        8: "g2n6nanen",
      },
      {
        0: "g0H6s8Heq",
        3: "g2k6kakekfh",
        4: "g4EcE",
        7: "g0k1a2k3a4k5a6k7a8k9aakbackdaekfd",
        8: "g2n6nanen",
        10: "geq",
      },
      // Two-step lean — the kick anticipates beat 3 (the country lift)
      {
        0: "g0H7q8Hfn",
        3: "g2k6kakek",
        4: "g4EcEek",
        7: "g0k1a2k3a4k5a6k7a8k9aakbackdaekfd",
        8: "g2n6nanen",
      },
    ],
  },
  // ── Progressive house (the hypnotic build — soft four-floor, offbeat open
  // hat, 16th shaker bed, NO big backbeat: tension comes from percussion
  // density, not the clap. Prydz / deadmau5 / Anjunadeep pocket) ──
  {
    id: "house.progressive",
    genre: "house",
    name: "Progressive",
    bpm: [124, 128],
    swing: 0.04,
    activePads: [0, 3, 7, 8, 10, 14],
    patterns: [
      {
        0: "g0H4H8HcH",
        3: "g6ncnfk",
        7: "g0d1a2d3a4d5a6d7a8d9aadbacddaedfd",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6qes",
      },
      {
        0: "g0H4H8HcH",
        3: "g2k7kak",
        7: "g0d172d374d576d778d97adb7cdd7edfa",
        8: "g1n3n5n7n9nbndnfn",
        14: "g0a3a6a8abaca",
      },
      // Groove lift — the kick swings a pickup, ride enters
      {
        0: "g0H3q4H8HcHeq",
        3: "g2n6kanek",
        7: "g0d1a2d3a4d5a6d7a8d9aadbacddaedfd",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6sesfk",
      },
    ],
  },
  // ── Big beat (the breaks floor — syncopated breakbeat kick, HEAVY snare
  // on 2+4, big swagger. Chemical Brothers / Fatboy Slim / Prodigy pocket) ──
  {
    id: "house.bigbeat",
    genre: "house",
    name: "Big Beat",
    bpm: [104, 128],
    swing: 0.05,
    activePads: [0, 4, 5, 8, 10, 12],
    patterns: [
      {
        0: "g0O6yaE",
        4: "g4OcO",
        5: "g4kck",
        8: "g0q2n4q6n8qancqenfk",
        10: "ges",
      },
      {
        0: "g0O3s6y8Keu",
        4: "g4OcKfn",
        5: "g4hch",
        8: "g0q2q4q6n7k8qaqcqen",
        12: "gaq",
      },
      // Roll variation — the kick doubles into the snare
      {
        0: "g0O4y6y8Obuew",
        4: "g4OcOeq",
        8: "g0q2n3k4q6n8qanbkcqenfk",
        10: "ges",
        12: "g2naq",
      },
    ],
  },
  // ── Moombahton (house × dembow — the four-floor kick at reggaeton tempo
  // with the dembow chop underneath. Dillon Francis / Major Lazer pocket) ──
  {
    id: "house.moombahton",
    genre: "house",
    name: "Moombahton",
    bpm: [105, 112],
    swing: 0.12,
    activePads: [0, 3, 4, 7, 8, 10],
    patterns: [
      {
        0: "g0K4K8KcK",
        3: "g3BbB",
        4: "g4EcE",
        7: "g0h2d4h6d8hadched",
        8: "g1q3q5q7q9qbqdqfq",
      },
      {
        0: "g0K4K8KcKeq",
        3: "g3B7nbBfn",
        4: "g4EcH",
        7: "g0h2d4h6d8hadched",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6qes",
      },
      // Tweak variation — kick drops beat 2, chop doubles
      {
        0: "g0K6u8KcKfq",
        3: "g3E7qbEfq",
        4: "g4HcE",
        7: "g0h2d4h6d7d8hadched",
        8: "g1q3q5q7q9qbqdqfq",
      },
    ],
  },
  // ── Slap house (modern minimal club — four-floor with a punch kick
  // double, rolling bass pocket, sparse everything else. Alok / Imanbek /
  // Meduza pocket) ──
  {
    id: "house.slaphouse",
    genre: "house",
    name: "Slap House",
    bpm: [118, 124],
    swing: 0.05,
    activePads: [0, 1, 6, 8, 10, 14],
    patterns: [
      {
        0: "g0K4K8KcK",
        1: "g4qcq",
        6: "g4ycy",
        8: "g1q3q5q7q9qbqdqfq",
        14: "g0d3d4d7d8dbdcdfd",
      },
      {
        0: "g0K4K8KcKeq",
        1: "g4n7qcn",
        6: "g4ycy",
        8: "g1q3q5q7q9qbqdqfq",
        10: "g6qes",
      },
      // Bass-pocket variation — kick double walks
      {
        0: "g0K4K7q8KcK",
        1: "g3nbneq",
        6: "g4ycB",
        8: "g1q3q5q7q9qbqdqfq",
        14: "g0d3d4d7d8dbdcdfd",
      },
    ],
  },
  // ── UK funky (the London soca-bounce — broken kick punch, syncopated rim
  // chatter, shaker bed. Roska / Lil Silva / Champion pocket, 125-130;
  // Drake's "One Dance" drew on this) ──
  {
    id: "house.ukfunky",
    genre: "house",
    name: "UK Funky",
    bpm: [125, 130],
    swing: 0.12,
    activePads: [0, 3, 6, 7, 8, 10],
    patterns: [
      {
        0: "g0K6w8H",
        3: "g2n6kanek",
        6: "g4ycy",
        7: "g0h2d4h6d8hadched",
        8: "g1q3n5q7n9qbndqfn",
      },
      {
        0: "g0K6u8Hcqfn",
        3: "g2n7kanfk",
        6: "g4ycy",
        7: "g0h2d4h6d7d8hadched",
        8: "g1q3n5q7n9qbndqfn",
        10: "g6qes",
      },
      // Soca lift — the rim walks, the kick drops the pickup
      {
        0: "g0K6w7q8Heq",
        3: "g2n6kanekfh",
        6: "g4Bcy",
        7: "g0h2d4h6d8hadbdched",
        8: "g1q3n5q7n9qbndqfn",
      },
    ],
  },
  // ── Gqom (the Durban mutation — NO four-on-the-floor: a broken syncopated
  // kick answered by pounding log toms over a distorted sub, sparse eerie
  // chants. DJ Lag / Distruction Boyz pocket, ~120) ──
  {
    id: "house.gqom",
    genre: "house",
    name: "Gqom",
    bpm: [115, 128],
    swing: 0.05,
    activePads: [0, 8, 12, 13, 15],
    patterns: [
      {
        0: "g0K6yes",
        8: "g0k3h4k7h8kbhckfh",
        12: "g4HcH",
        13: "g6yew",
        15: "g2kak",
      },
      {
        0: "g0K7qayfn",
        8: "g0k2h4k7h8kahckfh",
        12: "g4H7qcH",
        13: "g6yey",
      },
      // Cyclical drive — the log toms trade fours with the broken kick
      {
        0: "g0K6waydq",
        8: "g0k3h4k7h8kbhckfh",
        12: "g4HaucH",
        13: "g6yewfn",
        15: "g2k7kek",
      },
    ],
  },
  // ── Dembow dominicano (dembow 2.0 — the raw Santo Domingo lane: the same
  // chop but with every 16th FILLED, so it feels twice as fast as the tempo.
  // El Alfa / Rochy RD pocket, 100-112) ──
  {
    id: "house.dembowdom",
    genre: "house",
    name: "Dembow Dominicano",
    bpm: [100, 112],
    swing: 0.05,
    activePads: [0, 3, 4, 6, 8],
    patterns: [
      {
        0: "g0O6y8Oey",
        3: "g3H7qbHfq",
        4: "g4EcE",
        6: "g0d2a4d6a8daacdea",
        8: "g1q3q5q7q9qbqdqfq",
      },
      {
        0: "g0O4q6y8Ocqey",
        3: "g3H7qbHfs",
        4: "g4EcHek",
        6: "g0d2d4d6a8dadchea",
        8: "g1s3q5q7q9sbqdqfq",
      },
      // Perreo frenético — the chop doubles tight, kick rides 16th pickups
      {
        0: "g0O6B7q8OdqeB",
        3: "g3K7sbKfs",
        4: "g4HcK",
        6: "g0h2d4h6d8hadched",
        8: "g1s3q5s7q9sbqdsfq",
      },
    ],
  },
  // ── Amapiano (the log drum genre — quiet four-floor deep-house kick, busy
  // semiquaver shaker, and the syncopated rounded log-drum bass answering on
  // the toms. Kabza De Small / MDU aka Mas pocket, 110-116) ──
  {
    id: "house.amapiano",
    genre: "house",
    name: "Amapiano",
    bpm: [110, 116],
    swing: 0.08,
    activePads: [0, 7, 10, 12, 13],
    patterns: [
      {
        0: "g0B4B8BcB",
        7: "g0d182d384d586d788d98adb8cdd8edfc",
        10: "g6neq",
        12: "g3E6sbwen",
      },
      {
        0: "g0B4B8BcB",
        7: "g0d182d384d586d788d98adb8cdd8edfc",
        12: "g2w7qay",
        13: "gcufn",
      },
      // Log drum walk — the bass answer climbs across both toms
      {
        0: "g0B4B8BcB",
        7: "g0d182d384d586d788d98adb8cdd8edfc",
        12: "g3B7qau",
        13: "gcweqfk",
      },
    ],
  },
  // ── Organic house (the Anjunadeep / Keinemusik wave — soft four-floor under
  // hand-drum percussion: conga rim chatter, shaker, tom accents, emotive and
  // hypnotic. 118-124, the 120 sweet spot) ──
  {
    id: "house.organic",
    genre: "house",
    name: "Organic House",
    bpm: [118, 124],
    swing: 0.07,
    activePads: [0, 3, 7, 11, 12, 13],
    patterns: [
      {
        0: "g0E4E8EcE",
        3: "g2k6hakeh",
        7: "g0c172c374c576c778c97acb7ccd7ecfa",
        11: "g0a3a6a8abaca",
        12: "gcs",
      },
      {
        0: "g0E4E8EcEen",
        3: "g2k4h7kakeh",
        7: "g0c172c374c576c778c97acb7ccd7ecfa",
        13: "g8qen",
      },
      // Hypnotic build — the toms trade over the steady floor
      {
        0: "g0E4E8EcE",
        3: "g2k6hakekfd",
        12: "g6qcs",
        13: "geqfk",
      },
    ],
  },
  // ── Ghettotech (Detroit's torqued-up Miami bass — banging 808 kick with
  // syncopated booty-bounce pickups, hard claps, short hooky tracks. DJ
  // Godfather / DJ Assault pocket, 130-140) ──
  {
    id: "house.ghettotech",
    genre: "house",
    name: "Ghettotech",
    bpm: [130, 140],
    swing: 0.06,
    activePads: [0, 1, 6, 8, 10],
    patterns: [
      {
        0: "g0O6y8Key",
        1: "g7qfq",
        6: "g4KcK",
        8: "g0q2n4q6n8qancqen",
        10: "ges",
      },
      {
        0: "g0O3u6y8Kbuey",
        1: "g7nfn",
        6: "g4KcHek",
        8: "g0q2n4q6n7k8qancqenfk",
      },
      // Booty bounce — the kick doubles tight, electro open hat takes over
      {
        0: "g0O4y7s8Kcyfs",
        1: "gbq",
        6: "g4KcO",
        8: "g0q2n3k4q6n7k8qanbkcqenfk",
        10: "g6sesfn",
      },
    ],
  },
  // ── Kuduro / batida (the Luanda carnival engine — upbeat driving kick
  // with frantic syncopated percussion while the rap rides HALF-TIME on top.
  // Angola 90s → globalized by Lisbon's Buraka Som Sistema, 130-140) ──
  {
    id: "house.kuduro",
    genre: "house",
    name: "Kuduro",
    bpm: [130, 140],
    swing: 0.05,
    activePads: [0, 3, 6, 8, 12, 15],
    patterns: [
      {
        0: "g0K4K8KcK",
        3: "g2n6kanek",
        6: "g4EcE",
        8: "g0q2k3h4q6k8qakbhcqek",
        15: "g3kbkfk",
      },
      {
        0: "g0K4K7q8KcHeq",
        3: "g2n7kanfh",
        6: "g4EcH",
        12: "g6ses",
        15: "g2k7kek",
      },
      // Carnival break — the kick drops beat 3, percussion takes the wheel
      {
        0: "g0K4KaBcKeq",
        3: "g2q6kaqekfk",
        6: "g4HcE",
        8: "g0q2k3h4q6k7h8qakcqekfh",
        12: "g8qes",
      },
    ],
  },
  // ── Tropical house (the beach lane — a soft four-floor under light claps
  // and sparse steel-pan pings; the marimba/flute melodies float on top.
  // Kygo / Thomas Jack pocket, 100-110) ──
  {
    id: "house.tropical",
    genre: "house",
    name: "Tropical",
    bpm: [100, 110],
    swing: 0.07,
    activePads: [0, 6, 7, 10, 15],
    patterns: [
      {
        0: "g0y4y8ycy",
        6: "g4ucu",
        7: "g0c2a4c6a8caaccea",
        10: "g1n3n5n7n9nbndnfn",
        15: "g6kek",
      },
      {
        0: "g0y4y8ycy",
        6: "g4ucweh",
        7: "g0c284c688ca8cce8",
        10: "g1n3k5n7k9nbkdnfk",
        15: "g3hak",
      },
      // Sunset lift — the pan pings answer the offbeat hats
      {
        0: "g0y4y8ycyek",
        6: "g4wcu",
        7: "g0c2a4c6a8caacceafa",
        10: "g1n3n5n7n9nbndnfn",
        15: "g2kakek",
      },
    ],
  },
  // ── Grunge (the garage stomp — straight heavy backbeat: kick 1/3 with a
  // push, HEAVY snare 2/4, driving 8th hats, tom accents. Nirvana / Pearl
  // Jam pocket, 95-125) ──
  {
    id: "house.grunge",
    genre: "house",
    name: "Grunge",
    bpm: [95, 125],
    swing: 0.04,
    activePads: [0, 1, 4, 8, 12],
    patterns: [
      {
        0: "g0O6B8K",
        1: "gbs",
        4: "g4OcO",
        8: "g0s2q4s6q8saqcseq",
        12: "geq",
      },
      {
        0: "g0O6E8Kbuey",
        4: "g4OcOen",
        5: "g4hch",
        8: "g0s2q3k4s6q8saqbkcseq",
      },
      // Stop-time lift — the kick drops, the toms answer
      {
        0: "g0O8HcKeu",
        4: "g4OcO",
        8: "g0s2q3k4s6q7k8saqbkcseqfk",
        12: "g2naqeqfn",
      },
    ],
  },
  // ── Alternative rock (the tighter radio backbeat — syncopated kick, solid
  // snare 2/4, controlled 8ths. Radiohead / Weezer / RHCP pocket, 85-125) ──
  {
    id: "house.altrock",
    genre: "house",
    name: "Alt Rock",
    bpm: [85, 125],
    swing: 0.05,
    activePads: [0, 4, 8, 10, 12],
    patterns: [
      {
        0: "g0K6y8Heu",
        4: "g4KcK",
        8: "g0q2n4q6n8qancqen",
        10: "geq",
      },
      {
        0: "g0K3s6y8Hbsew",
        4: "g4KcK",
        8: "g0q2n4q6n7k8qancqen",
        12: "g8neq",
      },
      // Push variation — kick anticipates the backbeat
      {
        0: "g0K4u7s8Hcufq",
        4: "g4KcKek",
        8: "g0q2n3k4q6n8qanbkcqen",
      },
    ],
  },
  // ── Rapcore / nu metal (the hip-hop-rock hybrid — rap-syncopated kick
  // under a heavy rock backbeat, driving 16th hats. RATM / Linkin Park
  // pocket, 90-120 groove-based) ──
  {
    id: "house.rapcore",
    genre: "house",
    name: "Rapcore",
    bpm: [90, 120],
    swing: 0.05,
    activePads: [0, 4, 5, 8, 12],
    patterns: [
      {
        0: "g0O3u6B8Kbs",
        4: "g4OcO",
        5: "g4hch",
        8: "g0s1h2s3h4s5h6s7h8s9hasbhcsdhesfk",
      },
      {
        0: "g0O4u6B7q8Kcuew",
        4: "g4OcKen",
        8: "g0s1h2s3h4s5h6s7h8s9hasbhcsdhesfk",
        12: "g8qeq",
      },
      // Drop riff — kick doubles, snare cracks alone
      {
        0: "g0O3u7u8Oey",
        4: "g4OcO",
        5: "g3dbd",
        8: "g0s1h2s3h4s5h6s7h8s9hasbhcsdhesfk",
      },
    ],
  },
  // ── Synth punk (punk tempo on machines — driving kick 8ths under the
  // snare backbeat, tight and unswinging. The Units / proto-Suicide pocket,
  // 140-168) ──
  {
    id: "house.synthpunk",
    genre: "house",
    name: "Synth Punk",
    bpm: [140, 168],
    swing: 0.03,
    activePads: [0, 4, 8, 10],
    patterns: [
      {
        0: "g0K4u8Kcu",
        4: "g4KcK",
        8: "g0u2s4u6s8uascues",
        10: "geq",
      },
      {
        0: "g0K3s7s8Kbsfs",
        4: "g4KcK",
        8: "g0u2s4u6s8uascues",
      },
      // Descend variation — the kick walks the octave, hats open late
      {
        0: "g0K4s7s8Kcsfs",
        4: "g4KcOen",
        8: "g0u2s4u6s8uascues",
        10: "g6qes",
      },
    ],
  },
  // ── Piano House (the 90s/2020s piano-led floor filler) ───────────────────
  // Bright four-on-floor with open-hat lift and a shuffled shaker; the piano
  // chord stabs come from the melodic layer / presets — the groove leaves the
  // mid-band room for them (sparse percussion, no clap on every beat).
  {
    id: "house.pianohouse",
    genre: "house",
    name: "Piano House",
    bpm: [122, 130],
    swing: 0.1,
    activePads: [0, 4, 6, 7, 8, 10],
    patterns: [
      {
        0: "g0O4K8OcK",
        4: "g4HcH",
        6: "gcB",
        7: "g0d2c4d6c8daccdec",
        8: "g1q3n5q7n9qbndqfn",
        10: "g2u6saues",
      },
      {
        0: "g0O3q4K8ObqcK",
        4: "g4HcHek",
        6: "gcy",
        7: "g0c2b4c6b8cabcceb",
        8: "g0q2n4q6n8qancqen",
        10: "g2u6saues",
      },
      // Lift variation - the kick doubles into the last beat
      {
        0: "g0O4K8OcKeu",
        4: "g4HcK",
        6: "gcBeq",
        8: "g0q2n4q6n8qancqen",
        10: "g2u6saueu",
      },
    ],
  },
  // ── Midtempo (the half-time bass-music floor, 90-110) ────────────────────
  // Sparse kick on the one and the and-of-three, huge snare backbeat with a
  // long gap — the "midtempo bass" pocket where the sound design carries the
  // track, not the percussion.
  {
    id: "house.midtempo",
    genre: "house",
    name: "Midtempo",
    bpm: [90, 110],
    swing: 0.05,
    activePads: [0, 1, 4, 6, 8, 10, 14],
    patterns: [
      {
        0: "g0O8q",
        1: "g6E",
        4: "g8O",
        6: "g8E",
        8: "g0k4j8kcj",
        10: "g6qes",
        14: "gek",
      },
      {
        0: "g0O8scq",
        4: "g8O",
        6: "g8Hek",
        8: "g0k4j8kcj",
        10: "g6qes",
        14: "gek",
      },
      // Half-time drop - everything lands on the one
      {
        0: "g0R8u",
        4: "g8R",
        6: "g8H",
        8: "g0h4f8hcf",
        10: "g6qeq",
      },
    ],
  },
  // ── Breakbeat (the big-beat / breaks floor) ─────────────────────────────
  // Syncopated kick, hard snare backbeat with ghost pushes — the
  // Fatboy/Prodigy pocket, 125-140.
  {
    id: "house.breakbeat",
    genre: "house",
    name: "Breakbeat",
    bpm: [125, 140],
    swing: 0.08,
    activePads: [0, 4, 5, 8, 10],
    patterns: [
      {
        0: "g0O6y8ndqfw",
        4: "g4OcOek",
        5: "g2h7dbe",
        8: "g0q1k2p3j4q5k6p7j8q9kapbjcqdkepfj",
        10: "g3nbn",
      },
      {
        0: "g0O4s6y8nbqdufw",
        4: "g4OcOek",
        5: "g2h7dbeec",
        8: "g0q1k2p3j4q5k6p7j8q9kapbjcqdkepfj",
        10: "g3nbnfq",
      },
      // Rolling break - kick on every 8th, snare cracks sparse
      {
        0: "g0K2q4K6q8KaqcKeq",
        4: "g4KcK",
        5: "g2d7cbd",
        8: "g0n1h2l3f4n5h6l7f8n9halbfcndhelff",
      },
    ],
  },
  // ── Heavy metal (the gallop — driving backbeat with kick pickups, crash
  // accents. The classic engine, 100-140) ──
  {
    id: "house.metal",
    genre: "house",
    name: "Metal",
    bpm: [100, 140],
    swing: 0.04,
    activePads: [0, 4, 8, 10, 12],
    patterns: [
      {
        0: "g0O3w6B8KbueB",
        4: "g4OcO",
        8: "g0s2q4s6q8saqcseq",
        10: "g8qes",
      },
      {
        0: "g0O3u7y8Kbufy",
        4: "g4OcOen",
        8: "g0s2q3k4s6q8saqbkcseq",
      },
      // Gallop variation — the kick triples into the backbeat
      {
        0: "g0O3u4y6u8Kbucyeu",
        4: "g4OcO",
        8: "g0s2q3k4s6q7k8saqbkcseqfk",
        12: "g8neq",
      },
    ],
  },
  // ── Thrash (the driving 8th-kick beat — every eighth under the backbeat
  // snare, tight and relentless. Slayer / early Metallica pocket, 140-180) ──
  {
    id: "house.thrash",
    genre: "house",
    name: "Thrash",
    bpm: [140, 180],
    swing: 0.03,
    activePads: [0, 4, 8],
    patterns: [
      {
        0: "g0H2E4H6E8HaEcHeE",
        4: "g4OcO",
        8: "g0u2s4u6s8uascues",
      },
      {
        0: "g0H2E4H6E7q8HaEcHeEfq",
        4: "g4OcOen",
        8: "g0u2s4u6s8uascues",
      },
      // Ride-the-lightning variation — 8ths open up into 16th pushes
      {
        0: "g0H2E3n4H6E8HaEbncHeEfn",
        4: "g4OcKek",
        8: "g0u1k2s4u5k6s8u9kascudkes",
      },
    ],
  },
  // ── Metalcore (the breakdown genre — driving verses and the HALF-TIME
  // crush where the same tempo lands like half the speed. Killswitch / BMTH
  // pocket, 140-170) ──
  {
    id: "house.metalcore",
    genre: "house",
    name: "Metalcore",
    bpm: [140, 170],
    swing: 0.04,
    activePads: [0, 4, 5, 8, 12],
    patterns: [
      {
        0: "g0K2E4H6E8KaEcHeE",
        4: "g4KcK",
        8: "g0s1h2q3h4s5h6q7h8s9haqbhcsdheqfh",
      },
      // THE BREAKDOWN — half-time crush: same tempo, half the pulse
      {
        0: "g0O6B",
        4: "g8O",
        5: "g8k",
        8: "g0s4s8scs",
        12: "g6qeq",
      },
      // Breakdown chug — the kick stabs syncopate under the sparse snare
      {
        0: "g0O4y7uay",
        4: "g8O",
        5: "g8hed",
        8: "g0q4q8qcq",
      },
    ],
  },
  // ── Doom (the slow crush — half-time, sparse, every hit lands like a
  // tombstone closing. Black Sabbath / Electric Wizard pocket, 50-80) ──
  {
    id: "house.doom",
    genre: "house",
    name: "Doom",
    bpm: [50, 80],
    swing: 0.05,
    activePads: [0, 4, 8, 12],
    patterns: [
      {
        0: "g0OcE",
        4: "g8O",
        8: "g0n4n8ncn",
      },
      {
        0: "g0O6ycE",
        4: "g8Oeq",
        8: "g0n4k8nck",
        12: "gen",
      },
      // The long crawl — kick and snare trade whole notes
      {
        0: "g0OcH",
        4: "g4k8O",
        8: "g0k8n",
      },
    ],
  },
  // ── Hardcore punk (the fast tight beat — kick/snare trading eighths,
  // machine-tight, zero fat. Black Flag / Minor Threat pocket, 150-190) ──
  {
    id: "house.hardcorepunk",
    genre: "house",
    name: "Hardcore Punk",
    bpm: [150, 190],
    swing: 0.03,
    activePads: [0, 4, 8],
    patterns: [
      {
        0: "g0K6u8Keu",
        4: "g4OcO",
        8: "g0s2q4s6q8saqcseq",
      },
      // The d-beat — the kick displaces off the one (Discharge engine)
      {
        0: "g0K3u8Kbu",
        4: "g4OcO",
        8: "g0s1k2q4s5k6q8s9kaqcsdkeq",
      },
      // Blurring variation — the kick doubles under the snare roll
      {
        0: "g0K4u6u8Kcueu",
        4: "g4OcOek",
        8: "g0s1k2q3k4s5k6q7k8s9kaqbkcsdkeqfk",
      },
    ],
  },
  // ── Pop punk (the fast happy beat — kick 1 + the and-of-2 push under the
  // snare backbeat, tight 8th hats. Green Day / blink-182 pocket, 148-175) ──
  {
    id: "house.poppunk",
    genre: "house",
    name: "Pop Punk",
    bpm: [148, 175],
    swing: 0.04,
    activePads: [0, 4, 8, 10],
    patterns: [
      {
        0: "g0K6y8Heu",
        4: "g4OcO",
        8: "g0s2q4s6q8saqcseq",
        10: "geq",
      },
      {
        0: "g0K6y7q8Hew",
        4: "g4OcKek",
        8: "g0s2q3k4s6q8saqbkcseq",
      },
      // Hook lift — the open hat drives the turn
      {
        0: "g0K4u6y8Hcufs",
        4: "g4OcO",
        8: "g0s2q3k4s6q7k8saqbkcseqfk",
        10: "g6qes",
      },
    ],
  },
  // ── Indie (the garage-groove revival — syncopated kick under a dry
  // backbeat, offbeat open hats that make it dance. The Strokes / Arctic
  // Monkeys pocket, 100-130) ──
  {
    id: "house.indie",
    genre: "house",
    name: "Indie",
    bpm: [100, 130],
    swing: 0.06,
    activePads: [0, 4, 8, 10, 12],
    patterns: [
      {
        0: "g0H6u8Ees",
        4: "g4KcK",
        8: "g0q2n4q6n8qancqen",
        10: "g6neq",
      },
      {
        0: "g0H3q6u8Ebqes",
        4: "g4KcK",
        8: "g0q2n4q6n7k8qancqen",
        12: "g8ken",
      },
      // Dancefloor lean - the kick anticipates, the open hat answers
      {
        0: "g0H4s7q8Ecsfq",
        4: "g4KcKek",
        8: "g0q2n3k4q6n7k8qanbkcqenfk",
        10: "g6qeq",
      },
    ],
  },
  // ── Melodic house (Wave 4) — Lane 8 / Tinlicker / Yotto lane ────────────
  // Progressive / melodic house (Lane 8 'Brightest Lights' / Nora En Pure).
  // Rolling ride + soft ghost hats give the long-form forward motion; the
  // clap sits offbeat so the four-on-the-floor kick stays uncluttered.
  // BPM 120-128, swing 0.16.
  {
    id: "house.melodic",
    genre: "house",
    name: "Melodic",
    bpm: [120, 128],
    swing: 0.16,
    activePads: [0, 6, 8, 9, 10, 11],
    patterns: [
      {
        0: "g0H4H8HcH",
        6: "g6yey",
        8: "g0n2k4n6k8nakcnek",
        9: "g0727476787a7c7e7",
        10: "geq",
        11: "g0k3d4k7d8kbdckfd",
      },
      {
        0: "g0H4H8HcH",
        6: "g6yey",
        8: "g0n2k4n6k8nakcnek",
        9: "g2767a7e7",
        10: "ges",
        11: "g0k3d4k7d8kbdckfd",
      },
      {
        // Dropped clap bar - pure kick + ride + hats for the breakdown
        0: "g0H4H8HcH",
        8: "g0k2h4k6h8kahckeh",
        9: "g0727476787a7c7e7",
        11: "g0k3d4k7d8kbdckfd",
      },
      {
        // Clap pushed to the offbeat backbeat, ride doubles the 'and'
        0: "g0H4H8HcH",
        6: "g6wew",
        8: "g0n2k4n6k8nakcnek",
        9: "g2767a7e7",
        10: "g0q",
        11: "g0k3d4k7d8kbdckfd",
      },
    ],
  },
  // ── Baile funk (Wave 4) — Anitta / MC Kevin o Chris lane ───────────────
  // Brazilian baile funk (Anitta 'Envolver' / MC Kevin o Chris). The
  // tambor is the signature — modelled here as a low tom roll on the
  // offbeat triplet, with the shaker doubling the 16ths and a hard snare
  // landing on 2 and 4. BPM 130-150, swing 0.2 (the Brazilian shuffle).
  {
    id: "house.baile",
    genre: "house",
    name: "Baile Funk",
    bpm: [130, 150],
    swing: 0.2,
    activePads: [0, 4, 7, 8, 11, 12],
    patterns: [
      {
        0: "g0K4K8KcK",
        4: "g4HcH",
        7: "g4n6qcneq",
        8: "g0q2n4q6n8qancqen",
        11: "g0d4d8dcd",
        12: "g6ses",
      },
      {
        0: "g0K4K8KcK",
        4: "g4HcH",
        7: "g1n5n9ndn",
        8: "g0q2n4q6n8qancqen",
        11: "g2d6dad",
        12: "g6seq",
      },
      {
        // Tambor roll fills the second half of the bar
        0: "g0K4K8KcK",
        4: "g4HcH",
        7: "g4n6qcneq",
        8: "g0q2n4q6n8qancqenfq",
        11: "g0d4d8dcd",
        12: "g6qakcneqfs",
      },
      {
        // Half-time tail - snare drops out, tambor carries the groove
        0: "g0K4K8KcK",
        4: "g4EcE",
        7: "g4n6qcneq",
        8: "g0q2n4q6n8qancqen",
        11: "g0d4d8dcd",
        12: "g6ses",
      },
    ],
  },
  // ── Future bass (Wave 5) — Marshmello / Said The Sky lane ──────────────
  // The bright side of post-2014 pop-future-bass. Flume's existing entry
  // covers the 'lux' trap-flavour; this groove keeps the four-on-the-floor
  // pulse but adds the genre's signature syncopated 'skip' bass (pad 2 on
  // the 'e' and 'a' of 2) and a gated, reverse-filling open hat (pad 10 on
  // the last 16th). BPM 140-150, swing 0.04.
  {
    id: "house.futurebass",
    genre: "house",
    name: "Future Bass",
    bpm: [140, 150],
    swing: 0.04,
    activePads: [0, 1, 2, 6, 8, 10],
    patterns: [
      {
        0: "g0J4J8JcJ",
        1: "g0u8u",
        2: "g5ves",
        6: "g2D6DaDeD",
        8: "g0s2q4s6q8saqcseq",
        10: "gfq",
      },
      {
        0: "g0J4J8JcJ",
        1: "g0u8u",
        2: "g4uav",
        6: "g1D5D9DdD",
        8: "g0q2s4q6s8qascqes",
        10: "gfs",
      },
      {
        // Drop bar — skip bass drops out, kick + clap hold the floor
        0: "g0K4K8KcK",
        1: "g",
        2: "g",
        6: "g2D6DaDeD",
        8: "g0s2q4s6q8saqcseq",
        10: "gfu",
      },
      {
        // Half-time tail — the standard future-bass outro
        0: "g0K8K",
        1: "g",
        2: "g5u",
        6: "g2B6B",
        8: "g0q4q8qcq",
        10: "gfq",
      },
    ],
  },

  // ── K-pop (Wave 5) — BTS / NewJeans / IU / Stray Kids lane ─────────────
  // Korean pop production (BTS 'Dynamite' / NewJeans 'OMG' / IU). The
  // distinguishing feature vs house.pop is the half-time snare flip: the
  // backbeat lands on 3 (step 8) rather than 2-and-4, giving the
  // "k-step" bounce, with a tight hat on 8ths. BPM 100-120, swing 0.06.
  {
    id: "house.kpop",
    genre: "house",
    name: "K-Pop",
    bpm: [100, 120],
    swing: 0.06,
    activePads: [0, 6, 8, 10, 14],
    patterns: [
      {
        0: "g0K4K8KcK",
        6: "g2E6EaEeE",
        8: "g0s2q4s6q8saqcseq",
        10: "g6q",
        14: "gek",
      },
      {
        0: "g0K4K8KcK",
        6: "g1E5E9EdE",
        8: "g0q2s4q6s8qascqes",
        10: "gfq",
        14: "gek",
      },
      {
        // Half-time chorus — snare only on 3, kick drops the last 8th
        0: "g0K4K8K",
        6: "g2D6D",
        8: "g0q4q8qcq",
        10: "g",
        14: "g0kek",
      },
      {
        // Bridge — clap and hat only, no kick
        0: "g",
        6: "g2E6EaEeE",
        8: "g0s2q4s6q8saqcseq",
        10: "gfq",
        14: "gek",
      },
    ],
  },

  // ── Reggaeton (Wave 5) — J Balvin / Ozuna / Rosalía lane ──────────────
  // The Latin-urban reggaeton pocket (J Balvin 'Mi Gente' / Rosalía
  // 'MALAMENTE'). The signature is the snare on 3 plus the offbeat open hat
  // that answers it (the "dembow-adjacent" tick), with a kick on 1, the
  // 'and' of 2, and 4. Bad Bunny's existing entry covers the harder perreo
  // side; this is the brighter dancefloor-pop reggaeton. BPM 88-100,
  // swing 0.10.

  // ── Reggae (one-drop) ──────────────────────────────────────────────────
  // The roots/dub one-drop family (Bob Marley / Peter Tosh / Steel Pulse /
  // Lee Perry). The defining trait: the kick and snare land TOGETHER on beat
  // 3 (the "one drop") while beat 1 is EMPTY - the space where a four-floor
  // kick would be. Skank hats on the offbeats (the upstroke), rim tick for
  // the nyabinghi texture. BPM 60-90 (research target; dub can halve it -
  // the pocket reads half-time at 70-75). swing 0.12.
  {
    id: "house.reggae",
    genre: "house",
    name: "Reggae",
    bpm: [60, 90],
    swing: 0.12,
    activePads: [0, 5, 8, 14, 10],
    patterns: [
      {
        0: "g8O",
        5: "g8K",
        8: "g1k3k5k7k9kbkdkfk",
        14: "g2d6daded",
        10: "g6nen",
      },
      {
        // The rockers - kick answers after the one-drop
        0: "g6u8Oeq",
        5: "g8Keh",
        8: "g1h3h5h7h9hbhdhfh",
        14: "g0c6b",
        10: "g6kek",
      },
      {
        // Dub - the drop sparse; only the one-drop and the echo tick
        0: "g8O",
        5: "g8J",
        8: "g3d7dbdfd",
        14: "g49c9",
        10: "geh",
      },
      {
        // Dancehall-adjacent - the one-drop with a kick pickup
        0: "g3s8O",
        5: "g1d8K",
        8: "g1j3j5j7j9jbjdjfj",
        14: "g2c6cacec",
        10: "g6lel",
      },
    ],
  },

  // ── Shoegaze (the wall-of-guitars family) ──────────────────────────────
  // My Bloody Valentine / Slowdive / Beach House lane. Shoegaze drums are
  // deliberately BURIED: a soft thudding kick, a snare that reads as wash
  // rather than crack, and a ride that carries the blurred pulse. The point
  // is the texture, not the pocket - velocities stay low and even. BPM
  // 90-130 (research target; the classic era sits around 100-115). swing
  // 0.06.
  {
    id: "house.shoegaze",
    genre: "house",
    name: "Shoegaze",
    bpm: [90, 130],
    swing: 0.06,
    activePads: [0, 4, 8, 10, 12],
    patterns: [
      {
        0: "g0y4y8ycy",
        4: "g4zcz",
        8: "g0k2h4k6h8kahckehfk",
        10: "g6jej",
        12: "g0e4e8ece",
      },
      {
        // Wash - the snare blurs into the ride
        0: "g0x4x8xcx",
        4: "g4ycy",
        8: "g0j2g4j6g8jagcjeg",
        10: "g6iei",
        12: "g0d2d4d6d8dadcded",
      },
      {
        // Crescendo - the drums fade IN, not out (the post-rock shape)
        0: "g0u4u8zcD",
        4: "g4ucD",
        8: "g0h2d4h6d8lajcnekfl",
        10: "g6eel",
        12: "g0c4c8gcj",
      },
      {
        // Breakdown - everything but the ride drops
        0: "g0v8v",
        4: "g",
        8: "g0i4i8ici",
        10: "g",
        12: "g0d2c4d6c8daccdec",
      },
    ],
  },
]);
