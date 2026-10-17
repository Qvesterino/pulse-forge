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
    "9-0KzK0K9-0Kr60K",
    // Rolling bass
    "9e910Kz3yR0Kr6ir",
    // Walking bass
    "9-iuzNQXImr9iu9Y",
  ]),
};

const HOUSE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Stab on offbeats
    "0K9P0KzD0K9P0KqX",
    // Sustained pads
    "b32aAS2a",
  ]),
};

const HOUSE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Simple house motif
    "9L0Kzz0KqT0Kij0K",
    // Call and response
    "bb0Kzz2aif0K",
  ]),
};

// ── Techno ─────────────────────────────────────────────

const TECHNO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Root pulse
    "9g0000910K9b000Kz0000K9Y",
    // Rumble pattern
    "a00K958V0KzK0Kq_",
    // Minimal pulse
    "bq2a9S0KBd",
  ]),
};

const TECHNO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Minimal stab
    "bb2aA_2a",
    // Syncopated riff
    "9P0Kq_0KzH0Kij0K",
  ]),
};

const TECHNO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Minimal stab chords
    "b72aAX2a",
    // Industrial stab pattern
    "9L0K0Kzz2aqT0K",
  ]),
};

// ── Trap ───────────────────────────────────────────────

const TRAP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Classic 808 pattern
    "bv2a9Y0KBi2a",
    // Bouncy
    "a00K981szSr92abs",
    // Sparse
    "en2aBi",
  ]),
};

const TRAP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Simple motif
    "9PinBa2aqX9L",
    // Arpeggio
    "91hByVQ1yRhx9P52",
  ]),
};

const TRAP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Trap pad stabs
    "b32aAS2a",
    // Dark chord hits
    "9H3CqT3C",
  ]),
};

// Original, profile-level material: scale-degree sketches rather than copied
// melodies. These favor long harmonic beds and short, singable motifs over
// note-dense runs; the user's key still determines the actual pitches.
const SPACEY_RAP_MELODICS: MelodicPatternData[] = [
  {
    role: "bass",
    octaveOffset: -1,
    sequences: decodeMelodicSequences(["eh2aB9", "bn2aB82a"]),
  },
  {
    role: "chord",
    octaveOffset: 1,
    sequences: decodeMelodicSequences(["dR2aAL", "aX2aju2a"]),
  },
  {
    role: "lead",
    octaveOffset: 2,
    sequences: decodeMelodicSequences(["AY2ajE2a", "dX52"]),
  },
];

const DARK_ATMOSPHERIC_TRAP_MELODICS: MelodicPatternData[] = [
  {
    role: "bass",
    octaveOffset: -1,
    sequences: decodeMelodicSequences(["bu2a9U0KBh", "ek2asz"]),
  },
  {
    role: "chord",
    octaveOffset: 1,
    sequences: decodeMelodicSequences(["dT2as9", "b12aDF"]),
  },
  {
    role: "lead",
    octaveOffset: 2,
    sequences: decodeMelodicSequences(["9G3CqR3C", "AY2aa_2a"]),
  },
];

const SPACEY_DARK_TRAP_MELODICS: MelodicPatternData[] = [
  {
    role: "bass",
    octaveOffset: -1,
    sequences: decodeMelodicSequences(["el2aBe", "bs2asz2a"]),
  },
  {
    role: "chord",
    octaveOffset: 1,
    sequences: decodeMelodicSequences(["dS2aAM", "a_2av1"]),
  },
  {
    role: "lead",
    octaveOffset: 2,
    sequences: decodeMelodicSequences(["AZ52jF", "b42asg2a"]),
  },
];

// ── Ambient ────────────────────────────────────────────

const AMBIENT_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Drone
    "dX52",
    // Slow movement
    "d_DP",
  ]),
};

const AMBIENT_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Sparse melody
    "a-2aAN2ajz2a",
    // Arpeggiated
    "9t0Kzj0Ki50KRZ2a",
  ]),
};

const AMBIENT_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Evolving pad drones
    "dNDB",
    // Sparse chord tones
    "aR2ajr2aAI2a",
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
    "bs0K9Y0KBd0K",
    // Octave stepper
    "9-9SzQzHIpzDr6ir",
  ]),
};

const DNB_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Liquid pads
    "b32ase2a",
    // Minimal stabs
    "0KyV000KhB002a9D0K",
  ]),
};

const DNB_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Roller motif
    "yVHtyVQ10KIbyN00ij0K0K",
    // Sparse call
    "Sf2azvif2a",
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
    "a000980Kr90K9eyZ0KIm0K",
    // Log roll — the short-note tumble
    "a00Kz0yV0K9Y00HB0Kr600",
    // Deep walk — root patience, syncopated lift
    "bs0Kr60K9-00yZ0KIm",
  ]),
};

const AMAPIANO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Airy stabs — sparse, soft, floating above the log drum
    "2ab32aJu",
    "2asj2aa-",
  ]),
};

const AMAPIANO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Gentle piano phrase — patient, jazzy movement
    "bb0Kif0KA_0K",
    "IV00AX2ajH",
  ]),
};

// Dembow: the chop bass — root-heavy staccato answering the rim chop
const DEMBOW_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["aK009b0KzK0KaI00980KzK", "a00KIm009b0KzK0K9-00"]),
};

const DEMBOW_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Bright stabs answering the chop
    "1s952a1syV2a",
    "1sHx52911s",
  ]),
};

const DEMBOW_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Syncopated tropical-urban hook
    "9P00hB0KAl0Kij1s",
    "If0Kzz0Kij52",
  ]),
};

// Metal: the gallop — driving root-heavy 8ths, dark sustained power chords
const METAL_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Gallop — root drive with fifth jumps
    "a39-zU9-a39-zUrc",
    // Chug walk — root 8ths with a dark lift
    "a39-a0Isa39-R1zS",
  ]),
};

const METAL_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Dark sustained power — two heavy hits per bar
    "ei0KcQ",
    "cS0KMM",
  ]),
};

const METAL_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Dark minor run — the riff line
    "9Y9SzNr69YQXzKir",
    // Sparse menace — long tones, dark intervals
    "bo0Ksy0KBd",
  ]),
};

// ── Registry ───────────────────────────────────────────

// ── Rock + jazz genre tables (2026-10-10 — the promotion's melodic half) ──
// Authored as literal MelodicNote arrays (degree: -1 rest, 0 root, 2 third,
// 3 fourth, 4 fifth, 5 sixth, 6 seventh; duration in 16th steps) — readable
// by design, same shape the codec decodes to.
//
// ROCK is the pentatonic backline: the bass CHUGS roots in straight 8ths
// (fifth accents), chords are held power shapes, the lead states a
// signature riff and leaves space — the riff IS the hook the reprise
// replays.
const ROCK_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9J9z9Jzu9J9zI8zu", "9K9xqV9x9Kzu9J9z"]),
};
const ROCK_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["crzmsf2a", "b10KznJsAR"]),
};
const ROCK_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["zEI8Shzuigba", "9Kq8yOJGqSihbd"]),
};

// JAZZ is the swinging acoustic combo: the bass WALKS quarters through the
// scale, the chords comp syncopated off-beat stabs (the Charleston push),
// and the lead phrases loose 8ths with room to breathe.
const JAZZ_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["b5jBAWS7", "b5AUJtsi"]),
};
const JAZZ_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["0K9w2azli62a", "9u0Kzl3CjA"]),
};
const JAZZ_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["0KzwHjRvzrjH9H", "QLI1yKi-2ab8"]),
};

// ── Genre tables wave 2 (2026-10-11): full-library coverage ────────────────
// The 14 genres that lived engine-only now carry their own melodic identity.
// The tables pay TWICE: they are the template fallback AND multi-voice reads
// their octaveOffset (the engine's register per genre). Authored as literal
// MelodicNote arrays (degree: -1 rest, 0 root, 2 third, 3 fourth, 4 fifth,
// 5 sixth, 6 seventh; duration in 16th steps).

// DRILL: the sliding 808 — long gliding bass notes (6-8 steps, the slide
// IS the voice), dark minor stabs, a sparse cold lead.
const DRILL_SLIDE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["eb0KL9", "cM2atT"]),
};
const DRILL_SLIDE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["2a9D3Czr0K", "3C9E2aJx"]),
};
const DRILL_SLIDE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["3CjP0Kbe", "52zBlh"]),
};

// PHONK: dusty memphis — the detuned slide bass, ghost minor stabs, a high
// sparse whistle-ish lead.
const PHONK_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["bi0KbdJM0K", "cLsr2a9O"]),
};
const PHONK_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["0K9x52zn0K", "2ajD52"]),
};
const PHONK_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences(["2aQOB13C", "ig3Cbb2a"]),
};

// JERSEY: the club bounce — an 8th-note bass bounce with the kick, short
// stabs, a chant-length lead.
const JERSEY_BOUNCE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9X0K9QzK9W0KIlzG", "9Y9N0Kr69XzG0K9Q"]),
};
const JERSEY_BOUNCE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9D0Kzr2aqR2a", "2a9Ezr2aI70K"]),
};
const JERSEY_BOUNCE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["9QzD2aIhzB2a", "zG0Kilbg3C"]),
};

// HYPERPOP: the maximalist — a busy wide-leaping lead, pumping 8th bass,
// bright pumping chords.
const HYPERPOP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9Y9OzM9Q9YIlzL9Q", "9ZzJ9X9Lr79OzK9Q"]),
};
const HYPERPOP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["b9A-b9JA", "9IzvJC9IqT2a"]),
};
const HYPERPOP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["9XzLR2yXHCzKivbo", "z0HCR09XzJImR0zIiv"]),
};

// UKG: the swung 2-step — a syncopated bass that DODGES the downbeat,
// shuffled chord stabs, choppy lead hits.
const UKG_TWO_STEP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["0K9W0KzG9T0KIhzD", "2a9UzF0K9S0Kq_"]),
};
const UKG_TWO_STEP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["1s8T2azr3C", "9D3Cib3C"]),
};
const UKG_TWO_STEP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["0KzD0Kik2a9N0K", "QR3CzDii2a"]),
};

// BOOM BAP: the dusty crate — walking quarters under jazzy 7ths and a
// head-nod lead with room between the notes.
const BOOMBAP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["bjB3sujR", "bk0K9IJJB3"]),
};
const BOOMBAP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["0Kal1sA92U", "jF2aal2U"]),
};
const BOOMBAP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["2azDjM2a9N", "QQ3CB12a"]),
};

// AMAPIANO: the log drum — a SPARSE wide-interval bass that dodges the
// grid (the log drum answers, it never chases), lush 7th pads, an airy
// high lead.
const AMAPIANO_LOG_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["1saA2aAn1s", "0Kbj2UIZ0KyQ"]),
};
const AMAPIANO_LOG_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["cr0KCh0K", "mv0Kcp"]),
};
const AMAPIANO_LOG_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences(["3CAd1sRu00", "jH52Jx"]),
};

// TRANCE: the rolling floor — a driving 8th bass, sustained supersaw pads,
// a 16th arp lead.
const TRANCE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9U9L9U9L9U9L9UzF", "9W9N9WIf9W9NzI9L"]),
};
const TRANCE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["dYDN", "pr"]),
};
const TRANCE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["9SipzKQWzKinzJ9T", "y-HxQ-zGisbk2a"]),
};

// DETROIT: the machine funk — a sparse syncopated electro bass, jazzy
// minor-7 stabs, a cold futuristic lead.
const DETROIT_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9W2a9N0KzI2a", "2a9U9LIi3C"]),
};
const DETROIT_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9B3Czr3C", "if2a9B52"]),
};
const DETROIT_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["2a9LQQ2aB1", "QR0KIa6u"]),
};

// POST-ROCK: the slow cinema — whole-note bass, pad chords that hold a full
// bar, a sparse high lead with wide leaps and soft velocities.
const POSTROCK_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["gX", "e5DU"]),
};
const POSTROCK_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["gJ", "mrDF"]),
};
const POSTROCK_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["52DP", "b1AY52"]),
};

// CHIPTUNE: the pulse machine — bouncy 8th bass, arpeggiated chord chains
// (1-step chord tones — the 2A03 arp), a fanfare lead.
const CHIPTUNE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9XzI9WzG9XIk9WzG", "9Y9Nr69N9YzI9W9N"]),
};
const CHIPTUNE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["8VhtyNht8VhtyNht8VhtyNhtHnyHht8T", "yL8Rhv8RyL8Rhv8R52"]),
};
const CHIPTUNE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["9UzJQ_zGImzFitzI", "QfyXIm9WzGiszKQZ9X"]),
};

// EURODANCE: the 90s floor — the classic OFF-BEAT octave bass (rests on the
// beats, hits on the ands), stab chords on the beat, an anthem lead.
const EURODANCE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["0K9W0KzL0K9W0KzK", "0K9X0K9Q0KIm0KzJ"]),
};
const EURODANCE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9G0K9D0Kzw0Kzt0K", "qU3C9G3C"]),
};
const EURODANCE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["9TzISqzFjV9S", "BaQWbj0KB8"]),
};

// LATIN: the tumbao — the bass ANTICIPATES the beat (rest-2-2 rest shape),
// montuno-ish chord stabs in the 3-2 space, a linear lead.
const LATIN_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["0K9TzD0K0KIk9S0K", "0K9U0KzF2ar20K"]),
};
const LATIN_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9D0Kzt0K0Kib0Kzt", "2a9D0Kzr2aid"]),
};
const LATIN_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["0KzDik0Kbd0KzB", "Id2azAii0Kbb"]),
};

// DRONE: one chord, one breath — a whole-note bass, a full-bar pad, a rare
// high whisper. The quietest table in the library by design.
const DRONE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["gP", "g62a"]),
};
const DRONE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["gD", "FM2a"]),
};
const DRONE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences(["7cAN", "52UT"]),
};

export const MELODIC_BY_GENRE: Record<string, MelodicPatternData[]> = {
  house: [HOUSE_BASS, HOUSE_CHORD, HOUSE_LEAD],
  techno: [TECHNO_BASS, TECHNO_CHORD, TECHNO_LEAD],
  trap: [TRAP_BASS, TRAP_CHORD, TRAP_LEAD],
  ambient: [AMBIENT_BASS, AMBIENT_CHORD, AMBIENT_LEAD],
  dnb: [DNB_BASS, DNB_CHORD, DNB_LEAD],
  rock: [ROCK_BASS, ROCK_CHORD, ROCK_LEAD],
  jazz: [JAZZ_BASS, JAZZ_CHORD, JAZZ_LEAD],
  drill: [DRILL_SLIDE_BASS, DRILL_SLIDE_CHORD, DRILL_SLIDE_LEAD],
  phonk: [PHONK_BASS, PHONK_CHORD, PHONK_LEAD],
  jersey: [JERSEY_BOUNCE_BASS, JERSEY_BOUNCE_CHORD, JERSEY_BOUNCE_LEAD],
  hyperpop: [HYPERPOP_BASS, HYPERPOP_CHORD, HYPERPOP_LEAD],
  ukg: [UKG_TWO_STEP_BASS, UKG_TWO_STEP_CHORD, UKG_TWO_STEP_LEAD],
  boombap: [BOOMBAP_BASS, BOOMBAP_CHORD, BOOMBAP_LEAD],
  amapiano: [AMAPIANO_LOG_BASS, AMAPIANO_LOG_CHORD, AMAPIANO_LOG_LEAD],
  trance: [TRANCE_BASS, TRANCE_CHORD, TRANCE_LEAD],
  detroit: [DETROIT_BASS, DETROIT_CHORD, DETROIT_LEAD],
  postrock: [POSTROCK_BASS, POSTROCK_CHORD, POSTROCK_LEAD],
  chiptune: [CHIPTUNE_BASS, CHIPTUNE_CHORD, CHIPTUNE_LEAD],
  eurodance: [EURODANCE_BASS, EURODANCE_CHORD, EURODANCE_LEAD],
  latin: [LATIN_BASS, LATIN_CHORD, LATIN_LEAD],
  drone: [DRONE_BASS, DRONE_CHORD, DRONE_LEAD],
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
  sequences: decodeMelodicSequences(["a30K9Y0Ka000HH0K9-0K", "a300z30Ka00KIs009e0K"]),
};

const GHETTOTECH_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Sparse chant stab
    "bi3Csv0K",
  ]),
};

const GHETTOTECH_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Short electro licks — hooky, chromatic-feeling edges
    "9S0KzH0Kq_2a9P0K",
  ]),
};

// Baile funk: the tamborzão — punchy bass riding the syncopation, minimal
// melody, call-and-response
const BAILE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9i0K9e0K9g00z0009i0K9e0KHE00"]),
};

const BAILE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Minimal chant stab — one shout per bar
    "9S6uzH0K",
  ]),
};

const BAILE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Call-and-response short phrase
    "9S00hF2UzH2U",
  ]),
};

// Footwork: jumpy polyrhythm — off-grid short notes with octave jumps,
// repeating 2-3 note motifs
const FOOTWORK_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9i0Kz00K9Y00HE0K9-0KyZ00"]),
};

const FOOTWORK_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Sparse — the battle is between bass and drums
    "52bb2a",
  ]),
};

const FOOTWORK_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Manic repeated motif — 2-3 notes, machine-repeated
    "98yZ98yZ2a98yZ982U",
  ]),
};

// Jungle: THE chop bass — long deep sub notes under the fast break; the
// contrast between frantic drums and patient sub IS the genre
const JUNGLE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["en0KBi0K", "cX0KsG0KzQ"]),
};

const JUNGLE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Sparse reggae-ish skank stabs on the offbeats
    "0K912U0KyV2U",
  ]),
};

const JUNGLE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Ragga-ish stabs — sparse, punchy, patient
    "9S3CzH2aq_",
  ]),
};

// Slap house: the slap — plucky short notes with fifth pops, bouncy and
// minimal; chords stay out of the way
const SLAPHOUSE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9l009800za009b009i00HE009i00z000"]),
};

const SLAPHOUSE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Long soft pad — the slap carries the identity
    "dS2aJp",
  ]),
};

const SLAPHOUSE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Sparse hook — patient, roomy
    "bb2aA_2a",
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
    "9l009e1sqy00qr1sa00K",
    // The step-down answer
    "a30KQo00HM00zQ0Ka0",
  ]),
};

const TECHSTEP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Metallic stab on the 1 — reverb does the rest
    "9H3C52",
    // Two stabs, second a fourth up
    "2a8V1syR4k",
  ]),
};

const TECHSTEP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Sci-fi blip motif — short, quantised, cold
    "8Z1sq91syN4k",
    // Descending scanner
    "QLI7zvia52",
  ]),
};

const RAGGA_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // The reggae drop — root on the beat, rest OFF the beat, fifth pickup
    "a00Kz0009-2a",
    // Walking dub line
    "a000qr0KIs0KzN",
  ]),
};

const RAGGA_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // The skank — short offbeat stabs, the reggae organ/chop answer
    "0K951s911syZ1s",
    // Two-chord skank turnaround
    "2aqh1sHx1s",
  ]),
};

const RAGGA_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Call-and-response horn-ish phrase
    "9ShJ952azK3C",
    // Patient dub call
    "JL0KzD9P3C",
  ]),
};

const SAMBASS_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Bossa-tinged roller — root-fifth-octave with a syncopated push
    "a000z60K9-0KIs0K",
    // Gentle walking answer
    "bszQIszNixbq",
  ]),
};

const SAMBASS_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Long airy pads — the melodic sample leads, chords breathe
    "dSv3",
  ]),
};

const SAMBASS_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Melodic hook — the Marky/Bukem school lead
    "zDHtyRinbb0KijzD",
    // Sparse sung-feel call
    "Sfzz0Kifcz",
  ]),
};

const HALFTIME_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // Huge sparse sub — the bass is the hook in halftime
    "cX0KJW2a",
    // The drop-and-return
    "bv2asIk2",
  ]),
};

const HALFTIME_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // One vast pad wash
    "gF",
    // Slow two-chord drift
    "dPMh",
  ]),
};

const HALFTIME_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Distant, patient motif — room between every note
    "9D3Czv3C",
    // Rising sigh
    "jHA_52",
  ]),
};

const CROSSBREED_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // 16th root churn — relentless
    "9l9e9i9b9l9eqw9ba00Ka0",
    // Octave hammer
    "a3zUa3Iua0rebv",
  ]),
};

const CROSSBREED_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Industrial hammer stabs
    "9800912UHE4k",
  ]),
};

const CROSSBREED_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Screaming siren call
    "Q-HBQd2azH3C",
  ]),
};

const MINIMAL_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences([
    // One-note autonomic sub — the space is the style
    "ek52",
    // Two-note movement, barely
    "cT0Kls0K",
  ]),
};

const MINIMAL_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Near-silent pad — a whisper
    "gz",
  ]),
};

const MINIMAL_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Micro motif — one gesture per phrase
    "3CyI5M",
    // Textural blip pair
    "52hn00yI2U",
  ]),
};

// ── Melodic dialects (wave 3 — the octave bounce, the 808 slides, the 303) ──

// Disco: THE octave bounce — root and octave alternating on every beat
const DISCO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["a00KzQ0Ka00KzQr6", "9iz00K9-Im0KzNir"]),
};

const DISCO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // String stabs on the offbeats
    "0K9L0Kzz",
  ]),
};

const DISCO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Sunny hook — moves in comfortable steps
    "zD0KIbzz0Kif2a",
  ]),
};

// Synthpop: the driving 8th synth bass — relentless and even
const SYNTHPOP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9-9V9-9VIsImzNr6"]),
};

const SYNTHPOP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Gated stabs — the 80s snapshot chord
    "9L0K9L0K",
  ]),
};

const SYNTHPOP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Analog hook with a hook-y fall
    "zDijbb0KifA_",
  ]),
};

// Progressive house: the long patient bass — half-bar notes, deep and even
const PROGRESSIVE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["egvq", "cQ0KE2"]),
};

const PROGRESSIVE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Emotive pad swells
    "dXv6",
  ]),
};

const PROGRESSIVE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // The long hypnotic phrase
    "b7jHA_2a",
  ]),
};

// UK garage: the 2-step syncopated sub — skips the grid, answers late
const UKG_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9-00zK1s9Y00r31s"]),
};

const UKG_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Warm shuttling chords — the garage wipe
    "0K9H0KI7",
  ]),
};

const UKG_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Vocal-ishlick — syncopated, singable
    "Al00ij0Kbb2a",
  ]),
};

// Jersey club: the triple-kick answer — bass punctuates between the kicks
const JERSEY_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["a00K98009-0Kz000a00K"]),
};

const JERSEY_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // The club stab — short, chopped
    "1s9552yV1s",
  ]),
};

const JERSEY_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Chopped vocal-feel hook
    "9500yV2Uij3C",
  ]),
};

// Trap classic: the 808 slide — long gliding root notes, sparse and deep
const TRAP808_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["cX0KCM0K", "bv0KsG0Kbs"]),
};

const TRAP808_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Dark sparse bell-ish pad
    "3Cb33C",
  ]),
};

const TRAP808_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Dark bell hook — sparse, ringing
    "at1sAh1sjL",
  ]),
};

// UK drill: the sliding 808 answer — the root slides up a half-step feel
const DRILL_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["cd009Y0KCM0K", "bv0KJW0KBk0K"]),
};

const DRILL_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Dark sliding pad
    "2acq0KAN",
  ]),
};

const DRILL_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Dark sliding hook
    "at00A_0KIR1s",
  ]),
};

// Acid techno: the 303 — accented 16ths with octave jumps
const ACID_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9l9198z8919i00z0959iHH0098z80091"]),
};

const ACID_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Sparse stabs — the 303 carries the identity
    "529D3C",
  ]),
};

const ACID_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Screaming 303 line up top
    "9byZ98HB2a98yZ3C",
  ]),
};

// Bass house: the wobble stab — syncopated bass stabs between the kicks
const BASSHOUSE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["a30K9ez3a00KHH00a00K"]),
};

const BASSHOUSE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["2a9H3Czv0K"]),
};

const BASSHOUSE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Vocal-chop style hook
    "9P0KzD2aIf2a",
  ]),
};

// Country pop: the boom-chicka — root and fifth alternating, honest and warm
const COUNTRY_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9-0KzK0K9-0KzK0K", "9-zH9YIj9YzHq_9V"]),
};

const COUNTRY_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Warm acoustic strum feel
    "b72aAX2a",
  ]),
};

const COUNTRY_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Pentatonic twinkle — the country lead language
    "zDIbzzif2ab7",
  ]),
};

// Kuduro: the carnival punch — percussive root stabs, fast and dry
const KUDURO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9l009-0K9i1sz3009-0K"]),
};

const KUDURO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Carnival whistle-feel stab
    "3C912Uzz0K",
  ]),
};

const KUDURO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Half-time rap-feel phrase over the frantic floor
    "bf0KB30Ksn",
  ]),
};

// Tropical: the soft round beach bass — warm, rounded, patient
const TROPICAL_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["aG00bl2aBa", "bo0KJL0KBa"]),
};

const TROPICAL_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Steel-pan flavored bright stabs
    "0K9H2azv3C",
  ]),
};

const TROPICAL_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // The pan-flute melody — pentatonic sunshine
    "Alj1bb0KjL",
  ]),
};

// Liquid dnb: the long warm rolling — soulful, patient under the fast break
const LIQUID_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["cS0KBd2a", "bq0Ku10KIm"]),
};

const LIQUID_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Soulful Rhodes-feel pads
    "cv0KCi0K",
  ]),
};

const LIQUID_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Liquid soul line — smooth and singing
    "Al00ijbb0KA_",
  ]),
};

// Tech house: the wobbly stab — off-grid bass stabs with groove
const TECHHOUSE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["a0009b0Ka00Kz3009e1s"]),
};

const TECHHOUSE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["2a9D520K"]),
};

const TECHHOUSE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Sparse funk licks
    "2a9L0Kzz3C",
  ]),
};

// ── Melodic dialects (dnb depth wave 2 — the remaining seven voices) ──────

// Two-step: the snap — bass skips the grid with the break, short and tight
const TWOSTEP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["a00000zK0K9-00ql0KzK0K"]),
};

const TWOSTEP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["2a9D2a0KI20K"]),
};

const TWOSTEP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences(["Al00if0Kb72a"]),
};

// Roller: the smooth roll — even 8th root drive, hypnotic, never busy
const ROLLER_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["9-9S9Y9SzNzH9Y9S", "9-9Sr69S9-9SImzK"]),
};

const ROLLER_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Pad swells — long, dark, supportive
    "dS0KtB",
  ]),
};

const ROLLER_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Hypnotic minor motif — repeats with small changes
    "9H0KqTzv0KqT0K9H",
  ]),
};

// Amen chop: the bass follows the chop — syncopated with ghost movement
const AMENCHOP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["aK009V0KzQ00980KIp0K"]),
};

const AMENCHOP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Ragga stab feel
    "1s913Czz2a",
  ]),
};

const AMENCHOP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Ragga toast-feel phrase
    "9P00910KAl0KqX1s",
  ]),
};

// Neuro: the reese — long dark growling notes, semitone-adjacent tension
const NEURO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["cX0KU00K", "bv0KJW0KSA0K"]),
};

const NEURO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Dark techy stabs, mechanical
    "1s913C1sHt0K",
  ]),
};

const NEURO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // Techy growl line — mechanical, angular
    "9S0KQT0K9S0KIf0K",
  ]),
};

// Jump-up: the wobble stab — bouncy punchy stabs built for the skip
const JUMPUP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["a30K9e00zU0Ka00K9Y0K"]),
};

const JUMPUP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences(["3C9L52"]),
};

const JUMPUP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // The bouncywarrior hook — short stabs, big spaces
    "9S2azH2a9S0K",
  ]),
};

// Dancefloor: the anthemic drive — wide jumps, big and even
const DANCEFLOOR_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["a09VzSzKa09VIsIm"]),
};

const DANCEFLOOR_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Big anthemic swells
    "d_0KCn",
  ]),
};

const DANCEFLOOR_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // The festival hook — wide, singable, confident
    "B70KjP0Kbf0K",
  ]),
};

// ── Melodic dialects (gabber — the kick carries the low end) ──────────────

// Gabber bass: dark and sparse — the distorted kick owns the low register,
// the bass only anchors the half-bar. Screechy hoover lead is the genre voice.
const GABBER_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: decodeMelodicSequences(["eg0KcN", "eg0KTS"]),
};

const GABBER_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: decodeMelodicSequences([
    // Dark minor stabs on the half-bar, menace over the stomp
    "2a9H3C9D0K",
  ]),
};

const GABBER_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: decodeMelodicSequences([
    // The hoover screech — short aggressive phrases with a descending tail
    "9g9eR10KR452",
    "rcqrhM2a9V3C",
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
