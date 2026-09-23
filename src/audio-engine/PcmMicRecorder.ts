import { assetUrl } from "../shared/assetUrls";
import { materializePcmTake, type MaterializedPcmTake } from "./pcmRecording";
import {
  RECORDING_OWNER_ID,
  RecordingRecoveryRepository,
  type RecordingPcmChunk,
  type RecordingSession,
} from "../persistence/RecordingRecoveryRepository";
import type { IRecordingRecoveryRepository } from "../persistence/contracts";
import { loadRecordingInputDeviceId } from "./recordingInput";

export interface PcmRecordingMetadata {
  projectId: string;
  trackId: string;
  trackName: string;
  placeOnTimeline?: boolean;
  startBar: number;
  bpm: number;
  recordingInputOffsetMs?: number;
  /** Audit 07 D1: count-in/pre-roll seconds captured BEFORE the musical
   * content when REC rolled the transport with a lead-in. Placement trims
   * this head off (clip offsetSec) so the downbeat lands on startBar
   * instead of one lead-in late. */
  leadInSec?: number;
}

export type PcmRecorderState = "idle" | "starting" | "recording" | "stopping";

const PROCESSOR_NAME = "pulse-forge-pcm-capture";
// Short durable blocks reduce the amount of a take that can be lost if the
// browser or device disappears before the next IndexedDB commit.
const CHUNK_SECONDS = 0.5;
const STOP_TIMEOUT_MS = 2_000;
const READY_TIMEOUT_MS = 8_000;
// ctx.resume() can stay pending indefinitely (interrupted state on iOS/Safari,
// dead audio device after sleep); start() must still settle so the UI leaves
// its "starting" state and the mic claim below is eventually released.
const RESUME_TIMEOUT_MS = 10_000;
const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();

// One live microphone capture per tab. ArrangementPanel takes and ExportPanel
// mic resamples each construct their own recorder instance; without this claim
// both would open parallel getUserMedia streams from the same input and
// interleave monitoring/capture. Claimed from synchronous start() entry until
// the instance returns to "idle" (every path that sets idle releases it).
let activeCapture: PcmMicRecorder | null = null;

/** Bound an awaited step so a hung browser API cannot wedge start() forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

export interface PcmMicRecorderDependencies {
  ctx: AudioContext;
  recovery?: IRecordingRecoveryRepository;
  /** Empty string explicitly selects the system default; omitted uses the saved user preference. */
  inputDeviceId?: string;
  getUserMedia?: MediaDevices["getUserMedia"];
  addWorkletModule?: (ctx: AudioContext) => Promise<void>;
  /** Pre-capture input trim in dB (-24..+12). Applied to monitor + capture. */
  inputGainDb?: number;
}

/** Input trim clamps — must mirror the UI slider. */
export const MIN_INPUT_GAIN_DB = -24;
export const MAX_INPUT_GAIN_DB = 12;

export function clampInputGainDb(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(MIN_INPUT_GAIN_DB, Math.min(MAX_INPUT_GAIN_DB, Math.round(value * 10) / 10));
}

/**
 * Lossless microphone capture for arrangement takes. AudioWorklet emits
 * transferable planar Float32 blocks; each block is acknowledged only after
 * IndexedDB commits it. MediaRecorder remains available for non-mic bounces.
 */
export class PcmMicRecorder {
  onError: ((message: string) => void) | null = null;

  private state_: PcmRecorderState = "idle";
  // `cancel()` can return while getUserMedia is still awaiting a permission
  // prompt. Keep that attempt exclusive until its async start path unwinds;
  // otherwise its late cleanup can disconnect a newer take's graph.
  private startInFlight = false;
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
  /** Pre-capture trim stage (inputGainNode → capture/monitor). */
  private inputGainNode: GainNode | null = null;
  /** Input level tap (post-trim) for the UI meter. */
  private inputAnalyser: AnalyserNode | null = null;
  private inputGainDb = 0;
  /** Reused level buffer for getInputLevel. */
  private levelBuf: Float32Array<ArrayBuffer> | null = null;
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

  private readonly recovery: IRecordingRecoveryRepository;
  private readonly inputDeviceId: string;

  constructor(private readonly deps: PcmMicRecorderDependencies) {
    this.recovery = deps.recovery ?? new RecordingRecoveryRepository();
    this.inputDeviceId = deps.inputDeviceId ?? loadRecordingInputDeviceId();
    this.inputGainDb = clampInputGainDb(deps.inputGainDb ?? 0);
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

  /** Live input trim in dB (applies to capture AND monitor, takes effect immediately). */
  setInputGainDb(db: number): void {
    this.inputGainDb = clampInputGainDb(db);
    const gain = this.inputGainNode?.gain;
    if (!gain) return;
    const now = this.deps.ctx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(Math.pow(10, this.inputGainDb / 20), now, 0.01);
  }

  /** Current input trim in dB. Derived from {@link inputGainDb}; kept as a
   * public alias so callers (tests, meters) can read the trim in dB without
   * touching the clamped backing field. */
  get inputGain(): number {
    return this.inputGainDb;
  }

  /**
   * Latest input peak/RMS (0..1, post-trim) for the UI meter; 0 when no mic
   * session is wired. Cheap — one getFloatTimeDomainData poll per call.
   */
  getInputLevel(): { peak: number; rms: number } {
    const analyser = this.inputAnalyser;
    if (!analyser) return { peak: 0, rms: 0 };
    if (!this.levelBuf || this.levelBuf.length !== analyser.fftSize) {
      this.levelBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    }
    const buf = this.levelBuf;
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sumSq += v * v;
    }
    return { peak, rms: buf.length > 0 ? Math.sqrt(sumSq / buf.length) : 0 };
  }

  get elapsedSeconds(): number {
    return this.state_ === "recording" || this.state_ === "stopping"
      ? Math.max(0, this.deps.ctx.currentTime - this.startedAt)
      : 0;
  }

  async start(getMetadata: () => PcmRecordingMetadata | null): Promise<void> {
    if (this.startInFlight || this.state_ !== "idle") {
      throw new Error(
        this.state_ === "starting" || this.startInFlight ? "A recording start is still settling" : "Already recording",
      );
    }
    if (activeCapture && activeCapture !== this) {
      throw new Error("The microphone is already in use by another recording — stop that recording first");
    }
    activeCapture = this;
    this.startInFlight = true;
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
      if (ctx.state !== "running") {
        await withTimeout(
          ctx.resume(),
          RESUME_TIMEOUT_MS,
          "The audio engine did not resume playback — interact with the page and try again",
        );
      }
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
        const audio: MediaTrackConstraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        };
        if (this.inputDeviceId) audio.deviceId = { exact: this.inputDeviceId };
        this.stream = await getUserMedia({
          audio,
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          throw new Error("Microphone access denied — allow the mic and try again");
        }
        if (name === "NotFoundError" || name === "DevicesNotFoundError") {
          if (this.inputDeviceId) {
            throw new Error("The selected microphone is unavailable — choose another input or System default");
          }
          throw new Error("No microphone is available");
        }
        if (name === "OverconstrainedError" && this.inputDeviceId) {
          throw new Error("The selected microphone is unavailable — choose another input or System default");
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
      // Pre-capture trim: source → inputGainNode → (capture worklet | monitor).
      // getInputLevel taps post-trim so the meter reads what will be saved.
      this.inputGainNode = ctx.createGain();
      this.inputGainNode.gain.value = Math.pow(10, this.inputGainDb / 20);
      this.inputAnalyser = ctx.createAnalyser();
      this.inputAnalyser.fftSize = 1024;
      const readyPromise = this.waitUntilReady();
      this.node.port.onmessage = (event: MessageEvent) => this.handleWorkletMessage(event.data);
      this.node.onprocessorerror = () =>
        this.reportError("Audio capture stopped unexpectedly; saved audio is available for recovery");
      this.source.connect(this.inputGainNode);
      this.inputGainNode.connect(this.node);
      this.inputGainNode.connect(this.inputAnalyser);
      this.node.connect(this.muteGain);
      this.muteGain.connect(ctx.destination);
      this.inputGainNode.connect(this.monitorGain);
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
      this.releaseCaptureClaim();
      throw error;
    } finally {
      this.startInFlight = false;
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
      this.releaseCaptureClaim();
      return;
    }
    await this.finishCapture();
  }

  private releaseCaptureClaim(): void {
    if (activeCapture === this) activeCapture = null;
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
      this.releaseCaptureClaim();
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
    if (this.source && this.inputGainNode) {
      try {
        this.source.disconnect(this.inputGainNode);
      } catch {
        /* already disconnected */
      }
    }
    if (this.inputGainNode && this.node) {
      try {
        this.inputGainNode.disconnect(this.node);
      } catch {
        /* already disconnected */
      }
    }
    if (this.inputGainNode && this.monitorGain) {
      try {
        this.inputGainNode.disconnect(this.monitorGain);
      } catch {
        /* already disconnected */
      }
    }
    try {
      this.inputGainNode?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.inputAnalyser?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.inputGainNode = null;
    this.inputAnalyser = null;
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
  const loading = ctx.audioWorklet.addModule(new URL(assetUrl("/recording-capture-worklet.js"), import.meta.url).href);
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
