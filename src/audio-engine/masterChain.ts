import type { EffectRuntime } from "../effects/types";
import { createLimiterNode } from "../audio-worklets/limiter-node";
import { createCompressorNode } from "../audio-worklets/compressor-node";
import { createTapeNode } from "../audio-worklets/tape-node";
import { createKwMeterNode, type KwMeterHandle } from "../audio-worklets/kwmeter-node";
import { createRtMonitorNode, type RtMonitorHandle } from "../audio-worklets/rt-monitor-node";
import { isWorkletReady } from "../audio-worklets/loader";
import { defaultMasterConfig } from "../project-model/schema";
import type { MasterConfig } from "../project-model/types";
import { isLiveAudioContext } from "./liveContext";
import type { MeteringRig } from "./meteringRig";

/** Master-stage handles the metering rig (and diagnostics) read. */
export interface MasterStage {
  limiter: DynamicsCompressorNode | null;
  limiterWorklet: EffectRuntime | null;
  glue: EffectRuntime | null;
  glueNative: DynamicsCompressorNode | null;
  kwMeter: KwMeterHandle | null;
  /** Audio-thread load / xrun probe (release-gate hardening). */
  rtMonitor: RtMonitorHandle | null;
}

export interface MasterChainDeps {
  ctx: () => BaseAudioContext | null;
  doc: () => import("../project-model/types").ProjectDocument | null;
  metering: MeteringRig;
}

/**
 * MasterChain — Wave 4b of the AudioEngine decomposition
 * (docs/AUDIOENGINE-DECOMPOSITION-PLAN.md).
 *
 * Owns the master output graph: input gain → tape → M/S → bass-mono → DC
 * blocker → match EQ → tilt → glue → user inserts → clipper → limiter (+ look-ahead worklet
 * splice + K-weighted meter sink), and every `master*` device handle. The
 * metering taps it creates are REGISTERED with the MeteringRig (which owns
 * their storage and reads — Wave 4a); creation and graph shape stay here.
 *
 * Facade law: this module never imports AudioEngine. The context/document
 * arrive as getter closures, so the engine module graph stays acyclic.
 *
 * Everything below is a VERBATIM move from AudioEngine.ts — same bodies,
 * same constants, same config semantics (applyMasterConfig re-reads the
 * full config on every syncProject exactly as before).
 */

export class MasterChain {
  constructor(private readonly deps: MasterChainDeps) {}

  private master: GainNode | null = null;
  private masterClipper: WaveShaperNode | null = null;
  private masterInsertInput: GainNode | null = null;
  private masterInsertOutput: GainNode | null = null;
  /** Cached soft-clip curve — depends only on constants, so built once and
   *  reused across commits / fader-preview frames (applyMasterConfig runs
   *  on every syncProject). */
  private masterClipperCurve: Float32Array<ArrayBuffer> | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;
  /**
   * Look-ahead limiter runtime spliced between the master clipper and the
   * native node whenever AudioWorklet DSP is available. The native node then
   * stays a neutral pass-through and only takes over again without worklets.
   */
  private masterLimiterWorklet: EffectRuntime | null = null;
  /** K-weighted loudness meter (BS.1770) — sink branch off the master limiter. */
  private kwMeter: KwMeterHandle | null = null;
  /** Audio-thread load / xrun probe — sink branch off the master limiter. */
  private rtMonitor: RtMonitorHandle | null = null;
  // @ts-ignore — reserved for master tape/ms stage
  private masterTape: EffectRuntime | null = null;
  /**
   * Master DC blocker (fixed 12 Hz highpass, always on) — asymmetric tube /
   * tape / 808 stages push DC that would otherwise steal limiter headroom.
   */
  private masterDc: BiquadFilterNode | null = null;
  /**
   * Master buss glue (gentle 2:1 RMS compressor, post-M/S pre-clipper).
   * Worklet runtime when DSP is available, native DCN mapping otherwise.
   */
  private masterGlue: EffectRuntime | null = null;
  /** Native fallback node behind masterGlue (null on the worklet path). */
  private masterGlueNative: DynamicsCompressorNode | null = null;
  /**
   * Master tonal tilt (complementary shelf pair, ±tilt/2 at 150 Hz / 5 kHz).
   * Always in the chain; 0 dB = transparent, so legacy mixes are untouched.
   */
  private masterTiltLow: BiquadFilterNode | null =
    null; /** MATCH EQ corrective stage (4 biquads, MasterConfig.matchEq-driven). */
  private masterMatchEqStages: BiquadFilterNode[] | null = null;

  private masterTiltHigh: BiquadFilterNode | null = null;

  /**
   * Bass Mono stage (FX expansion): M/S matrix whose SIDE branch passes
   * through a lowpass — below the corner frequency the master collapses to
   * mono. Always in the chain; `enabled` crossfades dry/wet side paths.
   */
  private masterBassMono: {
    input: GainNode;
    output: GainNode;
    sideLP: BiquadFilterNode;
    sideWet: GainNode;
    sideDry: GainNode;
  } | null = null;
  // @ts-ignore — reserved for master ms stage
  private masterMs: {
    input: GainNode;
    output: GainNode;
    splitter: ChannelSplitterNode;
    merger: ChannelMergerNode;
    midGain: GainNode;
    sideGain: GainNode;
    sideInv: GainNode;
  } | null = null;

  /** Expose the master-stage handles the metering rig reads. */
  get stage(): MasterStage {
    return {
      limiter: this.masterLimiter,
      limiterWorklet: this.masterLimiterWorklet,
      glue: this.masterGlue,
      glueNative: this.masterGlueNative,
      kwMeter: this.kwMeter,
      rtMonitor: this.rtMonitor,
    };
  }

  /** Graph sink everything routes into (null until build()). */
  get input(): GainNode | null {
    return this.master;
  }

  /** Entry and exit of the user insert slot before the final safety stages. */
  get insertInput(): GainNode | null {
    return this.masterInsertInput;
  }

  get insertOutput(): GainNode | null {
    return this.masterInsertOutput;
  }

  bypassForOfflineRender(): void {
    const ctx = this.deps.ctx();
    if (!ctx || isLiveAudioContext(ctx)) {
      throw new Error("The master chain can only be bypassed for an offline render");
    }
    if (!this.master || !this.deps.metering.masterAnalyser)
      throw new Error("The offline master graph is not initialized");
    this.master.disconnect();
    this.master.connect(this.deps.metering.masterAnalyser);
  }

  /** Build (or rebuild) the whole master chain on the current context. */
  build(): void {
    const ctx = this.deps.ctx();
    if (!ctx) return;
    this.deps.metering.resetMeterHistory();
    // Disconnect old master chain if re-invoked (e.g. useContext with new context).
    this.deps.metering.disconnectMasterTaps();
    try {
      this.masterLimiter?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.masterClipper?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.masterInsertInput?.disconnect();
      this.masterInsertOutput?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.masterInsertInput = null;
    this.masterInsertOutput = null;
    try {
      this.master?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.masterLimiterWorklet?.dispose();
    this.masterLimiterWorklet = null;
    this.kwMeter?.dispose();
    this.kwMeter = null;
    this.rtMonitor?.dispose();
    this.rtMonitor = null;
    this.masterTape?.dispose();
    this.masterTape = null;
    try {
      this.masterDc?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.masterDc = null;
    try {
      this.masterTiltLow?.disconnect();
      this.masterTiltHigh?.disconnect();
    } catch {
      /* already disconnected */
    }
    for (const stage of this.masterMatchEqStages ?? []) {
      try {
        stage.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.masterMatchEqStages = null;
    this.masterTiltLow = null;
    this.masterTiltHigh = null;
    this.masterGlue?.dispose();
    this.masterGlue = null;
    this.masterGlueNative = null;
    try {
      this.masterBassMono?.sideLP.disconnect();
      this.masterBassMono?.sideWet.disconnect();
      this.masterBassMono?.sideDry.disconnect();
      this.masterBassMono?.input.disconnect();
      this.masterBassMono?.output.disconnect();
    } catch {
      /* already disconnected */
    }
    this.masterBassMono = null;
    if (this.masterMs) {
      try {
        this.masterMs.splitter.disconnect();
      } catch {}
      try {
        this.masterMs.merger.disconnect();
      } catch {}
      try {
        this.masterMs.midGain.disconnect();
      } catch {}
      try {
        this.masterMs.sideGain.disconnect();
      } catch {}
      try {
        this.masterMs.sideInv.disconnect();
      } catch {}
      try {
        this.masterMs.input.disconnect();
      } catch {}
      try {
        this.masterMs.output.disconnect();
      } catch {}
      this.masterMs = null;
    }
    // Bass Mono stage (M/S whose side passes a lowpass) — always in the
    // chain; applyMasterConfig() crossfades dry/wet side paths.
    {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const midL = ctx.createGain();
      const midR = ctx.createGain();
      const midSum = ctx.createGain();
      const sideL = ctx.createGain();
      const sideR = ctx.createGain();
      const sideSum = ctx.createGain();
      const sideLP = ctx.createBiquadFilter();
      sideLP.type = "lowpass";
      sideLP.frequency.value = 120;
      sideLP.Q.value = 0.707;
      const sideWet = ctx.createGain();
      const sideDry = ctx.createGain();
      sideWet.gain.value = 0;
      sideDry.gain.value = 1;
      const invR = ctx.createGain();
      invR.gain.value = -1;
      midL.gain.value = 0.5;
      midR.gain.value = 0.5;
      sideL.gain.value = 0.5;
      sideR.gain.value = -0.5;
      input.connect(splitter);
      splitter.connect(midL, 0);
      splitter.connect(midR, 1);
      splitter.connect(sideL, 0);
      splitter.connect(sideR, 1);
      // Decode with the shared M=(L+R)/2 signal on both channels. Sending
      // half of each original channel directly to its own output is not a
      // mid/side decode: with Bass Mono disabled it leaves a -6 dB,
      // polarity-inverted copy of a hard-panned signal on the other side.
      midL.connect(midSum);
      midR.connect(midSum);
      midSum.connect(merger, 0, 0);
      midSum.connect(merger, 0, 1);
      // Side: sum, then wet (lowpassed) + dry crossfade.
      sideL.connect(sideSum);
      // sideR already carries the required -0.5 encoding polarity. A second
      // inversion here turns (L-R)/2 into (L+R)/2 and makes the disabled
      // Bass Mono stage swap a hard-right signal to the left output.
      sideR.connect(sideSum);
      sideSum.connect(sideLP);
      sideSum.connect(sideDry);
      sideLP.connect(sideWet);
      const sideOut = ctx.createGain();
      sideWet.connect(sideOut);
      sideDry.connect(sideOut);
      // Decode: L += side, R -= side.
      sideOut.connect(merger, 0, 0);
      sideOut.connect(invR);
      invR.connect(merger, 0, 1);
      merger.connect(output);
      this.masterBassMono = { input, output, sideLP, sideWet, sideDry };
    }
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    // Master tape saturation (pre-limiter, post-gain)
    if (isWorkletReady("tapeSat", ctx)) {
      this.masterTape = createTapeNode(ctx, {
        params: { drive: 0.35, hysteresis: 0.3, tone: 6500, mix: 1, output: 0 },
      });
    } else {
      // Worklet-less: unity bypass (same policy as the tapeSat effect —
      // a plain-tanh stand-in would diverge from the hysteresis model in
      // both character AND aliasing, and a fake color is worse than none).
      const input = ctx.createGain();
      const output = ctx.createGain();
      input.connect(output);
      this.masterTape = {
        input,
        output,
        setParameter: () => {},
        setParameterAt: () => {},
        getAudioParam: () => null,
        dispose() {
          input.disconnect();
          output.disconnect();
        },
      };
    }
    // Master Mid/Side matrix (post-tape, pre-clipper) — unity when disabled
    {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const midGain = ctx.createGain();
      const sideGain = ctx.createGain();
      const sideInv = ctx.createGain();
      midGain.gain.value = 1;
      sideGain.gain.value = 1;
      sideInv.gain.value = -1;
      input.connect(splitter);
      // Encode: mid = 0.5*L + 0.5*R, side = 0.5*L -0.5*R
      const lToMid = ctx.createGain();
      const rToMid = ctx.createGain();
      const lToSide = ctx.createGain();
      const rToSide = ctx.createGain();
      lToMid.gain.value = 0.5;
      rToMid.gain.value = 0.5;
      lToSide.gain.value = 0.5;
      rToSide.gain.value = -0.5;
      splitter.connect(lToMid, 0);
      splitter.connect(rToMid, 1);
      splitter.connect(lToSide, 0);
      splitter.connect(rToSide, 1);
      lToMid.connect(midGain);
      rToMid.connect(midGain);
      lToSide.connect(sideGain);
      rToSide.connect(sideGain);
      // Decode: L = mid+side, R = mid-side. `sideInv` is THE single side
      // inversion — `sideToRInv` must stay unity or the two −1 gains cancel
      // and R receives +side (= mid+side = L), collapsing the master to mono
      // even with the M/S section disabled.
      const midToL = ctx.createGain();
      const sideToL = ctx.createGain();
      const midToR = ctx.createGain();
      const sideToRInv = ctx.createGain();
      midToL.gain.value = 1;
      sideToL.gain.value = 1;
      midToR.gain.value = 1;
      sideToRInv.gain.value = 1;
      midGain.connect(midToL);
      sideGain.connect(sideToL);
      midGain.connect(midToR);
      sideGain.connect(sideInv);
      sideInv.connect(sideToRInv);
      midToL.connect(merger, 0, 0);
      sideToL.connect(merger, 0, 0);
      midToR.connect(merger, 0, 1);
      sideToRInv.connect(merger, 0, 1);
      merger.connect(output);
      this.masterMs = { input, output, splitter, merger, midGain, sideGain, sideInv };
      // Keep helper gains for cleanup
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).lToMid = lToMid;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).rToMid = rToMid;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).lToSide = lToSide;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).rToSide = rToSide;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).midToL = midToL;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).sideToL = sideToL;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).midToR = midToR;
      (
        this.masterMs as unknown as {
          lToMid: GainNode;
          rToMid: GainNode;
          lToSide: GainNode;
          rToSide: GainNode;
          midToL: GainNode;
          sideToL: GainNode;
          midToR: GainNode;
          sideToRInv: GainNode;
        }
      ).sideToRInv = sideToRInv;
    }
    this.masterClipper = ctx.createWaveShaper();
    this.masterInsertInput = ctx.createGain();
    this.masterInsertOutput = ctx.createGain();
    this.masterClipper.oversample = "4x";
    this.masterClipper.curve = null;
    // Master DC blocker (fixed 12 Hz highpass, always on): asymmetric
    // saturation stages upstream (tube, tape, hot 808s) push DC that would
    // otherwise steal limiter headroom and pump the glue detector.
    this.masterDc = ctx.createBiquadFilter();
    this.masterDc.type = "highpass";
    this.masterDc.frequency.value = 12;
    this.masterDc.Q.value = 0.5;
    // MATCH EQ (reference tonal matching): four corrective stages mirroring
    // the rack EQ's band structure. Always wired; 0 dB config = transparent.
    const mkMatch = (type: BiquadFilterType, freq: number): BiquadFilterNode => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = 0.9; // bells only — shelves ignore Q
      f.gain.value = 0;
      return f;
    };
    this.masterMatchEqStages = [
      mkMatch("lowshelf", 180),
      mkMatch("peaking", 500),
      mkMatch("peaking", 2200),
      mkMatch("highshelf", 5200),
    ];
    // Master tonal tilt (genre color, mix-chain driven): complementary shelf
    // pair at ±tilt/2 so the spectral energy stays roughly constant. Always
    // wired; 0 dB config = transparent.
    this.masterTiltLow = ctx.createBiquadFilter();
    this.masterTiltLow.type = "lowshelf";
    this.masterTiltLow.frequency.value = 150;
    this.masterTiltLow.gain.value = 0;
    this.masterTiltHigh = ctx.createBiquadFilter();
    this.masterTiltHigh.type = "highshelf";
    this.masterTiltHigh.frequency.value = 5000;
    this.masterTiltHigh.gain.value = 0;
    // Master buss glue (gentle 2:1 RMS leveling, post-M/S pre-clipper).
    // Worklet compressor when DSP is ready; the native DCN mapping below is
    // the degraded fallback (same settings, coarse GR).
    if (isWorkletReady("compressor", ctx)) {
      this.masterGlueNative = null;
      this.masterGlue = createCompressorNode(ctx, {
        params: {
          threshold: -6,
          ratio: 2,
          attack: 0.03,
          release: 0.3,
          knee: 6,
          detector: 0,
          scHpf: 20,
          makeup: 0,
          mix: 1,
        },
      });
    } else {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -6;
      comp.knee.value = 6;
      comp.ratio.value = 2;
      comp.attack.value = 0.03;
      comp.release.value = 0.3;
      const input = ctx.createGain();
      const output = ctx.createGain();
      input.connect(comp).connect(output);
      const reduction = () => {
        const raw = (comp as unknown as { reduction?: number }).reduction;
        return Math.max(0, Number.isFinite(-(raw ?? 0)) ? -(raw as number) : 0);
      };
      this.masterGlueNative = comp;
      this.masterGlue = {
        input,
        output,
        degraded: true,
        degradedReason: "Master glue on native fallback",
        setParameter: () => undefined,
        setParameterAt: () => undefined,
        getGainReductionDb: reduction,
        dispose: () => {
          input.disconnect();
          comp.disconnect();
          output.disconnect();
        },
      };
    }
    this.masterLimiter = ctx.createDynamicsCompressor();
    // Prefer the look-ahead worklet limiter; applyMasterConfig() (right below)
    // then drives it and keeps the native node neutral while it is active.
    if (isWorkletReady("limiter", ctx)) this.attachMasterWorklet(ctx);
    this.applyMasterConfig(this.deps.doc()?.master ?? defaultMasterConfig());
    const masterAnalyser = ctx.createAnalyser();
    masterAnalyser.fftSize = 2048;
    masterAnalyser.channelCount = 2;
    masterAnalyser.channelCountMode = "explicit";
    this.master.connect(this.masterTape!.input);
    this.masterTape!.output.connect(this.masterMs!.input);
    this.masterMs!.output.connect(this.masterBassMono!.input);
    this.masterBassMono!.output.connect(this.masterDc!);
    // Match EQ sits BEFORE the tilt (correction first, taste last).
    this.masterDc!.connect(this.masterMatchEqStages![0]);
    this.masterMatchEqStages![0].connect(this.masterMatchEqStages![1]);
    this.masterMatchEqStages![1].connect(this.masterMatchEqStages![2]);
    this.masterMatchEqStages![2].connect(this.masterMatchEqStages![3]);
    this.masterMatchEqStages![3].connect(this.masterTiltLow!);
    this.masterTiltLow!.connect(this.masterTiltHigh!);
    this.masterTiltHigh!.connect(this.masterGlue!.input);
    this.masterGlue!.output.connect(this.masterInsertInput);
    this.masterInsertOutput!.connect(this.masterClipper);
    const attached = this.masterLimiterWorklet as EffectRuntime | null;
    if (attached) {
      this.masterClipper.connect(attached.input);
      attached.output.connect(this.masterLimiter);
    } else {
      this.masterClipper.connect(this.masterLimiter);
    }
    this.masterLimiter.connect(masterAnalyser);
    masterAnalyser.connect(ctx.destination);
    // Stereo tap: limiter → splitter → per-channel analysers (metering sinks).
    const masterSplitter = ctx.createChannelSplitter(2);
    const masterAnalyserL = ctx.createAnalyser();
    masterAnalyserL.fftSize = 2048;
    masterAnalyserL.channelCount = 1;
    masterAnalyserL.channelCountMode = "explicit";
    const masterAnalyserR = ctx.createAnalyser();
    masterAnalyserR.fftSize = 2048;
    masterAnalyserR.channelCount = 1;
    masterAnalyserR.channelCountMode = "explicit";
    this.masterLimiter.connect(masterSplitter);
    masterSplitter.connect(masterAnalyserL, 0);
    masterSplitter.connect(masterAnalyserR, 1);
    // Spectrogram tap: post-limiter sink (no output connection) — the same
    // observer pattern as the stereo tap above. 4096 gives ~10.7 Hz bin
    // spacing at 44.1 kHz so sub-bass rows stay readable on the log axis;
    // smoothing 0.55 trades a little smear for a flicker-free waterfall.
    const masterSpectrogramAnalyser = ctx.createAnalyser();
    masterSpectrogramAnalyser.fftSize = 4096;
    masterSpectrogramAnalyser.smoothingTimeConstant = 0.55;
    masterSpectrogramAnalyser.channelCount = 2;
    masterSpectrogramAnalyser.channelCountMode = "explicit";
    this.masterLimiter.connect(masterSpectrogramAnalyser);
    // Multi-resolution companions (same sink pattern): the long window
    // resolves sub-bass, the short one buys transient snap. Smoothing is
    // per band — lows steadier, highs snappier.
    const masterSpectrogramLow = ctx.createAnalyser();
    masterSpectrogramLow.fftSize = 8192;
    masterSpectrogramLow.smoothingTimeConstant = 0.6;
    masterSpectrogramLow.channelCount = 2;
    masterSpectrogramLow.channelCountMode = "explicit";
    this.masterLimiter.connect(masterSpectrogramLow);
    const masterSpectrogramHigh = ctx.createAnalyser();
    masterSpectrogramHigh.fftSize = 1024;
    masterSpectrogramHigh.smoothingTimeConstant = 0.35;
    masterSpectrogramHigh.channelCount = 2;
    masterSpectrogramHigh.channelCountMode = "explicit";
    this.masterLimiter.connect(masterSpectrogramHigh);
    // Mid/side spectrogram matrix off the existing stereo splitter:
    // mid = 0.5·(L+R), side = 0.5·(L−R). The ±0.5 gains sum inside one
    // merge node per branch; each feeds a mono sink analyser (no output).
    const msBranch = (sign: number) => {
      const gl = ctx.createGain();
      gl.gain.value = 0.5;
      const gr = ctx.createGain();
      gr.gain.value = 0.5 * sign;
      const merge = ctx.createGain();
      masterSplitter.connect(gl, 0);
      masterSplitter.connect(gr, 1);
      gl.connect(merge);
      gr.connect(merge);
      return merge;
    };
    const masterSpectrogramMid = ctx.createAnalyser();
    masterSpectrogramMid.fftSize = 4096;
    masterSpectrogramMid.smoothingTimeConstant = 0.55;
    masterSpectrogramMid.channelCount = 1;
    masterSpectrogramMid.channelCountMode = "explicit";
    msBranch(1).connect(masterSpectrogramMid);
    const masterSpectrogramSide = ctx.createAnalyser();
    masterSpectrogramSide.fftSize = 4096;
    masterSpectrogramSide.smoothingTimeConstant = 0.55;
    masterSpectrogramSide.channelCount = 1;
    masterSpectrogramSide.channelCountMode = "explicit";
    msBranch(-1).connect(masterSpectrogramSide);
    // Metering taps are OWNED by MeteringRig (Wave 4a) — creation and
    // graph shape stay here, storage and reads moved there.
    this.deps.metering.attachMasterTaps({
      analyser: masterAnalyser,
      splitter: masterSplitter,
      analyserL: masterAnalyserL,
      analyserR: masterAnalyserR,
      spectrogram: masterSpectrogramAnalyser,
      spectrogramLow: masterSpectrogramLow,
      spectrogramHigh: masterSpectrogramHigh,
      spectrogramMid: masterSpectrogramMid,
      spectrogramSide: masterSpectrogramSide,
    });
    // K-weighted loudness meter (BS.1770) — sink branch, no audio output.
    if (isWorkletReady("kwmeter", ctx)) this.attachKwMeter(ctx);
    // RT load / xrun probe — sink branch, no audio output (release-gate hardening).
    if (isWorkletReady("rtMonitor", ctx)) this.attachRtMonitor(ctx);
  }

  /** Create + arm the K-weighted loudness meter sink (idempotent). */
  attachKwMeter(ctx: BaseAudioContext): void {
    if (this.kwMeter || !this.masterLimiter || !isWorkletReady("kwmeter", ctx)) return;
    this.kwMeter = createKwMeterNode(ctx);
    this.masterLimiter.connect(this.kwMeter.input);
  }

  /** Create + arm the RT load probe sink (idempotent). */
  attachRtMonitor(ctx: BaseAudioContext): void {
    if (this.rtMonitor || !this.masterLimiter || !isWorkletReady("rtMonitor", ctx)) return;
    this.rtMonitor = createRtMonitorNode(ctx);
    this.masterLimiter.connect(this.rtMonitor.input);
  }

  /**
   * Splice the K-weight meter + RT monitor into an already-built live master
   * chain — called once AudioWorklet modules finish loading on a live context.
   */
  upgradeKwMeter(): void {
    const ctx = this.deps.ctx();
    if (!isLiveAudioContext(ctx)) return;
    if (this.kwMeter || !this.masterLimiter || !isWorkletReady("kwmeter", ctx)) return;
    this.attachKwMeter(ctx);
  }

  /** Splice the RT monitor into an already-built live master chain. */
  upgradeRtMonitor(): void {
    const ctx = this.deps.ctx();
    if (!isLiveAudioContext(ctx)) return;
    if (this.rtMonitor || !this.masterLimiter || !isWorkletReady("rtMonitor", ctx)) return;
    this.attachRtMonitor(ctx);
  }

  applyMasterConfig(config: MasterConfig): void {
    if (!this.master || !this.masterClipper || !this.masterLimiter) return;
    const ctx = this.deps.ctx();
    const now = ctx ? ctx.currentTime : 0;
    if (this.master) {
      // Genre loudness trim (song references) rides multiplicatively on the
      // input trim — pre-limiter by design, the limiter catches the extra
      // drive. Engine clamp ±12 dB is a defensive bound; the builder writes
      // at most ±6.
      // NaN-safe for the GAIN too (the trim below had this guard, the gain
      // line did not): Math.min/max pass NaN through, and
      // gain * 10**(NaN/20) would throw inside setTargetAtTime — the FIRST
      // statement of syncProject, killing the whole graph sync. Non-finite
      // falls back to the schema default (1).
      const gainRaw = config.masterGain;
      const gain = typeof gainRaw === "number" && Number.isFinite(gainRaw) ? Math.min(2, Math.max(0, gainRaw)) : 1;
      const trimRaw = config.loudnessTrimDb;
      const trim = typeof trimRaw === "number" && Number.isFinite(trimRaw) ? Math.min(12, Math.max(-12, trimRaw)) : 0;
      this.master.gain.setTargetAtTime(gain * Math.pow(10, trim / 20), now, 0.01);
    }
    if (this.masterTape) {
      const enabled = config.tapeEnabled ?? false;
      const drive = Math.min(1, Math.max(0, config.tapeDrive ?? 0.35));
      this.masterTape.setParameter("drive", enabled ? drive : 0);
      this.masterTape.setParameter("mix", enabled ? 1 : 0);
      this.masterTape.setParameter("hysteresis", enabled ? 0.3 : 0);
    }
    if (this.masterMs) {
      const enabled = config.msEnabled ?? false;
      // Clamp like normalizeProject (±6 dB): the collab/YDoc path can carry
      // hostile values straight into these AudioParams otherwise.
      const midDb = Math.min(6, Math.max(-6, config.msMidGain ?? 0));
      const sideDb = Math.min(6, Math.max(-6, config.msSideGain ?? 0));
      const midLin = enabled ? Math.pow(10, midDb / 20) : 1;
      const sideLin = enabled ? Math.pow(10, sideDb / 20) : 1;
      this.masterMs.midGain.gain.setTargetAtTime(midLin, now, 0.01);
      this.masterMs.sideGain.gain.setTargetAtTime(sideLin, now, 0.01);
    }
    if (this.masterBassMono) {
      const enabled = config.bassMonoEnabled ?? false;
      const freq = Math.min(400, Math.max(60, config.bassMonoFreq ?? 120));
      this.masterBassMono.sideLP.frequency.setTargetAtTime(freq, now, 0.02);
      this.masterBassMono.sideWet.gain.setTargetAtTime(enabled ? 1 : 0, now, 0.02);
      this.masterBassMono.sideDry.gain.setTargetAtTime(enabled ? 0 : 1, now, 0.02);
    }
    if (this.masterTiltLow && this.masterTiltHigh) {
      // Complementary shelves: positive tilt = dark (more low, less high).
      const tilt = Math.min(4, Math.max(-4, config.tiltDb ?? 0));
      this.masterTiltLow.gain.setTargetAtTime(tilt / 2, now, 0.05);
      this.masterTiltHigh.gain.setTargetAtTime(-tilt / 2, now, 0.05);
    }
    if (this.masterMatchEqStages) {
      // MATCH EQ: ±6 dB corrective gains, 0 = transparent (absent config
      // and garbage both land at 0 — the stage never blocks the master).
      const clamp6 = (v: unknown): number => {
        const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
        return Math.max(-6, Math.min(6, n));
      };
      const match = config.matchEq;
      const gains = [clamp6(match?.low), clamp6(match?.lowMid), clamp6(match?.highMid), clamp6(match?.high)];
      for (let i = 0; i < this.masterMatchEqStages.length; i++) {
        this.masterMatchEqStages[i].gain.setTargetAtTime(gains[i], now, 0.05);
      }
    }
    if (this.masterGlue) {
      // Buss glue: mix 1/0 on the worklet path (threshold/ratio stay put so
      // re-enabling never re-tunes); the native fallback has no mix stage,
      // so it parks at threshold 0 / ratio 1 like the disabled limiter below.
      const enabled = config.glueEnabled ?? true;
      if (this.masterGlueNative) {
        this.masterGlueNative.threshold.setTargetAtTime(enabled ? -6 : 0, now, 0.02);
        this.masterGlueNative.ratio.setTargetAtTime(enabled ? 2 : 1, now, 0.02);
      } else {
        this.masterGlue.setParameter("mix", enabled ? 1 : 0);
      }
    }
    if (config.clipperEnabled) {
      // The curve depends only on constants (fixed −0.3 dB ceiling) — build
      // it once. Rebuilding 2048 tanh samples + re-ingesting the WaveShaper
      // curve on every commit (and every master-fader preview frame) was
      // pure per-gesture waste.
      if (!this.masterClipperCurve) {
        const n = 2048;
        const curve = new Float32Array(new ArrayBuffer(n * 4));
        const ceilingLin = Math.pow(10, -0.3 / 20);
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * 2 - 1;
          curve[i] = (ceilingLin * Math.tanh(x * 3)) / Math.tanh(3);
        }
        this.masterClipperCurve = curve;
      }
      // Re-assign only when the node does not already carry it (the node is
      // rebuilt on context swaps; the cached array survives).
      if (this.masterClipper.curve !== this.masterClipperCurve) {
        this.masterClipper.curve = this.masterClipperCurve;
      }
    } else if (this.masterClipper.curve !== null) {
      this.masterClipper.curve = null;
    }
    // DynamicsCompressorNode.threshold is expressed in dBFS, not linear
    // amplitude. Passing pow(10, dB / 20) here coerced every negative ceiling
    // into a positive value, which browsers clamp to 0 dB and repeatedly warn
    // about during graph sync. Keep the native fallback honest and quiet.
    const ceilingDb = Math.min(0, Math.max(-12, config.ceilingDb));
    const worklet = this.masterLimiterWorklet;
    if (worklet) {
      // The look-ahead worklet drives limiting; the native node is held at a
      // neutral pass-through so the post-native metering tap measures the
      // true final signal. Master settings: threshold rides the ceiling
      // (soft-knee onset right where peaks must stop) with musical defaults.
      const ceilingParam = Math.min(0, Math.max(-12, config.ceilingDb));
      worklet.setParameter("ceiling", ceilingParam);
      worklet.setParameter("threshold", ceilingParam);
      worklet.setParameter("release", 0.12);
      worklet.setParameter("lookaheadMs", 5);
      worklet.setParameter("link", 1);
      worklet.setParameter("mix", config.limiterEnabled ? 1 : 0);
      this.masterLimiter.threshold.value = 0;
      this.masterLimiter.knee.value = 0;
      this.masterLimiter.ratio.value = 1;
      this.masterLimiter.attack.value = 0.001;
      this.masterLimiter.release.value = 0.01;
    } else if (config.limiterEnabled) {
      this.masterLimiter.threshold.value = ceilingDb;
      this.masterLimiter.knee.value = 0;
      this.masterLimiter.ratio.value = 20;
      this.masterLimiter.attack.value = 0.002;
      this.masterLimiter.release.value = 0.1;
    } else {
      this.masterLimiter.threshold.value = 0;
      this.masterLimiter.knee.value = 0;
      this.masterLimiter.ratio.value = 1;
      this.masterLimiter.attack.value = 0.001;
      this.masterLimiter.release.value = 0.01;
    }
  }

  /** Create + arm the look-ahead master limiter runtime (idempotent). */
  attachMasterWorklet(ctx: BaseAudioContext): void {
    if (this.masterLimiterWorklet || !isWorkletReady("limiter", ctx)) return;
    this.masterLimiterWorklet = createLimiterNode(ctx, { params: {} });
  }

  /**
   * Splice the look-ahead limiter into an ALREADY-BUILT live master chain —
   * used once AudioWorklet modules finish loading on a context that started
   * rendering before they were ready. Never touches OfflineAudioContexts:
   * mutating their graph mid-render is undefined behavior.
   */
  upgradeMasterDynamics(): void {
    const ctx = this.deps.ctx();
    if (!isLiveAudioContext(ctx)) return;
    if (!this.master || !this.masterClipper || !this.masterLimiter) return;
    if (isWorkletReady("limiter", ctx)) this.attachMasterWorklet(ctx);
    const attached = this.masterLimiterWorklet;
    if (!attached) return;
    try {
      this.masterClipper.disconnect();
    } catch {
      /* already disconnected */
    }
    this.masterClipper.connect(attached.input);
    attached.output.connect(this.masterLimiter);
    this.applyMasterConfig(this.deps.doc()?.master ?? defaultMasterConfig());
  }
}

/** Re-exported for the facade's helper imports. */
export { defaultMasterConfig };
