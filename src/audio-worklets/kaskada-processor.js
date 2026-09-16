/**
 * KYX Kaskáda — character stereo delay with ping-pong, modulation,
 * loop EQ (LP+HP), drive and freeze.
 *
 * Dual ring buffer (L,R) with linear interpolation for the fractional
 * read position. Per-channel biquad cascade in the feedback path
 * (LP 24 dB/oct + HP 24 dB/oct). Ping-pong crossfeeds L→R→L.
 *
 * All params are k-rate — updated once per block, no per-sample reads.
 * Freeze mode stops writing input to the buffer (infinite repeat).
 * Denormal flush on the feedback path prevents CPU spikes on silent tails.
 */

const MAX_DELAY_MS = 2000;
const SYNC_RATIO = [0, 1, 0.5, 1 / 3, 0.25, 1 / 6]; // off, 1/4, 1/8, 1/8T, 1/16, 1/16T
const TWO_PI = Math.PI * 2;

class KaskadaProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "time", defaultValue: 375, minValue: 30, maxValue: 2000, automationRate: "k-rate" },
      { name: "sync", defaultValue: 0, minValue: 0, maxValue: 5, automationRate: "k-rate" },
      { name: "bpm", defaultValue: 120, minValue: 40, maxValue: 240, automationRate: "k-rate" },
      { name: "pingPong", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "feedback", defaultValue: 0.35, minValue: 0, maxValue: 0.95, automationRate: "k-rate" },
      { name: "toneLp", defaultValue: 4500, minValue: 500, maxValue: 12000, automationRate: "k-rate" },
      { name: "toneHp", defaultValue: 150, minValue: 20, maxValue: 800, automationRate: "k-rate" },
      { name: "drive", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "modRate", defaultValue: 0.6, minValue: 0.1, maxValue: 8, automationRate: "k-rate" },
      { name: "modDepth", defaultValue: 0.15, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "spread", defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "freeze", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "character", defaultValue: 1, minValue: 0, maxValue: 2, automationRate: "k-rate" },
      { name: "mix", defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "level", defaultValue: -6, minValue: -24, maxValue: 6, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.sr = sampleRate;
    this.bufSize = Math.ceil((MAX_DELAY_MS / 1000) * this.sr) + 1;
    this.bufL = new Float32Array(this.bufSize);
    this.bufR = new Float32Array(this.bufSize);
    this.writePos = 0;
    this.lfoPhase = 0;

    // Cached state (avoids reading params per-sample)
    this.delaySamples = 1;
    this.fbGain = 0.35;
    this.mix = 0.25;
    this.outGain = Math.pow(10, -6 / 20);
    this.pingPong = false;
    this.freeze = false;
    this.drive = 0;
    this.spread = 0.8;
    this.modDepthMs = 0;
    this.character = 1;

    // Loop EQ biquads (2× LP cascade + 2× HP cascade = 24 dB/oct per side)
    this.lp1L = this.makeBiquad(); this.lp1R = this.makeBiquad();
    this.lp2L = this.makeBiquad(); this.lp2R = this.makeBiquad();
    this.hp1L = this.makeBiquad(); this.hp1R = this.makeBiquad();
    this.hp2L = this.makeBiquad(); this.hp2R = this.makeBiquad();
    this.lpL1c = this.lpCoeffs(4500, this.sr);
    this.lpR1c = this.lpCoeffs(4500, this.sr);
    this.hpL1c = this.hpCoeffs(150, this.sr);
    this.hpR1c = this.hpCoeffs(150, this.sr);

    // Character LP (one-pole per channel for tape/analog darkening)
    this.charLpz = 0;
    this.charRpz = 0;
    this.charLpCoef = 1 - Math.exp((-2 * Math.PI * 3500) / this.sr);

    // LFO state
    this.lfoPhase = 0;

    // Param change detection
    this._lastTimeMs = -1;
    this._lastSync = -1;
    this._lastBpm = -1;
    this._lastToneLp = -1;
    this._lastToneHp = -1;
  }

  makeBiquad() {
    return { x1: 0, x2: 0, y1: 0, y2: 0 };
  }

  lpCoeffs(freq, sr) {
    const w0 = (2 * Math.PI * freq) / sr;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 / Math.SQRT2);
    const a0 = 1 + alpha;
    return {
      b0: ((1 - cos) / 2) / a0,
      b1: ((1 - cos) / 1) / a0,
      b2: ((1 - cos) / 2) / a0,
      a1: (-2 * cos) / a0,
      a2: (1 - alpha) / a0,
    };
  }

  hpCoeffs(freq, sr) {
    const w0 = (2 * Math.PI * freq) / sr;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 / Math.SQRT2);
    const a0 = 1 + alpha;
    return {
      b0: ((1 + cos) / 2) / a0,
      b1: (-(1 + cos)) / a0,
      b2: ((1 + cos) / 2) / a0,
      a1: (-2 * cos) / a0,
      a2: (1 - alpha) / a0,
    };
  }

  applyBiquad(state, coeffs, x) {
    const y = coeffs.b0 * x + coeffs.b1 * state.x1 + coeffs.b2 * state.x2
      - coeffs.a1 * state.y1 - coeffs.a2 * state.y2;
    state.x2 = state.x1; state.x1 = x;
    state.y2 = state.y1;
    const clean = Math.abs(y) < 1e-20 ? 0 : y;
    state.y1 = clean;
    return clean;
  }

  /** Linear-interpolated read from a ring buffer at a fractional position. */
  readBuffer(buf, pos) {
    const size = this.bufSize;
    let p = pos % size;
    if (p < 0) p += size;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const i1 = (i0 + 1) % size;
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }

  process(inputs, outputs, params) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const input = inputs[0];
    const hasInput = input && input[0];
    const outL = output[0];
    const outR = output[1] ?? output[0];

    // ── Resolve delay time (sync or free) ──
    const timeMs = params.time[0];
    const sync = Math.round(params.sync[0]);
    const bpm = params.bpm[0];
    if (sync !== this._lastSync || bpm !== this._lastBpm || timeMs !== this._lastTimeMs) {
      this._lastSync = sync;
      this._lastBpm = bpm;
      this._lastTimeMs = timeMs;
      if (sync > 0 && sync < SYNC_RATIO.length) {
        this.delaySamples = Math.min(
          this.bufSize - 1,
          Math.max(1, SYNC_RATIO[sync] * (60 / bpm) * this.sr),
        );
      } else {
        this.delaySamples = Math.min(
          this.bufSize - 1,
          Math.max(1, (timeMs / 1000) * this.sr),
        );
      }
    }

    // ── Update biquads when tone freq changes ──
    const toneLpHz = params.toneLp[0];
    const toneHpHz = params.toneHp[0];
    if (toneLpHz !== this._lastToneLp) {
      this._lastToneLp = toneLpHz;
      this.lpL1c = this.lpCoeffs(toneLpHz, this.sr);
      this.lpR1c = this.lpCoeffs(toneLpHz, this.sr);
    }
    if (toneHpHz !== this._lastToneHp) {
      this._lastToneHp = toneHpHz;
      this.hpL1c = this.hpCoeffs(toneHpHz, this.sr);
      this.hpR1c = this.hpCoeffs(toneHpHz, this.sr);
    }

    // ── Cache scalar params ──
    this.pingPong = params.pingPong[0] > 0.5;
    this.fbGain = params.feedback[0];
    this.drive = params.drive[0];
    this.spread = params.spread[0];
    this.freeze = params.freeze[0] > 0.5;
    this.character = Math.round(params.character[0]);
    this.mix = params.mix[0];
    this.outGain = Math.pow(10, params.level[0] / 20);
    this.modDepthMs = params.modDepth[0] * this.delaySamples * 0.25;
    this.mix = params.mix[0];

    const pingPong = this.pingPong;
    const fbGain = this.freeze ? 0.99 : this.fbGain;
    const drive = this.drive;
    const driveGain = 1 + drive * 6;
    const mix = this.mix;
    const spread = this.spread;
    const modDepthMs = this.modDepthMs;
    const modRateInc = (TWO_PI * params.modRate[0]) / this.sr;
    const character = this.character;

    const L = this.bufL, R = this.bufR;
    const size = this.bufSize;
    const driveNorm = 1 / Math.max(1, Math.tanh(driveGain));

    for (let i = 0; i < outL.length; i++) {
      const writeIdx = this.writePos;

      // LFO modulated delay time (pitch drift, click-free fractional read)
      const lfo = Math.sin(this.lfoPhase);
      this.lfoPhase += modRateInc;
      if (this.lfoPhase > TWO_PI) this.lfoPhase -= TWO_PI;
      const delayPos = this.delaySamples + lfo * modDepthMs;

      // Fractional reads (linear interpolation)
      let wetL = this.readBuffer(L, writeIdx - delayPos);
      let wetR = this.readBuffer(R, writeIdx - delayPos);

      // Character colour (per-repeat darkening in feedback)
      if (character === 1) {
        // Tape: one-pole LP + mild saturation
        this.charLpz += this.charLpCoef * (wetL - this.charLpz);
        this.charRpz += this.charLpCoef * (wetR - this.charRpz);
        wetL = this.charLpz;
        wetR = this.charRpz;
      } else if (character === 2) {
        // Analog: darker, more lossy
        this.charLpz += this.charLpCoef * (wetL - this.charLpz);
        this.charRpz += this.charLpCoef * (wetR - this.charRpz);
        wetL = this.charLpz * 0.9;
        wetR = this.charRpz * 0.9;
      }

      // Loop EQ: LP 24 dB/oct then HP 24 dB/oct (per channel)
      wetL = this.applyBiquad(this.lp1L, this.lpL1c, wetL);
      wetL = this.applyBiquad(this.lp2L, this.lpL1c, wetL);
      wetL = this.applyBiquad(this.hp1L, this.hpL1c, wetL);
      wetL = this.applyBiquad(this.hp2L, this.hpL1c, wetL);
      wetR = this.applyBiquad(this.lp1R, this.lpR1c, wetR);
      wetR = this.applyBiquad(this.lp2R, this.lpR1c, wetR);
      wetR = this.applyBiquad(this.hp1R, this.hpR1c, wetR);
      wetR = this.applyBiquad(this.hp2R, this.hpR1c, wetR);

      // Drive in feedback (tanh saturation)
      if (drive > 0) {
        wetL = Math.tanh(wetL * driveGain) * driveNorm;
        wetR = Math.tanh(wetR * driveGain) * driveNorm;
      }

      // Ping-pong crossfeed
      const fbL = pingPong ? wetR : wetL;
      const fbR = pingPong ? wetL : wetR;

      // Write to ring buffer (input + feedback, frozen skips new input)
      const inL = hasInput ? input[0][i] : 0;
      const inR = hasInput && input[1] ? input[1][i] : inL;
      if (!this.freeze) {
        L[writeIdx] = inL + fbL * fbGain;
        R[writeIdx] = inR + fbR * fbGain;
      }

      // Stereo spread (cross-mix for width)
      const outWL = wetL + spread * 0.5 * (wetR - wetL);
      const outWR = wetR + spread * 0.5 * (wetL - wetR);

      // Output: dry + wet (mix)
      outL[i] = inL * (1 - mix) + outWL * mix * this.outGain;
      outR[i] = inR * (1 - mix) + outWR * mix * this.outGain;

      this.writePos = (writeIdx + 1) % size;
    }

    return true;
  }
}

registerProcessor("kaskada", KaskadaProcessor);
