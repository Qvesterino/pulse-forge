import type { MelodicPatternData } from "../types";

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

// ── Registry ───────────────────────────────────────────

export const MELODIC_BY_GENRE: Record<string, MelodicPatternData[]> = {
  house: [HOUSE_BASS, HOUSE_CHORD, HOUSE_LEAD],
  techno: [TECHNO_BASS, TECHNO_CHORD, TECHNO_LEAD],
  trap: [TRAP_BASS, TRAP_CHORD, TRAP_LEAD],
  ambient: [AMBIENT_BASS, AMBIENT_CHORD, AMBIENT_LEAD],
};
