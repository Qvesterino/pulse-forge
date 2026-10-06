import { MixDoctorAccumulator, type MixHealthReport } from "../analysis/mixDoctor";
import {
  evaluateMasterVerdict,
  toDb,
  TruePeakChannelAccumulator,
  type BufferSummary,
  type MasterVerdict,
} from "../audio-engine/metering";
import { KWeightedLoudnessAccumulator, type LoudnessTimeline } from "../audio-engine/kweighting";
import type { MasterProfile } from "./profiles";

/** All pre-encode or post-decode mastering measurements from one PCM buffer. */
export interface MasterBufferAnalysis {
  measurements: BufferSummary & { loudnessRangeLu: number | null };
  loudnessTimeline: LoudnessTimeline | null;
  mixHealth: MixHealthReport;
  verdict: MasterVerdict;
}

export interface MasterAnalysisProgress {
  progress: number;
  stage: string;
}

export type MasterAnalysisProgressListener = (update: MasterAnalysisProgress) => void;

/**
 * Canonical analysis entry for a rendered master. Each surface receives the
 * same summary, mix diagnostics and profile verdict from the same PCM buffer.
 */
export function analyzeMasterPcm(
  channels: readonly Float32Array[],
  sampleRate: number,
  profile: MasterProfile,
  onProgress?: MasterAnalysisProgressListener,
): MasterBufferAnalysis {
  if (channels.length < 1 || channels.length > 2) throw new Error("Master analysis requires one or two PCM channels.");
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000)
    throw new Error("Master analysis sample rate is outside the supported 8–384 kHz range.");
  const length = channels[0].length;
  if (length <= 0 || channels.some((channel) => channel.length !== length))
    throw new Error("Master analysis requires equally sized, non-empty PCM channels.");
  const analyzer = new MasterAnalysisAccumulator(sampleRate, channels.length, profile);
  const frame = new Float64Array(channels.length);
  const progressStride = 32768;
  onProgress?.({ progress: 0, stage: "Analyzing signal, loudness and spectral bands" });
  for (let index = 0; index < length; index++) {
    for (let channel = 0; channel < channels.length; channel++) frame[channel] = channels[channel][index];
    analyzer.processFrame(frame);
    if (index > 0 && index % progressStride === 0)
      onProgress?.({ progress: (index / length) * 0.88, stage: "Analyzing signal, loudness and spectral bands" });
  }
  return analyzer.finish(onProgress);
}

/** Single-pass, chunk-friendly analyzer used by the worker for long renders. */
export class MasterAnalysisAccumulator {
  private readonly frameScratch: Float64Array;
  private readonly loudness: KWeightedLoudnessAccumulator;
  private readonly mixDoctor: MixDoctorAccumulator;
  private readonly truePeak: TruePeakChannelAccumulator[];
  private frameCount = 0;
  private peak = 0;
  private sumSq = 0;
  private sumLeftSq = 0;
  private sumRightSq = 0;
  private monoSumSq = 0;
  private correlationMeanLeft = 0;
  private correlationMeanRight = 0;
  private correlationLeftVariance = 0;
  private correlationRightVariance = 0;
  private correlationCovariance = 0;

  constructor(
    sampleRate: number,
    private readonly channelCount: number,
    private readonly profile: MasterProfile,
  ) {
    this.frameScratch = new Float64Array(channelCount);
    this.truePeak = Array.from({ length: channelCount }, () => new TruePeakChannelAccumulator());
    this.loudness = new KWeightedLoudnessAccumulator(channelCount, sampleRate);
    this.mixDoctor = new MixDoctorAccumulator(channelCount, sampleRate);
  }

  processFrame(samples: ArrayLike<number>): void {
    this.mixDoctor.processFrame(samples);
    this.loudness.processFrame(samples);
    let mono = 0;
    for (let channel = 0; channel < this.channelCount; channel++) {
      const raw = samples[channel] ?? 0;
      const value = Number.isFinite(raw) ? raw : 0;
      this.frameScratch[channel] = value;
      const abs = Math.abs(value);
      if (abs > this.peak) this.peak = abs;
      this.sumSq += value * value;
      this.truePeak[channel].processSample(raw);
      mono += value;
      if (channel === 0) {
        this.sumLeftSq += value * value;
      } else if (channel === 1) {
        this.sumRightSq += value * value;
      }
    }
    if (this.channelCount >= 2) {
      const count = this.frameCount + 1;
      const left = this.frameScratch[0];
      const right = this.frameScratch[1];
      const deltaLeft = left - this.correlationMeanLeft;
      const deltaRight = right - this.correlationMeanRight;
      this.correlationMeanLeft += deltaLeft / count;
      this.correlationMeanRight += deltaRight / count;
      this.correlationLeftVariance += deltaLeft * (left - this.correlationMeanLeft);
      this.correlationRightVariance += deltaRight * (right - this.correlationMeanRight);
      this.correlationCovariance += deltaLeft * (right - this.correlationMeanRight);
    }
    mono /= this.channelCount;
    this.monoSumSq += mono * mono;
    this.frameCount++;
  }

  finish(onProgress?: MasterAnalysisProgressListener): MasterBufferAnalysis {
    onProgress?.({ progress: 0.9, stage: "Finalizing loudness and spectrum measurements" });
    const { loudness, loudnessRangeLu, loudnessTimeline } = this.loudness.finishWithLoudnessRange();
    const mixHealth = this.mixDoctor.finish(loudness);
    const totalSamples = this.frameCount * this.channelCount;
    const rms = totalSamples > 0 ? Math.sqrt(this.sumSq / totalSamples) : 0;
    const truePeak = this.truePeak.reduce((maximum, channel) => Math.max(maximum, channel.peak), 0);
    const correlation =
      this.channelCount < 2
        ? 1
        : (() => {
            if (this.correlationLeftVariance <= 0 || this.correlationRightVariance <= 0) return 1;
            return Math.max(
              -1,
              Math.min(
                1,
                this.correlationCovariance / Math.sqrt(this.correlationLeftVariance * this.correlationRightVariance),
              ),
            );
          })();
    const lrImbalanceDb =
      this.channelCount >= 2 && this.sumSq > 1e-12
        ? Math.abs(
            toDb(Math.sqrt(this.sumLeftSq / this.frameCount)) - toDb(Math.sqrt(this.sumRightSq / this.frameCount)),
          )
        : null;
    const stereoPower = (this.sumLeftSq + this.sumRightSq) * 0.5;
    const monoLossDb =
      this.channelCount < 2 || stereoPower <= 1e-12 ? 0 : toDb(Math.sqrt(this.monoSumSq / stereoPower));
    const measurements: BufferSummary & { loudnessRangeLu: number | null } = {
      channelCount: this.channelCount,
      peak: this.peak,
      peakDb: toDb(this.peak),
      truePeakDb: toDb(truePeak),
      rms,
      rmsDb: toDb(rms),
      correlation,
      lrImbalanceDb,
      lufsMomentary: loudness.measured ? loudness.momentaryMax : -120,
      lufsShortTerm: loudness.measured ? loudness.shortTermMax : -120,
      lufsIntegrated: loudness.measured ? loudness.integrated : -120,
      loudnessRangeLu,
      monoLossDb,
    };
    onProgress?.({ progress: 0.97, stage: "Building delivery verdict" });
    const stereoProgrammeMeasured = measurements.channelCount >= 2 && measurements.lufsIntegrated > -119;
    const verdict = evaluateMasterVerdict(
      {
        lufsIntegrated: measurements.lufsIntegrated,
        truePeakDb: measurements.truePeakDb,
        monoLossDb: stereoProgrammeMeasured ? measurements.monoLossDb : null,
        correlation: stereoProgrammeMeasured ? measurements.correlation : null,
        lrImbalanceDb: stereoProgrammeMeasured ? measurements.lrImbalanceDb : null,
      },
      this.profile.targetLufs,
      this.profile.maxTruePeakDb,
      this.profile.label.toUpperCase(),
      this.profile,
    );
    onProgress?.({ progress: 1, stage: "Analysis complete" });
    return { measurements, loudnessTimeline, mixHealth, verdict };
  }
}

export function analyzeMasterBuffer(
  buffer: AudioBuffer,
  profile: MasterProfile,
  onProgress?: MasterAnalysisProgressListener,
): MasterBufferAnalysis {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) channels.push(buffer.getChannelData(channel));
  return analyzeMasterPcm(channels, buffer.sampleRate, profile, onProgress);
}
