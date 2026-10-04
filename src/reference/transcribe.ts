/**
 * UN-SUNO TRANSCRIPTION CONTRACT — `transcribeTrack(pcm, sampleRate)`.
 *
 * The single seam every transcription wave lands behind (docs/UN-SUNO-PLAN.md
 * U1–U3): audio in, an honest transcription out. Today it carries what the
 * engine already measures (tempo + key from `audio-tempo-key`) and marks the
 * three missing layers EXPLICITLY unimplemented — `implemented: false` with a
 * warning, never invented content (the apply.ts honesty rule: a section under
 * the confidence gate stays empty).
 *
 * Async by contract: U1–U3 run heavy DSP in the reference worker; the
 * main-thread signature must not change when they land. Calls are cheap and
 * never throw — every estimator inside has its own guard.
 */
import { estimateKey, estimateTempo, type KeyEstimate, type TempoEstimate } from "../ai/audio-tempo-key";

export interface TranscribedLayer {
  /** false = this layer is not transcribed yet — consumers must treat it as
   * "no opinion", not as "verified empty". */
  implemented: boolean;
  warning: string | null;
}

export interface UnsunoTranscription {
  sampleRate: number;
  durationSec: number;
  tempo: TempoEstimate | null;
  key: KeyEstimate | null;
  drums: TranscribedLayer;
  bass: TranscribedLayer;
  chords: TranscribedLayer;
}

/** Which wave owns which layer — drives the pending warnings and the gated
 * KPI tests in tests/unsuno/golden-set.test.ts. */
export const TRANSCRIPTION_WAVE_OWNERS = { drums: "U3", bass: "U2", chords: "U1" } as const;

export function transcribeTrack(pcm: Float32Array, sampleRate: number): UnsunoTranscription {
  const tempo = estimateTempo(pcm, sampleRate);
  const key = estimateKey(pcm, sampleRate);
  const pending = (layer: keyof typeof TRANSCRIPTION_WAVE_OWNERS): TranscribedLayer => ({
    implemented: false,
    warning: `${layer} transcription not implemented yet — lands in ${TRANSCRIPTION_WAVE_OWNERS[layer]} (docs/UN-SUNO-PLAN.md)`,
  });
  return {
    sampleRate,
    durationSec: sampleRate > 0 ? pcm.length / sampleRate : 0,
    tempo,
    key,
    drums: pending("drums"),
    bass: pending("bass"),
    chords: pending("chords"),
  };
}
