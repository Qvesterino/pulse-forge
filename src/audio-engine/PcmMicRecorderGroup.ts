import {
  PcmCaptureStartBarrier,
  PcmMicRecorder,
  type PcmMicRecorderDependencies,
  type PcmRecordingMetadata,
} from "./PcmMicRecorder";
import type { MaterializedPcmTake } from "./pcmRecording";
import { RecordingRecoveryRepository, type RecordingPcmChunk } from "../persistence/RecordingRecoveryRepository";
import type { IRecordingRecoveryRepository } from "../persistence/contracts";

const PREPARE_TIMEOUT_MS = 20_000;
const RENDER_QUANTUM_FRAMES = 128;
const START_LEAD_SEC = 0.02;
const CHUNK_BATCH_WINDOW_MS = 4;
const MAX_GROUP_CHUNKS_PER_BATCH = 128;

export type PcmMicRecorderGroupDependencies = Omit<
  PcmMicRecorderDependencies,
  "captureGroupToken" | "captureStartBarrier" | "appendChunk"
>;

interface PendingGroupChunk {
  recovery: IRecordingRecoveryRepository;
  chunk: RecordingPcmChunk;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Collects concurrent worklet blocks so one storage transaction commits a group of tracks. */
class PcmCaptureChunkBatcher {
  private pending: PendingGroupChunk[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  append(recovery: IRecordingRecoveryRepository, chunk: RecordingPcmChunk): Promise<void> {
    const committed = new Promise<void>((resolve, reject) => {
      this.pending.push({ recovery, chunk, resolve, reject });
    });
    this.scheduleFlush();
    return committed;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, CHUNK_BATCH_WINDOW_MS);
  }

  private async flush(): Promise<void> {
    const batch = this.pending.splice(0, MAX_GROUP_CHUNKS_PER_BATCH);
    const byRepository = new Map<IRecordingRecoveryRepository, PendingGroupChunk[]>();
    for (const pending of batch) {
      const queued = byRepository.get(pending.recovery);
      if (queued) queued.push(pending);
      else byRepository.set(pending.recovery, [pending]);
    }

    await Promise.all(
      [...byRepository].map(async ([recovery, queued]) => {
        try {
          if (recovery.appendChunks) await recovery.appendChunks(queued.map((item) => item.chunk));
          else await Promise.all(queued.map((item) => recovery.appendChunk(item.chunk)));
          for (const item of queued) item.resolve();
        } catch (error) {
          for (const item of queued) item.reject(error);
        }
      }),
    );

    if (this.pending.length > 0) this.scheduleFlush();
  }
}

export interface PcmMicRecorderGroupInput {
  /** Stable per-track identity used by the arrangement UI and stop results. */
  id: string;
  dependencies: PcmMicRecorderGroupDependencies;
  getMetadata: () => PcmRecordingMetadata | null;
}

export interface PcmMicRecorderGroupStopResult {
  inputId: string;
  take: MaterializedPcmTake | null;
  error: string | null;
}

/**
 * Coordinates independent input devices as one arrangement recording.
 * Every member prepares its stream, worklet and recovery session first; only
 * then are all capture worklets armed on one future frame of their shared
 * AudioContext. Startup failure cancels every member, leaving committed PCM
 * in recovery instead of silently recording only part of the armed group.
 */
export class PcmMicRecorderGroup {
  private readonly entries: Array<{
    id: string;
    recorder: PcmMicRecorder;
    getMetadata: () => PcmRecordingMetadata | null;
  }>;
  private readonly startBarrier: PcmCaptureStartBarrier;
  private readonly captureGroupToken = {};
  private readonly context: AudioContext;
  private readonly chunkBatcher = new PcmCaptureChunkBatcher();
  private state_: "idle" | "starting" | "recording" | "stopping" | "complete" = "idle";
  private stopPromise: Promise<PcmMicRecorderGroupStopResult[]> | null = null;

  /** Called when an input fails after its group has started. */
  onFailure: ((inputId: string, message: string, results: PcmMicRecorderGroupStopResult[]) => void) | null = null;

  constructor(inputs: readonly PcmMicRecorderGroupInput[]) {
    if (inputs.length < 2) throw new Error("A coordinated capture group needs at least two input streams");
    if (new Set(inputs.map((input) => input.id)).size !== inputs.length) {
      throw new Error("Every coordinated input needs a different track identity");
    }
    const context = inputs[0]?.dependencies.ctx;
    if (!context || inputs.some((input) => input.dependencies.ctx !== context)) {
      throw new Error("All coordinated input streams must use the same live AudioContext");
    }
    this.context = context;

    this.startBarrier = new PcmCaptureStartBarrier(inputs.length);
    const fallbackRecovery = inputs.find((input) => input.dependencies.recovery)?.dependencies.recovery;
    const defaultRecovery = fallbackRecovery ?? new RecordingRecoveryRepository();
    this.entries = inputs.map((input) => {
      const recovery = input.dependencies.recovery ?? defaultRecovery;
      const recorder = new PcmMicRecorder({
        ...input.dependencies,
        recovery,
        captureGroupToken: this.captureGroupToken,
        captureStartBarrier: this.startBarrier,
        appendChunk: (chunk) => this.chunkBatcher.append(recovery, chunk),
      });
      recorder.onError = (message) => this.handleMemberFailure(input.id, message);
      return { id: input.id, recorder, getMetadata: input.getMetadata };
    });
  }

  get state(): "idle" | "starting" | "recording" | "stopping" | "complete" {
    return this.state_;
  }

  get elapsedSeconds(): number {
    return this.entries.reduce((elapsed, entry) => Math.max(elapsed, entry.recorder.elapsedSeconds), 0);
  }

  get inputIds(): string[] {
    return this.entries.map((entry) => entry.id);
  }

  getRecorder(inputId: string): PcmMicRecorder | null {
    return this.entries.find((entry) => entry.id === inputId)?.recorder ?? null;
  }

  setMonitoring(enabled: boolean): void {
    for (const { recorder } of this.entries) recorder.setMonitoring(enabled);
  }

  setInputMonitoring(inputId: string, enabled: boolean): void {
    this.getRecorder(inputId)?.setMonitoring(enabled);
  }

  setInputGainDb(db: number): void {
    for (const { recorder } of this.entries) recorder.setInputGainDb(db);
  }

  async start(): Promise<void> {
    if (this.state_ !== "idle") throw new Error("This coordinated recording group has already been used");
    this.state_ = "starting";

    const startAttempts = this.entries.map((entry) => entry.recorder.start(entry.getMetadata));
    // Each task is also observed independently. If one input rejects before
    // reaching the barrier, peers must not remain waiting for a member that
    // can never become ready.
    for (const attempt of startAttempts) void attempt.catch(() => {});
    const firstStartFailure = new Promise<never>((_resolve, reject) => {
      for (const attempt of startAttempts) void attempt.catch(reject);
    });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const preparationTimeout = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Not every armed audio input became ready within 20 seconds")),
        PREPARE_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([this.startBarrier.waitForAllPrepared(), firstStartFailure, preparationTimeout]);
      if (this.context.state !== "running")
        throw new Error("The shared audio engine stopped before the input group was ready");
      const firstFrame = Math.ceil(
        ((this.context.currentTime + START_LEAD_SEC) * this.context.sampleRate) / RENDER_QUANTUM_FRAMES,
      );
      this.startBarrier.releaseAt(firstFrame * RENDER_QUANTUM_FRAMES);
      await Promise.all(startAttempts);
      this.state_ = "recording";
    } catch (error) {
      this.startBarrier.abort(error);
      this.state_ = "stopping";
      await Promise.allSettled(this.entries.map((entry) => entry.recorder.cancel()));
      this.state_ = "complete";
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async stop(): Promise<PcmMicRecorderGroupStopResult[]> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state_ === "starting") {
      await this.cancel();
      return [];
    }
    if (this.state_ !== "recording") return [];
    this.state_ = "stopping";
    this.stopPromise = Promise.all(
      this.entries.map(async ({ id, recorder }) => {
        try {
          return { inputId: id, take: await recorder.stop(), error: null };
        } catch (error) {
          return { inputId: id, take: null, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    ).finally(() => {
      this.state_ = "complete";
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  async cancel(): Promise<void> {
    if (this.state_ === "complete") return;
    this.startBarrier.abort(new Error("The coordinated recording was cancelled"));
    this.state_ = "stopping";
    await Promise.allSettled(this.entries.map((entry) => entry.recorder.cancel()));
    this.state_ = "complete";
  }

  private handleMemberFailure(inputId: string, message: string): void {
    if (this.state_ === "starting") {
      void this.cancel();
      return;
    }
    if (this.state_ !== "recording") return;
    void this.stop().then((results) => this.onFailure?.(inputId, message, results));
  }
}
