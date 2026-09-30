import type { EffectRuntime } from "../effects/types";
import type { KwMeterHandle } from "../audio-worklets/kwmeter-node";
import { MeterRing } from "./MeterRing";
import {
  channelLevels,
  integratedLufs,
  lufsFromChannels,
  monoLossDb,
  stereoCorrelation,
  PeakHold,
  toDb,
  type ChannelLevels,
} from "./metering";
import { splitChannels, truePeakOversampled, type Frame } from "./metering";
import type { MasterMeterSnapshot, TrackMeterSnapshot } from "./metering-types";

/**
 * MeteringRig — Wave 4a of the AudioEngine decomposition
 * (docs/AUDIOENGINE-DECOMPOSITION-PLAN.md).
 *
 * Owns everything that READS the mixed graph without shaping it: track /
 * return / master meters, peak hold, LUFS history, and the analyser taps the
 * spectrum/spectrogram UIs observe. The nodes themselves are still created
 * and connected by the engine's master-chain builder (Wave 4b moves that) —
 * they are REGISTERED here via attachMasterTaps() and this class owns their
 * lifetime reads and teardown.
 *
 * Facade law: this module never imports AudioEngine. Everything it needs
 * from the engine arrives as getter closures in the constructor deps, so the
 * engine's module graph stays acyclic toward its collaborators.
 *
 * Everything below is a VERBATIM move from AudioEngine.ts (same bodies, same
 * constants, same cache semantics) — behavior-neutral by construction.
 */

/** Ring capacity: worst-case window for the 3.2 s short-term loudness read. */
export const METER_RING_CAPACITY = Math.ceil(96000 * 3.2);

/** Master-stage reads owned by the master chain (moves with Wave 4b). */
export interface MasterStageReader {
  limiter: DynamicsCompressorNode | null;
  limiterWorklet: EffectRuntime | null;
  glue: EffectRuntime | null;
  kwMeter: KwMeterHandle | null;
}

export interface MeteringRigDeps {
  ctx: () => BaseAudioContext | null;
  trackAnalyser: (id: string) => AnalyserNode | null;
  groupAnalyser: (id: string) => AnalyserNode | null;
  returnAnalyser: (id: string) => AnalyserNode | null;
  masterStage: () => MasterStageReader;
  /** Injectable clock for the snapshot TTL (tests); defaults to performance.now. */
  now?: () => number;
}

/** Snapshot + loudness history types moved beside their only owner. */
export type { MasterMeterSnapshot, TrackMeterSnapshot };

export class MeteringRig {
  // ── Registered master taps (written by the engine's buildMaster) ──
  masterAnalyser: AnalyserNode | null = null;
  private masterSplitter: ChannelSplitterNode | null = null;
  private masterAnalyserL: AnalyserNode | null = null;
  private masterAnalyserR: AnalyserNode | null = null;
  private masterSpectrogramAnalyser: AnalyserNode | null = null;
  private masterSpectrogramLow: AnalyserNode | null = null;
  private masterSpectrogramHigh: AnalyserNode | null = null;
  private masterSpectrogramMid: AnalyserNode | null = null;
  private masterSpectrogramSide: AnalyserNode | null = null;

  // ── Meter computation state ──
  private levelBuf = new Float32Array(1024);
  private masterChBufL: Float32Array<ArrayBuffer> = new Float32Array(2048);
  private masterChBufR: Float32Array<ArrayBuffer> = new Float32Array(2048);
  private masterPeakHold = new PeakHold(0.4);
  private meterHistoryL = new MeterRing(METER_RING_CAPACITY);
  private meterHistoryR = new MeterRing(METER_RING_CAPACITY);
  /** One-frame TTL cache for getMasterMeterSnapshot (see that method). */
  private masterMeterCache: { at: number; snapshot: MasterMeterSnapshot } | null = null;
  private meterLoudnessBlocks: number[] = [];
  private meterProjectId: string | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: MeteringRigDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  /**
   * Register the master-graph analysers created + connected by the engine's
   * master-chain builder. Null clears (a rebuild that has not rebuilt yet).
   */
  attachMasterTaps(taps: {
    analyser: AnalyserNode | null;
    splitter: ChannelSplitterNode | null;
    analyserL: AnalyserNode | null;
    analyserR: AnalyserNode | null;
    spectrogram: AnalyserNode | null;
    spectrogramLow: AnalyserNode | null;
    spectrogramHigh: AnalyserNode | null;
    spectrogramMid: AnalyserNode | null;
    spectrogramSide: AnalyserNode | null;
  }): void {
    this.masterAnalyser = taps.analyser;
    this.masterSplitter = taps.splitter;
    this.masterAnalyserL = taps.analyserL;
    this.masterAnalyserR = taps.analyserR;
    this.masterSpectrogramAnalyser = taps.spectrogram;
    this.masterSpectrogramLow = taps.spectrogramLow;
    this.masterSpectrogramHigh = taps.spectrogramHigh;
    this.masterSpectrogramMid = taps.spectrogramMid;
    this.masterSpectrogramSide = taps.spectrogramSide;
  }

  /** Disconnect every registered tap (master-chain rebuild path). */
  disconnectMasterTaps(): void {
    for (const node of [
      this.masterAnalyser,
      this.masterSplitter,
      this.masterAnalyserL,
      this.masterAnalyserR,
      this.masterSpectrogramAnalyser,
      this.masterSpectrogramLow,
      this.masterSpectrogramHigh,
      this.masterSpectrogramMid,
      this.masterSpectrogramSide,
    ]) {
      try {
        node?.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }

  /** Reset meter history when the metered project changes (setProject). */
  syncProjectId(projectId: string): void {
    if (this.meterProjectId !== null && this.meterProjectId !== projectId) this.resetMeterHistory();
    this.meterProjectId = projectId;
  }

  private rawPeakOf(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(this.levelBuf);
    let peak = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = Math.abs(this.levelBuf[i]);
      if (v > peak) peak = v;
    }
    return peak;
  }

  private peakOf(analyser: AnalyserNode | null): number {
    return Math.min(1, this.rawPeakOf(analyser));
  }

  getTrackLevel(trackId: string): number {
    return this.peakOf(this.deps.trackAnalyser(trackId));
  }

  getReturnLevel(returnId: string): number {
    return this.peakOf(this.deps.returnAnalyser(returnId));
  }

  /** One read for the mixer channel meter: level, peak readout and clip flag.
   * Groups are metered from their group nodes (same fallback the spectrogram
   * source getter uses) — pre-fix, bus strips showed flat-zero forever. */
  getTrackMeterSnapshot(trackId: string): TrackMeterSnapshot {
    const analyser = this.deps.trackAnalyser(trackId) ?? this.deps.groupAnalyser(trackId);
    const peak = this.rawPeakOf(analyser);
    return { level: Math.min(1, peak), peakDb: toDb(peak), clipping: peak >= 0.9995 };
  }

  getReturnMeterSnapshot(returnId: string): TrackMeterSnapshot {
    const peak = this.rawPeakOf(this.deps.returnAnalyser(returnId));
    return { level: Math.min(1, peak), peakDb: toDb(peak), clipping: peak >= 0.9995 };
  }

  getMasterLevel(): number {
    return this.peakOf(this.masterAnalyser);
  }

  /** Refresh the cached master frame and return per-channel levels + correlation. */
  getMasterLevels(): { left: ChannelLevels; right: ChannelLevels; correlation: number } {
    const out = {
      left: { peak: 0, rms: 0, peakDb: -120, rmsDb: -120 } as ChannelLevels,
      right: { peak: 0, rms: 0, peakDb: -120, rmsDb: -120 } as ChannelLevels,
      correlation: 1,
    };
    if (!this.masterAnalyserL || !this.masterAnalyserR) return out;
    this.masterAnalyserL.getFloatTimeDomainData(this.masterChBufL);
    this.masterAnalyserR.getFloatTimeDomainData(this.masterChBufR);
    const l = channelLevels(this.masterChBufL);
    const r = channelLevels(this.masterChBufR);
    const corr = stereoCorrelation(this.masterChBufL, this.masterChBufR);
    this.masterPeakHold.push(Math.max(l.peakDb, r.peakDb));
    out.left = l;
    out.right = r;
    out.correlation = corr;
    return out;
  }

  /** Held peak dBFS (decays slowly). Call after getMasterLevels() to get the latest hold. */
  getMasterPeakHoldDb(): number {
    return this.masterPeakHold.current;
  }

  /**
   * Current master-stage gain reduction in dB (0 = untouched). Reads the
   * look-ahead worklet meter when available, falling back to the native
   * DynamicsCompressorNode's reduction attribute (negative dB → normalized
   * to positive reduction).
   */
  getMasterGainReductionDb(): number {
    const stage = this.deps.masterStage();
    if (stage.limiterWorklet) return Math.max(0, stage.limiterWorklet.getGainReductionDb?.() ?? 0);
    const reduction = stage.limiter?.reduction ?? 0;
    const value = typeof reduction === "number" && Number.isFinite(reduction) ? -reduction : 0;
    return Math.max(0, value);
  }

  /** Current master-glue gain reduction in dB (0 = untouched). */
  getMasterGlueReductionDb(): number {
    return Math.max(0, this.deps.masterStage().glue?.getGainReductionDb?.() ?? 0);
  }

  resetMasterPeakHold(): void {
    this.masterPeakHold.reset();
  }

  resetMeterHistory(): void {
    this.meterHistoryL.reset();
    this.meterHistoryR.reset();
    this.meterLoudnessBlocks = [];
    this.masterPeakHold.reset();
  }

  resetMasterIntegratedLufs(): void {
    this.meterLoudnessBlocks = [];
    this.deps.masterStage().kwMeter?.reset();
  }

  getMasterMeterSnapshot(): MasterMeterSnapshot {
    // Three UI consumers poll this on the shared rAF bus (meter wall + stereo
    // strip ~30 Hz, loudness history ~10 Hz). A full snapshot runs true-peak
    // oversampling over 2×2048 samples plus ring pushes and allocations; a
    // one-frame TTL lets same-frame consumers share one computation instead
    // of paying it two-three times per animation frame.
    const now = this.now();
    const cached = this.masterMeterCache;
    if (cached && now - cached.at < 12) return cached.snapshot;
    const snapshot = this.computeMasterMeterSnapshot();
    this.masterMeterCache = { at: now, snapshot };
    return snapshot;
  }

  private computeMasterMeterSnapshot(): MasterMeterSnapshot {
    const levels = this.getMasterLevels();
    this.meterHistoryL.push(this.masterChBufL);
    this.meterHistoryR.push(this.masterChBufR);
    const sampleRate = this.deps.ctx()?.sampleRate ?? 44100;
    // The ring's capacity is the worst-case ceiling; no manual trim.
    // True peak: 4× polyphase oversampling (intersample peaks included).
    const truePeak = Math.max(measureTruePeak(this.masterChBufL, 1), measureTruePeak(this.masterChBufR, 1));
    // Loudness: exact BS.1770 K-weighting from the worklet when loaded;
    // legacy flat-energy approximation otherwise.
    const kwMeter = this.deps.masterStage().kwMeter;
    if (kwMeter) {
      const loudness = kwMeter.getLoudness();
      return {
        left: levels.left,
        right: levels.right,
        correlation: levels.correlation,
        peakHoldDb: this.masterPeakHold.current,
        truePeakDb: toDb(truePeak),
        lufsMomentary: loudness.m,
        lufsShortTerm: loudness.s,
        lufsIntegrated: loudness.i,
        monoLossDb: monoLossDb(this.masterChBufL, this.masterChBufR),
        lrImbalanceDb: Math.abs(levels.left.rmsDb - levels.right.rmsDb),
        gainReductionDb: this.getMasterGainReductionDb(),
        glueReductionDb: this.getMasterGlueReductionDb(),
      };
    }
    const window = (seconds: number): [Float32Array, Float32Array] => {
      // MeterRing.lastN already returns a fresh Float32Array in
      // chronological order — no slice + Float32Array.from copy.
      const length = Math.min(this.meterHistoryL.length, Math.max(1, Math.round(seconds * sampleRate)));
      return [this.meterHistoryL.lastN(length), this.meterHistoryR.lastN(length)];
    };
    const [momentaryL, momentaryR] = window(0.4);
    const [shortL, shortR] = window(3);
    const momentary = lufsFromChannels(momentaryL, momentaryR);
    this.meterLoudnessBlocks.push(momentary);
    if (this.meterLoudnessBlocks.length > 900) this.meterLoudnessBlocks.shift();
    return {
      left: levels.left,
      right: levels.right,
      correlation: levels.correlation,
      peakHoldDb: this.masterPeakHold.current,
      truePeakDb: toDb(truePeak),
      lufsMomentary: momentary,
      lufsShortTerm: lufsFromChannels(shortL, shortR),
      lufsIntegrated: integratedLufs(this.meterLoudnessBlocks),
      monoLossDb: monoLossDb(momentaryL, momentaryR),
      lrImbalanceDb: Math.abs(levels.left.rmsDb - levels.right.rmsDb),
      gainReductionDb: this.getMasterGainReductionDb(),
      glueReductionDb: this.getMasterGlueReductionDb(),
    };
  }

  /** 0 dBFS → 0 dB headroom (positive = peaking). */
  getMasterHeadroomDb(): number {
    const levels = this.getMasterLevels();
    return -Math.max(levels.left.peakDb, levels.right.peakDb);
  }

  /** Expose the master post-limiter AnalyserNode for spectrum UI (read-only observer). */
  getMasterSpectrumAnalyser(): AnalyserNode | null {
    return this.masterAnalyser;
  }

  getMasterStereoAnalysers(): { l: AnalyserNode; r: AnalyserNode } | null {
    if (!this.masterAnalyserL || !this.masterAnalyserR) return null;
    return { l: this.masterAnalyserL, r: this.masterAnalyserR };
  }

  /** Dedicated post-limiter analyser for the spectrogram waterfall (read-only observer). */
  getMasterSpectrogramAnalyser(): AnalyserNode | null {
    return this.masterSpectrogramAnalyser;
  }

  /**
   * Multi-resolution spectrogram taps (low 8192 / mid 4096 / high 1024) off
   * the same post-limiter sink point. Null until the master graph exists.
   */
  getMasterSpectrogramTaps(): { low: AnalyserNode; mid: AnalyserNode; high: AnalyserNode } | null {
    if (!this.masterSpectrogramLow || !this.masterSpectrogramAnalyser || !this.masterSpectrogramHigh) return null;
    return { low: this.masterSpectrogramLow, mid: this.masterSpectrogramAnalyser, high: this.masterSpectrogramHigh };
  }

  /**
   * Mid/side spectrogram taps (0.5·(L+R) and 0.5·(L−R)) off the master
   * splitter. Null until the master graph exists.
   */
  getMasterSpectrogramStereoTaps(): { mid: AnalyserNode; side: AnalyserNode } | null {
    if (!this.masterSpectrogramMid || !this.masterSpectrogramSide) return null;
    return { mid: this.masterSpectrogramMid, side: this.masterSpectrogramSide };
  }

  /**
   * Post-fader analyser branch for one track or group — the spectrogram's
   * per-source view. Reuses the track's own metering analyser (the chain
   * tail already feeds it), so a track view costs zero extra FFT work.
   * Read-only observer; null for unknown ids.
   */
  getSpectrogramTrackAnalyser(sourceId: string): AnalyserNode | null {
    return this.deps.trackAnalyser(sourceId) ?? this.deps.groupAnalyser(sourceId);
  }
}

/**
 * True peak via 4× polyphase oversampling (ITU BS.1770 style) — catches
 * intersample peaks that the old parabolic estimate missed. Delegates to
 * the shared pure implementation in metering.ts.
 */
export function measureTruePeak(frames: Frame, channels: number): number {
  if (frames.length === 0) return 0;
  return truePeakOversampled(splitChannels(frames, channels));
}
