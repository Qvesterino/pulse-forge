/**
 * Type stub for the plain-JS ducking-delay worklet processor (house pattern:
 * see kaskada-processor.d.ts). The implementation stays plain JS because it
 * is an input of the classic-script core bundle (scripts/build-core-worklets.mjs).
 * The module has no exports — registration happens via the registerProcessor
 * side effect inside the real AudioWorkletGlobalScope — so this stub is an
 * empty module: it only silences TS7016 on side-effect imports in tests.
 */
export {};
