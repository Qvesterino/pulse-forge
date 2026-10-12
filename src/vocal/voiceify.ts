/**
 * HUM→VOICE (W3 of the vocal campaign, 2026-10-12) — the user's own hum,
 * tuned and assembled into a lead.
 *
 * The anti-SUNO wedge: SUNO sings with someone else's voice; KYX sings with
 * YOURS. The hum recording (already decoded by the voice-idea flow) is the
 * timbre source; the target melody (hum-to-notes output, or any note list)
 * is the pitch/duration authority. Per target note the engine:
 *
 *   1. estimates the hum's own pitch ONCE (autocorrelation at the loudest
 *      window — humming one sustained vowel is the common case);
 *   2. derives the resample ratio 2^((target − source)/12) — the classic
 *      pitch-shift-by-resample (timbre intact, pitch moves);
 *   3. reads the hum's SUSTAINED REGION cyclically at that ratio (the
 *      region is pre-crossfaded into a seamless loop, so wraps read as
 *      vibrato, not clicks);
 *   4. fades the note edges so consecutive notes phase-cleanly separate.
 *
 * Pure DSP over Float32Array — no AudioContext, deterministic, testable in
 * vitest with a synthetic hum.
 */

/** A target melody note for the voiceify assembler. */
export interface VoiceifyNote {
  /** Target pitch (MIDI). */
  midi: number;
  /** Note start in ticks (the project PPQ grid). */
  startTicks: number;
  /** Note length in ticks. */
  durationTicks: number;
}

export interface VoiceifyOptions {
  /** Project tempo — ticks → seconds. Default 120. */
  bpm?: number;
  /** Ticks per quarter note. Default 480 (the project PPQ). */
  ppq?: number;
  /** Output gain. Default 0.8 — headroom for stacked harmonies. */
  gain?: number;
  /** Silence gate for the sustained-region scan (linear 0..1). Default 0.02. */
  gate?: number;
}

const MIDI_A4 = 69;
const DEFAULT_BPM = 120;
const DEFAULT_PPQ = 480;
const DEFAULT_GAIN = 0.8;
const DEFAULT_GATE = 0.02;
const FADE_MS = 5;
const WINDOW = 4096;

/** MIDI → Hz (A4 = 440). */
function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - MIDI_A4) / 12);
}

/** The loudest WINDOW-sample window's start (the sustained "ah" lives there). */
function loudestWindowStart(audio: Float32Array): number {
  let best = 0;
  let bestRms = -1;
  for (let start = 0; start + WINDOW <= audio.length; start += WINDOW / 2) {
    let sum = 0;
    for (let i = 0; i < WINDOW; i++) sum += audio[start + i] * audio[start + i];
    const rms = Math.sqrt(sum / WINDOW);
    if (rms > bestRms) {
      bestRms = rms;
      best = start;
    }
  }
  return best;
}

/**
 * Estimate the hum's pitch at its loudest point: autocorrelation over
 * 60–500 Hz on a 4096 window. Pure, deterministic. Null when the audio is
 * silent or too short to correlate.
 */
export function estimateHumMidi(audio: Float32Array, sampleRate: number): number | null {
  if (audio.length < WINDOW) return null;
  const start = loudestWindowStart(audio);
  const minLag = Math.max(1, Math.floor(sampleRate / 500));
  const maxLag = Math.min(WINDOW - 1, Math.floor(sampleRate / 60));
  let energy = 0;
  for (let i = 0; i < WINDOW; i++) energy += audio[start + i] * audio[start + i];
  if (energy < 1e-6) return null;
  // Pass 1: best normalized score over the plausible range. For a periodic
  // signal the correlation peaks at every period multiple, and any lag NEAR
  // a multiple also scores high — so a plain global max lands on later
  // multiples (octave errors) and a threshold picks peak shoulders
  // (±100-cent errors).
  let bestScore = 0;
  const scores = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < WINDOW - lag; i++) sum += audio[start + i] * audio[start + i + lag];
    scores[lag] = sum / (WINDOW - lag);
    if (scores[lag] > bestScore) bestScore = scores[lag];
  }
  if (bestScore <= 0) return null;
  // Pass 2: LOCAL maxima scoring ≥ 0.8 of the best, smallest first — the
  // smallest such peak is the fundamental (later peaks are its multiples).
  let bestLag = 0;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (scores[lag] >= bestScore * 0.8 && scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) {
      bestLag = lag;
      break;
    }
  }
  if (bestLag === 0) return null;
  // Parabolic interpolation on the peak's three points — the raw lag grid
  // (sampleRate / integer) quantizes ~±80 cents at low pitches.
  const left = scores[bestLag - 1];
  const center = scores[bestLag];
  const right = scores[bestLag + 1];
  const denom = left - 2 * center + right;
  const shift = denom !== 0 ? (0.5 * (left - right)) / denom : 0;
  const refined = bestLag + Math.max(-1, Math.min(1, shift));
  const midi = MIDI_A4 + 12 * Math.log2(sampleRate / refined / 440);
  return Number.isFinite(midi) ? Math.round(midi * 100) / 100 : null;
}

/**
 * The hum's sustained region: first-to-last sample above the gate, then
 * crossfaded into a seamless loop (the tail melts into the head — a wrap
 * then reads as vibrato, not a click).
 */
function seamlessRegion(audio: Float32Array, gate: number): Float32Array {
  let first = -1;
  let last = -1;
  for (let i = 0; i < audio.length; i++) {
    if (Math.abs(audio[i]) > gate) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0 || last - first < 480) return audio.slice();
  const region = audio.slice(first, last + 1);
  const fade = Math.min(Math.floor(region.length / 4), 2400);
  if (fade <= 0) return region;
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    region[i] = region[i] * t + region[region.length - fade + i] * (1 - t);
  }
  return region;
}

/**
 * HUM→VOICE: the tuned, assembled lead. The output covers every note's
 * span; untouched gaps are silence. Deterministic.
 */
export function voiceifyHum(
  audio: Float32Array,
  sampleRate: number,
  notes: readonly VoiceifyNote[],
  options: VoiceifyOptions = {},
): Float32Array {
  if (notes.length === 0) return new Float32Array(0);
  const bpm = options.bpm ?? DEFAULT_BPM;
  const ppq = options.ppq ?? DEFAULT_PPQ;
  const gain = options.gain ?? DEFAULT_GAIN;
  const gate = options.gate ?? DEFAULT_GATE;

  const sourceMidi = estimateHumMidi(audio, sampleRate);
  if (sourceMidi === null) return new Float32Array(0);

  const region = seamlessRegion(audio, gate);
  if (region.length === 0) return new Float32Array(0);

  const ticksToSec = 60 / bpm / ppq;
  let endTicks = 0;
  for (const note of notes) endTicks = Math.max(endTicks, note.startTicks + note.durationTicks);
  const outLength = Math.max(1, Math.ceil(endTicks * ticksToSec * sampleRate));
  const out = new Float32Array(outLength);

  const fadeSamples = Math.max(1, Math.floor((FADE_MS / 1000) * sampleRate));
  let phase = 0;

  for (const note of notes) {
    // Resample ratio: target pitch over the hum's own (timbre stays, pitch
    // moves to the melody).
    const noteRatio = midiToHz(note.midi) / midiToHz(sourceMidi);
    const startSample = Math.floor(note.startTicks * ticksToSec * sampleRate);
    const lengthSamples = Math.max(1, Math.floor(note.durationTicks * ticksToSec * sampleRate));
    const noteFade = Math.min(fadeSamples, Math.floor(lengthSamples / 2));
    for (let i = 0; i < lengthSamples; i++) {
      const index = startSample + i;
      if (index >= outLength) break;
      phase += noteRatio;
      phase -= region.length * Math.floor(phase / region.length);
      const position = Math.floor(phase);
      const frac = phase - position;
      const value = (region[position] ?? 0) * (1 - frac) + (region[(position + 1) % region.length] ?? 0) * frac;
      const edge = i < noteFade ? i / noteFade : i >= lengthSamples - noteFade ? (lengthSamples - i) / noteFade : 1;
      out[index] += value * gain * edge;
    }
  }
  return out;
}
