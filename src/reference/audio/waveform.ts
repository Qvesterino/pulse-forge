/**
 * Min/max peak buckets for waveform display, independent of DSP data.
 * Ported from audiokey `src/audio/waveform.ts`. Never renders millions of
 * individual samples — bucket count is capped to display width needs.
 */
export interface WaveformPeaks {
  min: Float32Array;
  max: Float32Array;
  buckets: number;
  duration: number;
}

export function buildWaveformPeaks(mono: Float32Array, sampleRate: number, buckets = 1600): WaveformPeaks {
  const count = Math.max(1, Math.min(buckets, mono.length));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const step = mono.length / count;
  for (let b = 0; b < count; b++) {
    const start = Math.floor(b * step);
    const end = Math.min(mono.length, Math.floor((b + 1) * step));
    let lo = 0;
    let hi = 0;
    if (end > start) {
      lo = mono[start];
      hi = mono[start];
      for (let i = start + 1; i < end; i++) {
        const v = mono[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max, buckets: count, duration: mono.length / sampleRate };
}
