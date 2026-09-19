/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a semantics-faithful copy of the upstream DSP oracle (line endings are
 * normalized) so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Convolution mode types
//
// The live convolution state lives in `ConvolutionState` (types.ts).
// This module holds the factory IR catalogue used by the UI and the
// procedural IR generator.
// ═══════════════════════════════════════════════════════════

/** Pre-defined factory IR identifiers. */
export type FactoryIrId = "vocal-booth" | "plate" | "hall" | "cathedral" | "plate-wide" | "chamber-wide";

/** Factory IR descriptor. */
export interface FactoryIr {
  readonly id: FactoryIrId;
  readonly label: string;
  readonly category: "room" | "plate" | "hall" | "cathedral";
  /** Approximate length in seconds. */
  readonly lengthSec: number;
}

export const FACTORY_IRS: readonly FactoryIr[] = [
  { id: "vocal-booth", label: "Vocal Booth", category: "room", lengthSec: 1.2 },
  { id: "plate", label: "Plate Reverb", category: "plate", lengthSec: 2.5 },
  { id: "hall", label: "Concert Hall", category: "hall", lengthSec: 4.0 },
  { id: "cathedral", label: "Cathedral", category: "cathedral", lengthSec: 5.0 },
] as const;

export function getFactoryIr(id: string): FactoryIr | undefined {
  return FACTORY_IRS.find((ir) => ir.id === id);
}
