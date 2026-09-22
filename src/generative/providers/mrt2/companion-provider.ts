import { withGenerativeTimeout, GENERATIVE_PROVIDER_TIMEOUT_MS } from "../../timeout";
import {
  encodeMrt2AudioPacket,
  validateMrt2AudioPacket,
  type Mrt2AudioPacket,
  type Mrt2ControlMessage,
  type Mrt2SerializableInput,
} from "./protocol";
import {
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
  type GenerativeSessionState,
  type GenerativeStatus,
  type GenerativeStatusListener,
} from "../../types";
import { validateCaptureRequest, validateGenerativeInput, validateSessionConfig } from "../../validation";

export type Mrt2CompanionEvent =
  | { kind: "control"; message: Mrt2ControlMessage }
  | { kind: "audio"; packet: Mrt2AudioPacket }
  | { kind: "closed"; reason?: string };

/** Transport supplied by Electron IPC or a deliberately-created localhost companion. */
export interface Mrt2CompanionTransport {
  sendControl(message: Mrt2ControlMessage): Promise<void> | void;
  sendBinary(packet: ArrayBuffer): Promise<void> | void;
  subscribe(listener: (event: Mrt2CompanionEvent) => void): () => void;
  close(): Promise<void> | void;
}

export interface Mrt2CompanionProviderOptions {
  transportFactory: (config: GenerativeSessionConfig) => Promise<Mrt2CompanionTransport>;
  providerId?: string;
  modelId?: string;
  timeoutMs?: number;
  capabilities?: Partial<GenerativeCapabilities>;
}

const DEFAULT_CAPABILITIES: GenerativeCapabilities = {
  providerId: "mrt2",
  modelIds: ["mrt2_small"],
  supportsRealtime: true,
  supportsCapture: true,
  supportsTextStyle: true,
  supportsAudioStyle: true,
  supportsNoteConditioning: true,
  supportsDrumsMode: true,
  supportsSeed: false,
  macroSupport: { energy: "wrapper", density: "wrapper", variation: "wrapper", texture: "wrapper" },
  outputSampleRates: [48_000],
  outputChannels: [2],
  maxCaptureSeconds: GENERATIVE_MAX_CAPTURE_SECONDS,
};

function requestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function serializableInput(input: GenerativeInput): { input: Mrt2SerializableInput; stylePacket?: Mrt2AudioPacket } {
  if (input.style.kind === "text") return { input: { ...input, style: { kind: "text", text: input.style.text } } };
  const frames = input.style.channels[0]?.length ?? 0;
  return {
    input: {
      ...input,
      style: {
        kind: "audio",
        sampleRate: input.style.sampleRate,
        channels: input.style.channels.length,
        frames,
      },
    },
    stylePacket: {
      kind: "style",
      sequence: 0,
      sampleRate: input.style.sampleRate,
      channels: input.style.channels.length,
      frames,
      data: interleave(input.style.channels, frames),
    },
  };
}

function interleave(channels: readonly Float32Array[], frames: number): Float32Array {
  const output = new Float32Array(frames * channels.length);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels.length; channel++) {
      output[frame * channels.length + channel] = channels[channel]?.[frame] ?? 0;
    }
  }
  return output;
}

export class Mrt2CompanionProvider implements GenerativeAudioProvider {
  readonly id: string;
  private readonly modelId: string;
  private readonly timeoutMs: number;
  private readonly capabilities: GenerativeCapabilities;
  private readonly transportFactory: Mrt2CompanionProviderOptions["transportFactory"];

  constructor(options: Mrt2CompanionProviderOptions) {
    this.id = options.providerId ?? "mrt2";
    this.modelId = options.modelId ?? "mrt2_small";
    this.timeoutMs = options.timeoutMs ?? GENERATIVE_PROVIDER_TIMEOUT_MS;
    this.transportFactory = options.transportFactory;
    this.capabilities = {
      ...DEFAULT_CAPABILITIES,
      ...options.capabilities,
      providerId: this.id,
      modelIds: options.capabilities?.modelIds ?? [this.modelId],
    };
    validateSessionConfig({ modelId: this.modelId, outputSampleRate: 48_000, outputChannels: 2 });
  }

  getCapabilities(): GenerativeCapabilities {
    return { ...this.capabilities, modelIds: [...this.capabilities.modelIds] };
  }

  async createSession(config: GenerativeSessionConfig): Promise<GenerativeAudioSession> {
    validateSessionConfig(config);
    if (!this.capabilities.modelIds.includes(config.modelId)) {
      throw new Error(`MRT2 model is unsupported: ${config.modelId}`);
    }
    const transport = await withGenerativeTimeout(this.transportFactory(config), {
      operation: "connect",
      timeoutMs: this.timeoutMs,
    });
    const session = new Mrt2CompanionSession(this.capabilities, config, transport, this.timeoutMs);
    try {
      await session.handshake();
      return session;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }
}

class Mrt2CompanionSession implements GenerativeAudioSession {
  capabilities: GenerativeCapabilities;
  readonly config: GenerativeSessionConfig;
  private status: GenerativeStatus = { state: "idle" };
  private readonly statusListeners = new Set<GenerativeStatusListener>();
  private readonly audioListeners = new Set<GenerativeAudioListener>();
  private readonly pending = new Map<
    string,
    { resolve: (message: Mrt2ControlMessage) => void; reject: (error: unknown) => void }
  >();
  private readonly captureChunks: Mrt2AudioPacket[] = [];
  private sessionId: string | null = null;
  private disposed = false;
  private failedError: Error | null = null;
  private unsubscribeTransport: (() => void) | null;

  constructor(
    capabilities: GenerativeCapabilities,
    config: GenerativeSessionConfig,
    private readonly transport: Mrt2CompanionTransport,
    private readonly timeoutMs: number,
  ) {
    this.capabilities = capabilities;
    this.config = config;
    this.unsubscribeTransport = transport.subscribe((event) => this.onTransportEvent(event));
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

  async handshake(): Promise<void> {
    const response = await this.request(
      {
        version: 1,
        type: "hello",
        requestId: requestId("hello"),
        client: "kyx",
      },
      "hello.ok",
    );
    if (response.type !== "hello.ok") throw new Error("MRT2 companion handshake failed");
    if (!response.supportsRealtime) throw new Error("MRT2 companion does not support realtime playback");
    if (!response.modelIds.includes(this.config.modelId)) {
      throw new Error(`MRT2 companion does not support model ${this.config.modelId}`);
    }
    if (!response.outputSampleRates.includes(this.config.outputSampleRate)) {
      throw new Error(`MRT2 companion does not support ${this.config.outputSampleRate} Hz output`);
    }
    if (!response.outputChannels.includes(this.config.outputChannels)) {
      throw new Error(`MRT2 companion does not support ${this.config.outputChannels}-channel output`);
    }
    this.capabilities = {
      ...this.capabilities,
      providerId: response.providerId,
      modelIds: [...response.modelIds],
      outputSampleRates: [...response.outputSampleRates],
      outputChannels: [...response.outputChannels],
      supportsRealtime: response.supportsRealtime,
      supportsCapture: response.supportsCapture,
      supportsTextStyle: response.supportsTextStyle,
      supportsNoteConditioning: response.supportsNoteConditioning,
      supportsAudioStyle: response.supportsAudioStyle,
      supportsDrumsMode: response.supportsDrumsMode,
      supportsSeed: response.supportsSeed,
      maxCaptureSeconds: response.maxCaptureSeconds,
      ...(response.macroSupport ? { macroSupport: response.macroSupport } : {}),
    };
    const session = await this.request(
      {
        version: 1,
        type: "session.create",
        requestId: requestId("session"),
        config: this.config,
      },
      "session.ok",
    );
    if (session.type !== "session.ok") throw new Error("MRT2 companion session creation failed");
  }

  async updateInput(input: GenerativeInput): Promise<void> {
    this.assertUsable();
    validateGenerativeInput(input);
    if (input.style.kind === "text" && !this.capabilities.supportsTextStyle) {
      throw new Error("MRT2 companion does not support text style conditioning");
    }
    if (input.noteFrames.length > 0 && !this.capabilities.supportsNoteConditioning) {
      throw new Error("MRT2 companion does not support note conditioning");
    }
    if (input.style.kind === "audio" && !this.capabilities.supportsAudioStyle) {
      throw new Error("MRT2 companion does not support audio style conditioning");
    }
    if (input.drumsMode !== "provider-default" && !this.capabilities.supportsDrumsMode) {
      throw new Error("MRT2 companion does not support drums mode control");
    }
    if (input.seed && !this.capabilities.supportsSeed) {
      throw new Error("MRT2 companion does not guarantee seed control");
    }
    const sessionId = this.requireSessionId();
    const request = requestId("input");
    const serialized = serializableInput(input);
    if (serialized.stylePacket) {
      await withGenerativeTimeout(
        Promise.resolve(this.transport.sendBinary(encodeMrt2AudioPacket(serialized.stylePacket))),
        {
          operation: "send-style",
          timeoutMs: this.timeoutMs,
        },
      );
    }
    await this.request(
      { version: 1, type: "input.update", requestId: request, sessionId, input: serialized.input },
      "status",
    );
  }

  async start(): Promise<void> {
    this.assertUsable();
    const sessionId = this.requireSessionId();
    this.setStatus({ state: "starting" });
    await this.request({ version: 1, type: "session.start", requestId: requestId("start"), sessionId }, "status");
    this.setStatus({ state: "running" });
  }

  async stop(): Promise<void> {
    if (this.disposed || !this.sessionId) return;
    await this.request(
      { version: 1, type: "session.stop", requestId: requestId("stop"), sessionId: this.sessionId },
      "status",
    );
    this.setStatus({ state: "ready" });
  }

  async capture(request: GenerativeCaptureRequest): Promise<GeneratedAudio> {
    this.assertUsable();
    validateCaptureRequest(request, this.capabilities.maxCaptureSeconds);
    if (!this.capabilities.supportsCapture) throw new Error("MRT2 companion does not support capture");
    const sessionId = this.requireSessionId();
    this.captureChunks.length = 0;
    this.setStatus({ state: "capturing" });
    const response = await this.request(
      {
        version: 1,
        type: "capture.start",
        requestId: requestId("capture"),
        sessionId,
        durationSec: request.durationSec,
      },
      "capture.ok",
      request.signal,
    );
    if (response.type !== "capture.ok") throw new Error("MRT2 companion capture did not complete");
    const data = concatenateCapture(this.captureChunks, response.frames, this.config.outputChannels);
    this.setStatus({ state: "ready" });
    return {
      sampleRate: this.config.outputSampleRate,
      channels: this.config.outputChannels,
      frames: response.frames,
      durationSec: response.durationSec,
      data,
      providerId: this.capabilities.providerId,
      modelId: this.config.modelId,
      inputHash: response.inputHash,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.sessionId) {
      try {
        await this.request(
          { version: 1, type: "session.close", requestId: requestId("close"), sessionId: this.sessionId },
          "status",
        );
      } catch {
        /* transport teardown remains best effort */
      }
    }
    this.disposed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("MRT2 session disposed"));
    this.pending.clear();
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    await this.transport.close();
    this.setStatus({ state: "disposed" });
    this.statusListeners.clear();
    this.audioListeners.clear();
  }

  private async request(
    message: Mrt2ControlMessage,
    expectedType: Mrt2ControlMessage["type"],
    signal?: AbortSignal,
  ): Promise<Mrt2ControlMessage> {
    this.assertUsable(false);
    const requestIdValue = message.requestId;
    if (!requestIdValue) throw new Error(`MRT2 ${message.type} request is missing an id`);
    const response = new Promise<Mrt2ControlMessage>((resolve, reject) => {
      this.pending.set(requestIdValue, { resolve, reject });
    });
    try {
      await withGenerativeTimeout(Promise.resolve(this.transport.sendControl(message)), {
        operation: message.type,
        timeoutMs: this.timeoutMs,
        signal,
      });
      const result = await withGenerativeTimeout(response, {
        operation: `${message.type} response`,
        timeoutMs: this.timeoutMs,
        signal,
      });
      if (result.type === "error") throw new Error(result.message);
      if (result.type !== expectedType) throw new Error(`Unexpected MRT2 response: ${result.type}`);
      return result;
    } finally {
      this.pending.delete(requestIdValue);
    }
  }

  private onTransportEvent(event: Mrt2CompanionEvent): void {
    if (event.kind === "closed") {
      const error = new Error(event.reason ?? "MRT2 companion disconnected");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (!this.disposed && !this.failedError) {
        // A closed transport is recoverable by the next explicit Play/Connect
        // action, but this session cannot silently recreate a socket or native
        // model. Keep that distinction visible instead of claiming a retry.
        this.setStatus({ state: "reconnecting", message: `${error.message}; stop and play to reconnect` });
      }
      return;
    }
    if (event.kind === "audio") {
      let packet: Mrt2AudioPacket;
      try {
        packet = validateMrt2AudioPacket(event.packet);
      } catch (error) {
        this.fail(
          new Error(
            error instanceof Error ? `Invalid MRT2 audio packet: ${error.message}` : "Invalid MRT2 audio packet",
          ),
        );
        return;
      }
      if (packet.kind !== "output") return;
      if (this.status.state === "capturing") this.captureChunks.push(packet);
      const chunk: GenerativeAudioChunk = {
        sequence: packet.sequence,
        sampleRate: packet.sampleRate,
        channels: packet.channels,
        frames: packet.frames,
        data: packet.data,
      };
      for (const listener of this.audioListeners) listener(chunk);
      return;
    }
    const message = event.message;
    if (message.type === "status") {
      this.setStatus({
        state: message.state as GenerativeSessionState,
        ...(message.message ? { message: message.message } : {}),
      });
    }
    if (message.requestId) {
      const pending = this.pending.get(message.requestId);
      if (pending) pending.resolve(message);
    }
    if (message.type === "session.ok") this.sessionId = message.sessionId;
  }

  private setStatus(status: GenerativeStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private requireSessionId(): string {
    if (!this.sessionId) throw new Error("MRT2 companion session is not ready");
    return this.sessionId;
  }

  private assertUsable(allowDisposed = false): void {
    if (!allowDisposed && this.disposed) throw new Error("MRT2 companion session is disposed");
    if (!allowDisposed && this.failedError) throw this.failedError;
  }

  private fail(error: Error): void {
    if (this.disposed || this.failedError) return;
    this.failedError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.setStatus({ state: "error", message: error.message });
  }
}

function concatenateCapture(chunks: readonly Mrt2AudioPacket[], frames: number, channels: number): Float32Array {
  const ordered = [...chunks].sort((a, b) => a.sequence - b.sequence);
  const output = new Float32Array(frames * channels);
  let offset = 0;
  for (const packet of ordered) {
    if (packet.channels !== channels) throw new Error("MRT2 capture channel count changed");
    const count = Math.min(packet.data.length, output.length - offset);
    if (count <= 0) break;
    output.set(packet.data.subarray(0, count), offset);
    offset += count;
  }
  if (offset !== output.length) throw new Error("MRT2 capture returned incomplete PCM");
  return output;
}
