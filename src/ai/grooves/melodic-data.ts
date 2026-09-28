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
  sequences: [
    // Clipped staccato root — the techstep signature is a SHORT note
    [
      { degree: 0, duration: 1, velocity: 0.95 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.8 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 3, duration: 1, velocity: 0.9 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 3, duration: 1, velocity: 0.75 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    // The step-down answer
    [
      { degree: 0, duration: 2, velocity: 0.95 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 6, duration: 1, velocity: 0.85 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 5, duration: 1, velocity: 0.85 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.9 },
    ],
  ],
};

const TECHSTEP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Metallic stab on the 1 — reverb does the rest
    [
      { degree: 0, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 6, velocity: 0 },
      { degree: -1, duration: 8, velocity: 0 },
    ],
    // Two stabs, second a fourth up
    [
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.5 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.55 },
      { degree: -1, duration: 7, velocity: 0 },
    ],
  ],
};

const TECHSTEP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Sci-fi blip motif — short, quantised, cold
    [
      { degree: 0, duration: 1, velocity: 0.55 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 3, duration: 1, velocity: 0.5 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.5 },
      { degree: -1, duration: 7, velocity: 0 },
    ],
    // Descending scanner
    [
      { degree: 6, duration: 2, velocity: 0.5 },
      { degree: 5, duration: 2, velocity: 0.5 },
      { degree: 4, duration: 2, velocity: 0.5 },
      { degree: 2, duration: 2, velocity: 0.45 },
      { degree: -1, duration: 8, velocity: 0 },
    ],
  ],
};

const RAGGA_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    // The reggae drop — root on the beat, rest OFF the beat, fifth pickup
    [
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
    // Walking dub line
    [
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 3, duration: 1, velocity: 0.75 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.75 },
    ],
  ],
};

const RAGGA_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // The skank — short offbeat stabs, the reggae organ/chop answer
    [
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 3, velocity: 0 },
    ],
    // Two-chord skank turnaround
    [
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 3, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 5, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 3, velocity: 0 },
    ],
  ],
};

const RAGGA_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Call-and-response horn-ish phrase
    [
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: 2, duration: 1, velocity: 0.65 },
      { degree: 0, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 6, velocity: 0 },
    ],
    // Patient dub call
    [
      { degree: 5, duration: 4, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.6 },
      { degree: 0, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 6, velocity: 0 },
    ],
  ],
};

const SAMBASS_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    // Bossa-tinged roller — root-fifth-octave with a syncopated push
    [
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    // Gentle walking answer
    [
      { degree: 0, duration: 4, velocity: 0.9 },
      { degree: 4, duration: 2, velocity: 0.8 },
      { degree: 5, duration: 2, velocity: 0.8 },
      { degree: 4, duration: 2, velocity: 0.75 },
      { degree: 2, duration: 2, velocity: 0.75 },
      { degree: 0, duration: 4, velocity: 0.85 },
    ],
  ],
};

const SAMBASS_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Long airy pads — the melodic sample leads, chords breathe
    [
      { degree: 0, duration: 8, velocity: 0.45 },
      { degree: 3, duration: 8, velocity: 0.42 },
    ],
  ],
};

const SAMBASS_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Melodic hook — the Marky/Bukem school lead
    [
      { degree: 4, duration: 2, velocity: 0.6 },
      { degree: 5, duration: 1, velocity: 0.55 },
      { degree: 4, duration: 1, velocity: 0.55 },
      { degree: 2, duration: 2, velocity: 0.6 },
      { degree: 0, duration: 4, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.55 },
      { degree: 4, duration: 2, velocity: 0.6 },
    ],
    // Sparse sung-feel call
    [
      { degree: 6, duration: 4, velocity: 0.55 },
      { degree: 4, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.5 },
      { degree: 0, duration: 6, velocity: 0.55 },
    ],
  ],
};

const HALFTIME_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    // Huge sparse sub — the bass is the hook in halftime
    [
      { degree: 0, duration: 6, velocity: 0.95 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 4, velocity: 0.85 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
    // The drop-and-return
    [
      { degree: 0, duration: 4, velocity: 0.95 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 3, duration: 4, velocity: 0.9 },
      { degree: 2, duration: 4, velocity: 0.85 },
    ],
  ],
};

const HALFTIME_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // One vast pad wash
    [{ degree: 0, duration: 16, velocity: 0.4 }],
    // Slow two-chord drift
    [
      { degree: 0, duration: 8, velocity: 0.42 },
      { degree: 5, duration: 8, velocity: 0.4 },
    ],
  ],
};

const HALFTIME_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Distant, patient motif — room between every note
    [
      { degree: 0, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 6, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 6, velocity: 0 },
    ],
    // Rising sigh
    [
      { degree: 2, duration: 4, velocity: 0.5 },
      { degree: 4, duration: 4, velocity: 0.55 },
      { degree: -1, duration: 8, velocity: 0 },
    ],
  ],
};

const CROSSBREED_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    // 16th root churn — relentless
    [
      { degree: 0, duration: 1, velocity: 0.95 },
      { degree: 0, duration: 1, velocity: 0.8 },
      { degree: 0, duration: 1, velocity: 0.9 },
      { degree: 0, duration: 1, velocity: 0.75 },
      { degree: 0, duration: 1, velocity: 0.95 },
      { degree: 0, duration: 1, velocity: 0.8 },
      { degree: 3, duration: 1, velocity: 0.85 },
      { degree: 0, duration: 1, velocity: 0.75 },
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.9 },
    ],
    // Octave hammer
    [
      { degree: 0, duration: 2, velocity: 0.95 },
      { degree: 4, duration: 2, velocity: 0.9 },
      { degree: 0, duration: 2, velocity: 0.95 },
      { degree: 5, duration: 2, velocity: 0.85 },
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: 3, duration: 2, velocity: 0.85 },
      { degree: 0, duration: 4, velocity: 0.95 },
    ],
  ],
};

const CROSSBREED_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Industrial hammer stabs
    [
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 5, velocity: 0 },
      { degree: 5, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 7, velocity: 0 },
    ],
  ],
};

const CROSSBREED_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Screaming siren call
    [
      { degree: 6, duration: 2, velocity: 0.7 },
      { degree: 5, duration: 1, velocity: 0.65 },
      { degree: 6, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 6, velocity: 0 },
    ],
  ],
};

const MINIMAL_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    // One-note autonomic sub — the space is the style
    [
      { degree: 0, duration: 8, velocity: 0.9 },
      { degree: -1, duration: 8, velocity: 0 },
    ],
    // Two-note movement, barely
    [
      { degree: 0, duration: 6, velocity: 0.88 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 6, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const MINIMAL_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Near-silent pad — a whisper
    [{ degree: 0, duration: 16, velocity: 0.3 }],
  ],
};

const MINIMAL_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Micro motif — one gesture per phrase
    [
      { degree: -1, duration: 6, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.45 },
      { degree: -1, duration: 9, velocity: 0 },
    ],
    // Textural blip pair
    [
      { degree: -1, duration: 8, velocity: 0 },
      { degree: 2, duration: 1, velocity: 0.4 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.45 },
      { degree: -1, duration: 5, velocity: 0 },
    ],
  ],
};

// ── Melodic dialects (wave 3 — the octave bounce, the 808 slides, the 303) ──

// Disco: THE octave bounce — root and octave alternating on every beat
const DISCO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.8 },
      { degree: 3, duration: 2, velocity: 0.7 },
    ],
    [
      { degree: 0, duration: 1, velocity: 0.9 },
      { degree: 4, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 5, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.75 },
      { degree: 2, duration: 2, velocity: 0.65 },
    ],
  ],
};

const DISCO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // String stabs on the offbeats
    [
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.55 },
    ],
  ],
};

const DISCO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Sunny hook — moves in comfortable steps
    [
      { degree: 4, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.55 },
      { degree: 4, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
  ],
};

// Synthpop: the driving 8th synth bass — relentless and even
const SYNTHPOP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 0, duration: 2, velocity: 0.75 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 0, duration: 2, velocity: 0.75 },
      { degree: 5, duration: 2, velocity: 0.8 },
      { degree: 5, duration: 2, velocity: 0.7 },
      { degree: 4, duration: 2, velocity: 0.75 },
      { degree: 3, duration: 2, velocity: 0.7 },
    ],
  ],
};

const SYNTHPOP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Gated stabs — the 80s snapshot chord
    [
      { degree: 0, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const SYNTHPOP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Analog hook with a hook-y fall
    [
      { degree: 4, duration: 2, velocity: 0.6 },
      { degree: 2, duration: 2, velocity: 0.55 },
      { degree: 0, duration: 4, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.5 },
      { degree: 4, duration: 4, velocity: 0.55 },
    ],
  ],
};

// Progressive house: the long patient bass — half-bar notes, deep and even
const PROGRESSIVE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 8, velocity: 0.8 },
      { degree: 3, duration: 8, velocity: 0.7 },
    ],
    [
      { degree: 0, duration: 6, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 8, velocity: 0.7 },
    ],
  ],
};

const PROGRESSIVE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Emotive pad swells
    [
      { degree: 0, duration: 8, velocity: 0.5 },
      { degree: 3, duration: 8, velocity: 0.45 },
    ],
  ],
};

const PROGRESSIVE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // The long hypnotic phrase
    [
      { degree: 0, duration: 4, velocity: 0.55 },
      { degree: 2, duration: 4, velocity: 0.5 },
      { degree: 4, duration: 4, velocity: 0.55 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
  ],
};

// UK garage: the 2-step syncopated sub — skips the grid, answers late
const UKG_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 3, velocity: 0 },
    ],
  ],
};

const UKG_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Warm shuttling chords — the garage wipe
    [
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.5 },
    ],
  ],
};

const UKG_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Vocal-ishlick — syncopated, singable
    [
      { degree: 4, duration: 3, velocity: 0.6 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 4, velocity: 0.6 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
  ],
};

// Jersey club: the triple-kick answer — bass punctuates between the kicks
const JERSEY_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const JERSEY_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // The club stab — short, chopped
    [
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 8, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 3, velocity: 0 },
    ],
  ],
};

const JERSEY_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Chopped vocal-feel hook
    [
      { degree: 0, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 5, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 6, velocity: 0 },
    ],
  ],
};

// Trap classic: the 808 slide — long gliding root notes, sparse and deep
const TRAP808_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 6, velocity: 0.95 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 6, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    [
      { degree: 0, duration: 4, velocity: 0.95 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 4, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 4, velocity: 0.9 },
    ],
  ],
};

const TRAP808_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Dark sparse bell-ish pad
    [
      { degree: -1, duration: 6, velocity: 0 },
      { degree: 0, duration: 4, velocity: 0.5 },
      { degree: -1, duration: 6, velocity: 0 },
    ],
  ],
};

const TRAP808_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Dark bell hook — sparse, ringing
    [
      { degree: 0, duration: 3, velocity: 0.6 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 4, duration: 3, velocity: 0.55 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 2, duration: 4, velocity: 0.55 },
    ],
  ],
};

// UK drill: the sliding 808 answer — the root slides up a half-step feel
const DRILL_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 5, velocity: 0.95 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 6, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    [
      { degree: 0, duration: 4, velocity: 0.95 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 4, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const DRILL_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Dark sliding pad
    [
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 6, velocity: 0.45 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.4 },
    ],
  ],
};

const DRILL_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Dark sliding hook
    [
      { degree: 0, duration: 3, velocity: 0.6 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 3, velocity: 0.5 },
      { degree: -1, duration: 3, velocity: 0 },
    ],
  ],
};

// Acid techno: the 303 — accented 16ths with octave jumps
const ACID_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 1, velocity: 0.95 },
      { degree: 0, duration: 1, velocity: 0.6 },
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: 4, duration: 1, velocity: 0.85 },
      { degree: 0, duration: 1, velocity: 0.6 },
      { degree: 0, duration: 1, velocity: 0.9 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.7 },
      { degree: 0, duration: 1, velocity: 0.65 },
      { degree: 0, duration: 1, velocity: 0.9 },
      { degree: 5, duration: 1, velocity: 0.75 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: 4, duration: 1, velocity: 0.85 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.6 },
    ],
  ],
};

const ACID_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Sparse stabs — the 303 carries the identity
    [
      { degree: -1, duration: 8, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 6, velocity: 0 },
    ],
  ],
};

const ACID_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Screaming 303 line up top
    [
      { degree: 0, duration: 1, velocity: 0.75 },
      { degree: 4, duration: 1, velocity: 0.65 },
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: 5, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: 4, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 6, velocity: 0 },
    ],
  ],
};

// Bass house: the wobble stab — syncopated bass stabs between the kicks
const BASSHOUSE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 2, velocity: 0.95 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.8 },
      { degree: 4, duration: 1, velocity: 0.75 },
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 1, velocity: 0.75 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const BASSHOUSE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    [
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 6, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const BASSHOUSE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Vocal-chop style hook
    [
      { degree: 0, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
  ],
};

// Country pop: the boom-chicka — root and fifth alternating, honest and warm
const COUNTRY_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    [
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 4, duration: 2, velocity: 0.65 },
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: 5, duration: 2, velocity: 0.65 },
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: 4, duration: 2, velocity: 0.65 },
      { degree: 3, duration: 2, velocity: 0.6 },
      { degree: 0, duration: 2, velocity: 0.75 },
    ],
  ],
};

const COUNTRY_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Warm acoustic strum feel
    [
      { degree: 0, duration: 4, velocity: 0.55 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.5 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
  ],
};

const COUNTRY_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Pentatonic twinkle — the country lead language
    [
      { degree: 4, duration: 2, velocity: 0.6 },
      { degree: 5, duration: 2, velocity: 0.55 },
      { degree: 4, duration: 2, velocity: 0.55 },
      { degree: 2, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 4, velocity: 0.55 },
    ],
  ],
};

// Kuduro: the carnival punch — percussive root stabs, fast and dry
const KUDURO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 1, velocity: 0.95 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.9 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.75 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const KUDURO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Carnival whistle-feel stab
    [
      { degree: -1, duration: 6, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 5, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const KUDURO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Half-time rap-feel phrase over the frantic floor
    [
      { degree: 0, duration: 4, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 4, velocity: 0.55 },
    ],
  ],
};

// Tropical: the soft round beach bass — warm, rounded, patient
const TROPICAL_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 3, velocity: 0.8 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 4, velocity: 0.75 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.7 },
    ],
    [
      { degree: 0, duration: 4, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 4, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.7 },
    ],
  ],
};

const TROPICAL_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Steel-pan flavored bright stabs
    [
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 6, velocity: 0 },
    ],
  ],
};

const TROPICAL_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // The pan-flute melody — pentatonic sunshine
    [
      { degree: 4, duration: 3, velocity: 0.6 },
      { degree: 2, duration: 3, velocity: 0.55 },
      { degree: 0, duration: 4, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 4, velocity: 0.55 },
    ],
  ],
};

// Liquid dnb: the long warm rolling — soulful, patient under the fast break
const LIQUID_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 6, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.75 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
    [
      { degree: 0, duration: 4, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 6, velocity: 0.75 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.7 },
    ],
  ],
};

const LIQUID_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Soulful Rhodes-feel pads
    [
      { degree: 0, duration: 6, velocity: 0.5 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 6, velocity: 0.45 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const LIQUID_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Liquid soul line — smooth and singing
    [
      { degree: 4, duration: 3, velocity: 0.6 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.55 },
      { degree: 0, duration: 4, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 4, velocity: 0.55 },
    ],
  ],
};

// Tech house: the wobbly stab — off-grid bass stabs with groove
const TECHHOUSE_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.75 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 1, velocity: 0.75 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.8 },
      { degree: -1, duration: 3, velocity: 0 },
    ],
  ],
};

const TECHHOUSE_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    [
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 8, velocity: 0 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const TECHHOUSE_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Sparse funk licks
    [
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 6, velocity: 0 },
    ],
  ],
};

// ── Melodic dialects (dnb depth wave 2 — the remaining seven voices) ──────

// Two-step: the snap — bass skips the grid with the break, short and tight
const TWOSTEP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 3, duration: 1, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const TWOSTEP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    [
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.45 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const TWOSTEP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    [
      { degree: 4, duration: 3, velocity: 0.6 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 2, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 4, velocity: 0.55 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
  ],
};

// Roller: the smooth roll — even 8th root drive, hypnotic, never busy
const ROLLER_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: 4, duration: 2, velocity: 0.75 },
      { degree: 4, duration: 2, velocity: 0.65 },
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: 0, duration: 2, velocity: 0.7 },
    ],
    [
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: 3, duration: 2, velocity: 0.7 },
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: 0, duration: 2, velocity: 0.85 },
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: 5, duration: 2, velocity: 0.7 },
      { degree: 4, duration: 2, velocity: 0.7 },
    ],
  ],
};

const ROLLER_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Pad swells — long, dark, supportive
    [
      { degree: 0, duration: 8, velocity: 0.45 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 6, velocity: 0.4 },
    ],
  ],
};

const ROLLER_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Hypnotic minor motif — repeats with small changes
    [
      { degree: 0, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.5 },
      { degree: 4, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.55 },
    ],
  ],
};

// Amen chop: the bass follows the chop — syncopated with ghost movement
const AMENCHOP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 3, velocity: 0.9 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.75 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.75 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const AMENCHOP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Ragga stab feel
    [
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 6, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 4, velocity: 0 },
    ],
  ],
};

const AMENCHOP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Ragga toast-feel phrase
    [
      { degree: 0, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 3, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 3, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 3, velocity: 0 },
    ],
  ],
};

// Neuro: the reese — long dark growling notes, semitone-adjacent tension
const NEURO_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 6, velocity: 0.95 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 6, duration: 6, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
    [
      { degree: 0, duration: 4, velocity: 0.95 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 4, velocity: 0.85 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 6, duration: 4, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const NEURO_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Dark techy stabs, mechanical
    [
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.6 },
      { degree: -1, duration: 6, velocity: 0 },
      { degree: -1, duration: 3, velocity: 0 },
      { degree: 5, duration: 1, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const NEURO_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // Techy growl line — mechanical, angular
    [
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 6, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 5, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

// Jump-up: the wobble stab — bouncy punchy stabs built for the skip
const JUMPUP_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 2, velocity: 0.95 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 1, velocity: 0.8 },
      { degree: -1, duration: 1, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const JUMPUP_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    [
      { degree: -1, duration: 6, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.6 },
      { degree: -1, duration: 8, velocity: 0 },
    ],
  ],
};

const JUMPUP_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // The bouncywarrior hook — short stabs, big spaces
    [
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 4, duration: 2, velocity: 0.65 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.7 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

// Dancefloor: the anthemic drive — wide jumps, big and even
const DANCEFLOOR_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: 0, duration: 2, velocity: 0.75 },
      { degree: 4, duration: 2, velocity: 0.85 },
      { degree: 4, duration: 2, velocity: 0.7 },
      { degree: 0, duration: 2, velocity: 0.9 },
      { degree: 0, duration: 2, velocity: 0.75 },
      { degree: 5, duration: 2, velocity: 0.8 },
      { degree: 5, duration: 2, velocity: 0.7 },
    ],
  ],
};

const DANCEFLOOR_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Big anthemic swells
    [
      { degree: 0, duration: 8, velocity: 0.55 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 4, duration: 6, velocity: 0.5 },
    ],
  ],
};

const DANCEFLOOR_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // The festival hook — wide, singable, confident
    [
      { degree: 4, duration: 4, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 2, duration: 4, velocity: 0.6 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 4, velocity: 0.65 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

// ── Melodic dialects (gabber — the kick carries the low end) ──────────────

// Gabber bass: dark and sparse — the distorted kick owns the low register,
// the bass only anchors the half-bar. Screechy hoover lead is the genre voice.
const GABBER_BASS: MelodicPatternData = {
  role: "bass",
  octaveOffset: 0,
  sequences: [
    [
      { degree: 0, duration: 8, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 0, duration: 6, velocity: 0.75 },
    ],
    [
      { degree: 0, duration: 8, velocity: 0.8 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 6, duration: 6, velocity: 0.7 },
    ],
  ],
};

const GABBER_CHORD: MelodicPatternData = {
  role: "chord",
  octaveOffset: 1,
  sequences: [
    // Dark minor stabs on the half-bar, menace over the stomp
    [
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.55 },
      { degree: -1, duration: 6, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.5 },
      { degree: -1, duration: 2, velocity: 0 },
    ],
  ],
};

const GABBER_LEAD: MelodicPatternData = {
  role: "lead",
  octaveOffset: 2,
  sequences: [
    // The hoover screech — short aggressive phrases with a descending tail
    [
      { degree: 0, duration: 1, velocity: 0.85 },
      { degree: 0, duration: 1, velocity: 0.8 },
      { degree: 6, duration: 2, velocity: 0.75 },
      { degree: -1, duration: 2, velocity: 0 },
      { degree: 6, duration: 2, velocity: 0.8 },
      { degree: -1, duration: 8, velocity: 0 },
    ],
    [
      { degree: 3, duration: 2, velocity: 0.8 },
      { degree: 3, duration: 1, velocity: 0.75 },
      { degree: 2, duration: 1, velocity: 0.7 },
      { degree: -1, duration: 4, velocity: 0 },
      { degree: 0, duration: 2, velocity: 0.75 },
      { degree: -1, duration: 6, velocity: 0 },
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
