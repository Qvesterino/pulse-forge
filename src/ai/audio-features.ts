/**
 * AUDIO FEATURE EXTRACTION (INTENT_ENGINE.md T4/D1 v3) — time-domain analysis
 * of rendered audio. No FFT, no audio context — a single pass over the sample
 * data extracts 5 features that capture the essential "character" of a beat:
 *
 *   rms         — average energy (loudness proxy)
 *   peak        — absolute maximum amplitude
 *   crestFactor — peak / RMS (high = dynamic/punchy, low = compressed)
 *   zcr         — zero-crossing rate (high = bright/noisy, low = dark/tonal)
 *   lowRatio    — energy below ~200 Hz / total energy (bass weight)
 *
 * These features allow the ranking pipeline to JUDGE BY SOUND, not just by
 * symbolic pattern data. Two candidates with identical note data can sound
 * completely different depending on samples, effects and mixing — this
 * extractor captures that difference.
 *
 * Pure math — no audio context, no DOM, no async. Single-pass, O(n).
 */

export interface AudioFeatures {
  rms: number;
  peak: number;
  crestFactor: number;
  zeroCrossingRate: number;
  lowBandRatio: number;
}

/** Additional deterministic summaries used by the versioned audio.v2 DNA contract. */
export interface AudioFeaturesV2 extends AudioFeatures {
  /** Spectral centroid divided by Nyquist, in [0, 1]. */
  spectralCentroid: number;
  /** 85% spectral-energy rolloff divided by Nyquist, in [0, 1]. */
  spectralRolloff: number;
  /** Geometric/arithmetic spectral power ratio, in [0, 1]. */
  spectralFlatness: number;
  /** Maximum normalized short-window autocorrelation in the voiced range. */
  harmonicity: number;
}

export interface StereoAudioFeatures {
  /** Side RMS / (mid RMS + side RMS), in [0, 1]. */
  width: number;
  /** Pearson-like L/R correlation remapped from [-1, 1] to [0, 1]. */
  correlation: number;
}

/** One-pole low-pass coefficient for ~200 Hz cutoff at the given rate. */
function lowPassCoef(sampleRate: number, cutoff: number): number {
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / sampleRate;
  return dt / (rc + dt);
}

export function extractAudioFeatures(data: Float32Array, sampleRate: number): AudioFeatures {
  if (data.length === 0) {
    return { rms: 0, peak: 0, crestFactor: 0, zeroCrossingRate: 0, lowBandRatio: 0 };
  }

  let sumSquares = 0;
  let peak = 0;
  let crossings = 0;
  let prevSample = data[0];

  const lpCoef = lowPassCoef(sampleRate, 200);
  let lpState = 0;
  let lowEnergy = 0;
  let totalEnergy = 0;

  for (let i = 0; i < data.length; i++) {
    const sample = data[i];
    sumSquares += sample * sample;
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    if ((sample >= 0 && prevSample < 0) || (sample < 0 && prevSample >= 0)) crossings += 1;
    prevSample = sample;

    // One-pole low-pass for bass weight
    lpState += lpCoef * (sample - lpState);
    lowEnergy += lpState * lpState;
    totalEnergy += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / data.length);
  const crestFactor = rms > 1e-10 ? peak / rms : 0;
  const zeroCrossingRate = crossings / data.length;
  const lowBandRatio = totalEnergy > 1e-10 ? lowEnergy / totalEnergy : 0;

  return {
    rms: Math.round(rms * 10000) / 10000,
    peak: Math.round(peak * 10000) / 10000,
    crestFactor: Math.round(crestFactor * 100) / 100,
    zeroCrossingRate: Math.round(zeroCrossingRate * 10000) / 10000,
    lowBandRatio: Math.round(lowBandRatio * 10000) / 10000,
  };
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

function spectrumSummary(
  data: Float32Array,
  sampleRate: number,
): Pick<AudioFeaturesV2, "spectralCentroid" | "spectralRolloff" | "spectralFlatness"> {
  const size = 2048;
  const half = size >>> 1;
  const frameCount = data.length <= size ? 1 : Math.min(8, Math.max(2, Math.floor(data.length / size)));
  const frameEnergy = new Float64Array(frameCount);
  const centroidByFrame = new Float64Array(frameCount);
  const rolloffByFrame = new Float64Array(frameCount);
  const flatnessByFrame = new Float64Array(frameCount);

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frameCount === 1 ? 0 : Math.floor(((data.length - size) * frame) / (frameCount - 1));
    const real = new Float64Array(size);
    const imag = new Float64Array(size);
    for (let index = 0; index < size; index++) {
      const sample = data[start + index] ?? 0;
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1));
      real[index] = sample * window;
    }

    // In-place radix-2 FFT. The fixed 2048-point windows keep this bounded
    // even for a full-song render and run only after rendering has completed.
    for (let index = 1, reversed = 0; index < size; index++) {
      let bit = size >>> 1;
      while (reversed & bit) {
        reversed ^= bit;
        bit >>>= 1;
      }
      reversed ^= bit;
      if (index < reversed) {
        [real[index], real[reversed]] = [real[reversed] ?? 0, real[index] ?? 0];
        [imag[index], imag[reversed]] = [imag[reversed] ?? 0, imag[index] ?? 0];
      }
    }
    for (let span = 2; span <= size; span <<= 1) {
      const halfSpan = span >>> 1;
      const angle = (-2 * Math.PI) / span;
      for (let base = 0; base < size; base += span) {
        for (let offset = 0; offset < halfSpan; offset++) {
          const twiddleAngle = angle * offset;
          const wr = Math.cos(twiddleAngle);
          const wi = Math.sin(twiddleAngle);
          const even = base + offset;
          const odd = even + halfSpan;
          const oddReal = (real[odd] ?? 0) * wr - (imag[odd] ?? 0) * wi;
          const oddImag = (real[odd] ?? 0) * wi + (imag[odd] ?? 0) * wr;
          const evenReal = real[even] ?? 0;
          const evenImag = imag[even] ?? 0;
          real[even] = evenReal + oddReal;
          imag[even] = evenImag + oddImag;
          real[odd] = evenReal - oddReal;
          imag[odd] = evenImag - oddImag;
        }
      }
    }

    let powerSum = 0;
    let weightedFrequency = 0;
    let logPowerSum = 0;
    const powers = new Float64Array(half + 1);
    for (let bin = 1; bin <= half; bin++) {
      const re = real[bin] ?? 0;
      const im = imag[bin] ?? 0;
      const power = re * re + im * im;
      powers[bin] = power;
      powerSum += power;
      weightedFrequency += power * bin;
      logPowerSum += Math.log(Math.max(power, 1e-20));
    }
    if (powerSum <= 1e-20) continue;

    const targetPower = powerSum * 0.85;
    let cumulative = 0;
    let rolloffBin = half;
    for (let bin = 1; bin <= half; bin++) {
      cumulative += powers[bin] ?? 0;
      if (cumulative >= targetPower) {
        rolloffBin = bin;
        break;
      }
    }
    const arithmeticMean = powerSum / half;
    const geometricMean = Math.exp(logPowerSum / half);
    const nyquist = Math.max(1, sampleRate / 2);
    const binHz = nyquist / half;
    frameEnergy[frame] = powerSum;
    centroidByFrame[frame] = (weightedFrequency / powerSum) * binHz;
    rolloffByFrame[frame] = rolloffBin * binHz;
    flatnessByFrame[frame] = arithmeticMean > 0 ? geometricMean / arithmeticMean : 0;
  }

  let totalWeight = 0;
  let centroid = 0;
  let rolloff = 0;
  let flatness = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const weight = frameEnergy[frame] ?? 0;
    totalWeight += weight;
    centroid += (centroidByFrame[frame] ?? 0) * weight;
    rolloff += (rolloffByFrame[frame] ?? 0) * weight;
    flatness += (flatnessByFrame[frame] ?? 0) * weight;
  }
  if (totalWeight <= 0) return { spectralCentroid: 0, spectralRolloff: 0, spectralFlatness: 0 };
  const nyquist = Math.max(1, sampleRate / 2);
  return {
    spectralCentroid: clamp01(centroid / totalWeight / nyquist),
    spectralRolloff: clamp01(rolloff / totalWeight / nyquist),
    spectralFlatness: clamp01(flatness / totalWeight),
  };
}

function estimateHarmonicity(data: Float32Array, sampleRate: number): number {
  if (data.length < 64 || !Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  const stride = Math.max(1, Math.floor(sampleRate / 11_025));
  const effectiveRate = sampleRate / stride;
  const frameSize = 1024;
  const sampledLength = Math.ceil(data.length / stride);
  const frameCount = sampledLength <= frameSize ? 1 : Math.min(4, Math.max(2, Math.floor(sampledLength / frameSize)));
  const minLag = Math.max(2, Math.floor(effectiveRate / 1_000));
  const maxLag = Math.min(frameSize >>> 1, Math.floor(effectiveRate / 60));
  if (maxLag <= minLag) return 0;
  let total = 0;
  let accepted = 0;

  for (let frame = 0; frame < frameCount; frame++) {
    const sampledStart = frameCount === 1 ? 0 : Math.floor(((sampledLength - frameSize) * frame) / (frameCount - 1));
    const samples = new Float64Array(frameSize);
    let mean = 0;
    for (let index = 0; index < frameSize; index++) {
      const value = data[(sampledStart + index) * stride] ?? 0;
      samples[index] = value;
      mean += value;
    }
    mean /= frameSize;
    let baseEnergy = 0;
    for (let index = 0; index < frameSize; index++) {
      samples[index] = (samples[index] ?? 0) - mean;
      baseEnergy += (samples[index] ?? 0) ** 2;
    }
    if (baseEnergy <= 1e-10) continue;

    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let cross = 0;
      let leftEnergy = 0;
      let rightEnergy = 0;
      for (let index = 0; index < frameSize - lag; index++) {
        const left = samples[index] ?? 0;
        const right = samples[index + lag] ?? 0;
        cross += left * right;
        leftEnergy += left * left;
        rightEnergy += right * right;
      }
      const denominator = Math.sqrt(leftEnergy * rightEnergy);
      if (denominator > 1e-10) best = Math.max(best, cross / denominator);
    }
    total += clamp01(best);
    accepted++;
  }
  return accepted > 0 ? clamp01(total / accepted) : 0;
}

/** Bounded post-render timbre/voicing analysis; never called from audio callbacks. */
export function extractAudioFeaturesV2(data: Float32Array, sampleRate: number): AudioFeaturesV2 {
  const base = extractAudioFeatures(data, sampleRate);
  const spectral = spectrumSummary(data, sampleRate);
  return {
    ...base,
    ...spectral,
    harmonicity: estimateHarmonicity(data, sampleRate),
  };
}

/** Stereo image summaries. `undefined` inputs mean the render was mono/unavailable. */
export function extractStereoAudioFeatures(left: Float32Array, right: Float32Array): StereoAudioFeatures {
  const length = Math.min(left.length, right.length);
  if (length === 0) return { width: 0, correlation: 0.5 };
  const stride = Math.max(1, Math.floor(length / 16_384));
  let midEnergy = 0;
  let sideEnergy = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  let cross = 0;
  let count = 0;
  for (let index = 0; index < length; index += stride) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (!Number.isFinite(l) || !Number.isFinite(r)) continue;
    const mid = (l + r) * 0.5;
    const side = (l - r) * 0.5;
    midEnergy += mid * mid;
    sideEnergy += side * side;
    leftEnergy += l * l;
    rightEnergy += r * r;
    cross += l * r;
    count++;
  }
  if (count === 0) return { width: 0, correlation: 0.5 };
  const midRms = Math.sqrt(midEnergy / count);
  const sideRms = Math.sqrt(sideEnergy / count);
  const denominator = Math.sqrt(leftEnergy * rightEnergy);
  const correlation = denominator > 1e-10 ? cross / denominator : 1;
  return {
    width: clamp01(sideRms / Math.max(1e-10, midRms + sideRms)),
    correlation: clamp01((Math.max(-1, Math.min(1, correlation)) + 1) * 0.5),
  };
}
