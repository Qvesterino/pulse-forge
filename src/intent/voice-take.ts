/**
 * VOICE TAKE — what did the artist actually record? (Hum-to-Beat W1)
 *
 * One mic take may carry a MELODY (hummed/sung), a RHYTHM (beatbox, claps,
 * taps) or both. The two analyzers alone cannot tell them apart: the groove
 * extractor happily finds "onsets" in a hummed melody (every note start is
 * an energy rise) and YIN happily reports pitch noise on claps.
 *
 * The discriminator is ATTACK SHARPNESS: percussive material jumps from
 * quiet to peak within ~20 ms and decays immediately; vocal onsets rise
 * softly and SUSTAIN. Both measures are plain frame statistics — no models,
 * no throwing, deterministic.
 *
 * Verdicts feed the IDEA 2.0 strip: melody → the voice instrument / SONG
 * lead, rhythm → the drum track (the same machinery the 🎧 REF file path
 * uses — the microphone finally feeds it).
 */
import { resampleLinear } from "../sample-library/audio-index";
import { extractGrooveGrid, type GrooveExtraction } from "./groove-extraction";
import { analyzeVoiceIdea, type VoiceIdeaOptions, type VoiceIdeaResult } from "./voice-idea";

export type VoiceTakeVerdict = "empty" | "melodic" | "percussive" | "both";

export interface VoiceTakeAnalysis {
  verdict: VoiceTakeVerdict;
  melody: VoiceIdeaResult | null;
  groove: GrooveExtraction | null;
  /** Impulsive frames — the percussive-lane evidence (absolute count). */
  sharpFrames: number;
  /** Diagnostic share of strong frames that are impulsive. */
  sharpRatio: number;
  /** Sustain: share of strong frames sitting above half the peak RMS (0..1). */
  sustainRatio: number;
  summary: string;
}

export interface VoiceTakeOptions extends VoiceIdeaOptions {
  /** Analysis rate for the groove pass (default 16 kHz, the 🎧 REF rate). */
  grooveSampleRate?: number;
}

/** ≥3 quantized notes before the melody lane counts. */
const MIN_MELODY_NOTES = 3;
/** ≥2 filled steps of 16 — thinner than that is not a playable groove. */
const MIN_GROOVE_COVERAGE = 0.125;
/** The extractor itself refuses takes with fewer onsets. */
const MIN_GROOVE_HITS = 4;
/** A strong frame peaks within this many frames of being quiet (20 ms frames → ≤40 ms attack). */
const SHARP_ATTACK_FRAMES = 2;
/** Strong = frame RMS above this share of the take's peak frame RMS. */
const STRONG_FRAME_SHARE = 0.3;
/** Frame crest (peak/RMS) above this is an impulsive burst — a sine sits at ~1.41. */
const SHARP_CREST = 3;
/** Percussive verdict needs at least this many impulsive frames (~4 taps). */
const SHARP_FRAMES_MIN = 8;
/** Percussive verdict when at least this share of strong frames are sharp attacks. */
const SHARP_RATIO_THRESHOLD = 0.5;
/** Melodic sustain floor: voiced material holds level; taps collapse instantly. */
const SUSTAIN_RATIO_THRESHOLD = 0.35;

const FRAME_SECONDS = 0.02;

export interface Percussiveness {
  /** Impulsive frames (crest ≥ SHARP_CREST, RMS ≥ strong) — absolute count. */
  sharpFrames: number;
  /** Diagnostic share of strong frames that are impulsive (sparse taps over a
   * hum stay LOW even when the taps are real — use sharpFrames to decide). */
  sharpRatio: number;
  sustainRatio: number;
  strongFrames: number;
}

/**
 * Frame statistics that separate "taps" from "hums": an impulsive frame has
 * crest (peak/RMS) ≥ SHARP_CREST — a sine sits at ~1.41, a 15 ms burst at
 * 3+. The DECISION uses the absolute sharpFrames count (sparse taps over a
 * sustained hum never win a ratio against the hum's plateaus); sustainRatio
 * (plateaus holding ≥½ their level) is the voiced-material signature.
 * Pure, deterministic, O(n).
 */
export function measurePercussiveness(pcm: Float32Array, sampleRate: number): Percussiveness {
  const frameLength = Math.max(1, Math.round(FRAME_SECONDS * sampleRate));
  const frames = Math.floor(pcm.length / frameLength);
  if (frames < 4) return { sharpFrames: 0, sharpRatio: 0, sustainRatio: 0, strongFrames: 0 };
  const rms = new Float32Array(frames);
  const crest = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    let framePeak = 0;
    const start = frame * frameLength;
    for (let index = start; index < start + frameLength; index += 1) {
      const value = pcm[index]!;
      sum += value * value;
      framePeak = Math.max(framePeak, Math.abs(value));
    }
    rms[frame] = Math.sqrt(sum / frameLength);
    crest[frame] = rms[frame]! > 0 ? framePeak / rms[frame]! : 0;
  }
  let peak = 0;
  for (let frame = 0; frame < frames; frame += 1) peak = Math.max(peak, rms[frame]!);
  const strongLevel = peak * STRONG_FRAME_SHARE;
  if (strongLevel <= 0) return { sharpFrames: 0, sharpRatio: 0, sustainRatio: 0, strongFrames: 0 };
  let strongFrames = 0;
  let sharp = 0;
  let sustained = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    if (rms[frame]! < strongLevel) continue;
    strongFrames += 1;
    if (crest[frame]! >= SHARP_CREST) sharp += 1;
    // Sustain: still ≥½ this frame's level a few frames later (a plateau,
    // not a decay tail).
    const hold = rms[Math.min(frames - 1, frame + SHARP_ATTACK_FRAMES)] ?? 0;
    if (hold >= rms[frame]! / 2) sustained += 1;
  }
  return {
    sharpFrames: sharp,
    sharpRatio: strongFrames > 0 ? sharp / strongFrames : 0,
    sustainRatio: strongFrames > 0 ? sustained / strongFrames : 0,
    strongFrames,
  };
}

/**
 * Analyze one mic take into a verdict plus both lanes. NEVER throws — a
 * failing analyzer degrades to null and the verdict follows the survivor.
 */
export async function analyzeVoiceTake(
  pcm: Float32Array,
  sampleRate: number,
  options: VoiceTakeOptions = {},
): Promise<VoiceTakeAnalysis> {
  const melody = await analyzeVoiceIdea(pcm, sampleRate, options);
  const percussiveness = measurePercussiveness(pcm, sampleRate);

  let groove: GrooveExtraction | null = null;
  try {
    const grooveRate = options.grooveSampleRate ?? 16000;
    const grid = sampleRate === grooveRate ? pcm : resampleLinear(pcm, sampleRate, grooveRate);
    groove = extractGrooveGrid(grid, grooveRate, options.bpm ? { bpm: options.bpm } : {});
  } catch {
    groove = null;
  }

  const melodic =
    !!melody && melody.noteCount >= MIN_MELODY_NOTES && percussiveness.sustainRatio >= SUSTAIN_RATIO_THRESHOLD;
  // Absolute impulsive-frame count, not a ratio: sparse taps over a sustained
  // hum never win a share against the hum's own plateaus.
  const percussive =
    !!groove &&
    groove.hits.length >= MIN_GROOVE_HITS &&
    groove.coverage >= MIN_GROOVE_COVERAGE &&
    percussiveness.sharpFrames >= SHARP_FRAMES_MIN;

  const verdict: VoiceTakeVerdict =
    melodic && percussive ? "both" : melodic ? "melodic" : percussive ? "percussive" : "empty";
  const parts: string[] = [];
  if (melodic && melody) parts.push(`melódia ${melody.noteCount} not`);
  if (percussive && groove) parts.push(`rytmus ${Math.round(groove.coverage * 100)} % gridu`);
  if (parts.length === 0) parts.push("nerozpoznaný obsah — skús to jasnejšie");
  const summary = parts.join(" + ");

  return {
    verdict,
    melody,
    groove,
    sharpFrames: percussiveness.sharpFrames,
    sharpRatio: percussiveness.sharpRatio,
    sustainRatio: percussiveness.sustainRatio,
    summary,
  };
}

export { MIN_GROOVE_COVERAGE, MIN_MELODY_NOTES, SHARP_FRAMES_MIN, SHARP_RATIO_THRESHOLD, SUSTAIN_RATIO_THRESHOLD };
