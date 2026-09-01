/* eslint-disable */
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

  // Sidechain HPF buffers
  private scHpfBufferL: Float32Array = new Float32Array(0);
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
    const xover1 = params["gate.crossoverHz1"] ?? 250;
    const xover2 = params["gate.crossoverHz2"] ?? 2500;
    const channelModeRaw = Math.round(clamp(params["gate.channelMode"] ?? 0, 0, 4));
    const channelMode = channelModeFromValue(channelModeRaw);
    const deltaListen = (params["gate.delta"] ?? 0) >= 0.5;
    const mixPercent = clamp(params["gate.mix"] ?? 100, 0, 100);

    // The "range" controls max attenuation. rangeDb = -20 means -20 dB when closed.
    // The "closed gain" in linear:
    const closedGainLinear = dbToLinear(rangeDb);

    // Compute thresholds
    // Open threshold comes from per-band params; close = open - hysteresis
    const openThresholdDb = [
      params["gate.band0.openThresholdDb"] ?? -40,
      params["gate.band1.openThresholdDb"] ?? -40,
      params["gate.band2.openThresholdDb"] ?? -40,
    ];
    const closeThresholdDb = [
      params["gate.band0.closeThresholdDb"] ?? (openThresholdDb[0] - hysteresisDb),
      params["gate.band1.closeThresholdDb"] ?? (openThresholdDb[1] - hysteresisDb),
      params["gate.band2.closeThresholdDb"] ?? (openThresholdDb[2] - hysteresisDb),
    ];

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
      const scChannels = [this.scHpfBufferL, this.scHpfBufferR];
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

    // Mix dry/wet
    const mix = mixPercent / 100;
    if (mix < 0.999) {
      for (let i = 0; i < frameCount; i++) {
        channels[0][i] = sanitizeSample(channels[0][i] * mix + this.dryL[i] * (1 - mix));
        channels[1][i] = sanitizeSample(channels[1][i] * mix + this.dryR[i] * (1 - mix));
      }
    }

    // Delta listen
    if (deltaListen) {
      for (let i = 0; i < frameCount; i++) {
        channels[0][i] = sanitizeSample(channels[0][i] - this.dryL[i]);
        channels[1][i] = sanitizeSample(channels[1][i] - this.dryR[i]);
      }
    }

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
    resetBiquad(this.scHpf);
  }

  getMeters(): GateMeters {
    return {
      bandGain: [...this.bandGain],
      bandState: [...this.bandState],
      bandReductionDb: [...this.bandReductionDb],
    };
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
