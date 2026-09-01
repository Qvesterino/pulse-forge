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
// Ultina — Module Types
//
// Enumerates the 10 processing modules and their metadata.
// ═══════════════════════════════════════════════════════════

/** All module type identifiers. */
export const MODULE_TYPES = [
  "eq",
  "comp",
  "gate",
  "exciter",
  "transient",
  "clipper",
  "density",
  "sculptor",
  "phase",
  "unmask",
] as const;

export type ModuleType = (typeof MODULE_TYPES)[number];

/** Human-readable display name for each module. */
export const MODULE_DISPLAY_NAMES: Record<ModuleType, string> = {
  eq: "Equalizer",
  comp: "Compressor",
  gate: "Gate",
  exciter: "Exciter",
  transient: "Transient Shaper",
  clipper: "Clipper",
  density: "Density",
  sculptor: "Sculptor",
  phase: "Phase",
  unmask: "Unmask",
};

/** Short description of each module's purpose. */
export const MODULE_DESCRIPTIONS: Record<ModuleType, string> = {
  eq: "12-band parametric EQ with static, dynamic, and sidechain modes",
  comp: "Multiband compressor with Punch, Modern, and Vintage modes",
  gate: "3-band gate/expander with drag open/close markers",
  exciter: "Multiband harmonic exciter with 8 saturation/distortion types",
  transient: "Transient shaper with global modes and contour shapes",
  clipper: "Multiband soft clipper with 4x oversampling",
  density: "Upward compressor for detail and fullness",
  sculptor: "Adaptive spectral shaper with instrument target profiles",
  phase: "Phase correction with learn, rotation, and time-shift",
  unmask: "32-band spectral masking solver for clarity",
};

/** Whether a module supports multiband processing. */
export const MODULE_SUPPORTS_MULTIBAND: Record<ModuleType, boolean> = {
  eq: false, // EQ uses its own band system (up to 12 EQ bands)
  comp: true,
  gate: true,
  exciter: true,
  transient: true,
  clipper: true,
  density: true,
  sculptor: true, // Uses spectral bands, not crossover multiband
  phase: false,
  unmask: true, // Uses 32 spectral bands, not crossover multiband
};

/** Whether a module supports mid/side channel modes. */
export const MODULE_SUPPORTS_MID_SIDE: Record<ModuleType, boolean> = {
  eq: true,
  comp: true,
  gate: true,
  exciter: true,
  transient: true,
  clipper: true,
  density: true,
  sculptor: true,
  phase: true,
  unmask: true,
};

/** Whether a module supports transient/sustain channel modes. */
export const MODULE_SUPPORTS_TRANSIENT_SUSTAIN: Record<ModuleType, boolean> = {
  eq: true,
  comp: false,
  gate: false,
  exciter: false,
  transient: false,
  clipper: true,
  density: false,
  sculptor: false,
  phase: false,
  unmask: true,
};

/** Whether a module supports sidechain input. */
export const MODULE_SUPPORTS_SIDECHAIN: Record<ModuleType, boolean> = {
  eq: true,
  comp: true,
  gate: true,
  exciter: false,
  transient: false,
  clipper: false,
  density: false,
  sculptor: false,
  phase: true,
  unmask: true,
};

/** Maximum number of crossover bands a module supports. */
export const MODULE_MAX_BANDS: Record<ModuleType, number> = {
  eq: 12,
  comp: 3,
  gate: 3,
  exciter: 3,
  transient: 3,
  clipper: 3,
  density: 3,
  sculptor: 0, // Uses spectral, not crossover
  phase: 0,
  unmask: 32, // Spectral bands
};

export function isModuleType(value: string): value is ModuleType {
  return (MODULE_TYPES as readonly string[]).includes(value);
}
