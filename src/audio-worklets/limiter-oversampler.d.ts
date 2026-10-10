export const LIMITER_OVERSAMPLER_LATENCY_SAMPLES: number;

export class LimiterOversampler2x {
  readonly upBufferL: Float32Array;
  readonly upBufferR: Float32Array;
  readonly processBufferL: Float32Array;
  readonly processBufferR: Float32Array;
  readonly downBufferL: Float32Array;
  readonly downBufferR: Float32Array;
  upsample(input: Float32Array, inputFrames: number, channel: 0 | 1): Float32Array;
  downsample(input: Float32Array, outputFrames: number, channel: 0 | 1): Float32Array;
}
