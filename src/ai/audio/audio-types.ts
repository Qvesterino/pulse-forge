/** Shared contract for the audio tagging worker (INTENT_ENGINE.md T4). */

export interface AudioLabel {
  label: string;
  score: number;
}

export interface AudioLoadRequest {
  type: "load";
  requestId: number;
}

export interface AudioClassifyRequest {
  type: "classify";
  requestId: number;
  /** MONO audio at 16 kHz — the caller resamples before sending. */
  audio: Float32Array;
}

export type AudioRequest = AudioLoadRequest | AudioClassifyRequest;

export interface AudioLoadResponse {
  type: "load";
  requestId: number;
  ok: boolean;
  error?: string;
}

export interface AudioClassifyResponse {
  type: "classify";
  requestId: number;
  ok: boolean;
  /** Top-K AudioSet labels, score-desc. */
  labels?: AudioLabel[];
  error?: string;
}

export type AudioResponse = AudioLoadResponse | AudioClassifyResponse;
