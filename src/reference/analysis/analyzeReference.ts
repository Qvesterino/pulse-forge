import { preprocessForAnalysis } from "../audio/preprocess";
import { resampleLinear } from "../audio/resample";
import {
  DEFAULT_REFERENCE_OPTIONS,
  REFERENCE_ENGINE_VERSION,
  REFERENCE_SCHEMA_VERSION,
  type ReferenceAudioMetadata,
  type ReferenceDiagnostics,
  type ReferenceMap,
  type ReferenceOptions,
  type ReferenceStage,
} from "../types";
import { analyzeRhythm } from "./rhythm";
import { analyzeTonality } from "./tonal";

export interface AnalyzeReferenceInput {
  /** Already mono-summed PCM at the original sample rate. */
  mono: Float32Array;
  metadata: ReferenceAudioMetadata;
  options?: Partial<ReferenceOptions>;
  onStage?: (stage: ReferenceStage) => void;
}

export interface AnalyzeReferenceOutput {
  result: ReferenceMap;
  /** Downsampled onset envelope (max-pool to ~1500 buckets) for waveform overlay. */
  onsetEnvelope: number[];
  onsetFrameRate: number;
}

const MAX_TONAL_SECONDS = 180;

function downsampleForDisplay(x: Float32Array, target = 1500): number[] {
  if (x.length <= target) return Array.from(x, (v) => Number(v.toFixed(4)));
  const out: number[] = [];
  const step = x.length / target;
  for (let i = 0; i < target; i++) {
    const s = Math.floor(i * step);
    const e = Math.min(x.length, Math.floor((i + 1) * step));
    let max = 0;
    for (let j = s; j < e; j++) if (x[j] > max) max = x[j];
    out.push(Number(max.toFixed(4)));
  }
  return out;
}

/**
 * Core deterministic analysis entry point. Knows nothing about React or the
 * DOM. Pipeline:
 *   buffer → transients → tempo → chroma → key → finalizing
 * Calls {@link onStage} at each transition so the worker / main thread can
 * surface progress. Silent input short-circuits with null rhythm + tonal +
 * a top-level warning; silence is never silently mis-reported as music.
 *
 * Ported verbatim from audiokey-analyzer/src/analysis/analyzeAudio.ts
 * (Apache-2.0 / project-owned, see docs/REFERENCE-MAP-ROADMAP.md §B).
 */
export function analyzeReference(input: AnalyzeReferenceInput): AnalyzeReferenceOutput {
  const started = Date.now();
  const options: ReferenceOptions = { ...DEFAULT_REFERENCE_OPTIONS, ...input.options };
  const { mono, metadata, onStage } = input;
  const warnings: string[] = [];

  onStage?.("buffer");
  const analysisRate = Math.min(options.analysisSampleRate, metadata.sampleRate);
  const resampled = resampleLinear(mono, metadata.sampleRate, analysisRate);
  const { signal, peak, rms, isSilent } = preprocessForAnalysis(resampled);

  const duration = metadata.duration;
  if (duration < 1) warnings.push("Audio is extremely short; analysis is unreliable.");
  else if (duration < 10)
    warnings.push("Short audio may produce unreliable tempo analysis.");

  if (isSilent) {
    warnings.push("The audio appears to be silent or near-silent. No analysis was performed.");
    const diagnostics: ReferenceDiagnostics = {
      engineVersion: REFERENCE_ENGINE_VERSION,
      schemaVersion: REFERENCE_SCHEMA_VERSION,
      analysisSampleRate: analysisRate,
      fftSize: options.fftSize,
      hopSize: options.hopSize,
      frameCount: 0,
      onsetEnvelopeLength: 0,
      tempoRange: [options.tempoMin, options.tempoMax],
      tonalRegion: options.keyRegion,
      tonalFrameCount: 0,
      analyzedSeconds: duration,
      processingMs: Date.now() - started,
      peakAmplitude: peak,
      rmsLevel: rms,
    };
    return {
      result: {
        metadata,
        rhythm: {
          bpm: null,
          confidence: 0,
          beatIntervalSeconds: null,
          beatOffsetSeconds: null,
          beatTimes: [],
          candidates: [],
          stability: "unknown",
          localBpms: [],
          warning: "Tempo could not be determined: the audio is silent.",
        },
        tonal: {
          tonic: null,
          mode: null,
          camelot: null,
          confidence: 0,
          chroma: new Array(12).fill(0),
          candidates: [],
          warning: "Key could not be determined: the audio is silent.",
        },
        diagnostics,
        warnings,
      },
      onsetEnvelope: [],
      onsetFrameRate: analysisRate / options.hopSize,
    };
  }

  onStage?.("transients");
  const rhythm = analyzeRhythm({
    signal,
    sampleRate: analysisRate,
    fftSize: options.fftSize,
    hopSize: options.hopSize,
    tempoMin: options.tempoMin,
    tempoMax: options.tempoMax,
    durationSeconds: duration,
  });
  onStage?.("tempo");

  // Tonal region selection.
  onStage?.("chroma");
  let tonalSignal = signal;
  if (options.keyRegion === "middle" && signal.length > analysisRate * 20) {
    const start = Math.floor(signal.length * 0.1);
    const end = Math.floor(signal.length * 0.9);
    tonalSignal = signal.subarray(start, end);
  }
  const maxSamples = MAX_TONAL_SECONDS * analysisRate;
  if (tonalSignal.length > maxSamples) {
    const center = Math.floor(tonalSignal.length / 2);
    const half = Math.floor(maxSamples / 2);
    tonalSignal = tonalSignal.subarray(center - half, center + half);
  }

  const tonal = analyzeTonality({
    signal: tonalSignal,
    sampleRate: analysisRate,
    fftSize: options.fftSize,
    hopSize: options.hopSize,
  });
  onStage?.("key");

  onStage?.("finalizing");
  if (rhythm.warning) warnings.push(rhythm.warning);
  if (tonal.warning) warnings.push(tonal.warning);

  // Strip envelope/frameCount from the rhythm/tonal output before persisting
  // (envelopes are kept only in the worker for visualization).
  const { envelopes, ...rhythmResult } = rhythm;
  const { frameCount: tonalFrames, ...tonalResult } = tonal;

  const diagnostics: ReferenceDiagnostics = {
    engineVersion: REFERENCE_ENGINE_VERSION,
    schemaVersion: REFERENCE_SCHEMA_VERSION,
    analysisSampleRate: analysisRate,
    fftSize: options.fftSize,
    hopSize: options.hopSize,
    frameCount: envelopes.frameCount,
    onsetEnvelopeLength: envelopes.combined.length,
    tempoRange: [options.tempoMin, options.tempoMax],
    tonalRegion: options.keyRegion,
    tonalFrameCount: tonalFrames,
    analyzedSeconds: signal.length / analysisRate,
    processingMs: Date.now() - started,
    peakAmplitude: Number(peak.toFixed(5)),
    rmsLevel: Number(rms.toFixed(5)),
  };

  const result: ReferenceMap = {
    metadata,
    rhythm: rhythmResult,
    tonal: tonalResult,
    diagnostics,
    warnings,
  };

  return {
    result,
    onsetEnvelope: downsampleForDisplay(envelopes.combined),
    onsetFrameRate: envelopes.frameRate,
  };
}
