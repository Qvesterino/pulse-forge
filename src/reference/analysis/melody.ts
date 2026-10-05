/**
 * U7 — MELODY / LEAD TRANSCRIPTION (docs/UN-SUNO-PLAN.md U7 candidate).
 *
 * Pure DSP: a rendered signal in → lead-line notes out
 * ({ startSec, durationSec, midi, velocity, confidence }).
 *
 * This is the HARDEST transcription problem (anything melodic overlaps the
 * chords' register), so the design is honest about being best-effort:
 *
 * - ISOLATION: high-pass at ~120 Hz (cascade of the bass lane's low-pass
 *   and a subtraction) removes the kick/bass floor, where most of the
 *   non-lead energy lives. Chord-pad bleed above 120 Hz stays — no cheap
 *   trick removes it — which is exactly why the gates below are strict.
 * - TRACKING: the shared pitch tracker at { fminHz: 150, fmaxHz: 1050 }
 *   (vocals + lead synth), 10 ms frames.
 * - GATES: clarity ≥ 0.65 per frame (polyphonic bleed reads as mush); a
 *   note is a run of ≥ minNoteSec with a stable pitch (±1 semitone around
 *   the median); the LAYER only reports when total coverage reaches
 *   MIN_COVERAGE — below it, "no lead line found" beats a list of
 *   chord-pad ghosts.
 *
 * Coverage is the honesty metric: the caller shows it, and the golden
 * suite pins that kick+bass+chord material without a lead comes back EMPTY.
 */

import { trackPitch, type PitchFrame } from "../../audio-workers/pitch-tracker";
import { applyLowPass } from "./bass";

export interface TranscribedMelodyNote {
  startSec: number;
  durationSec: number;
  midi: number;
  velocity: number;
  confidence: number;
}

export interface MelodyDetection {
  notes: TranscribedMelodyNote[];
  analyzedSec: number;
  /** Share of analyzed time covered by detected notes, 0..1. */
  coverage: number;
}

export interface MelodyDetectionOptions {
  bpm: number;
  /** Analysis cap in seconds (default 120, mirrors the other lanes). */
  maxSeconds?: number;
}

const HOP_MS = 10;
const FMIN_HZ = 150;
const FMAX_HZ = 1050;
const CLARITY_GATE = 0.65;
const PITCH_RUN_TOLERANCE_SEMITONES = 1;
const MIN_COVERAGE = 0.04;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function highPass(data: Float32Array, sampleRate: number, hz: number): Float32Array {
  const low = applyLowPass(data, sampleRate, hz);
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] - low[i];
  return out;
}

export function detectMelodyNotes(
  pcm: Float32Array,
  sampleRate: number,
  options: MelodyDetectionOptions,
): MelodyDetection | null {
  if (!Number.isFinite(options.bpm) || options.bpm <= 0 || sampleRate <= 0) return null;
  const maxSeconds = options.maxSeconds ?? 120;
  const analyzedSamples = Math.min(pcm.length, Math.floor(maxSeconds * sampleRate));
  const analyzedSec = analyzedSamples / sampleRate;
  if (analyzedSec < 1) return null;

  const isolated = highPass(pcm.subarray(0, analyzedSamples), sampleRate, 120);
  if (isolated.length < 2048) return null;
  const frames = trackPitch(isolated, sampleRate, { fminHz: FMIN_HZ, fmaxHz: FMAX_HZ, hopMs: HOP_MS });
  if (frames.length === 0) return null;

  const frameSec = HOP_MS / 1000;
  const stepSec = 60 / options.bpm / 4;
  const minNoteSec = Math.max((HOP_MS / 1000) * 4, stepSec * 0.5);

  const runs: PitchFrame[][] = [];
  let current: PitchFrame[] = [];
  const flush = (): void => {
    if (current.length > 0) runs.push(current);
    current = [];
  };
  for (const frame of frames) {
    if (frame.clarity < CLARITY_GATE || frame.midi <= 0) {
      flush();
      continue;
    }
    if (current.length > 0) {
      const anchor = median(current.map((f) => f.midi));
      if (Math.abs(frame.midi - anchor) > PITCH_RUN_TOLERANCE_SEMITONES) flush();
    }
    current.push(frame);
  }
  flush();

  const raw: TranscribedMelodyNote[] = [];
  for (const run of runs) {
    if (run.length * frameSec < minNoteSec) continue;
    const startSec = run[0].timeSec;
    const durationSec = run[run.length - 1].timeSec - startSec + frameSec;
    const midi = Math.round(median(run.map((f) => f.midi)));
    const confidence = run.reduce((sum, f) => sum + f.clarity, 0) / run.length;
    raw.push({
      startSec,
      durationSec,
      midi,
      // clarity-scaled velocity against the loudest run (same convention as bass)
      velocity: 0,
      confidence,
    });
  }
  const maxClarity = raw.reduce((m, n) => Math.max(m, n.confidence), 0);
  const notes = raw.map((note) => ({
    ...note,
    velocity: Math.max(1, Math.min(127, Math.round(40 + 80 * (note.confidence / Math.max(maxClarity, 1e-9))))),
  }));

  const coveredSec = notes.reduce((sum, n) => sum + n.durationSec, 0);
  const coverage = Math.min(1, coveredSec / analyzedSec);
  if (coverage < MIN_COVERAGE) return { notes: [], analyzedSec, coverage };
  return { notes, analyzedSec, coverage };
}
