interface FreqShiftProcessorLike {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

export function createFreqShiftProcessor(options?: unknown): FreqShiftProcessorLike;
export function osDriveSat(state: unknown, input: number, drive: number, inverseNorm: number): number;
export function newOsDriveState(): unknown;
