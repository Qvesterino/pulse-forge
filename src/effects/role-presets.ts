import type { EffectType, Track } from "../project-model/types";

/**
 * ROLE-AWARE LANDINGS (FX-ADD-REWORK-ROADMAP Wave B) — adding an effect
 * lands with starting parameters tuned to WHAT IT IS ON, not factory
 * defaults: Vinyl on an 808 is tape-ish dust, Vinyl on a drum kit is
 * sizzle. The fold happens at the UI layer (addEffectWithPresetCommand);
 * `addEffect` itself stays a pure single-purpose command.
 *
 * Roles mirror the production-intent target resolution (bass = 808/sub
 * kinds or names, chords = keys/pad, lead = the rest). Drum SUB-roles
 * (kick/snare/hats) are deliberately absent — chains are per-track
 * (ADR 0006), so a landing preset describes the whole kit until per-pad
 * chains ever exist.
 *
 * Values are artistic intent; BOTH the command and the catalog test clamp
 * them to the registry's ParamDef metadata, so an out-of-range entry can
 * never corrupt an instance.
 */

export type FxTrackRole = "drums" | "bass" | "chords" | "lead";

const BASS_KINDS = new Set(["bass", "808", "logdrum"]);
const CHORD_KINDS = new Set(["keys"]);

/** Resolve the landing role for a track — null when presets must not fire. */
export function roleOfTrack(track: Track): FxTrackRole | null {
  if (track.kind === "drum") return "drums";
  if (track.kind !== "instrument") return null;
  if (BASS_KINDS.has(track.instrument)) return "bass";
  if (CHORD_KINDS.has(track.instrument)) return "chords";
  const name = track.name.toLowerCase();
  if (/\bbass\b|\b808\b|\bsub\b|\blog ?drum\b/.test(name)) return "bass";
  if (/\bchord|\bkeys?\b|\bpad\b/.test(name)) return "chords";
  return "lead";
}

/** Human label for the popover badge ("♪ tuned for 808 / bass"). */
export const ROLE_LABELS: Record<FxTrackRole, string> = {
  drums: "drums",
  bass: "808 / bass",
  chords: "keys",
  lead: "lead",
};

type RoleTable = Partial<Record<FxTrackRole, Record<string, number>>>;

/**
 * The landing table. Only confident, musically meaningful entries — an
 * absent (type, role) pair falls back to factory defaults, which is better
 * than a guess. Keep entries small: landings nudge, they don't preset the
 * whole device (the preset dropdown stays the deeper starting point).
 */
const ROLE_PRESETS: Partial<Record<EffectType, RoleTable>> = {
  vinyl: {
    bass: { amount: 0.45, crackle: 0.25, crackleTone: 1400, hiss: 0.2, wow: 0.6, flutter: 0.2, drive: 0.15, mix: 1 },
    drums: { amount: 0.6, crackle: 0.6, crackleTone: 2600, hiss: 0.35, wow: 0.5, flutter: 0.35, drive: 0.1, mix: 1 },
    lead: { amount: 0.5, crackle: 0.4, crackleTone: 2200, hiss: 0.3, wow: 0.4, flutter: 0.25, drive: 0.1, mix: 0.9 },
  },
  tapeSat: {
    bass: { drive: 0.3, tone: 4800, mix: 1 },
    drums: { drive: 0.45, tone: 6500, mix: 1 },
    chords: { drive: 0.25, tone: 5200, mix: 1 },
  },
  svFilter: {
    bass: { cutoff: 3200, resonance: 0.15, mode: 0, mix: 1 },
    drums: { cutoff: 9000, resonance: 0.1, mode: 0, mix: 1 },
  },
  pitchShift: {
    bass: { semitones: -3, grainMs: 65, width: 0.6, mix: 1 },
  },
  beatMangler: {
    drums: { playMode: 0, repeatFill: 0, trigger: 1, interval: 4, offset: 0, chance: 0.4, gate: 2, mix: 0.85 },
  },
  compressor: {
    drums: { threshold: -24, ratio: 4, attack: 0.005, release: 0.12, knee: 6, mix: 1 },
    bass: { threshold: -28, ratio: 3, attack: 0.015, release: 0.18, knee: 6, mix: 1 },
  },
  transient: {
    drums: { attack: 0.55, sustain: -0.15, sensitivity: 0.65, mix: 1 },
  },
  reverb: {
    bass: { decay: 0.5, predelay: 30, tone: 900, diffusion: 0.5, mix: 0.12 },
    drums: { decay: 1.2, predelay: 12, tone: 6500, diffusion: 0.6, mix: 0.16 },
    lead: { decay: 2.4, predelay: 20, tone: 5200, diffusion: 0.8, mix: 0.3 },
  },
  distortion: {
    bass: { drive: 0.3, tone: 2400, mix: 0.5, output: -3 },
    drums: { drive: 0.35, tone: 6000, mix: 0.4, output: -1 },
    lead: { drive: 0.45, tone: 5500, mix: 0.8, output: -2 },
  },
  haasWidener: {
    lead: { delayMs: 14, width: 0.5 },
    chords: { delayMs: 18, width: 0.6 },
  },
};

/**
 * The landing params for a device on a track role — null when the table
 * says nothing (factory defaults stay).
 */
export function rolePresetFor(type: EffectType, role: FxTrackRole | null): Record<string, number> | null {
  if (!role) return null;
  return ROLE_PRESETS[type]?.[role] ?? null;
}
