/**
 * PORTAL AudioWorklet entry — bundled by scripts/build-spectral-worklet.mjs into
 * a single classic-script file (public/spectral-worklet.js) that the loader
 * feeds to AudioWorklet.addModule().
 *
 * Thin wrapper: all DSP lives in spectral-core (typed, first-party). This file
 * owns block copying, the k-rate parameter read, latency reporting and the
 * observer-only meter post. The protocol mirrors the skrutka / ultina entries so
 * the node wrapper and the engine treat all of them identically.
 *
 * PARAMETERS ARE AUDIOPARAMS, NOT PORT MESSAGES (the M2 pattern)
 * ------------------------------------------------------------
 * Every rack parameter is an AudioParam on the processor, so live writes AND
 * offline automation both work natively — live == offline parity holds without
 * a single message round-trip. The one port frame is observer-only telemetry.
 *
 * This matters more than usual here. NEW-EFFECT-CHECKLIST §5 records that
 * Chromium does not pump processor message queues mid-render, so any parameter
 * delivered by postMessage renders SILENT offline. An AudioParam surface cannot
 * hit that failure mode at all.
 *
 * PARAMS ARE READ AT BLOCK RATE
 * -----------------------------
 * A spectral frame arrives once per `hop` samples, and a parameter that changed
 * the frame geometry would have to be applied per-sample to be correct — which is
 * a per-sample read of a block-rate control, and exactly the class of bug
 * NEW-EFFECT-CHECKLIST §4 exists to prevent. Reading each AudioParam once per
 * block and handing the processor a plain value keeps the whole DSP k-rate.
 */

import { SpectralProcessor } from "./spectral-core/dsp/SpectralProcessor.ts";

const MAX_BLOCK = 128;
const CHANNELS = 2;

/** Meter cadence target (~20 Hz), derived from the ACTUAL render rate. */
const METERS_DIVIDER = Math.max(1, Math.round(sampleRate / MAX_BLOCK / 20));

/** Every rack parameter, read once per block and passed to the processor. */
const PARAM_IDS = [
  "mode",
  "time",
  "sync",
  "feedback",
  "decay",
  "resonance",
  "focus",
  "focusWidth",
  "shift",
  "diffuse",
  "freeze",
  "drive",
  "tone",
  "mix",
];

class PortalWorkletProcessor extends AudioWorkletProcessor {
  /**
   * The AudioParam surface is the WHOLE parameter contract - an AudioWorklet
   * creates its AudioParams from this list and from nothing else. A processor
   * that forgets it does not degrade, it goes silent: `node.parameters.get(id)`
   * is undefined, `safeApplyAudioParam` no-ops, and every knob reads as
   * "no change" while the effect happily plays its baked-in defaults. That is
   * indistinguishable from a working effect in a unit test that drives
   * SpectralProcessor directly, which is exactly why the ranges below are
   * pinned against EFFECT_META by tests/param-range-coherence.test.ts.
   *
   * Ranges mirror `portalParams` in src/effects/definitions.ts 1:1. Defaults
   * mirror it too, so an unconfigured node boots at the rack default instead of
   * at the AudioParam default.
   *
   * `bpm` is declared because SYNC is dead without it: portal-node.ts routes
   * `syncBpm()` into this AudioParam and readParams() feeds it to
   * SpectralProcessor.setBpm().
   */
  static get parameterDescriptors() {
    return [
      { name: "mode", minValue: 0, maxValue: 2, defaultValue: 0, automationRate: "k-rate" },
      { name: "time", minValue: 20, maxValue: 2000, defaultValue: 320, automationRate: "k-rate" },
      { name: "sync", minValue: 0, maxValue: 5, defaultValue: 0, automationRate: "k-rate" },
      { name: "bpm", minValue: 20, maxValue: 300, defaultValue: 120, automationRate: "k-rate" },
      { name: "feedback", minValue: 0, maxValue: 1, defaultValue: 0.55, automationRate: "k-rate" },
      { name: "decay", minValue: 0, maxValue: 1, defaultValue: 0.5, automationRate: "k-rate" },
      { name: "resonance", minValue: 0, maxValue: 1, defaultValue: 0.35, automationRate: "k-rate" },
      { name: "focus", minValue: 20, maxValue: 18000, defaultValue: 1200, automationRate: "k-rate" },
      { name: "focusWidth", minValue: 0.1, maxValue: 4, defaultValue: 1, automationRate: "k-rate" },
      { name: "shift", minValue: -24, maxValue: 24, defaultValue: 0, automationRate: "k-rate" },
      { name: "diffuse", minValue: 0, maxValue: 1, defaultValue: 0.3, automationRate: "k-rate" },
      { name: "freeze", minValue: 0, maxValue: 1, defaultValue: 0, automationRate: "k-rate" },
      { name: "drive", minValue: 0, maxValue: 1, defaultValue: 0, automationRate: "k-rate" },
      { name: "tone", minValue: -24, maxValue: 24, defaultValue: 0, automationRate: "k-rate" },
      { name: "mix", minValue: 0, maxValue: 1, defaultValue: 0.35, automationRate: "k-rate" },
    ];
  }

  proc = new SpectralProcessor();

  scratch = [new Float32Array(MAX_BLOCK), new Float32Array(MAX_BLOCK)];
  outL = new Float32Array(MAX_BLOCK);
  outR = new Float32Array(MAX_BLOCK);

  blockCount = 0;
  latencyPosted = -1;
  metersEnabled = false;
  disposed = false;

  constructor(options) {
    super();
    // Parameters BEFORE prepare(): prepare() seeds the smoothed MIX from the
    // current parameter value, so an effect that boots with MIX already at 1
    // starts wet from sample 0 instead of fading in through 20 ms of dry.
    const initial = options?.processorOptions?.params;
    if (initial && typeof initial === "object") this.proc.setParams(initial);
    this.proc.prepare(sampleRate);
    this.postLatency();
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "setMeters") {
        this.metersEnabled = data.enabled === true;
      }
    };
  }

  postLatency() {
    const frames = Math.round(this.proc.latencySamples());
    if (!Number.isFinite(frames) || frames < 0 || frames === this.latencyPosted) return;
    this.latencyPosted = frames;
    this.port.postMessage({ type: "latency", frames });
  }

  /** Read every AudioParam once — k-rate by construction. */
  readParams(params) {
    const frame = {};
    for (const id of PARAM_IDS) {
      const p = params[id];
      if (!p || p.length === 0) continue;
      // Every PORTAL param is documented k-rate, so reading index 0 is correct
      // for both the 1-length and the (unused) a-rate shapes alike.
      const v = p[0];
      if (Number.isFinite(v)) frame[id] = v;
    }
    const bpm = params.bpm;
    if (bpm && bpm.length > 0 && Number.isFinite(bpm[0])) this.proc.setBpm(bpm[0]);
    return frame;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    if (this.disposed) return false;

    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    const n = Math.min(outL.length, MAX_BLOCK);

    this.proc.setParams(this.readParams(params));

    const inL = input && input.length > 0 ? input[0] : null;
    const inR = input && input.length > 1 ? input[1] : inL;

    if (!inL) {
      // Input disconnected. Feed silence so the tail decays out naturally and the
      // ring never reads uninitialised memory — but keep running the processor,
      // because a delay that cuts dead the instant its source goes away is not a
      // delay.
      this.scratch[0].fill(0);
      this.scratch[1].fill(0);
    } else {
      for (let i = 0; i < n; i++) {
        this.scratch[0][i] = inL[i] ?? 0;
        this.scratch[1][i] = (inR ? inR[i] : inL[i]) ?? 0;
      }
    }

    this.proc.process(this.scratch[0], this.scratch[1], this.outL, this.outR, n);

    for (let i = 0; i < n; i++) {
      outL[i] = this.outL[i];
      outR[i] = this.outR[i];
    }

    this.blockCount++;
    if (this.metersEnabled && this.blockCount % METERS_DIVIDER === 0) {
      const m = this.proc.getMeters();
      // The band arrays are posted WITHOUT transfer. Structured clone copies
      // them on the RECEIVING side, so the audio thread hands over two live
      // views (128 bytes total) without allocating or detaching anything.
      // Transferring would be marginally cheaper on the main thread but would
      // detach the processor's own buffers and force it to re-allocate on the
      // audio thread — the one place this codebase must not allocate.
      this.port.postMessage({
        type: "meters",
        peak: m.peak,
        activity: m.activity,
        delaySec: m.delaySec,
        frames: m.frames,
        shiftSemitones: m.shiftSemitones,
        bandsIn: m.bandsIn,
        bandsOut: m.bandsOut,
      });
    }
    return true;
  }
}

registerProcessor("portal", PortalWorkletProcessor);
