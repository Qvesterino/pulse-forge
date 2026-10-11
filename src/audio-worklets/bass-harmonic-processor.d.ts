/**
 * Type stub for the plain-JS GROW bass-harmonic worklet processor (house
 * pattern: see apeks-processor.d.ts). The implementation stays plain JS
 * because it is bundled as a standalone lazy worklet module
 * (scripts/build-bass-harmonic-worklet.mjs) and exercised by vitest via a
 * stubbed registerProcessor. No exports - registration happens via the
 * registerProcessor side effect inside the real AudioWorkletGlobalScope.
 */
export {};
