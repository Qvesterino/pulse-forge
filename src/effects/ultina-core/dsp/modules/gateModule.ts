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
// Ultina — Gate Module (TypeScript Reference)
//
// 3-band gate/expander with hysteresis and hold.
// State machine: closed → opening → open → holding → closing.
//
// Signal flow:
//   Input → [Sidechain HPF] → [Multiband Split]
//   → [Per-Band Gate] → [Multiband Sum]
//   → [Mix/Delta] → Output
//
// The gate uses separate open and close thresholds (hysteresis)
// to prevent chatter. The hold time ensures the gate stays open
// for a minimum duration after the signal drops below threshold.
// ═══════════════════════════════════════════════════════════

import type {
  UltinaModuleProcessor,
  ModuleProcessorContext,
  ModuleProcessArgs,
} from "../ultinaProcessor.js";
import {
  clamp,
  dbToLinear,
  linearToDb,
  sanitizeSample,
  smoothCoef,
  EnvelopeFollower,
  createBiquad,
  setHighPass,
  resetBiquad,
  processBiquad,
  type BiquadState,
} from "../primitives.js";
import {
  MultibandProcessor,
} from "../multiband.js";
import { DryDelayMixer } from "../dryDelay.js";
import {
  channelModeFromValue,
  type BandCount,
  type CrossoverMode,
} from "../../contracts/channelModes.js";

// ── Constants ───────────────────────────────────────────────

export const GATE_MAX_BANDS = 3;

// ── Gate state machine ──────────────────────────────────────

enum GateState {
  Closed = 0,
  Opening = 1,
  Open = 2,
  Holding = 3,
  Closing = 4,
}

// ── Band state ──────────────────────────────────────────────

interface GateBandState {
  /** Current state machine state. */
  state: GateState;
  /** Current gain (0..1). */
  currentGain: number;
  /** Hold counter (samples remaining). */
  holdCounter: number;
  /** Envelope follower for detection. */
  detector: EnvelopeFollower;
  /** Attack coefficient. */
  attackCoef: number;
  /** Release coefficient. */
  releaseCoef: number;
}

// ── Module meters ───────────────────────────────────────────

export interface GateMeters {
  /** Per-band current gain (0..1, 1 = fully open). */
  bandGain: number[];
  /** Per-band state (0=closed, 1=opening, 2=open, 3=holding, 4=closing). */
  bandState: number[];
  /** Per-band reduction (dB, positive = attenuation). */
  bandReductionDb: number[];
}

// ── Gate Module ─────────────────────────────────────────────

export class GateModuleProcessor implements UltinaModuleProcessor {
  private sampleRate = 44100;
  private maxBlockSize = 512;
  private bands: GateBandState[] = [];
  private multiband = new MultibandProcessor();

  // Sidechain HPF
  private scHpf: BiquadState = createBiquad(2);

  // Dry buffer for delta
  private dryL: Float32Array = new Float32Array(0);
  private dryR: Float32Array = new Float32Array(0);
  // Latency-compensated dry/wet mixing (see dsp/dryDelay.ts).
  private dryDelay = new DryDelayMixer();
  private pooledMeters: GateMeters | null = null;

  // Sidechain HPF buffers
  private scHpfBufferL: Float32Array = new Float32Array(0);
  // Reused per-block scratch (audio thread — no fresh arrays in process())
  private openThresholdDbBuf: number[] = [0, 0, 0];
  private closeThresholdDbBuf: number[] = [0, 0, 0];
  private scChannelsWrap: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private scHpfBufferR: Float32Array = new Float32Array(0);

  // Meter state
  private bandGain: number[] = new Array(GATE_MAX_BANDS).fill(0);
  private bandState: number[] = new Array(GATE_MAX_BANDS).fill(GateState.Closed);
  private bandReductionDb: number[] = new Array(GATE_MAX_BANDS).fill(0);

  // Cached config
  private cachedBandCount = -1;
  private cachedXover1 = -1;
  private cachedXover2 = -1;

  prepare(ctx: ModuleProcessorContext): void {
    this.sampleRate = ctx.sampleRate;
    this.maxBlockSize = ctx.maxBlockSize;

    this.ensureBuffers(this.maxBlockSize);
    this.scHpf = createBiquad(2);

    this.bands = [];
    for (let i = 0; i < GATE_MAX_BANDS; i++) {
      this.bands.push({
        state: GateState.Closed,
        currentGain: 0,
        holdCounter: 0,
        detector: new EnvelopeFollower(),
        attackCoef: 0,
        releaseCoef: 0,
      });
      this.bands[i].detector.prepare(2, 20, this.sampleRate);
    }

    this.multiband.prepare(this.sampleRate, 2, this.maxBlockSize, 1);
    this.dryDelay.prepare(this.maxBlockSize);
    // prepare() rebuilds crossover filters; invalidate cached split values.
    this.cachedBandCount = -1;
    this.cachedXover1 = -1;
    this.cachedXover2 = -1;
  }

  process(args: ModuleProcessArgs): void {
    const { channels, frameCount, sidechain, params } = args;

    if (channels.length < 2) return;

    const enabled = (params["gate.enabled"] ?? 0) >= 0.5;
    if (!enabled) return;

    this.ensureBuffers(frameCount);

    // Read parameters
    const rangeDb = clamp(params["gate.rangeDb"] ?? -20, -80, 0);
    const attackMs = clamp(params["gate.attackMs"] ?? 1, 0.1, 100);
    const holdMs = clamp(params["gate.holdMs"] ?? 50, 0, 1000);
    const releaseMs = clamp(params["gate.releaseMs"] ?? 100, 5, 5000);
    const hysteresisDb = clamp(params["gate.hysteresisDb"] ?? 6, 0, 24);
    const scHpfHz = clamp(params["gate.sidechainHpfHz"] ?? 20, 20, 2000);
    const bandCount = Math.round(clamp(params["gate.bandCount"] ?? 1, 1, 3)) as BandCount;
    // Clamp like the exciter/transient/clipper/density modules: the hybrid
    // FIR crossover designs its sinc from an unclamped fc = freq/sr — a
    // value above Nyquist yields a degenerate filter.
    const xover1 = clamp(params["gate.crossoverHz1"] ?? 250, 20, 20000);
    const xover2 = clamp(params["gate.crossoverHz2"] ?? 2500, 20, 20000);
    const channelModeRaw = Math.round(clamp(params["gate.channelMode"] ?? 0, 0, 4));
    const channelMode = channelModeFromValue(channelModeRaw);
    const deltaListen = (params["gate.delta"] ?? 0) >= 0.5;
    const mixPercent = clamp(params["gate.mix"] ?? 100, 0, 100);

    // The "range" controls max attenuation. rangeDb = -20 means -20 dB when closed.
    // The "closed gain" in linear:
    const closedGainLinear = dbToLinear(rangeDb);

    // Compute thresholds (reused arrays — audio thread)
    // Open threshold comes from per-band params; close = open - hysteresis
    const openThresholdDb = this.openThresholdDbBuf;
    openThresholdDb[0] = params["gate.band0.openThresholdDb"] ?? -40;
    openThresholdDb[1] = params["gate.band1.openThresholdDb"] ?? -40;
    openThresholdDb[2] = params["gate.band2.openThresholdDb"] ?? -40;
    const closeThresholdDb = this.closeThresholdDbBuf;
    closeThresholdDb[0] = params["gate.band0.closeThresholdDb"] ?? (openThresholdDb[0] - hysteresisDb);
    closeThresholdDb[1] = params["gate.band1.closeThresholdDb"] ?? (openThresholdDb[1] - hysteresisDb);
    closeThresholdDb[2] = params["gate.band2.closeThresholdDb"] ?? (openThresholdDb[2] - hysteresisDb);
    // A close threshold ABOVE its open threshold makes the state machine
    // chatter (open→closing→open… per block) — enforce close ≤ open, which
    // is also what the hysteresis default expresses.
    for (let b = 0; b < closeThresholdDb.length; b++) {
      if (closeThresholdDb[b] > openThresholdDb[b]) {
        closeThresholdDb[b] = openThresholdDb[b];
      }
    }

    // Update multiband config
    this.updateMultiband(bandCount, xover1, xover2);
    const xoverMode: CrossoverMode = (params["gate.crossoverMode"] ?? 0) >= 0.5 ? "hybrid" : "analog";
    this.multiband.setCrossoverMode(xoverMode);

    // Store dry signal
    this.dryL.set(channels[0].subarray(0, frameCount));
    this.dryR.set(channels[1].subarray(0, frameCount));

    // Prepare detection source
    let detectSource: Float32Array[] = channels;
    const scEnabled = sidechain && sidechain.length >= 2;
    if (scEnabled) {
      setHighPass(this.scHpf.coeffs, scHpfHz, 0.707, this.sampleRate);
      this.scHpfBufferL.set(sidechain![0].subarray(0, frameCount));
      this.scHpfBufferR.set(sidechain![1].subarray(0, frameCount));
      const scChannels = this.scChannelsWrap;
      scChannels[0] = this.scHpfBufferL;
      scChannels[1] = this.scHpfBufferR;
      processBiquad(this.scHpf, scChannels, frameCount);
      detectSource = scChannels;
    }

    // Process through multiband
    const scActive = scEnabled && sidechain && sidechain.length >= 2;
    this.multiband.process(
      channels,
      frameCount,
      (bandIdx, bandChannels, bandFrames) => {
        this.processBand(
          bandIdx,
          bandChannels,
          bandFrames,
          scActive ? detectSource : null,
          openThresholdDb[bandIdx],
          closeThresholdDb[bandIdx],
          attackMs,
          holdMs,
          releaseMs,
          closedGainLinear,
        );
      },
      channelMode,
    );

    // Mix dry/wet — the dry copy is delayed by the wet path's current
    // latency (crossover + oversampler) so mix < 100 % stays phase-coherent
    // and delta listen has no delayed-copy echo (see dsp/dryDelay.ts).
    const mix = mixPercent / 100;
    this.dryDelay.process(
      channels,
      this.dryL,
      this.dryR,
      frameCount,
      this.multiband.getCrossoverLatency(),
      mix,
      deltaListen,
    );

    // Update output level smoothing is done per-band in processBand
  }

  reset(): void {
    for (const band of this.bands) {
      band.state = GateState.Closed;
      band.currentGain = 0;
      band.holdCounter = 0;
      band.detector.reset();
    }
    this.bandGain.fill(0);
    this.bandState.fill(GateState.Closed);
    this.bandReductionDb.fill(0);
    this.multiband.reset();
    this.dryDelay.reset();
    resetBiquad(this.scHpf);
  }

  getMeters(): GateMeters {
    if (!this.pooledMeters) {
      this.pooledMeters = {
        bandGain: new Array(this.bandGain.length).fill(0),
        bandState: new Array(this.bandState.length).fill(0),
        bandReductionDb: new Array(this.bandReductionDb.length).fill(0),
      };
    }
    const m = this.pooledMeters;
    // POOLED snapshot (audio thread — getMeters runs at meter cadence inside
    // UltinaProcessor.getMeters). The next call overwrites every field;
    // postMessage clones, direct readers must copy immediately.
    for (let i = 0; i < m.bandGain.length; i++) m.bandGain[i] = this.bandGain[i];
    for (let i = 0; i < m.bandState.length; i++) m.bandState[i] = this.bandState[i];
    for (let i = 0; i < m.bandReductionDb.length; i++) m.bandReductionDb[i] = this.bandReductionDb[i];
    return m;
  }

  /** Hybrid crossover group delay (samples). */
  getLatency(): number {
    return this.multiband.getCrossoverLatency();
  }

  // ── Internal ──────────────────────────────────────────────

  private ensureBuffers(requiredSize: number): void {
    if (this.dryL.length < requiredSize) {
      this.dryL = new Float32Array(requiredSize);
      this.dryR = new Float32Array(requiredSize);
      this.scHpfBufferL = new Float32Array(requiredSize);
      this.scHpfBufferR = new Float32Array(requiredSize);
    }
  }

  private updateMultiband(bandCount: BandCount, xover1: number, xover2: number): void {
    if (this.cachedBandCount !== bandCount) {
      this.multiband.setBandCount(bandCount);
      this.cachedBandCount = bandCount;
      // Bands beyond the new count must not keep reporting stale meter
      // readings — getMeters publishes the full 3-slot arrays.
      for (let b = bandCount; b < GATE_MAX_BANDS; b++) {
        this.bandGain[b] = 0;
        this.bandState[b] = GateState.Closed;
        this.bandReductionDb[b] = 0;
      }
      // setBandCount rebuilds the crossover (coefficients wiped) —
      // force both split frequencies to be re-applied below.
      this.cachedXover1 = -1;
      this.cachedXover2 = -1;
    }
    if (this.cachedXover1 !== xover1) {
      this.multiband.setCrossover(0, xover1);
      this.cachedXover1 = xover1;
    }
    if (this.cachedXover2 !== xover2 && bandCount >= 3) {
      this.multiband.setCrossover(1, xover2);
      this.cachedXover2 = xover2;
    }
  }

  private processBand(
    bandIdx: number,
    channels: Float32Array[],
    frameCount: number,
    sidechainSource: Float32Array[] | null,
    openThresholdDb: number,
    closeThresholdDb: number,
    attackMs: number,
    holdMs: number,
    releaseMs: number,
    closedGainLinear: number,
  ): void {
    const band = this.bands[bandIdx];
    band.attackCoef = smoothCoef(attackMs, this.sampleRate);
    band.releaseCoef = smoothCoef(releaseMs, this.sampleRate);
    const holdSamples = Math.round((holdMs / 1000) * this.sampleRate);

    const detectCh = sidechainSource ? (sidechainSource[0] ?? channels[0]) : channels[0];
    const openThresholdLin = dbToLinear(openThresholdDb);
    const closeThresholdLin = dbToLinear(closeThresholdDb);

    for (let i = 0; i < frameCount; i++) {
      // Detect signal level
      const sample = Math.abs(detectCh[i] ?? channels[0][i]);
      const detected = band.detector.process(sample);

      // State machine
      switch (band.state) {
        case GateState.Closed:
          if (detected >= openThresholdLin) {
            band.state = GateState.Opening;
          }
          break;

        case GateState.Opening:
          // Gain ramps from closedGainLinear to 1
          if (detected < closeThresholdLin) {
            // Signal dropped before fully open — start closing
            band.state = GateState.Closing;
          } else if (band.currentGain >= 0.999) {
            // Fully open — transition to Open state
            band.state = GateState.Open;
          }
          break;

        case GateState.Open:
          if (detected < closeThresholdLin) {
            band.state = GateState.Holding;
            band.holdCounter = holdSamples;
          }
          break;

        case GateState.Holding:
          if (detected >= openThresholdLin) {
            // Signal came back — reopen
            band.state = GateState.Open;
          } else if (band.holdCounter <= 0) {
            // Hold expired — start closing
            band.state = GateState.Closing;
          } else {
            band.holdCounter--;
          }
          break;

        case GateState.Closing:
          if (detected >= openThresholdLin) {
            // Signal came back — reopen
            band.state = GateState.Opening;
          }
          break;
      }

      // Target gain based on state
      let targetGain: number;
      switch (band.state) {
        case GateState.Closed:
          targetGain = closedGainLinear;
          break;
        case GateState.Opening:
        case GateState.Open:
        case GateState.Holding:
          targetGain = 1;
          break;
        case GateState.Closing:
          targetGain = closedGainLinear;
          break;
        default:
          targetGain = 1;
      }

      // Smooth gain toward target
      const coef = targetGain > band.currentGain ? band.attackCoef : band.releaseCoef;
      band.currentGain += coef * (targetGain - band.currentGain);

      // Clamp
      band.currentGain = clamp(band.currentGain, 0, 1);

      // If gain is very close to closed target and state is closing, finalize
      if (band.state === GateState.Closing && band.currentGain <= closedGainLinear * 1.001) {
        band.state = GateState.Closed;
      }

      // Apply gain
      const g = band.currentGain;
      for (let ch = 0; ch < channels.length; ch++) {
        channels[ch][i] = sanitizeSample(channels[ch][i] * g);
      }
    }

    // Update meters (smoothed)
    this.bandGain[bandIdx] = this.bandGain[bandIdx] * 0.7 + band.currentGain * 0.3;
    this.bandState[bandIdx] = band.state;
    const reductionDb = -linearToDb(Math.max(1e-10, band.currentGain));
    this.bandReductionDb[bandIdx] = this.bandReductionDb[bandIdx] * 0.7 + reductionDb * 0.3;
  }
}
