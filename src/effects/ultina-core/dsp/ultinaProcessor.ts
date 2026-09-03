/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ultina. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden vectors
 * (tests/ultina-vectors.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ultina.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ultina — Top-Level Processor
//
// Wires modules in graph order, handles global gain, mix,
// delta listen, and bypass. This is the audio-thread entry
// point for the entire plugin.
//
// REALTIME CONSTRAINTS:
//   - No allocations in process()
//   - No locks in process()
//   - No JS callbacks in process() (pure DSP)
//   - Parameter changes arrive via a pre-allocated queue
//
// ARCHITECTURE:
//   1. Input gain (global.inputGainDb)
//   2. Dry buffer capture (for mix + delta)
//   3. Module chain (active modules in graph order)
//   4. Mix crossfade (global.mix)
//   5. Output gain (global.outputGainDb)
//   6. Bypass / delta listen
// ═══════════════════════════════════════════════════════════

import { ModuleGraphRuntime } from "./moduleGraphRuntime.js";
import { MODULE_TYPES, type ModuleType } from "../contracts/moduleTypes.js";
import type { UltinaMeters, GlobalMeters } from "../contracts/meters.js";
import { createDefaultGlobalMeters } from "../contracts/meters.js";
import {
  GLOBAL_BYPASS_ID,
  GLOBAL_INPUT_GAIN_DB_ID,
  GLOBAL_OUTPUT_GAIN_DB_ID,
  GLOBAL_MIX_ID,
  GLOBAL_DELTA_LISTEN_ID,
  GLOBAL_QUALITY_MODE_ID,
  GLOBAL_GAIN_MATCH_ENABLED_ID,
  GLOBAL_AUTOGAIN_TARGET_LUFS_ID,
} from "../contracts/parameterIds.js";
import { buildDefaultParams, clampParam } from "../contracts/parameterSchema.js";
import { dbToLinear, sanitizeSample, OnePoleSmoother, ampToDb } from "./primitives.js";
import { SpectrumAnalyzer, FFT_SIZE, SPECTRUM_BINS } from "./spectrumAnalyzer.js";
import { LufsMeter } from "./lufsMeter.js";
import { AutoGainController, type AutoGainReading } from "./autoGain.js";
import { SpectralRegistry, BandAnalyzer } from "./spectralRegistry.js";
import { EqLearn } from "./eqLearn.js";
import { CrossoverLearn } from "./crossoverLearn.js";
import type { EqLearnMeters, CrossoverLearnMeters } from "../contracts/meters.js";

// ── Module processor interface ─────────────────────────────
//
// Every module implements this interface. The top-level
// processor calls these methods during the audio callback.

export interface ModuleProcessorContext {
  /** Current sample rate. */
  sampleRate: number;
  /** Maximum block size. */
  maxBlockSize: number;
  /** Channel count (always 2 for stereo). */
  channelCount: number;
  /** Quality mode (0=tracking, 1=mix, 2=hq). */
  qualityMode: number;
}

export interface ModuleProcessArgs {
  /** Audio channels [left, right]. Modified in-place. */
  channels: Float32Array[];
  /** Number of valid frames in this block. */
  frameCount: number;
  /** Sidechain input channels (may be null if not connected). */
  sidechain: Float32Array[] | null;
  /** Processing context. */
  ctx: ModuleProcessorContext;
  /** Current parameters for this module (filtered subset). */
  params: Record<string, number>;
}

export interface UltinaModuleProcessor {
  /** Called when sample rate or block size changes. */
  prepare(ctx: ModuleProcessorContext): void;
  /** Process a block of audio. Modifies channels in-place. */
  process(args: ModuleProcessArgs): void;
  /** Reset internal state (filters, envelopes, etc.). */
  reset(): void;
  /** Get current meter values for this module. */
  getMeters(): unknown;
  /**
   * Processing latency introduced by this module in samples
   * (hybrid FIR crossover, oversampler group delay, etc.).
   * Called from the control thread. Default 0.
   */
  getLatency?(): number;
}

export type ModuleProcessorFactory = () => UltinaModuleProcessor;

// ── Stub module (identity passthrough) ─────────────────────
//
// Used when a module's DSP hasn't been implemented yet.

class StubModuleProcessor implements UltinaModuleProcessor {
  prepare(): void {}
  process(): void {}
  reset(): void {}
  getMeters(): unknown {
    return { bands: [], stub: true };
  }
}

// ── Processor configuration ────────────────────────────────

export interface UltinaProcessorConfig {
  sampleRate: number;
  maxBlockSize: number;
  channelCount: number;
  qualityMode: number;
}

// ── Parameter change queue ─────────────────────────────────
//
// Pre-allocated ring buffer for thread-safe parameter updates.
// The control thread enqueues; the audio thread dequeues at
// the start of each process() call.

interface ParamChange {
  id: string;
  value: number;
}

const PARAM_QUEUE_SIZE = 1024;

class ParamChangeQueue {
  private buffer: ParamChange[];
  private writePos: number = 0;
  private readPos: number = 0;

  constructor() {
    this.buffer = new Array(PARAM_QUEUE_SIZE);
    for (let i = 0; i < PARAM_QUEUE_SIZE; i++) {
      this.buffer[i] = { id: "", value: 0 };
    }
  }

  reset(): void {
    this.writePos = 0;
    this.readPos = 0;
  }

  /** Control-thread: enqueue a parameter change. */
  enqueue(id: string, value: number): boolean {
    const nextWrite = (this.writePos + 1) % PARAM_QUEUE_SIZE;
    if (nextWrite === this.readPos) return false; // Full
    this.buffer[this.writePos].id = id;
    this.buffer[this.writePos].value = value;
    this.writePos = nextWrite;
    return true;
  }

  /** Audio-thread: dequeue the next change into `out`. The payload is
   * copied BEFORE the read index advances — otherwise the control
   * thread may overwrite the slot while the audio thread still reads
   * it (mismatched id/value pairs under heavy parameter traffic). */
  dequeueInto(out: ParamChange): boolean {
    if (this.readPos === this.writePos) return false;
    const slot = this.buffer[this.readPos];
    out.id = slot.id;
    out.value = slot.value;
    this.readPos = (this.readPos + 1) % PARAM_QUEUE_SIZE;
    return true;
  }

  /** Drain all pending changes into a target map. */
  drainInto(target: Record<string, number>): void {
    const entry: ParamChange = { id: "", value: 0 };
    while (this.dequeueInto(entry)) {
      target[entry.id] = entry.value;
    }
  }
}

// ── Main processor ─────────────────────────────────────────

export class UltinaProcessor {
  // Configuration
  private sampleRate: number = 44100;
  private maxBlockSize: number = 512;
  private channelCount: number = 2;
  private qualityMode: number = 1;
  private prepared: boolean = false;

  // Parameters
  private params: Record<string, number>;

  // Module graph runtime
  private graphRuntime: ModuleGraphRuntime;

  // Module instances (one per type, lazily created)
  private modules: Map<ModuleType, UltinaModuleProcessor> = new Map();

  // Module factory registry
  private factories: Map<ModuleType, ModuleProcessorFactory> = new Map();

  // Parameter change queue (control → audio thread)
  private paramQueue: ParamChangeQueue = new ParamChangeQueue();

  // Working buffers
  private dryBufferL: Float32Array = new Float32Array(0);
  private dryBufferR: Float32Array = new Float32Array(0);

  // Smoothers for global controls
  private inputGainSmoother: OnePoleSmoother = new OnePoleSmoother();
  private outputGainSmoother: OnePoleSmoother = new OnePoleSmoother();
  private mixSmoother: OnePoleSmoother = new OnePoleSmoother();

  // Meter state
  private lufsMeter: LufsMeter = new LufsMeter();
  private autoGain: AutoGainController = new AutoGainController();
  private inputPeakL: number = 0;
  private inputPeakR: number = 0;
  private outputPeakL: number = 0;
  private outputPeakR: number = 0;
  private inputRmsL: number = 0;
  private inputRmsR: number = 0;
  private outputRmsL: number = 0;
  private outputRmsR: number = 0;
  private totalSamples: number = 0;

  // Visualizer buffers (pre-allocated to avoid per-block GC)
  private waveformBuffer: Float32Array = new Float32Array(256);
  private waveformFillPos: number = 0;
  private monoSumBuffer: Float32Array = new Float32Array(FFT_SIZE);
  private spectrumAnalyzer: SpectrumAnalyzer = new SpectrumAnalyzer();
  private spectrumCounter: number = 0;
  /** Run spectrum analysis every N blocks to reduce CPU. */
  private static readonly SPECTRUM_INTERVAL: number = 4;

  // Cross-instance spectral sharing
  private instanceId: string;
  private bandAnalyzer: BandAnalyzer = new BandAnalyzer();

  // Learn-mode analyzers (run only while the respective learn param is on)
  private eqLearn = new EqLearn();
  private xoverLearn = new CrossoverLearn();
  private eqLearnWasActive = false;
  private xoverLearnWasActive = false;
  private spectralRegistry: SpectralRegistry = SpectralRegistry.getInstance();

  // Active delta module (null = no delta listen)
  private deltaModule: ModuleType | null = null;

  // Cached context object (reused across process() calls — no per-block allocation)
  private cachedCtx: ModuleProcessorContext = {
    sampleRate: 44100,
    maxBlockSize: 512,
    channelCount: 2,
    qualityMode: 1,
  };

  // Pre-allocated per-chunk channel refs + module process args. process()
  // reuses these instead of allocating a channels array and an args object
  // per module per block — the processor's own REALTIME CONSTRAINTS forbid
  // allocations on the audio path (modules destructure args immediately and
  // never retain it).
  private chunkChannels: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private chunkArgs: ModuleProcessArgs = {
    channels: this.chunkChannels,
    frameCount: 0,
    sidechain: null,
    ctx: this.cachedCtx,
    params: {},
  };

  // Pre-allocated per-module param records (keyed by module type prefix)
  private moduleParamCache: Map<string, Record<string, number>> = new Map();
  private moduleParamKeys: Map<string, string[]> = new Map();

  constructor() {
    this.params = buildDefaultParams();
    this.graphRuntime = new ModuleGraphRuntime();
    this.instanceId = this.spectralRegistry.generateId();
  }

  // ── Lifecycle ────────────────────────────────────────────

  /**
   * Prepare the processor for audio processing.
   * Must be called before process().
   */
  prepare(config: UltinaProcessorConfig): void {
    this.sampleRate = config.sampleRate;
    this.maxBlockSize = config.maxBlockSize;
    this.channelCount = config.channelCount;
    this.qualityMode = config.qualityMode;

    // Allocate buffers
    const bufSize = this.maxBlockSize;
    this.dryBufferL = new Float32Array(bufSize);
    this.dryBufferR = new Float32Array(bufSize);

    // Initialize smoothers
    const smoothMs = 20; // 20ms smoothing for gain changes
    this.inputGainSmoother = new OnePoleSmoother();
    this.outputGainSmoother = new OnePoleSmoother();
    this.mixSmoother = new OnePoleSmoother();
    this.inputGainSmoother.setTimeConstant(smoothMs, this.sampleRate);
    this.outputGainSmoother.setTimeConstant(smoothMs, this.sampleRate);
    this.mixSmoother.setTimeConstant(smoothMs, this.sampleRate);

    // Set smoother values to current parameter values (no ramp)
    this.inputGainSmoother.reset(
      dbToLinear(this.params[GLOBAL_INPUT_GAIN_DB_ID] ?? 0),
    );
    this.outputGainSmoother.reset(
      dbToLinear(this.params[GLOBAL_OUTPUT_GAIN_DB_ID] ?? 0),
    );
    this.mixSmoother.reset((this.params[GLOBAL_MIX_ID] ?? 100) / 100);

    // REALTIME SAFETY: instantiate EVERY module type up front (real
    // implementation via factory, stub when none is registered) so the
    // audio thread's getOrCreateModule() is a pure map lookup. Creating
    // a module lazily in process() would allocate and run prepare() on
    // the audio thread — an audible dropout risk the first time a module
    // is enabled during playback.
    this.cachedCtx.sampleRate = this.sampleRate;
    this.cachedCtx.maxBlockSize = this.maxBlockSize;
    this.cachedCtx.channelCount = this.channelCount;
    this.cachedCtx.qualityMode = this.qualityMode;

    for (const moduleType of MODULE_TYPES) {
      const existing = this.modules.get(moduleType);
      if (existing) {
        existing.prepare(this.cachedCtx);
        continue;
      }
      const factory = this.factories.get(moduleType);
      const module = factory ? factory() : new StubModuleProcessor();
      // Wire cross-instance ecosystem: pass instance ID to unmask module
      if (moduleType === "unmask" && "setInstanceId" in module) {
        (module as { setInstanceId(id: string): void }).setInstanceId(this.instanceId);
      }
      module.prepare(this.cachedCtx);
      this.modules.set(moduleType, module);
    }

    // Pre-build the per-module parameter key lists: building them on
    // first use in getModuleParams() would allocate inside process().
    this.moduleParamKeys.clear();
    this.moduleParamCache.clear();
    for (const moduleType of MODULE_TYPES) {
      const prefix = `${moduleType}.`;
      const keys: string[] = [];
      for (const id of Object.keys(this.params)) {
        if (id.startsWith(prefix)) keys.push(id);
      }
      this.moduleParamKeys.set(prefix, keys);
      this.moduleParamCache.set(prefix, {});
    }

    // Initialize visualizer buffers
    this.spectrumAnalyzer.prepare(this.sampleRate);
    this.lufsMeter.prepare(this.sampleRate, this.maxBlockSize);
    this.autoGain.prepare(this.sampleRate, this.maxBlockSize);
    this.waveformBuffer.fill(0);
    this.waveformFillPos = 0;
    this.monoSumBuffer.fill(0);
    this.spectrumCounter = 0;

    // Cross-instance spectral sharing
    this.bandAnalyzer.prepare(this.sampleRate, this.maxBlockSize);
    this.eqLearn.prepare(this.sampleRate, this.maxBlockSize);
    this.xoverLearn.prepare(this.sampleRate, this.maxBlockSize);
    this.spectralRegistry.register(this.instanceId);

    this.prepared = true;
  }

  /**
   * Process a block of audio.
   * channels[0] = left, channels[1] = right.
   * Modified in-place.
   */
  process(
    channels: Float32Array[],
    frameCount: number,
    sidechain: Float32Array[] | null = null,
  ): void {
    if (!this.prepared || channels.length < 2) return;

    const chL = channels[0];
    const chR = channels[1];

    // Drain parameter queue
    this.paramQueue.drainInto(this.params);

    // Read global parameters
    const bypass = (this.params[GLOBAL_BYPASS_ID] ?? 0) >= 0.5;
    const inputGainDb = this.params[GLOBAL_INPUT_GAIN_DB_ID] ?? 0;
    const outputGainDb = this.params[GLOBAL_OUTPUT_GAIN_DB_ID] ?? 0;
    const mixPercent = this.params[GLOBAL_MIX_ID] ?? 100;
    const deltaListen = (this.params[GLOBAL_DELTA_LISTEN_ID] ?? 0) >= 0.5;
    const gainMatchEnabled = (this.params[GLOBAL_GAIN_MATCH_ENABLED_ID] ?? 0) >= 0.5;
    const autoGainTargetLufs = this.params[GLOBAL_AUTOGAIN_TARGET_LUFS_ID] ?? -14;

    // Quality mode is a live parameter — pick up changes at runtime
    // (0=tracking, 1=mix, 2=hq) instead of only at prepare().
    const qualityModeParam = this.params[GLOBAL_QUALITY_MODE_ID] ?? this.qualityMode;
    if (qualityModeParam !== this.qualityMode) {
      this.qualityMode = Math.round(qualityModeParam);
    }

    // If bypassed, pass through (no processing)
    if (bypass) {
      this.updateInputMeters(chL, chR, frameCount);
      this.updateOutputMeters(chL, chR, frameCount);
      this.totalSamples += frameCount;
      return;
    }

    // Smoother targets
    const inputGainTarget = dbToLinear(inputGainDb);
    const mixTarget = mixPercent / 100;

    // Get active module chain
    const activeChain = this.graphRuntime.getActiveChain();

    // Determine which module is in delta mode (if delta listen is on)
    this.deltaModule = deltaListen
      ? this.findDeltaModule(activeChain.modules)
      : null;

    // Process module chain
    this.cachedCtx.qualityMode = this.qualityMode;

    // All internal buffers are sized for maxBlockSize — process larger
    // host blocks in chunks so nothing overflows (Float32Array.set
    // would otherwise throw and kill the audio callback).
    let offset = 0;
    while (offset < frameCount) {
      const frames = Math.min(this.maxBlockSize, frameCount - offset);
      const chunkChannels = this.chunkChannels;
      chunkChannels[0] = offset === 0 ? chL : chL.subarray(offset, offset + frames);
      chunkChannels[1] = offset === 0 ? chR : chR.subarray(offset, offset + frames);
      const chunkL = chunkChannels[0];
      const chunkR = chunkChannels[1];
      const chunkSidechain =
        sidechain && offset > 0
          ? sidechain.map((s) => (s ? s.subarray(offset, offset + frames) : s))
          : sidechain;

      // Reused args record — see chunkArgs declaration. Refreshed per module
      // (params differ); modules read it synchronously and never retain it.
      const args = this.chunkArgs;
      args.channels = chunkChannels;
      args.sidechain = chunkSidechain;
      args.ctx = this.cachedCtx;
      args.frameCount = frames;

      // Apply input gain (per-sample smoothing)
      for (let i = 0; i < frames; i++) {
        const g = this.inputGainSmoother.process(inputGainTarget);
        chunkL[i] *= g;
        chunkR[i] *= g;
      }

      // Measure input (post-input-gain)
      this.updateInputMeters(chunkL, chunkR, frames);

      // Capture dry buffer (for mix and delta)
      this.dryBufferL.set(chunkL.subarray(0, frames));
      this.dryBufferR.set(chunkR.subarray(0, frames));

      if (this.deltaModule !== null && activeChain.modules.length > 0) {
        // Delta listen mode: process up to and including the delta module,
        // then output (processed - dry)
        let processedToDelta = false;

        for (const moduleType of activeChain.modules) {
          const module = this.getOrCreateModule(moduleType);
          if (!module) continue;

          args.params = this.getModuleParams(moduleType);
          module.process(args);

          if (moduleType === this.deltaModule) {
            processedToDelta = true;
            // Compute delta: output = processed - dry
            for (let i = 0; i < frames; i++) {
              chunkL[i] = chunkL[i] - this.dryBufferL[i];
              chunkR[i] = chunkR[i] - this.dryBufferR[i];
            }
            break;
          }
        }

        if (!processedToDelta) {
          // Delta module not found in active chain, process normally
          for (const moduleType of activeChain.modules) {
            const module = this.getOrCreateModule(moduleType);
            if (!module) continue;
            args.params = this.getModuleParams(moduleType);
            module.process(args);
          }
        }
      } else {
        // Normal processing: run all active modules in order
        for (const moduleType of activeChain.modules) {
          const module = this.getOrCreateModule(moduleType);
          if (!module) continue;

          args.params = this.getModuleParams(moduleType);
          module.process(args);
        }
      }

      // Apply mix (dry/wet crossfade) — per-sample smoothing
      for (let i = 0; i < frames; i++) {
        const m = this.mixSmoother.process(mixTarget);
        const dryGain = 1 - m;
        chunkL[i] = this.dryBufferL[i] * dryGain + chunkL[i] * m;
        chunkR[i] = this.dryBufferR[i] * dryGain + chunkR[i] * m;
      }

      // Auto-Gain feedback loop: adjust output gain toward target LUFS
      this.autoGain.setEnabled(gainMatchEnabled);
      this.autoGain.setTargetLufs(autoGainTargetLufs);
      const autoGainCorrectionDb = this.autoGain.process(
        this.lufsMeter.getShortTermLufs(),
        frames,
      );

      // Apply output gain (per-sample smoothing) — includes auto-gain correction
      const totalOutputGainTarget = dbToLinear(outputGainDb + autoGainCorrectionDb);
      for (let i = 0; i < frames; i++) {
        const g = this.outputGainSmoother.process(totalOutputGainTarget);
        chunkL[i] *= g;
        chunkR[i] *= g;
      }

      // Sanitize (catch NaN/Inf)
      for (let i = 0; i < frames; i++) {
        chunkL[i] = sanitizeSample(chunkL[i]);
        chunkR[i] = sanitizeSample(chunkR[i]);
      }

      // Measure output
      this.updateOutputMeters(chunkL, chunkR, frames);

      offset += frames;
    }

    this.totalSamples += frameCount;
  }

  /**
   * Reset all state (filters, envelopes, etc.).
   */
  reset(): void {
    // Reset smoothers to their current parameter targets (not 0) so a
    // reset never ramps through a dry/unity flash.
    this.inputGainSmoother.reset(
      dbToLinear(this.params[GLOBAL_INPUT_GAIN_DB_ID] ?? 0),
    );
    this.outputGainSmoother.reset(
      dbToLinear(this.params[GLOBAL_OUTPUT_GAIN_DB_ID] ?? 0),
    );
    this.mixSmoother.reset((this.params[GLOBAL_MIX_ID] ?? 100) / 100);

    for (const module of this.modules.values()) {
      module.reset();
    }

    this.inputPeakL = 0;
    this.inputPeakR = 0;
    this.outputPeakL = 0;
    this.outputPeakR = 0;
    this.inputRmsL = 0;
    this.inputRmsR = 0;
    this.outputRmsL = 0;
    this.outputRmsR = 0;
    this.paramQueue.reset();

    // Reset visualizer buffers
    this.waveformBuffer.fill(0);
    this.waveformFillPos = 0;
    this.monoSumBuffer.fill(0);
    this.spectrumAnalyzer.reset();
    this.lufsMeter.reset();
    this.autoGain.reset();
    this.spectrumCounter = 0;

    // Reset cross-instance spectral sharing state
    this.bandAnalyzer.reset();
  }

  /**
   * Dispose the processor and unregister from the spectral registry.
   * Called when the plugin instance is being destroyed.
   */
  dispose(): void {
    this.spectralRegistry.unregister(this.instanceId);
  }

  // ── Parameter management ─────────────────────────────────

  /**
   * Set a single parameter (control thread).
   * Queues the change for the audio thread.
   */
  setParameter(id: string, value: number): void {
    const clamped = clampParam(id, value);
    this.params[id] = clamped;
    this.paramQueue.enqueue(id, clamped);
  }

  /**
   * Set multiple parameters at once (control thread).
   */
  setParameters(params: Record<string, number>): void {
    for (const [id, value] of Object.entries(params)) {
      this.setParameter(id, value);
    }
  }

  /**
   * Get a parameter value (control thread).
   */
  getParameter(id: string): number {
    return this.params[id] ?? 0;
  }

  /**
   * Get all parameters (control thread).
   */
  getAllParameters(): Record<string, number> {
    return { ...this.params };
  }

  // ── Module graph ─────────────────────────────────────────

  /**
   * Get the module graph runtime for graph manipulation.
   */
  getGraphRuntime(): ModuleGraphRuntime {
    return this.graphRuntime;
  }

  /**
   * Register a module processor factory.
   */
  registerModuleFactory(
    moduleType: ModuleType,
    factory: ModuleProcessorFactory,
  ): void {
    this.factories.set(moduleType, factory);
    // If we already have an instance, replace it
    if (this.modules.has(moduleType)) {
      this.cachedCtx.sampleRate = this.sampleRate;
      this.cachedCtx.maxBlockSize = this.maxBlockSize;
      this.cachedCtx.channelCount = this.channelCount;
      this.cachedCtx.qualityMode = this.qualityMode;
      const instance = factory();
      if (this.prepared) instance.prepare(this.cachedCtx);
      this.modules.set(moduleType, instance);
    }
  }

  /**
   * Register all module factories at once.
   */
  registerModuleFactories(
    factories: Partial<Record<ModuleType, ModuleProcessorFactory>>,
  ): void {
    for (const [type, factory] of Object.entries(factories)) {
      this.registerModuleFactory(type as ModuleType, factory!);
    }
  }

  // ── State ────────────────────────────────────────────────

  /**
   * Load state from a parameter map + module graph.
   */
  loadState(params: Record<string, number>): void {
    // Apply all parameters
    for (const [id, value] of Object.entries(params)) {
      this.params[id] = clampParam(id, value);
    }
  }

  // ── Meters ───────────────────────────────────────────────

  /**
   * Get current meter snapshot.
   * Safe to call from the UI thread.
   */
  getMeters(): UltinaMeters {
    // Copy waveform buffer snapshot (avoid sharing live reference)
    const waveformCopy = new Float32Array(256);
    waveformCopy.set(this.waveformBuffer);

    // Copy spectrum bins snapshot
    const spectrumCopy = new Float32Array(SPECTRUM_BINS);
    spectrumCopy.set(this.spectrumAnalyzer.getBins());

    const ag = this.autoGain.getReading();

    const global: GlobalMeters = {
      ...createDefaultGlobalMeters(),
      inputPeakL: ampToDb(this.inputPeakL),
      inputPeakR: ampToDb(this.inputPeakR),
      inputRmsL: ampToDb(Math.sqrt(this.inputRmsL)),
      inputRmsR: ampToDb(Math.sqrt(this.inputRmsR)),
      outputPeakL: ampToDb(this.outputPeakL),
      outputPeakR: ampToDb(this.outputPeakR),
      outputRmsL: ampToDb(Math.sqrt(this.outputRmsL)),
      outputRmsR: ampToDb(Math.sqrt(this.outputRmsR)),
      qualityMode: this.qualityMode,
      timestamp: this.totalSamples,
      outputWaveform: waveformCopy,
      inputSpectrumDb: spectrumCopy,
      outputShortTermLufs: this.lufsMeter.getShortTermLufs(),
      outputTruePeakDb: this.lufsMeter.getTruePeakDb(),
      autoGainCorrectionDb: ag.gainCorrectionDb,
      autoGainErrorDb: ag.errorDb,
      autoGainActive: ag.active,
    };

    const modules: Record<string, unknown> = {};
    for (const [type, module] of this.modules) {
      if (this.graphRuntime.isModuleEnabled(type)) {
        modules[type] = module.getMeters();
      }
    }

    // Learn results (present only while the learn params are active)
    const eqLearnNow = (this.params["eq.learnActive"] ?? 0) >= 0.5;
    let eq: EqLearnMeters | null = null;
    if (eqLearnNow) {
      const res = this.eqLearn.getResult();
      eq = {
        suggestions: res.suggestions.map((s) => ({
          freqHz: s.freqHz, gainDb: s.gainDb, q: s.q, severity: s.severity,
        })),
        isReady: res.isReady,
      };
    }
    const xoverLearnNow = (this.params["comp.crossoverLearn"] ?? 0) >= 0.5
      || (this.params["gate.crossoverLearn"] ?? 0) >= 0.5
      || (this.params["exciter.crossoverLearn"] ?? 0) >= 0.5;
    let crossover: CrossoverLearnMeters | null = null;
    if (xoverLearnNow) {
      const res = this.xoverLearn.getResult();
      const s3 = res.suggestions3Band;
      crossover = {
        freqHz1: s3 ? s3[0].freqHz : (res.suggestion2Band?.freqHz ?? 250),
        freqHz2: s3 ? s3[1].freqHz : null,
        confidence: s3 ? s3[0].confidence : (res.suggestion2Band?.confidence ?? 0),
        isReady: res.isReady,
      };
    }

    return { global, modules, learn: { eq, crossover } };
  }

  /**
   * Get detailed LUFS readings (momentary, short-term, integrated, LRA, true-peak).
   */
  getLufsReading() {
    return this.lufsMeter.getReading();
  }

  /**
   * Compute the total processing latency introduced by the active
   * module chain (hybrid FIR crossover, oversampler group delay).
   * Called from the control thread.
   */
  getLatencySamples(): number {
    let total = 0;
    const activeChain = this.graphRuntime.getActiveChain();
    for (const moduleType of activeChain.modules) {
      const module = this.modules.get(moduleType);
      if (module && typeof module.getLatency === "function") {
        total += module.getLatency();
      }
    }
    return total;
  }

  /**
   * Get current auto-gain controller state for metering.
   */
  getAutoGainReading(): AutoGainReading {
    return this.autoGain.getReading();
  }

  // ── Internal helpers ─────────────────────────────────────

  private getOrCreateModule(
    moduleType: ModuleType,
  ): UltinaModuleProcessor | null {
    // prepare() instantiates every module type (real or stub), so this
    // is a pure lookup — no allocation and no prepare() on the audio
    // thread.
    return this.modules.get(moduleType) ?? null;
  }

  private getModuleParams(moduleType: ModuleType): Record<string, number> {
    const prefix = `${moduleType}.`;
    let cached = this.moduleParamCache.get(prefix);
    if (!cached) {
      cached = {};
      this.moduleParamCache.set(prefix, cached);
    }
    let keys = this.moduleParamKeys.get(prefix);
    if (!keys) {
      keys = [];
      for (const id of Object.keys(this.params)) {
        if (id.startsWith(prefix)) keys.push(id);
      }
      this.moduleParamKeys.set(prefix, keys);
    }
    for (let i = 0; i < keys.length; i++) {
      cached[keys[i]] = this.params[keys[i]];
    }
    return cached;
  }

  private findDeltaModule(
    activeModules: readonly ModuleType[],
  ): ModuleType | null {
    // Find the first module with delta=true (the module-level delta param)
    // For now, we use the global delta listen which processes the full chain
    // minus dry. This can be extended to per-module delta in the future.
    if (activeModules.length === 0) return null;
    return activeModules[activeModules.length - 1];
  }

  private updateInputMeters(
    chL: Float32Array,
    chR: Float32Array,
    frameCount: number,
  ): void {
    let peakL = 0;
    let peakR = 0;
    let sumSqL = 0;
    let sumSqR = 0;

    for (let i = 0; i < frameCount; i++) {
      const absL = Math.abs(chL[i]);
      const absR = Math.abs(chR[i]);
      if (absL > peakL) peakL = absL;
      if (absR > peakR) peakR = absR;
      sumSqL += chL[i] * chL[i];
      sumSqR += chR[i] * chR[i];
    }

    // Peak hold with decay
    this.inputPeakL = Math.max(peakL, this.inputPeakL * 0.95);
    this.inputPeakR = Math.max(peakR, this.inputPeakR * 0.95);

    // RMS (running average of the per-block MEAN square — dividing by
    // frameCount keeps the reading independent of block size)
    const alpha = frameCount / (this.sampleRate * 0.3 + frameCount);
    const meanSqL = sumSqL / Math.max(1, frameCount);
    const meanSqR = sumSqR / Math.max(1, frameCount);
    this.inputRmsL = this.inputRmsL * (1 - alpha) + meanSqL * alpha;
    this.inputRmsR = this.inputRmsR * (1 - alpha) + meanSqR * alpha;

    // Run spectrum analysis every N blocks to reduce CPU
    this.spectrumCounter++;
    if (this.spectrumCounter >= UltinaProcessor.SPECTRUM_INTERVAL) {
      this.spectrumCounter = 0;

      // Build mono sum (L+R)/2 — decimate or zero-pad to FFT_SIZE
      const copyLen = Math.min(frameCount, FFT_SIZE);
      for (let i = 0; i < FFT_SIZE; i++) {
        if (i < copyLen) {
          this.monoSumBuffer[i] = (chL[i] + chR[i]) * 0.5;
        } else {
          this.monoSumBuffer[i] = 0;
        }
      }

      this.spectrumAnalyzer.process(this.monoSumBuffer, FFT_SIZE);

      // Cross-instance spectral sharing: analyze output spectrum and publish.
      // Only process the valid (non-zero-padded) portion to avoid pulling
      // down the envelope followers with zeros.
      this.bandAnalyzer.process(this.monoSumBuffer, copyLen);
      this.spectralRegistry.publish(this.instanceId, this.bandAnalyzer.getBandLevelsDb());

      // Learn-mode analysis: reset the analyzer on a fresh learn start,
      // feed audio while active.
      const eqLearnOn = (this.params["eq.learnActive"] ?? 0) >= 0.5;
      if (eqLearnOn && !this.eqLearnWasActive) this.eqLearn.reset();
      this.eqLearnWasActive = eqLearnOn;
      if (eqLearnOn) this.eqLearn.process(this.monoSumBuffer, copyLen);

      const xoverLearnOn = (this.params["comp.crossoverLearn"] ?? 0) >= 0.5
        || (this.params["gate.crossoverLearn"] ?? 0) >= 0.5
        || (this.params["exciter.crossoverLearn"] ?? 0) >= 0.5;
      if (xoverLearnOn && !this.xoverLearnWasActive) this.xoverLearn.reset();
      this.xoverLearnWasActive = xoverLearnOn;
      if (xoverLearnOn) this.xoverLearn.process(this.monoSumBuffer, copyLen);
    }
  }

  private updateOutputMeters(
    chL: Float32Array,
    chR: Float32Array,
    frameCount: number,
  ): void {
    let peakL = 0;
    let peakR = 0;
    let sumSqL = 0;
    let sumSqR = 0;

    for (let i = 0; i < frameCount; i++) {
      const absL = Math.abs(chL[i]);
      const absR = Math.abs(chR[i]);
      if (absL > peakL) peakL = absL;
      if (absR > peakR) peakR = absR;
      sumSqL += chL[i] * chL[i];
      sumSqR += chR[i] * chR[i];
    }

    this.outputPeakL = Math.max(peakL, this.outputPeakL * 0.95);
    this.outputPeakR = Math.max(peakR, this.outputPeakR * 0.95);

    const alpha = frameCount / (this.sampleRate * 0.3 + frameCount);
    const meanSqL = sumSqL / Math.max(1, frameCount);
    const meanSqR = sumSqR / Math.max(1, frameCount);
    this.outputRmsL = this.outputRmsL * (1 - alpha) + meanSqL * alpha;
    this.outputRmsR = this.outputRmsR * (1 - alpha) + meanSqR * alpha;

    // Update LUFS meter
    this.lufsMeter.process(chL, chR, frameCount);

    // Capture decimated mono waveform for oscilloscope
    // Fill a 256-sample ring buffer from the latest output block
    const bufLen = this.waveformBuffer.length;
    const decimation = Math.max(1, Math.floor(frameCount / bufLen));
    for (let i = 0; i < frameCount; i += decimation) {
      this.waveformBuffer[this.waveformFillPos] = (chL[i] + chR[i]) * 0.5;
      this.waveformFillPos = (this.waveformFillPos + 1) % bufLen;
    }
  }
}

/**
 * Create a default UltinaProcessor instance.
 */
export function createUltinaProcessor(): UltinaProcessor {
  return new UltinaProcessor();
}
