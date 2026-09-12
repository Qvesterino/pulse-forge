/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a semantics-faithful copy of the upstream DSP oracle (line endings are
 * normalized) so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Top-level Processor (TS oracle)
//
// Implements the full signal flow:
//
//   Input (L,R)
//     → Input Gain
//     → DC-Block HP (15 Hz)
//     → Pre-Delay (with tempo sync)
//     → Smoother (transient shaper)
//     → Pre EQ (3-band) + spectrum analyzer tap
//     → Blend Pad distribution → [E1 Reflections, E2 Plate/Chamber, E3 Hall]
//     → Σ  (sum blended engines)
//     → Reverb EQ (3-band) on the wet bus + dry/wet analyzer taps
//     → Mod Pad (RandomFat or Pitch)
//     → Dry/Wet + Level + Output Gain
//     → Output (L,R)
//
// Process() is the realtime entry. Set the full OzvenaStateV1 via
// `loadState()` (or individual sections via `setGlobal / setEngines …`).
// `prepare()` allocates all buffers; `reset()` clears state.
// ═══════════════════════════════════════════════════════════

import type { OzvenaStateV1 } from "../v2/types.js";
import { clamp, dbToLinear, sanitize } from "../dsp/math.js";
import { createDcBlocker, type DcBlocker } from "../dsp/biquad.js";
import { createSpectrumAnalyzer, type SpectrumAnalyzer } from "../dsp/spectrumAnalyzer.js";
import { pickOversampleFactor, pickQualityTier } from "../dsp/oversampler.js";
import { createPreDelay, type PreDelay } from "../modules/preDelay.js";
import { createSmoother, type Smoother } from "../modules/smoother.js";
import { createPreEq, type PreEq, type AutoCutDetails } from "../modules/preEq.js";
import { createReverbEq, type ReverbEq, type UnmaskDetails } from "../modules/reverbEq.js";
import { createModPad, type ModPad } from "../modules/modPad.js";
import { createMaskingMeter, type MaskingMeter } from "../modules/maskingMeter.js";
import { generateFactoryIr, generateFactoryIr4 } from "../modules/factoryIr.js";
import { createSafetyLimiter, type SafetyLimiter } from "../modules/safetyLimiter.js";
import {
  createReflectionsEngine,
  type ReflectionsEngine,
} from "../engines/reflectionsEngine.js";
import {
  createPlateChamberEngine,
  type PlateChamberEngine,
} from "../engines/plateChamberEngine.js";
import { createHallEngine, type HallEngine } from "../engines/hallEngine.js";
import {
  createConvolutionEngine,
  type ConvolutionEngine,
} from "../engines/convolutionEngine.js";
import {
  computeBlendPadMixInto,
  distributeToEnginesInto,
  type BlendPadMix,
} from "./blendPad.js";
import {
  createDuckController,
  type DuckController,
  type DuckControllerParams,
} from "./duckController.js";
import {
  createOzvenaIpc,
  type OzvenaIpc,
  type PeerNotification,
} from "../v2/vocalForgeIpc.js";
import type { PrecomputedIrSet } from "../dsp/fftPartitioned.js";

/**
 * Result of a factory-IR lookup requested by the processor:
 *  - a ready interleaved payload (`channels` 1/2/4), or its PRECOMPUTED
 *    frequency-domain form (per-convolver slot sets — see
 *    fftPartitioned.precomputeConvolverSpectra; the audio-thread-free
 *    variant), 
 *  - "pending" — generation is in flight elsewhere; keep the current IR,
 *  - null — unknown id; clear the convolution.
 */
export type FactoryIrLookup =
  | { samples: Float32Array; channels: 1 | 2 | 4 }
  | { precomputed: PrecomputedIrSet[]; channels: 1 | 2 | 4 }
  | "pending"
  | null;

export type FactoryIrProvider = (
  irId: string,
  sampleRate: number,
  stereo: boolean,
) => FactoryIrLookup;

export interface OzvenaProcessor {
  prepare(sampleRate: number, channelCount: number, bpm: number, maxBlockSize: number): void;
  process(channels: Float32Array[], frameCount: number): void;
  loadState(state: OzvenaStateV1): void;
  /** Live tempo update — recomputes tempo-synced delays without a re-prepare. */
  setBpm(bpm: number): void;
  reset(): void;
  dispose(): void;
  getLatencySamples(): number;
  getTailSamples(): number;
  /**
   * Load a USER impulse response (interleaved, `channels` 1/2/4) already
   * resampled to the host rate. Replaces the factory IR until the
   * convolution selection changes.
   */
  loadUserIr(samples: Float32Array, channels: 1 | 2 | 4): void;
  /** Remove a user IR (falls back to the factory selection). */
  clearUserIr(): void;
  /**
   * Load a user IR from PRECOMPUTED frequency-domain partition sets (the
   * FFT batch ran off the audio thread; see
   * fftPartitioned.precomputeConvolverSpectra). Marks the current
   * convolution selection as satisfied exactly like loadUserIr.
   * (Reconciled from Pulse Forge, 2026-09-09.)
   */
  loadPrecomputedIr(sets: PrecomputedIrSet[], channels: 1 | 2 | 4): void;
  getSpectrumAnalyzer(): SpectrumAnalyzer;
  /**
   * Install a factory-IR acquisition hook (null restores the default
   * inline generation). The provider is called from syncConvolutionIr when
   * the selection wants a factory IR that is not already loaded:
   *   - `{ samples, channels }` → loaded synchronously (caller-owned shape;
   *     for stereo buses pass the interleaved 1/2/4-channel payload).
   *   - "pending" → the CURRENT IR keeps playing; the host delivers the
   *     payload later via loadUserIr() (which re-marks the selection).
   *   - null → unknown id: the convolution is cleared.
   * Hosts that must keep the audio thread light generate off-thread and
   * return "pending". (Reconciled from Pulse Forge, 2026-09-08.)
   */
  setFactoryIrProvider(provider: FactoryIrProvider | null): void;
  /** Load a user IR (interleaved, resampled to the host rate). */
  loadUserIr(samples: Float32Array, channels: 1 | 2 | 4): void;
  /** Drop the user IR and fall back to the factory selection. */
  clearUserIr(): void;
  runAutoCut(): [number, number, number] | null;
  runUnmask(): [number, number, number] | null;
  runAutoCutDetailed(): AutoCutDetails | null;
  runUnmaskDetailed(): UnmaskDetails | null;
  runMaskingSnapshot(sampleRate: number, grid: Float32Array): ReturnType<MaskingMeter["snapshot"]>;
  /**
   * Gate every internal spectrum-analyzer tap (processor input/dry/wet/
   * output, Pre EQ, Reverb EQ, Masking Meter). Hosts that consume none of
   * them skip nine per-block ring writes; Auto Cut / Unmask / masking
   * snapshots read stale data until re-enabled. Default: enabled.
   * (Reconciled from Pulse Forge, 2026-09-05.)
   */
  setAnalyzersEnabled(on: boolean): void;
  /** Roadmap O7: true when a convolution IR is currently loaded. */
  isIrLoaded(): boolean;
  /** Channel count of the loaded IR (1/2/4), 0 when empty. */
  getIrChannels(): 1 | 2 | 4 | 0;
}

export function createOzvenaProcessor(): OzvenaProcessor {
  let sampleRate = 44100;
  let channelCount = 2;
  let bpm = 120;
  let prepared = false;

  let state: OzvenaStateV1 | null = null;

  // Recreated in doPrepare() with the ACTUAL sample rate — the original
  // hard-coded 44.1 kHz coefficients detuned the 15 Hz corner at 48/96 kHz
  // and diverged from the native processor's DcBlocker(sampleRate, 15).
  // ONE BLOCKER PER CHANNEL: a shared blocker applied L-then-R per block
  // lets each channel's state be kicked by the other channel a different
  // number of times depending on the host block size — the output became
  // block-size-dependent (and L/R subtly coupled). Mirrors the native fix.
  let dcBlocks: [DcBlocker, DcBlocker] = [
    createDcBlocker(44100, 15),
    createDcBlocker(44100, 15),
  ];
  const preDelay: PreDelay = createPreDelay();
  const smoother: Smoother = createSmoother();
  const preEq: PreEq = createPreEq();
  const reverbEq: ReverbEq = createReverbEq();
  const modPad: ModPad = createModPad();
  const maskingMeter: MaskingMeter = createMaskingMeter();
  const reflections: ReflectionsEngine = createReflectionsEngine();
  const plateChamber: PlateChamberEngine = createPlateChamberEngine();
  const hall: HallEngine = createHallEngine();
  const convolution: ConvolutionEngine = createConvolutionEngine();
  const safetyLimiter: SafetyLimiter = createSafetyLimiter();
  // Auto-duck controller. Watches peer level notifications via the
  // VocalForge IPC bridge and applies a smoothed gain reduction to
  // the wet bus when masking energy is detected.
  const duckController: DuckController = createDuckController();
  const ipc: OzvenaIpc = createOzvenaIpc();
  // Phase P: persistent Blend Pad mix scratch — zero allocation per block.
  const blendMixScratch: BlendPadMix = { weights: { e1: 0, e2: 0, e3: 0 }, wetGain: 1 };
  let duckInstanceId: number | null = null;
  let duckSubscription: (() => void) | null = null;
  let lastDuckGain = 1.0;
  let lastFreeze: boolean | null = null;
  let gateGain = 1.0;
  let limiterQuality: string = "standard";
  let lastQualityTier = 1;
  let preparedMaxBs = 2048;

  let analyzer: SpectrumAnalyzer = createSpectrumAnalyzer({ fftSize: 2048 });
  // Master gate for every internal analyzer tap. Default enabled (upstream
  // behaviour); hosts without spectrum/AutoCut/Unmask UI turn it off —
  // see setAnalyzersEnabled below.
  let analyzersEnabled = true;

  // Tracks which factory IR is currently loaded into the convolution
  // engine so we only regenerate when the selection or rate changes.
  let loadedIrId: string | null = null;
  let loadedIrRate = 0;
  // When a user IR is loaded it takes precedence over the factory
  // selection; any factory irId change clears it.
  let userIrActive = false;

  // Factory-IR acquisition hook. Default: generate inline (the historical
  // behaviour every host got before the hook existed — including the
  // VocalForge native port). Audio-thread-conscious hosts install a
  // provider that returns "pending" and deliver the payload through
  // loadUserIr() once their off-thread generation completes.
  // (Reconciled from Pulse Forge, 2026-09-08.)
  let factoryIrProvider: FactoryIrProvider | null = null;

  /** Historical inline factory-IR generation (exact pre-hook behaviour). */
  function defaultFactoryIrLookup(irId: string, sr: number, stereo: boolean): FactoryIrLookup {
    // TRUE-STEREO factory IRs: 4-channel decorrelated (LL, LR, RL, RR).
    const quad = generateFactoryIr4(irId, sr);
    if (quad) {
      if (stereo) return { samples: quad, channels: 4 };
      // Mono bus: first channel only.
      return { samples: quad.subarray(0, quad.length / 4), channels: 1 };
    }
    const mono = generateFactoryIr(irId, sr);
    if (!mono) return null;
    // The convolution engine expects interleaved stereo when processing
    // stereo — broadcast the mono IR.
    if (stereo) {
      const stereoIr = new Float32Array(mono.length * 2);
      for (let i = 0; i < mono.length; i++) {
        stereoIr[2 * i] = mono[i];
        stereoIr[2 * i + 1] = mono[i];
      }
      return { samples: stereoIr, channels: 2 };
    }
    return { samples: mono, channels: 1 };
  }

  /** (Re)load the factory IR selected in state into the convolution engine. */
  function syncConvolutionIr(): void {
    if (!state) return;
    const irId = state.convolution?.irId ?? null;
    if (irId === null || irId === "none") {
      convolution.clearIr();
      loadedIrId = null;
      loadedIrRate = 0;
      userIrActive = false;
      return;
    }
    if (userIrActive && irId === loadedIrId && sampleRate === loadedIrRate && convolution.isIrLoaded()) {
      return; // keep the user IR while the selection still points at it
    }
    if (irId === loadedIrId && sampleRate === loadedIrRate && convolution.isIrLoaded()) {
      return;
    }
    userIrActive = false;
    const lookup = factoryIrProvider ?? defaultFactoryIrLookup;
    const res = lookup(irId, sampleRate, channelCount >= 2);
    if (res === null) {
      // Unknown/removed factory IDs must not leave the previous IR active.
      convolution.clearIr();
      loadedIrId = null;
      loadedIrRate = 0;
      return;
    }
    if (res === "pending") {
      // Off-thread generation in flight: keep the current IR audible; the
      // host delivers the payload via loadUserIr() (which re-marks this
      // selection as loaded) when it lands. A later sync while still
      // pending simply asks again — providers dedupe their requests.
      return;
    }
    if ("precomputed" in res && res.precomputed) {
      // Frequency-domain payload — the FFT batch already ran off-thread.
      convolution.loadIrPrecomputed(res.precomputed, res.channels);
    } else {
      convolution.loadIr(res.samples, sampleRate, res.channels);
    }
    loadedIrId = irId;
    loadedIrRate = sampleRate;
  }

  function loadUserIr(samples: Float32Array, channels: 1 | 2 | 4): void {
    if (!prepared || samples.length === 0) return;
    convolution.loadIr(samples, sampleRate, channels);
    userIrActive = true;
    loadedIrId = state?.convolution?.irId ?? null;
    loadedIrRate = sampleRate;
  }

  /** Precomputed-spectra twin of loadUserIr — the FFT batch already ran
   *  off the audio thread. (Reconciled from Pulse Forge, 2026-09-09.) */
  function loadPrecomputedIr(sets: PrecomputedIrSet[], channels: 1 | 2 | 4): void {
    if (!prepared || sets.length === 0) return;
    convolution.loadIrPrecomputed(sets, channels);
    userIrActive = true;
    loadedIrId = state?.convolution?.irId ?? null;
    loadedIrRate = sampleRate;
  }

  function clearUserIr(): void {
    userIrActive = false;
    syncConvolutionIr();
  }

  /** Subscribe to the global peer registry and push notifications
   *  into the duckController. Idempotent — re-subscribing replaces
   *  the previous subscription so the active listener count is 1. */
  function setupIpc(): void {
    if (duckSubscription) return;
    if (duckInstanceId === null) {
      duckInstanceId = ipc.register("Ozvena", sampleRate, 0, channelCount);
    }
    duckSubscription = ipc.subscribe((n: PeerNotification) => {
      duckController.processNotification(n);
    });
  }

  // Pre-allocated scratch buffers.
  // finalDry is the signal used by the final global dry/wet mix: after input
  // gain, before the reverb processing graph.
  let finalDry: Float32Array[] = [];
  // engineDry is the exact signal presented to the engine blend, before each
  // engine adds its wet contribution. It must not be confused with finalDry.
  let engineDry: Float32Array[] = [];
  let engineIn: { e1: Float32Array[]; e2: Float32Array[]; e3: Float32Array[] } = {
    e1: [], e2: [], e3: [],
  };
  let wetPreEq: Float32Array[] = [];
  // E1 wet (recovered) for ER→Late injection.
  let erWet: Float32Array[] = [];

  function ensureScratch(frameCount: number): void {
    if (finalDry.length < channelCount || finalDry[0]?.length < frameCount) {
      finalDry = [];
      for (let c = 0; c < channelCount; c++) {
        finalDry.push(new Float32Array(frameCount));
      }
    }
    const make = (): Float32Array[] => {
      const out: Float32Array[] = [];
      for (let c = 0; c < channelCount; c++) out.push(new Float32Array(frameCount));
      return out;
    };
    if (
      engineIn.e1.length < channelCount ||
      engineIn.e1[0]?.length < frameCount
    ) {
      engineIn = { e1: make(), e2: make(), e3: make() };
      engineDry = make();
      erWet = make();
    }
    if (engineDry.length < channelCount || engineDry[0]?.length < frameCount) {
      engineDry = make();
      erWet = make();
    }
    if (wetPreEq.length < channelCount || wetPreEq[0]?.length < frameCount) {
      wetPreEq = make();
    }
    if (erWet.length < channelCount || erWet[0]?.length < frameCount) {
      erWet = make();
    }
  }

  /** The state object whose values were last pushed to the modules.
   *  Sections are treated as immutable (the whole codebase updates state
   *  via immutable spreads), so a section reference that did NOT change
   *  means the module's params did not change either — and its
   *  setParams() (which re-computes coefficients and engine layouts)
   *  can be skipped. This is what keeps a single-automation-parameter
   *  update from reconfiguring the entire graph. */
  let pushedState: OzvenaStateV1 | null = null;

  function pushStateToModules(): void {
    if (!state) return;
    const prev = pushedState;
    if (prev === state) return;
    pushedState = state;

    if (!prev || state.preDelay !== prev.preDelay) {
      preDelay.setParams({
        enabled: state.preDelay.enabled,
        ms: state.preDelay.ms,
        syncEnabled: state.preDelay.syncEnabled,
        syncNote: state.preDelay.syncNote,
      });
    }
    if (!prev || state.smoother !== prev.smoother) {
      smoother.setParams({ enabled: state.smoother.enabled, amount: state.smoother.amount });
    }
    if (!prev || state.preEq !== prev.preEq) {
      preEq.setParams({
        enabled: state.preEq.enabled,
        band1: state.preEq.band1,
        band2: state.preEq.band2,
        band3: state.preEq.band3,
      });
      preEq.setAutoCutEnabled(state.preEq.autoCut.enabled);
      preEq.setAutoCutAmount(state.preEq.autoCut.amount);
    }
    if (!prev || state.reverbEq !== prev.reverbEq) {
      reverbEq.setParams({
        enabled: state.reverbEq.enabled,
        band1: state.reverbEq.band1,
        band2: state.reverbEq.band2,
        band3: state.reverbEq.band3,
      });
      reverbEq.setUnmaskEnabled(state.reverbEq.unmask.enabled);
      reverbEq.setUnmaskAmount(state.reverbEq.unmask.amount);
    }
    const modChanged = !prev || state.mod !== prev.mod;
    if (modChanged) {
      modPad.setParams({
        enabled: state.mod.enabled,
        mode: state.mod.mode,
        depthX: state.mod.depthX,
        rateY: state.mod.rateY,
      });
    }
    if (!prev || state.engines.e1 !== prev.engines.e1) {
      reflections.setParams(state.engines.e1);
    }
    if (!prev || state.engines.e2 !== prev.engines.e2) {
      plateChamber.setParams(state.engines.e2);
    }
    if (!prev || state.engines.e3 !== prev.engines.e3) {
      hall.setParams(state.engines.e3);
    }
    // Roadmap O6: per-engine modulation-rate multiplier (additive state,
    // default 1 = the engine's ALGO_TUNING rate untouched). Engine changes
    // must re-push modulation too (the multiplier lives in the engine state).
    const enginesChanged =
      !prev || state.engines.e2 !== prev.engines.e2 || state.engines.e3 !== prev.engines.e3;
    if (modChanged || enginesChanged) {
      // Scalar-only — cheap, and must follow modPad.setParams. A disabled
      // Mod Pad must zero the engine modulation entirely: fractional LFO
      // reads add smear (and libm sin() rounding drift vs the native
      // port) the user never asked for.
      const mod = state.mod.enabled
        ? modPad.getModParams()
        : { rateHz: 0, depthSamples: 0 };
      // Roadmap O6: caller-declared depth ceiling (additive state field,
      // default 20 = historical engine clamp).
      const maxDepth = state.mod?.maxDepthSamples ?? 20;
      plateChamber.setModulation(
        mod.rateHz * (state.engines.e2.modRateMult ?? 1),
        mod.depthSamples,
        maxDepth,
      );
      hall.setModulation(
        mod.rateHz * (state.engines.e3.modRateMult ?? 1),
        mod.depthSamples,
        maxDepth,
      );
    }
    if (!prev || state.convolution !== prev.convolution) {
      convolution.setParams({
        enabled: state.convolution?.mode !== "algorithmic",
        mix: state.convolution?.wet ?? 100,
      });
      // Cached by (irId, sampleRate) internally — allocates only when the
      // selection or rate actually changed.
      syncConvolutionIr();
    }

    // Duck controller (auto-duck). Only set enabled/threshold/etc.
    // when the underlying object is present (legacy states without
    // a duck block fall back to defaults via defaultDuck()).
    if (!prev || state.duck !== prev.duck) {
      duckController.setParams({
        enabled: state.duck.enabled,
        thresholdDb: state.duck.thresholdDb,
        sensitivity: state.duck.sensitivity,
        attackMs: state.duck.attackMs,
        releaseMs: state.duck.releaseMs,
      } satisfies DuckControllerParams);
    }

    // Quality mode drives the safety limiter's oversampling factor.
    // Scalar-only switch — all factor states are preallocated in the
    // limiter's prepare(); the old path called safetyLimiter.prepare()
    // here, allocating and zeroing the rings ON THE AUDIO THREAD on every
    // quality change (dropout risk mid-render, envelope-reset click).
    // (Reconciled from Pulse Forge, 2026-09-05.)
    const q = state.global.quality;
    if (prepared && q !== limiterQuality) {
      limiterQuality = q;
      safetyLimiter.setOversampleFactor(pickOversampleFactor(q));
    }

    // Quality also scales the FDN shimmer cost (window size, grain count).
    // Scalar-only on the engines — no realloc, no click.
    const tier = pickQualityTier(q);
    if (prepared && tier !== lastQualityTier) {
      lastQualityTier = tier;
      plateChamber.setQuality(tier);
      hall.setQuality(tier);
    }

    // Freeze routes to the FDN engines (E1 taps decay naturally).
    if (state.global.freeze !== lastFreeze) {
      lastFreeze = state.global.freeze;
      plateChamber.setFreeze(lastFreeze);
      hall.setFreeze(lastFreeze);
    }
  }

  function doPrepare(sr: number, cc: number, hostBpm: number, maxBlockSize: number): void {
      sampleRate = clamp(sr, 8000, 192000);
      channelCount = Math.max(1, cc);
      bpm = clamp(hostBpm, 20, 300);
      preparedMaxBs = Math.max(64, maxBlockSize);
      dcBlocks = [createDcBlocker(sampleRate, 15), createDcBlocker(sampleRate, 15)];
      dcBlocks[0].reset();
      dcBlocks[1].reset();
      preDelay.prepare(sampleRate, channelCount, bpm);
      smoother.prepare(sampleRate);
      preEq.prepare(sampleRate, channelCount);
      reverbEq.prepare(sampleRate, channelCount);
      modPad.prepare(sampleRate);
      maskingMeter.prepare(sampleRate, channelCount);
      reflections.prepare(sampleRate, channelCount);
      plateChamber.prepare(sampleRate, channelCount);
      hall.prepare(sampleRate, channelCount);
      convolution.prepare(sampleRate, channelCount, preparedMaxBs);
      limiterQuality = state?.global.quality ?? "standard";
      safetyLimiter.prepare(sampleRate, channelCount, preparedMaxBs, pickOversampleFactor(limiterQuality as "eco" | "standard" | "high" | "render"));
      const q0 = limiterQuality as "eco" | "standard" | "high" | "render";
      lastQualityTier = pickQualityTier(q0);
      plateChamber.setQuality(lastQualityTier);
      hall.setQuality(lastQualityTier);
      analyzer = createSpectrumAnalyzer({ fftSize: 2048 });
      analyzer.setEnabled(analyzersEnabled);
      ensureScratch(2048);
      // Force a full module re-push: prepare() may have changed the sample
      // rate or block size even though the state object stayed identical.
      pushedState = null;
      pushStateToModules();
      setupIpc();
      prepared = true;
  }

  return {
    prepare(sr, cc, hostBpm, maxBlockSize) {
      sampleRate = clamp(sr, 8000, 192000);
      channelCount = Math.max(1, cc);
      bpm = clamp(hostBpm, 20, 300);
      preparedMaxBs = Math.max(64, maxBlockSize);
      dcBlocks = [createDcBlocker(sampleRate, 15), createDcBlocker(sampleRate, 15)];
      dcBlocks[0].reset();
      dcBlocks[1].reset();
      preDelay.prepare(sampleRate, channelCount, bpm);
      smoother.prepare(sampleRate);
      preEq.prepare(sampleRate, channelCount);
      reverbEq.prepare(sampleRate, channelCount);
      modPad.prepare(sampleRate);
      maskingMeter.prepare(sampleRate, channelCount);
      reflections.prepare(sampleRate, channelCount);
      plateChamber.prepare(sampleRate, channelCount);
      hall.prepare(sampleRate, channelCount);
      convolution.prepare(sampleRate, channelCount, preparedMaxBs);
      limiterQuality = state?.global.quality ?? "standard";
      safetyLimiter.prepare(sampleRate, channelCount, preparedMaxBs, pickOversampleFactor(limiterQuality as "eco" | "standard" | "high" | "render"));
      const q0 = limiterQuality as "eco" | "standard" | "high" | "render";
      lastQualityTier = pickQualityTier(q0);
      plateChamber.setQuality(lastQualityTier);
      hall.setQuality(lastQualityTier);
      analyzer = createSpectrumAnalyzer({ fftSize: 2048 });
      analyzer.setEnabled(analyzersEnabled);
      ensureScratch(2048);
      // Force a full module re-push: prepare() may have changed the sample
      // rate or block size even though the state object stayed identical.
      pushedState = null;
      pushStateToModules();
      setupIpc();
      prepared = true;
    },

    loadState(s) {
      state = s;
      if (prepared) pushStateToModules();
    },

    setBpm(hostBpm) {
      bpm = clamp(hostBpm, 20, 300);
      preDelay.setBpm(bpm);
    },

    process(channels, frameCount) {
      if (!state || !prepared || frameCount <= 0) return;
      ensureScratch(frameCount);
      const cc = Math.min(channelCount, channels.length);

      // Bypass: pass-through unchanged. Cosine-law crossfade is the
      // production behaviour (see vst3Contracts); for the oracle we use
      // a hard bypass which the host applies an equivalent crossfade to.
      if (state.global.bypass) {
        // Already in place — no work.
        // Push to analyser for UI visibility (optional).
        analyzer.push("input", channels, frameCount);
        return;
      }

      // Sanitize non-finite input samples first: NaN/Inf must never
      // reach the feedback loops (delay lines, filter states), or they
      // will ring forever inside the engines.
      for (let c = 0; c < cc; c++) {
        const buf = channels[c];
        for (let i = 0; i < frameCount; i++) {
          if (!Number.isFinite(buf[i])) buf[i] = 0;
        }
      }

      // 1. Input gain. Clamped to the documented range (-24..+24 dB) like
      // every engine-side param — dbToLinear(1e9) is Infinity and would
      // blow the output stage past float32 (input-side sanitize cannot
      // rescue a gain applied to the WHOLE signal).
      const inGain = dbToLinear(clamp(state.global.inputGainDb, -24, 24));
      for (let c = 0; c < cc; c++) {
        const buf = channels[c];
        for (let i = 0; i < frameCount; i++) buf[i] *= inGain;
      }

      // Snapshot final dry for the spectrum analyzer and final global mix.
      // This is intentionally captured AFTER input gain, but before the
      // reverb processing graph. It is not the reference used to undo an
      // engine's embedded dry component.
      // inGain introduced non-finite values (defensive — dbToLinear is
      // safe for finite dB, but a NaN input ⇒ NaN output ⇒ engine poll).
      for (let c = 0; c < cc; c++) {
        const buf = channels[c];
        const dry = finalDry[c];
        for (let i = 0; i < frameCount; i++) {
          const v = buf[i];
          dry[i] = Number.isFinite(v) ? v : 0;
        }
      }
      analyzer.push("input", finalDry, frameCount);
      analyzer.push("dry", finalDry, frameCount);

      // 2. DC-block per channel (scalar; called per-sample).
      for (let c = 0; c < cc; c++) {
        const buf = channels[c];
        for (let i = 0; i < frameCount; i++) {
          buf[i] = sanitize(dcBlocks[c].process(buf[i]));
        }
      }

      // 3. Pre-Delay.
      preDelay.process(channels, frameCount);

      // 4. Smoother (transient shaper — modifies in place).
      smoother.process(channels, frameCount);

      // 5. Pre EQ (operates on the signal; pushes to analyzer).
      preEq.process(channels, frameCount);

      // Capture the exact signal entering the engine blend. Engine dry
      // compensation must use this post-pre-EQ reference, not finalDry.
      for (let c = 0; c < cc; c++) {
        for (let i = 0; i < frameCount; i++) {
          engineDry[c][i] = sanitize(channels[c][i]);
        }
      }

      // 6. Distribute to engines via the Blend Pad. Writes into the
      // pre-allocated engineIn scratch — no allocation in the audio path
      // (Phase P: the mix weights land in a persistent scratch object
      // instead of two fresh objects per block).
      computeBlendPadMixInto(
        state.blendPad,
        {
          e1: state.engines.e1.enabled,
          e2: state.engines.e2.enabled,
          e3: state.engines.e3.enabled,
        },
        blendMixScratch,
      );
      distributeToEnginesInto(engineIn, channels, blendMixScratch.weights, frameCount);

      // 7. Run each engine on its own distributed scratch. Engine
      // contract: input → output, where output = dry * (1 - engine.mix)
      // + wet * engine.mix. The engine writes the result back into
      // its input buffer (in-place). EngineOut.{e1,e2,e3} receive the
      // post-engine buffers.
      // E1 runs FIRST so its recovered tail can excite the late FDNs
      // (ER→Late injection, blend.injectER).
      reflections.process(engineIn.e1, frameCount);

      const injectER = clamp(state.blendPad.injectER, 0, 1);
      const m1g = clamp(state.engines.e1.mix, 0, 100) / 100;
      if (injectER > 0 && m1g > 1e-6) {
        // Pure-wet engines: e1L already holds E1's wet tail.
        for (let c = 0; c < cc; c++) {
          const wet1 = engineIn.e1[c];
          const in2 = engineIn.e2[c];
          const in3 = engineIn.e3[c];
          for (let i = 0; i < frameCount; i++) {
            const erIn = injectER * m1g * wet1[i];
            in2[i] += erIn;
            in3[i] += erIn;
          }
        }
      }

      plateChamber.process(engineIn.e2, frameCount);
      hall.process(engineIn.e3, frameCount);

      // 7b. Convolution engine. Runs when mode is not algorithmic.
      // Capture its contribution and add to the wet bus.
      const convMode = state.convolution?.mode ?? "algorithmic";
      if (convMode !== "algorithmic" && convolution.isIrLoaded()) {
        convolution.process(channels, frameCount);
      }

      // 8. Compute the wet bus: wetPerEngine = (engineOut - dry * (1-m))
      // / m, then weighted by blend weight.
      const distributed = engineIn;
      for (let c = 0; c < cc; c++) {
        for (let i = 0; i < frameCount; i++) wetPreEq[c][i] = 0;
      }
      const m1 = state.engines.e1.mix / 100;
      const m2 = state.engines.e2.mix / 100;
      const m3 = state.engines.e3.mix / 100;
      // PURE-WET reconstruction: engines hand back tail only, so the wet
      // bus is a plain mix — no dry subtraction, no division. Weights were
      // applied at distribution, engine mix gains apply here.
      for (let c = 0; c < cc; c++) {
        const out1 = distributed.e1[c];
        const out2 = distributed.e2[c];
        const out3 = distributed.e3[c];
        for (let i = 0; i < frameCount; i++) {
          wetPreEq[c][i] = m1 * out1[i] + m2 * out2[i] + m3 * out3[i];
        }
      }

      if (convMode !== "algorithmic" && convolution.isIrLoaded()) {
        // The convolution engine writes `dry*(1-mix) + wet*mix` into the
        // channels. To recover the pure wet contribution we subtract the
        // dry component: wet = out - dry*(1-mix). Convolution sees the
        // post-pre-EQ engine input, so use engineDry rather than finalDry.
        const cMix = clamp((state.convolution?.wet ?? 100) / 100, 0, 1);
        const cDryGain = 1 - cMix;
        for (let c = 0; c < cc; c++) {
          const dryRef = engineDry[c];
          for (let i = 0; i < frameCount; i++) {
            wetPreEq[c][i] += channels[c][i] - dryRef[i] * cDryGain;
          }
        }
      }

      // 8b. Auto-duck: shrink the wet bus when peer notifications
      // signal masking energy. The controller smooths attack/release
      // internally; we only apply the per-block scalar here.
      lastDuckGain = duckController.getGain(sampleRate, frameCount);
      if (lastDuckGain < 0.999) {
        for (let c = 0; c < cc; c++) {
          const wet = wetPreEq[c];
          for (let i = 0; i < frameCount; i++) wet[i] *= lastDuckGain;
        }
      }

      // Snapshot wet for analyzers.
      analyzer.push("wet", wetPreEq, frameCount);

      // 9. Reverb EQ on the wet bus.
      reverbEq.process(wetPreEq, frameCount, finalDry);

      // 10. Mod Pad (animates the wet tail).
      modPad.process(wetPreEq, frameCount);

      // 10b. Gated reverb: when the input stops, ramp the wet bus down.
      let gateG = 1;
      if (state.global.gate) {
        let pk = 0;
        for (let c = 0; c < cc; c++) {
          const d = finalDry[c];
          for (let i = 0; i < frameCount; i++) {
            const a = Math.abs(d[i]);
            if (a > pk) pk = a;
          }
        }
        const target = pk > 0.0056 ? 1 : 0; // ≈ −45 dBFS
        const tau = target > gateGain ? 0.003 : 0.12;
        gateGain += (1 - Math.exp(-frameCount / (tau * sampleRate))) * (target - gateGain);
        gateG = gateGain;
      }

      // 11. Global Dry/Wet mix + Level trim.
      const dw = clamp(state.global.dryWet, 0, 100) / 100;
      const dryG = state.global.fxOnly ? 0 : 1 - dw;
      const wetG = dw;
      // Level (-24..+6 dB) and output gain (-24..+24 dB) clamped to their
      // documented ranges: these multiply AFTER the last input-side
      // sanitize, so an out-of-range value (dbToLinear(1e9) = Infinity)
      // would reach the output directly.
      const levelGain = dbToLinear(clamp(state.global.levelDb, -24, 6));
      const outGain = dbToLinear(clamp(state.global.outputGainDb, -24, 24));
      for (let c = 0; c < cc; c++) {
        const out = channels[c];
        const dry = finalDry[c];
        const wet = wetPreEq[c];
        for (let i = 0; i < frameCount; i++) {
          out[i] = (dry[i] * dryG + wet[i] * wetG * gateG) * levelGain * outGain;
        }
      }

      // 12. Safety limiter — brickwall true-peak ceiling so the output
      // never produces an intersample peak above -0.3 dBFS.
      safetyLimiter.process(channels, frameCount);

      // 13. Output poison guard. The limiter's peak comparisons treat NaN
      // as "no peak" and re-emit poisoned samples verbatim, so any residual
      // NaN/Inf from an upstream stage would reach the host — and through
      // the convolver's spectra rings it can sustain itself. The input side
      // is sanitized on entry; contain the output side at the last boundary.
      for (let c = 0; c < cc; c++) {
        const out = channels[c];
        for (let i = 0; i < frameCount; i++) {
          if (!Number.isFinite(out[i])) out[i] = 0;
        }
      }

      // Masking Meter (passive analyser — always live per spec, no click required).
      maskingMeter.push(finalDry, wetPreEq, frameCount);

      // Output analyzer (post everything, sees the limited output).
      analyzer.push("output", channels, frameCount);
    },

    reset() {
      // Reset = full re-prepare (mirrors native): guarantees a reset
      // processor is bit-identical to a freshly prepared one. The IPC
      // subscription stays alive (see dispose for terminal teardown).
      doPrepare(sampleRate, channelCount, bpm, preparedMaxBs);
      // prepare() keeps some module state when buffers are already sized
      // — clear explicitly (mirrors the native reset).
      preDelay.reset();
      smoother.reset();
      reflections.reset();
      plateChamber.reset();
      hall.reset();
      convolution.reset();
      safetyLimiter.reset();
      // Same "freshly prepared" contract for the scalar states prepare()
      // does not touch: a duck gain latched low, a gate envelope collapsed
      // by silence, or a lingering transient-shaper reduction would all
      // survive reset() and shape the post-reset tail differently than a
      // brand-new instance. (Reconciled from Pulse Forge hardening audit,
      // 2026-09-07.)
      duckController.reset();
      gateGain = 1.0;
    },

    dispose() {
      // Terminal lifecycle operation: unlike reset(), release the peer and
      // callback retained by the global IPC registry.
      if (duckSubscription) {
        duckSubscription();
        duckSubscription = null;
      }
      if (duckInstanceId !== null) {
        ipc.unregister();
        duckInstanceId = null;
      }
      duckController.reset();
      lastDuckGain = 1.0;
      prepared = false;
    },

    getLatencySamples() {
      let latency = safetyLimiter.getLatencySamples();
      const convMode = state?.convolution?.mode ?? "algorithmic";
      if (convMode !== "algorithmic" && convolution.isIrLoaded()) {
        latency += convolution.getLatencySamples();
      }
      return latency;
    },

    getTailSamples() {
      // Worst-case Hall engine at max time (24 s) at the ACTUAL sample
      // rate — a hard-coded 48 kHz value under-reported tails by 2× at
      // 96 kHz.
      return Math.round(24 * sampleRate);
    },

    getSpectrumAnalyzer() {
      return analyzer;
    },

    runAutoCut() {
      return preEq.runAutoCut(sampleRate);
    },

    runUnmask() {
      return reverbEq.runUnmask(sampleRate);
    },

    runAutoCutDetailed() {
      return preEq.runAutoCutDetailed(sampleRate);
    },

    runUnmaskDetailed() {
      return reverbEq.runUnmaskDetailed(sampleRate);
    },

    runMaskingSnapshot(sr, grid) {
      return maskingMeter.snapshot(sr, grid);
    },

    setAnalyzersEnabled(on) {
      analyzersEnabled = on;
      analyzer.setEnabled(on);
      preEq.setAnalyzerEnabled(on);
      reverbEq.setAnalyzerEnabled(on);
      maskingMeter.setAnalyzerEnabled(on);
    },

    setFactoryIrProvider(provider) {
      factoryIrProvider = provider;
    },

    isIrLoaded() {
      return convolution.isIrLoaded();
    },

    getIrChannels() {
      return convolution.getIrChannels();
    },

    loadUserIr(samples, channels) {
      loadUserIr(samples, channels);
    },

    loadPrecomputedIr(sets, channels) {
      loadPrecomputedIr(sets, channels);
    },

    clearUserIr() {
      clearUserIr();
    },
  };
}
