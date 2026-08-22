/**
 * Type declarations for AudioWorklet globals.
 * These are available in the AudioWorklet scope but not in regular TypeScript.
 */
declare class AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[];
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

declare function registerProcessor(name: string, constructor: typeof AudioWorkletProcessor): void;

interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: "a-rate" | "k-rate";
}
