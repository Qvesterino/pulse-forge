/**
 * Type stub for the plain-JS Kaskáda worklet processor (house pattern: see
 * ozvena-worklet.entry.d.ts). The implementation stays plain JS because it
 * is an input of the classic-script core bundle (scripts/build-core-worklets.mjs).
 * Only the test factory is exported — registration happens via the
 * registerProcessor side effect inside the real AudioWorkletGlobalScope.
 */
export declare function createKaskadaProcessor(): KaskadaProcessorInstance;

export interface KaskadaProcessorInstance {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean;
}
