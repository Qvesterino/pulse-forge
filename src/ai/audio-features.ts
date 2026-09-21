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
