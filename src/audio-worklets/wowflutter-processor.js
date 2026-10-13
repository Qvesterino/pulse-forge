/**
 * WOW & FLUTTER — a musical pitch-instability effect.
 *
 * Real tape wow is not a filter or a noise layer: it is the PLAYBACK SPEED
 * drifting, which is audible as pitch. Current production uses it as a
 * *musical* device — a static chord "comes alive" when the pitch wanders a few
 * cents — not only as a lo-fi character layer.
 *
 * This is deliberately NOT a second copy of the wow/flutter already inside
 * `vinyl-processor.js`. Three things differ, each for a musical reason:
 *
 *  1. DEPTH IS IN CENTS, not milliseconds of delay. Vinyl's `wow` is 0..2 ms
 *     at 0.2..4 Hz, which at its maximum is roughly a SEMITONE of wobble —
 *     the right number for a ruined record, the wrong number for a pad. Cents
 *     is the unit a producer already thinks in, and it makes the two extremes
 *     of the control meaningful (a few cents = alive; 60 cents = seasick).
 *
 *  2. THE READ POINTER NEVER WRAPS AHEAD OF THE WRITE POINTER. Vinyl reads at
 *     `delayPos - 1 - wobble` and folds a negative wobble through the ring
 *     modulo, which lands the read near the far end of the buffer and clicks
 *     on every wobble zero-crossing. Here the modulation is centred as
 *     `base + swing/2 + wobble` and the swing budget is `base - 1` samples, so
 *     the offset provably stays >= 1 sample and the only added latency is the
 *     fixed base delay.
 *
 *  3. STEREO MOVES IN PHASE. Vinyl deliberately reads the two channels in
 *     OPPOSITE directions to smear and widen the lo-fi image. For musical
 *     material that destroys the stereo image of a pad, so both channels share
 *     one modulation here.
 *
 * Real wow also wanders instead of oscillating cleanly, so a seeded, smoothed
 * random walk is mixed in under `drift`. The RNG is seeded per instance, so the
 * live/offline bit-identity contract holds.
 */

/** Ring length. Only ever has to cover base + swing, but it is kept generous so
 *  the read pointer has room even if a future term exceeds the budget. */
const DELAY_SECONDS = 0.06;
// The modulation math, its constants and the swing allocation live in a
// worklet-free module so that this processor and the panel readout cannot
// disagree about what a depth setting actually delivers — importing THIS file
// from the UI bundle throws, because the class below extends AudioWorkletProcessor.
// Aliased on import so the usage sites below read exactly as they did before the
// extraction; re-exported because the unit tests drive the pure math directly.
import {
  WF_BASE_DELAY_SECONDS as BASE_DELAY_SECONDS,
  WF_MIN_OFFSET_SAMPLES as MIN_OFFSET_SAMPLES,
  WF_DRIFT_MAX_CENTS as DRIFT_MAX_CENTS,
  WF_DRIFT_RATE_HZ as DRIFT_RATE_HZ,
  wfCentsToAmplitudeSeconds,
  wfAchievableCents,
  wfSwingPlan,
} from "./wowflutter-math.js";

export { wfCentsToAmplitudeSeconds, wfAchievableCents };

/** Deterministic 32-bit PRNG — same instance seed, same drift, offline and live. */
function wfRng(seed) {
  let s = seed >>> 0 || 1;
  return function rng() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function pv(parameters, name, fallback) {
  const arr = parameters[name];
  if (!arr || arr.length === 0) return fallback;
  const v = arr[0];
  return Number.isFinite(v) ? v : fallback;
}

class WowFlutterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = globalThis.sampleRate || 44100;
    this.sr = sr;
    this.baseSamples = Math.max(MIN_OFFSET_SAMPLES, Math.round(sr * BASE_DELAY_SECONDS));
    this.delayLen = Math.ceil(sr * DELAY_SECONDS);
    // Swing budget. The read offset is `base + swing/2 + wobble`, and wobble
    // reaches -swing at its most negative, so `swing <= base - 1` is exactly the
    // condition that keeps the offset >= 1 sample and the read strictly behind
    // the write. This replaces the old ring-size ceiling, which allowed a swing
    // several times the base delay and was the reason a "depth 0" setting still
    // delayed the signal by 13.8 ms instead of 4 ms.
    this.maxSwingSamples = Math.max(1, this.baseSamples - MIN_OFFSET_SAMPLES);
    this.maxSwingSeconds = this.maxSwingSamples / sr;
    // One ring PER CHANNEL. Sharing a single ring and alternating the write
    // (write L, read, write R, read) would leave the L read pointer looking at
    // a buffer whose every other sample is an R sample — an interleaved channel
    // swap, not a stereo image.
    this.delayL = new Float32Array(this.delayLen);
    this.delayR = new Float32Array(this.delayLen);
    this.pos = 0;

    this.wowPhase = 0;
    this.flutterPhase = 0;

    // Smoothed random walk for the `drift` term.
    const opt = options && options.processorOptions;
    const seed = typeof opt === "object" && opt !== null && Number.isFinite(opt.seed) ? opt.seed : 1;
    this.rng = wfRng(seed);
    this.driftValue = 0;
    this.driftTarget = 0;
    this.driftCoef = 1 - Math.exp(-2 * Math.PI * 3 * (1 / sr)); // ~3 Hz one-pole
    this.driftCountdown = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "wowRate", defaultValue: 0.5, minValue: 0.05, maxValue: 6, automationRate: "k-rate" },
      { name: "wowDepth", defaultValue: 10, minValue: 0, maxValue: 60, automationRate: "k-rate" },
      { name: "flutterRate", defaultValue: 11, minValue: 4, maxValue: 60, automationRate: "k-rate" },
      { name: "flutterDepth", defaultValue: 2.5, minValue: 0, maxValue: 20, automationRate: "k-rate" },
      { name: "drift", defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "output", defaultValue: 0, minValue: -12, maxValue: 12, automationRate: "k-rate" },
    ];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const sr = this.sr;

    const wowRate = clamp(pv(parameters, "wowRate", 0.5), 0.05, 6);
    const wowDepth = clamp(pv(parameters, "wowDepth", 10), 0, 60);
    const flutterRate = clamp(pv(parameters, "flutterRate", 11), 4, 60);
    const flutterDepth = clamp(pv(parameters, "flutterDepth", 2.5), 0, 20);
    const driftAmt = clamp(pv(parameters, "drift", 0.35), 0, 1);
    const mix = clamp(pv(parameters, "mix", 1), 0, 1);
    const outDb = clamp(pv(parameters, "output", 0), -12, 12);

    // Cents -> modulation amplitude, via the SHARED allocation in
    // wowflutter-math.js. That module is the single implementation: it clamps
    // each term to the swing budget and scales them down proportionally when
    // they overflow together, and the panel readout calls the same function to
    // print the cents it actually delivered. A second copy here would be a
    // second set of numbers to keep honest.
    const plan = wfSwingPlan({ wowDepth, wowRate, flutterDepth, flutterRate, sampleRate: sr });
    const wowAmp = plan.wowAmp;
    const flutterAmp = plan.flutterAmp;
    const driftAmp = plan.driftAmp;

    const wowStep = wowRate / sr;
    const flutterStep = flutterRate / sr;
    const gain = Math.pow(10, outDb / 20);
    const dryMix = 1 - mix;

    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    const inL = input && input[0] ? input[0] : null;
    const inR = input && input[1] ? input[1] : null;
    const frames = outL ? outL.length : 0;

    for (let i = 0; i < frames; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      this.wowPhase += wowStep;
      if (this.wowPhase > 1) this.wowPhase -= 1;
      this.flutterPhase += flutterStep;
      if (this.flutterPhase > 1) this.flutterPhase -= 1;

      // Drift target re-picks roughly every 350 ms and is walked toward, so the
      // wander is smooth instead of a stutter.
      if (this.driftCountdown-- <= 0) {
        this.driftCountdown = Math.floor(sr * 0.35);
        this.driftTarget = (this.rng() * 2 - 1) * driftAmt;
      }
      this.driftValue += this.driftCoef * (this.driftTarget - this.driftValue);

      // Signed wobble: sine wow + sine flutter + the wander.
      //
      // `driftValue` is already bounded by driftAmt <= 1, so `driftAmp` alone is
      // a valid bound for its contribution and the swing sum below is tight.
      const wobble =
        Math.sin(this.wowPhase * 2 * Math.PI) * wowAmp +
        Math.sin(this.flutterPhase * 2 * Math.PI) * flutterAmp +
        this.driftValue * driftAmp;
      // Centred so the read never goes negative (see the header). `wobble` is
      // NOT halved: halving it halves dD/dt, and therefore halves the pitch
      // deviation the knob just asked for — measured as exactly the 2x half of
      // the 500x conversion error.
      const swing = wowAmp + flutterAmp + driftAmp;
      const offset = this.baseSamples + swing * 0.5 * sr + wobble * sr;

      // Write both channels, then read both behind the write pointer with
      // linear interpolation. Both channels share ONE modulation value, so the
      // stereo image survives (see header, point 3).
      this.delayL[this.pos] = l;
      this.delayR[this.pos] = r;

      let readL = this.pos - offset;
      while (readL < 0) readL += this.delayLen;
      const i0 = readL | 0;
      const fracL = readL - i0;
      const i1 = i0 + 1 >= this.delayLen ? 0 : i0 + 1;
      const wetL = this.delayL[i0] * (1 - fracL) + this.delayL[i1] * fracL;

      let readR = this.pos - offset;
      while (readR < 0) readR += this.delayLen;
      const j0 = readR | 0;
      const fracR = readR - j0;
      const j1 = j0 + 1 >= this.delayLen ? 0 : j0 + 1;
      const wetR = this.delayR[j0] * (1 - fracR) + this.delayR[j1] * fracR;

      outL[i] = (l * dryMix + wetL * mix) * gain;
      if (outR) outR[i] = (r * dryMix + wetR * mix) * gain;

      this.pos++;
      if (this.pos >= this.delayLen) this.pos = 0;
    }
    return true;
  }
}

export function createWowFlutterProcessor(options) {
  return new WowFlutterProcessor(options);
}

registerProcessor("wowflutter-processor", WowFlutterProcessor);
