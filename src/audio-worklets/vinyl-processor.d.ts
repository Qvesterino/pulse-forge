interface VinylProcessorLike {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

export function createVinylProcessor(options?: unknown): VinylProcessorLike;
export function vnOsDrive(state: unknown, input: number, drive: number, compensation: number): number;
export function newVnDriveState(): unknown;
