import { withGenerativeTimeout, GENERATIVE_PROVIDER_TIMEOUT_MS } from "../../timeout";
import {
  encodeMrt2AudioPacket,
  parseMrt2ControlMessage,
  validateMrt2AudioPacket,
  MRT2_CAPTURE_MAX_FRAMES,
  MRT2_CAPTURE_MAX_CHUNKS,
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
  private capabilities: GenerativeCapabilities;
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
      this.capabilities = session.capabilities;
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
  private captureData: Float32Array | null = null;
  private captureExpectedFrames = 0;
  private captureCollectedFrames = 0;
  private captureLastSequence: number | null = null;
  private capturePacketCount = 0;
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
    if (!response.supportsRealtime && !response.supportsCapture) {
      throw new Error("MRT2 companion supports neither realtime playback nor capture");
    }
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
      ...(response.runtimeProfile ? { runtimeProfile: response.runtimeProfile } : {}),
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
    if (!this.capabilities.supportsRealtime) {
      throw new Error("MRT2 companion does not support realtime playback");
    }
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
    const requestedFrames = Math.ceil(request.durationSec * this.config.outputSampleRate);
    if (requestedFrames > MRT2_CAPTURE_MAX_FRAMES) {
      throw new Error("MRT2 capture exceeds the bounded PCM frame limit for this sample rate");
    }
    this.captureData = new Float32Array(requestedFrames * this.config.outputChannels);
    this.captureExpectedFrames = requestedFrames;
    this.captureCollectedFrames = 0;
    this.captureLastSequence = null;
    this.capturePacketCount = 0;
    this.setStatus({ state: "capturing" });
    try {
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
      if (response.frames <= 0 || response.frames !== this.captureCollectedFrames) {
        throw new Error("MRT2 capture frame count does not match received PCM");
      }
      const expectedDurationSec = response.frames / this.config.outputSampleRate;
      if (Math.abs(response.durationSec - expectedDurationSec) > 1 / this.config.outputSampleRate + 1e-9) {
        throw new Error("MRT2 capture duration does not match its PCM frame count");
      }
      const captureData = this.captureData;
      if (!captureData) throw new Error("MRT2 capture PCM buffer is unavailable");
      const data = captureData.subarray(0, response.frames * this.config.outputChannels);
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
    } catch (error) {
      if (!this.failedError && this.captureData !== null) {
        this.setStatus({ state: "ready", message: error instanceof Error ? error.message : "MRT2 capture failed" });
      }
      throw error;
    } finally {
      this.captureData = null;
      this.captureExpectedFrames = 0;
      this.captureCollectedFrames = 0;
      this.captureLastSequence = null;
      this.capturePacketCount = 0;
    }
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
    if (this.disposed || this.failedError) return;
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
      // Capture ownership is the allocated buffer, not the display status. A
      // native inference underrun may report buffering during capture without
      // making subsequent PCM cease to belong to that capture.
      if (this.captureData !== null) {
        if (packet.sampleRate !== this.config.outputSampleRate || packet.channels !== this.config.outputChannels) {
          this.fail(new Error("MRT2 capture PCM format changed during capture"));
          return;
        }
        if (
          this.captureLastSequence !== null &&
          (packet.sequence <= this.captureLastSequence || packet.sequence !== this.captureLastSequence + 1)
        ) {
          this.fail(new Error("MRT2 capture PCM sequence is duplicated, out of order, or incomplete"));
          return;
        }
        if (this.capturePacketCount >= MRT2_CAPTURE_MAX_CHUNKS) {
          this.fail(new Error("MRT2 capture exceeded its bounded packet count"));
          return;
        }
        if (this.captureCollectedFrames + packet.frames > this.captureExpectedFrames) {
          this.fail(new Error("MRT2 capture exceeded its requested frame limit"));
          return;
        }
        const captureData = this.captureData;
        if (!captureData) {
          this.fail(new Error("MRT2 capture PCM buffer is unavailable"));
          return;
        }
        captureData.set(packet.data, this.captureCollectedFrames * this.config.outputChannels);
        this.captureLastSequence = packet.sequence;
        this.captureCollectedFrames += packet.frames;
        this.capturePacketCount++;
      }
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
    let message: Mrt2ControlMessage;
    try {
      message = parseMrt2ControlMessage(event.message);
    } catch (error) {
      this.fail(
        new Error(
          error instanceof Error ? `Invalid MRT2 control message: ${error.message}` : "Invalid MRT2 control message",
        ),
      );
      return;
    }
    if (message.type === "error") {
      this.fail(new Error(`MRT2 companion error ${message.code}: ${message.message}`));
      return;
    }
    if (message.type === "status") {
      if (message.state === "error" || message.state === "unavailable") {
        this.fail(new Error(message.message ?? `MRT2 companion reported ${message.state}`), message.state);
        return;
      }
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

  private fail(error: Error, state: "error" | "unavailable" = "error"): void {
    if (this.disposed || this.failedError) return;
    this.failedError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.setStatus({ state, message: error.message });
  }
}
