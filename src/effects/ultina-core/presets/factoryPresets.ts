/* eslint-disable */
/**
 * VENDORED from VocalForge_DAW/plugins/ultina. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden vectors
 * (tests/ultina-vectors.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ultina.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ultina — Factory Presets
//
// Predefined parameter collections for EQ, Compressor, and Gate
// modules. Each preset is a partial parameter override that can
// be merged with default parameters.
// ═══════════════════════════════════════════════════════════

import { clampParam, buildDefaultParams, tryGetParamDef } from "../contracts/parameterSchema.js";
import type { ModuleType } from "../contracts/moduleTypes.js";
export type { ModuleType };

export interface FactoryPreset {
  /** Unique preset identifier. */
  id: string;
  /** Display name. */
  name: string;
  /** Which module this preset applies to. */
  module: ModuleType;
  /** Category for organization. */
  category: "vocal" | "instrument" | "master" | "drum" | "utility";
  /** Brief description shown in UI. */
  description: string;
  /** Parameter overrides (merged on top of defaults). */
  params: Record<string, number>;
}

// ── Helper ──────────────────────────────────────────────────

/**
 * Merge a preset's params onto the module defaults.
 * All values are clamped to their valid ranges.
 */
export function applyPreset(
  preset: FactoryPreset,
  baseParams?: Record<string, number>,
): Record<string, number> {
  const defaults = baseParams ?? buildDefaultParams();
  const result = { ...defaults };

  for (const [key, value] of Object.entries(preset.params)) {
    // Skip non-finite values (NaN/Infinity) and unknown parameter IDs —
    // these would otherwise leak into the audio path and render as "NaN"
    // in the editor.
    if (!Number.isFinite(value)) continue;
    if (!tryGetParamDef(key)) continue;
    result[key] = clampParam(key, value);
  }

  return result;
}

/**
 * Get all presets for a specific module.
 */
export function getPresetsForModule(
  module: ModuleType,
  presets: FactoryPreset[] = FACTORY_PRESETS,
): FactoryPreset[] {
  return presets.filter((p) => p.module === module);
}

/**
 * Find a preset by ID.
 */
export function findPreset(
  id: string,
  presets: FactoryPreset[] = FACTORY_PRESETS,
): FactoryPreset | undefined {
  return presets.find((p) => p.id === id);
}

// ── EQ Presets ──────────────────────────────────────────────

const EQ_PRESETS: FactoryPreset[] = [
  {
    id: "eq-vocal-air",
    name: "Vocal Air",
    module: "eq",
    category: "vocal",
    description: "High-shelf boost for airy vocal clarity",
    params: {
      "eq.enabled": 1,
      "eq.band0.shape": 2, // lowShelf
      "eq.band0.freqHz": 80,
      "eq.band0.gainDb": -2,
      "eq.band0.q": 0.7,
      "eq.band1.shape": 0, // bell
      "eq.band1.freqHz": 300,
      "eq.band1.gainDb": -3,
      "eq.band1.q": 1.5,
      "eq.band2.shape": 0,
      "eq.band2.freqHz": 800,
      "eq.band2.gainDb": -1.5,
      "eq.band2.q": 1.2,
      "eq.band3.shape": 1, // highShelf
      "eq.band3.freqHz": 10000,
      "eq.band3.gainDb": 3,
      "eq.band3.q": 0.7,
      "eq.band4.shape": 1,
      "eq.band4.freqHz": 15000,
      "eq.band4.gainDb": 2,
      "eq.band4.q": 0.7,
    },
  },
  {
    id: "eq-vocal-warmth",
    name: "Vocal Warmth",
    module: "eq",
    category: "vocal",
    description: "Low-mid warmth without muddiness",
    params: {
      "eq.enabled": 1,
      "eq.band0.shape": 2, // lowShelf
      "eq.band0.freqHz": 120,
      "eq.band0.gainDb": 2.5,
      "eq.band0.q": 0.8,
      "eq.band1.shape": 0, // bell
      "eq.band1.freqHz": 250,
      "eq.band1.gainDb": -2,
      "eq.band1.q": 1.8,
      "eq.band2.shape": 0,
      "eq.band2.freqHz": 500,
      "eq.band2.gainDb": 1.5,
      "eq.band2.q": 1.0,
    },
  },
  {
    id: "eq-vocal-presence",
    name: "Vocal Presence",
    module: "eq",
    category: "vocal",
    description: "Forward mid-range presence for cutting through",
    params: {
      "eq.enabled": 1,
      "eq.band0.shape": 0, // bell
      "eq.band0.freqHz": 200,
      "eq.band0.gainDb": -2,
      "eq.band0.q": 1.5,
      "eq.band1.shape": 0,
      "eq.band1.freqHz": 2500,
      "eq.band1.gainDb": 2.5,
      "eq.band1.q": 1.2,
      "eq.band2.shape": 0,
      "eq.band2.freqHz": 5000,
      "eq.band2.gainDb": 2,
      "eq.band2.q": 1.0,
    },
  },
  {
    id: "eq-de-ess",
    name: "De-Ess (Dynamic)",
    module: "eq",
    category: "vocal",
    description: "Dynamic bell to tame sibilance around 5-8 kHz",
    params: {
      "eq.enabled": 1,
      "eq.band0.shape": 9, // dynamicBell
      "eq.band0.freqHz": 6500,
      "eq.band0.gainDb": -6,
      "eq.band0.q": 4,
      "eq.band0.mode": 1, // dynamic
      "eq.band0.dynamicRangeDb": 6,
      "eq.band0.dynamicThresholdDb": -30,
    },
  },
  {
    id: "eq-lowcut",
    name: "Low Cut 80 Hz",
    module: "eq",
    category: "utility",
    description: "High-pass filter at 80 Hz for rumble removal",
    params: {
      "eq.enabled": 1,
      "eq.band0.shape": 3, // highPass
      "eq.band0.freqHz": 80,
      "eq.band0.q": 0.707,
    },
  },
  {
    id: "eq-tilt-bright",
    name: "Tilt Bright",
    module: "eq",
    category: "utility",
    description: "Tilt EQ for gentle brightness boost",
    params: {
      "eq.enabled": 1,
      "eq.band0.shape": 6, // tilt
      "eq.band0.freqHz": 1000,
      "eq.band0.gainDb": 2,
      "eq.band0.q": 0.7,
    },
  },
];

// ── Compressor Presets ──────────────────────────────────────

const COMP_PRESETS: FactoryPreset[] = [
  {
    id: "comp-vocal-glue",
    name: "Vocal Glue",
    module: "comp",
    category: "vocal",
    description: "Transparent compression for vocal leveling",
    params: {
      "comp.enabled": 1,
      "comp.mode": 1, // modern
      "comp.detectionMode": 1, // rms
      "comp.thresholdDb": -18,
      "comp.ratio": 2.5,
      "comp.attackMs": 15,
      "comp.releaseMs": 150,
      "comp.kneeDb": 6,
      "comp.makeupAuto": 1,
    },
  },
  {
    id: "comp-vocal-punch",
    name: "Vocal Punch",
    module: "comp",
    category: "vocal",
    description: "Aggressive punchy compression with fast attack",
    params: {
      "comp.enabled": 1,
      "comp.mode": 0, // punch
      "comp.detectionMode": 0, // peak
      "comp.thresholdDb": -15,
      "comp.ratio": 5,
      "comp.attackMs": 3,
      "comp.releaseMs": 80,
      "comp.kneeDb": 2,
      "comp.makeupDb": 4,
    },
  },
  {
    id: "comp-vocal-warm",
    name: "Vocal Warm (Vintage)",
    module: "comp",
    category: "vocal",
    description: "Vintage-style warm compression with character",
    params: {
      "comp.enabled": 1,
      "comp.mode": 2, // vintage
      "comp.detectionMode": 2, // trueEnvelope
      "comp.thresholdDb": -20,
      "comp.ratio": 3,
      "comp.attackMs": 20,
      "comp.releaseMs": 200,
      "comp.kneeDb": 8,
      "comp.makeupAuto": 1,
    },
  },
  {
    id: "comp-mbus-glue",
    name: "Master Bus Glue",
    module: "comp",
    category: "master",
    description: "Gentle master bus compression for cohesion",
    params: {
      "comp.enabled": 1,
      "comp.mode": 1, // modern
      "comp.detectionMode": 1, // rms
      "comp.thresholdDb": -10,
      "comp.ratio": 1.8,
      "comp.attackMs": 30,
      "comp.releaseMs": 300,
      "comp.kneeDb": 10,
      "comp.makeupAuto": 1,
      "comp.mix": 80,
    },
  },
  {
    id: "comp-multiband-wide",
    name: "Multiband Wide",
    module: "comp",
    category: "utility",
    description: "3-band compression for full-spectrum control",
    params: {
      "comp.enabled": 1,
      "comp.mode": 1, // modern
      "comp.detectionMode": 1, // rms
      "comp.bandCount": 3,
      "comp.crossoverHz1": 200,
      "comp.crossoverHz2": 2500,
      "comp.thresholdDb": -15,
      "comp.ratio": 3,
      "comp.attackMs": 10,
      "comp.releaseMs": 120,
      "comp.kneeDb": 4,
      "comp.makeupAuto": 1,
    },
  },
  {
    id: "comp-parallel",
    name: "Parallel Squash",
    module: "comp",
    category: "utility",
    description: "Heavy parallel compression at 40% mix",
    params: {
      "comp.enabled": 1,
      "comp.mode": 0, // punch
      "comp.detectionMode": 0, // peak
      "comp.thresholdDb": -30,
      "comp.ratio": 8,
      "comp.attackMs": 1,
      "comp.releaseMs": 50,
      "comp.kneeDb": 0,
      "comp.makeupDb": 8,
      "comp.mix": 40,
    },
  },
];

// ── Gate Presets ────────────────────────────────────────────

const GATE_PRESETS: FactoryPreset[] = [
  {
    id: "gate-vocal-clean",
    name: "Vocal Cleanup",
    module: "gate",
    category: "vocal",
    description: "Gentle gate for vocal noise floor removal",
    params: {
      "gate.enabled": 1,
      "gate.rangeDb": -12,
      "gate.attackMs": 2,
      "gate.holdMs": 100,
      "gate.releaseMs": 150,
      "gate.hysteresisDb": 6,
    },
  },
  {
    id: "gate-vocal-aggro",
    name: "Vocal Tight",
    module: "gate",
    category: "vocal",
    description: "Aggressive gating for tight vocal isolation",
    params: {
      "gate.enabled": 1,
      "gate.rangeDb": -40,
      "gate.attackMs": 0.5,
      "gate.holdMs": 30,
      "gate.releaseMs": 50,
      "gate.hysteresisDb": 10,
    },
  },
  {
    id: "gate-drum-kick",
    name: "Kick Gate",
    module: "gate",
    category: "drum",
    description: "Fast gate for kick drum bleed removal",
    params: {
      "gate.enabled": 1,
      "gate.rangeDb": -30,
      "gate.attackMs": 0.3,
      "gate.holdMs": 20,
      "gate.releaseMs": 30,
      "gate.hysteresisDb": 8,
      "gate.sidechainHpfHz": 50,
    },
  },
  {
    id: "gate-mb-control",
    name: "Multiband Control",
    module: "gate",
    category: "utility",
    description: "3-band gating for frequency-selective cleanup",
    params: {
      "gate.enabled": 1,
      "gate.rangeDb": -20,
      "gate.attackMs": 1,
      "gate.holdMs": 50,
      "gate.releaseMs": 100,
      "gate.hysteresisDb": 6,
      "gate.bandCount": 3,
      "gate.crossoverHz1": 300,
      "gate.crossoverHz2": 3000,
    },
  },
  {
    id: "gate-expander",
    name: "Soft Expander",
    module: "gate",
    category: "utility",
    description: "Gentle expansion for natural noise reduction",
    params: {
      "gate.enabled": 1,
      "gate.rangeDb": -6,
      "gate.attackMs": 5,
      "gate.holdMs": 200,
      "gate.releaseMs": 500,
      "gate.hysteresisDb": 3,
    },
  },
];

// ── Exciter Presets ─────────────────────────────────────────

const EXCITER_PRESETS: FactoryPreset[] = [
  {
    id: "exciter-warm-tube",
    name: "Warm Tube",
    module: "exciter",
    category: "vocal",
    description: "Gentle tube saturation for vocal warmth and presence",
    params: {
      "exciter.enabled": 1,
      "exciter.trashMode": 0,
      "exciter.tubeAmount": 40,
      "exciter.warmAmount": 30,
      "exciter.tapeAmount": 0,
      "exciter.retroAmount": 0,
      "exciter.toneSlider": 20,
      "exciter.oversampling": 1,
      "exciter.mix": 60,
    },
  },
  {
    id: "exciter-tape-sheen",
    name: "Tape Sheen",
    module: "exciter",
    category: "vocal",
    description: "Tape-style harmonic excitement for silky highs",
    params: {
      "exciter.enabled": 1,
      "exciter.trashMode": 0,
      "exciter.tubeAmount": 0,
      "exciter.warmAmount": 15,
      "exciter.tapeAmount": 50,
      "exciter.retroAmount": 0,
      "exciter.toneSlider": 50,
      "exciter.oversampling": 1,
      "exciter.mix": 50,
    },
  },
  {
    id: "exciter-retro-harmonics",
    name: "Retro Harmonics",
    module: "exciter",
    category: "instrument",
    description: "Asymmetric saturation with vintage character",
    params: {
      "exciter.enabled": 1,
      "exciter.trashMode": 0,
      "exciter.tubeAmount": 20,
      "exciter.warmAmount": 20,
      "exciter.tapeAmount": 20,
      "exciter.retroAmount": 45,
      "exciter.toneSlider": -10,
      "exciter.oversampling": 1,
      "exciter.mix": 55,
    },
  },
  {
    id: "exciter-trash-mode",
    name: "Trash Mode",
    module: "exciter",
    category: "drum",
    description: "Aggressive multi-distortion for creative destruction",
    params: {
      "exciter.enabled": 1,
      "exciter.trashMode": 1,
      "exciter.tubeAmount": 30,
      "exciter.warmAmount": 0,
      "exciter.tapeAmount": 20,
      "exciter.retroAmount": 0,
      "exciter.overdriveAmount": 35,
      "exciter.screamAmount": 0,
      "exciter.clipperAmount": 15,
      "exciter.scratchAmount": 0,
      "exciter.toneSlider": 30,
      "exciter.oversampling": 1,
      "exciter.mix": 70,
    },
  },
];

// ── Transient Shaper Presets ────────────────────────────────

const TRANSIENT_PRESETS: FactoryPreset[] = [
  {
    id: "transient-punch",
    name: "Punch",
    module: "transient",
    category: "drum",
    description: "Emphasize attack for punchy drums and percussion",
    params: {
      "transient.enabled": 1,
      "transient.globalMode": 0,
      "transient.contourShape": 0,
      "transient.attackAmount": 60,
      "transient.sustainAmount": 0,
    },
  },
  {
    id: "transient-smooth",
    name: "Smooth",
    module: "transient",
    category: "vocal",
    description: "Reduce transient peaks for a smoother, more controlled sound",
    params: {
      "transient.enabled": 1,
      "transient.globalMode": 1,
      "transient.contourShape": 2,
      "transient.attackAmount": -40,
      "transient.sustainAmount": 20,
    },
  },
  {
    id: "transient-snap",
    name: "Snap",
    module: "transient",
    category: "instrument",
    description: "Tighten transients with balanced attack and sustain",
    params: {
      "transient.enabled": 1,
      "transient.globalMode": 0,
      "transient.contourShape": 1,
      "transient.attackAmount": 40,
      "transient.sustainAmount": -15,
    },
  },
];

// ── Clipper Presets ─────────────────────────────────────────

const CLIPPER_PRESETS: FactoryPreset[] = [
  {
    id: "clipper-transparent",
    name: "Transparent",
    module: "clipper",
    category: "master",
    description: "Subtle transparent clipping to catch peaks",
    params: {
      "clipper.enabled": 1,
      "clipper.ceilingDb": -1,
      "clipper.kneeDb": 6,
      "clipper.driveDb": 3,
      "clipper.oversampling": 1,
    },
  },
  {
    id: "clipper-warm-clip",
    name: "Warm Clip",
    module: "clipper",
    category: "master",
    description: "Soft knee clipping with moderate drive for warmth",
    params: {
      "clipper.enabled": 1,
      "clipper.ceilingDb": -2,
      "clipper.kneeDb": 12,
      "clipper.driveDb": 6,
      "clipper.oversampling": 1,
    },
  },
  {
    id: "clipper-brick-wall",
    name: "Brick Wall",
    module: "clipper",
    category: "master",
    description: "Hard limiting at the ceiling for maximum loudness",
    params: {
      "clipper.enabled": 1,
      "clipper.ceilingDb": -0.5,
      "clipper.kneeDb": 0,
      "clipper.driveDb": 12,
      "clipper.oversampling": 1,
    },
  },
  {
    id: "clipper-drum-slam",
    name: "Drum Slam",
    module: "clipper",
    category: "drum",
    description: "Multiband clipping for controlled drum bus loudness",
    params: {
      "clipper.enabled": 1,
      "clipper.ceilingDb": -3,
      "clipper.kneeDb": 4,
      "clipper.driveDb": 9,
      "clipper.bandCount": 2,
      "clipper.crossoverHz1": 1000,
      "clipper.oversampling": 1,
    },
  },
];

// ── Density Presets ─────────────────────────────────────────

const DENSITY_PRESETS: FactoryPreset[] = [
  {
    id: "density-vocal-warmth",
    name: "Vocal Warmth",
    module: "density",
    category: "vocal",
    description: "Gentle upward compression for consistent vocal level",
    params: {
      "density.enabled": 1,
      "density.thresholdDb": -35,
      "density.rangeDb": 6,
      "density.ratio": 2,
      "density.attackMs": 20,
      "density.releaseMs": 200,
      "density.bandCount": 1,
      "density.channelMode": 0,
    },
  },
  {
    id: "density-vocal-consistency",
    name: "Vocal Consistency",
    module: "density",
    category: "vocal",
    description: "Stronger upward compression to even out dynamics",
    params: {
      "density.enabled": 1,
      "density.thresholdDb": -40,
      "density.rangeDb": 10,
      "density.ratio": 3,
      "density.attackMs": 10,
      "density.releaseMs": 150,
      "density.bandCount": 1,
      "density.channelMode": 0,
    },
  },
  {
    id: "density-drum-punch",
    name: "Drum Punch",
    module: "density",
    category: "drum",
    description: "Multiband upward compression for drum body and punch",
    params: {
      "density.enabled": 1,
      "density.thresholdDb": -30,
      "density.rangeDb": 8,
      "density.ratio": 2.5,
      "density.attackMs": 5,
      "density.releaseMs": 100,
      "density.bandCount": 2,
      "density.crossoverHz1": 200,
      "density.channelMode": 0,
    },
  },
  {
    id: "density-master-glue",
    name: "Master Glue",
    module: "density",
    category: "master",
    description: "3-band upward compression for cohesive master density",
    params: {
      "density.enabled": 1,
      "density.thresholdDb": -38,
      "density.rangeDb": 6,
      "density.ratio": 1.5,
      "density.attackMs": 30,
      "density.releaseMs": 300,
      "density.bandCount": 3,
      "density.crossoverHz1": 250,
      "density.crossoverHz2": 2500,
      "density.channelMode": 0,
    },
  },
  {
    id: "density-mid-focus",
    name: "Mid Focus",
    module: "density",
    category: "instrument",
    description: "Upward compression applied to mid channel only",
    params: {
      "density.enabled": 1,
      "density.thresholdDb": -35,
      "density.rangeDb": 8,
      "density.ratio": 2,
      "density.attackMs": 15,
      "density.releaseMs": 180,
      "density.bandCount": 1,
      "density.channelMode": 1,
    },
  },
  {
    id: "density-side-widen",
    name: "Side Widen",
    module: "density",
    category: "master",
    description: "Upward compression on side channel for wider stereo image",
    params: {
      "density.enabled": 1,
      "density.thresholdDb": -45,
      "density.rangeDb": 6,
      "density.ratio": 2,
      "density.attackMs": 20,
      "density.releaseMs": 250,
      "density.bandCount": 1,
      "density.channelMode": 2,
    },
  },
];

// ── Sculptor Presets ────────────────────────────────────────

const SCULPTOR_PRESETS: FactoryPreset[] = [
  {
    id: "sculptor-vocal-speech",
    name: "Vocal Speech",
    module: "sculptor",
    category: "vocal",
    description: "Adaptive spectral shaping for vocal clarity",
    params: {
      "sculptor.enabled": 1,
      "sculptor.targetProfile": 5,
      "sculptor.amount": 60,
      "sculptor.lowFreqBoundaryHz": 80,
      "sculptor.highFreqBoundaryHz": 12000,
      "sculptor.dryWet": 100,
      "sculptor.channelMode": 0,
    },
  },
  {
    id: "sculptor-guitar-tone",
    name: "Guitar Tone",
    module: "sculptor",
    category: "instrument",
    description: "Spectral contouring for electric guitar body and presence",
    params: {
      "sculptor.enabled": 1,
      "sculptor.targetProfile": 0,
      "sculptor.amount": 50,
      "sculptor.lowFreqBoundaryHz": 80,
      "sculptor.highFreqBoundaryHz": 10000,
      "sculptor.dryWet": 100,
      "sculptor.channelMode": 0,
    },
  },
  {
    id: "sculptor-bass-control",
    name: "Bass Control",
    module: "sculptor",
    category: "instrument",
    description: "Adaptive low-end shaping for bass guitar",
    params: {
      "sculptor.enabled": 1,
      "sculptor.targetProfile": 1,
      "sculptor.amount": 65,
      "sculptor.lowFreqBoundaryHz": 40,
      "sculptor.highFreqBoundaryHz": 5000,
      "sculptor.dryWet": 100,
      "sculptor.channelMode": 0,
    },
  },
  {
    id: "sculptor-kick-impact",
    name: "Kick Impact",
    module: "sculptor",
    category: "drum",
    description: "Spectral sculpting for punchy kick drum",
    params: {
      "sculptor.enabled": 1,
      "sculptor.targetProfile": 2,
      "sculptor.amount": 70,
      "sculptor.lowFreqBoundaryHz": 40,
      "sculptor.highFreqBoundaryHz": 6000,
      "sculptor.dryWet": 100,
      "sculptor.channelMode": 0,
    },
  },
  {
    id: "sculptor-snare-crack",
    name: "Snare Crack",
    module: "sculptor",
    category: "drum",
    description: "Spectral shaping for snare crack and body",
    params: {
      "sculptor.enabled": 1,
      "sculptor.targetProfile": 4,
      "sculptor.amount": 65,
      "sculptor.lowFreqBoundaryHz": 100,
      "sculptor.highFreqBoundaryHz": 8000,
      "sculptor.dryWet": 100,
      "sculptor.channelMode": 0,
    },
  },
  {
    id: "sculptor-piano-clarity",
    name: "Piano Clarity",
    module: "sculptor",
    category: "instrument",
    description: "Balanced spectral contour for piano presence",
    params: {
      "sculptor.enabled": 1,
      "sculptor.targetProfile": 3,
      "sculptor.amount": 45,
      "sculptor.lowFreqBoundaryHz": 60,
      "sculptor.highFreqBoundaryHz": 12000,
      "sculptor.dryWet": 80,
      "sculptor.channelMode": 0,
    },
  },
];

// ── Phase Presets ───────────────────────────────────────────

const PHASE_PRESETS: FactoryPreset[] = [
  {
    id: "phase-dc-remover",
    name: "DC Remover",
    module: "phase",
    category: "utility",
    description: "Gentle DC offset removal with no phase modification",
    params: {
      "phase.enabled": 1,
      "phase.rotationDegrees": 0,
      "phase.timeShiftMs": 0,
      "phase.sidechainEnabled": 0,
      "phase.learnActive": 0,
    },
  },
  {
    id: "phase-auto-align",
    name: "Auto Align",
    module: "phase",
    category: "utility",
    description: "Automatic phase alignment using sidechain reference",
    params: {
      "phase.enabled": 1,
      "phase.sidechainEnabled": 1,
      "phase.autoAlignActive": 1,
      "phase.rotationDegrees": 0,
      "phase.timeShiftMs": 0,
    },
  },
  {
    id: "phase-learn-fix",
    name: "Learn Fix",
    module: "phase",
    category: "vocal",
    description: "Learn mode to detect and correct asymmetry on vocals",
    params: {
      "phase.enabled": 1,
      "phase.learnActive": 1,
      "phase.rotationDegrees": 0,
      "phase.timeShiftMs": 0,
    },
  },
  {
    id: "phase-90-rotation",
    name: "90° Rotation",
    module: "phase",
    category: "utility",
    description: "90-degree phase rotation for improved mono compatibility",
    params: {
      "phase.enabled": 1,
      "phase.rotationDegrees": 90,
      "phase.timeShiftMs": 0,
    },
  },
  {
    id: "phase-time-align",
    name: "Time Align",
    module: "phase",
    category: "utility",
    description: "Small time-shift to align multi-mic recordings",
    params: {
      "phase.enabled": 1,
      "phase.timeShiftMs": 5,
      "phase.rotationDegrees": 0,
    },
  },
];

// ── Unmask Presets ──────────────────────────────────────────

const UNMASK_PRESETS: FactoryPreset[] = [
  {
    id: "unmask-vocal-clarity",
    name: "Vocal Clarity",
    module: "unmask",
    category: "vocal",
    description: "Sidechain-based spectral carving for vocal intelligibility",
    params: {
      "unmask.enabled": 1,
      "unmask.amount": 60,
      "unmask.sidechainEnabled": 1,
      "unmask.maskingThresholdDb": -15,
      "unmask.responseSpeedHz": 5,
      "unmask.channelMode": 0,
    },
  },
  {
    id: "unmask-instrument-pocket",
    name: "Instrument Pocket",
    module: "unmask",
    category: "instrument",
    description: "Create space for instruments in a dense mix",
    params: {
      "unmask.enabled": 1,
      "unmask.amount": 50,
      "unmask.sidechainEnabled": 1,
      "unmask.maskingThresholdDb": -10,
      "unmask.responseSpeedHz": 10,
      "unmask.channelMode": 0,
    },
  },
  {
    id: "unmask-master-space",
    name: "Master Space",
    module: "unmask",
    category: "master",
    description: "Gentle masking reduction for master bus clarity",
    params: {
      "unmask.enabled": 1,
      "unmask.amount": 30,
      "unmask.sidechainEnabled": 1,
      "unmask.maskingThresholdDb": -5,
      "unmask.responseSpeedHz": 3,
      "unmask.channelMode": 0,
    },
  },
  {
    id: "unmask-aggressive-carve",
    name: "Aggressive Carve",
    module: "unmask",
    category: "drum",
    description: "Strong spectral carving for maximum separation",
    params: {
      "unmask.enabled": 1,
      "unmask.amount": 90,
      "unmask.sidechainEnabled": 1,
      "unmask.maskingThresholdDb": -25,
      "unmask.responseSpeedHz": 20,
      "unmask.channelMode": 0,
    },
  },
];

// ── All Presets ─────────────────────────────────────────────

export const FACTORY_PRESETS: FactoryPreset[] = [
  ...EQ_PRESETS,
  ...COMP_PRESETS,
  ...GATE_PRESETS,
  ...EXCITER_PRESETS,
  ...TRANSIENT_PRESETS,
  ...CLIPPER_PRESETS,
  ...DENSITY_PRESETS,
  ...SCULPTOR_PRESETS,
  ...PHASE_PRESETS,
  ...UNMASK_PRESETS,
];
