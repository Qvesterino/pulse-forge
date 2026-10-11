/**
 * Type stub for the plain-JS TWIST phase-dispersion worklet processor
 * (house pattern: see bass-harmonic-processor.d.ts). The implementation stays
 * plain JS because it is bundled as a standalone lazy worklet module
 * (scripts/build-skrutka-worklet.mjs) and exercised by vitest via a stubbed
 * registerProcessor. No exports - registration happens via the
 * registerProcessor side effect inside the real AudioWorkletGlobalScope.
 */
export {};
