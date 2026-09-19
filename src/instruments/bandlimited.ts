/**
 * Band-limited oscillator tables for the static-waveform synths.
 *
 * Native OscillatorNode saw/square/triangle are naive — every harmonic above
 * Nyquist folds straight back as inharmonic whine, clearly audible on bright
 * high leads (e.g. a 2 kHz saw at 48 kHz folds its 13th+ harmonics all over
 * the top octave). These tables carry exactly the harmonics below Nyquist
 * for the scheduled pitch (additive synthesis, no windowing tricks), so a
 * voice built with `setPeriodicWave` cannot alias by construction.
 *
 * Design notes:
 *  - Tables are per MIDI note (harmonic count = floor(sr/2 / f0), no cap —
 *    full cleanup down to the lowest scheduled pitch), cached per context.
 *  - RMS-normalized to the naive equivalents (saw/tri 1/√3, square 1), so
 *    drive/filter staging and preset loudness keep their meaning.
 *  - Sine stays native (exact, no aliasing possible).
 *  - FM paths (fm/modulator, keys carriers) keep native oscillators: their
 *    frequency is audio-rate modulated, which a static table cannot follow.
 *    Documented residual, not an oversight.
 *  - Glide/pitch ramps keep working — the spectrum is frozen at the schedule
 *    pitch while the frequency glides (standard wavetable-glide behavior).
 */

export type BandlimitedWave = "sawtooth" | "square" | "triangle";

export interface BandlimitedCoefficients {
  /** Cosine terms (all zero — classic waveforms are odd-symmetric). */
  real: Float32Array;
  /** Sine terms, index = harmonic number (index 0 unused). */
  imag: Float32Array;
  /** Fundamental frequency the table was built for. */
  fundamentalHz: number;
  /** Sample rate the harmonic count was derived from. */
  sampleRate: number;
  /** Number of harmonics below Nyquist (imag length − 1). */
  harmonicCount: number;
}

/** Target RMS of the naive equivalents (loudness-preserving normalization). */
export const BANDLIMITED_RMS: Record<BandlimitedWave, number> = {
  sawtooth: 1 / Math.sqrt(3),
  square: 1,
  triangle: 1 / Math.sqrt(3),
};

/**
 * Pure coefficient builder (no audio context — unit-testable). The returned
 * series contains no energy above Nyquist by construction.
 */
export function bandlimitedCoefficients(
  wave: BandlimitedWave,
  freqHz: number,
  sampleRate: number,
): BandlimitedCoefficients {
  const f0 = Math.max(1, freqHz);
  const sr = Math.max(8000, sampleRate);
  const harmonicCount = Math.max(1, Math.floor(sr / 2 / f0));
  const real = new Float32Array(harmonicCount + 1);
  const imag = new Float32Array(harmonicCount + 1);
  for (let n = 1; n <= harmonicCount; n++) {
    if (wave === "sawtooth") {
      // Saw: 2·(−1)^(n+1) / (π·n).
      imag[n] = (n % 2 === 1 ? 2 : -2) / (Math.PI * n);
    } else if (wave === "square") {
      // Square: odd harmonics only, 4 / (π·n).
      if (n % 2 === 1) imag[n] = 4 / (Math.PI * n);
    } else {
      // Triangle: odd harmonics, alternating sign, 1/n² falloff —
      // 8/π² · (−1)^((n−1)/2) / n².
      if (n % 2 === 1) {
        const k = (n - 1) / 2;
        imag[n] = (k % 2 === 0 ? 8 : -8) / (Math.PI * Math.PI * n * n);
      }
    }
  }
  // RMS-normalize to the naive loudness (Σ a_n²/2 over harmonics).
  let energy = 0;
  for (let n = 1; n <= harmonicCount; n++) energy += (imag[n] * imag[n]) / 2;
  const target = BANDLIMITED_RMS[wave];
  const scale = energy > 1e-12 ? target / Math.sqrt(energy) : 1;
  if (scale !== 1) {
    for (let n = 1; n <= harmonicCount; n++) imag[n] *= scale;
  }
  return { real, imag, fundamentalHz: f0, sampleRate: sr, harmonicCount };
}

/** MIDI note number for a frequency (clamped to 0..127 for cache keys). */
export function freqToMidi(freqHz: number): number {
  if (!Number.isFinite(freqHz) || freqHz <= 0) return 69;
  return Math.max(0, Math.min(127, Math.round(69 + 12 * Math.log2(freqHz / 440))));
}

const tableCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();

/**
 * Cached band-limited PeriodicWave for a waveform at a pitch. Thin wrapper
 * over the pure builder — the only part needing a real context.
 */
export function periodicWaveFor(ctx: BaseAudioContext, wave: BandlimitedWave, freqHz: number): PeriodicWave {
  const sr = ctx.sampleRate || 44100;
  const key = `${wave}:${freqToMidi(freqHz)}:${sr}`;
  let perCtx = tableCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    tableCache.set(ctx, perCtx);
  }
  const hit = perCtx.get(key);
  if (hit) return hit;
  // Build at the exact scheduled frequency (not the quantized MIDI pitch)
  // so detuned/unison voices keep their true harmonic cutoff.
  const { real, imag } = bandlimitedCoefficients(wave, freqHz, sr);
  const table = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  perCtx.set(key, table);
  return table;
}

/**
 * Shape an oscillator like the legacy `osc.type = wave` assignment, but
 * band-limited for saw/square/triangle. Sine passes through natively.
 * Drop-in for voice factories: same call shape, same timing semantics —
 * only the spectrum changes (no aliasing).
 */
export function shapeOscillator(
  ctx: BaseAudioContext,
  osc: OscillatorNode,
  wave: OscillatorType | string,
  freqHz: number,
): void {
  if (wave === "sawtooth" || wave === "square" || wave === "triangle") {
    osc.setPeriodicWave(periodicWaveFor(ctx, wave, freqHz));
  } else {
    osc.type = wave as OscillatorType;
  }
}
