/* eslint-disable */
// @ts-nocheck
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
// Ultina — Channel Modes
//
// Defines the stereo processing modes shared across all
// multiband modules: stereo, mid, side, transient, sustain.
// ═══════════════════════════════════════════════════════════

/** Channel processing mode. */
export type ChannelMode =
  | "stereo" // Process L+R together
  | "mid" // Process mid channel only
  | "side" // Process side channel only
  | "transient" // Process transient component only
  | "sustain"; // Process sustain component only

export const CHANNEL_MODES: readonly ChannelMode[] = [
  "stereo",
  "mid",
  "side",
  "transient",
  "sustain",
] as const;

/** Normalized value for each channel mode (for VST3 param mapping). */
export const CHANNEL_MODE_VALUES: Record<ChannelMode, number> = {
  stereo: 0,
  mid: 1,
  side: 2,
  transient: 3,
  sustain: 4,
};

export function channelModeFromValue(v: number): ChannelMode {
  const idx = Math.round(v);
  return CHANNEL_MODES[Math.max(0, Math.min(CHANNEL_MODES.length - 1, idx))];
}

/** Whether this channel mode requires mid/side encoding. */
export function isMidSideMode(mode: ChannelMode): boolean {
  return mode === "mid" || mode === "side";
}

/** Whether this channel mode requires transient/sustain separation. */
export function isTransientSustainMode(mode: ChannelMode): boolean {
  return mode === "transient" || mode === "sustain";
}

// ── Crossover configuration ─────────────────────────────────

/** Crossover filter topology. */
export type CrossoverMode =
  | "analog" // LR4, zero latency
  | "hybrid"; // Linear-phase, transparent

export const CROSSOVER_MODES: readonly CrossoverMode[] = [
  "analog",
  "hybrid",
] as const;

/** Number of bands (1 = fullband, 2 = two-band, 3 = three-band). */
export type BandCount = 1 | 2 | 3;

/**
 * Multiband configuration shared across modules.
 * Stored per-module since each module has independent settings.
 */
export interface MultibandConfig {
  bandCount: BandCount;
  /** Crossover frequency 1 (Hz). Boundary between band 1 and band 2. */
  crossoverHz1: number;
  /** Crossover frequency 2 (Hz). Boundary between band 2 and band 3. */
  crossoverHz2: number;
  /** Crossover topology. */
  crossoverMode: CrossoverMode;
  /** Channel mode for this module. */
  channelMode: ChannelMode;
  /** Whether auto-learn is actively searching for crossover points. */
  crossoverLearnActive: boolean;
}

export const DEFAULT_MULTIBAND_CONFIG: MultibandConfig = {
  bandCount: 1,
  crossoverHz1: 250,
  crossoverHz2: 2500,
  crossoverMode: "analog",
  channelMode: "stereo",
  crossoverLearnActive: false,
};

/** Default multiband config for a given band count. */
export function defaultMultibandConfig(bandCount: BandCount): MultibandConfig {
  switch (bandCount) {
    case 1:
      return { ...DEFAULT_MULTIBAND_CONFIG, bandCount: 1 };
    case 2:
      return {
        ...DEFAULT_MULTIBAND_CONFIG,
        bandCount: 2,
        crossoverHz1: 1000,
      };
    case 3:
      return {
        ...DEFAULT_MULTIBAND_CONFIG,
        bandCount: 3,
        crossoverHz1: 250,
        crossoverHz2: 2500,
      };
  }
}
