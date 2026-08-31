/* eslint-disable */
/**
 * VENDORED from VocalForge_DAW/plugins/fxeq. Do not edit by hand — this is a
 * byte-faithful copy of the upstream DSP oracle so Pulse Forge and VocalForge
 * validate against the SAME golden fixtures (tests/fxeq-golden/). Fix DSP
 * issues upstream, then re-vendor via scripts/vendor-fxeq.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// FXEQ — Presets
//
// Each preset is a partial parameter map (only non-default values).
// `applyPreset()` merges a preset onto the processor's defaults.
// `randomizePreset()` generates a musically sane random configuration.
//
// Versioning:
//   SCHEMA_VERSION 1 = v1 shared-crossover topology (frozen for migration).
//   The production v2 target replaces this with per-lane EQ-paint masks.
// ═══════════════════════════════════════════════════════════

/** Current preset/parameter schema version. v1 = shared-crossover topology. */
export const SCHEMA_VERSION = 1 as const;

/** Label identifying the v1 shared-crossover topology in golden fixtures. */
export const V1_TOPOLOGY_LABEL = "v1-shared-crossover" as const;

export interface FxEqPreset {
  id: string;
  name: string;
  category: PresetCategory;
  /** Optional subcategory for hierarchical browsing. */
  subcategory?: string;
  /** Tags for search filtering: instrument, genre, mood. */
  tags?: string[];
  params: Record<string, number>;
  /** Schema version this preset targets. Defaults to 1 for legacy presets. */
  schemaVersion?: number;
}

export type PresetCategory =
  | "Saturation"
  | "Lo-Fi"
  | "Modulation"
  | "Reverb"
  | "Delay"
  | "Combined";

// Helpers to set a module across bands concisely.
function setBandModule(bands: number[], key: string, params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  for (const b of bands) {
    for (const k of Object.keys(params)) {
      out[`band${b}.${key}${cap(k)}`] = params[k];
    }
  }
  return out;
}

export const FXEQ_PRESETS: readonly FxEqPreset[] = [
  // ═════════════════ SATURATION ═════════════════
  {
    id: "warmth-allround",
    name: "Warmth — All-Round",
    category: "Saturation",
    params: { ...setBandModule([2, 3, 4], "sat", { enabled: 1, driveDb: 4, mode: 1, mix: 60 }) },
  },
  {
    id: "tape-bass",
    name: "Tape Bass Crunch",
    category: "Saturation",
    params: {
      bandCount: 4,
      ...setBandModule([1], "sat", { enabled: 1, driveDb: 12, mode: 2, mix: 80 }),
      ...setBandModule([2], "sat", { enabled: 1, driveDb: 6, mode: 2, mix: 40 }),
    },
  },
  {
    id: "aggressive-drums",
    name: "Aggressive Drums",
    category: "Saturation",
    params: { ...setBandModule([4, 5, 6], "sat", { enabled: 1, driveDb: 10, mode: 4, mix: 50 }) },
  },
  {
    id: "soft-tube-warmth",
    name: "Soft Tube Warmth",
    category: "Saturation",
    params: {
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 3, mode: 1, mix: 45, outputDb: -1 }),
    },
  },
  {
    id: "tube-vocal-glue",
    name: "Tube Vocal Glue",
    category: "Saturation",
    params: {
      ...setBandModule([3, 4], "sat", { enabled: 1, driveDb: 5, mode: 6, mix: 55 }),
    },
  },
  {
    id: "hard-clip-ceiling",
    name: "Hard Clip Ceiling",
    category: "Saturation",
    params: {
      ...setBandModule([5, 6], "sat", { enabled: 1, driveDb: 8, mode: 3, mix: 70 }),
      limiterEnabled: 1,
      limiterCeilDb: -1,
    },
  },
  {
    id: "fuzz-bass-mayhem",
    name: "Fuzz Bass Mayhem",
    category: "Saturation",
    params: {
      bandCount: 4,
      ...setBandModule([1], "sat", { enabled: 1, driveDb: 18, mode: 4, mix: 75 }),
      ...setBandModule([2], "sat", { enabled: 1, driveDb: 8, mode: 4, mix: 30 }),
    },
  },
  {
    id: "diode-bridge",
    name: "Diode Bridge Warmth",
    category: "Saturation",
    params: {
      ...setBandModule([2, 3, 4], "sat", { enabled: 1, driveDb: 6, mode: 7, mix: 50 }),
    },
  },
  {
    id: "valve-console",
    name: "Valve Console Emulation",
    category: "Saturation",
    params: {
      ...setBandModule([1, 2, 3, 4, 5], "sat", { enabled: 1, driveDb: 3, mode: 6, mix: 35 }),
    },
  },
  {
    id: "harmonic-enhancer",
    name: "Harmonic Enhancer",
    category: "Saturation",
    params: {
      ...setBandModule([4, 5, 6], "sat", { enabled: 1, driveDb: 5, mode: 0, mix: 45 }),
    },
  },
  {
    id: "warm-master-buss",
    name: "Warm Master Buss",
    category: "Saturation",
    params: {
      ...setBandModule([3, 4], "sat", { enabled: 1, driveDb: 2, mode: 1, mix: 40 }),
      ...setBandModule([1, 2], "sat", { enabled: 1, driveDb: 4, mode: 2, mix: 35 }),
      limiterEnabled: 1,
      limiterCeilDb: -0.5,
    },
  },
  {
    id: "crunch-guitar-amp",
    name: "Crunch Guitar Amp",
    category: "Saturation",
    params: {
      bandCount: 4,
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 14, mode: 5, mix: 80 }),
      ...setBandModule([4], "sat", { enabled: 1, driveDb: 10, mode: 4, mix: 60 }),
    },
  },

  // ═════════════════ LO-FI ═════════════════
  {
    id: "vintage-lofi",
    name: "Vintage Lo-Fi",
    category: "Lo-Fi",
    params: {
      ...setBandModule([1, 2, 3], "lofi", { enabled: 1, mode: 1, amount: 35, mix: 70 }),
      ...setBandModule([5, 6], "lofi", { enabled: 1, mode: 0, amount: 25, mix: 50 }),
    },
  },
  {
    id: "vinyl-crackle",
    name: "Vinyl Crackle & Wow",
    category: "Lo-Fi",
    params: {
      ...setBandModule([1, 2, 3], "lofi", { enabled: 1, mode: 2, amount: 45, mix: 60 }),
      ...setBandModule([4, 5], "lofi", { enabled: 1, mode: 3, amount: 50, mix: 60 }),
    },
  },
  {
    id: "8bit-chiptune",
    name: "8-Bit Chiptune",
    category: "Lo-Fi",
    params: {
      ...setBandModule([1, 2, 3, 4, 5], "lofi", { enabled: 1, mode: 0, amount: 70, mix: 90 }),
    },
  },
  {
    id: "cassette-tape-hiss",
    name: "Cassette Tape Hiss",
    category: "Lo-Fi",
    params: {
      ...setBandModule([1, 2, 3], "lofi", { enabled: 1, mode: 3, amount: 30, mix: 55 }),
      ...setBandModule([4, 5], "lofi", { enabled: 1, mode: 1, amount: 20, mix: 40 }),
    },
  },
  {
    id: "warped-vinyl",
    name: "Warped Vinyl Drone",
    category: "Lo-Fi",
    params: {
      ...setBandModule([1, 2, 3, 4], "lofi", { enabled: 1, mode: 2, amount: 55, mix: 75 }),
    },
  },
  {
    id: "sample-rate-degrade",
    name: "Sample Rate Degradation",
    category: "Lo-Fi",
    params: {
      ...setBandModule([2, 3, 4], "lofi", { enabled: 1, mode: 1, amount: 50, mix: 80 }),
    },
  },
  {
    id: "phone-filter-lofi",
    name: "Old Phone Line",
    category: "Lo-Fi",
    params: {
      bandCount: 4,
      ...setBandModule([2, 3], "lofi", { enabled: 1, mode: 0, amount: 60, mix: 85 }),
      ...setBandModule([2, 3], "lofi", { enabled: 1, mode: 1, amount: 40, mix: 60 }),
    },
  },
  {
    id: "lofi-hiphop",
    name: "Lo-Fi Hip Hop",
    category: "Lo-Fi",
    params: {
      ...setBandModule([1, 2], "lofi", { enabled: 1, mode: 2, amount: 35, mix: 50 }),
      ...setBandModule([3, 4], "lofi", { enabled: 1, mode: 1, amount: 30, mix: 45 }),
      ...setBandModule([1, 2], "sat", { enabled: 1, driveDb: 5, mode: 2, mix: 40 }),
    },
  },

  // ═════════════════ MODULATION ═════════════════
  {
    id: "lush-chorus",
    name: "Lush Stereo Chorus",
    category: "Modulation",
    params: {
      ...setBandModule([3, 4, 5], "mod", { enabled: 1, type: 0, rate: 0.6, depth: 60, mix: 50 }),
    },
  },
  {
    id: "psychedelic-phaser",
    name: "Psychedelic Phaser",
    category: "Modulation",
    params: {
      ...setBandModule([2, 3, 4], "mod", { enabled: 1, type: 2, rate: 0.3, depth: 80, feedback: 0.5, mix: 60 }),
    },
  },
  {
    id: "through-zero-flange",
    name: "Through-Zero Flange",
    category: "Modulation",
    params: {
      ...setBandModule([4, 5, 6], "mod", { enabled: 1, type: 1, rate: 0.4, depth: 90, feedback: 0.7, mix: 55 }),
    },
  },
  {
    id: "doubler-vocal",
    name: "Vocal ADT Doubler",
    category: "Modulation",
    params: {
      ...setBandModule([3, 4], "mod", { enabled: 1, type: 3, rate: 0.1, depth: 20, mix: 40 }),
    },
  },
  {
    id: "slow-chorus-pad",
    name: "Slow Chorus Pad",
    category: "Modulation",
    params: {
      ...setBandModule([1, 2, 3, 4], "mod", { enabled: 1, type: 0, rate: 0.2, depth: 50, mix: 45 }),
    },
  },
  {
    id: "fast-flanger-lead",
    name: "Fast Flanger Lead",
    category: "Modulation",
    params: {
      ...setBandModule([4, 5, 6], "mod", { enabled: 1, type: 1, rate: 2.5, depth: 85, feedback: 0.6, mix: 50 }),
    },
  },
  {
    id: "deep-phaser-bass",
    name: "Deep Phaser Bass",
    category: "Modulation",
    params: {
      bandCount: 4,
      ...setBandModule([1, 2], "mod", { enabled: 1, type: 2, rate: 0.15, depth: 90, feedback: 0.7, mix: 65 }),
    },
  },
  {
    id: "ensemble-strings",
    name: "String Ensemble",
    category: "Modulation",
    params: {
      ...setBandModule([3, 4, 5, 6], "mod", { enabled: 1, type: 0, rate: 0.8, depth: 45, mix: 55 }),
      ...setBandModule([3, 4, 5, 6], "mod", { enabled: 1, type: 3, rate: 0.15, depth: 15, mix: 30 }),
    },
  },
  {
    id: "rotary-speaker",
    name: "Rotary Speaker Sim",
    category: "Modulation",
    params: {
      ...setBandModule([3, 4], "mod", { enabled: 1, type: 1, rate: 1.2, depth: 40, feedback: 0.3, mix: 50 }),
      ...setBandModule([5, 6], "mod", { enabled: 1, type: 2, rate: 0.8, depth: 60, feedback: 0.2, mix: 45 }),
    },
  },
  {
    id: "widener-stereo",
    name: "Stereo Widener",
    category: "Modulation",
    params: {
      ...setBandModule([4, 5, 6], "mod", { enabled: 1, type: 3, rate: 0.05, depth: 10, mix: 35 }),
    },
  },

  // ═════════════════ REVERB ═════════════════
  {
    id: "dreamy-plate",
    name: "Dreamy Plate Verb",
    category: "Reverb",
    params: {
      ...setBandModule([4, 5, 6], "rev", { enabled: 1, type: 0, decayMs: 2500, mix: 35 }),
    },
  },
  {
    id: "ambient-hall",
    name: "Ambient Hall Wash",
    category: "Reverb",
    params: {
      ...setBandModule([3, 4, 5, 6], "rev", { enabled: 1, type: 1, decayMs: 5000, mix: 45 }),
    },
  },
  {
    id: "spring-tank",
    name: "Spring Tank Drip",
    category: "Reverb",
    params: {
      ...setBandModule([3, 4], "rev", { enabled: 1, type: 2, decayMs: 800, mix: 40 }),
    },
  },
  {
    id: "cathedral-verb",
    name: "Cathedral Immersion",
    category: "Reverb",
    params: {
      ...setBandModule([2, 3, 4, 5, 6], "rev", { enabled: 1, type: 1, decayMs: 7000, mix: 55 }),
    },
  },
  {
    id: "plate-vocal",
    name: "Vocal Plate Space",
    category: "Reverb",
    params: {
      ...setBandModule([3, 4], "rev", { enabled: 1, type: 0, decayMs: 1800, mix: 30 }),
    },
  },
  {
    id: "room-ambience",
    name: "Tight Room Ambience",
    category: "Reverb",
    params: {
      ...setBandModule([3, 4, 5], "rev", { enabled: 1, type: 0, decayMs: 600, mix: 20 }),
    },
  },
  {
    id: "spring-surf",
    name: "Surf Spring Splash",
    category: "Reverb",
    params: {
      ...setBandModule([4, 5], "rev", { enabled: 1, type: 2, decayMs: 1200, mix: 50 }),
    },
  },
  {
    id: "shimmer-reverb",
    name: "Shimmer Reverb Tail",
    category: "Reverb",
    params: {
      ...setBandModule([5, 6], "rev", { enabled: 1, type: 1, decayMs: 6000, mix: 50 }),
      ...setBandModule([5, 6], "mod", { enabled: 1, type: 0, rate: 0.3, depth: 40, mix: 30 }),
    },
  },
  {
    id: "reverse-reverb",
    name: "Reverse Reverb Swell",
    category: "Reverb",
    params: {
      ...setBandModule([3, 4, 5, 6], "rev", { enabled: 1, type: 1, decayMs: 3500, mix: 60 }),
    },
  },

  // ═════════════════ DELAY ═════════════════
  {
    id: "slapback-vocals",
    name: "Vocal Slapback",
    category: "Delay",
    params: {
      ...setBandModule([3, 4], "delay", { enabled: 1, type: 0, timeMs: 120, feedback: 0.15, mix: 25 }),
    },
  },
  {
    id: "tape-echo",
    name: "Tape Echo Wobble",
    category: "Delay",
    params: {
      ...setBandModule([2, 3], "delay", { enabled: 1, type: 1, timeMs: 350, feedback: 0.45, mix: 35 }),
    },
  },
  {
    id: "pingpong-drums",
    name: "Ping-Pong Drums",
    category: "Delay",
    params: {
      ...setBandModule([5, 6], "delay", { enabled: 1, type: 2, timeMs: 280, feedback: 0.5, mix: 30 }),
    },
  },
  {
    id: "dub-delay",
    name: "Dub Echo Throw",
    category: "Delay",
    params: {
      ...setBandModule([4, 5], "delay", { enabled: 1, type: 3, timeMs: 450, feedback: 0.7, mix: 45, dampHz: 2500 }),
    },
  },
  {
    id: "analog-warmth-delay",
    name: "Analog Warm Delay",
    category: "Delay",
    params: {
      ...setBandModule([2, 3, 4], "delay", { enabled: 1, type: 3, timeMs: 300, feedback: 0.4, mix: 30, dampHz: 1800 }),
    },
  },
  {
    id: "digital-precision",
    name: "Digital Precision Delay",
    category: "Delay",
    params: {
      ...setBandModule([5, 6], "delay", { enabled: 1, type: 0, timeMs: 200, feedback: 0.35, mix: 25, dampHz: 12000 }),
    },
  },
  {
    id: "quarter-note-throw",
    name: "Quarter Note Throw",
    category: "Delay",
    params: {
      ...setBandModule([4, 5, 6], "delay", { enabled: 1, type: 1, timeMs: 500, feedback: 0.55, mix: 35, dampHz: 3500 }),
    },
  },
  {
    id: "multi-tap-spread",
    name: "Multi-Tap Stereo Spread",
    category: "Delay",
    params: {
      ...setBandModule([3], "delay", { enabled: 1, type: 0, timeMs: 180, feedback: 0.3, mix: 30 }),
      ...setBandModule([5], "delay", { enabled: 1, type: 2, timeMs: 320, feedback: 0.4, mix: 30 }),
    },
  },

  // ═════════════════ VOCAL ═════════════════
  {
    id: "vocal-lead",
    name: "Vocal — Lead",
    category: "Combined",
    params: {
      bandCount: 6,
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 3, mode: 1, mix: 35 }),
      ...setBandModule([3], "rev", { enabled: 1, type: 0, decayMs: 1200, mix: 18 }),
      ...setBandModule([4], "mod", { enabled: 1, type: 0, rate: 0.3, depth: 15, mix: 12 }),
    },
  },
  {
    id: "vocal-backing",
    name: "Vocal — Backing",
    category: "Combined",
    params: {
      bandCount: 6,
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 2, mode: 0, mix: 25 }),
      ...setBandModule([3, 4], "rev", { enabled: 1, type: 0, decayMs: 1800, mix: 22 }),
      ...setBandModule([5], "delay", { enabled: 1, type: 0, timeMs: 120, feedback: 0.25, mix: 15 }),
    },
  },
  {
    id: "vocal-spoken",
    name: "Vocal — Spoken Word",
    category: "Combined",
    params: {
      bandCount: 6,
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 4, mode: 1, mix: 40 }),
      ...setBandModule([1], "rev", { enabled: 1, type: 2, decayMs: 400, mix: 12 }),
    },
  },
  {
    id: "vocal-podcast",
    name: "Vocal — Podcast",
    category: "Combined",
    params: {
      bandCount: 6,
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 3, mode: 1, mix: 30 }),
      ...setBandModule([4], "lofi", { enabled: 1, mode: 0, amount: 15, mix: 20 }),
    },
  },
  // ═════════════════ DRUMS ═════════════════
  {
    id: "drums-kick",
    name: "Drums — Kick Shaping",
    category: "Combined",
    params: {
      bandCount: 4,
      ...setBandModule([1], "sat", { enabled: 1, driveDb: 8, mode: 4, mix: 60 }),
      ...setBandModule([2], "sat", { enabled: 1, driveDb: 5, mode: 1, mix: 40 }),
    },
  },
  {
    id: "drums-snare",
    name: "Drums — Snare Crack",
    category: "Combined",
    params: {
      bandCount: 4,
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 6, mode: 4, mix: 50 }),
      ...setBandModule([3], "lofi", { enabled: 1, mode: 1, amount: 20, mix: 30 }),
    },
  },
  {
    id: "drums-overhead",
    name: "Drums — Overhead Air",
    category: "Combined",
    params: {
      bandCount: 4,
      ...setBandModule([3, 4], "sat", { enabled: 1, driveDb: 2, mode: 0, mix: 20 }),
      ...setBandModule([4], "rev", { enabled: 1, type: 0, decayMs: 800, mix: 15 }),
    },
  },
  // ═════════════════ MASTER ═════════════════
  {
    id: "master-subtle",
    name: "Master — Subtle Enhancement",
    category: "Combined",
    params: {
      bandCount: 6,
      ...setBandModule([2, 3, 4], "sat", { enabled: 1, driveDb: 1, mode: 0, mix: 20 }),
      limiterEnabled: 1,
      limiterCeilDb: -0.3,
    },
  },
  {
    id: "master-loudness",
    name: "Master — Loudness",
    category: "Combined",
    params: {
      bandCount: 6,
      ...setBandModule([2, 3, 4], "sat", { enabled: 1, driveDb: 3, mode: 1, mix: 30 }),
      limiterEnabled: 1,
      limiterCeilDb: -0.1,
    },
  },
  {
    id: "master-analog",
    name: "Master — Analog Warmth",
    category: "Combined",
    params: {
      bandCount: 6,
      ...setBandModule([2, 3, 4], "sat", { enabled: 1, driveDb: 2, mode: 2, mix: 35 }),
      limiterEnabled: 1,
      limiterCeilDb: -0.3,
    },
  },
  // ═════════════════ SYNTH ═════════════════
  {
    id: "synth-lofi",
    name: "Synth — Lo-Fi",
    category: "Combined",
    params: {
      bandCount: 4,
      ...setBandModule([2, 3], "lofi", { enabled: 1, mode: 2, amount: 40, mix: 60 }),
      ...setBandModule([3], "delay", { enabled: 1, type: 1, timeMs: 200, feedback: 0.3, mix: 25 }),
    },
  },
  {
    id: "synth-aggressive",
    name: "Synth — Aggressive",
    category: "Combined",
    params: {
      bandCount: 4,
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 15, mode: 4, mix: 70 }),
      ...setBandModule([3], "rev", { enabled: 1, type: 1, decayMs: 2500, mix: 20 }),
    },
  },
  {
    id: "synth-ethereal",
    name: "Synth — Ethereal",
    category: "Combined",
    params: {
      bandCount: 4,
      ...setBandModule([2, 3], "mod", { enabled: 1, type: 0, rate: 0.5, depth: 40, mix: 40 }),
      ...setBandModule([3, 4], "rev", { enabled: 1, type: 1, decayMs: 4000, mix: 35 }),
    },
  },
  // ═════════════════ GUITAR ═════════════════
  {
    id: "guitar-clean",
    name: "Guitar — Clean",
    category: "Combined",
    params: {
      bandCount: 4,
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 2, mode: 0, mix: 25 }),
      ...setBandModule([3], "rev", { enabled: 1, type: 0, decayMs: 1500, mix: 18 }),
    },
  },
  {
    id: "guitar-crunch",
    name: "Guitar — Crunch",
    category: "Combined",
    params: {
      bandCount: 4,
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 8, mode: 1, mix: 55 }),
      ...setBandModule([3], "rev", { enabled: 1, type: 0, decayMs: 1000, mix: 15 }),
    },
  },
  {
    id: "guitar-highgain",
    name: "Guitar — High-Gain",
    category: "Combined",
    params: {
      bandCount: 4,
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 14, mode: 4, mix: 65 }),
      ...setBandModule([3], "rev", { enabled: 1, type: 1, decayMs: 2000, mix: 12 }),
    },
  },
  {
    id: "guitar-ambient",
    name: "Guitar — Ambient",
    category: "Combined",
    params: {
      bandCount: 4,
      ...setBandModule([2, 3], "mod", { enabled: 1, type: 0, rate: 0.4, depth: 50, mix: 45 }),
      ...setBandModule([3, 4], "rev", { enabled: 1, type: 1, decayMs: 4500, mix: 40 }),
      ...setBandModule([4], "delay", { enabled: 1, type: 1, timeMs: 350, feedback: 0.4, mix: 30 }),
    },
  },
  // ═════════════════ COMBINED ═════════════════
  {
    id: "washed-synth",
    name: "Washed-Out Synth",
    category: "Combined",
    params: {
      ...setBandModule([1, 2], "sat", { enabled: 1, driveDb: 8, mode: 1, mix: 50 }),
      ...setBandModule([3, 4, 5], "mod", { enabled: 1, type: 0, rate: 0.5, depth: 70, mix: 60 }),
      ...setBandModule([5, 6], "rev", { enabled: 1, type: 1, decayMs: 4000, mix: 40 }),
    },
  },
  {
    id: "crunch-master",
    name: "Crunch Mix Master",
    category: "Combined",
    params: {
      ...setBandModule([3, 4], "sat", { enabled: 1, driveDb: 5, mode: 0, mix: 40 }),
      ...setBandModule([5, 6], "sat", { enabled: 1, driveDb: 7, mode: 3, mix: 35 }),
      limiterEnabled: 1,
      limiterCeilDb: -0.5,
    },
  },
  {
    id: "dream-pop-wash",
    name: "Dream Pop Wash",
    category: "Combined",
    params: {
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 4, mode: 1, mix: 40 }),
      ...setBandModule([3, 4, 5], "mod", { enabled: 1, type: 0, rate: 0.4, depth: 55, mix: 50 }),
      ...setBandModule([5, 6], "rev", { enabled: 1, type: 0, decayMs: 3000, mix: 45 }),
      ...setBandModule([4, 5], "delay", { enabled: 1, type: 1, timeMs: 380, feedback: 0.4, mix: 25 }),
    },
  },
  {
    id: "industrial-distort",
    name: "Industrial Distortion",
    category: "Combined",
    params: {
      bandCount: 4,
      ...setBandModule([1, 2], "sat", { enabled: 1, driveDb: 16, mode: 4, mix: 70 }),
      ...setBandModule([3, 4], "sat", { enabled: 1, driveDb: 12, mode: 5, mix: 60 }),
      ...setBandModule([3, 4], "lofi", { enabled: 1, mode: 0, amount: 40, mix: 50 }),
      limiterEnabled: 1,
      limiterCeilDb: -1,
    },
  },
  {
    id: "vintage-broadcast",
    name: "Vintage Broadcast",
    category: "Combined",
    params: {
      ...setBandModule([1, 2, 3, 4, 5], "lofi", { enabled: 1, mode: 3, amount: 40, mix: 65 }),
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 5, mode: 2, mix: 50 }),
    },
  },
  {
    id: "ambient-cinematic",
    name: "Cinematic Ambient",
    category: "Combined",
    params: {
      ...setBandModule([1, 2], "sat", { enabled: 1, driveDb: 3, mode: 1, mix: 35 }),
      ...setBandModule([3, 4, 5, 6], "rev", { enabled: 1, type: 1, decayMs: 6000, mix: 50 }),
      ...setBandModule([5, 6], "delay", { enabled: 1, type: 3, timeMs: 500, feedback: 0.6, mix: 30 }),
      ...setBandModule([3, 4], "mod", { enabled: 1, type: 0, rate: 0.15, depth: 40, mix: 35 }),
    },
  },
  {
    id: "lofi-chillhop",
    name: "Chillhop Downtempo",
    category: "Combined",
    params: {
      ...setBandModule([1, 2], "lofi", { enabled: 1, mode: 2, amount: 30, mix: 45 }),
      ...setBandModule([3, 4], "sat", { enabled: 1, driveDb: 4, mode: 2, mix: 35 }),
      ...setBandModule([5, 6], "delay", { enabled: 1, type: 1, timeMs: 300, feedback: 0.35, mix: 20 }),
    },
  },
  {
    id: "psychedelic-trip",
    name: "Psychedelic Trip",
    category: "Combined",
    params: {
      ...setBandModule([2, 3, 4], "mod", { enabled: 1, type: 2, rate: 0.25, depth: 85, feedback: 0.8, mix: 65 }),
      ...setBandModule([5, 6], "rev", { enabled: 1, type: 1, decayMs: 4500, mix: 50 }),
      ...setBandModule([4, 5], "delay", { enabled: 1, type: 2, timeMs: 400, feedback: 0.55, mix: 35 }),
    },
  },
  {
    id: "glitch-fx-machine",
    name: "Glitch FX Machine",
    category: "Combined",
    params: {
      ...setBandModule([1, 2], "lofi", { enabled: 1, mode: 0, amount: 55, mix: 75 }),
      ...setBandModule([3, 4], "delay", { enabled: 1, type: 2, timeMs: 150, feedback: 0.6, mix: 40 }),
      ...setBandModule([5, 6], "mod", { enabled: 1, type: 1, rate: 3, depth: 70, feedback: 0.65, mix: 45 }),
    },
  },
  {
    id: "warm-tape-master",
    name: "Warm Tape Mastering",
    category: "Combined",
    params: {
      ...setBandModule([1, 2], "sat", { enabled: 1, driveDb: 3, mode: 2, mix: 30 }),
      ...setBandModule([3, 4], "sat", { enabled: 1, driveDb: 2, mode: 1, mix: 25 }),
      ...setBandModule([1, 2, 3], "lofi", { enabled: 1, mode: 3, amount: 15, mix: 30 }),
      limiterEnabled: 1,
      limiterCeilDb: -0.3,
    },
  },
  {
    id: "vocal-production-suite",
    name: "Vocal Production Suite",
    category: "Combined",
    params: {
      ...setBandModule([3, 4], "sat", { enabled: 1, driveDb: 4, mode: 6, mix: 35 }),
      ...setBandModule([3, 4], "mod", { enabled: 1, type: 3, rate: 0.1, depth: 15, mix: 25 }),
      ...setBandModule([3, 4], "delay", { enabled: 1, type: 0, timeMs: 140, feedback: 0.2, mix: 20 }),
      ...setBandModule([4, 5], "rev", { enabled: 1, type: 0, decayMs: 2000, mix: 25 }),
    },
  },
  {
    id: "drum-bus-enhancer",
    name: "Drum Bus Enhancer",
    category: "Combined",
    params: {
      ...setBandModule([1], "sat", { enabled: 1, driveDb: 8, mode: 2, mix: 55 }),
      ...setBandModule([4, 5, 6], "sat", { enabled: 1, driveDb: 6, mode: 0, mix: 40 }),
      ...setBandModule([5, 6], "delay", { enabled: 1, type: 2, timeMs: 100, feedback: 0.15, mix: 15 }),
      limiterEnabled: 1,
      limiterCeilDb: -0.5,
    },
  },
  {
    id: "space-echo-dub",
    name: "Space Echo Dub",
    category: "Combined",
    params: {
      ...setBandModule([2, 3, 4], "delay", { enabled: 1, type: 1, timeMs: 400, feedback: 0.65, mix: 40, dampHz: 2200 }),
      ...setBandModule([5, 6], "rev", { enabled: 1, type: 2, decayMs: 1500, mix: 35 }),
      ...setBandModule([1, 2], "sat", { enabled: 1, driveDb: 5, mode: 2, mix: 35 }),
    },
  },
  {
    id: "ethereal-pads",
    name: "Ethereal Pad Generator",
    category: "Combined",
    params: {
      ...setBandModule([2, 3, 4, 5], "mod", { enabled: 1, type: 0, rate: 0.3, depth: 65, mix: 55 }),
      ...setBandModule([3, 4, 5, 6], "rev", { enabled: 1, type: 1, decayMs: 5500, mix: 55 }),
      ...setBandModule([4, 5], "delay", { enabled: 1, type: 3, timeMs: 450, feedback: 0.5, mix: 25 }),
    },
  },
  {
    id: "retro-soul-warmth",
    name: "Retro Soul Warmth",
    category: "Combined",
    params: {
      ...setBandModule([1, 2], "sat", { enabled: 1, driveDb: 6, mode: 1, mix: 45 }),
      ...setBandModule([3, 4], "sat", { enabled: 1, driveDb: 4, mode: 2, mix: 40 }),
      ...setBandModule([1, 2, 3], "lofi", { enabled: 1, mode: 3, amount: 20, mix: 35 }),
      ...setBandModule([4, 5], "rev", { enabled: 1, type: 0, decayMs: 1500, mix: 25 }),
    },
  },
  {
    id: "radio-destroyer",
    name: "Radio Destroyer",
    category: "Combined",
    params: {
      bandCount: 4,
      ...setBandModule([2, 3], "lofi", { enabled: 1, mode: 1, amount: 65, mix: 90 }),
      ...setBandModule([2, 3], "lofi", { enabled: 1, mode: 0, amount: 50, mix: 75 }),
      ...setBandModule([2, 3], "sat", { enabled: 1, driveDb: 8, mode: 5, mix: 50 }),
    },
  },
  {
    id: "shoegaze-wall",
    name: "Shoegaze Wall of Sound",
    category: "Combined",
    params: {
      ...setBandModule([1, 2], "sat", { enabled: 1, driveDb: 10, mode: 4, mix: 60 }),
      ...setBandModule([3, 4, 5, 6], "rev", { enabled: 1, type: 1, decayMs: 5000, mix: 60 }),
      ...setBandModule([3, 4, 5], "mod", { enabled: 1, type: 0, rate: 0.5, depth: 75, mix: 55 }),
      ...setBandModule([5, 6], "delay", { enabled: 1, type: 1, timeMs: 350, feedback: 0.5, mix: 30 }),
    },
  },
  {
    id: "clean-enhancer",
    name: "Clean Harmonic Enhancer",
    category: "Combined",
    params: {
      ...setBandModule([5, 6], "sat", { enabled: 1, driveDb: 3, mode: 0, mix: 30 }),
      ...setBandModule([4, 5], "sat", { enabled: 1, driveDb: 2, mode: 6, mix: 25 }),
      limiterEnabled: 1,
      limiterCeilDb: -0.3,
    },
  },
  {
    id: "analog-console-sim",
    name: "Analog Console Simulator",
    category: "Combined",
    params: {
      ...setBandModule([1, 2, 3, 4, 5, 6], "sat", { enabled: 1, driveDb: 2, mode: 1, mix: 30 }),
      ...setBandModule([1, 2], "lofi", { enabled: 1, mode: 3, amount: 10, mix: 20 }),
    },
  },
];

/**
 * Frozen manifest of all v1 preset IDs. This array is committed and must not
 * change without a schema version bump. Migration tests assert against it.
 */
export const V1_PRESET_IDS: readonly string[] = Object.freeze(
  FXEQ_PRESETS.map((p) => p.id),
);

export function getPresets(): readonly FxEqPreset[] {
  return FXEQ_PRESETS;
}

/**
 * Get presets filtered by category and optionally subcategory.
 * Returns presets matching the given category, sorted by name.
 */
export function getPresetsFiltered(
  category?: PresetCategory,
  subcategory?: string,
): readonly FxEqPreset[] {
  let filtered = FXEQ_PRESETS;
  if (category) filtered = filtered.filter((p) => p.category === category);
  if (subcategory) filtered = filtered.filter((p) => p.subcategory === subcategory);
  return filtered;
}

/**
 * Search presets by tag, name substring, or category.
 * Returns presets matching any of the search terms (case-insensitive).
 */
export function searchPresets(query: string): readonly FxEqPreset[] {
  const q = query.toLowerCase();
  return FXEQ_PRESETS.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      (p.subcategory?.toLowerCase().includes(q)) ||
      p.tags?.some((t) => t.toLowerCase().includes(q)),
  );
}

/**
 * Get unique subcategories for a given category.
 */
export function getSubcategories(category: PresetCategory): string[] {
  const subs = new Set<string>();
  for (const p of FXEQ_PRESETS) {
    if (p.category === category && p.subcategory) subs.add(p.subcategory);
  }
  return [...subs].sort();
}

/**
 * Get all unique tags across all presets.
 */
export function getAllTags(): string[] {
  const tags = new Set<string>();
  for (const p of FXEQ_PRESETS) {
    if (p.tags) for (const t of p.tags) tags.add(t);
  }
  return [...tags].sort();
}

// ── Export / Import ──────────────────────────────────────────

/** Metadata for exported preset files. */
interface ExportMetadata {
  version: string;
  exportedAt: string;
  pluginVersion: string;
}

/** Serialized preset file format. */
export interface PresetExportFile {
  metadata: ExportMetadata;
  presets: FxEqPreset[];
}

/** Export presets to a JSON string. */
export function exportPresets(presets: FxEqPreset[]): string {
  const file: PresetExportFile = {
    metadata: {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      pluginVersion: "1.0.0",
    },
    presets,
  };
  return JSON.stringify(file, null, 2);
}

/** Import presets from a JSON string. Returns the parsed presets or null on error. */
export function importPresets(json: string): FxEqPreset[] | null {
  try {
    const file = JSON.parse(json) as PresetExportFile;
    if (!file.presets || !Array.isArray(file.presets)) return null;
    // Validate each preset has required fields.
    return file.presets.filter(
      (p) =>
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        typeof p.category === "string" &&
        p.params &&
        typeof p.params === "object",
    );
  } catch {
    return null;
  }
}

/** Download a preset file (browser only). */
export function downloadPresets(presets: FxEqPreset[], filename = "fxeq-presets.json"): void {
  // Keep this core module usable by the Electron/native typecheck too. The
  // UI calls this in a browser, but the preset model is also imported by the
  // standalone host where DOM globals are intentionally not part of the
  // compiler lib.
  const browser = (globalThis as {
    document?: {
      createElement?: (tagName: string) => {
        href: string;
        download: string;
        click: () => void;
      };
    };
    URL?: {
      createObjectURL: (value: Blob) => string;
      revokeObjectURL: (url: string) => void;
    };
  });
  if (!browser.document?.createElement || !browser.URL) return;
  const json = exportPresets(presets);
  const blob = new Blob([json], { type: "application/json" });
  const url = browser.URL.createObjectURL(blob);
  const a = browser.document.createElement("a");
  if (!a || typeof a.click !== "function") {
    browser.URL.revokeObjectURL(url);
    return;
  }
  a.href = url;
  a.download = filename;
  a.click();
  browser.URL.revokeObjectURL(url);
}

/** Minimal browser File-compatible contract, without importing DOM types. */
export interface PresetFileLike {
  text(): Promise<string>;
}

/** Read a preset file from a File input (browser only). */
export async function readPresetFile(file: PresetFileLike): Promise<FxEqPreset[] | null> {
  try {
    return importPresets(await file.text());
  } catch {
    return null;
  }
}

/**
 * Generate a random but sane configuration: random crossover points,
 * 1–3 modules enabled on 1–4 bands with constrained ranges.
 */
export function randomizePreset(): Record<string, number> {
  const out: Record<string, number> = {};
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const bandCount = 4 + Math.floor(Math.random() * 3); // 4–6
  out["bandCount"] = bandCount;

  const moduleChoices = ["sat", "lofi", "mod", "delay", "rev"] as const;
  const moduleRanges: Record<string, Record<string, number>> = {
    sat: { enabled: 1, driveDb: 4 + Math.random() * 12, mode: Math.floor(Math.random() * 8), mix: 40 + Math.random() * 50 },
    lofi: { enabled: 1, mode: Math.floor(Math.random() * 4), amount: 20 + Math.random() * 50, mix: 40 + Math.random() * 40 },
    mod: { enabled: 1, type: Math.floor(Math.random() * 4), rate: 0.1 + Math.random() * 3, depth: 30 + Math.random() * 60, mix: 30 + Math.random() * 40 },
    delay: { enabled: 1, type: Math.floor(Math.random() * 4), timeMs: 80 + Math.random() * 400, feedback: 0.2 + Math.random() * 0.5, mix: 20 + Math.random() * 30 },
    rev: { enabled: 1, type: Math.floor(Math.random() * 3), decayMs: 500 + Math.random() * 4000, mix: 20 + Math.random() * 30 },
  };

  const moduleCount = 1 + Math.floor(Math.random() * 3); // 1–3 modules
  const shuffled = [...moduleChoices].sort(() => Math.random() - 0.5).slice(0, moduleCount);
  const bandCount2 = 1 + Math.floor(Math.random() * 3); // 1–4 bands active

  for (const key of shuffled) {
    const bands: number[] = [];
    const pool = Array.from({ length: bandCount }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    for (let i = 0; i < bandCount2; i++) bands.push(pool[i]);
    for (const b of bands) {
      const params = moduleRanges[key];
      for (const k of Object.keys(params)) {
        out[`band${b}.${key}${cap(k)}`] = params[k];
      }
    }
  }

  out["limiterEnabled"] = 1;
  return out;
}
