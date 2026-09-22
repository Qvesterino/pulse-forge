import { withGenerativeTimeout } from "./timeout";
import type {
  GeneratedAudio,
  GenerativeAudioProvider,
  GenerativeInput,
  GenerativeSessionConfig,
  GenerativeStyle,
} from "./types";
import { validateGenerativeInput } from "./validation";

/** MusicCoCa audio references are capped before they leave the KYX process. */
export const MUSICOCA_STYLE_SAMPLE_RATE = 16_000;
export const GENERATIVE_REFERENCE_MAX_SECONDS = 15;
export const GENERATIVE_REFERENCE_MAX_FRAMES = MUSICOCA_STYLE_SAMPLE_RATE * GENERATIVE_REFERENCE_MAX_SECONDS;
export const GENERATIVE_VARIATION_COUNT = 4;

/** Stable, bounded provenance hash for a reference; this is not a security digest. */
export function hashGenerativeAudioReference(style: GenerativeStyle): string | undefined {
  if (style.kind !== "audio") return undefined;
  let hash = 2166136261;
  const add = (value: number): void => {
    hash ^= value | 0;
    hash = Math.imul(hash, 16777619);
  };
  add(Math.round(style.sampleRate));
  for (const channel of style.channels) {
    add(channel.length);
    for (const sample of channel) add(Math.round(sample * 1_000_000));
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface AudioReferenceSource {
  sampleRate: number;
  channels: readonly Float32Array[];
}

export interface MusicCocaAudioReference {
  kind: "audio";
  sampleRate: typeof MUSICOCA_STYLE_SAMPLE_RATE;
  channels: readonly [Float32Array];
}

export interface AudioReferenceOptions {
  maxSeconds?: number;
  startFrame?: number;
  frameCount?: number;
}

function finitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function validateSource(source: AudioReferenceSource): number {
  finitePositive(source.sampleRate, "Audio reference sampleRate");
  if (source.channels.length < 1 || source.channels.length > 2)
    throw new Error("Audio reference must be mono or stereo");
  const frames = source.channels[0]?.length ?? 0;
  if (frames <= 0) throw new Error("Audio reference is empty");
  for (const channel of source.channels) {
    if (channel.length !== frames) throw new Error("Audio reference channels must have equal length");
    for (const sample of channel)
      if (!Number.isFinite(sample)) throw new Error("Audio reference contains non-finite PCM");
  }
  return frames;
}

function downmix(source: AudioReferenceSource, startFrame: number, frameCount: number): Float32Array {
  const result = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    let value = 0;
    for (const channel of source.channels) value += channel[startFrame + frame] ?? 0;
    result[frame] = Math.max(-1, Math.min(1, value / source.channels.length));
  }
  return result;
}

function linearResample(source: Float32Array, inputRate: number, outputRate: number): Float32Array {
  const outputFrames = Math.max(1, Math.round((source.length * outputRate) / inputRate));
  const result = new Float32Array(outputFrames);
  const ratio = inputRate / outputRate;
  for (let frame = 0; frame < outputFrames; frame++) {
    const position = frame * ratio;
    const left = Math.min(source.length - 1, Math.floor(position));
    const right = Math.min(source.length - 1, left + 1);
    const mix = position - left;
    result[frame] = source[left]! + (source[right]! - source[left]!) * mix;
  }
  return result;
}

/** Downmix, cap and resample a user-selected audio reference off the audio callback. */
export function toMusicCocaAudioReference(
  source: AudioReferenceSource,
  options: AudioReferenceOptions = {},
): MusicCocaAudioReference {
  const sourceFrames = validateSource(source);
  const maxSeconds = options.maxSeconds ?? GENERATIVE_REFERENCE_MAX_SECONDS;
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > GENERATIVE_REFERENCE_MAX_SECONDS) {
    throw new Error(`Audio reference maxSeconds must be in 0..${GENERATIVE_REFERENCE_MAX_SECONDS}`);
  }
  const startFrame = Math.max(0, Math.min(sourceFrames - 1, Math.floor(options.startFrame ?? 0)));
  const requestedFrames = options.frameCount ?? sourceFrames - startFrame;
  if (!Number.isFinite(requestedFrames) || requestedFrames <= 0)
    throw new Error("Audio reference frameCount is invalid");
  const maxSourceFrames = Math.max(1, Math.floor(maxSeconds * source.sampleRate));
  const frameCount = Math.min(sourceFrames - startFrame, Math.floor(requestedFrames), maxSourceFrames);
  if (frameCount <= 0) throw new Error("Audio reference selection is empty");
  const mono = downmix(source, startFrame, frameCount);
  const resampled = linearResample(mono, source.sampleRate, MUSICOCA_STYLE_SAMPLE_RATE);
  if (resampled.length > GENERATIVE_REFERENCE_MAX_FRAMES) {
    return {
      kind: "audio",
      sampleRate: MUSICOCA_STYLE_SAMPLE_RATE,
      channels: [resampled.slice(0, GENERATIVE_REFERENCE_MAX_FRAMES)],
    };
  }
  return { kind: "audio", sampleRate: MUSICOCA_STYLE_SAMPLE_RATE, channels: [resampled] };
}

export function audioBufferToMusicCocaAudioReference(
  buffer: AudioBuffer,
  options: AudioReferenceOptions = {},
): MusicCocaAudioReference {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  return toMusicCocaAudioReference({ sampleRate: buffer.sampleRate, channels }, options);
}

export interface GenerativeVariation {
  id: string;
  label: string;
  audio: GeneratedAudio;
  input: GenerativeInput;
}

export interface GenerativeVariationOptions {
  count?: number;
  durationSec: number;
  createId?: (index: number) => string;
  timeoutMs?: number;
  signal?: AbortSignal;
  prompt?: string;
}

function chooseSessionConfig(provider: GenerativeAudioProvider, modelId: string): GenerativeSessionConfig {
  const capabilities = provider.getCapabilities();
  if (!capabilities.supportsCapture) throw new Error("Provider does not support generative resample capture");
  if (!capabilities.supportsAudioStyle) throw new Error("Provider does not support audio style references");
  if (!capabilities.modelIds.includes(modelId)) throw new Error(`Provider does not support model ${modelId}`);
  const sampleRate = capabilities.outputSampleRates.includes(48_000) ? 48_000 : capabilities.outputSampleRates[0];
  const channels = capabilities.outputChannels.includes(2) ? 2 : capabilities.outputChannels[0];
  if (!sampleRate || !channels) throw new Error("Provider has no usable output format");
  return { modelId, outputSampleRate: sampleRate, outputChannels: channels };
}

/**
 * Generate preview-only variations. Jobs are deliberately serial: MRT2's
 * native runner owns a single model/session and four parallel jobs would
 * multiply memory and GPU pressure. Nothing is persisted or added to a doc.
 */
export async function generateGenerativeVariations(
  provider: GenerativeAudioProvider,
  modelId: string,
  input: GenerativeInput,
  options: GenerativeVariationOptions,
): Promise<GenerativeVariation[]> {
  const count = Math.max(
    1,
    Math.min(GENERATIVE_VARIATION_COUNT, Math.floor(options.count ?? GENERATIVE_VARIATION_COUNT)),
  );
  if (!Number.isFinite(options.durationSec) || options.durationSec <= 0)
    throw new Error("Variation duration is invalid");
  validateGenerativeInput(input);
  if (input.style.kind !== "audio") throw new Error("Generative resample requires an audio style reference");
  const config = chooseSessionConfig(provider, modelId);
  const capabilities = provider.getCapabilities();
  const results: GenerativeVariation[] = [];
  for (let index = 0; index < count; index++) {
    if (options.signal?.aborted) throw new Error("Generative variation jobs aborted");
    const variationInput: GenerativeInput = {
      ...input,
      ...(capabilities.supportsSeed
        ? { seed: `${input.seed ?? "kyx"}:variation:${String.fromCharCode(65 + index)}` }
        : {}),
    };
    const session = await withGenerativeTimeout(provider.createSession(config), {
      operation: `variation-${index + 1}-create`,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    try {
      const audio = await withGenerativeTimeout(
        session.capture({ input: variationInput, durationSec: options.durationSec, signal: options.signal }),
        { operation: `variation-${index + 1}-capture`, timeoutMs: options.timeoutMs, signal: options.signal },
      );
      results.push({
        id: options.createId?.(index) ?? `variation-${String.fromCharCode(65 + index)}`,
        label: String.fromCharCode(65 + index),
        audio: {
          ...audio,
          provenance: {
            ...audio.provenance,
            sourceHash: hashGenerativeAudioReference(variationInput.style),
            ...(options.prompt ? { prompt: options.prompt } : {}),
          },
        },
        input: variationInput,
      });
    } finally {
      await withGenerativeTimeout(session.dispose(), {
        operation: `variation-${index + 1}-dispose`,
        timeoutMs: options.timeoutMs,
      }).catch(() => undefined);
    }
  }
  return results;
}
