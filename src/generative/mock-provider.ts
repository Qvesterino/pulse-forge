import {
  GENERATIVE_FRAME_RATE_HZ,
  GENERATIVE_MAX_CAPTURE_SECONDS,
  type GeneratedAudio,
  type GenerativeAudioChunk,
  type GenerativeAudioListener,
  type GenerativeAudioProvider,
  type GenerativeAudioSession,
  type GenerativeCapabilities,
  type GenerativeCaptureRequest,
  type GenerativeInput,
  type GenerativeSessionConfig,
  type GenerativeStatus,
  type GenerativeStatusListener,
} from "./types";
import { validateCaptureRequest, validateGenerativeInput, validateSessionConfig } from "./validation";

const MOCK_PROVIDER_ID = "mock-generative";
const MOCK_MODEL_ID = "mock-small";

const CAPABILITIES: GenerativeCapabilities = {
  providerId: MOCK_PROVIDER_ID,
  modelIds: [MOCK_MODEL_ID],
  supportsRealtime: true,
  supportsCapture: true,
  supportsTextStyle: true,
  supportsAudioStyle: true,
  supportsNoteConditioning: true,
  supportsDrumsMode: true,
  supportsSeed: true,
  macroSupport: { energy: "wrapper", density: "wrapper", variation: "wrapper", texture: "wrapper" },
  outputSampleRates: [8000, 44100, 48000],
  outputChannels: [1, 2],
  maxCaptureSeconds: GENERATIVE_MAX_CAPTURE_SECONDS,
};

export interface MockGenerativeProviderOptions {
  providerId?: string;
  modelId?: string;
  sampleRate?: number;
  channels?: number;
}

function hashInput(input: GenerativeInput): number {
  let hash = 2166136261;
  const add = (value: number): void => {
    hash ^= value | 0;
    hash = Math.imul(hash, 16777619);
  };
  add(Math.round(input.bpm * 100));
  add(Math.round(input.startTick));
  add(input.drumsMode === "off" ? 0 : input.drumsMode === "on" ? 1 : 2);
  for (const character of input.style.kind === "text" ? input.style.text : "audio") add(character.charCodeAt(0));
  add(Math.round(input.macros.energy * 1000));
  add(Math.round(input.macros.density * 1000));
  add(Math.round(input.macros.variation * 1000));
  add(Math.round(input.macros.texture * 1000));
  for (const frame of input.noteFrames) {
    add(frame.frameIndex);
    for (let pitch = 0; pitch < frame.pitchState.length; pitch += 8) add(frame.pitchState[pitch] ?? 0);
  }
  for (const character of input.seed ?? "") add(character.charCodeAt(0));
  return hash >>> 0;
}

function firstActivePitch(input: GenerativeInput): number {
  const frame = input.noteFrames[0];
  if (!frame) return 57;
  const pitch = frame.pitchState.findIndex((state) => state === 2 || state === 3);
  return pitch >= 0 ? pitch : 57;
}

function pitchFrequency(midiPitch: number): number {
  return 440 * Math.pow(2, (midiPitch - 69) / 12);
}

function nextRandom(state: { value: number }): number {
  let value = state.value;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value >>> 0;
  return state.value / 0x100000000;
}

function renderAudio(input: GenerativeInput, durationSec: number, sampleRate: number, channels: number): Float32Array {
  const frames = Math.max(1, Math.round(durationSec * sampleRate));
  const output = new Float32Array(frames * channels);
  const random = { value: hashInput(input) || 1 };
  const baseFrequency = pitchFrequency(firstActivePitch(input));
  const amplitude = 0.08 + input.macros.energy * 0.16 + input.macros.density * 0.08;
  const wobbleAmount = input.macros.variation * 0.03;
  let phase = 0;
  for (let frame = 0; frame < frames; frame++) {
    const seconds = frame / sampleRate;
    const wobble = 1 + Math.sin(seconds * 2 * Math.PI * (0.25 + input.macros.texture)) * wobbleAmount;
    phase += (2 * Math.PI * baseFrequency * wobble) / sampleRate;
    const texture = (nextRandom(random) - 0.5) * input.macros.texture * 0.025;
    const envelope = Math.min(1, seconds * 20) * Math.min(1, (durationSec - seconds) * 20);
    const sample = Math.max(-1, Math.min(1, (Math.sin(phase) * amplitude + texture) * envelope));
    for (let channel = 0; channel < channels; channel++) output[frame * channels + channel] = sample;
  }
  return output;
}

class MockGenerativeSession implements GenerativeAudioSession {
  readonly capabilities: GenerativeCapabilities;
  readonly config: GenerativeSessionConfig;
  private status: GenerativeStatus = { state: "idle" };
  private input: GenerativeInput | null = null;
  private sequence = 0;
  private readonly statusListeners = new Set<GenerativeStatusListener>();
  private readonly audioListeners = new Set<GenerativeAudioListener>();

  constructor(capabilities: GenerativeCapabilities, config: GenerativeSessionConfig) {
    this.capabilities = capabilities;
    this.config = config;
  }

  getStatus(): GenerativeStatus {
    return this.status;
  }

  subscribeStatus(listener: GenerativeStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  subscribeAudio(listener: GenerativeAudioListener): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  async updateInput(input: GenerativeInput): Promise<void> {
    this.assertUsable();
    validateGenerativeInput(input);
    this.input = input;
    if (this.status.state !== "running") return;
    const durationSec = 1 / GENERATIVE_FRAME_RATE_HZ;
    const data = renderAudio(input, durationSec, this.config.outputSampleRate, this.config.outputChannels);
    const chunk: GenerativeAudioChunk = {
      sequence: this.sequence++,
      sampleRate: this.config.outputSampleRate,
      channels: this.config.outputChannels,
      frames: data.length / this.config.outputChannels,
      data,
    };
    for (const listener of this.audioListeners) listener(chunk);
  }

  async start(): Promise<void> {
    this.assertUsable();
    if (!this.input) throw new Error("Generative input must be set before start");
    if (this.status.state === "running") return;
    this.setStatus({ state: "starting" });
    await Promise.resolve();
    this.setStatus({ state: "running" });
  }

  async stop(): Promise<void> {
    if (this.status.state === "disposed") return;
    if (this.status.state === "running" || this.status.state === "starting") this.setStatus({ state: "ready" });
  }

  async capture(request: GenerativeCaptureRequest): Promise<GeneratedAudio> {
    this.assertUsable();
    validateCaptureRequest(request, this.capabilities.maxCaptureSeconds);
    if (!this.capabilities.supportsCapture) throw new Error("Provider does not support capture");
    if (request.signal?.aborted) throw new Error("Generative capture aborted");
    const previous = this.status.state;
    this.setStatus({ state: "capturing" });
    await Promise.resolve();
    if (request.signal?.aborted) {
      this.setStatus({ state: previous === "running" ? "running" : "ready" });
      throw new Error("Generative capture aborted");
    }
    const data = renderAudio(
      request.input,
      request.durationSec,
      this.config.outputSampleRate,
      this.config.outputChannels,
    );
    this.setStatus({ state: previous === "running" ? "running" : "ready" });
    return {
      sampleRate: this.config.outputSampleRate,
      channels: this.config.outputChannels,
      frames: data.length / this.config.outputChannels,
      durationSec: request.durationSec,
      data,
      providerId: this.capabilities.providerId,
      modelId: this.config.modelId,
      inputHash: hashInput(request.input).toString(16).padStart(8, "0"),
    };
  }

  async dispose(): Promise<void> {
    if (this.status.state === "disposed") return;
    this.input = null;
    this.statusListeners.clear();
    this.audioListeners.clear();
    this.setStatus({ state: "disposed" });
  }

  private assertUsable(): void {
    if (this.status.state === "disposed") throw new Error("Generative session is disposed");
  }

  private setStatus(status: GenerativeStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

export class MockGenerativeProvider implements GenerativeAudioProvider {
  readonly id: string;
  private readonly modelId: string;
  private readonly sampleRate: number;
  private readonly channels: number;

  constructor(options: MockGenerativeProviderOptions = {}) {
    this.id = options.providerId ?? MOCK_PROVIDER_ID;
    this.modelId = options.modelId ?? MOCK_MODEL_ID;
    this.sampleRate = options.sampleRate ?? 48000;
    this.channels = options.channels ?? 2;
    validateSessionConfig({ modelId: this.modelId, outputSampleRate: this.sampleRate, outputChannels: this.channels });
  }

  getCapabilities(): GenerativeCapabilities {
    return {
      ...CAPABILITIES,
      providerId: this.id,
      modelIds: [this.modelId],
      outputSampleRates: [this.sampleRate],
      outputChannels: [this.channels],
    };
  }

  async createSession(config: GenerativeSessionConfig): Promise<GenerativeAudioSession> {
    validateSessionConfig(config);
    if (config.modelId !== this.modelId) throw new Error(`Unsupported mock model: ${config.modelId}`);
    if (config.outputChannels !== this.channels || config.outputSampleRate !== this.sampleRate) {
      throw new Error("Mock provider output format does not match its configured format");
    }
    return new MockGenerativeSession(this.getCapabilities(), config);
  }
}

export function createMockGenerativeProvider(options: MockGenerativeProviderOptions = {}): GenerativeAudioProvider {
  return new MockGenerativeProvider(options);
}
