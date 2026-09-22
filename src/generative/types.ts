/**
 * Provider-neutral contracts for KYX generative audio.
 *
 * This file deliberately contains no Web Audio nodes, React state or native
 * MRT2 imports. Providers adapt their own runtime to these bounded contracts.
 */

export const GENERATIVE_PITCH_COUNT = 128;
export const GENERATIVE_FRAME_RATE_HZ = 25;
export const GENERATIVE_MAX_STYLE_TEXT_LENGTH = 400;
export const GENERATIVE_MAX_CAPTURE_SECONDS = 120;

export type GenerativeDrumsMode = "off" | "on" | "provider-default";

export type GenerativeStyle =
  { kind: "text"; text: string } | { kind: "audio"; sampleRate: number; channels: readonly Float32Array[] };

export interface GenerativeMacroValues {
  energy: number;
  density: number;
  variation: number;
  texture: number;
}

export type GenerativeMacroName = keyof GenerativeMacroValues;
export type GenerativeMacroSupport = "native" | "wrapper" | "unsupported";
export type GenerativeMacroSupportMap = Readonly<Partial<Record<GenerativeMacroName, GenerativeMacroSupport>>>;
export const GENERATIVE_MACRO_NAMES = ["energy", "density", "variation", "texture"] as const;

/** One provider-time frame. Pitch states use 0=off, 1=sustain, 2=onset, 3=provider decides. */
export interface GenerativeNoteFrame {
  frameIndex: number;
  pitchState: readonly number[];
}

export interface GenerativeInput {
  bpm: number;
  frameRateHz: number;
  startTick: number;
  style: GenerativeStyle;
  noteFrames: readonly GenerativeNoteFrame[];
  drumsMode: GenerativeDrumsMode;
  macros: GenerativeMacroValues;
  seed?: string;
}

export type GenerativeSessionState =
  | "idle"
  | "loading"
  | "downloading"
  | "starting"
  | "ready"
  | "running"
  | "buffering"
  | "capturing"
  | "reconnecting"
  | "error"
  | "unavailable"
  | "disposed";

export interface GenerativeStatus {
  state: GenerativeSessionState;
  message?: string;
}

export interface GenerativeCapabilities {
  providerId: string;
  modelIds: readonly string[];
  supportsRealtime: boolean;
  supportsCapture: boolean;
  supportsTextStyle: boolean;
  supportsAudioStyle: boolean;
  supportsNoteConditioning: boolean;
  supportsDrumsMode: boolean;
  supportsSeed: boolean;
  /** Product-level macro semantics; these are not assumed to be native model controls. */
  macroSupport?: GenerativeMacroSupportMap;
  outputSampleRates: readonly number[];
  outputChannels: readonly number[];
  maxCaptureSeconds: number;
}

export interface GenerativeSessionConfig {
  modelId: string;
  outputSampleRate: number;
  outputChannels: number;
}

/** Interleaved PCM audio chunk; ownership may be transferred by a native adapter. */
export interface GenerativeAudioChunk {
  sequence: number;
  sampleRate: number;
  channels: number;
  frames: number;
  data: Float32Array;
}

export interface GeneratedAudio {
  sampleRate: number;
  channels: number;
  frames: number;
  durationSec: number;
  data: Float32Array;
  providerId: string;
  modelId: string;
  inputHash: string;
  provenance?: {
    sourceHash?: string;
    prompt?: string;
    providerVersion?: string;
  };
}

export interface GenerativeCaptureRequest {
  input: GenerativeInput;
  durationSec: number;
  signal?: AbortSignal;
}

export type GenerativeStatusListener = (status: GenerativeStatus) => void;
export type GenerativeAudioListener = (chunk: GenerativeAudioChunk) => void;

export interface GenerativeAudioSession {
  readonly capabilities: GenerativeCapabilities;
  readonly config: GenerativeSessionConfig;

  getStatus(): GenerativeStatus;
  subscribeStatus(listener: GenerativeStatusListener): () => void;
  subscribeAudio(listener: GenerativeAudioListener): () => void;
  updateInput(input: GenerativeInput): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  capture(request: GenerativeCaptureRequest): Promise<GeneratedAudio>;
  dispose(): Promise<void>;
}

export interface GenerativeAudioProvider {
  readonly id: string;
  getCapabilities(): GenerativeCapabilities;
  createSession(config: GenerativeSessionConfig): Promise<GenerativeAudioSession>;
}
