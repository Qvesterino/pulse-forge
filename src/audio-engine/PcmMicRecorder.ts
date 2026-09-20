import { materializePcmTake, type MaterializedPcmTake } from "./pcmRecording";
import {
  RECORDING_OWNER_ID,
  RecordingRecoveryRepository,
  type RecordingPcmChunk,
  type RecordingSession,
} from "../persistence/RecordingRecoveryRepository";

export interface PcmRecordingMetadata {
  projectId: string;
  trackId: string;
  trackName: string;
  placeOnTimeline?: boolean;
  startBar: number;
  bpm: number;
  recordingInputOffsetMs?: number;
}

export type PcmRecorderState = "idle" | "starting" | "recording" | "stopping";

const PROCESSOR_NAME = "pulse-forge-pcm-capture";
const CHUNK_SECONDS = 1;
const STOP_TIMEOUT_MS = 2_000;
const READY_TIMEOUT_MS = 8_000;
const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();

export interface PcmMicRecorderDependencies {
  ctx: AudioContext;
  recovery?: RecordingRecoveryRepository;
  getUserMedia?: MediaDevices["getUserMedia"];
  addWorkletModule?: (ctx: AudioContext) => Promise<void>;
}

/**
 * Lossless microphone capture for arrangement takes. AudioWorklet emits
 * transferable planar Float32 blocks; each block is acknowledged only after
 * IndexedDB commits it. MediaRecorder remains available for non-mic bounces.
 */
export class PcmMicRecorder {
  onError: ((message: string) => void) | null = null;

  private state_: PcmRecorderState = "idle";
  private startToken = 0;
  private startedAt = 0;
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private onTrackEnded: (() => void) | null = null;
  private onTrackMuted: (() => void) | null = null;
  private onContextStateChange: (() => void) | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private muteGain: GainNode | null = null;
  private monitorGain: GainNode | null = null;
  private monitoringEnabled = false;
  private session: RecordingSession | null = null;
  private nextChunkSequence = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private persistenceError: string | null = null;
  private errorReported = false;
  private readyResolve: ((value: { channels: number; sampleRate: number }) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private stoppedResolve: (() => void) | null = null;
  private finishPromise: Promise<string | null> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly recovery: RecordingRecoveryRepository;

  constructor(private readonly deps: PcmMicRecorderDependencies) {
    this.recovery = deps.recovery ?? new RecordingRecoveryRepository();
  }

  get state(): PcmRecorderState {
    return this.state_;
  }

  /** Enable a dry, direct mic path independently of the silent capture worklet output. */
  setMonitoring(enabled: boolean): void {
    this.monitoringEnabled = enabled;
    const gain = this.monitorGain?.gain;
    if (!gain) return;
    const now = this.deps.ctx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(enabled ? 1 : 0, now, 0.01);
  }

  get elapsedSeconds(): number {
    return this.state_ === "recording" || this.state_ === "stopping"
      ? Math.max(0, this.deps.ctx.currentTime - this.startedAt)
      : 0;
  }

  async start(getMetadata: () => PcmRecordingMetadata | null): Promise<void> {
    if (this.state_ !== "idle") throw new Error(this.state_ === "starting" ? "Already starting" : "Already recording");
    const token = ++this.startToken;
    this.state_ = "starting";
    this.nextChunkSequence = 0;
    this.writeTail = Promise.resolve();
    this.persistenceError = null;
    this.errorReported = false;
    this.session = null;
    try {
      const { ctx } = this.deps;
      if (ctx.state === "closed") throw new Error("Audio engine is closed — reopen the project and try again");
      if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") {
        throw new Error("Lossless microphone recording needs AudioWorklet support in this browser");
      }
      if (ctx.state !== "running") await ctx.resume();
      this.assertStartIsCurrent(token);

      await (this.deps.addWorkletModule ?? loadCaptureWorklet)(ctx);
      this.assertStartIsCurrent(token);

      const getUserMedia =
        this.deps.getUserMedia ??
        (typeof navigator !== "undefined"
          ? navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)
          : undefined);
      if (!getUserMedia) throw new Error("Microphone capture is not available in this browser");
      try {
        this.stream = await getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          throw new Error("Microphone access denied — allow the mic and try again");
        }
        if (name === "NotFoundError" || name === "DevicesNotFoundError") {
          throw new Error("No microphone is available");
        }
        throw new Error(`Could not start microphone capture${error instanceof Error ? `: ${error.message}` : ""}`);
      }
      this.assertStartIsCurrent(token);
      this.track = this.stream.getAudioTracks()[0] ?? null;
      if (!this.track || this.track.readyState === "ended") throw new Error("The selected microphone is unavailable");

      this.source = ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { chunkFrames: Math.max(128, Math.round(ctx.sampleRate * CHUNK_SECONDS)) },
      });
      this.muteGain = ctx.createGain();
      this.muteGain.gain.value = 0;
      this.monitorGain = ctx.createGain();
      this.monitorGain.gain.value = this.monitoringEnabled ? 1 : 0;
      const readyPromise = this.waitUntilReady();
      this.node.port.onmessage = (event: MessageEvent) => this.handleWorkletMessage(event.data);
      this.node.onprocessorerror = () =>
        this.reportError("Audio capture stopped unexpectedly; saved audio is available for recovery");
      this.source.connect(this.node);
      this.node.connect(this.muteGain);
      this.muteGain.connect(ctx.destination);
      this.source.connect(this.monitorGain);
      this.monitorGain.connect(ctx.destination);

      const ready = await readyPromise;
      this.assertStartIsCurrent(token);
      if (!Number.isInteger(ready.channels) || ready.channels < 1 || ready.channels > 32) {
        throw new Error("The microphone reported an unsupported channel layout");
      }
      if (!Number.isInteger(ready.sampleRate) || ready.sampleRate < 8_000 || ready.sampleRate > 384_000) {
        throw new Error("The audio device reported an unsupported sample rate");
      }

      const metadata = getMetadata();
      if (!metadata) throw new Error("The armed track no longer exists");
      const now = new Date();
      const session: RecordingSession = {
        id: createSessionId(),
        ownerId: RECORDING_OWNER_ID,
        ...metadata,
        sampleRate: ready.sampleRate,
        channels: ready.channels,
        createdAt: now.toISOString(),
        updatedAt: now.getTime(),
        status: "recording",
        totalFrames: 0,
        chunkCount: 0,
      };
      await this.recovery.begin(session);
      this.session = session;
      this.assertStartIsCurrent(token);
      const currentMetadata = getMetadata();
      if (
        !currentMetadata ||
        currentMetadata.projectId !== metadata.projectId ||
        currentMetadata.trackId !== metadata.trackId
      ) {
        throw new Error("The armed track or project changed before recording began");
      }

      this.onTrackEnded = () =>
        this.reportError("Microphone disconnected — the captured take is being stopped and kept for recovery");
      this.track.addEventListener("ended", this.onTrackEnded);
      this.onTrackMuted = () =>
        this.reportError("Microphone input was interrupted — the captured take is being stopped and kept for recovery");
      this.track.addEventListener("mute", this.onTrackMuted);
      if (isTrackEnded(this.track)) throw new Error("The microphone disconnected before recording began");
      if (this.track.muted) throw new Error("The selected microphone is not delivering audio");
      this.onContextStateChange = () => {
        if (this.state_ !== "recording" || ctx.state === "running") return;
        this.reportError(
          `Audio context became ${String(ctx.state)} during microphone recording. Recording stopped; previously committed blocks are recoverable, but the final uncommitted buffer may be incomplete.`,
        );
      };
      ctx.addEventListener("statechange", this.onContextStateChange);
      if (ctx.state !== "running") {
        throw new Error(`Audio context became ${String(ctx.state)} before recording began`);
      }
      this.startedAt = ctx.currentTime;
      this.state_ = "recording";
      this.node.port.postMessage({ type: "start" });
    } catch (error) {
      const session = this.session;
      this.cleanupWiring();
      this.session = null;
      if (session) {
        try {
          await this.recovery.remove(session.id);
        } catch {
          try {
            await this.recovery.markRecoverable(session.id);
          } catch {
            /* preserve the original start error */
          }
        }
      }
      this.state_ = "idle";
      throw error;
    }
  }

  async stop(): Promise<MaterializedPcmTake | null> {
    const sessionId = await this.finishCapture();
    if (!sessionId) return null;
    const session = await this.recovery.get(sessionId);
    if (!session || session.totalFrames <= 0) {
      await this.recovery.remove(sessionId);
      return null;
    }
    return materializePcmTake(this.recovery, sessionId, this.deps.ctx);
  }

  /** Stop capture but retain the staged PCM for a later recovery prompt. */
  async cancel(): Promise<void> {
    if (this.state_ === "starting") {
      this.startToken++;
      this.cleanupWiring();
      this.state_ = "idle";
      return;
    }
    await this.finishCapture();
  }

  private assertStartIsCurrent(token: number): void {
    if (token !== this.startToken) throw new Error("Recording start was cancelled");
  }

  private waitUntilReady(): Promise<{ channels: number; sampleRate: number }> {
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimer = setTimeout(() => {
        this.readyTimer = null;
        this.readyReject?.(new Error("Microphone produced no audio — check the selected input and try again"));
        this.readyResolve = null;
        this.readyReject = null;
      }, READY_TIMEOUT_MS);
    });
  }

  private handleWorkletMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const data = message as {
      type?: string;
      channels?: number;
      sampleRate?: number;
      sequence?: number;
      frames?: number;
      reason?: string;
    };
    if (data.type === "ready") {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.readyResolve?.({ channels: data.channels ?? 0, sampleRate: data.sampleRate ?? 0 });
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (data.type === "chunk") {
      // The loose message shape (channels as a count on "ready") doesn't
      // overlap RecordingPcmChunk (channels as Float32Array[]) — acceptChunk
      // validates sequence/frames/chunks at runtime.
      this.acceptChunk(data as unknown as RecordingPcmChunk);
      return;
    }
    if (data.type === "error") {
      this.reportError(data.reason || "Audio capture failed; completed blocks remain available for recovery");
      return;
    }
    if (data.type === "stopped") this.stoppedResolve?.();
  }

  private acceptChunk(chunk: RecordingPcmChunk): void {
    if (this.persistenceError) return;
    if (
      !Number.isInteger(chunk.sequence) ||
      chunk.sequence !== this.nextChunkSequence ||
      !Number.isInteger(chunk.frames) ||
      !Array.isArray(chunk.channels)
    ) {
      this.persistenceError = "Audio capture sent an invalid block; completed blocks remain available for recovery";
      this.reportError(this.persistenceError);
      return;
    }
    this.nextChunkSequence++;
    const node = this.node;
    const session = this.session;
    if (!node || !session) {
      this.persistenceError = "Audio capture ended before its session was ready";
      this.reportError(this.persistenceError);
      return;
    }
    this.writeTail = this.writeTail
      .then(async () => {
        if (this.persistenceError) return;
        await this.recovery.appendChunk({ ...chunk, sessionId: session.id });
        node.port.postMessage({ type: "ack", sequence: chunk.sequence });
      })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.persistenceError = `Audio storage stopped: ${detail}. Previously saved blocks are recoverable.`;
        this.reportError(this.persistenceError);
      });
  }

  private reportError(message: string): void {
    if (this.errorReported) return;
    this.errorReported = true;
    // Capture lifecycle must not rely on a mounted UI reacting to onError.
    // Stop at the recorder boundary too; UI callers may also call stop(),
    // which safely joins the same finishPromise.
    if (this.state_ === "recording") {
      void this.finishCapture().catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[recording] cleanup after capture error failed: ${detail}`);
      });
    }
    this.onError?.(message);
  }

  private finishCapture(): Promise<string | null> {
    if (this.finishPromise) return this.finishPromise;
    if (this.state_ !== "recording" && this.state_ !== "stopping") return Promise.resolve(null);
    this.state_ = "stopping";
    this.finishPromise = (async () => {
      const sessionId = this.session?.id ?? null;
      const node = this.node;
      if (node) {
        let stopAcknowledged = false;
        let stopDispatchFailed = false;
        const stopped = new Promise<void>((resolve) => {
          this.stoppedResolve = () => {
            stopAcknowledged = true;
            resolve();
          };
          try {
            node.port.postMessage({ type: "stop" });
          } catch {
            stopDispatchFailed = true;
            resolve();
          }
        });
        let timeout: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          stopped,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, STOP_TIMEOUT_MS);
          }),
        ]);
        if (timeout) clearTimeout(timeout);
        if (!stopAcknowledged) {
          this.reportError(
            stopDispatchFailed
              ? "The recorder could not confirm its stop command. Previously committed PCM blocks remain available for recovery, but the final tail may be incomplete."
              : "The recorder did not confirm flushing its final audio block. Previously committed PCM blocks remain available for recovery, but the final tail may be incomplete.",
          );
        }
      }
      await this.writeTail;
      this.cleanupWiring();
      if (sessionId) {
        try {
          await this.recovery.markRecoverable(sessionId);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.reportError(`Could not mark the take recoverable: ${detail}`);
        }
      }
      this.state_ = "idle";
      return sessionId;
    })().finally(() => {
      this.finishPromise = null;
    });
    return this.finishPromise;
  }

  private cleanupWiring(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.readyResolve = null;
    const rejectReady = this.readyReject;
    this.readyReject = null;
    rejectReady?.(new Error("Recording start was cancelled"));
    this.stoppedResolve = null;
    if (this.track && this.onTrackEnded) this.track.removeEventListener("ended", this.onTrackEnded);
    if (this.track && this.onTrackMuted) this.track.removeEventListener("mute", this.onTrackMuted);
    if (this.onContextStateChange) this.deps.ctx.removeEventListener("statechange", this.onContextStateChange);
    this.onTrackEnded = null;
    this.onTrackMuted = null;
    this.onContextStateChange = null;
    if (this.source && this.node) {
      try {
        this.source.disconnect(this.node);
      } catch {
        /* already disconnected */
      }
    }
    if (this.source && this.monitorGain) {
      try {
        this.source.disconnect(this.monitorGain);
      } catch {
        /* already disconnected */
      }
    }
    try {
      this.node?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.muteGain?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.monitorGain?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.node?.port.close();
    this.node = null;
    this.source = null;
    this.muteGain = null;
    this.monitorGain = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.track = null;
  }
}

async function loadCaptureWorklet(ctx: AudioContext): Promise<void> {
  const existing = moduleLoads.get(ctx);
  if (existing) return existing;
  const loading = ctx.audioWorklet.addModule(new URL("/recording-capture-worklet.js", import.meta.url).href);
  moduleLoads.set(ctx, loading);
  try {
    await loading;
  } catch (error) {
    moduleLoads.delete(ctx);
    throw error;
  }
}

function createSessionId(): string {
  const randomId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : null;
  return `recording.${randomId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function isTrackEnded(track: MediaStreamTrack): boolean {
  return track.readyState === "ended";
}
