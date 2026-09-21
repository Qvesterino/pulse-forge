/**
 * Test fixtures for the F1 reference analyzer.
 *
 * Pure-Python-free signal synthesis helpers: click tracks, chroma tracks
 * (tonal sinusoids), and silence. Inputs feed directly into
 * `analyzeReference({ mono, metadata, options })` without going through
 * `decodeAudioData` so jsdom can drive the full deterministic pipeline.
 */

import type { ReferenceAudioMetadata } from "../../src/reference/types";

/** Default analysis sample rate for all fixtures. */
export const FIXTURE_SR = 22050;

/** Default FFT size aligned with the production default. */
export const FIXTURE_FFT = 2048;

/** Default hop size aligned with the production default. */
export const FIXTURE_HOP = 512;

export function makeMetadata(
  durationSeconds: number,
  overrides: Partial<ReferenceAudioMetadata> = {},
): ReferenceAudioMetadata {
  return {
    name: "fixture",
    size: Math.round(durationSeconds * FIXTURE_SR * 4),
    duration: durationSeconds,
    sampleRate: FIXTURE_SR,
    channels: 1,
    ...overrides,
  };
}

/**
 * Generate a click track — a short Hann-windowed tone at `clickHz` placed at
 * every beat boundary, with silence elsewhere. The sharp onsets give the
 * onset envelope a strong, unambiguous peak at the requested tempo.
 *
 * Click length: 25 ms. The tail between clicks is true silence (zeros).
 */
export function clickTrack(bpm: number, durationSeconds: number, clickHz = 1000): Float32Array {
  const sr = FIXTURE_SR;
  const samples = Math.floor(durationSeconds * sr);
  const out = new Float32Array(samples);
  const beatPeriodSamples = Math.round((60 / bpm) * sr);
  const clickSamples = Math.round(0.025 * sr); // 25 ms click
  for (let i = 0; i < samples; i += beatPeriodSamples) {
    const start = i;
    const end = Math.min(samples, start + clickSamples);
    for (let j = start; j < end; j++) {
      const t = (j - start) / clickSamples;
      // Hann envelope + sine tone. Amplitude 0.8 leaves headroom for envelope.
      const envelope = 0.5 * (1 - Math.cos(2 * Math.PI * t));
      out[j] = 0.8 * envelope * Math.sin(2 * Math.PI * clickHz * (j - start) / sr);
    }
  }
  return out;
}

/**
 * Generate a sustained-note track with one of the 12 pitch classes as the
 * tonic. We pick a single sine + a perfect fifth + a perfect octave so the
 * chroma profile has a clear peak. Mode determines the relative weights.
 *
 * The signal is intentionally simple — the chroma is mostly driven by the
 * tonic/octave, with the third determining major vs minor. This gives the
 * Krumhansl–Schmuckler profile rotation a deterministic winner.
 */
export function tonalTrack(
  tonic: number, // 0 = C, 1 = C#, …, 11 = B
  mode: "major" | "minor",
  durationSeconds: number,
  fundamentalHz = 220, // A3
): Float32Array {
  const sr = FIXTURE_SR;
  const samples = Math.floor(durationSeconds * sr);
  const out = new Float32Array(samples);
  // MIDI semitone → Hz. Reference: tonic + 69 → A4 = 440.
  const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);
  const tonicMidi = 57 + tonic; // A3 = MIDI 57 → tonic offset around it.
  const interval = (semitones: number): number => midi(tonicMidi + semitones);
  // Major triad: 0, 4, 7. Minor triad: 0, 3, 7. Octave: +12.
  const intervals = mode === "major" ? [0, 4, 7, 12] : [0, 3, 7, 12];
  const weights = [0.42, 0.18, 0.22, 0.18];
  for (let i = 0; i < samples; i++) {
    let v = 0;
    for (let k = 0; k < intervals.length; k++) {
      v += weights[k] * Math.sin(2 * Math.PI * interval(intervals[k]) * (i / sr));
    }
    out[i] = 0.3 * v;
  }
  return out;
}

/** All-zero PCM — represents a silent / near-silent file. */
export function silence(durationSeconds: number): Float32Array {
  return new Float32Array(Math.floor(durationSeconds * FIXTURE_SR));
}

/** PCM of a single sustained 440 Hz tone at full-scale — broadband spectral energy, no onset. */
export function drone(durationSeconds: number, freqHz = 440): Float32Array {
  const sr = FIXTURE_SR;
  const samples = Math.floor(durationSeconds * sr);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = 0.5 * Math.sin(2 * Math.PI * freqHz * (i / sr));
  }
  return out;
}
