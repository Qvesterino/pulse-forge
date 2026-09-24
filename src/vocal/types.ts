import type { MusicalKey } from "../project-model/types";

/**
 * VOCAL PROFILE (V1 "Pocujem ta") — what the engine HEARD in a vocal take.
 *
 * A proposal, never a mutation: analysis produces this serializable record
 * (with a content hash); application happens later through undoable commands
 * (`adapt.ts`). Every field that the signal cannot support stays null/false
 * with `measured: false` — the engine admits deafness instead of guessing.
 */

export interface VocalPhrase {
  /** First bar (inclusive, 0-based) on the analysis grid. */
  startBar: number;
  /** Last bar (inclusive). */
  endBar: number;
  /** Peak per-bar energy inside the phrase (0..1). */
  peakEnergy: number;
}

export interface VocalProfile {
  version: 1;
  /** Estimated musical key ("A Natural Minor" format) — null when unmeasurable. */
  key: MusicalKey | null;
  /** Margin between best/second-best key correlation (0..~2). */
  keyConfidence: number;
  keyMeasured: boolean;
  /** Estimated beat tempo (BPM, folded 70..180) — null when unmeasurable. */
  tempoBpm: number | null;
  /** Share of autocorrelation mass at the tempo peak (0..1). */
  tempoConfidence: number;
  tempoMeasured: boolean;
  /** Per-bar RMS energy, normalized 0..1 by the take maximum. */
  energyCurve: number[];
  /** Sung phrases as bar spans (pauses between them = future pockets). */
  phrases: VocalPhrase[];
  /** Share of bars below the silence gate (0..1). */
  silenceRatio: number;
  /** Peak-to-quiet-decile ratio in dB (rough SNR). */
  snrDb: number;
  /** Take length actually analyzed (seconds, capped). */
  durationSec: number;
  /** Bar count on the analysis grid. */
  bars: number;
  /** Project BPM the bar grid was built on. */
  bpm: number;
  /** False when the take is silence/garbage — nothing else is trustworthy. */
  measured: boolean;
  /** Content hash (8 hex chars) — provenance for applied commands. */
  profileHash: string;
}

/** Raw analyzer input — source-agnostic (file drop or arrangement take PCM). */
export interface VocalAnalysisInput {
  /** Mono PCM, any sample rate (analysis adapts frame sizes to it). */
  pcm: Float32Array;
  sampleRate: number;
  /** Project BPM at analysis time — defines the bar grid. */
  bpm: number;
}
