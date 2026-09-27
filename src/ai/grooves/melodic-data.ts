import type { MelodicPatternData } from "../types";
import type { ProductionProfile } from "../../project-model/types";

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
  sequences: [
    // Classic offbeat bass
    [
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    // Rolling bass
    [
      { degree: 0, duration: 1, velocity: 0.8 },
      { degree: 0, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.75 },
      { degree: 4, duration: 1, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.7 },
      { degree: 2, duration: 2, velocity: 0.65 },
    ],
    // Walking bass
    [
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 2, duration: 2, velocity: 0.7 },
      { degree: 4, duration: 2, velocity: 0.75 },
      { degree: 6, duration: 2, velocity: 0.65 },
      { degree: 5, duration: 2, velocity: 0.7 },
      { degree: 3, duration: 2, velocity: 0.75 },
      { degree: 2, duration: 2, velocity: 0.7 },
      { degree: 0, duration: 2, velocity: 0.8 },
    ],
  ],
};

const HOUSE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Stab on offbeats
    [
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.55 },
    ],
    // Sustained pads
    [
      { degree: 0, duration: 4, velocity: 0.5 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.45 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
  ],
};

const HOUSE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Simple house motif
    [
      { degree: 0, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    // Call and response
    [
      { degree: 0, duration: 4, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

// ── Techno ─────────────────────────────────────────────

const TECHNO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    // Root pulse
    [
      { degree: 0, duration: 1, velocity: 0.85 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.75 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.8 },
    ],
    // Rumble pattern
    [
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.65 },
      { degree: 0, duration: 1, velocity: 0.5 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.6 },
    ],
    // Minimal pulse
    [
      { degree: 0, duration: 4, velocity: 0.85 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.75 },
    ],
  ],
};

const TECHNO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: [
    // Minimal stab
    [
      { degree: 0, duration: 4, velocity: 0.6 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.55 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
    // Syncopated riff
    [
      { degree: 0, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const TECHNO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Minimal stab chords
    [
      { degree: 0, duration: 4, velocity: 0.55 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.5 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
    // Industrial stab pattern
    [
      { degree: 0, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

// ── Trap ───────────────────────────────────────────────

const TRAP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    // Classic 808 pattern
    [
      { degree: 0, duration: 4, velocity: 0.95 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.85 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
    // Bouncy
    [
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.85 },
      { degree: 3, duration: 2, velocity: 0.75 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 4, velocity: 0.9 },
    ],
    // Sparse
    [
      { degree: 0, duration: 8, velocity: 0.95 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.85 },
    ],
  ],
};

const TRAP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Simple motif
    [
      { degree: 0, duration: 2, velocity: 0.65 },
      { degree: 2, duration: 2, velocity: 0.6 },
      { degree: 4, duration: 4, velocity: 0.7 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.55 },
      { degree: 0, duration: 2, velocity: 0.6 },
    ],
    // Arpeggio
    [
      { degree: 0, duration: 1, velocity: 0.6 },
      { degree: 2, duration: 1, velocity: 0.55 },
      { degree: 4, duration: 1, velocity: 0.6 },
      { degree: 6, duration: 1, velocity: 0.5 },
      { degree: 4, duration: 1, velocity: 0.55 },
      { degree: 2, duration: 1, velocity: 0.5 },
      { degree: 0, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 8, velocity: 0 },
    ],
  ],
};

const TRAP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Trap pad stabs
    [
      { degree: 0, duration: 4, velocity: 0.5 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.45 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
    // Dark chord hits
    [
      { degree: 0, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 6, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 6, velocity: 0 },
    ],
  ],
};

// Original, profile-level material: scale-degree sketches rather than copied
// melodies. These favor long harmonic beds and short, singable motifs over
// note-dense runs; the user's key still determines the actual pitches.
const SPACEY_RAP_MELODICS: MelodicPatternData[] = [
  {
    role: "bass",
    octaveOffset: -1,
    sequences: [
      [
        { degree: 0, duration: 8, velocity: 0.82 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 4, duration: 4, velocity: 0.68 },
      ],
      [
        { degree: 0, duration: 4, velocity: 0.78 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 4, duration: 4, velocity: 0.66 },
        { degree: -1, duration: 4, velocity: 0 },
      ],
    ],
  },
  {
    role: "chord",
    octaveOffset: 1,
    sequences: [
      [
        { degree: 0, duration: 8, velocity: 0.44 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 4, duration: 4, velocity: 0.38 },
      ],
      [
        { degree: 0, duration: 4, velocity: 0.42 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 2, duration: 4, velocity: 0.36 },
        { degree: -1, duration: 4, velocity: 0 },
      ],
    ],
  },
  {
    role: "lead",
    octaveOffset: 2,
    sequences: [
      [
        { degree: 4, duration: 4, velocity: 0.52 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 2, duration: 4, velocity: 0.47 },
        { degree: -1, duration: 4, velocity: 0 },
      ],
      [
        { degree: 0, duration: 8, velocity: 0.5 },
        { degree: -1, duration: 8, velocity: 0 },
      ],
    ],
  },
];

const DARK_ATMOSPHERIC_TRAP_MELODICS: MelodicPatternData[] = [
  {
    role: "bass",
    octaveOffset: -1,
    sequences: [
      [
        { degree: 0, duration: 4, velocity: 0.94 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 0, duration: 2, velocity: 0.74 },
        { degree: -1, duration: 2, velocity: 0 },
        { degree: 4, duration: 4, velocity: 0.82 },
      ],
      [
        { degree: 0, duration: 8, velocity: 0.9 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 3, duration: 4, velocity: 0.72 },
      ],
    ],
  },
  {
    role: "chord",
    octaveOffset: 1,
    sequences: [
      [
        { degree: 0, duration: 8, velocity: 0.46 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 3, duration: 4, velocity: 0.4 },
      ],
      [
        { degree: 0, duration: 4, velocity: 0.48 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 4, duration: 8, velocity: 0.4 },
      ],
    ],
  },
  {
    role: "lead",
    octaveOffset: 2,
    sequences: [
      [
        { degree: 0, duration: 2, velocity: 0.54 },
        { degree: -1, duration: 6, velocity: 0 },
        { degree: 3, duration: 2, velocity: 0.48 },
        { degree: -1, duration: 6, velocity: 0 },
      ],
      [
        { degree: 4, duration: 4, velocity: 0.52 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 0, duration: 4, velocity: 0.46 },
        { degree: -1, duration: 4, velocity: 0 },
      ],
    ],
  },
];

const SPACEY_DARK_TRAP_MELODICS: MelodicPatternData[] = [
  {
    role: "bass",
    octaveOffset: -1,
    sequences: [
      [
        { degree: 0, duration: 8, velocity: 0.92 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 4, duration: 4, velocity: 0.76 },
      ],
      [
        { degree: 0, duration: 4, velocity: 0.9 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 3, duration: 4, velocity: 0.72 },
        { degree: -1, duration: 4, velocity: 0 },
      ],
    ],
  },
  {
    role: "chord",
    octaveOffset: 1,
    sequences: [
      [
        { degree: 0, duration: 8, velocity: 0.45 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 4, duration: 4, velocity: 0.39 },
      ],
      [
        { degree: 0, duration: 4, velocity: 0.46 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 3, duration: 8, velocity: 0.4 },
      ],
    ],
  },
  {
    role: "lead",
    octaveOffset: 2,
    sequences: [
      [
        { degree: 4, duration: 4, velocity: 0.53 },
        { degree: -1, duration: 8, velocity: 0 },
        { degree: 2, duration: 4, velocity: 0.48 },
      ],
      [
        { degree: 0, duration: 4, velocity: 0.52 },
        { degree: -1, duration: 4, velocity: 0 },
        { degree: 3, duration: 4, velocity: 0.47 },
        { degree: -1, duration: 4, velocity: 0 },
      ],
    ],
  },
];

// ── Ambient ────────────────────────────────────────────

const AMBIENT_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    // Drone
    [
      { degree: 0, duration: 8, velocity: 0.5 },
      { degree: -1, duration: 8, velocity: 0 },
    ],
    // Slow movement
    [
      { degree: 0, duration: 8, velocity: 0.55 },
      { degree: 4, duration: 8, velocity: 0.5 },
    ],
  ],
};

const AMBIENT_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: [
    // Sparse melody
    [
      { degree: 0, duration: 4, velocity: 0.45 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.4 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 2, duration: 4, velocity: 0.42 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
    // Arpeggiated
    [
      { degree: 0, duration: 2, velocity: 0.4 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.38 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.4 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 6, duration: 4, velocity: 0.35 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
  ],
};

const AMBIENT_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Evolving pad drones
    [
      { degree: 0, duration: 8, velocity: 0.4 },
      { degree: 4, duration: 8, velocity: 0.35 },
    ],
    // Sparse chord tones
    [
      { degree: 0, duration: 4, velocity: 0.35 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 2, duration: 4, velocity: 0.3 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.32 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
  ],
};

// ── Drum & bass ──────────────────────────────────────────
// Reese pressure under chopped-break energy: long root sustains with octave
// motion (bass), airy liquid pads + minimal stabs (chords), rolling motifs
// with space to breathe (lead). Degrees are scale-relative (minor home).

const DNB_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    // Reese roller
    [
      { degree: 0, duration: 4, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.75 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    // Octave stepper
    [
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: 4, duration: 2, velocity: 0.8 },
      { degree: 4, duration: 2, velocity: 0.65 },
      { degree: 5, duration: 2, velocity: 0.75 },
      { degree: 4, duration: 2, velocity: 0.6 },
      { degree: 3, duration: 2, velocity: 0.7 },
      { degree: 2, duration: 2, velocity: 0.65 },
    ],
  ],
};

const DNB_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Liquid pads
    [
      { degree: 0, duration: 4, velocity: 0.5 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 3, duration: 4, velocity: 0.45 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
    // Minimal stabs
    [
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 1, velocity: 0.55 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const DNB_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Roller motif
    [
      { degree: 4, duration: 1, velocity: 0.6 },
      { degree: 5, duration: 1, velocity: 0.55 },
      { degree: 4, duration: 1, velocity: 0.6 },
      { degree: 6, duration: 1, velocity: 0.5 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.55 },
      { degree: 4, duration: 1, velocity: 0.5 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    // Sparse call
    [
      { degree: 6, duration: 4, velocity: 0.55 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.5 },
      { degree: 2, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
  ],
};

// ── Melodic dialects (per-style pilots) ───────────────
// Amapiano: the LOG DRUM is melodic content, not a drum — syncopated short
// bass notes answering the kick, airy chord stabs, gentle piano lead.
const AMAPIANO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    // Core log-drum answer — syncopated short notes between the kicks
    [
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.75 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.8 },
      { degree: 4, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    // Log roll — the short-note tumble
    [
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.7 },
      { degree: 4, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 5, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 1, velocity: 0 },
    ],
    // Deep walk — root patience, syncopated lift
    [
      { degree: 0, duration: 4, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.7 },
    ],
  ],
};

const AMAPIANO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 2,
  sequences: [
    // Airy stabs — sparse, soft, floating above the log drum
    [
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 4, velocity: 0.5 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 5, duration: 4, velocity: 0.45 },
    ],
    [
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 3, duration: 4, velocity: 0.5 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 4, velocity: 0.45 },
    ],
  ],
};

const AMAPIANO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Gentle piano phrase — patient, jazzy movement
    [
      { degree: 0, duration: 4, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    [
      { degree: 5, duration: 3, velocity: 0.55 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.5 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 2, duration: 4, velocity: 0.5 },
    ],
  ],
};

// Dembow: the chop bass — root-heavy staccato answering the rim chop
const DEMBOW_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 3, velocity: 0.9 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.75 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 3, velocity: 0.85 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.7 },
    ],
    [
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.75 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 1, velocity: 0 },
    ],
  ],
};

const DEMBOW_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Bright stabs answering the chop
    [
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
    [
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 5, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 8, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 3, velocity: 0 },
    ],
  ],
};

const DEMBOW_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 1,
  sequences: [
    // Syncopated tropical-urban hook
    [
      { degree: 0, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 2, duration: 1, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 3, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 3, velocity: 0 },
    ],
    [
      { degree: 5, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 8, velocity: 0 },
    ],
  ],
};

// Metal: the gallop — driving root-heavy 8ths, dark sustained power chords
const METAL_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    // Gallop — root drive with fifth jumps
    [
      { degree: 0, duration: 2, velocity: 0.95 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 4, duration: 2, velocity: 0.9 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 0, duration: 2, velocity: 0.95 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 4, duration: 2, velocity: 0.9 },
      { degree: 3, duration: 2, velocity: 0.8 },
    ],
    // Chug walk — root 8ths with a dark lift
    [
      { degree: 0, duration: 2, velocity: 0.95 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: 5, duration: 2, velocity: 0.8 },
      { degree: 0, duration: 2, velocity: 0.95 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 6, duration: 2, velocity: 0.75 },
      { degree: 4, duration: 2, velocity: 0.85 },
    ],
  ],
};

const METAL_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Dark sustained power — two heavy hits per bar
    [
      { degree: 0, duration: 8, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 6, velocity: 0.8 },
    ],
    [
      { degree: 0, duration: 6, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 8, velocity: 0.8 },
    ],
  ],
};

const METAL_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Dark minor run — the riff line
    [
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: 4, duration: 2, velocity: 0.75 },
      { degree: 3, duration: 2, velocity: 0.7 },
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: 6, duration: 2, velocity: 0.65 },
      { degree: 4, duration: 2, velocity: 0.7 },
      { degree: 2, duration: 2, velocity: 0.65 },
    ],
    // Sparse menace — long tones, dark intervals
    [
      { degree: 0, duration: 4, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 4, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.75 },
    ],
  ],
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
  sequences: [
    [
      { degree: 0, duration: 2, velocity: 0.95 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 5, duration: 1, velocity: 0.75 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    [
      { degree: 0, duration: 2, velocity: 0.95 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.75 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const GHETTOTECH_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Sparse chant stab
    [
      { degree: 0, duration: 4, velocity: 0.7 },
      { degree: -1, duration: 6, velocity: 0 },
      { degree: 3, duration: 4, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const GHETTOTECH_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Short electro licks — hooky, chromatic-feeling edges
    [
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

// Baile funk: the tamborzão — punchy bass riding the syncopation, minimal
// melody, call-and-response
const BAILE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 1, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.85 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 1, velocity: 0 },
    ],
  ],
};

const BAILE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Minimal chant stab — one shout per bar
    [
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 10, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const BAILE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Call-and-response short phrase
    [
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 2, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 5, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 5, velocity: 0 },
    ],
  ],
};

// Footwork: jumpy polyrhythm — off-grid short notes with octave jumps,
// repeating 2-3 note motifs
const FOOTWORK_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 1, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 5, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 1, velocity: 0 },
    ],
  ],
};

const FOOTWORK_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Sparse — the battle is between bass and drums
    [
      { degree: -1, duration: 8, velocity: 0 },
      { degree: 0, duration: 4, velocity: 0.6 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
  ],
};

const FOOTWORK_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Manic repeated motif — 2-3 notes, machine-repeated
    [
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: 4, duration: 1, velocity: 0.65 },
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: 4, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: 4, duration: 1, velocity: 0.65 },
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 5, velocity: 0 },
    ],
  ],
};

// Jungle: THE chop bass — long deep sub notes under the fast break; the
// contrast between frantic drums and patient sub IS the genre
const JUNGLE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 8, velocity: 0.95 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    [
      { degree: 0, duration: 6, velocity: 0.95 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 4, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.8 },
    ],
  ],
};

const JUNGLE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Sparse reggae-ish skank stabs on the offbeats
    [
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 5, velocity: 0 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 5, velocity: 0 },
    ],
  ],
};

const JUNGLE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Ragga-ish stabs — sparse, punchy, patient
    [
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 6, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.6 },
    ],
  ],
};

// Slap house: the slap — plucky short notes with fifth pops, bouncy and
// minimal; chords stay out of the way
const SLAPHOUSE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 1, velocity: 0.95 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.9 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.75 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.9 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 5, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.9 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 1, velocity: 0 },
    ],
  ],
};

const SLAPHOUSE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Long soft pad — the slap carries the identity
    [
      { degree: 0, duration: 8, velocity: 0.45 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 5, duration: 4, velocity: 0.4 },
    ],
  ],
};

const SLAPHOUSE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Sparse hook — patient, roomy
    [
      { degree: 0, duration: 4, velocity: 0.6 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.55 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
  ],
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
  "house.slaphouse": [SLAPHOUSE_BASS, SLAPHOUSE_CHORD, SLAPHOUSE_LEAD],
};

export const MELODIC_BY_PROFILE: Record<ProductionProfile, MelodicPatternData[]> = {
  "spacey-melodic-rap": SPACEY_RAP_MELODICS,
  "dark-atmospheric-trap": DARK_ATMOSPHERIC_TRAP_MELODICS,
  "spacey-dark-trap": SPACEY_DARK_TRAP_MELODICS,
};
