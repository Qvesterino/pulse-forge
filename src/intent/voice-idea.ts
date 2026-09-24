/**
 * VOICE IDEA — the producer listens to THE ARTIST (Fázy 1+2).
 *
 * A solo artist hums/sings their idea into the mic; this turns that recording
 * into the same currency the Intent Engine already speaks:
 *
 *   - KEY from Goertzel chroma (the artist's tone — the beat goes to them);
 *   - TEMPO from energy-flux autocorrelation (syllable/note pulses);
 *   - MELODY: the YIN pitch tracker + hum-to-notes segmentation → quantized
 *     NoteEvents in the artist's key — later injected as the LEAD hook of a
 *     SUNO MODE song.
 *
 * `track` is injectable (tests pass synthetic PitchFrames); production uses
 * the shared YIN worker client. NEVER throws — partial results degrade: no
 * key/tempo → no patch fields; no frames → no melody; still returns the rest.
 */
import { trackPitchAsync } from "../audio-workers/pitch-tracker-client";
import type { PitchFrame } from "../audio-workers/pitch-tracker";
import { framesToNotes } from "../midi/hum-to-notes";
import { estimateKey, estimateTempo } from "../ai/audio-tempo-key";
import { STEP_TICKS } from "../project-model/types";
import type { NoteEvent } from "../project-model/types";
import type { IntentInput } from "./types";

export type TrackPitchFn = (pcm: Float32Array, sampleRate: number) => Promise<PitchFrame[]>;

export interface VoiceIdeaResult {
  bpm: number | null;
  bpmConfidence: number | null;
  key: string | null;
  /** Quantized hummed melody (ticks relative to loop start, in the hum key). */
  notes: NoteEvent[];
  /** Tick length of one hum loop (loopBars × 16 × STEP_TICKS). */
  loopTicks: number;
  noteCount: number;
  patch: IntentInput;
  summary: string;
}

export interface VoiceIdeaOptions {
  /** Explicit tempo ("at 128") — skips flux detection. */
  bpm?: number;
  /** Injectable pitch tracker (tests pass synthetic frames). */
  track?: TrackPitchFn;
  /** Hum loop length in bars. Default 4. */
  loopBars?: number;
  /**
   * Beat-synced take: transport tick at the recording start — note times map
   * from this position and wrap modulo `patternLengthTicks` (the loop grid).
   */
  transportStartTick?: number;
  /** Loop grid length in ticks for the transportStartTick mapping. */
  patternLengthTicks?: number;
}

export const DEFAULT_HUM_LOOP_BARS = 4;

/**
 * Analyze a mono voice recording (any sample rate) into an intent patch
 * (bpmRange + key) plus the hummed melody as NoteEvents.
 */
export async function analyzeVoiceIdea(
  pcm: Float32Array,
  sampleRate: number,
  options: VoiceIdeaOptions = {},
): Promise<VoiceIdeaResult | null> {
  try {
    const keyEstimate = estimateKey(pcm, sampleRate);
    const tempo = options.bpm ? null : estimateTempo(pcm, sampleRate);
    const bpm = options.bpm ?? tempo?.bpm ?? null;

    const tracker = options.track ?? trackPitchAsync;
    const frames = (await tracker(pcm, sampleRate)) ?? [];
    const loopBars = options.loopBars ?? DEFAULT_HUM_LOOP_BARS;
    const loopTicks = loopBars * 16 * STEP_TICKS;

    const notes =
      frames.length > 0
        ? framesToNotes(frames, {
            bpm: bpm ?? 120,
            key: (keyEstimate?.key as IntentInput["key"]) ?? null,
            patternLengthTicks: loopTicks,
            quantize: true,
            ...(options.transportStartTick !== undefined ? { transportStartTick: options.transportStartTick } : {}),
            ...(options.patternLengthTicks !== undefined ? { patternLengthTicks: options.patternLengthTicks } : {}),
          })
        : [];

    const patch: IntentInput = {};
    if (bpm) patch.bpmRange = [Math.round(bpm) - 2, Math.round(bpm) + 2];
    if (keyEstimate) patch.key = keyEstimate.key as IntentInput["key"];

    const summary = `${bpm ?? "?"} BPM, ${keyEstimate?.key ?? "?"} — ${notes.length} notes`;
    return {
      bpm,
      bpmConfidence: tempo?.confidence ?? null,
      key: keyEstimate?.key ?? null,
      notes,
      loopTicks,
      noteCount: notes.length,
      patch,
      summary,
    };
  } catch {
    return null;
  }
}
