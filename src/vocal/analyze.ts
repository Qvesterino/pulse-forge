import { hashString } from "../shared/rng";
import { parseKey } from "../project-model/scales";
import type { MusicalKey } from "../project-model/types";
import { estimateKey, estimateTempo } from "../ai/audio-tempo-key";
import type { VocalAnalysisInput, VocalPhrase, VocalProfile } from "./types";

/**
 * VOCAL ANALYSIS DSP (V1) — pure functions over mono PCM, no RNG, no I/O.
 *
 * Key + tempo reuse the tested audio-reference estimators
 * (`src/ai/audio-tempo-key.ts`: Goertzel chroma + Krumhansl, transient
 * autocorr); energy/phrases/SNR are computed here. Deterministic: the same
 * PCM + grid always yields the same profile (and hash).
 */

/** Analyze at most this much audio (takes are songs; the head says enough). */
export const MAX_ANALYZE_SEC = 90;
/** Absolute floor — a take peaking below this is room tone, not singing. */
export const SILENCE_RMS_FLOOR = 0.004;
/**
 * Phrase gate: bars above max(0.25, median·0.5) sing. A below-gate bar
 * bridges (breath) only when it is still audible (≥ 0.1) AND singing resumes
 * within the next bar — true silence always splits the phrase.
 */
const PHRASE_FLOOR = 0.25;
const PHRASE_MEDIAN_GAIN = 0.5;
const PHRASE_BRIDGE_FLOOR = 0.1;
const PHRASE_BRIDGE_BARS = 1;

/** RMS of pcm[from, to) — pure. */
export function frameRms(pcm: Float32Array, from: number, to: number): number {
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(pcm.length, Math.ceil(to));
  if (end <= start) return 0;
  let sum = 0;
  for (let index = start; index < end; index++) {
    const v = pcm[index];
    sum += v * v;
  }
  return Math.sqrt(sum / (end - start));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Peak-to-quiet-decile ratio in dB over 2048-sample frames (rough SNR). */
export function estimateSnrDb(pcm: Float32Array, sampleRate: number): number {
  const frame = 2048;
  const hop = 1024;
  const levels: number[] = [];
  for (let start = 0; start + frame <= pcm.length; start += hop) {
    levels.push(frameRms(pcm, start, start + frame));
  }
  if (levels.length === 0) return 0;
  const peak = Math.max(...levels);
  const quiet = [...levels].sort((a, b) => a - b)[Math.floor(levels.length / 10)] ?? 0;
  if (!(peak > 0) || !(quiet > 0)) return 0;
  return 20 * Math.log10(peak / quiet);
}

/** Per-bar RMS energy, normalized 0..1 by the take maximum. */
export function perBarEnergy(pcm: Float32Array, sampleRate: number, bpm: number, bars: number): number[] {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const secPerBar = 240 / safeBpm;
  const curve: number[] = [];
  let peak = 0;
  for (let bar = 0; bar < bars; bar++) {
    const level = frameRms(pcm, bar * secPerBar * sampleRate, (bar + 1) * secPerBar * sampleRate);
    curve.push(level);
    if (level > peak) peak = level;
  }
  if (!(peak > 0)) return curve.map(() => 0);
  return curve.map((level) => Math.min(1, level / peak));
}

/** Contiguous above-threshold bar runs → phrases (audible 1-bar gaps bridge, silence splits). */
export function extractPhrases(energyCurve: number[]): VocalPhrase[] {
  if (energyCurve.length === 0) return [];
  const threshold = Math.max(PHRASE_FLOOR, median(energyCurve) * PHRASE_MEDIAN_GAIN);
  const phrases: VocalPhrase[] = [];
  let start = -1;
  let peak = 0;
  const close = (endBar: number) => {
    if (start >= 0) {
      phrases.push({ startBar: start, endBar, peakEnergy: peak });
      start = -1;
      peak = 0;
    }
  };
  for (let bar = 0; bar < energyCurve.length; bar++) {
    if (energyCurve[bar] >= threshold) {
      if (start < 0) start = bar;
      if (energyCurve[bar] > peak) peak = energyCurve[bar];
    } else if (start >= 0) {
      // Bridge a lone audible bar (breath) only when singing resumes right
      // after it; true silence always splits.
      const audible = energyCurve[bar] >= PHRASE_BRIDGE_FLOOR;
      const resumes = energyCurve.slice(bar + 1, bar + 2 + PHRASE_BRIDGE_BARS).some((v) => v >= threshold);
      if (!(audible && resumes)) close(bar - 1);
    }
  }
  close(energyCurve.length - 1);
  return phrases;
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

/** Canonical form for hashing (fixed decimals, stable key order). */
export function canonicalizeVocalProfile(profile: Omit<VocalProfile, "profileHash">): string {
  return JSON.stringify({
    version: profile.version,
    key: profile.key,
    keyConfidence: round4(profile.keyConfidence),
    keyMeasured: profile.keyMeasured,
    tempoBpm: profile.tempoBpm,
    tempoConfidence: round4(profile.tempoConfidence),
    tempoMeasured: profile.tempoMeasured,
    energyCurve: profile.energyCurve.map(round4),
    phrases: profile.phrases.map((p) => [p.startBar, p.endBar, round4(p.peakEnergy)]),
    silenceRatio: round4(profile.silenceRatio),
    snrDb: round4(profile.snrDb),
    durationSec: round4(profile.durationSec),
    bars: profile.bars,
    bpm: profile.bpm,
    measured: profile.measured,
  });
}

export function vocalProfileHash(profile: Omit<VocalProfile, "profileHash">): string {
  return (hashString(canonicalizeVocalProfile(profile)) >>> 0).toString(16).padStart(8, "0");
}

/**
 * Full take → VocalProfile. NEVER throws (estimators are try/caught
 * internally; anything unexpected resolves to an unmeasured profile).
 */
export function buildVocalProfile(input: VocalAnalysisInput): VocalProfile {
  try {
    const sampleRate = input.sampleRate;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || input.pcm.length === 0) {
      return emptyProfile(input);
    }
    const pcm = input.pcm.subarray(0, Math.min(input.pcm.length, Math.floor(MAX_ANALYZE_SEC * sampleRate)));
    const bpm = Number.isFinite(input.bpm) && input.bpm > 0 ? input.bpm : 120;
    const durationSec = pcm.length / sampleRate;
    const bars = Math.min(512, Math.floor(durationSec / (240 / bpm)));

    const peak = peakRms(pcm);
    if (!(peak >= SILENCE_RMS_FLOOR) || bars < 1) {
      return { ...emptyProfile(input), durationSec: round4(durationSec), snrDb: 0 };
    }

    const keyRaw = estimateKey(pcm, sampleRate);
    const key = keyRaw && parseKey(keyRaw.key as MusicalKey) ? (keyRaw.key as MusicalKey) : null;
    const tempoRaw = estimateTempo(pcm, sampleRate);

    const energyCurve = perBarEnergy(pcm, sampleRate, bpm, bars).map(round4);
    const phrases = extractPhrases(energyCurve);
    const silentBars = energyCurve.filter((v) => v < PHRASE_FLOOR).length;

    const base: Omit<VocalProfile, "profileHash"> = {
      version: 1,
      key,
      keyConfidence: key && keyRaw ? round4(keyRaw.confidence) : 0,
      keyMeasured: key !== null,
      tempoBpm: tempoRaw ? tempoRaw.bpm : null,
      tempoConfidence: tempoRaw ? round4(tempoRaw.confidence) : 0,
      tempoMeasured: tempoRaw !== null,
      energyCurve,
      phrases,
      silenceRatio: round4(silentBars / Math.max(1, bars)),
      snrDb: round4(estimateSnrDb(pcm, sampleRate)),
      durationSec: round4(durationSec),
      bars,
      bpm: Math.round(bpm * 10) / 10,
      measured: true,
    };
    return { ...base, profileHash: vocalProfileHash(base) };
  } catch {
    return emptyProfile(input);
  }
}

function peakRms(pcm: Float32Array): number {
  const frame = 2048;
  let peak = 0;
  for (let start = 0; start + frame <= pcm.length; start += frame) {
    const level = frameRms(pcm, start, start + frame);
    if (level > peak) peak = level;
  }
  return peak;
}

function emptyProfile(input: VocalAnalysisInput): VocalProfile {
  const base: Omit<VocalProfile, "profileHash"> = {
    version: 1,
    key: null,
    keyConfidence: 0,
    keyMeasured: false,
    tempoBpm: null,
    tempoConfidence: 0,
    tempoMeasured: false,
    energyCurve: [],
    phrases: [],
    silenceRatio: 1,
    snrDb: 0,
    durationSec: 0,
    bars: 0,
    bpm: Number.isFinite(input.bpm) && input.bpm > 0 ? input.bpm : 120,
    measured: false,
  };
  return { ...base, profileHash: vocalProfileHash(base) };
}
