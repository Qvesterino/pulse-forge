/**
 * 2× streaming half-band FIR oversampler for the master limiter.
 *
 * A 129-tap Kaiser-windowed, linear-phase filter is used for both stages.
 * Upsampling plus decimation adds 64 base-rate samples; all channel histories
 * and work buffers are allocated once and reused by each worklet quantum.
 */
export const LIMITER_OVERSAMPLER_LATENCY_SAMPLES = 64;

const FACTOR = 2;
const TAPS = 129;
const CENTER = (TAPS - 1) >> 1;
const PHASE_TAP_COUNT = (TAPS + 1) >> 1;
const MAX_INPUT_FRAMES = 2048;

function besselI0(x) {
  let sum = 1;
  let term = 1;
  const half = x * 0.5;
  for (let k = 1; k < 80; k++) {
    term *= (half * half) / (k * k);
    sum += term;
    if (term < 1e-14) break;
  }
  return sum;
}

function designHalfBandKernel() {
  const beta = 8.6;
  const denominator = besselI0(beta);
  const kernel = new Float32Array(TAPS);
  let sum = 0;
  for (let n = 0; n < TAPS; n++) {
    const k = n - CENTER;
    // Ideal half-band low-pass: 0.25 cycles per oversampled sample.
    const ideal = k === 0 ? 0.5 : k % 2 === 0 ? 0 : Math.sin((Math.PI * 0.5 * k)) / (Math.PI * k);
    const position = k / CENTER;
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - position * position))) / denominator;
    const value = ideal * window;
    kernel[n] = value;
    sum += value;
  }
  const inverse = 1 / sum;
  for (let n = 0; n < kernel.length; n++) kernel[n] *= inverse;
  return kernel;
}

const KERNEL = designHalfBandKernel();
const UP_PHASES = [0, 1].map((phase) => {
  const taps = [];
  for (let tap = 0; tap < PHASE_TAP_COUNT; tap++) {
    const index = phase + tap * FACTOR;
    if (index >= KERNEL.length) continue;
    const coefficient = KERNEL[index] * FACTOR;
    if (Math.abs(coefficient) > 1e-12) taps.push({ delay: tap, coefficient });
  }
  return taps;
});
const DOWN_TAPS = [];
for (let tap = 0; tap < TAPS; tap++) {
  const coefficient = KERNEL[tap];
  if (Math.abs(coefficient) > 1e-12) DOWN_TAPS.push({ delay: tap, coefficient });
}

/** Streaming oversampler with a bounded, allocation-free render path. */
export class LimiterOversampler2x {
  constructor() {
    this.upBufferL = new Float32Array(MAX_INPUT_FRAMES * FACTOR);
    this.upBufferR = new Float32Array(MAX_INPUT_FRAMES * FACTOR);
    this.processBufferL = new Float32Array(MAX_INPUT_FRAMES * FACTOR);
    this.processBufferR = new Float32Array(MAX_INPUT_FRAMES * FACTOR);
    this.downBufferL = new Float32Array(MAX_INPUT_FRAMES);
    this.downBufferR = new Float32Array(MAX_INPUT_FRAMES);
    this.upHistoryL = new Float32Array(PHASE_TAP_COUNT);
    this.upHistoryR = new Float32Array(PHASE_TAP_COUNT);
    this.upWriteL = 0;
    this.upWriteR = 0;
    this.downHistoryL = new Float32Array(TAPS);
    this.downHistoryR = new Float32Array(TAPS);
    this.downWriteL = 0;
    this.downWriteR = 0;
  }

  upsample(input, inputFrames, channel) {
    const right = channel === 1;
    const history = right ? this.upHistoryR : this.upHistoryL;
    let write = right ? this.upWriteR : this.upWriteL;
    const output = right ? this.upBufferR : this.upBufferL;
    if (inputFrames > MAX_INPUT_FRAMES) {
      throw new RangeError("Limiter oversampler input exceeds its bounded work-buffer size");
    }
    for (let frame = 0; frame < inputFrames; frame++) {
      write = (write + 1) % PHASE_TAP_COUNT;
      history[write] = input[frame] ?? 0;
      const out = frame * FACTOR;
      for (let phase = 0; phase < FACTOR; phase++) {
        const taps = UP_PHASES[phase];
        let acc = 0;
        for (let tap = 0; tap < taps.length; tap++) {
          const entry = taps[tap];
          acc += entry.coefficient * history[(write - entry.delay + PHASE_TAP_COUNT) % PHASE_TAP_COUNT];
        }
        output[out + phase] = acc;
      }
    }
    if (right) this.upWriteR = write;
    else this.upWriteL = write;
    return output;
  }

  downsample(input, outputFrames, channel) {
    const right = channel === 1;
    const history = right ? this.downHistoryR : this.downHistoryL;
    let write = right ? this.downWriteR : this.downWriteL;
    const output = right ? this.downBufferR : this.downBufferL;
    if (outputFrames > MAX_INPUT_FRAMES) {
      throw new RangeError("Limiter oversampler output exceeds its bounded work-buffer size");
    }
    for (let frame = 0; frame < outputFrames; frame++) {
      const source = frame * FACTOR;
      // Decimate on the even high-rate phase. With 64 samples of group delay
      // in both FIR stages, this makes the measured cascade latency exactly
      // 64 base-rate samples instead of a half-sample fractional delay.
      write = (write + 1) % TAPS;
      history[write] = input[source] ?? 0;
      let acc = 0;
      for (let tap = 0; tap < DOWN_TAPS.length; tap++) {
        const entry = DOWN_TAPS[tap];
        acc += entry.coefficient * history[(write - entry.delay + TAPS) % TAPS];
      }
      output[frame] = acc;
      write = (write + 1) % TAPS;
      history[write] = input[source + 1] ?? 0;
    }
    if (right) this.downWriteR = write;
    else this.downWriteL = write;
    return output;
  }
}
