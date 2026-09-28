import type { MelodicPatternData } from "../types";
import type { ProductionProfile } from "../../project-model/types";
import { decodeMelodicSequences } from "./melodic-codec";

/**
 * Melodic reference patterns per genre.
 *
 * Scale degrees: 0=root, 1=2nd, 2=3rd, 3=4th, 4=5th, 5=6th, 6=7th
 * Duration: steps (1=16th, 2=8th, 4=quarter, 8=half)
 * Velocity: 0-1
 */

// ── House ──────────────────────────────────────────────

const HOUSE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Classic offbeat bass
    "7r0Bqo0B7r0Bk10B",
    // Rolling bass
    "6Q6G0BpSpK0Bk1dD",
    // Walking bass
    "7rdGqrD3wLk4dG7p",
  ]),
};

const HOUSE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Stab on offbeats
    "0B7g0Bqk0B7g0BjY",
    // Sustained pads
    "8k1Lrl1L",
  ]),
};

const HOUSE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Simple house motif
    "7f0Bqj0BjU0BdB0B",
    // Call and response
    "8p0Bqj1Ldx0B",
  ]),
};

// ── Techno ─────────────────────────────────────────────

const TECHNO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Root pulse
    "6S00006G0B6N000BpP000B7p",
    // Rumble pattern
    "7t0B6H6B0Bqo0BjZ",
    // Minimal pulse
    "8B1L7j0BrB",
  ]),
};

const TECHNO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Minimal stab
    "8p1Lrt1L",
    // Syncopated riff
    "7g0BjZ0Bql0BdB0B",
  ]),
};

const TECHNO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Minimal stab chords
    "8o1Lrp1L",
    // Industrial stab pattern
    "7f0B0Bqj1LjU0B",
  ]),
};

// ── Trap ───────────────────────────────────────────────

const TRAP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Classic 808 pattern
    "8G1L7p0BrG1L",
    // Bouncy
    "7t0B6K1aqwk41L8D",
    // Sparse
    "a-1LrG",
  ]),
};

const TRAP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Simple motif
    "7gdCry1LjY7f",
    // Arpeggio
    "6Gd0pLCopKcY7g43",
  ]),
};

const TRAP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Trap pad stabs
    "8k1Lrl1L",
    // Dark chord hits
    "7e2VjU2V",
  ]),
};

// Original, profile-level material: scale-degree sketches rather than copied
// melodies. These favor long harmonic beds and short, singable motifs over
// note-dense runs; the user's key still determines the actual pitches.
const SPACEY_RAP_MELODICS: MelodicPatternData[] = [
  {
    role: "bass",
    octaveOffset: -1,
    sequences: decodeMelodicSequences(["aU1Lrx", "8y1Lrw1L"]),
  },
  {
    role: "chord",
    octaveOffset: 1,
    sequences: decodeMelodicSequences(["az1Lrg", "8e1Lex1L"]),
  },
  {
    role: "lead",
    octaveOffset: 2,
    sequences: decodeMelodicSequences(["rq1LeF1L", "aE43"]),
  },
];

const DARK_ATMOSPHERIC_TRAP_MELODICS: MelodicPatternData[] = [
  {
    role: "bass",
    octaveOffset: -1,
    sequences: decodeMelodicSequences(["8F1L7l0BrF", "aX1Llc"]),
  },
  {
    role: "chord",
    octaveOffset: 1,
    sequences: decodeMelodicSequences(["aB1LkX", "8j1LtC"]),
  },
  {
    role: "lead",
    octaveOffset: 2,
    sequences: decodeMelodicSequences(["7d2VjT2V", "rq1L8h1L"]),
  },
];

const SPACEY_DARK_TRAP_MELODICS: MelodicPatternData[] = [
  {
    role: "bass",
    octaveOffset: -1,
    sequences: decodeMelodicSequences(["aY1LrC", "8D1Llc1L"]),
  },
  {
    role: "chord",
    octaveOffset: 1,
    sequences: decodeMelodicSequences(["aA1Lrh", "8h1Lnf"]),
  },
  {
    role: "lead",
    octaveOffset: 2,
    sequences: decodeMelodicSequences(["rr43eG", "8l1Ll01L"]),
  },
];

// ── Ambient ────────────────────────────────────────────

const AMBIENT_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Drone
    "aE43",
    // Slow movement
    "aItJ",
  ]),
};

const AMBIENT_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Sparse melody
    "8g1Lri1LeB1L",
    // Arpeggiated
    "730Bq60Bdq0BDY1L",
  ]),
};

const AMBIENT_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Evolving pad drones
    "axty",
    // Sparse chord tones
    "891Leu1Lrd1L",
  ]),
};

// ── Drum & bass ──────────────────────────────────────────
// Reese pressure under chopped-break energy: long root sustains with octave
// motion (bass), airy liquid pads + minimal stabs (chords), rolling motifs
// with space to breathe (lead). Degrees are scale-relative (minor home).

const DNB_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Reese roller
    "8D0B7p0BrB0B",
    // Octave stepper
    "7r7jquqlwOqkk1dD",
  ]),
};

const DNB_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Liquid pads
    "8k1Lk-1L",
    // Minimal stabs
    "0BpL000Bd0001L7a0B",
  ]),
};

const DNB_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Roller motif
    "pLw5pLCo0BwGpG00dB0B0B",
    // Sparse call
    "Eb1Lqfdx1L",
  ]),
};

// ── Melodic dialects (per-style pilots) ───────────────
// Amapiano: the LOG DRUM is melodic content, not a drum — syncopated short
// bass notes answering the kick, airy chord stabs, gentle piano lead.
const AMAPIANO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Core log-drum answer — syncopated short notes between the kicks
    "7t006K0Bk40B6QpM0BwL0B",
    // Log roll — the short-note tumble
    "7t0BpPpL0B7p00w70Bk100",
    // Deep walk — root patience, syncopated lift
    "8D0Bk10B7r00pM0BwL",
  ]),
};

const AMAPIANO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Airy stabs — sparse, soft, floating above the log drum
    "1L8k1LxI",
    "1Ll21L8g",
  ]),
};

const AMAPIANO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Gentle piano phrase — patient, jazzy movement
    "8p0Bdx0Brt0B",
    "xf00rp1LeH",
  ]),
};

// Dembow: the chop bass — root-heavy staccato answering the rim chop
const DEMBOW_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["82006N0Bqo0B80006K0Bqo", "7t0BwL006N0Bqo0B7r00"]),
};

const DEMBOW_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Bright stabs answering the chop
    "1a6H1L1apL1L",
    "1aw6436G1a",
  ]),
};

const DEMBOW_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Syncopated tropical-urban hook
    "7g00d00BqV0BdB1a",
    "wH0Bqj0BdB43",
  ]),
};

// Metal: the gallop — driving root-heavy 8ths, dark sustained power chords
const METAL_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Gallop — root drive with fifth jumps
    "7w7rqy7r7w7rqyk7",
    // Chug walk — root 8ths with a dark lift
    "7w7r7twR7w7rD9qw",
  ]),
};

const METAL_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Dark sustained power — two heavy hits per bar
    "aV0B9J",
    "9L0BAj",
  ]),
};

const METAL_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Dark minor run — the riff line
    "7p7jqrk17pD3qodD",
    // Sparse menace — long tones, dark intervals
    "8z0Blb0BrB",
  ]),
};

// ── Registry ───────────────────────────────────────────

export const MELODIC_BY_GENRE: Record<string, MelodicPatternData[]> = {
  house: [HOUSE_BASS, HOUSE_CHORD, HOUSE_LEAD],
  techno: [TECHNO_BASS, TECHNO_CHORD, TECHNO_LEAD],
  trap: [TRAP_BASS, TRAP_CHORD, TRAP_LEAD],
  ambient: [AMBIENT_BASS, AMBIENT_CHORD, AMBIENT_LEAD],
  dnb: [DNB_BASS, DNB_CHORD, DNB_LEAD],
};

/**
 * Per-style melodic dialects (Wave: melodic dialects) — keyed by the
 * `${genre}.${style}` groove id, selected between the production profile
 * and the genre fallback. A dialect REPLACES the genre array: the dialect
 * knows all three roles best. Aliases share arrays (dembowdom rides the
 * dembow chop; thrash/metalcore ride the metal gallop).
 */
// ── Melodic dialects (wave 2) ─────────────────────────

// Ghettotech: the banging 808 bounce — syncopated root stabs with Miami
// bass pickups, short and hooky
const GHETTOTECH_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["7w0B7p0B7t00wd0B7r0B", "7w00pS0B7t0BwR006Q0B"]),
};

const GHETTOTECH_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Sparse chant stab
    "8t2Vl80B",
  ]),
};

const GHETTOTECH_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Short electro licks — hooky, chromatic-feeling edges
    "7j0Bql0BjZ1L7g0B",
  ]),
};

// Baile funk: the tamborzão — punchy bass riding the syncopation, minimal
// melody, call-and-response
const BAILE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["6U0B6Q0B6S00pP006U0B6Q0Bwa00"]),
};

const BAILE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Minimal chant stab — one shout per bar
    "7j5dql0B",
  ]),
};

const BAILE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Call-and-response short phrase
    "7j00d12kql2k",
  ]),
};

// Footwork: jumpy polyrhythm — off-grid short notes with octave jumps,
// repeating 2-3 note motifs
const FOOTWORK_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["6U0BpP0B7p00wa0B7r0BpM00"]),
};

const FOOTWORK_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Sparse — the battle is between bass and drums
    "438p1L",
  ]),
};

const FOOTWORK_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Manic repeated motif — 2-3 notes, machine-repeated
    "6KpM6KpM1L6KpM6K2k",
  ]),
};

// Jungle: THE chop bass — long deep sub notes under the fast break; the
// contrast between frantic drums and patient sub IS the genre
const JUNGLE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["a-0BrG0B", "9Q0Blj0Bqu"]),
};

const JUNGLE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Sparse reggae-ish skank stabs on the offbeats
    "0B6G2k0BpL2k",
  ]),
};

const JUNGLE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Ragga-ish stabs — sparse, punchy, patient
    "7j2Vql1LjZ",
  ]),
};

// Slap house: the slap — plucky short notes with fifth pops, bouncy and
// minimal; chords stay out of the way
const SLAPHOUSE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["6X006K00pZ006N006U00wa006U00pP00"]),
};

const SLAPHOUSE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Long soft pad — the slap carries the identity
    "aA1LxF",
  ]),
};

const SLAPHOUSE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Sparse hook — patient, roomy
    "8p1Lrt1L",
  ]),
};

// ── DnB dialects (depth wave 2026-09-27) ─────────────────
// Before this wave ALL 8+ dnb sub-genres shared one bass/chord/lead array, so
// a neuro request and a liquid request produced the same melodic material.
// The audit flagged this as the real blocker (dnb had 0 augmented rows and a
// single melodic vocabulary). Each dialect here knows its lane:
//
//   techstep  — clipped staccato root pulses, no glide warmth, metallic space
//   ragga     — reggae skank: offbeat chord stabs, call-and-response lead
//   sambass   — bossa-tinged rolling bass, long airy pads, melodic lead
//   halftime  — huge sparse sub notes, the bass IS the hook
//   crossbreed— distorted 16th root churn, industrial lead stabs
//   minimal   — one-note autonomic sub, near-silent chords, micro lead

const TECHSTEP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Clipped staccato root — the techstep signature is a SHORT note
    "6X006Q1ajC00jv1a7t0B",
    // The step-down answer
    "7w0BCF00wi00qu0B7t",
  ]),
};

const TECHSTEP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Metallic stab on the 1 — reverb does the rest
    "7e2V43",
    // Two stabs, second a fourth up
    "1L6B1apK3u",
  ]),
};

const TECHSTEP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Sci-fi blip motif — short, quantised, cold
    "6F1ajj1apG3u",
    // Descending scanner
    "CZwCqfdt43",
  ]),
};

const RAGGA_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // The reggae drop — root on the beat, rest OFF the beat, fifth pickup
    "7t0BpP007r1L",
    // Walking dub line
    "7t00jv0BwR0Bqr",
  ]),
};

const RAGGA_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // The skank — short offbeat stabs, the reggae organ/chop answer
    "0B6H1a6G1apM1a",
    // Two-chord skank turnaround
    "1Ljo1aw61a",
  ]),
};

const RAGGA_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Call-and-response horn-ish phrase
    "7jd26H1Lqo2V",
    // Patient dub call
    "xS0Bqk7g2V",
  ]),
};

const SAMBASS_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Bossa-tinged roller — root-fifth-octave with a syncopated push
    "7t00pV0B7r0BwR0B",
    // Gentle walking answer
    "8DquwRqrdJ8B",
  ]),
};

const SAMBASS_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Long airy pads — the melodic sample leads, chords breathe
    "aAng",
  ]),
};

const SAMBASS_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Melodic hook — the Marky/Bukem school lead
    "qkw5pKdC8p0BdBqk",
    // Sparse sung-feel call
    "Ebqj0Bdx9y",
  ]),
};

const HALFTIME_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Huge sparse sub — the bass is the hook in halftime
    "9Q0By11L",
    // The drop-and-return
    "8G1LlleY",
  ]),
};

const HALFTIME_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // One vast pad wash
    "cg",
    // Slow two-chord drift
    "ayzZ",
  ]),
};

const HALFTIME_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Distant, patient motif — room between every note
    "7a2Vqf2V",
    // Rising sigh
    "eHrt43",
  ]),
};

const CROSSBREED_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // 16th root churn — relentless
    "6X6Q6U6N6X6QjA6N7t0B7t",
    // Octave hammer
    "7wqy7wwT7tk98G",
  ]),
};

const CROSSBREED_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Industrial hammer stabs
    "6K006G2kwa3u",
  ]),
};

const CROSSBREED_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Screaming siren call
    "D6w7Cu1Lql2V",
  ]),
};

const MINIMAL_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // One-note autonomic sub — the space is the style
    "aX43",
    // Two-note movement, barely
    "9M0Bg40B",
  ]),
};

const MINIMAL_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Near-silent pad — a whisper
    "ca",
  ]),
};

const MINIMAL_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Micro motif — one gesture per phrase
    "2VpC4E",
    // Textural blip pair
    "43cR00pC2k",
  ]),
};

// ── Melodic dialects (wave 3 — the octave bounce, the 808 slides, the 303) ──

// Disco: THE octave bounce — root and octave alternating on every beat
const DISCO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["7t0Bqu0B7t0Bquk1", "6UpP0B7rwL0BqrdD"]),
};

const DISCO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // String stabs on the offbeats
    "0B7f0Bqj",
  ]),
};

const DISCO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Sunny hook — moves in comfortable steps
    "qk0BwGqj0Bdx1L",
  ]),
};

// Synthpop: the driving 8th synth bass — relentless and even
const SYNTHPOP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["7r7m7r7mwRwLqrk1"]),
};

const SYNTHPOP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Gated stabs — the 80s snapshot chord
    "7f0B7f0B",
  ]),
};

const SYNTHPOP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Analog hook with a hook-y fall
    "qkdB8p0Bdxrt",
  ]),
};

// Progressive house: the long patient bass — half-bar notes, deep and even
const PROGRESSIVE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["aTnv", "9J0BtS"]),
};

const PROGRESSIVE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Emotive pad swells
    "aEni",
  ]),
};

const PROGRESSIVE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // The long hypnotic phrase
    "8oeHrt1L",
  ]),
};

// UK garage: the 2-step syncopated sub — skips the grid, answers late
const UKG_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["7r00qo1a7p00j-1a"]),
};

const UKG_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Warm shuttling chords — the garage wipe
    "0B7e0BwC",
  ]),
};

const UKG_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Vocal-ishlick — syncopated, singable
    "qV00dB0B8p1L",
  ]),
};

// Jersey club: the triple-kick answer — bass punctuates between the kicks
const JERSEY_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["7t0B6K007r0BpP007t0B"]),
};

const JERSEY_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // The club stab — short, chopped
    "1a6H43pL1a",
  ]),
};

const JERSEY_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Chopped vocal-feel hook
    "6H00pL2kdB2V",
  ]),
};

// Trap classic: the 808 slide — long gliding root notes, sparse and deep
const TRAP808_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9Q0BsS0B", "8G0Blj0B8D"]),
};

const TRAP808_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Dark sparse bell-ish pad
    "2V8k2V",
  ]),
};

const TRAP808_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Dark bell hook — sparse, ringing
    "7Q1aqU1aeL",
  ]),
};

// UK drill: the sliding 808 answer — the root slides up a half-step feel
const DRILL_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9f007p0BsS0B", "8G0By10BrI0B"]),
};

const DRILL_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Dark sliding pad
    "1L9q0Bri",
  ]),
};

const DRILL_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Dark sliding hook
    "7Q00rt0Bxb1a",
  ]),
};

// Acid techno: the 303 — accented 16ths with octave jumps
const ACID_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["6X6G6KpX6G6U00pP6H6Uwd006KpX006G"]),
};

const ACID_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Sparse stabs — the 303 carries the identity
    "437a2V",
  ]),
};

const ACID_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Screaming 303 line up top
    "6NpM6Kw71L6KpM2V",
  ]),
};

// Bass house: the wobble stab — syncopated bass stabs between the kicks
const BASSHOUSE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["7w0B6QpS7t0Bwd007t0B"]),
};

const BASSHOUSE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["1L7e2Vqf0B"]),
};

const BASSHOUSE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Vocal-chop style hook
    "7g0Bqk1LwH1L",
  ]),
};

// Country pop: the boom-chicka — root and fifth alternating, honest and warm
const COUNTRY_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["7r0Bqo0B7r0Bqo0B", "7rql7pwI7pqljZ7m"]),
};

const COUNTRY_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Warm acoustic strum feel
    "8o1Lrp1L",
  ]),
};

const COUNTRY_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Pentatonic twinkle — the country lead language
    "qkwGqjdx1L8o",
  ]),
};

// Kuduro: the carnival punch — percussive root stabs, fast and dry
const KUDURO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["6X007r0B6U1apS007r0B"]),
};

const KUDURO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Carnival whistle-feel stab
    "2V6G2kqj0B",
  ]),
};

const KUDURO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Half-time rap-feel phrase over the frantic floor
    "8q0Bru0Bl6",
  ]),
};

// Tropical: the soft round beach bass — warm, rounded, patient
const TROPICAL_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["7-008w1Lry", "8z0BxS0Bry"]),
};

const TROPICAL_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Steel-pan flavored bright stabs
    "0B7e1Lqf2V",
  ]),
};

const TROPICAL_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // The pan-flute melody — pentatonic sunshine
    "qVea8p0BeL",
  ]),
};

// Liquid dnb: the long warm rolling — soulful, patient under the fast break
const LIQUID_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9L0BrB1L", "8B0Bmo0BwL"]),
};

const LIQUID_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Soulful Rhodes-feel pads
    "9u0Bsv0B",
  ]),
};

const LIQUID_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Liquid soul line — smooth and singing
    "qV00dB8p0Brt",
  ]),
};

// Tech house: the wobbly stab — off-grid bass stabs with groove
const TECHHOUSE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["7t006N0B7t0BpS006Q1a"]),
};

const TECHHOUSE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["1L7a430B"]),
};

const TECHHOUSE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Sparse funk licks
    "1L7f0Bqj2V",
  ]),
};

// ── Melodic dialects (dnb depth wave 2 — the remaining seven voices) ──────

// Two-step: the snap — bass skips the grid with the break, short and tight
const TWOSTEP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["7t0000qo0B7r00jp0Bqo0B"]),
};

const TWOSTEP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["1L7a1L0Bwy0B"]),
};

const TWOSTEP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences(["qV00dx0B8o1L"]),
};

// Roller: the smooth roll — even 8th root drive, hypnotic, never busy
const ROLLER_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["7r7j7p7jqrql7p7j", "7r7jk17j7r7jwLqo"]),
};

const ROLLER_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Pad swells — long, dark, supportive
    "aA0Bm5",
  ]),
};

const ROLLER_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Hypnotic minor motif — repeats with small changes
    "7e0BjUqf0BjU0B7e",
  ]),
};

// Amen chop: the bass follows the chop — syncopated with ghost movement
const AMENCHOP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["82007m0Bqu006K0BwO0B"]),
};

const AMENCHOP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Ragga stab feel
    "1a6G2Vqj1L",
  ]),
};

const AMENCHOP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Ragga toast-feel phrase
    "7g006G0BqV0BjY1a",
  ]),
};

// Neuro: the reese — long dark growling notes, semitone-adjacent tension
const NEURO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9Q0BFA0B", "8G0By10BEq0B"]),
};

const NEURO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Dark techy stabs, mechanical
    "1a6G2V1aw50B",
  ]),
};

const NEURO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Techy growl line — mechanical, angular
    "7j0BD20B7j0BwH0B",
  ]),
};

// Jump-up: the wobble stab — bouncy punchy stabs built for the skip
const JUMPUP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["7w0B6Q00qy0B7t0B7p0B"]),
};

const JUMPUP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["2V7f43"]),
};

const JUMPUP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // The bouncywarrior hook — short stabs, big spaces
    "7j1Lql1L7j0B",
  ]),
};

// Dancefloor: the anthemic drive — wide jumps, big and even
const DANCEFLOOR_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["7t7mqwqo7t7mwRwL"]),
};

const DANCEFLOOR_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Big anthemic swells
    "aI0Bsz",
  ]),
};

const DANCEFLOOR_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // The festival hook — wide, singable, confident
    "rv0BeM0B8q0B",
  ]),
};

// ── Melodic dialects (gabber — the kick carries the low end) ──────────────

// Gabber bass: dark and sparse — the distorted kick owns the low register,
// the bass only anchors the half-bar. Screechy hoover lead is the genre voice.
const GABBER_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["aT0B9G", "aT0BFq"]),
};

const GABBER_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Dark minor stabs on the half-bar, menace over the stomp
    "1L7e2V7a0B",
  ]),
};

const GABBER_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // The hoover screech — short aggressive phrases with a descending tail
    "6S6QD90BDc43",
    "k7jvd51L7m2V",
  ]),
};

export const MELODIC_BY_STYLE: Record<string, MelodicPatternData[]> = {
  "house.amapiano": [AMAPIANO_BASS, AMAPIANO_CHORD, AMAPIANO_LEAD],
  "house.dembow": [DEMBOW_BASS, DEMBOW_CHORD, DEMBOW_LEAD],
  "house.dembowdom": [DEMBOW_BASS, DEMBOW_CHORD, DEMBOW_LEAD],
  "house.metal": [METAL_BASS, METAL_CHORD, METAL_LEAD],
  "house.thrash": [METAL_BASS, METAL_CHORD, METAL_LEAD],
  "house.metalcore": [METAL_BASS, METAL_CHORD, METAL_LEAD],
  "house.ghettotech": [GHETTOTECH_BASS, GHETTOTECH_CHORD, GHETTOTECH_LEAD],
  "house.baile": [BAILE_BASS, BAILE_CHORD, BAILE_LEAD],
  "house.footwork": [FOOTWORK_BASS, FOOTWORK_CHORD, FOOTWORK_LEAD],
  "dnb.jungle": [JUNGLE_BASS, JUNGLE_CHORD, JUNGLE_LEAD],
  // DnB depth wave (2026-09-27): each sub-genre gets its own melodic voice.
  "dnb.techstep": [TECHSTEP_BASS, TECHSTEP_CHORD, TECHSTEP_LEAD],
  "dnb.ragga": [RAGGA_BASS, RAGGA_CHORD, RAGGA_LEAD],
  "dnb.sambass": [SAMBASS_BASS, SAMBASS_CHORD, SAMBASS_LEAD],
  "dnb.halftime": [HALFTIME_BASS, HALFTIME_CHORD, HALFTIME_LEAD],
  "dnb.crossbreed": [CROSSBREED_BASS, CROSSBREED_CHORD, CROSSBREED_LEAD],
  "dnb.minimal": [MINIMAL_BASS, MINIMAL_CHORD, MINIMAL_LEAD],
  // DnB depth wave 2 — the remaining seven family voices
  "dnb.twostep": [TWOSTEP_BASS, TWOSTEP_CHORD, TWOSTEP_LEAD],
  "dnb.roller": [ROLLER_BASS, ROLLER_CHORD, ROLLER_LEAD],
  "dnb.amen": [AMENCHOP_BASS, AMENCHOP_CHORD, AMENCHOP_LEAD],
  "dnb.neuro": [NEURO_BASS, NEURO_CHORD, NEURO_LEAD],
  "dnb.jumpup": [JUMPUP_BASS, JUMPUP_CHORD, JUMPUP_LEAD],
  "dnb.dancefloor": [DANCEFLOOR_BASS, DANCEFLOOR_CHORD, DANCEFLOOR_LEAD],
  // Gabber — the stomp kick owns the low end; bass anchors, lead screeches
  "techno.gabber": [GABBER_BASS, GABBER_CHORD, GABBER_LEAD],
  "house.slaphouse": [SLAPHOUSE_BASS, SLAPHOUSE_CHORD, SLAPHOUSE_LEAD],
  // Wave 3 — 14 lanes with a bass signature (2026-09-28)
  "house.disco": [DISCO_BASS, DISCO_CHORD, DISCO_LEAD],
  "house.synthpop": [SYNTHPOP_BASS, SYNTHPOP_CHORD, SYNTHPOP_LEAD],
  "house.progressive": [PROGRESSIVE_BASS, PROGRESSIVE_CHORD, PROGRESSIVE_LEAD],
  "house.ukg": [UKG_BASS, UKG_CHORD, UKG_LEAD],
  "jersey.club": [JERSEY_BASS, JERSEY_CHORD, JERSEY_LEAD],
  "trap.classic": [TRAP808_BASS, TRAP808_CHORD, TRAP808_LEAD],
  "drill.uk": [DRILL_BASS, DRILL_CHORD, DRILL_LEAD],
  "techno.acid": [ACID_BASS, ACID_CHORD, ACID_LEAD],
  "house.basshouse": [BASSHOUSE_BASS, BASSHOUSE_CHORD, BASSHOUSE_LEAD],
  "house.countrypop": [COUNTRY_BASS, COUNTRY_CHORD, COUNTRY_LEAD],
  "house.kuduro": [KUDURO_BASS, KUDURO_CHORD, KUDURO_LEAD],
  "house.tropical": [TROPICAL_BASS, TROPICAL_CHORD, TROPICAL_LEAD],
  "dnb.liquid": [LIQUID_BASS, LIQUID_CHORD, LIQUID_LEAD],
  // "tech house" prompts route genre=house — the dialect rides that key
  // (the groove library keeps hybrid.techhouse for its own routing).
  "house.techhouse": [TECHHOUSE_BASS, TECHHOUSE_CHORD, TECHHOUSE_LEAD],
};

export const MELODIC_BY_PROFILE: Record<ProductionProfile, MelodicPatternData[]> = {
  "spacey-melodic-rap": SPACEY_RAP_MELODICS,
  "dark-atmospheric-trap": DARK_ATMOSPHERIC_TRAP_MELODICS,
  "spacey-dark-trap": SPACEY_DARK_TRAP_MELODICS,
};
