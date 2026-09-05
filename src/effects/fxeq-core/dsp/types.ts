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
// FXEQ — Portable DSP type definitions
//
// Host-agnostic interfaces shared by every module and the core
// processor. Nothing here imports from the VocalForge host, so the
// whole plugin package stays self-contained and portable.
// ═══════════════════════════════════════════════════════════

/** Audio channel data: one Float32Array per channel (non-interleaved). */
export type Channels = Float32Array[];

/** A single parameter definition (mirrors the host DspParameterDef shape). */
export interface FxEqParamDef {
  id: string;
  name: string;
  defaultValue: number;
  minValue: number;
  maxValue: number;
  unit?: string;
  /** True when the host/UI should use logarithmic control resolution. */
  logScale?: boolean;
  automatable?: boolean;
}

/**
 * Portable module interface. Each creative effect (saturation, lo-fi,
 * modulation, delay, reverb) implements this. Band engines orchestrate
 * a chain of modules per band.
 */
export interface ModuleProcessor {
  readonly typeId: string;
  readonly parameterDefs: readonly FxEqParamDef[];

  prepare(sampleRate: number, channelCount: number, maxBlockSize: number): void;
  process(channels: Channels, frameCount: number): void;
  /**
   * Optional external trigger signal for dynamic EQ nodes with
   * dynSource = external (P-engine #9). The channels ride the process
   * chunking and are only read. Processors without sidechain support
   * simply omit this — dynSource=external then falls back to internal
   * detection.
   */
  setSidechain?(channels: Channels | null): void;
  /**
   * Optional host tempo notification (quality roadmap Q2). Modules with
   * tempo-synced parameters (delay time, modulation rate) recompute their
   * derived values; modules without tempo awareness omit this. Must never
   * allocate or reallocate buffers.
   */
  setTempo?(bpm: number): void;
  reset(): void;
  getLatencySamples(): number;
  setParameter(id: string, value: number): void;
  getParameter(id: string): number;
  getParameters(): Record<string, number>;
  loadParameters(params: Record<string, number>): void;
  getGainReductionDb?(): number;
}

/** Factory that constructs a module from optional initial parameters. */
export type ModuleFactory = (params?: Record<string, number>) => ModuleProcessor;
