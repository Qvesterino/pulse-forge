/**
 * Live audio metering primitives. All helpers are pure and analyser-friendly so
 * they can be reused by the master/track/return meters and by the offline
 * renderer for export summaries.
 *
 * Conventions:
 *  - sample peak is linear; floating-point renders may exceed 1.0 (0 dBFS)
 *  - dBFS via `toDb(linear)`, clamped to -120..+6
 *  - RMS over a frame for momentary loudness
 *  - stereo correlation ∈ [-1, +1]: +1 = mono-compatible, < 0 = phase issues
 *  - peak hold with linear decay per poll
 */

import { evaluateDelivery, type MasterProfile } from "../mastering/profiles";

import { analyzeLoudnessBuffer } from "./kweighting";

export const MIN_DB = -120;
export const MAX_DB = 6;

export function toDb(linear: number): number {
  const v = Math.abs(linear);
  if (!Number.isFinite(v) || v <= 0) return MIN_DB;
  const db = 20 * Math.log10(v);
  if (db > MAX_DB) return MAX_DB;
  if (db < MIN_DB) return MIN_DB;
  return db;
}

export function fromDb(db: number): number {
  return Math.pow(10, db / 20);
}

/** Approximate BS.1770 loudness from a stereo window (K-weighting is omitted
 * for the lightweight live path; the same calibration is used offline). */
export function lufsFromChannels(left: Float32Array, right: Float32Array = left): number {
  const n = Math.min(left.length, right.length);
  if (n === 0) return MIN_DB;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += (left[i] * left[i] + right[i] * right[i]) * 0.5;
  return energy <= 1e-12 ? MIN_DB : Math.max(MIN_DB, -0.691 + 10 * Math.log10(energy / n));
}

/** EBU-style relative-gated integrated loudness from 400 ms block readings. */
export function integratedLufs(blocks: number[]): number {
  const valid = blocks.filter((value) => Number.isFinite(value) && value > -70);
  if (valid.length === 0) return MIN_DB;
  const ungated = valid.reduce((sum, value) => sum + Math.pow(10, (value + 0.691) / 10), 0) / valid.length;
  const relativeGate = -0.691 + 10 * Math.log10(Math.max(1e-12, ungated)) - 10;
  const gated = valid.filter((value) => value >= Math.max(-70, relativeGate));
  if (gated.length === 0) return MIN_DB;
  const energy = gated.reduce((sum, value) => sum + Math.pow(10, (value + 0.691) / 10), 0) / gated.length;
  return Math.max(MIN_DB, -0.691 + 10 * Math.log10(Math.max(1e-12, energy)));
}

/** Stereo fold-down level relative to the stereo RMS level. */
export function monoLossDb(left: Float32Array, right: Float32Array): number {
  const n = Math.min(left.length, right.length);
  if (n === 0) return 0;
  let stereo = 0;
  let mono = 0;
  for (let i = 0; i < n; i++) {
    const leftSample = left[i];
    const rightSample = right[i];
    const l = Number.isFinite(leftSample) ? leftSample : 0;
    const r = Number.isFinite(rightSample) ? rightSample : 0;
    stereo += (l * l + r * r) * 0.5;
    const m = (l + r) * 0.5;
    mono += m * m;
  }
  if (stereo <= 1e-12) return 0;
  return toDb(Math.sqrt(mono / stereo));
}

export interface MixCheckSnapshot {
  truePeakDb: number;
  correlation: number;
  monoLossDb: number;
  lrImbalanceDb: number;
  phaseDurationMs?: number;
  imbalanceDurationMs?: number;
}

export interface MixCheckWarning {
  code: "true-peak" | "clipping" | "phase" | "mono-loss" | "lr-imbalance";
  message: string;
  severity: "warn" | "error";
}

export function evaluateMixCheck(snapshot: MixCheckSnapshot): MixCheckWarning[] {
  const warnings: MixCheckWarning[] = [];
  if (snapshot.truePeakDb > -0.1)
    warnings.push({ code: "clipping", message: "True peak is clipping above -0.1 dBTP", severity: "error" });
  else if (snapshot.truePeakDb > -1)
    warnings.push({ code: "true-peak", message: "True peak is above -1 dBTP", severity: "warn" });
  if (snapshot.correlation < 0 && (snapshot.phaseDurationMs ?? 0) >= 250)
    warnings.push({ code: "phase", message: "Stereo correlation is negative", severity: "warn" });
  if (snapshot.monoLossDb < -3)
    warnings.push({ code: "mono-loss", message: "Mono fold-down loses more than 3 dB", severity: "warn" });
  if (snapshot.lrImbalanceDb > 6 && (snapshot.imbalanceDurationMs ?? 0) >= 1000)
    warnings.push({ code: "lr-imbalance", message: "Left/right balance differs by more than 6 dB", severity: "warn" });
  return warnings;
}

export interface ExportMonoGuard {
  /** ok = mono-safe, warn = check wide elements, bad = fix before sharing. */
  level: "ok" | "warn" | "bad";
  /** Actionable hints, highest priority first (UI shows all, usually 1–2). */
  hints: string[];
}

/**
 * Mono-compatibility guardian for rendered files. Same thresholds as the
 * live mix-check verdict (mono loss −3 dB warn, negative correlation bad,
 * −6 dB loss severe) so live meters and the export summary never disagree.
 * Pure so the export panel can render it and tests can pin the thresholds.
 */
export function evaluateExportMonoGuard(input: Pick<BufferSummary, "monoLossDb" | "correlation">): ExportMonoGuard {
  const hints: string[] = [];
  let level: ExportMonoGuard["level"] = "ok";

  if (input.correlation < 0) {
    level = "bad";
    hints.push("Phase issues — the sides cancel in mono, check wide elements");
  }
  if (input.monoLossDb < -6) {
    level = "bad";
    hints.push("Mono fold-down loses depth — narrow Haas/wide layers");
  } else if (input.monoLossDb < -3) {
    if (level === "ok") level = "warn";
    hints.push("Mono fold-down loses depth — check wide elements");
  }

  return { level, hints };
}

export interface StageAdjustment {
  /** True when there is nothing to do (silent mix, muted master, already staged). */
  noop: boolean;
  /** New masterGain in 0..2 (equals the current gain when noop). */
  masterGain: number;
  /** Applied delta in dB before output clamping (≤ +something, display only). */
  deltaDb: number;
  /** Human-readable applied steps (empty when noop). */
  applied: string[];
}

/**
 * One-click export gain staging from a rendered summary. Pulls the master IN
 * so the true peak lands at ceiling − 1 dBTP while honoring the streaming
 * loudness target — the conservative (quieter) of the two deltas wins, so a
 * single step can never clip. Only ever touches masterGain (the limiter
 * ceiling stays an artistic choice); the command is undoable at the call
 * site. Pure so tests can pin the math.
 */
export function computeStageAdjustment(
  input: Pick<BufferSummary, "lufsIntegrated" | "truePeakDb">,
  currentGain: number,
  lufsTarget: number,
  ceilingDb: number,
): StageAdjustment {
  const noop = { noop: true, masterGain: currentGain, deltaDb: 0, applied: [] as string[] };
  if (!Number.isFinite(currentGain) || currentGain <= 0) return noop;
  if (input.lufsIntegrated <= -119) return noop;
  if (!Number.isFinite(input.truePeakDb) || !Number.isFinite(input.lufsIntegrated)) return noop;

  const peakDelta = ceilingDb - 1 - input.truePeakDb;
  // Positive when the mix is quiet (raise IN), negative when loud.
  const loudDelta = lufsTarget - input.lufsIntegrated;
  const loud = Math.abs(input.lufsIntegrated - lufsTarget) > 1 ? loudDelta : 0;
  const delta = Math.min(peakDelta, loud);
  if (Math.abs(delta) < 0.05) return noop;

  const masterGain = Math.max(0, Math.min(2, currentGain * Math.pow(10, delta / 20)));
  if (masterGain === currentGain) return noop;
  const actualDb = 20 * Math.log10(masterGain / currentGain);
  return {
    noop: false,
    masterGain,
    deltaDb: delta,
    applied: [
      `Master IN ${actualDb >= 0 ? "+" : ""}${actualDb.toFixed(1)} dB — ` +
        `peak ≈ ${(input.truePeakDb + actualDb).toFixed(1)} dBTP, ` +
        `LUFS-I ≈ ${(input.lufsIntegrated + actualDb).toFixed(1)}`,
    ],
  };
}

export interface MasterVerdictInput {
  lufsIntegrated: number;
  truePeakDb: number;
  monoLossDb: number | null;
  correlation: number | null;
  lrImbalanceDb: number | null;
}

export interface MasterVerdict {
  /** idle = one or more required checks were not measured, ok = print-ready, warn = close, bad = fix first. */
  level: "idle" | "ok" | "warn" | "bad";
  headline: string;
  /** Fix-it hints, highest priority first (UI shows at most two). */
  hints: string[];
  /** LUFS-I − target; 0 when idle. */
  loudnessDeltaDb: number;
  /** Detailed delivery checks from the shared profile evaluator. */
  status: ReturnType<typeof evaluateDelivery>["status"];
  checks: ReturnType<typeof evaluateDelivery>["checks"];
}

/**
 * One-glance "is this print-ready" verdict for the master: loudness vs the
 * streaming target, true peak vs the limiter ceiling, mono compatibility and
 * balance. Pure so the UI can render it and tests can pin the thresholds.
 */
export function evaluateMasterVerdict(
  input: MasterVerdictInput,
  lufsTarget: number,
  ceilingDb: number,
  targetLabel = "",
  deliveryProfile?: MasterProfile,
): MasterVerdict {
  const profile: MasterProfile = deliveryProfile ?? {
    id: "custom",
    label: targetLabel || "Master",
    targetLufs: lufsTarget,
    targetToleranceLufs: 1,
    warningToleranceLufs: 2,
    maxTruePeakDb: ceilingDb,
    truePeakGraceDb: 0.3,
    note: "",
    recommendedFormat: "",
    intendedUse: "",
  };
  const result = evaluateDelivery(
    {
      lufs: input.lufsIntegrated,
      truePeakDb: input.truePeakDb,
      correlation: input.correlation,
      monoLossDb: input.monoLossDb,
      lrImbalanceDb: input.lrImbalanceDb,
    },
    profile,
    lufsTarget,
    deliveryProfile?.maxTruePeakDb ?? ceilingDb,
  );
  const checks = result.checks;
  const level: MasterVerdict["level"] =
    result.status === "fail"
      ? "bad"
      : result.status === "warn"
        ? "warn"
        : result.status === "not-measured"
          ? "idle"
          : "ok";
  const peakCheck = checks.find((check) => check.line.startsWith("true peak "));
  const failedPeak = peakCheck?.status === "fail";
  const phaseIssue = checks.some((check) => check.status === "fail" && check.line.startsWith("Phase issues"));
  const hints: string[] = [];
  if (phaseIssue) hints.push("Phase issues — check mono compatibility");
  if (peakCheck && peakCheck.status !== "pass") {
    hints.push(
      peakCheck.status === "warn"
        ? `True peak is close to the ${deliveryProfile?.label ?? "master"} limit — leave more headroom`
        : deliveryProfile
          ? `True peak exceeds ${deliveryProfile.label} target — lower the output level or choose more headroom`
          : "True peak over ceiling — pull IN or CEIL down",
    );
  }
  if (Math.abs(result.loudnessDeltaDb) > 1) {
    hints.push(
      result.loudnessDeltaDb > 0
        ? `+${result.loudnessDeltaDb.toFixed(1)} dB louder than target — review the delivery target`
        : `${Math.abs(result.loudnessDeltaDb).toFixed(1)} dB quieter than target — review the delivery target`,
    );
  }
  if (checks.some((check) => check.status === "warn" && check.line.startsWith("Mono fold-down"))) {
    hints.push("Mono fold-down loses depth — check wide elements");
  }
  if (checks.some((check) => check.status === "warn" && check.line.startsWith("Left/right balance"))) {
    hints.push("Left/right balance off by more than 6 dB");
  }

  const forLabel = targetLabel ? ` FOR ${targetLabel}` : "";
  let headline: string;
  if (level === "idle") headline = "NOT MEASURED";
  else if (level === "ok") headline = `READY${forLabel}`;
  else if (failedPeak) headline = "TRUE PEAK OVER";
  else if (phaseIssue) headline = "PHASE ISSUES";
  else if (result.loudnessDeltaDb > 1) headline = "TOO LOUD";
  else if (result.loudnessDeltaDb < -1) headline = "TOO QUIET";
  else headline = "CHECK STEREO";

  return {
    level,
    headline,
    hints: hints.slice(0, 2),
    loudnessDeltaDb: result.loudnessDeltaDb,
    status: result.status,
    checks: result.checks,
  };
}

/** Channel-interleaved linear frame (L, R, L, R, …). */
export type Frame = Float32Array<ArrayBuffer>;

export interface ChannelLevels {
  /** Linear peak [0..1] (post-clipping safety). */
  peak: number;
  /** Linear RMS [0..1]. */
  rms: number;
  /** Peak in dBFS. */
  peakDb: number;
  /** RMS in dBFS. */
  rmsDb: number;
}

export function emptyLevels(): ChannelLevels {
  return { peak: 0, rms: 0, peakDb: MIN_DB, rmsDb: MIN_DB };
}

/** Split an interleaved frame into separate left/right channel arrays. */
export function splitChannels(frame: Frame, channels: number): Float32Array<ArrayBuffer>[] {
  if (channels <= 1) return [frame as Float32Array<ArrayBuffer>];
  const length = Math.floor(frame.length / channels);
  const out: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < channels; c++) {
    const slice = new Float32Array(length);
    for (let i = 0; i < length; i++) slice[i] = frame[i * channels + c];
    out.push(slice);
  }
  return out;
}

/** Peak + RMS over a single channel. */
export function channelLevels(channel: Float32Array): ChannelLevels {
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < channel.length; i++) {
    const v = Math.abs(channel[i]);
    if (v > peak) peak = v;
    sumSq += channel[i] * channel[i];
  }
  const rms = channel.length > 0 ? Math.sqrt(sumSq / channel.length) : 0;
  return { peak, rms, peakDb: toDb(peak), rmsDb: toDb(rms) };
}

/**
 * Stereo correlation ∈ [-1, +1] from two equal-length channels. Uses the
 * standard Pearson formula on the recent frame. Returns 1 for true mono.
 */
export function stereoCorrelation(left: Float32Array, right: Float32Array): number {
  const n = Math.min(left.length, right.length);
  if (n === 0) return 1;
  let sumL = 0;
  let sumR = 0;
  for (let i = 0; i < n; i++) {
    const leftSample = left[i];
    const rightSample = right[i];
    sumL += Number.isFinite(leftSample) ? leftSample : 0;
    sumR += Number.isFinite(rightSample) ? rightSample : 0;
  }
  const meanL = sumL / n;
  const meanR = sumR / n;
  let num = 0;
  let denL = 0;
  let denR = 0;
  for (let i = 0; i < n; i++) {
    const leftSample = left[i];
    const rightSample = right[i];
    const dl = (Number.isFinite(leftSample) ? leftSample : 0) - meanL;
    const dr = (Number.isFinite(rightSample) ? rightSample : 0) - meanR;
    num += dl * dr;
    denL += dl * dl;
    denR += dr * dr;
  }
  if (denL === 0 || denR === 0) return 1;
  return Math.max(-1, Math.min(1, num / Math.sqrt(denL * denR)));
}

/**
 * Peak-hold with linear decay per poll. The "true peak" reading tracks the
 * largest peak observed since the last reset (or implicit last decay window),
 * then drops at `decayPerPoll` dB per poll. Decay rate is set so the displayed
 * value falls ~10 dB over ~1 second at a 30 Hz poll rate.
 */
export class PeakHold {
  private value = MIN_DB;
  constructor(private decayPerPoll = 0.33) {}

  push(peakDb: number): number {
    if (peakDb > this.value) {
      this.value = peakDb;
    } else {
      this.value = Math.max(MIN_DB, this.value - this.decayPerPoll);
    }
    return this.value;
  }

  reset(): void {
    this.value = MIN_DB;
  }

  get current(): number {
    return this.value;
  }
}

/**
 * Read interleaved audio data from an AnalyserNode into a buffer. Handles
 * channelCount via `getFloatTimeDomainData` (which produces interleaved data
 * when channelCount > 1).
 */
export function readAnalyserFrame(analyser: AnalyserNode, target: Frame): void {
  analyser.getFloatTimeDomainData(target);
}

export interface BufferSummary {
  /** Actual channel count on the measured buffer. */
  channelCount: number;
  /** Linear sample peak across the whole buffer; can exceed 1 in floating-point audio. */
  peak: number;
  /** Peak in dBFS. */
  peakDb: number;
  /** True peak estimate (4×-style oversampled search) in dBFS. */
  truePeakDb: number;
  /** Linear RMS [0..1]. */
  rms: number;
  /** RMS in dBFS. */
  rmsDb: number;
  /** Stereo correlation [-1, +1]; 1 for mono source. */
  correlation: number;
  /** Absolute whole-program RMS difference between channels; null for mono or digital silence. */
  lrImbalanceDb: number | null;
  lufsMomentary: number;
  lufsShortTerm: number;
  lufsIntegrated: number;
  /** EBU Tech 3342 loudness range in LU; absent outside full master analysis. */
  loudnessRangeLu?: number | null;
  monoLossDb: number;
}

export type MeteringProgress = (stage: "peak-rms" | "true-peak" | "loudness", fraction: number) => void;

const EMPTY_SUMMARY: BufferSummary = {
  channelCount: 0,
  peak: 0,
  peakDb: MIN_DB,
  truePeakDb: MIN_DB,
  rms: 0,
  rmsDb: MIN_DB,
  correlation: 1,
  lrImbalanceDb: null,
  lufsMomentary: MIN_DB,
  lufsShortTerm: MIN_DB,
  lufsIntegrated: MIN_DB,
  monoLossDb: 0,
};

/**
 * Whole-buffer summary: peak, true-peak, RMS, and (stereo) correlation. Used
 * by the export panel to surface the master reading for a rendered file.
 */
export function summarizeBuffer(buffer: AudioBuffer): BufferSummary {
  const split: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++)
    split.push(buffer.getChannelData(c) as Float32Array<ArrayBuffer>);
  return summarizePcm(split, buffer.sampleRate, buffer.numberOfChannels);
}

/** Pure channel-array entry point shared by the UI and mastering analysis worker. */
export function summarizePcm(
  channels: readonly Float32Array[],
  sampleRate: number,
  channelCount = channels.length,
  onProgress?: MeteringProgress,
): BufferSummary {
  const split = channels.slice(0, 2);
  if (split.length === 0 || split[0].length === 0)
    return { ...EMPTY_SUMMARY, channelCount: Math.max(0, Math.floor(channelCount)) };

  let peak = 0;
  let sumSq = 0;
  const channelSumSq = new Array<number>(split.length).fill(0);
  const totalFrames = split.reduce((sum, channel) => sum + channel.length, 0);
  let completedFrames = 0;
  onProgress?.("peak-rms", 0);
  for (let channel = 0; channel < split.length; channel++) {
    const ch = split[channel];
    for (let i = 0; i < ch.length; i++) {
      const raw = ch[i];
      const v = Number.isFinite(raw) ? raw : 0;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
      channelSumSq[channel] += v * v;
      completedFrames++;
      if (completedFrames % 32768 === 0) onProgress?.("peak-rms", completedFrames / totalFrames);
    }
  }
  onProgress?.("peak-rms", 1);
  const total = split.reduce((acc, ch) => acc + ch.length, 0);
  const rms = total > 0 ? Math.sqrt(sumSq / total) : 0;
  const truePeak = truePeakOversampled(split, (fraction) => onProgress?.("true-peak", fraction));
  const correlation = split.length >= 2 ? stereoCorrelation(split[0], split[1]) : 1;
  const lrImbalanceDb =
    split.length >= 2 && sumSq > 1e-12
      ? Math.abs(
          toDb(Math.sqrt(channelSumSq[0] / split[0].length)) - toDb(Math.sqrt(channelSumSq[1] / split[1].length)),
        )
      : null;
  const loudness = analyzeLoudnessBuffer(split, sampleRate, (fraction) => onProgress?.("loudness", fraction));

  return {
    channelCount: Math.max(0, Math.floor(channelCount)),
    peak,
    peakDb: toDb(peak),
    truePeakDb: toDb(truePeak),
    rms,
    rmsDb: toDb(rms),
    correlation,
    lrImbalanceDb,
    lufsMomentary: loudness.measured ? loudness.momentaryMax : MIN_DB,
    lufsShortTerm: loudness.measured ? loudness.shortTermMax : MIN_DB,
    lufsIntegrated: loudness.measured ? loudness.integrated : MIN_DB,
    monoLossDb: split.length >= 2 ? monoLossDb(split[0], split[1]) : 0,
  };
}

/**
 * True-peak via 4× polyphase oversampling (ITU BS.1770 style): each input
 * sample is zero-stuffed ×4 and low-passed with a windowed-sinc prototype
 * (decomposed into 4 phases of 16 taps, DC-normalized). Catches intersample
 * peaks — the classic fs/4 sine at 45° phase reads ~+3 dB over sample peak,
 * which the old parabolic estimate could not see.
 */
const TP_PHASES = 4;
const TP_TAPS_PER_PHASE = 16;

const TRUE_PEAK_FILTER: Float32Array[] = (() => {
  const prototype = new Float64Array(TP_PHASES * TP_TAPS_PER_PHASE);
  const center = (prototype.length - 1) / 2;
  for (let n = 0; n < prototype.length; n++) {
    const x = (n - center) / TP_PHASES;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    // Blackman window for clean stopband.
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * n) / (prototype.length - 1)) +
      0.08 * Math.cos((4 * Math.PI * n) / (prototype.length - 1));
    prototype[n] = sinc * w;
  }
  const phases: Float32Array[] = [];
  for (let p = 0; p < TP_PHASES; p++) {
    const taps = new Float32Array(TP_TAPS_PER_PHASE);
    let sum = 0;
    for (let j = 0; j < TP_TAPS_PER_PHASE; j++) {
      taps[j] = prototype[j * TP_PHASES + p];
      sum += taps[j];
    }
    for (let j = 0; j < TP_TAPS_PER_PHASE; j++) taps[j] /= sum; // DC gain = 1
    phases.push(taps);
  }
  return phases;
})();

/** One-channel true-peak state that keeps only the FIR history between chunks. */
export class TruePeakChannelAccumulator {
  private readonly history = new Float64Array(TP_TAPS_PER_PHASE);
  private frameCount = 0;
  private maximum = 0;

  processSample(raw: number): void {
    const index = this.frameCount;
    this.history[index % TP_TAPS_PER_PHASE] = Number.isFinite(raw) ? raw : 0;
    for (let phase = 0; phase < TP_PHASES; phase++) {
      const taps = TRUE_PEAK_FILTER[phase];
      let acc = 0;
      const base = index + 1 - TP_TAPS_PER_PHASE;
      for (let tap = 0; tap < TP_TAPS_PER_PHASE; tap++) {
        const sourceIndex = base + tap;
        if (sourceIndex >= 0) acc += this.history[sourceIndex % TP_TAPS_PER_PHASE] * taps[tap];
      }
      const value = acc < 0 ? -acc : acc;
      if (value > this.maximum) this.maximum = value;
    }
    this.frameCount++;
  }

  get peak(): number {
    return this.maximum;
  }
}

export function truePeakOversampled(
  channels: readonly Float32Array[],
  onProgress?: (fraction: number) => void,
): number {
  let peak = 0;
  const totalWork = channels.reduce((sum, channel) => sum + channel.length * TP_PHASES, 0);
  let completedWork = 0;
  let lastProgressWork = 0;
  const progressStride = 32768;
  onProgress?.(0);
  for (const ch of channels) {
    const accumulator = new TruePeakChannelAccumulator();
    for (let index = 0; index < ch.length; index++) {
      accumulator.processSample(ch[index]);
      completedWork += TP_PHASES;
      if (completedWork - lastProgressWork >= progressStride && totalWork > 0) {
        lastProgressWork = completedWork;
        onProgress?.(completedWork / totalWork);
      }
    }
    if (accumulator.peak > peak) peak = accumulator.peak;
  }
  onProgress?.(1);
  return peak;
}
