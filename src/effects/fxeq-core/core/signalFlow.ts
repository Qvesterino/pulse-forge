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
