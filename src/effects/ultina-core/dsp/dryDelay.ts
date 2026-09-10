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
// Ultina — Latency-Compensated Dry/Wet Mixer
//
// Shared helper for the multiband modules' mix and delta stages.
//
// The wet path of a multiband module carries the crossover (and
// optional oversampler) group delay, while the dry path was captured
// pre-processing. Mixing them un-delayed combs the two copies
// together — audible as a hollow, phasey blend at mix < 100 % and as
// an "echo" of the unprocessed signal in delta listen. This mixer
// delays the DRY side by exactly the module's current latency so the
// two paths align sample-for-sample.
//
// Latency is dynamic (crossover mode / band count / oversampling can
// change at runtime); when it steps, the read point jumps — an
// acceptable one-time discontinuity on a rarely-touched control, and
// the host PDC is re-reported through the module's getLatency().
//
// REALTIME SAFETY: preallocated ring buffer, no allocation in
// process(), O(1) per sample.
// ═══════════════════════════════════════════════════════════

import { sanitizeSample } from "./primitives.js";

export class DryDelayMixer {
  private bufL: Float32Array = new Float32Array(0);
  private bufR: Float32Array = new Float32Array(0);
  private size = 0;
  private writePos = 0;

  prepare(maxBlockSize: number, maxDelaySamples = 64): void {
    // Keep the historical 64-sample headroom for ordinary multiband
    // modules, but let modules with a larger creative delay budget reserve
    // enough history for a coherent mix/delta path.
    this.size = maxBlockSize + Math.max(64, Math.ceil(maxDelaySamples));
    this.bufL = new Float32Array(this.size);
    this.bufR = new Float32Array(this.size);
    this.writePos = 0;
  }

  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.writePos = 0;
  }

  /**
   * Feed this block's dry signal and apply the compensated mix/delta.
   *
   * The line is ALWAYS fed (even at mix = 100 % with delta off) so the
   * history stays valid the moment the user touches the mix knob.
   * `delaySamples` of 0 reproduces the classic un-delayed mix exactly.
   *
   * @param channels   Wet output, modified in place.
   * @param dryL/dryR  This block's pre-processing signal.
   * @param delaySamples Current wet-path latency in samples.
   * @param mix        0..1 wet fraction (ignored while `delta` is set).
   * @param delta      Delta listen: output = wet − delayed dry.
   */
  process(
    channels: Float32Array[],
    dryL: Float32Array,
    dryR: Float32Array,
    frameCount: number,
    delaySamples: number,
    mix: number,
    delta: boolean,
  ): void {
    if (this.size === 0) return;
    const delay = Math.min(Math.max(0, delaySamples | 0), this.size - 1);
    const applyMix = !delta && mix < 0.999;

    for (let i = 0; i < frameCount; i++) {
      // Feed first, then read — with delay = 0 the read must see the
      // CURRENT dry sample (writePos points at it before advancing).
      this.bufL[this.writePos] = dryL[i];
      this.bufR[this.writePos] = dryR[i];

      if (delta || applyMix) {
        let r = this.writePos - delay;
        if (r < 0) r += this.size;
        const dryDelayL = this.bufL[r];
        const dryDelayR = this.bufR[r];
        const wetL = channels[0][i];
        const wetR = channels[1][i];
        if (delta) {
          channels[0][i] = sanitizeSample(wetL - dryDelayL);
          channels[1][i] = sanitizeSample(wetR - dryDelayR);
        } else {
          channels[0][i] = sanitizeSample(wetL * mix + dryDelayL * (1 - mix));
          channels[1][i] = sanitizeSample(wetR * mix + dryDelayR * (1 - mix));
        }
      }

      this.writePos++;
      if (this.writePos >= this.size) this.writePos = 0;
    }
  }

  /**
   * Per-channel variant for modules whose latency DIFFERS between L and R
   * (phase module: the Time Shift offset is a deliberate inter-channel
   * feature). Each dry channel is delayed by its own wet-path latency, so
   * mix and delta stay coherent on BOTH channels independently.
   */
  processPerChannel(
    channels: Float32Array[],
    dryL: Float32Array,
    dryR: Float32Array,
    frameCount: number,
    delaySamplesL: number,
    delaySamplesR: number,
    mix: number,
    delta: boolean,
  ): void {
    if (this.size === 0) return;
    const delayL = Math.min(Math.max(0, delaySamplesL | 0), this.size - 1);
    const delayR = Math.min(Math.max(0, delaySamplesR | 0), this.size - 1);
    const applyMix = !delta && mix < 0.999;

    for (let i = 0; i < frameCount; i++) {
      this.bufL[this.writePos] = dryL[i];
      this.bufR[this.writePos] = dryR[i];

      if (delta || applyMix) {
        let rl = this.writePos - delayL;
        if (rl < 0) rl += this.size;
        let rr = this.writePos - delayR;
        if (rr < 0) rr += this.size;
        const wetL = channels[0][i];
        const wetR = channels[1][i];
        if (delta) {
          channels[0][i] = sanitizeSample(wetL - this.bufL[rl]);
          channels[1][i] = sanitizeSample(wetR - this.bufR[rr]);
        } else {
          channels[0][i] = sanitizeSample(wetL * mix + this.bufL[rl] * (1 - mix));
          channels[1][i] = sanitizeSample(wetR * mix + this.bufR[rr] * (1 - mix));
        }
      }

      this.writePos++;
      if (this.writePos >= this.size) this.writePos = 0;
    }
  }
}
