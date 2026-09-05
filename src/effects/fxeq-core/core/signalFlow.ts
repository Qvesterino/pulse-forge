/* eslint-disable */
// @ts-nocheck
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
// FXEQ — Signal flow registry
//
// Defines the ordered set of creative modules every band runs, their
// short keys (used in parameter IDs like `band2.satDriveDb`), and their
// factories. This is the single place to change module wiring.
// ═══════════════════════════════════════════════════════════

import type { ModuleFactory } from "../dsp/types.js";
import { createBandEqModule } from "../modules/bandEq.js";
import { createSaturationModule } from "../modules/saturation.js";
import { createDynamicsModule } from "../modules/dynamics.js";
import { createLofiModule } from "../modules/lofi.js";
import { createModulationModule } from "../modules/modulation.js";
import { createDelayModule } from "../modules/delay.js";
import { createReverbModule } from "../modules/reverb.js";

/**
 * Ordered module keys — the processing order within each band.
 * Q3: the band equalizer heads the chain (shape the tone before the
 * creative color). Appending a key is additive for serialization; the
 * position defines chain order only.
 */
export const MODULE_KEYS = ["eq", "sat", "dyn", "lofi", "mod", "delay", "rev"] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/** Human-readable names per module key (for UI / presets). */
export const MODULE_NAMES: Record<ModuleKey, string> = {
  eq: "Equalizer",
  sat: "Saturation",
  dyn: "Dynamics",
  lofi: "Lo-Fi",
  mod: "Modulation",
  delay: "Delay",
  rev: "Reverb",
};

/** Factories keyed by module key. */
export const MODULE_FACTORIES: Record<ModuleKey, ModuleFactory> = {
  eq: createBandEqModule,
  sat: createSaturationModule,
  dyn: createDynamicsModule,
  lofi: createLofiModule,
  mod: createModulationModule,
  delay: createDelayModule,
  rev: createReverbModule,
};

/**
 * Q6 envelope-routing targets. Index = the band scalar `envModTarget`
 * value; 0 = off. Each active entry names the routed parameter and the
 * modulation swing in that parameter's own unit — the band's envelope
 * (0..1 against full scale) scaled by `envModDepth` (%) sweeps the
 * parameter around its base value by at most ±swing.
 *
 * Deliberately EXCLUDED: time-based parameters (delayTimeMs, revDecayMs,
 * modRate) — block-rate retuning of delay lengths clicks and fights the
 * tempo-sync machinery; and the dyn EQ's own thresholds — the follower
 * would modulate its own detector domain.
 */
export interface EnvModTarget {
  /** Routed module (undefined = band-scalar target). */
  moduleKey?: ModuleKey;
  /** Routed parameter id inside the module. */
  paramId?: string;
  /** Band-scalar target ("gainDb" is applied at the band gain stage). */
  bandScalar?: "gainDb";
  /** Modulation swing in the parameter's unit at depth = ±100 %. */
  swing: number;
}

export const ENV_MOD_TARGETS: readonly (EnvModTarget | null)[] = [
  null, // 0 = off
  { moduleKey: "sat", paramId: "driveDb", swing: 6 }, // 1 — drive
  { moduleKey: "sat", paramId: "mix", swing: 25 }, // 2 — sat blend
  { moduleKey: "eq", paramId: "lowGainDb", swing: 12 }, // 3 — low shelf
  { moduleKey: "eq", paramId: "peak1GainDb", swing: 12 }, // 4 — peak 1
  { moduleKey: "eq", paramId: "peak2GainDb", swing: 12 }, // 5 — peak 2
  { moduleKey: "eq", paramId: "highGainDb", swing: 12 }, // 6 — high shelf
  { moduleKey: "delay", paramId: "mix", swing: 30 }, // 7 — delay blend
  { moduleKey: "rev", paramId: "mix", swing: 30 }, // 8 — reverb blend
  { bandScalar: "gainDb", swing: 12 }, // 9 — band gain
] as const;
