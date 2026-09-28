import type { GrooveData } from "../types";
import { decodeGrooves } from "./compact";

/**
 * Chiptune grooves — the sound-chip tradition promoted to a first-class genre.
 * The defining quality: the whole arrangement comes out of a fixed voice
 * budget (NES 2A03: 2 pulse + triangle + noise; Game Boy: 2 pulse + wave +
 * noise), so melodies are ARPEGGIATED (one channel faking chords by cycling
 * pitches every tick) and percussion is NOISE-CHANNEL work — sparse, punchy,
 * never a sampled kit. Tempo follows the tracker/counter conventions.
 *
 * Schools (the accepted scene split):
 *   nintendo — the NES/Famicom era (Koji Kondo / Mega Man / Castlevania):
 *              march-like kick, snappy noise snare, fast 16th hat, blip
 *              accents. The "action platformer" pocket, 100–150.
 *   gameboy  — the LSDj / Game Boy scene (Chipzel / 4mat / Jeroen Tel):
 *              harder-clipped pulses, breakbeat-leaning noise drums,
 *              120–160.
 *   modern   — the modern chip band (Anamanaguchi / Sabrepulse / Dan
 *              Terminus): live-ish drums under NES leads, 140–180.
 *   ballad   — the town-theme / ending-theme pocket (sad chip, slow
 *              arpeggio): almost no percussion, 70–100.
 *   boss     — the boss-battle / VGM-metal corner: driving double-kick
 *              feel, aggressive noise fills, 150–185.
 *   tracker  — the demoscene tracker lineage (FastTracker / Impulse
 *              Tracker): dense arpeggio churn over a four-floor-ish pulse,
 *              130–170.
 *
 * Pad indices (default kit): 0 kick, 1 kick punch, 3 rim, 4 snare, 5 snare
 * tight, 6 clap, 7 shaker, 8 hat closed, 9 hat soft, 10 hat open, 11 ride,
 * 12 tom low, 13 tom high, 14 tick, 15 blip.
 */
export const CHIPTUNE_GROOVES: GrooveData[] = decodeGrooves([
  // ── Nintendo (the NES era) ──────────────────────────────
  {
    id: "chiptune.nintendo",
    genre: "chiptune",
    name: "Nintendo",
    bpm: [100, 150],
    swing: 0,
    activePads: [0, 4, 8, 15, 5],
    patterns: [
      {
        // The action-platformer march: kick 1+3, noise snare 2+4, 16th hat.
        0: "g0K8H",
        4: "g4HcH",
        8: "g0n1k2n3k4n5k6n7k8n9kanbkcndkenfk",
        15: "g2k6kakek",
        5: "g5ddd",
      },
      {
        // The cave-theme pattern: sparser, blip answers where the snare sits.
        0: "g0K8H",
        4: "g4E",
        8: "g0k1h2k3h4k5h6k7h8k9hakbhckdhekfh",
        15: "g0k4k8kck",
        5: "g7dfd",
      },
      {
        // The athletic theme: continuous 16th hat, kick push on the "and".
        0: "g0K3s8Hcs",
        4: "g4HcHeq",
        8: "g0q1n2q3n4q5n6q7n8q9naqbncqdneqfn",
        15: "g1k3k5k7k9kbkdkfk",
      },
      {
        // The water-temple variant: half-time backbeat, deeper blips.
        0: "g0J8E",
        4: "g8F",
        8: "g0k1h2k3h4k5h6k7h8k9hakbhckdhekfh",
        15: "g3j7jbjfj",
      },
    ],
  },
  // ── Game Boy (the LSDj scene) ──────────────────────────
  {
    id: "chiptune.gameboy",
    genre: "chiptune",
    name: "Game Boy",
    bpm: [120, 160],
    swing: 0.02,
    activePads: [0, 1, 5, 8, 15],
    patterns: [
      {
        // LSDj pocket: clipped punch kick, tight snare, dense hat chatter.
        0: "g0O4K8K",
        1: "g3qaq",
        5: "g4KcK",
        8: "g0q1n2q3n4q5n6q7n8q9naqbncqdneqfn",
        15: "g3l7lblfl",
      },
      {
        // The Chipzel breakbeat lean: displaced kick, ghost-snare pressure.
        0: "g0O6saH",
        1: "g3q4H9neq",
        5: "g1h3d5H7d9hbdcHed",
        8: "g0q2q4q6q8qaqcqeq",
        15: "g6kek",
      },
      {
        // The 4mat/4-channel restraint: one voice at a time.
        0: "g0L8J",
        1: "g3pcp",
        5: "g4J",
        8: "g0n1k2n3k4n5k6n7k8n9kanbkcndkenfk",
        15: "g0k6k8kek",
      },
    ],
  },
  // ── Modern chip ─────────────────────────────────────────
  {
    id: "chiptune.chipband",
    genre: "chiptune",
    name: "Modern Chip",
    bpm: [140, 180],
    swing: 0.03,
    activePads: [0, 1, 4, 8, 3, 15],
    patterns: [
      {
        // Anamanaguchi drive: rock backbeat under the NES lead.
        0: "g0O4O8OcO",
        1: "g6qeq",
        4: "g4LcL",
        8: "g0s1q2s3q4s5q6s7q8s9qasbqcsdqesfq",
        3: "g0k6k8kek",
        15: "g2l7lalfl",
      },
      {
        // The Sabrepulse high-tempo variant: 8th kick push.
        0: "g0O3s4O8ObscO",
        4: "g4KcK",
        8: "g0s1q2s3q4s5q6s7q8s9qasbqcsdqesfq",
        3: "g3j7jbjfj",
        15: "g0k2k4k6k8kakckek",
      },
      {
        // The verse pocket: half-time backbeat with blip melody space.
        0: "g0O6s8L",
        4: "g8L",
        8: "g0q2q4q6q8qaqcqeq",
        3: "g0l8l",
        15: "g3k6kbkek",
      },
    ],
  },
  // ── Ballad (town / ending themes) ───────────────────────
  {
    id: "chiptune.ballad",
    genre: "chiptune",
    name: "Chip Ballad",
    bpm: [70, 100],
    swing: 0.06,
    activePads: [3, 8, 15, 11],
    patterns: [
      {
        // Almost no percussion — the arpeggio is the arrangement.
        3: "g0h6d8hed",
        8: "g1a5a9ada",
        15: "g0d8d",
        11: "g3878b8f8",
      },
      {
        // The ending-credits variant: soft ride pulse only.
        3: "g0e8e",
        8: "g3979b9f9",
        15: "g2c6cacec",
        11: "g0727476787a7c7e7",
      },
      {
        // The snow-town variant: a slow heartbeat kick enters late.
        3: "g0d6c8dec",
        8: "g185898d8",
        15: "g0b",
        11: "g3777b7f7",
      },
    ],
  },
  // ── Boss battle ─────────────────────────────────────────
  {
    id: "chiptune.boss",
    genre: "chiptune",
    name: "Boss Battle",
    bpm: [150, 185],
    swing: 0,
    activePads: [0, 1, 4, 8, 12, 13],
    patterns: [
      {
        // Driving double-kick feel under the noise snare backbeat.
        0: "g0R4O8RcO",
        1: "g3u7ubufu",
        4: "g4OcO",
        8: "g0u1s2u3s4u5s6u7s8u9saubscudseufs",
        12: "g6qeq",
        13: "g1q5q9qdq",
      },
      {
        // The final-boss fill: tom cascade into the turn.
        0: "g0R4O8RcO",
        1: "g3u7ubuesfu",
        4: "g4OcOes",
        8: "g0u1s2u3s4u5s6u7s8u9saubscsdsesfs",
        12: "g2q5q9qdqes",
        13: "g0q3q6q7s8s9sasbscsdsesfs",
      },
      {
        // The chase variant: relentless 16th noise.
        0: "g0R4O8RcO",
        1: "g3s7sbsfs",
        4: "g4OcO",
        8: "g0u1u2u3u4u5u6u7u8u9uaubucudueufu",
        12: "g6qeq",
        13: "g2q6qaqeq",
      },
    ],
  },
  // ── Tracker (demoscene) ─────────────────────────────────
  {
    id: "chiptune.tracker",
    genre: "chiptune",
    name: "Tracker",
    bpm: [130, 170],
    swing: 0.01,
    activePads: [0, 1, 4, 5, 8, 15],
    patterns: [
      {
        // Four-floor pulse under the arpeggio churn.
        0: "g0L4L8LcL",
        1: "g3q7qbqfq",
        4: "g4JcJ",
        5: "g1e5e9ede",
        8: "g0q1n2q3n4q5n6q7n8q9naqbncqdneqfn",
        15: "g2k6kakekfn",
      },
      {
        // The FastTracker pattern-break idiom: kick drops out, hat carries.
        0: "g0L4L8L",
        1: "g3qbq",
        4: "g4JcJ",
        5: "g0d2d4d6d8dadcded",
        8: "g0q1n2q3n4q5n6q7n8q9naqbncqdneqfn",
        15: "g0l4l8lcl",
      },
      {
        // The BPM-ramp verse: sparse anchors, room for pitch slides.
        0: "g0L8L",
        1: "g3pcp",
        4: "g4J",
        5: "g1d6d9ddd",
        8: "g0p2p4p6p8papcpep",
        15: "g3k7kbkfk",
      },
    ],
  },
]);
