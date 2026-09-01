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
// Ultina — Core Module Factory Registration
//
// Registers the TS reference implementations of EQ, Compressor,
// Gate, Exciter, Transient Shaper, and Clipper modules with the
// UltinaProcessor. This replaces the stub processors for these
// six modules.
// ═══════════════════════════════════════════════════════════

import type { UltinaProcessor } from "./ultinaProcessor.js";
import { EqModuleProcessor } from "./modules/eqModule.js";
import { CompModuleProcessor } from "./modules/compModule.js";
import { GateModuleProcessor } from "./modules/gateModule.js";
import { ExciterModuleProcessor } from "./modules/exciterModule.js";
import { TransientModuleProcessor } from "./modules/transientModule.js";
import { ClipperModuleProcessor } from "./modules/clipperModule.js";
import { DensityModuleProcessor } from "./modules/densityModule.js";
import { SculptorModuleProcessor } from "./modules/sculptorModule.js";
import { PhaseModuleProcessor } from "./modules/phaseModule.js";
import { UnmaskModuleProcessor } from "./modules/unmaskModule.js";

/**
 * Register the core modules (EQ, Compressor, Gate, Exciter,
 * Transient Shaper, Clipper, Density, Sculptor, Phase, Unmask)
 * with the given UltinaProcessor instance. This replaces the stub
 * processors with full TS reference implementations.
 */
export function registerCoreModules(processor: UltinaProcessor): void {
  processor.registerModuleFactory("eq", () => new EqModuleProcessor());
  processor.registerModuleFactory("comp", () => new CompModuleProcessor());
  processor.registerModuleFactory("gate", () => new GateModuleProcessor());
  processor.registerModuleFactory("exciter", () => new ExciterModuleProcessor());
  processor.registerModuleFactory("transient", () => new TransientModuleProcessor());
  processor.registerModuleFactory("clipper", () => new ClipperModuleProcessor());
  processor.registerModuleFactory("density", () => new DensityModuleProcessor());
  processor.registerModuleFactory("sculptor", () => new SculptorModuleProcessor());
  processor.registerModuleFactory("phase", () => new PhaseModuleProcessor());
  processor.registerModuleFactory("unmask", () => new UnmaskModuleProcessor());
}

/**
 * Factory map for programmatic access.
 * Maps module type to a constructor function.
 */
export const CORE_MODULE_FACTORIES = {
  eq: () => new EqModuleProcessor(),
  comp: () => new CompModuleProcessor(),
  gate: () => new GateModuleProcessor(),
  exciter: () => new ExciterModuleProcessor(),
  transient: () => new TransientModuleProcessor(),
  clipper: () => new ClipperModuleProcessor(),
  density: () => new DensityModuleProcessor(),
  sculptor: () => new SculptorModuleProcessor(),
  phase: () => new PhaseModuleProcessor(),
  unmask: () => new UnmaskModuleProcessor(),
} as const;

/**
 * Check if a module type has a real (non-stub) implementation.
 */
export function isCoreModuleImplemented(moduleType: string): boolean {
  return moduleType in CORE_MODULE_FACTORIES;
}
