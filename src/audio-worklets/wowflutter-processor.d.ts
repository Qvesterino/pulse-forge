interface WowFlutterProcessorLike {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

export function createWowFlutterProcessor(options?: unknown): WowFlutterProcessorLike;
/**
 * Modulation amplitude in seconds needed for a given pitch deviation in cents
 * at a given rate.
 *
 * There is deliberately no base-delay factor. A continuously modulated delay
 * line shifts pitch by dD/dt, not by dD/dt/D; the latter is the granular
 * resampling law and made the control 250x too weak at a 4 ms base delay.
 */
export function wfCentsToAmplitudeSeconds(cents: number, rateHz: number): number;
/** The cents actually achievable once the swing budget applies. */
export function wfAchievableCents(cents: number, rateHz: number, maxAmplitudeSeconds: number): number;
