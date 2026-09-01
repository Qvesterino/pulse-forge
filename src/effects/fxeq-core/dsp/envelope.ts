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
// FXEQ — Envelope / parameter smoother
//
// One-pole smoothing used to de-click parameter changes (gains, mixes,
// drive) and to ramp band gains. Per-channel when needed.
// ═══════════════════════════════════════════════════════════

/**
 * A scalar one-pole smoother. `processValue()` advances toward the
 * target each call. Time constant ~ 1 / (2*pi*freq).
 */
export interface Smoother {
  setCoeff(alpha: number): void;
  setTimeConstantMs(ms: number, sampleRate: number): void;
  reset(value?: number): void;
  processValue(target: number): number;
  getValue(): number;
}

export function createSmoother(sampleRate: number, freqHz = 20): Smoother {
  let alpha = 1 - Math.exp((-2 * Math.PI * freqHz) / sampleRate);
  let value = 0;

  return {
    setCoeff(a: number) {
      alpha = a;
    },
    setTimeConstantMs(ms: number, sampleRate: number) {
      alpha = 1 - Math.exp(-1 / ((ms / 1000) * sampleRate));
    },
    reset(v = 0) {
      value = v;
    },
    processValue(target: number) {
      value += alpha * (target - value);
      return value;
    },
    getValue() {
      return value;
    },
  };
}
