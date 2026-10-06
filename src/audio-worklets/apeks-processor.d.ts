/**
 * Type stub for the plain-JS APEKS maximizer worklet processor (house
 * pattern: see chorus-processor.d.ts). The implementation stays plain JS
 * because it is an input of the classic-script core bundle
 * (scripts/build-core-worklets.mjs). No exports — registration happens via
 * the registerProcessor side effect inside the real AudioWorkletGlobalScope;
 * tests capture the class through a stubbed registerProcessor.
 */
export {};
