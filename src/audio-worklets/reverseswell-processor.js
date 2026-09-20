/**
 * Reverse Swell AudioWorkletProcessor — a live reverse-envelope riser.
 *
 * The classic "reverse cymbal before the drop" trick normally needs an
 * offline-reversed sample. This processor does it LIVE: a ring buffer records
 * the incoming signal at all times; on a trigger (`engaged` 0→1) the read
 * head is anchored at the write head and sweeps BACKWARDS through the last
 * `reach` seconds while a rising envelope multiplies the output — a riser
 * built from whatever the track is already playing.
 *
 * Signal flow per sample:
 *   1. write the dry input into the ring buffer (always, so a trigger always
 *      has fresh material)
 *   2. on trigger, capture `anchor = writePos` and reset the swell clock
 *   3. read backwards: readPos = anchor − progress · reach · sr
 *   4. envelope: env = progress^k where k = 1 + curve·4 (exponential rise at
 *      high curve — the musical reverse-swell shape)
 *   5. wet = reverseRead · env · level, smoothed with a ~4 ms one-pole so a
 *      trigger release or a swell end can never click
 *
 * `time` is the swell DURATION; `reach` is how much material it plays. Their
 * ratio is the reverse playback rate: reach = time is a straight reverse
 * (rate −1), reach > time stretches it (tape-slow dive), reach < time speeds
 * it up (rising octave-ish chirp).
 *
 * After the swell completes the wet path falls silent (dry remains at
 * 1 − mix), which is exactly the "drop lands here" gesture.
 *
 * Determinism: zero randomness and a zero-initialised clock — two renders of
 * the same document are bit-identical (offline parity).
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */
const RS_MAX_SWELL_SEC = 8;

/** Read a k-rate parameter defensively (missing → fallback). */
function rsPv(parameters, name, fallback) {
  const p = parameters[name];
  if (!p || p.length === 0) return fallback;
  const v = p[0];
  return Number.isFinite(v) ? v : fallback;
}

function rsClamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

class ReverseSwellProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = globalThis.sampleRate || 44100;
    this.sr = sr;
    // 9 s stereo ring buffer: the longest swell (8 s) plus headroom so a
    // freshly armed processor always has full reach available.
    this.bufferLen = Math.ceil(sr * (RS_MAX_SWELL_SEC + 1));
    this.bufL = new Float32Array(this.bufferLen);
    this.bufR = new Float32Array(this.bufferLen);
    this.writePos = 0;
    /** Previous `engaged` state — the 0→1 edge starts a swell. */
    this.armed = false;
    /** Write head captured at the trigger: the reverse window's end. */
    this.anchor = 0;
    /** Wall samples since the trigger. */
    this.elapsed = 0;
    /** Smoothed swell envelope 0..1 — drives BOTH the wet gain and the dry
     *  duck (so idle passes the track through and the swell takes over). */
    this.envSmoothed = 0;
    // Wet tone one-pole (per channel).
    this.toneLpL = 0;
    this.toneLpR = 0;
    this.lastToneHz = -1;
    this.toneCoef = 1;
  }

  static get parameterDescriptors() {
    return [
      { name: "engaged", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "time", defaultValue: 2, minValue: 0.25, maxValue: RS_MAX_SWELL_SEC, automationRate: "k-rate" },
      { name: "reach", defaultValue: 2, minValue: 0.25, maxValue: RS_MAX_SWELL_SEC, automationRate: "k-rate" },
      { name: "curve", defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "tone", defaultValue: 12000, minValue: 500, maxValue: 16000, automationRate: "k-rate" },
      { name: "level", defaultValue: 0, minValue: -24, maxValue: 12, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  readSample(pos) {
    const len = this.bufferLen;
    let p = pos % len;
    if (p < 0) p += len;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const i1 = (i0 + 1) % len;
    return this.bufL[i0] * (1 - frac) + this.bufL[i1] * frac;
  }

  readSampleR(pos) {
    const len = this.bufferLen;
    let p = pos % len;
    if (p < 0) p += len;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const i1 = (i0 + 1) % len;
    return this.bufR[i0] * (1 - frac) + this.bufR[i1] * frac;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const outL = output[0];
    const outR = output.length > 1 && output[1] ? output[1] : null;
    const input = inputs[0];
    const inL = input && input[0] && input[0].length ? input[0] : null;
    const inR = input && input.length > 1 && input[1] && input[1].length ? input[1] : null;
    const len = outL.length;
    const sr = this.sr;

    const engaged = rsPv(parameters, "engaged", 0) >= 0.5;
    const swellSec = rsClamp(rsPv(parameters, "time", 2), 0.25, RS_MAX_SWELL_SEC);
    const reachSec = rsClamp(rsPv(parameters, "reach", 2), 0.25, RS_MAX_SWELL_SEC);
    const curve = rsClamp(rsPv(parameters, "curve", 0.6), 0, 1);
    const toneHz = rsClamp(rsPv(parameters, "tone", 12000), 500, 16000);
    const levelLin = Math.pow(10, rsClamp(rsPv(parameters, "level", 0), -24, 12) / 20);
    const mix = rsClamp(rsPv(parameters, "mix", 1), 0, 1);

    // Trigger edge: a fresh 0→1 latch re-anchors the reverse window.
    if (engaged && !this.armed) {
      this.anchor = this.writePos;
      this.elapsed = 0;
      this.armed = true;
    } else if (!engaged) {
      this.armed = false;
    }

    if (toneHz !== this.lastToneHz) {
      this.lastToneHz = toneHz;
      this.toneCoef = 1 - Math.exp((-2 * Math.PI * toneHz) / sr);
    }

    const swellSamples = Math.max(1, swellSec * sr);
    const reachSamples = reachSec * sr;
    // Exponential rise: env = progress^k, k 1..5.
    const k = 1 + curve * 4;
    // ~4 ms gain smoothing — de-clicks trigger release and the swell end.
    const smoothCoef = 1 - Math.exp(-1 / (sr * 0.004));

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // Record always — a trigger must always find fresh material.
      this.bufL[this.writePos % this.bufferLen] = l;
      this.bufR[this.writePos % this.bufferLen] = r;
      this.writePos += 1;

      // Swell envelope for this sample (0 when idle or finished).
      let env = 0;
      if (this.armed) {
        const progress = this.elapsed / swellSamples;
        if (progress < 1) env = Math.pow(progress, k);
        this.elapsed += 1;
      }

      let wetL = 0;
      let wetR = 0;
      if (env > 0) {
        // Reverse read: from the anchor (newest) backwards through `reach`.
        const progress = this.elapsed / swellSamples;
        const readPos = this.anchor - 1 - progress * reachSamples;
        wetL = this.readSample(readPos);
        wetR = this.readSampleR(readPos);
      }

      // Wet tone trim (one-pole LP per channel) before the envelope.
      this.toneLpL += (wetL - this.toneLpL) * this.toneCoef;
      this.toneLpR += (wetR - this.toneLpR) * this.toneCoef;

      // The smoothed envelope drives the whole gesture: idle (env 0) passes
      // the track through untouched, and as the swell rises the dry signal is
      // ducked by the same curve — one continuous crossfade, no clicks.
      this.envSmoothed += (env - this.envSmoothed) * smoothCoef;
      if (this.envSmoothed < 1e-20) this.envSmoothed = 0;
      const dryGain = 1 - mix * this.envSmoothed;
      const wetGain = mix * this.envSmoothed * levelLin;

      outL[i] = l * dryGain + this.toneLpL * wetGain;
      if (outR) outR[i] = r * dryGain + this.toneLpR * wetGain;
    }
    return true;
  }
}

registerProcessor("reverseswell-processor", ReverseSwellProcessor);
