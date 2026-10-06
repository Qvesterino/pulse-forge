import { MasterAnalysisAccumulator, type MasterAnalysisProgressListener } from "./analysis";
import type { MasterBufferAnalysis } from "./analysis";
import type { MasterProfile } from "./profiles";

const MAX_CHUNK_FRAMES = 131_072;
const MAX_ANALYSIS_SECONDS = 12 * 60 * 60;
const PROFILE_IDS = new Set(["streaming", "apple", "loud", "vinyl", "custom"]);

interface WorkerScope extends EventTarget {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
}

interface ActiveJob {
  jobId: number;
  sampleRate: number;
  frameCount: number;
  channelCount: number;
  profile: MasterProfile;
  analyzer: MasterAnalysisAccumulator;
  frameScratch: Float64Array;
  nextFrameOffset: number;
}

const scope = self as unknown as WorkerScope;
let activeJob: ActiveJob | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProfile(value: unknown): value is MasterProfile {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    PROFILE_IDS.has(value.id) &&
    typeof value.label === "string" &&
    value.label.length <= 96 &&
    typeof value.targetLufs === "number" &&
    Number.isFinite(value.targetLufs) &&
    value.targetLufs >= -70 &&
    value.targetLufs <= 6 &&
    typeof value.targetToleranceLufs === "number" &&
    Number.isFinite(value.targetToleranceLufs) &&
    value.targetToleranceLufs >= 0 &&
    value.targetToleranceLufs <= 24 &&
    typeof value.warningToleranceLufs === "number" &&
    Number.isFinite(value.warningToleranceLufs) &&
    value.warningToleranceLufs >= value.targetToleranceLufs &&
    value.warningToleranceLufs <= 36 &&
    typeof value.maxTruePeakDb === "number" &&
    Number.isFinite(value.maxTruePeakDb) &&
    value.maxTruePeakDb >= -60 &&
    value.maxTruePeakDb <= 6 &&
    typeof value.truePeakGraceDb === "number" &&
    Number.isFinite(value.truePeakGraceDb) &&
    value.truePeakGraceDb >= 0 &&
    value.truePeakGraceDb <= 12 &&
    typeof value.note === "string" &&
    value.note.length <= 1000 &&
    typeof value.recommendedFormat === "string" &&
    value.recommendedFormat.length <= 160 &&
    typeof value.intendedUse === "string" &&
    value.intendedUse.length <= 1000
  );
}

function post(jobId: number, type: string, details: Record<string, unknown> = {}): void {
  scope.postMessage({ type, jobId, ...details });
}

function handleMessage(value: unknown): void {
  if (!isRecord(value) || typeof value.type !== "string") return;
  const jobId = value.jobId;
  if (typeof jobId !== "number" || !Number.isSafeInteger(jobId) || jobId <= 0) return;

  if (value.type === "MASTER_ANALYSIS_START") {
    const sampleRate = value.sampleRate;
    const frameCount = value.frameCount;
    const channels = value.channelCount;
    const profile = value.profile;
    if (
      typeof sampleRate !== "number" ||
      !Number.isFinite(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 384000 ||
      typeof frameCount !== "number" ||
      !Number.isSafeInteger(frameCount) ||
      frameCount <= 0 ||
      frameCount / sampleRate > MAX_ANALYSIS_SECONDS ||
      typeof channels !== "number" ||
      !Number.isInteger(channels) ||
      channels < 1 ||
      channels > 2 ||
      !isProfile(profile)
    ) {
      post(jobId, "MASTER_ANALYSIS_ERROR", { message: "Invalid mastering analysis request or memory limit exceeded." });
      return;
    }
    try {
      activeJob = {
        jobId,
        sampleRate,
        frameCount,
        channelCount: channels,
        profile,
        analyzer: new MasterAnalysisAccumulator(sampleRate, channels, profile),
        frameScratch: new Float64Array(channels),
        nextFrameOffset: 0,
      };
    } catch {
      activeJob = null;
      post(jobId, "MASTER_ANALYSIS_ERROR", { message: "The browser could not reserve memory for this analysis." });
      return;
    }
    post(jobId, "MASTER_ANALYSIS_READY");
    return;
  }

  const job = activeJob;
  if (!job || job.jobId !== jobId) return;

  if (value.type === "MASTER_ANALYSIS_CHUNK") {
    const offset = value.offset;
    const data = value.channels;
    const chunks: unknown[] = Array.isArray(data) ? data : [];
    const length = chunks[0] instanceof Float32Array ? chunks[0].length : 0;
    if (
      offset !== job.nextFrameOffset ||
      chunks.length !== job.channelCount ||
      length <= 0 ||
      length > MAX_CHUNK_FRAMES ||
      chunks.some((chunk) => !(chunk instanceof Float32Array) || chunk.length !== length) ||
      offset + length > job.frameCount
    ) {
      activeJob = null;
      post(jobId, "MASTER_ANALYSIS_ERROR", { message: "Invalid PCM chunk sequence sent to mastering worker." });
      return;
    }
    for (let frame = 0; frame < length; frame++) {
      for (let channel = 0; channel < job.channelCount; channel++)
        job.frameScratch[channel] = (chunks[channel] as Float32Array)[frame];
      job.analyzer.processFrame(job.frameScratch);
    }
    job.nextFrameOffset += length;
    post(jobId, "MASTER_ANALYSIS_CHUNK_ACK", {
      offset,
      length,
      progress: job.nextFrameOffset / job.frameCount,
    });
    return;
  }

  if (value.type === "MASTER_ANALYSIS_FINISH") {
    if (job.nextFrameOffset !== job.frameCount) {
      activeJob = null;
      post(jobId, "MASTER_ANALYSIS_ERROR", { message: "Mastering analysis finished before all PCM chunks arrived." });
      return;
    }
    try {
      const onProgress: MasterAnalysisProgressListener = ({ progress, stage }) =>
        post(jobId, "MASTER_ANALYSIS_PROGRESS", { progress, stage });
      const analysis: MasterBufferAnalysis = job.analyzer.finish(onProgress);
      activeJob = null;
      post(jobId, "MASTER_ANALYSIS_RESULT", { analysis });
    } catch (error) {
      activeJob = null;
      post(jobId, "MASTER_ANALYSIS_ERROR", {
        message: error instanceof Error ? error.message.slice(0, 500) : "Mastering analysis failed.",
      });
    }
  }
}

scope.onmessage = (event) => handleMessage(event.data);
