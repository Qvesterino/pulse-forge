/**
 * MORPH DYNAMICS — Meter contract (processor → panel).
 *
 * Meters are observability, not parameters: every reactive relationship the
 * engine uses must be visible (DSP_ARCHITECTURE.md principle 7). Posted
 * ~20 Hz over the worklet port, gated by setMeters so closed panels cost
 * nothing. Plain numbers + one number[] — cheap structured-clone payload.
 */
export interface MorphMeters {
  inputPeakDb: number;
  outputPeakDb: number;
  /** Current dynamics gain reduction (positive dB). */
  gainReductionDb: number;
  /** Normalized reactive sources 0..1 — the engine's mental model, visible. */
  transient: number;
  body: number;
  texture: number;
  density: number;
  inputEnergy: number;
  /** PRESSURE after its nonlinear curve — instantaneous reactive drive 0..1. */
  pressureActive: number;
  /**
   * AGC compensation on the analysis tap in dB (−8…+24): how far the
   * adaptive level reference sits from the fixed nominal. 0 = AGC off or
   * material already at the nominal reference. Observability for the
   * analysis engine (docs principle 7).
   */
  agcBoostDb: number;
  /** Per-route post-modulation magnitude 0..1 (route slot 0..7 activity). */
  routes: number[];
}
