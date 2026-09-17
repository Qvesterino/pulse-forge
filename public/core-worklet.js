/* KYX core AudioWorklet bundle — generated. Do not edit. */
"use strict";
(() => {
  // src/audio-worklets/sidechain-processor.js
  var SQRT2 = 1.4142135623730951;
  var SidechainProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.env = 0;
      this.lpL = { x1: 0, x2: 0, y1: 0, y2: 0 };
      this.lpR = { x1: 0, x2: 0, y1: 0, y2: 0 };
      this.lpB0 = 0;
      this.lpB1 = 0;
      this.lpB2 = 0;
      this.lpA1 = 0;
      this.lpA2 = 0;
      this.lastSplitFreq = -1;
    }
    static get parameterDescriptors() {
      return [
        { name: "threshold", defaultValue: -18, minValue: -60, maxValue: 0, automationRate: "k-rate" },
        { name: "ratio", defaultValue: 4, minValue: 1, maxValue: 20, automationRate: "k-rate" },
        { name: "attack", defaultValue: 5e-3, minValue: 1e-3, maxValue: 0.5, automationRate: "k-rate" },
        { name: "release", defaultValue: 0.2, minValue: 0.02, maxValue: 1, automationRate: "k-rate" },
        { name: "amount", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "splitFreq", defaultValue: 0, minValue: 0, maxValue: 500, automationRate: "k-rate" }
      ];
    }
    /**
     * Recompute 2-pole Butterworth LP coefficients for a given cutoff frequency.
     * Only recalculated when splitFreq changes (typically once per block).
     */
    updateLPCoefficients(f) {
      const K = Math.tan(Math.PI * f / (globalThis.sampleRate || 44100));
      const K2 = K * K;
      const a0 = 1 + SQRT2 * K + K2;
      this.lpB0 = K2 / a0;
      this.lpB1 = 2 * K2 / a0;
      this.lpB2 = K2 / a0;
      this.lpA1 = 2 * (K2 - 1) / a0;
      this.lpA2 = (1 - SQRT2 * K + K2) / a0;
    }
    /**
     * Single-sample 2-pole Butterworth LP. Must be called per channel with its
     * own state (x1, x2, y1, y2 passed by reference).
     */
    lpFilter(x, state) {
      const y = this.lpB0 * x + this.lpB1 * state.x1 + this.lpB2 * state.x2 - this.lpA1 * state.y1 - this.lpA2 * state.y2;
      state.x2 = state.x1;
      state.x1 = x;
      state.y2 = state.y1;
      state.y1 = y;
      if (Math.abs(state.x1) < 1e-20) state.x1 = 0;
      if (Math.abs(state.x2) < 1e-20) state.x2 = 0;
      if (Math.abs(state.y1) < 1e-20) state.y1 = 0;
      if (Math.abs(state.y2) < 1e-20) state.y2 = 0;
      if (Math.abs(y) < 1e-20) return 0;
      return y;
    }
    process(inputs, outputs, parameters) {
      const main = inputs[0];
      const sidechain = inputs[1];
      const output = outputs[0];
      if (!sidechain || !sidechain[0] || !sidechain[0].length) {
        if (main && main[0] && output && output[0]) {
          for (let ch = 0; ch < Math.min(main.length, output.length); ch++) {
            output[ch].set(main[ch]);
          }
        }
        return true;
      }
      if (!main || !main[0] || !output || !output[0]) return true;
      const threshold = parameters.threshold;
      const ratio = parameters.ratio;
      const attack = parameters.attack;
      const release = parameters.release;
      const amount = parameters.amount;
      const splitFreq = parameters.splitFreq[0];
      const sidechainLen = sidechain[0].length;
      const mainLen = main[0].length;
      const len = Math.min(mainLen, sidechainLen);
      const sr = globalThis.sampleRate ?? 44100;
      const splitActive = splitFreq > 10;
      if (splitActive && splitFreq !== this.lastSplitFreq) {
        this.updateLPCoefficients(splitFreq);
        this.lastSplitFreq = splitFreq;
      }
      for (let i = 0; i < len; i++) {
        const sidePeak = Math.abs(sidechain[0][i]);
        const thresh = threshold.length > 1 ? threshold[i] : threshold[0];
        const rat = ratio.length > 1 ? ratio[i] : ratio[0];
        const att = attack.length > 1 ? attack[i] : attack[0];
        const rel = release.length > 1 ? release[i] : release[0];
        const amt = amount.length > 1 ? amount[i] : amount[0];
        const attCoef = Math.exp(-1 / (sr * Math.max(1e-3, att)));
        const relCoef = Math.exp(-1 / (sr * Math.max(1e-3, rel)));
        this.env = sidePeak > this.env ? attCoef * this.env + (1 - attCoef) * sidePeak : relCoef * this.env + (1 - relCoef) * sidePeak;
        if (Math.abs(this.env) < 1e-20) this.env = 0;
        const envDb = 20 * Math.log10(Math.max(this.env, 1e-7));
        const threshDb = 20 * Math.log10(Math.max(Math.pow(10, thresh / 20), 1e-7));
        const overDb = Math.max(0, envDb - threshDb);
        const reductionDb = overDb * (1 - 1 / Math.max(1, rat));
        const reduction = Math.pow(10, -reductionDb / 20);
        const gain = Math.max(0, 1 - amt * (1 - reduction));
        if (splitActive) {
          for (let ch = 0; ch < Math.min(main.length, output.length); ch++) {
            const x = main[ch][i];
            const st = ch === 0 ? this.lpL : this.lpR;
            const low = this.lpFilter(x, st);
            const high = x - low;
            output[ch][i] = low * gain + high;
          }
        } else {
          for (let ch = 0; ch < Math.min(main.length, output.length); ch++) {
            output[ch][i] = main[ch][i] * gain;
          }
        }
      }
      for (let i = len; i < mainLen; i++) {
        for (let ch = 0; ch < Math.min(main.length, output.length); ch++) {
          output[ch][i] = main[ch][i];
        }
      }
      return true;
    }
  };
  registerProcessor("sidechain-processor", SidechainProcessor);

  // src/audio-worklets/transient-processor.js
  var TransientProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.envelope = 0;
      this.fast = 0;
      this.slow = 0;
    }
    static get parameterDescriptors() {
      return [
        { name: "attack", defaultValue: 0.25, minValue: -1, maxValue: 1, automationRate: "k-rate" },
        { name: "sustain", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "k-rate" },
        { name: "sensitivity", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "output", defaultValue: 0, minValue: -24, maxValue: 24, automationRate: "k-rate" }
      ];
    }
    process(inputs, outputs, parameters) {
      const input = inputs[0];
      const output = outputs[0];
      if (!input || !input[0] || !output || !output[0]) return true;
      const sr = globalThis.sampleRate || 44100;
      const attack = parameters.attack;
      const sustain = parameters.sustain;
      const sensitivity = parameters.sensitivity;
      const mix = parameters.mix;
      const outputDb = parameters.output;
      const channels = Math.min(input.length, output.length);
      for (let i = 0; i < output[0].length; i++) {
        let peak = 0;
        for (let ch = 0; ch < channels; ch++) peak = Math.max(peak, Math.abs(input[ch][i] || 0));
        const fastCoef = Math.exp(-1 / (sr * 4e-3));
        const slowCoef = Math.exp(-1 / (sr * 0.08));
        this.fast = fastCoef * this.fast + (1 - fastCoef) * peak;
        this.slow = slowCoef * this.slow + (1 - slowCoef) * peak;
        if (Math.abs(this.fast) < 1e-20) this.fast = 0;
        if (Math.abs(this.slow) < 1e-20) this.slow = 0;
        const transient = Math.max(-1, Math.min(1, (this.fast - this.slow) * (3 + sensitivity * 9)));
        const shape = Math.max(
          0.1,
          1 + transient * (attack.length > 1 ? attack[i] : attack[0]) + this.slow * (sustain.length > 1 ? sustain[i] : sustain[0])
        );
        const wet = mix.length > 1 ? mix[i] : mix[0];
        const gain = Math.pow(10, (outputDb.length > 1 ? outputDb[i] : outputDb[0]) / 20);
        for (let ch = 0; ch < channels; ch++) output[ch][i] = input[ch][i] * (1 + (shape - 1) * wet) * gain;
      }
      return true;
    }
  };
  registerProcessor("transient-processor", TransientProcessor);

  // src/audio-worklets/gate-processor.js
  var GateProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.envelope = 0;
      this.gain = 0;
      this.holdSamples = 0;
    }
    static get parameterDescriptors() {
      return [
        { name: "threshold", defaultValue: -36, minValue: -80, maxValue: 0, automationRate: "k-rate" },
        { name: "attack", defaultValue: 2e-3, minValue: 1e-4, maxValue: 0.5, automationRate: "k-rate" },
        { name: "hold", defaultValue: 0.02, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "release", defaultValue: 0.08, minValue: 1e-3, maxValue: 2, automationRate: "k-rate" },
        { name: "range", defaultValue: -48, minValue: -80, maxValue: 0, automationRate: "k-rate" },
        { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }
      ];
    }
    process(inputs, outputs, parameters) {
      const input = inputs[0];
      const output = outputs[0];
      if (!input || !input[0] || !output || !output[0]) return true;
      const sr = globalThis.sampleRate || 44100;
      const channels = Math.min(input.length, output.length);
      for (let i = 0; i < output[0].length; i++) {
        let peak = 0;
        for (let ch = 0; ch < channels; ch++) peak = Math.max(peak, Math.abs(input[ch][i] || 0));
        const threshold = parameters.threshold.length > 1 ? parameters.threshold[i] : parameters.threshold[0];
        const attack = parameters.attack.length > 1 ? parameters.attack[i] : parameters.attack[0];
        const hold = parameters.hold.length > 1 ? parameters.hold[i] : parameters.hold[0];
        const release = parameters.release.length > 1 ? parameters.release[i] : parameters.release[0];
        const range = parameters.range.length > 1 ? parameters.range[i] : parameters.range[0];
        const mix = parameters.mix.length > 1 ? parameters.mix[i] : parameters.mix[0];
        const envCoef = Math.exp(
          -1 / (sr * (peak > this.envelope ? Math.max(1e-4, attack) : Math.max(1e-3, release)))
        );
        this.envelope = envCoef * this.envelope + (1 - envCoef) * peak;
        if (Math.abs(this.envelope) < 1e-20) this.envelope = 0;
        if (20 * Math.log10(Math.max(this.envelope, 1e-7)) >= threshold)
          this.holdSamples = Math.max(this.holdSamples, Math.round(hold * sr));
        else this.holdSamples = Math.max(0, this.holdSamples - 1);
        const target = this.holdSamples > 0 ? 1 : Math.pow(10, range / 20);
        const step = target > this.gain ? 1 / Math.max(1, sr * Math.max(1e-4, attack)) : 1 / Math.max(1, sr * Math.max(1e-3, release));
        this.gain += (target - this.gain) * Math.min(1, step);
        if (Math.abs(this.gain) < 1e-20) this.gain = 0;
        for (let ch = 0; ch < channels; ch++) output[ch][i] = input[ch][i] * (1 + (this.gain - 1) * mix);
      }
      return true;
    }
  };
  registerProcessor("gate-processor", GateProcessor);

  // src/audio-worklets/limiter-processor.js
  var MaxDeque = class {
    constructor(capacity) {
      this.idx = new Float64Array(capacity);
      this.val = new Float32Array(capacity);
      this.head = 0;
      this.tail = 0;
      this.count = 0;
    }
    push(value, absIdx) {
      const cap = this.val.length;
      while (this.count > 0) {
        const back = (this.tail - 1 + cap) % cap;
        if (this.val[back] <= value) {
          this.tail = back;
          this.count--;
        } else break;
      }
      this.idx[this.tail] = absIdx;
      this.val[this.tail] = value;
      this.tail = (this.tail + 1) % cap;
      this.count++;
    }
    /** Max value among entries with idx >= minIdx. */
    front(minIdx) {
      const cap = this.val.length;
      while (this.count > 0 && this.idx[this.head] < minIdx) {
        this.head = (this.head + 1) % cap;
        this.count--;
      }
      return this.count > 0 ? this.val[this.head] : 0;
    }
  };
  var LimiterProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      const sr = globalThis.sampleRate || 44100;
      const cap = 1 << Math.ceil(Math.log2(0.03 * sr + 256));
      this.cap = cap;
      this.delayL = new Float32Array(cap);
      this.delayR = new Float32Array(cap);
      this.linked = new MaxDeque(cap);
      this.leftPeak = new MaxDeque(cap);
      this.rightPeak = new MaxDeque(cap);
      this.step = 0;
      this.gainL = 1;
      this.gainR = 1;
      this.postedGr = -1;
      this.grAccumulator = 0;
      this.grWindowStart = typeof globalThis.currentTime === "number" ? globalThis.currentTime : 0;
    }
    static get parameterDescriptors() {
      return [
        { name: "threshold", defaultValue: -6, minValue: -24, maxValue: 0, automationRate: "k-rate" },
        { name: "ceiling", defaultValue: -1, minValue: -12, maxValue: 0, automationRate: "k-rate" },
        { name: "release", defaultValue: 0.12, minValue: 0.01, maxValue: 1, automationRate: "k-rate" },
        { name: "lookahead", defaultValue: 5e-3, minValue: 1e-3, maxValue: 0.02, automationRate: "k-rate" },
        { name: "link", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }
      ];
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
      const sr = globalThis.sampleRate || 44100;
      const ceilingDb = parameters.ceiling[0];
      const ceilingLin = Math.pow(10, ceilingDb / 20);
      const thresholdDb = parameters.threshold[0];
      const releaseSec = parameters.release[0];
      const laSamples = Math.max(1, Math.min(this.cap - 2, Math.round(parameters.lookahead[0] * sr)));
      const link = parameters.link[0];
      const mix = parameters.mix[0];
      const perChannel = outR !== null && link < 0.999;
      const attackCoef = 1 - Math.exp(-1 / (sr * 5e-4));
      let blockGrDb = 0;
      for (let i = 0; i < len; i++, this.step++) {
        const l = inL ? inL[i] : 0;
        const r = inR ? inR[i] : l;
        const s = this.step;
        const w = s % this.cap;
        this.delayL[w] = l;
        this.delayR[w] = r;
        const absL = l < 0 ? -l : l;
        const absR = r < 0 ? -r : r;
        const linked = absL > absR ? absL : absR;
        const windowStart = s - laSamples;
        this.linked.push(linked, s);
        if (perChannel) {
          this.leftPeak.push(absL, s);
          this.rightPeak.push(absR, s);
        }
        const peakLinked = this.linked.front(windowStart);
        let targetLinked = 1;
        if (peakLinked > 1e-8) {
          const peakDb = 20 * Math.log10(peakLinked);
          const over = peakDb - thresholdDb;
          if (over > 0) {
            const gDb = Math.min(0, Math.min(1, over / 3) * (ceilingDb - peakDb));
            targetLinked = Math.pow(10, gDb / 20);
          }
        }
        let targetL = targetLinked;
        let targetR = targetLinked;
        if (perChannel) {
          const applyKnee = (peak) => {
            if (peak <= 1e-8) return 1;
            const peakDb = 20 * Math.log10(peak);
            const over = peakDb - thresholdDb;
            if (over <= 0) return 1;
            const gDb = Math.min(0, Math.min(1, over / 3) * (ceilingDb - peakDb));
            return Math.pow(10, gDb / 20);
          };
          const gl = applyKnee(this.leftPeak.front(windowStart));
          const gr2 = applyKnee(this.rightPeak.front(windowStart));
          targetL = link * targetLinked + (1 - link) * gl;
          targetR = link * targetLinked + (1 - link) * gr2;
        }
        this.gainL = this.smoothGain(this.gainL, targetL, sr, releaseSec, attackCoef);
        this.gainR = this.smoothGain(this.gainR, targetR, sr, releaseSec, attackCoef);
        if (Math.abs(this.gainL) < 1e-20) this.gainL = 0;
        if (Math.abs(this.gainR) < 1e-20) this.gainR = 0;
        const readIdx = ((s - laSamples) % this.cap + this.cap) % this.cap;
        let wetL = this.delayL[readIdx] * this.gainL;
        let wetR = this.delayR[readIdx] * this.gainR;
        if (wetL > ceilingLin) wetL = ceilingLin;
        else if (wetL < -ceilingLin) wetL = -ceilingLin;
        if (wetR > ceilingLin) wetR = ceilingLin;
        else if (wetR < -ceilingLin) wetR = -ceilingLin;
        outL[i] = mix * wetL + (1 - mix) * this.delayL[readIdx];
        if (outR) outR[i] = mix * wetR + (1 - mix) * this.delayR[readIdx];
        const depth = 1 - (this.gainL < this.gainR ? this.gainL : this.gainR);
        if (depth > this.grAccumulator) this.grAccumulator = depth;
      }
      const now = typeof globalThis.currentTime === "number" ? globalThis.currentTime : this.grWindowStart + len / sr;
      if (now - this.grWindowStart >= 0.05) {
        const grDb = this.grAccumulator > 1e-4 ? Math.min(24, -20 * Math.log10(Math.max(1e-4, 1 - this.grAccumulator))) : 0;
        this.grAccumulator = 0;
        this.grWindowStart = now;
        if (grDb !== this.postedGr) {
          this.postedGr = grDb;
          this.port.postMessage({ type: "gr", gr: grDb });
        }
      }
      return true;
    }
    smoothGain(current, target, sr, releaseSec, attackCoef) {
      if (target < current) return target + (current - target) * (1 - attackCoef);
      const depth = 1 - current;
      const effRelease = Math.max(2e-3, releaseSec * (0.35 + 0.65 * Math.min(1, depth * 4)));
      const rc = 1 - Math.exp(-1 / (sr * effRelease));
      return current + (target - current) * rc;
    }
  };
  registerProcessor("limiter-processor", LimiterProcessor);

  // src/audio-worklets/envfollower-processor.js
  var EnvFollowerProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.env = 0;
      this.lastEnvPost = 0;
    }
    static get parameterDescriptors() {
      return [
        { name: "attack", defaultValue: 0.012, minValue: 1e-3, maxValue: 1, automationRate: "k-rate" },
        { name: "release", defaultValue: 0.18, minValue: 0.01, maxValue: 3, automationRate: "k-rate" },
        { name: "sensitivity", defaultValue: 1.5, minValue: 0.2, maxValue: 3, automationRate: "k-rate" }
      ];
    }
    process(inputs, outputs, parameters) {
      const output = outputs[0];
      if (!output || !output[0]) return true;
      const out = output[0];
      const input = inputs[0];
      const inL = input && input[0] && input[0].length ? input[0] : null;
      const inR = input && input.length > 1 && input[1] && input[1].length ? input[1] : null;
      const sr = globalThis.sampleRate || 44100;
      const atkBlend = 1 - Math.exp(-1 / (sr * Math.max(1e-3, parameters.attack[0])));
      const relBlend = 1 - Math.exp(-1 / (sr * Math.max(0.01, parameters.release[0])));
      const sens = Math.max(0.2, Math.min(3, parameters.sensitivity[0]));
      for (let i = 0; i < out.length; i++) {
        const l = inL ? inL[i] : 0;
        const r = inR ? inR[i] : l;
        const peak = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
        const driven = Math.tanh(peak * sens);
        this.env = driven > this.env ? this.env + (driven - this.env) * atkBlend : this.env + (driven - this.env) * relBlend;
        if (this.env < 1e-20) this.env = 0;
        out[i] = this.env;
      }
      const now = typeof globalThis.currentTime === "number" ? globalThis.currentTime : 0;
      if (now - this.lastEnvPost >= 0.04) {
        this.lastEnvPost = now;
        this.port.postMessage({ type: "env", value: this.env });
      }
      return true;
    }
  };
  registerProcessor("envfollower-processor", EnvFollowerProcessor);

  // src/audio-worklets/compressor-processor.js
  var CompressorProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.gain = 1;
      this.rms = 0;
      this.postL1 = 0;
      this.postR1 = 0;
      this.postL2 = 0;
      this.postR2 = 0;
      this.prevInL = 0;
      this.prevInR = 0;
      this.prevL1 = 0;
      this.prevR1 = 0;
      this.grAccumulator = 0;
      this.grWindowStart = typeof globalThis.currentTime === "number" ? globalThis.currentTime : 0;
      this.postedGr = -1;
    }
    static get parameterDescriptors() {
      return [
        { name: "threshold", defaultValue: -18, minValue: -60, maxValue: 0, automationRate: "k-rate" },
        { name: "ratio", defaultValue: 3, minValue: 1, maxValue: 20, automationRate: "k-rate" },
        { name: "attack", defaultValue: 0.01, minValue: 1e-3, maxValue: 0.5, automationRate: "k-rate" },
        { name: "release", defaultValue: 0.2, minValue: 0.02, maxValue: 1, automationRate: "k-rate" },
        { name: "knee", defaultValue: 6, minValue: 0, maxValue: 40, automationRate: "k-rate" },
        { name: "makeup", defaultValue: 1, minValue: 0, maxValue: 16, automationRate: "k-rate" },
        // linear (wrapper converts dB)
        { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "detector", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        // 0 = RMS, 1 = PEAK
        { name: "scHpf", defaultValue: 20, minValue: 20, maxValue: 500, automationRate: "k-rate" }
        // Hz
      ];
    }
    process(inputs, outputs, parameters) {
      const output = outputs[0];
      if (!output || !output[0]) return true;
      const outL = output[0];
      const outR = output.length > 1 && output[1] ? output[1] : null;
      const main = inputs[0];
      const mainL = main && main[0] && main[0].length ? main[0] : null;
      const mainR = main && main.length > 1 && main[1] && main[1].length ? main[1] : null;
      const side = inputs[1];
      const sideActive = !!(side && side[0] && side[0].length);
      const sideL = sideActive ? side[0] : null;
      const sideR = sideActive && side.length > 1 && side[1] && side[1].length ? side[1] : null;
      const len = outL.length;
      const sr = globalThis.sampleRate || 44100;
      const thresholdDb = parameters.threshold[0];
      const ratio = Math.max(1, parameters.ratio[0]);
      const slope = 1 - 1 / ratio;
      const knee = Math.max(0, parameters.knee[0]);
      const attackBlend = 1 - Math.exp(-1 / (sr * Math.max(1e-3, parameters.attack[0])));
      const releaseBlend = 1 - Math.exp(-1 / (sr * Math.max(0.02, parameters.release[0])));
      const makeupLin = Math.max(0, parameters.makeup[0]);
      const mix = parameters.mix[0];
      const peakMode = parameters.detector[0] >= 0.5;
      const hpfHz = parameters.scHpf[0];
      const hpfOn = sideActive && hpfHz > 25;
      const dt = 1 / sr;
      const rc = hpfOn ? 1 / (2 * Math.PI * Math.max(20, hpfHz)) : 0;
      const hpA = hpfOn ? rc / (rc + dt) : 0;
      for (let i = 0; i < len; i++) {
        const l = mainL ? mainL[i] : 0;
        const r = mainR ? mainR[i] : l;
        let dL = 0;
        let dR = 0;
        if (sideActive) {
          const sl = sideL ? sideL[i] : 0;
          const sr2 = sideR ? sideR[i] : sl;
          if (hpfOn) {
            const y1l = hpA * (this.postL1 + sl - this.prevInL);
            const y1r = hpA * (this.postR1 + sr2 - this.prevInR);
            const y2l = hpA * (this.postL2 + y1l - this.prevL1);
            const y2r = hpA * (this.postR2 + y1r - this.prevR1);
            this.prevInL = sl;
            this.prevInR = sr2;
            this.prevL1 = y1l;
            this.prevR1 = y1r;
            this.postL1 = y1l;
            this.postR1 = y1r;
            this.postL2 = y2l;
            this.postR2 = y2r;
            if (Math.abs(this.postL1) < 1e-20) this.postL1 = 0;
            if (Math.abs(this.postR1) < 1e-20) this.postR1 = 0;
            if (Math.abs(this.postL2) < 1e-20) this.postL2 = 0;
            if (Math.abs(this.postR2) < 1e-20) this.postR2 = 0;
            if (Math.abs(this.prevL1) < 1e-20) this.prevL1 = 0;
            if (Math.abs(this.prevR1) < 1e-20) this.prevR1 = 0;
            if (Math.abs(this.prevInL) < 1e-20) this.prevInL = 0;
            if (Math.abs(this.prevInR) < 1e-20) this.prevInR = 0;
            dL = y2l;
            dR = y2r;
            if (Math.abs(dL) < 1e-20) dL = 0;
            if (Math.abs(dR) < 1e-20) dR = 0;
          } else {
            dL = sl;
            dR = sr2;
          }
        } else {
          dL = l;
          dR = r;
        }
        const absL = dL < 0 ? -dL : dL;
        const absR = dR < 0 ? -dR : dR;
        const peak = absL > absR ? absL : absR;
        let level;
        if (peakMode) {
          level = peak;
        } else {
          this.rms = this.rms + (peak * peak - this.rms) * 6e-3;
          if (this.rms < 1e-20) this.rms = 0;
          level = Math.sqrt(this.rms);
        }
        let target = 1;
        if (level > 1e-8) {
          const levelDb = 20 * Math.log10(level);
          const over = levelDb - thresholdDb;
          if (over > -knee / 2) {
            let gr;
            if (over >= knee / 2) gr = over * slope;
            else {
              const t = over + knee / 2;
              gr = t * t * slope / (2 * knee);
            }
            if (gr > 0) target = Math.pow(10, -gr / 20);
          }
        }
        this.gain = target < this.gain ? this.gain + (target - this.gain) * attackBlend : this.gain + (target - this.gain) * releaseBlend;
        if (Math.abs(this.gain) < 1e-20) this.gain = 0;
        else if (this.gain < 1e-10) this.gain = 0;
        const gl = this.gain * makeupLin;
        const wetL = l * gl;
        const wetR = r * gl;
        outL[i] = l * (1 - mix) + wetL * mix;
        if (outR) outR[i] = r * (1 - mix) + wetR * mix;
        const depth = 1 - this.gain;
        if (depth > this.grAccumulator) this.grAccumulator = depth;
      }
      const now = typeof globalThis.currentTime === "number" ? globalThis.currentTime : this.grWindowStart + len / sr;
      if (now - this.grWindowStart >= 0.05) {
        const grDb = this.grAccumulator > 1e-4 ? Math.min(24, -20 * Math.log10(Math.max(1e-4, 1 - this.grAccumulator))) : 0;
        this.grAccumulator = 0;
        this.grWindowStart = now;
        if (grDb !== this.postedGr) {
          this.postedGr = grDb;
          this.port.postMessage({ type: "gr", gr: grDb });
        }
      }
      return true;
    }
  };
  registerProcessor("compressor-processor", CompressorProcessor);

  // src/audio-worklets/kwmeter-processor.js
  var KwMeterProcessor = class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const opts = options && options.processorOptions || {};
      const s1 = opts.s1 || [1, 0, 0, 0, 0];
      const s2 = opts.s2 || [1, 0, 0, 0, 0];
      this.s1 = s1;
      this.s2 = s2;
      this.x1 = [0, 0];
      this.x2 = [0, 0];
      this.y1 = [0, 0];
      this.y2 = [0, 0];
      this.u1 = [0, 0];
      this.u2 = [0, 0];
      this.w1 = [0, 0];
      this.w2 = [0, 0];
      const sr = globalThis.sampleRate || 48e3;
      this.subblockSamples = Math.max(1, Math.round(sr * 0.1));
      this.subCount = 0;
      this.subAccum = [0, 0];
      this.subPowers = [];
      this.integratedStart = 0;
      this.lastPost = 0;
      this.loudness = { m: -180, s: -180, i: -180 };
      this.port.onmessage = (event) => {
        const data = event.data;
        if (data && data.type === "reset") this.resetLoudness();
      };
    }
    loudnessOf(meanSquare) {
      return meanSquare > 1e-12 ? Math.max(-180, -0.691 + 10 * Math.log10(meanSquare)) : -180;
    }
    integratedLoudness() {
      const powers = this.subPowers;
      const start = this.integratedStart;
      const blocks = [];
      for (let k = start; k + 4 <= powers.length; k++) {
        blocks.push((powers[k] + powers[k + 1] + powers[k + 2] + powers[k + 3]) / 4);
      }
      if (blocks.length === 0) return -180;
      const audible = blocks.filter((ms) => this.loudnessOf(ms) > -70);
      if (audible.length === 0) return -180;
      const ungatedMean = audible.reduce((acc, ms) => acc + ms, 0) / audible.length;
      const relativeGate = -0.691 + 10 * Math.log10(ungatedMean) - 10;
      const gated = blocks.filter((ms) => this.loudnessOf(ms) >= Math.max(-70, relativeGate));
      if (gated.length === 0) return -180;
      const gatedMean = gated.reduce((acc, ms) => acc + ms, 0) / gated.length;
      return this.loudnessOf(gatedMean);
    }
    process(inputs, outputs, parameters) {
      void outputs;
      void parameters;
      const input = inputs[0];
      const inL = input && input[0] && input[0].length ? input[0] : null;
      const inR = input && input.length > 1 && input[1] && input[1].length ? input[1] : null;
      if (!inL) return true;
      const s1 = this.s1;
      const s2 = this.s2;
      for (let i = 0; i < inL.length; i++) {
        for (let ch = 0; ch < 2; ch++) {
          const x = ch === 0 ? inL[i] || 0 : inR ? inR[i] : inL[i] || 0;
          const shelf = s1[0] * x + s1[1] * this.x1[ch] + s1[2] * this.x2[ch] - s1[3] * this.y1[ch] - s1[4] * this.y2[ch];
          this.x2[ch] = this.x1[ch];
          this.x1[ch] = x;
          this.y2[ch] = this.y1[ch];
          this.y1[ch] = shelf;
          if (Math.abs(this.x1[ch]) < 1e-20) this.x1[ch] = 0;
          if (Math.abs(this.x2[ch]) < 1e-20) this.x2[ch] = 0;
          if (Math.abs(this.y1[ch]) < 1e-20) this.y1[ch] = 0;
          if (Math.abs(this.y2[ch]) < 1e-20) this.y2[ch] = 0;
          const hp = s2[0] * shelf + s2[1] * this.u1[ch] + s2[2] * this.u2[ch] - s2[3] * this.w1[ch] - s2[4] * this.w2[ch];
          this.u2[ch] = this.u1[ch];
          this.u1[ch] = shelf;
          this.w2[ch] = this.w1[ch];
          this.w1[ch] = hp;
          if (Math.abs(this.u1[ch]) < 1e-20) this.u1[ch] = 0;
          if (Math.abs(this.u2[ch]) < 1e-20) this.u2[ch] = 0;
          if (Math.abs(this.w1[ch]) < 1e-20) this.w1[ch] = 0;
          if (Math.abs(this.w2[ch]) < 1e-20) this.w2[ch] = 0;
          if (Math.abs(hp) < 1e-20) continue;
          this.subAccum[ch] += hp * hp;
        }
        this.subCount++;
        if (this.subCount >= this.subblockSamples) {
          const ms = (this.subAccum[0] + this.subAccum[1]) / this.subblockSamples;
          this.subPowers.push(ms);
          if (this.subPowers.length > 36e3) this.subPowers.splice(0, 18e3);
          this.subCount = 0;
          this.subAccum[0] = 0;
          this.subAccum[1] = 0;
          const n = this.subPowers.length;
          if (n >= 4) {
            const mPower = (this.subPowers[n - 1] + this.subPowers[n - 2] + this.subPowers[n - 3] + this.subPowers[n - 4]) / 4;
            this.loudness.m = this.loudnessOf(mPower);
          }
          if (n >= 30) {
            let acc = 0;
            for (let k = n - 30; k < n; k++) acc += this.subPowers[k];
            this.loudness.s = this.loudnessOf(acc / 30);
          }
          this.loudness.i = this.integratedLoudness();
        }
      }
      const now = typeof globalThis.currentTime === "number" ? globalThis.currentTime : 0;
      if (now - this.lastPost >= 0.1) {
        this.lastPost = now;
        this.port.postMessage({ type: "loudness", m: this.loudness.m, s: this.loudness.s, i: this.loudness.i });
      }
      return true;
    }
    resetLoudness() {
      this.integratedStart = this.subPowers.length;
      this.loudness = { m: this.loudness.m, s: this.loudness.s, i: -180 };
    }
  };
  registerProcessor("kwmeter-processor", KwMeterProcessor);

  // src/audio-worklets/stepgate-processor.js
  var GATE_DIVISION_BEATS = [4, 2, 1, 0.5, 0.25, 0.125];
  var StepGateProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.steps = [1, 0];
      this.phase = 0;
      this.bpm = 120;
      this.gain = 1;
      this.port.onmessage = (event) => {
        const d = event.data || {};
        if (d.type === "pattern" && Array.isArray(d.steps) && d.steps.length > 0) {
          this.steps = d.steps.map((v) => Math.min(1, Math.max(0, Number(v) || 0)));
        } else if (d.type === "align") {
          const stepBeats = GATE_DIVISION_BEATS[Math.max(0, Math.min(GATE_DIVISION_BEATS.length - 1, Math.round(this.divisionValue ?? 4)))];
          this.phase = Math.floor((d.phase || 0) / stepBeats) * stepBeats;
        } else if (d.type === "bpm") {
          this.bpm = Math.max(20, Math.min(300, d.bpm || 120));
        }
      };
    }
    static get parameterDescriptors() {
      return [
        { name: "division", defaultValue: 4, minValue: 0, maxValue: 5, automationRate: "k-rate" },
        { name: "depth", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "smooth", defaultValue: 0.15, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }
      ];
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
      const sr = globalThis.sampleRate || 44100;
      this.divisionValue = parameters.division[0];
      const stepBeats = GATE_DIVISION_BEATS[Math.max(0, Math.min(GATE_DIVISION_BEATS.length - 1, Math.round(parameters.division[0])))];
      const depth = parameters.depth[0];
      const mix = parameters.mix[0];
      const smoothValue = Math.max(0, Math.min(1, parameters.smooth[0]));
      const smoothTime = 5e-4 + smoothValue * smoothValue * 0.04;
      const smoothBlend = 1 - Math.exp(-1 / (sr * smoothTime));
      const phaseRate = this.bpm / (60 * sr);
      const steps = this.steps;
      const length = steps.length;
      for (let i = 0; i < len; i++) {
        this.phase += phaseRate;
        const raw = this.phase / stepBeats;
        const index = (Math.floor(raw) % length + length) % length;
        const open = steps[index] || 0;
        const target = 1 - depth * (1 - open);
        this.gain += (target - this.gain) * smoothBlend;
        if (this.gain < 1e-10) this.gain = 0;
        const l = inL ? inL[i] : 0;
        const r = inR ? inR[i] : l;
        outL[i] = l * (1 - mix + this.gain * mix);
        if (outR) outR[i] = r * (1 - mix + this.gain * mix);
      }
      return true;
    }
  };
  registerProcessor("stepgate-processor", StepGateProcessor);

  // src/audio-worklets/svfilter-processor.js
  var OS_TAPS = (() => {
    const N = 9;
    const fc = 0.375;
    const taps = new Array(N);
    const M = N - 1;
    for (let i = 0; i < N; i++) {
      const m = i - (M >> 1);
      const sinc = m === 0 ? 1 : Math.sin(Math.PI * fc * m) / (Math.PI * fc * m);
      const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / M);
      taps[i] = sinc * w;
    }
    let sum = 0;
    for (let i = 0; i < N; i++) sum += taps[i];
    for (let i = 0; i < N; i++) taps[i] /= sum;
    return taps;
  })();
  function fastTanh(x) {
    if (x > 3) return 1;
    if (x < -3) return -1;
    const x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }
  function osDrive(state, x, driveGain, makeup) {
    const sub = state.sub;
    const sat = state.sat;
    const mid = (state.prev + x) * 0.5;
    state.prev = x;
    sub[state.w] = mid;
    let k = state.w;
    let acc = 0;
    for (let i = 0; i < 9; i++) {
      acc += OS_TAPS[i] * sub[k];
      k = k + 7 & 7;
    }
    state.w = state.w + 1 & 7;
    const satMid = fastTanh(acc * driveGain) / driveGain * makeup;
    sub[state.w] = x;
    k = state.w;
    acc = 0;
    for (let i = 0; i < 9; i++) {
      acc += OS_TAPS[i] * sub[k];
      k = k + 7 & 7;
    }
    state.w = state.w + 1 & 7;
    const satEven = fastTanh(acc * driveGain) / driveGain * makeup;
    sat[state.sw] = satMid;
    state.sw = state.sw + 1 & 7;
    sat[state.sw] = satEven;
    k = state.sw;
    let out = 0;
    for (let i = 0; i < 9; i++) {
      out += OS_TAPS[i] * sat[k];
      k = k + 7 & 7;
    }
    state.sw = state.sw + 1 & 7;
    return out;
  }
  var SvFilterProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.lpL = 0;
      this.bpL = 0;
      this.lpR = 0;
      this.bpR = 0;
      this.lastCutoff = -1;
      this.lastRes = -1;
      this.f = 0.1;
      this.q = 1;
      this.drvL = { sub: new Float32Array(8), w: 0, sat: new Float32Array(8), sw: 0, prev: 0 };
      this.drvR = { sub: new Float32Array(8), w: 0, sat: new Float32Array(8), sw: 0, prev: 0 };
    }
    static get parameterDescriptors() {
      return [
        { name: "cutoff", defaultValue: 2e3, minValue: 20, maxValue: 2e4, automationRate: "k-rate" },
        { name: "resonance", defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "mode", defaultValue: 0, minValue: 0, maxValue: 3, automationRate: "k-rate" },
        // 0=LP 1=HP 2=BP 3=Notch
        { name: "drive", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }
      ];
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
      const sr = globalThis.sampleRate || 44100;
      const cutoff = Math.max(20, Math.min(2e4, parameters.cutoff[0]));
      const res = Math.max(0, Math.min(1, parameters.resonance[0]));
      const mode = Math.round(parameters.mode[0]);
      const drive = parameters.drive[0];
      const mix = parameters.mix[0];
      if (cutoff !== this.lastCutoff || res !== this.lastRes) {
        this.lastCutoff = cutoff;
        this.lastRes = res;
        this.f = 2 * Math.sin(Math.PI * Math.min(cutoff, sr * 0.24) / sr);
        this.q = 2 - 2 * res;
        const fqMax = (4 - this.f * this.f) * 0.49;
        if (this.f * this.q > fqMax) this.q = fqMax / this.f;
      }
      const driveGain = drive > 0 ? 1 + drive * 9 : 1;
      const clampVal = 8;
      for (let i = 0; i < len; i++) {
        let l = inL ? inL[i] : 0;
        let r = inR ? inR[i] : l;
        if (drive > 0) {
          const makeup = 1 + drive * 2.5;
          l = osDrive(this.drvL, l, driveGain, makeup);
          r = osDrive(this.drvR, r, driveGain, makeup);
        }
        const hpL = l - this.lpL - this.q * this.bpL;
        this.bpL += this.f * hpL;
        this.lpL += this.f * this.bpL;
        if (this.bpL > clampVal) this.bpL = clampVal;
        else if (this.bpL < -clampVal) this.bpL = -clampVal;
        if (this.lpL > clampVal) this.lpL = clampVal;
        else if (this.lpL < -clampVal) this.lpL = -clampVal;
        if (Math.abs(this.bpL) < 1e-20) this.bpL = 0;
        if (Math.abs(this.lpL) < 1e-20) this.lpL = 0;
        const hpR = r - this.lpR - this.q * this.bpR;
        this.bpR += this.f * hpR;
        this.lpR += this.f * this.bpR;
        if (this.bpR > clampVal) this.bpR = clampVal;
        else if (this.bpR < -clampVal) this.bpR = -clampVal;
        if (this.lpR > clampVal) this.lpR = clampVal;
        else if (this.lpR < -clampVal) this.lpR = -clampVal;
        if (Math.abs(this.bpR) < 1e-20) this.bpR = 0;
        if (Math.abs(this.lpR) < 1e-20) this.lpR = 0;
        let fL, fR;
        switch (mode) {
          case 1:
            fL = hpL;
            fR = hpR;
            break;
          // HP
          case 2:
            fL = this.bpL;
            fR = this.bpR;
            break;
          // BP
          case 3:
            fL = this.lpL + hpL;
            fR = this.lpR + hpR;
            break;
          // Notch
          default:
            fL = this.lpL;
            fR = this.lpR;
            break;
        }
        outL[i] = l * (1 - mix) + fL * mix;
        if (outR) outR[i] = r * (1 - mix) + fR * mix;
      }
      return true;
    }
  };
  registerProcessor("svfilter-processor", SvFilterProcessor);

  // src/audio-worklets/wtvoice-processor.js
  function svfCoeffs(f, q, sr) {
    let ff = 2 * Math.sin(Math.PI * Math.min(f, sr * 0.24) / sr);
    let qq = 2 - 2 * Math.max(0, Math.min(1, q));
    const fqMax = (4 - ff * ff) * 0.49;
    if (ff * qq > fqMax) qq = fqMax / ff;
    return { f: ff, q: qq };
  }
  var UNISON_MAX = 8;
  var VOICES_MAX = 8;
  var GOLDEN = 2.399963;
  var WtTables = class {
    constructor() {
      this.levels = null;
      this.ks = [1];
    }
    set(msg) {
      if (!Array.isArray(msg.levels) || msg.levels.length === 0) return;
      this.levels = msg.levels.map((level) => level.map((f) => Float32Array.from(f)));
      this.ks = Array.isArray(msg.ks) && msg.ks.length > 0 ? Array.from(msg.ks) : [1];
    }
    frameCount() {
      return this.levels ? this.levels[0].length : 0;
    }
    frameLength() {
      return this.levels ? this.levels[0][0].length : 0;
    }
    /** Most-harmonic level whose top harmonic stays under Nyquist at f0. */
    pickLevel(f0) {
      const limit = 0.475 * (globalThis.sampleRate || 44100);
      for (let m = 0; m < this.ks.length; m++) {
        if (this.ks[m] * f0 <= limit) return m;
      }
      return this.ks.length - 1;
    }
  };
  var WtVoice = class {
    constructor(index, params) {
      this.index = index;
      this.p = params;
      this.active = false;
      this.gate = false;
      this.dead = true;
      this.pitch = 60;
      this.f0 = 261.63;
      this.vel = 0;
      this.pressure = 0;
      this.levelIndex = 0;
      this.morphBase = params.morph;
      this.scanPos = 0;
      this.lfoPhase = index * GOLDEN % 1;
      this.env = 0;
      this.stage = "off";
      this.age = 0;
      this.svfF = 0;
      this.svfQ = 1;
      this.lastCutoff = -1;
      this.subPhase = 0;
      this.f1L = 0;
      this.f2L = 0;
      this.f1R = 0;
      this.f2R = 0;
      this.copyPhase = new Float32Array(UNISON_MAX + 2);
      this.copyDetune = new Float32Array(UNISON_MAX + 2);
      this.copyLevel = new Float32Array(UNISON_MAX + 2);
      this.panL = new Float32Array(UNISON_MAX + 2);
      this.panR = new Float32Array(UNISON_MAX + 2);
      this.copyCount = 0;
    }
    noteOn(pitch, velocity) {
      this.active = true;
      this.gate = true;
      this.dead = false;
      this.pitch = pitch;
      this.f0 = 440 * Math.pow(2, (pitch - 69) / 12);
      this.vel = velocity;
      this.pressure = 0;
      this.env = 0;
      this.stage = "attack";
      this.morphBase = this.p.morph;
      this.scanPos = this.morphBase * (this.p.tableFrames - 1);
      this.levelIndex = this.p.pickLevel(this.f0);
      this.lfoPhase = this.index * GOLDEN % 1;
      this.refreshCopies();
      this.lastCutoff = -1;
    }
    refreshCopies() {
      const unison = Math.max(1, Math.min(UNISON_MAX, Math.round(this.p.unison)));
      const spread = this.p.spread;
      const detune = this.p.detune;
      this.copyDetune[0] = 0;
      this.copyLevel[0] = 0.5;
      this.panL[0] = 0.7071;
      this.panR[0] = 0.7071;
      this.copyDetune[1] = detune;
      this.copyLevel[1] = 0.45;
      this.panL[1] = 0.7071;
      this.panR[1] = 0.7071;
      this.copyCount = 2;
      if (unison > 1) {
        for (let u = 0; u < unison; u++) {
          const t = unison === 1 ? 0 : u / (unison - 1) * 2 - 1;
          const idx = 2 + u;
          this.copyDetune[idx] = detune * 0.5 + t * spread;
          this.copyLevel[idx] = 0.4 / Math.sqrt(unison);
          const pan = t * 0.6;
          this.panL[idx] = Math.cos((pan + 1) * Math.PI / 4);
          this.panR[idx] = Math.sin((pan + 1) * Math.PI / 4);
          this.copyCount++;
        }
      }
    }
    release() {
      this.gate = false;
      this.stage = "release";
    }
  };
  var WtVoiceProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.tables = new WtTables();
      this.voices = [];
      this.voiceCounter = 0;
      this.events = [];
      this.params = {
        morph: 0.3,
        morphRate: 0,
        morphDepth: 0.5,
        scanRate: 0,
        detune: 7,
        sub: 0.2,
        unison: 1,
        spread: 0,
        cutoff: 12e3,
        resonance: 1,
        mode: 0,
        keytrack: 0,
        level: -6,
        attack: 0.01,
        release: 0.25,
        modASrc: 0,
        modADst: 0,
        modAAmt: 0,
        modBSrc: 0,
        modBDst: 1,
        modBAmt: 0,
        modLfoRate: 2,
        tableFrames: 8,
        pickLevel: () => 0
      };
      this.port.onmessage = (e) => this.handleMessage(e.data);
    }
    handleMessage(msg) {
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "tables":
          this.tables.set(msg);
          this.params.tableFrames = this.tables.frameCount();
          this.params.pickLevel = (f0) => this.tables.pickLevel(f0);
          break;
        case "noteOn":
          this.events.push({
            when: Math.max(msg.when ?? currentTime, currentTime),
            kind: "on",
            pitch: msg.pitch,
            velocity: msg.velocity
          });
          this.events.sort((a, b) => a.when - b.when);
          break;
        case "noteOff":
          this.events.push({ when: Math.max(msg.when ?? currentTime, currentTime), kind: "off", pitch: msg.pitch });
          this.events.sort((a, b) => a.when - b.when);
          break;
        case "pressure":
          for (const v of this.voices) {
            if (v.active && v.pitch === msg.pitch) v.pressure = Math.max(0, Math.min(1, msg.value));
          }
          break;
        case "panic":
          this.voices.length = 0;
          this.events.length = 0;
          break;
        case "param":
          if (typeof msg.name === "string" && msg.name in this.params && typeof msg.value === "number") {
            this.params[msg.name] = msg.value;
          }
          break;
      }
    }
    drainDue(t, dueOn, dueOff) {
      while (this.events.length > 0 && this.events[0].when <= t) {
        const ev = this.events.shift();
        if (ev.kind === "on") dueOn.push(ev);
        else dueOff.push(ev);
      }
    }
    triggerOn(ev) {
      let voice = null;
      for (const v of this.voices) {
        if (!v.gate) {
          voice = v;
          break;
        }
      }
      if (!voice) {
        if (this.voices.length >= VOICES_MAX) {
          voice = this.voices.reduce((a, b) => a.age <= b.age ? a : b);
        } else {
          voice = new WtVoice(this.voiceCounter++, this.params);
          this.voices.push(voice);
        }
      }
      voice.noteOn(ev.pitch, ev.velocity);
    }
    triggerOff(pitch) {
      for (const v of this.voices) {
        if (v.active && v.gate && v.pitch === pitch) v.release();
      }
    }
    process(inputs, outputs) {
      const outL = outputs[0][0];
      const outR = outputs[0].length > 1 ? outputs[0][1] : null;
      if (!outL) return true;
      const sr = globalThis.sampleRate || 44100;
      const dt = 1 / sr;
      const blockStart = currentTime;
      const dueOn = [];
      const dueOff = [];
      const p = this.params;
      const N = p.tableFrames;
      const tN1 = Math.max(1, N - 1);
      const frameLen = this.tables.frameLength();
      for (let i = 0; i < outL.length; i++) {
        const t = blockStart + i * dt;
        dueOn.length = 0;
        dueOff.length = 0;
        this.drainDue(t, dueOn, dueOff);
        for (const ev of dueOn) this.triggerOn(ev);
        for (const ev of dueOff) this.triggerOff(ev.pitch);
        let l = 0;
        let r = 0;
        for (const v of this.voices) {
          if (!v.active) continue;
          const tau = v.stage === "attack" ? Math.max(2e-3, p.attack) / 3 : Math.max(5e-3, p.release) / 3;
          if (v.stage === "attack") {
            const tau2 = Math.max(2e-3, p.attack) / 3;
            v.env += (1 - v.env) * (1 - Math.exp(-dt / tau2));
            if (v.env > 0.985) v.stage = "sustain";
          } else if (v.stage === "release") {
            const tauR = Math.max(5e-3, p.release) / 3;
            v.env += (0 - v.env) * (1 - Math.exp(-dt / tauR));
            if (v.env < 4e-4) {
              v.dead = true;
              v.active = false;
              continue;
            }
          }
          const srcEnv = v.env;
          const srcLfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * p.modLfoRate * t + v.lfoPhase * 2 * Math.PI);
          const srcVel = v.vel;
          const srcPress = v.pressure;
          const srcA = p.modASrc === 0 ? srcEnv : p.modASrc === 1 ? srcLfo : p.modASrc === 2 ? srcVel : srcPress;
          const srcB = p.modBSrc === 0 ? srcEnv : p.modBSrc === 1 ? srcLfo : p.modBSrc === 2 ? srcVel : srcPress;
          v.scanPos += tN1 * p.scanRate * dt;
          let pairPos = v.morphBase * tN1 + v.scanPos;
          const frac = pairPos - Math.floor(pairPos);
          pairPos += Math.sin(2 * Math.PI * p.morphRate * t + v.lfoPhase * 2 * Math.PI) * p.morphDepth * Math.min(frac, 1 - frac) * 0.9;
          pairPos += srcA * p.modAAmt * 2 * (p.modADst === 0 ? 1 : 0);
          pairPos += srcB * p.modBAmt * 2 * (p.modBDst === 0 ? 1 : 0);
          pairPos = (pairPos % tN1 + tN1) % tN1;
          const ia = Math.floor(pairPos);
          const blend = pairPos - ia;
          const ib = (ia + 1) % N;
          const keytr = 1 + p.keytrack * (v.f0 / 261.63 - 1);
          const modCut = srcA * p.modAAmt * 2 * (p.modADst === 1 ? 1 : 0) + srcB * p.modBAmt * 2 * (p.modBDst === 1 ? 1 : 0);
          const cutoff = Math.min(18e3, Math.max(60, p.cutoff * keytr * (1 + Math.max(-0.9, modCut))));
          if (Math.abs(cutoff - v.lastCutoff) > 0.01) {
            v.lastCutoff = cutoff;
            const c = svfCoeffs(cutoff, p.resonance, sr);
            v.svfF = c.f;
            v.svfQ = c.q;
          }
          const mode = Math.round(p.mode);
          const frames = this.tables.levels ? this.tables.levels[v.levelIndex] : null;
          if (!frames || frameLen === 0) continue;
          const dB = Math.pow(10, p.level / 20);
          const amp = v.env * v.vel * dB;
          let voiceL = 0;
          let voiceR = 0;
          for (let cI = 0; cI < v.copyCount; cI++) {
            v.copyPhase[cI] += v.f0 * Math.pow(2, v.copyDetune[cI] / 1200) * dt;
            if (v.copyPhase[cI] >= 1) v.copyPhase[cI] -= Math.floor(v.copyPhase[cI]);
            const posA = v.copyPhase[cI] * frameLen;
            const i0 = posA | 0;
            const fr = posA - i0;
            const sa = frames[ia];
            const sb = frames[ib];
            const a = sa[i0] ?? 0;
            const b = sa[i0 + 1] ?? a;
            const c = sb[i0] ?? 0;
            const d = sb[i0 + 1] ?? c;
            const sample = (a + (b - a) * fr) * (1 - blend) + (c + (d - c) * fr) * blend;
            voiceL += sample * v.copyLevel[cI] * v.panL[cI];
            voiceR += sample * v.copyLevel[cI] * v.panR[cI];
          }
          if (p.sub > 5e-3) {
            v.subPhase += v.f0 * 0.5 * dt;
            if (v.subPhase >= 1) v.subPhase -= Math.floor(v.subPhase);
            const sub = Math.sin(2 * Math.PI * v.subPhase) * p.sub * 0.7;
            voiceL += sub;
            voiceR += sub;
          }
          let fL = voiceL;
          let fR = voiceR;
          if (v.svfF > 0) {
            const hpL = voiceL - v.f1L - v.svfQ * v.f2L;
            v.f2L += v.svfF * hpL;
            v.f1L += v.svfF * v.f2L;
            v.f2L = Math.max(-8, Math.min(8, v.f2L));
            v.f1L = Math.max(-8, Math.min(8, v.f1L));
            const hpR = voiceR - v.f1R - v.svfQ * v.f2R;
            v.f2R += v.svfF * hpR;
            v.f1R += v.svfF * v.f2R;
            v.f2R = Math.max(-8, Math.min(8, v.f2R));
            v.f1R = Math.max(-8, Math.min(8, v.f1R));
            if (mode === 1) {
              fL = hpL;
              fR = hpR;
            } else if (mode === 2) {
              fL = v.f2L;
              fR = v.f2R;
            } else {
              fL = v.f1L;
              fR = v.f1R;
            }
          }
          const ampMod = srcA * p.modAAmt * (p.modADst === 3 ? 1 : 0) + srcB * p.modBAmt * (p.modBDst === 3 ? 1 : 0);
          const gain = amp * Math.max(0.1, 1 + ampMod);
          l += fL * gain;
          r += fR * gain;
          v.age++;
        }
        this.voices = this.voices.filter((v) => !v.dead);
        outL[i] = Math.max(-8, Math.min(8, l));
        if (outR) outR[i] = Math.max(-8, Math.min(8, r));
      }
      return true;
    }
  };
  registerProcessor("wtvoice-processor", WtVoiceProcessor);

  // src/audio-worklets/granular-voice-processor.js
  var VOICES_MAX2 = 6;
  var GRAINS_PER_NOTE_MAX = 512;
  var GRAINS_ACTIVE_MAX = 48;
  var SYNC_BEATS = [0, 2, 1, 0.75, 0.5, 1 / 3, 0.25];
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var Grain = class {
    constructor() {
      this.active = false;
      this.pos = 0;
      this.rate = 1;
      this.remaining = 0;
      this.ramp = 0;
      this.plateau = 0;
      this.age = 0;
      this.peak = 0;
      this.panL = 0.7071;
      this.panR = 0.7071;
      this.ch = 0;
    }
  };
  var GrainVoice = class {
    constructor(index, params) {
      this.index = index;
      this.p = params;
      this.bpm = 120;
      this.active = false;
      this.gate = false;
      this.dead = true;
      this.pitch = 60;
      this.vel = 0;
      this.age = 0;
      this.startFrame = 0;
      this.offFrame = 0;
      this.env = 0;
      this.stage = "attack";
      this.peak = 0;
      this.rand = () => 0;
      this.spawned = 0;
      this.nextSpawn = 0;
      this.grains = [];
      for (let i = 0; i < GRAINS_ACTIVE_MAX; i++) this.grains.push(new Grain());
    }
    noteOn(msg, sr) {
      this.active = true;
      this.gate = true;
      this.dead = false;
      this.pitch = msg.pitch;
      this.vel = Math.max(0, Math.min(1, msg.velocity));
      this.startFrame = Math.round(msg.when * sr);
      const size = Math.min(0.4, Math.max(0.02, this.p.size ?? 0.09));
      const hold = Math.max(msg.dur ?? 0.5, size + 0.02);
      this.offFrame = this.startFrame + Math.round(hold * sr);
      this.env = 0;
      this.stage = "attack";
      this.peak = this.vel * (this.p.gain ?? 0.8);
      this.spawned = 0;
      this.rand = mulberry32(msg.seed >>> 0);
      this.nextSpawn = this.startFrame;
      for (const g of this.grains) g.active = false;
    }
    release(nowFrame, sr) {
      this.gate = false;
      this.offFrame = Math.min(this.offFrame, nowFrame);
      this.stage = "release";
      void sr;
    }
    /** Effective grains/s — R SYNC lock resolved at spawn time (live BPM). */
    grainRate(sr) {
      const beats = SYNC_BEATS[Math.max(0, Math.min(SYNC_BEATS.length - 1, Math.round(this.p.rateSync ?? 0)))];
      const hz = beats > 0 && this.bpm > 0 ? this.bpm / 60 * beats : this.p.rate ?? 14;
      return Math.max(0, Math.min(60, hz));
    }
    spawn(frame, sr, sample) {
      if (!sample || sample.length === 0) return;
      if (this.spawned >= GRAINS_PER_NOTE_MAX) return;
      if (frame >= this.offFrame + 5e-3 * sr) return;
      const free = this.grains.find((g) => !g.active);
      if (!free) return;
      const p = this.p;
      const position = Math.min(1, Math.max(0, p.position ?? 0.25));
      const size = Math.min(0.4, Math.max(0.02, p.size ?? 0.09));
      const jitter = Math.max(0, p.jitter ?? 0.15);
      const spread = Math.max(0, Math.min(1, p.spread ?? 0.5));
      const reverseProb = Math.min(1, Math.max(0, p.reverse ?? 0));
      const shape = Math.min(1, Math.max(0, p.shape ?? 0.5));
      const scan = Math.max(-2, Math.min(2, p.scan ?? 0));
      const pitchRand = Math.max(0, Math.min(12, p.pRand ?? 0));
      const tSec = (frame - this.startFrame) / sr;
      const drift = position + scan * tSec;
      const basePos = scan !== 0 ? drift - Math.floor(drift) : position;
      const offsetFrac = Math.min(0.999, Math.max(0, basePos + (this.rand() * 2 - 1) * jitter * 0.5));
      const reverse = this.rand() < reverseProb;
      const pan = (this.rand() * 2 - 1) * spread;
      const playRate = Math.pow(2, (this.pitch - 60 + (p.pitch ?? 0)) / 12);
      const grainRate = Math.max(0.02, playRate * (pitchRand > 5e-3 ? Math.pow(2, (this.rand() * 2 - 1) * pitchRand / 12) : 1));
      const len = sample.length;
      const grainDurSamples = Math.round((size + 0.01) * sr);
      let start = offsetFrac * len;
      const maxStart = Math.max(0, len - grainDurSamples);
      start = Math.min(Math.max(0, start), maxStart);
      if (reverse) start = Math.min(Math.max(0, len - start - grainDurSamples), maxStart);
      free.active = true;
      free.pos = start;
      free.rate = reverse ? -grainRate : grainRate;
      free.remaining = grainDurSamples;
      free.ramp = Math.max(Math.round(4e-3 * sr), Math.round((0.12 + 0.38 * shape) * size * sr));
      free.plateau = Math.max(0, grainDurSamples - 2 * free.ramp);
      free.age = 0;
      const theta = (pan + 1) * (Math.PI / 4);
      free.panL = Math.cos(theta);
      free.panR = Math.sin(theta);
      const overlap = Math.max(0.75, this.grainRate(sr) * size);
      free.peak = this.vel * (p.gain ?? 0.8) * 0.7 / overlap;
      free.ch = sample.channels;
      this.spawned++;
    }
  };
  var GrainVoiceProcessor = class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.sample = null;
      this.voices = [];
      this.voiceCounter = 0;
      this.bpm = 120;
      this.params = {
        position: 0.25,
        size: 0.09,
        rate: 14,
        rateSync: 0,
        jitter: 0.15,
        scan: 0,
        spread: 0.5,
        reverse: 0,
        shape: 0.5,
        pRand: 0,
        pitch: 0,
        gain: 0.8,
        attack: 0.02,
        release: 0.4
      };
      this.events = [];
      this.port.onmessage = (e) => this.handleMessage(e.data);
      const init = options?.processorOptions;
      if (init) {
        if (init.params) Object.assign(this.params, init.params);
        if (typeof init.bpm === "number") this.bpm = init.bpm;
        if (init.sample) this.handleMessage({ type: "sample", ...init.sample });
      }
    }
    handleMessage(msg) {
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "sample":
          if (!(msg.ch0 instanceof Float32Array) || msg.ch0.length === 0) return;
          this.sample = {
            ch0: msg.ch0,
            ch1: msg.ch1 instanceof Float32Array ? msg.ch1 : null,
            length: msg.ch0.length,
            channels: msg.ch1 instanceof Float32Array ? 2 : 1,
            sampleRate: msg.sampleRate || 44100
          };
          return;
        case "noteOn":
          this.events.push({ ...msg, kind: "on" });
          return;
        case "noteOff":
          this.events.push({ ...msg, kind: "off" });
          return;
        case "panic":
          this.events.length = 0;
          for (const v of this.voices) {
            v.active = false;
            v.gate = false;
            v.dead = true;
            for (const g of v.grains) g.active = false;
          }
          return;
        case "bpm":
          if (typeof msg.value === "number" && msg.value > 10 && msg.value < 400) this.bpm = msg.value;
          return;
        case "param":
          if (typeof msg.value === "number") this.params[msg.name] = msg.value;
          return;
        default:
          return;
      }
    }
    triggerOn(ev, sr) {
      let voice = null;
      for (const v of this.voices) {
        if (!v.gate) {
          voice = v;
          break;
        }
      }
      if (!voice) {
        if (this.voices.length >= VOICES_MAX2) {
          voice = this.voices.reduce((a, b) => a.age <= b.age ? a : b);
        } else {
          voice = new GrainVoice(this.voiceCounter++, this.params);
          voice.bpm = this.bpm;
          this.voices.push(voice);
        }
      }
      voice.p = this.params;
      voice.bpm = this.bpm;
      voice.noteOn(ev, sr);
    }
    triggerOff(pitch, nowFrame, sr) {
      for (const v of this.voices) {
        if (v.active && v.gate && v.pitch === pitch) v.release(nowFrame, sr);
      }
    }
    process(inputs, outputs) {
      const outL = outputs[0][0];
      const outR = outputs[0].length > 1 ? outputs[0][1] : null;
      if (!outL) return true;
      void inputs;
      this.processCalls = (this.processCalls || 0) + 1;
      const sr = globalThis.sampleRate || 44100;
      this.srSeen = sr;
      const blockStart = currentTime;
      const sample = this.sample;
      const p = this.params;
      for (let i = 0; i < outL.length; i++) {
        const frame = Math.round((blockStart + i / sr) * sr);
        this.lastFrame = frame;
        for (let e = this.events.length - 1; e >= 0; e--) {
          const ev = this.events[e];
          if (Math.round(ev.when * sr) <= frame) {
            this.events.splice(e, 1);
            if (ev.kind === "on") this.triggerOn(ev, sr);
            else this.triggerOff(ev.pitch, frame, sr);
          }
        }
        let l = 0;
        let r = 0;
        for (const v of this.voices) {
          if (!v.active) continue;
          v.age++;
          v.p = p;
          v.bpm = this.bpm;
          if (v.stage === "attack") {
            const tau = Math.max(2e-3, p.attack ?? 0.02) / 3;
            v.env += (v.peak - v.env) * (1 - Math.exp(-1 / (tau * sr)));
            if (v.env > v.peak * 0.985) v.stage = "sustain";
          } else if (v.stage === "release") {
            const tau = Math.max(5e-3, p.release ?? 0.4) / 3;
            v.env += (0 - v.env) * (1 - Math.exp(-1 / (tau * sr)));
          }
          if (!v.gate && frame >= v.offFrame) v.stage = "release";
          while (v.nextSpawn <= frame && v.nextSpawn < v.offFrame + 5e-3 * sr) {
            v.spawn(v.nextSpawn, sr, sample);
            const rate = v.grainRate(sr);
            v.nextSpawn += rate > 0.01 ? Math.max(1, Math.round(sr / rate)) : sr * 10;
          }
          let gl = 0;
          let gr = 0;
          for (const g of v.grains) {
            if (!g.active) continue;
            let envg;
            if (g.age < g.ramp) envg = g.age / g.ramp;
            else if (g.age < g.ramp + g.plateau) envg = 1;
            else envg = Math.max(0, 1 - (g.age - g.ramp - g.plateau) / g.ramp);
            if (envg <= 0 && g.age > 0) {
              g.active = false;
              continue;
            }
            const idx = g.pos | 0;
            const frac = g.pos - idx;
            if (idx < 0 || idx >= sample.length - 1) {
              g.active = false;
              continue;
            }
            const s0 = sample.ch0[idx];
            const s1 = sample.ch0[idx + 1];
            let mono = s0 + (s1 - s0) * frac;
            let monoR = mono;
            if (g.ch === 2 && sample.ch1) {
              const t0 = sample.ch1[idx];
              const t1 = sample.ch1[idx + 1];
              monoR = t0 + (t1 - t0) * frac;
            }
            gl += mono * g.panL * envg;
            gr += monoR * g.panR * envg;
            g.pos += g.rate;
            g.age++;
            g.remaining--;
            if (g.remaining <= 0) g.active = false;
          }
          const amp = v.env;
          l += gl * amp;
          r += gr * amp;
          if (!v.gate && v.stage === "release" && v.env < 4e-4 && frame >= v.offFrame + 5e-3 * sr && !v.grains.some((g) => g.active)) {
            v.active = false;
            v.dead = true;
          }
        }
        this.voices = this.voices.filter((v) => !v.dead);
        outL[i] = Math.max(-8, Math.min(8, l));
        if (outR) outR[i] = Math.max(-8, Math.min(8, r));
      }
      return true;
    }
  };
  registerProcessor("granular-voice-processor", GrainVoiceProcessor);

  // src/audio-worklets/flanger-processor.js
  var FLANGER_DIVISOR = 2048;
  var FLANGER_MASK = FLANGER_DIVISOR - 1;
  var FlangerProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.bufL = new Float32Array(FLANGER_DIVISOR);
      this.bufR = new Float32Array(FLANGER_DIVISOR);
      this.writeIdx = 0;
      this.lfoPhaseL = 0;
      this.lfoPhaseR = Math.PI * (2 / 3);
      this.gain = 1;
    }
    static get parameterDescriptors() {
      return [
        { name: "rate", defaultValue: 0.5, minValue: 0.05, maxValue: 10, automationRate: "k-rate" },
        { name: "depth", defaultValue: 3, minValue: 0, maxValue: 10, automationRate: "k-rate" },
        // ms
        { name: "base", defaultValue: 5, minValue: 0.5, maxValue: 20, automationRate: "k-rate" },
        // ms
        { name: "feedback", defaultValue: 0.4, minValue: 0, maxValue: 0.95, automationRate: "k-rate" },
        { name: "spread", defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "mix", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" }
      ];
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
      const sr = globalThis.sampleRate || 44100;
      const rate = parameters.rate[0];
      const depthSec = Math.max(0, parameters.depth[0]) / 1e3;
      const baseSec = Math.max(5e-4, parameters.base[0]) / 1e3;
      const feedback = Math.max(0, Math.min(0.95, parameters.feedback[0]));
      const spread = parameters.spread[0];
      const mix = parameters.mix[0];
      const lfoRateRad = 2 * Math.PI * rate / sr;
      const depthSamples = depthSec * sr;
      const baseSamples = baseSec * sr;
      const spreadOffset = spread * Math.PI;
      for (let i = 0; i < len; i++) {
        const l = inL ? inL[i] : 0;
        const r = inR ? inR[i] : l;
        const lfoL = Math.sin(this.lfoPhaseL);
        const lfoR = Math.sin(this.lfoPhaseR);
        this.lfoPhaseL += lfoRateRad;
        this.lfoPhaseR += lfoRateRad;
        if (this.lfoPhaseL > 2 * Math.PI) this.lfoPhaseL -= 2 * Math.PI;
        if (this.lfoPhaseR > 2 * Math.PI) this.lfoPhaseR -= 2 * Math.PI;
        const delayLSamples = baseSamples + depthSamples * (0.5 + 0.5 * lfoL);
        const delayRSamples = baseSamples + depthSamples * (0.5 + 0.5 * lfoR);
        const readL = this.writeIdx - delayLSamples;
        const readR = this.writeIdx - delayRSamples;
        const wetL = this.readLinear(this.bufL, readL);
        const wetR = this.readLinear(this.bufR, readR);
        this.bufL[this.writeIdx] = l + wetL * feedback;
        this.bufR[this.writeIdx] = r + wetR * feedback;
        this.writeIdx = this.writeIdx + 1 & FLANGER_MASK;
        outL[i] = l * (1 - mix) + wetL * mix;
        if (outR) outR[i] = r * (1 - mix) + wetR * mix;
      }
      if (Math.abs(this.bufL[this.writeIdx]) < 1e-20) this.bufL[this.writeIdx] = 0;
      if (Math.abs(this.bufR[this.writeIdx]) < 1e-20) this.bufR[this.writeIdx] = 0;
      return true;
    }
    readLinear(buf, position) {
      const idx0 = Math.floor(position);
      const frac = position - idx0;
      const i0 = idx0 & FLANGER_MASK;
      const i1 = idx0 + 1 & FLANGER_MASK;
      return buf[i0] * (1 - frac) + buf[i1] * frac;
    }
  };
  registerProcessor("flanger-processor", FlangerProcessor);

  // src/audio-worklets/tremolo-processor.js
  var TremoloProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.lfoPhase = 0;
      this.gainL = 1;
      this.gainR = 1;
    }
    static get parameterDescriptors() {
      return [
        { name: "rate", defaultValue: 5, minValue: 0.1, maxValue: 20, automationRate: "k-rate" },
        { name: "depth", defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "shape", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        // 0=sine 1=square
        { name: "mode", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        // 0=AM 1=auto-pan
        { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }
      ];
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
      const sr = globalThis.sampleRate || 44100;
      const rate = parameters.rate[0];
      const depth = parameters.depth[0];
      const shape = parameters.shape[0];
      const autoPan = parameters.mode[0] >= 0.5;
      const mix = parameters.mix[0];
      const phaseRate = 2 * Math.PI * rate / sr;
      for (let i = 0; i < len; i++) {
        const l = inL ? inL[i] : 0;
        const r = inR ? inR[i] : l;
        const raw = Math.sin(this.lfoPhase);
        const shaped = raw * (1 - shape) + (raw >= 0 ? 1 : -1) * shape;
        const lfo = (shaped + 1) * 0.5;
        let gainL = 1;
        let gainR = 1;
        if (autoPan) {
          const pan = shaped * depth;
          gainL = 1 - Math.max(0, pan);
          gainR = 1 + Math.min(0, pan);
        } else {
          const g = 1 - depth * (1 - lfo);
          gainL = g;
          gainR = g;
        }
        this.gainL += (gainL - this.gainL) * 0.5;
        this.gainR += (gainR - this.gainR) * 0.5;
        if (Math.abs(this.gainL) < 1e-20) this.gainL = 0;
        if (Math.abs(this.gainR) < 1e-20) this.gainR = 0;
        outL[i] = l * (1 - mix) + l * this.gainL * mix;
        if (outR) outR[i] = r * (1 - mix) + r * this.gainR * mix;
        this.lfoPhase += phaseRate;
        if (this.lfoPhase > 2 * Math.PI) this.lfoPhase -= 2 * Math.PI;
      }
      return true;
    }
  };
  registerProcessor("tremolo-processor", TremoloProcessor);

  // src/audio-worklets/autowah-processor.js
  var AutowahProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.env = 0;
      this.lpL = 0;
      this.bpL = 0;
      this.lpR = 0;
      this.bpR = 0;
    }
    static get parameterDescriptors() {
      return [
        { name: "minFreq", defaultValue: 300, minValue: 100, maxValue: 2e3, automationRate: "k-rate" },
        { name: "maxFreq", defaultValue: 2500, minValue: 500, maxValue: 8e3, automationRate: "k-rate" },
        { name: "resonance", defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "attack", defaultValue: 0.01, minValue: 1e-3, maxValue: 0.1, automationRate: "k-rate" },
        { name: "release", defaultValue: 0.15, minValue: 0.05, maxValue: 1, automationRate: "k-rate" },
        { name: "sensitivity", defaultValue: 1.5, minValue: 0.5, maxValue: 3, automationRate: "k-rate" },
        { name: "mode", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        // 0=BP 1=LP
        { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }
      ];
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
      const sr = globalThis.sampleRate || 44100;
      const minF = parameters.minFreq[0];
      const maxF = Math.max(minF + 50, parameters.maxFreq[0]);
      const res = Math.max(0, Math.min(1, parameters.resonance[0]));
      const atkBlend = 1 - Math.exp(-1 / (sr * Math.max(1e-3, parameters.attack[0])));
      const relBlend = 1 - Math.exp(-1 / (sr * Math.max(0.05, parameters.release[0])));
      const sens = parameters.sensitivity[0];
      const bpMode = parameters.mode[0] < 0.5;
      const mix = parameters.mix[0];
      const q = 2 - 2 * res;
      const clampVal = 8;
      for (let i = 0; i < len; i++) {
        const l = inL ? inL[i] : 0;
        const r = inR ? inR[i] : l;
        const peak = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
        const driven = Math.tanh(peak * sens);
        this.env = driven > this.env ? this.env + (driven - this.env) * atkBlend : this.env + (driven - this.env) * relBlend;
        if (this.env < 1e-20) this.env = 0;
        const fc = minF + this.env * (maxF - minF);
        const f = 2 * Math.sin(Math.PI * Math.min(fc, sr * 0.24) / sr);
        const hpL = l - this.lpL - q * this.bpL;
        this.bpL += f * hpL;
        this.lpL += f * this.bpL;
        if (this.bpL > clampVal) this.bpL = clampVal;
        else if (this.bpL < -clampVal) this.bpL = -clampVal;
        if (this.lpL > clampVal) this.lpL = clampVal;
        else if (this.lpL < -clampVal) this.lpL = -clampVal;
        if (Math.abs(this.bpL) < 1e-20) this.bpL = 0;
        if (Math.abs(this.lpL) < 1e-20) this.lpL = 0;
        const hpR = r - this.lpR - q * this.bpR;
        this.bpR += f * hpR;
        this.lpR += f * this.bpR;
        if (this.bpR > clampVal) this.bpR = clampVal;
        else if (this.bpR < -clampVal) this.bpR = -clampVal;
        if (this.lpR > clampVal) this.lpR = clampVal;
        else if (this.lpR < -clampVal) this.lpR = -clampVal;
        if (Math.abs(this.bpR) < 1e-20) this.bpR = 0;
        if (Math.abs(this.lpR) < 1e-20) this.lpR = 0;
        let fL, fR;
        if (bpMode) {
          fL = this.bpL;
          fR = this.bpR;
        } else {
          fL = this.lpL;
          fR = this.lpR;
        }
        outL[i] = l * (1 - mix) + fL * mix;
        if (outR) outR[i] = r * (1 - mix) + fR * mix;
      }
      return true;
    }
  };
  registerProcessor("autowah-processor", AutowahProcessor);

  // src/audio-worklets/stutter-processor.js
  var STUT_BUF_SIZE = 262144;
  var STUT_MASK = STUT_BUF_SIZE - 1;
  var STUT_DIV_BEATS = [4, 2, 1, 0.5, 0.25, 0.125];
  var StutterProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.bufL = new Float32Array(STUT_BUF_SIZE);
      this.bufR = new Float32Array(STUT_BUF_SIZE);
      this.writeIdx = 0;
      this.phase = 0;
      this.bpm = 120;
      this.gateSteps = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
      this.port.onmessage = (event) => {
        const d = event.data || {};
        if (d.type === "pattern" && Array.isArray(d.steps) && d.steps.length > 0) {
          this.gateSteps = d.steps.map((v) => Math.min(1, Math.max(0, Number(v) || 0)));
        } else if (d.type === "align") {
          const stepBeats = STUT_DIV_BEATS[Math.max(0, Math.min(5, Math.round(this.divValue ?? 4)))];
          this.phase = Math.floor((d.phase || 0) / stepBeats) * stepBeats;
        } else if (d.type === "bpm") {
          this.bpm = Math.max(20, Math.min(300, d.bpm || 120));
        }
      };
    }
    static get parameterDescriptors() {
      return [
        { name: "division", defaultValue: 4, minValue: 0, maxValue: 5, automationRate: "k-rate" },
        { name: "mix", defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "feedback", defaultValue: 0, minValue: 0, maxValue: 0.7, automationRate: "k-rate" }
      ];
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
      const sr = globalThis.sampleRate || 44100;
      const divIdx = Math.max(0, Math.min(5, Math.round(parameters.division[0])));
      this.divValue = divIdx;
      const mix = parameters.mix[0];
      const feedback = Math.max(0, Math.min(0.7, parameters.feedback[0]));
      const stepBeats = STUT_DIV_BEATS[divIdx];
      const phaseRate = this.bpm / (60 * sr);
      const loopSamples = Math.min(STUT_BUF_SIZE - 1, Math.max(1, Math.round(16 * stepBeats * (60 / this.bpm) * sr)));
      for (let i = 0; i < len; i++) {
        const l = inL ? inL[i] : 0;
        const r = inR ? inR[i] : l;
        const readIdx = this.writeIdx - loopSamples + STUT_BUF_SIZE & STUT_MASK;
        const delayedL = this.bufL[readIdx];
        const delayedR = this.bufR[readIdx];
        this.phase += phaseRate;
        const stepIdx = Math.floor(this.phase / stepBeats) % this.gateSteps.length;
        const gate = this.gateSteps[stepIdx] || 0;
        let wL = l + delayedL * gate * feedback;
        let wR = r + delayedR * gate * feedback;
        if (Math.abs(wL) < 1e-20) wL = 0;
        if (Math.abs(wR) < 1e-20) wR = 0;
        this.bufL[this.writeIdx] = wL;
        this.bufR[this.writeIdx] = wR;
        this.writeIdx = this.writeIdx + 1 & STUT_MASK;
        const gatedL = delayedL * gate;
        const gatedR = delayedR * gate;
        outL[i] = l * (1 - mix) + gatedL * mix;
        if (outR) outR[i] = r * (1 - mix) + gatedR * mix;
      }
      return true;
    }
  };
  registerProcessor("stutter-processor", StutterProcessor);

  // src/audio-worklets/tape-processor.js
  var TapeProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.prevL = 0;
      this.prevR = 0;
      this.lpL = 0;
      this.lpR = 0;
    }
    static get parameterDescriptors() {
      return [
        { name: "drive", defaultValue: 0.4, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "hysteresis", defaultValue: 0.3, minValue: 0, maxValue: 0.95, automationRate: "k-rate" },
        { name: "tone", defaultValue: 6500, minValue: 500, maxValue: 12e3, automationRate: "k-rate" },
        { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "output", defaultValue: 0, minValue: -12, maxValue: 12, automationRate: "k-rate" }
      ];
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
      const sr = globalThis.sampleRate || 44100;
      const drive = parameters.drive[0];
      const hyst = parameters.hysteresis[0];
      const tone = parameters.tone[0];
      const mix = parameters.mix[0];
      const outDb = parameters.output[0];
      const driveGain = 1 + drive * 14;
      const outGain = Math.pow(10, outDb / 20);
      const alpha = 1 - Math.exp(-2 * Math.PI * tone / sr);
      for (let i = 0; i < len; i++) {
        const l = inL ? inL[i] : 0;
        const r = inR ? inR[i] : l;
        const wetL = Math.tanh(driveGain * l + hyst * this.prevL);
        const wetR = Math.tanh(driveGain * r + hyst * this.prevR);
        this.prevL = wetL;
        this.prevR = wetR;
        if (Math.abs(this.prevL) < 1e-20) this.prevL = 0;
        if (Math.abs(this.prevR) < 1e-20) this.prevR = 0;
        this.lpL += alpha * (wetL - this.lpL);
        this.lpR += alpha * (wetR - this.lpR);
        if (Math.abs(this.lpL) < 1e-20) this.lpL = 0;
        if (Math.abs(this.lpR) < 1e-20) this.lpR = 0;
        const tonedL = this.lpL;
        const tonedR = this.lpR;
        outL[i] = (l * (1 - mix) + tonedL * mix) * outGain;
        if (outR) outR[i] = (r * (1 - mix) + tonedR * mix) * outGain;
      }
      return true;
    }
  };
  registerProcessor("tape-processor", TapeProcessor);

  // src/audio-worklets/comb-processor.js
  var COMB_SIZE = 8192;
  var COMB_MASK = COMB_SIZE - 1;
  var CombProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.bufL = new Float32Array(COMB_SIZE);
      this.bufR = new Float32Array(COMB_SIZE);
      this.writeIdx = 0;
      this.dampL = 0;
      this.dampR = 0;
    }
    static get parameterDescriptors() {
      return [
        { name: "delayMs", defaultValue: 12, minValue: 0.5, maxValue: 60, automationRate: "k-rate" },
        { name: "feedback", defaultValue: 0.5, minValue: -0.95, maxValue: 0.95, automationRate: "k-rate" },
        { name: "damp", defaultValue: 6500, minValue: 500, maxValue: 12e3, automationRate: "k-rate" },
        { name: "mix", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" }
      ];
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
      const sr = globalThis.sampleRate || 44100;
      const delayMs = Math.max(0.5, Math.min(60, parameters.delayMs[0]));
      const feedback = Math.max(-0.95, Math.min(0.95, parameters.feedback[0]));
      const dampFreq = Math.max(500, Math.min(12e3, parameters.damp[0]));
      const mix = Math.max(0, Math.min(1, parameters.mix[0]));
      const delaySamples = delayMs * sr / 1e3;
      const dampAlpha = 1 - Math.exp(-2 * Math.PI * dampFreq / sr);
      for (let i = 0; i < len; i++) {
        const l = inL ? inL[i] : 0;
        const r = inR ? inR[i] : l;
        const readPos = this.writeIdx - delaySamples;
        const delayedL = this.readLinear(this.bufL, readPos);
        const delayedR = this.readLinear(this.bufR, readPos);
        this.dampL += dampAlpha * (delayedL - this.dampL);
        this.dampR += dampAlpha * (delayedR - this.dampR);
        if (Math.abs(this.dampL) < 1e-20) this.dampL = 0;
        if (Math.abs(this.dampR) < 1e-20) this.dampR = 0;
        const wetL = this.dampL;
        const wetR = this.dampR;
        let wL = l + feedback * wetL;
        let wR = r + feedback * wetR;
        if (Math.abs(wL) < 1e-20) wL = 0;
        if (Math.abs(wR) < 1e-20) wR = 0;
        this.bufL[this.writeIdx] = wL;
        this.bufR[this.writeIdx] = wR;
        this.writeIdx = this.writeIdx + 1 & COMB_MASK;
        outL[i] = l * (1 - mix) + wetL * mix;
        if (outR) outR[i] = r * (1 - mix) + wetR * mix;
      }
      return true;
    }
    readLinear(buf, position) {
      const idx0 = Math.floor(position);
      const frac = position - idx0;
      const i0 = idx0 & COMB_MASK;
      const i1 = idx0 + 1 & COMB_MASK;
      return buf[i0] * (1 - frac) + buf[i1] * frac;
    }
  };
  registerProcessor("comb-processor", CombProcessor);

  // src/audio-worklets/vowel-processor.js
  var VOWEL_FREQS = [
    [860, 1220, 2500],
    // A
    [560, 1840, 2580],
    // E
    [300, 2320, 3e3],
    // I
    [600, 900, 2400],
    // O
    [320, 800, 2300]
    // U
  ];
  var VowelProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.x1 = [
        [0, 0],
        [0, 0],
        [0, 0]
      ];
      this.x2 = [
        [0, 0],
        [0, 0],
        [0, 0]
      ];
      this.y1 = [
        [0, 0],
        [0, 0],
        [0, 0]
      ];
      this.y2 = [
        [0, 0],
        [0, 0],
        [0, 0]
      ];
      this.b0 = [1, 1, 1];
      this.b1 = [0, 0, 0];
      this.b2 = [0, 0, 0];
      this.a1 = [0, 0, 0];
      this.a2 = [0, 0, 0];
      this.lastVowel = -1;
      this.lastRes = -1;
    }
    static get parameterDescriptors() {
      return [
        { name: "vowel", defaultValue: 0, minValue: 0, maxValue: 4, automationRate: "k-rate" },
        { name: "resonance", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }
      ];
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
      const sr = globalThis.sampleRate || 44100;
      const vowel = Math.max(0, Math.min(4, parameters.vowel[0]));
      const res = Math.max(0, Math.min(1, parameters.resonance[0]));
      const mix = Math.max(0, Math.min(1, parameters.mix[0]));
      if (vowel !== this.lastVowel || res !== this.lastRes) {
        this.lastVowel = vowel;
        this.lastRes = res;
        const idx = Math.floor(vowel);
        const frac = vowel - idx;
        const i0 = Math.max(0, Math.min(4, idx));
        const i1 = Math.max(0, Math.min(4, idx + 1));
        const f0 = VOWEL_FREQS[i0];
        const f1 = VOWEL_FREQS[i1];
        const Q = 3.5 + res * 5.5;
        const gainDb = 7 + res * 8;
        for (let f = 0; f < 3; f++) {
          const freq = Math.exp((1 - frac) * Math.log(f0[f]) + frac * Math.log(f1[f]));
          const fc = Math.max(20, Math.min(sr * 0.48, freq));
          const A = Math.pow(10, gainDb / 40);
          const w0 = 2 * Math.PI * fc / sr;
          const cosw0 = Math.cos(w0);
          const sinw0 = Math.sin(w0);
          const alpha = sinw0 / (2 * Q);
          const b0 = 1 + alpha * A;
          const b1 = -2 * cosw0;
          const b2 = 1 - alpha * A;
          const a0 = 1 + alpha / A;
          const a1 = -2 * cosw0;
          const a2 = 1 - alpha / A;
          this.b0[f] = b0 / a0;
          this.b1[f] = b1 / a0;
          this.b2[f] = b2 / a0;
          this.a1[f] = a1 / a0;
          this.a2[f] = a2 / a0;
        }
      }
      for (let i = 0; i < len; i++) {
        let l = inL ? inL[i] : 0;
        let r = inR ? inR[i] : l;
        let wetL = l;
        let wetR = r;
        for (let f = 0; f < 3; f++) {
          const b0 = this.b0[f], b1 = this.b1[f], b2 = this.b2[f], a1 = this.a1[f], a2 = this.a2[f];
          let yL = b0 * wetL + b1 * this.x1[f][0] + b2 * this.x2[f][0] - a1 * this.y1[f][0] - a2 * this.y2[f][0];
          this.x2[f][0] = this.x1[f][0];
          this.x1[f][0] = wetL;
          this.y2[f][0] = this.y1[f][0];
          this.y1[f][0] = yL;
          if (Math.abs(this.x1[f][0]) < 1e-20) this.x1[f][0] = 0;
          if (Math.abs(this.x2[f][0]) < 1e-20) this.x2[f][0] = 0;
          if (Math.abs(this.y1[f][0]) < 1e-20) this.y1[f][0] = 0;
          if (Math.abs(this.y2[f][0]) < 1e-20) this.y2[f][0] = 0;
          if (Math.abs(yL) < 1e-20) yL = 0;
          wetL = yL;
          let yR = b0 * wetR + b1 * this.x1[f][1] + b2 * this.x2[f][1] - a1 * this.y1[f][1] - a2 * this.y2[f][1];
          this.x2[f][1] = this.x1[f][1];
          this.x1[f][1] = wetR;
          this.y2[f][1] = this.y1[f][1];
          this.y1[f][1] = yR;
          if (Math.abs(this.x1[f][1]) < 1e-20) this.x1[f][1] = 0;
          if (Math.abs(this.x2[f][1]) < 1e-20) this.x2[f][1] = 0;
          if (Math.abs(this.y1[f][1]) < 1e-20) this.y1[f][1] = 0;
          if (Math.abs(this.y2[f][1]) < 1e-20) this.y2[f][1] = 0;
          if (Math.abs(yR) < 1e-20) yR = 0;
          wetR = yR;
        }
        outL[i] = l * (1 - mix) + wetL * mix;
        if (outR) outR[i] = r * (1 - mix) + wetR * mix;
      }
      return true;
    }
  };
  registerProcessor("vowel-processor", VowelProcessor);

  // src/audio-worklets/ducking-delay-processor.js
  var DUCK_BUF_SIZE = 131072;
  var DUCK_MASK = DUCK_BUF_SIZE - 1;
  var DuckingDelayProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.bufL = new Float32Array(DUCK_BUF_SIZE);
      this.bufR = new Float32Array(DUCK_BUF_SIZE);
      this.writeIdx = 0;
      this.env = 0;
      this.dampL = 0;
      this.dampR = 0;
    }
    static get parameterDescriptors() {
      return [
        { name: "time", defaultValue: 375, minValue: 30, maxValue: 1e3, automationRate: "k-rate" },
        { name: "feedback", defaultValue: 0.35, minValue: 0, maxValue: 0.9, automationRate: "k-rate" },
        { name: "tone", defaultValue: 4e3, minValue: 500, maxValue: 8e3, automationRate: "k-rate" },
        { name: "duckAmount", defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "duckThresh", defaultValue: -24, minValue: -60, maxValue: 0, automationRate: "k-rate" },
        { name: "duckAttack", defaultValue: 5e-3, minValue: 1e-3, maxValue: 0.5, automationRate: "k-rate" },
        { name: "duckRelease", defaultValue: 0.18, minValue: 0.02, maxValue: 1, automationRate: "k-rate" },
        { name: "mix", defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: "k-rate" }
      ];
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
      const sr = globalThis.sampleRate || 44100;
      const delayMs = Math.max(30, Math.min(1e3, parameters.time[0]));
      const feedback = Math.max(0, Math.min(0.9, parameters.feedback[0]));
      const tone = Math.max(500, Math.min(8e3, parameters.tone[0]));
      const duckAmt = Math.max(0, Math.min(1, parameters.duckAmount[0]));
      const threshDb = Math.max(-60, Math.min(0, parameters.duckThresh[0]));
      const atkSec = Math.max(1e-3, parameters.duckAttack[0]);
      const relSec = Math.max(0.02, parameters.duckRelease[0]);
      const mix = Math.max(0, Math.min(1, parameters.mix[0]));
      const delaySamples = delayMs * sr / 1e3;
      const toneAlpha = 1 - Math.exp(-2 * Math.PI * tone / sr);
      const threshLin = Math.pow(10, threshDb / 20);
      const atkCoef = Math.exp(-1 / (sr * atkSec));
      const relCoef = Math.exp(-1 / (sr * relSec));
      for (let i = 0; i < len; i++) {
        const l = inL ? inL[i] : 0;
        const r = inR ? inR[i] : l;
        const peak = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
        this.env = peak > this.env ? atkCoef * this.env + (1 - atkCoef) * peak : relCoef * this.env + (1 - relCoef) * peak;
        if (Math.abs(this.env) < 1e-20) this.env = 0;
        let duckGain = 1;
        if (duckAmt > 1e-3 && this.env > threshLin) {
          const over = (this.env - threshLin) / Math.max(1e-6, 1 - threshLin);
          duckGain = 1 - duckAmt * Math.min(1, over);
          if (duckGain < 0) duckGain = 0;
        }
        const readPos = this.writeIdx - delaySamples;
        const delayedL = this.readLinear(this.bufL, readPos);
        const delayedR = this.readLinear(this.bufR, readPos);
        this.dampL += toneAlpha * (delayedL - this.dampL);
        this.dampR += toneAlpha * (delayedR - this.dampR);
        if (Math.abs(this.dampL) < 1e-20) this.dampL = 0;
        if (Math.abs(this.dampR) < 1e-20) this.dampR = 0;
        const dampL = this.dampL;
        const dampR = this.dampR;
        const wetL = dampL * duckGain;
        const wetR = dampR * duckGain;
        outL[i] = l * (1 - mix) + wetL * mix;
        if (outR) outR[i] = r * (1 - mix) + wetR * mix;
        let wL = l + dampL * feedback;
        let wR = r + dampR * feedback;
        if (Math.abs(wL) < 1e-20) wL = 0;
        if (Math.abs(wR) < 1e-20) wR = 0;
        this.bufL[this.writeIdx] = wL;
        this.bufR[this.writeIdx] = wR;
        this.writeIdx = this.writeIdx + 1 & DUCK_MASK;
      }
      return true;
    }
    readLinear(buf, position) {
      const idx0 = Math.floor(position);
      const frac = position - idx0;
      const i0 = idx0 & DUCK_MASK;
      const i1 = idx0 + 1 & DUCK_MASK;
      return buf[i0] * (1 - frac) + buf[i1] * frac;
    }
  };
  registerProcessor("ducking-delay-processor", DuckingDelayProcessor);

  // src/audio-worklets/kaskada-processor.js
  var MAX_DELAY_MS = 2e3;
  var SYNC_RATIO = [0, 1, 0.5, 1 / 3, 0.25, 1 / 6];
  var TWO_PI = Math.PI * 2;
  var KaskadaProcessor = class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: "time", defaultValue: 375, minValue: 30, maxValue: 2e3, automationRate: "k-rate" },
        { name: "sync", defaultValue: 0, minValue: 0, maxValue: 5, automationRate: "k-rate" },
        { name: "bpm", defaultValue: 120, minValue: 40, maxValue: 240, automationRate: "k-rate" },
        { name: "pingPong", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "feedback", defaultValue: 0.35, minValue: 0, maxValue: 0.95, automationRate: "k-rate" },
        { name: "toneLp", defaultValue: 4500, minValue: 500, maxValue: 12e3, automationRate: "k-rate" },
        { name: "toneHp", defaultValue: 150, minValue: 20, maxValue: 800, automationRate: "k-rate" },
        { name: "drive", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "modRate", defaultValue: 0.6, minValue: 0.1, maxValue: 8, automationRate: "k-rate" },
        { name: "modDepth", defaultValue: 0.15, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "spread", defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "freeze", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "character", defaultValue: 1, minValue: 0, maxValue: 2, automationRate: "k-rate" },
        { name: "mix", defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "level", defaultValue: -6, minValue: -24, maxValue: 6, automationRate: "k-rate" }
      ];
    }
    constructor() {
      super();
      this.sr = sampleRate;
      this.bufSize = Math.ceil(MAX_DELAY_MS / 1e3 * this.sr) + 1;
      this.bufL = new Float32Array(this.bufSize);
      this.bufR = new Float32Array(this.bufSize);
      this.writePos = 0;
      this.lfoPhase = 0;
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
      this.lp1L = this.makeBiquad();
      this.lp1R = this.makeBiquad();
      this.lp2L = this.makeBiquad();
      this.lp2R = this.makeBiquad();
      this.hp1L = this.makeBiquad();
      this.hp1R = this.makeBiquad();
      this.hp2L = this.makeBiquad();
      this.hp2R = this.makeBiquad();
      this.lpL1c = this.lpCoeffs(4500, this.sr);
      this.lpR1c = this.lpCoeffs(4500, this.sr);
      this.hpL1c = this.hpCoeffs(150, this.sr);
      this.hpR1c = this.hpCoeffs(150, this.sr);
      this.charLpz = 0;
      this.charRpz = 0;
      this.charLpCoef = 1 - Math.exp(-2 * Math.PI * 3500 / this.sr);
      this.lfoPhase = 0;
      this.wobPhaseL = 0;
      this.wobPhaseR = Math.PI / 3;
      this.dcxL = 0;
      this.dcyL = 0;
      this.dcxR = 0;
      this.dcyR = 0;
      this.dcCoef = 1 - TWO_PI * 5 / this.sr;
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
      const w0 = 2 * Math.PI * freq / sr;
      const cos = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 / Math.SQRT2);
      const a0 = 1 + alpha;
      return {
        b0: (1 - cos) / 2 / a0,
        b1: (1 - cos) / 1 / a0,
        b2: (1 - cos) / 2 / a0,
        a1: -2 * cos / a0,
        a2: (1 - alpha) / a0
      };
    }
    hpCoeffs(freq, sr) {
      const w0 = 2 * Math.PI * freq / sr;
      const cos = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 / Math.SQRT2);
      const a0 = 1 + alpha;
      return {
        b0: (1 + cos) / 2 / a0,
        b1: -(1 + cos) / a0,
        b2: (1 + cos) / 2 / a0,
        a1: -2 * cos / a0,
        a2: (1 - alpha) / a0
      };
    }
    applyBiquad(state, coeffs, x) {
      const y = coeffs.b0 * x + coeffs.b1 * state.x1 + coeffs.b2 * state.x2 - coeffs.a1 * state.y1 - coeffs.a2 * state.y2;
      state.x2 = state.x1;
      state.x1 = x;
      state.y2 = state.y1;
      const clean = Math.abs(y) < 1e-20 ? 0 : y;
      state.y1 = clean;
      return clean;
    }
    /** Cubic-hermite read from a ring buffer at a fractional position
     *  (4-point, 3rd order — clean under fast delay-time modulation). */
    readBuffer(buf, pos) {
      const size = this.bufSize;
      let p = pos % size;
      if (p < 0) p += size;
      const i0 = Math.floor(p);
      const frac = p - i0;
      const im1 = (i0 + size - 1) % size;
      const i1 = (i0 + 1) % size;
      const i2 = (i0 + 2) % size;
      const xm1 = buf[im1], x0 = buf[i0], x1 = buf[i1], x2 = buf[i2];
      const c1 = 0.5 * (x1 - xm1);
      const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
      const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
      return ((c3 * frac + c2) * frac + c1) * frac + x0;
    }
    process(inputs, outputs, params) {
      const output = outputs[0];
      if (!output || !output[0]) return true;
      const input = inputs[0];
      const hasInput = input && input[0];
      const outL = output[0];
      const outR = output[1] ?? output[0];
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
            Math.max(1, SYNC_RATIO[sync] * (60 / bpm) * this.sr)
          );
        } else {
          this.delaySamples = Math.min(
            this.bufSize - 1,
            Math.max(1, timeMs / 1e3 * this.sr)
          );
        }
      }
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
      this.pingPong = params.pingPong[0] > 0.5;
      this.fbGain = params.feedback[0];
      this.drive = params.drive[0];
      this.spread = params.spread[0];
      this.freeze = params.freeze[0] > 0.5;
      this.character = Math.round(params.character[0]);
      this.mix = params.mix[0];
      this.outGain = Math.pow(10, params.level[0] / 20);
      this.modDepthMs = params.modDepth[0] * this.delaySamples * 0.25;
      const pingPong = this.pingPong;
      const fbGain = this.fbGain;
      const drive = this.drive;
      const driveGain = 1 + drive * 2;
      const mix = this.mix;
      const spread = this.spread;
      const modDepthMs = this.modDepthMs;
      const modRateInc = TWO_PI * params.modRate[0] / this.sr;
      const character = this.character;
      const wobbleAmp = character === 1 ? 5e-4 * this.sr : 0;
      const wobRateInc = TWO_PI * 0.7 / this.sr;
      const L = this.bufL, R = this.bufR;
      const size = this.bufSize;
      for (let i = 0; i < outL.length; i++) {
        const writeIdx = this.writePos;
        const lfo = Math.sin(this.lfoPhase);
        this.lfoPhase += modRateInc;
        if (this.lfoPhase > TWO_PI) this.lfoPhase -= TWO_PI;
        const delayPos = this.delaySamples + lfo * modDepthMs;
        let wobL = 0;
        let wobR = 0;
        if (wobbleAmp > 0) {
          this.wobPhaseL += wobRateInc;
          this.wobPhaseR += wobRateInc;
          if (this.wobPhaseL > TWO_PI) this.wobPhaseL -= TWO_PI;
          if (this.wobPhaseR > TWO_PI) this.wobPhaseR -= TWO_PI;
          wobL = Math.sin(this.wobPhaseL) * wobbleAmp;
          wobR = Math.sin(this.wobPhaseR) * wobbleAmp;
        }
        let wetL = this.readBuffer(L, writeIdx - delayPos - wobL);
        let wetR = this.readBuffer(R, writeIdx - delayPos - wobR);
        let dc = wetL - this.dcxL + this.dcCoef * this.dcyL;
        this.dcxL = wetL;
        this.dcyL = dc;
        wetL = dc;
        dc = wetR - this.dcxR + this.dcCoef * this.dcyR;
        this.dcxR = wetR;
        this.dcyR = dc;
        wetR = dc;
        if (character === 1) {
          this.charLpz += this.charLpCoef * (wetL - this.charLpz);
          this.charRpz += this.charLpCoef * (wetR - this.charRpz);
          wetL = this.charLpz;
          wetR = this.charRpz;
        } else if (character === 2) {
          this.charLpz += this.charLpCoef * (wetL - this.charLpz);
          this.charRpz += this.charLpCoef * (wetR - this.charRpz);
          wetL = this.charLpz * 0.9;
          wetR = this.charRpz * 0.9;
        }
        wetL = this.applyBiquad(this.lp1L, this.lpL1c, wetL);
        wetL = this.applyBiquad(this.lp2L, this.lpL1c, wetL);
        wetL = this.applyBiquad(this.hp1L, this.hpL1c, wetL);
        wetL = this.applyBiquad(this.hp2L, this.hpL1c, wetL);
        wetR = this.applyBiquad(this.lp1R, this.lpR1c, wetR);
        wetR = this.applyBiquad(this.lp2R, this.lpR1c, wetR);
        wetR = this.applyBiquad(this.hp1R, this.hpR1c, wetR);
        wetR = this.applyBiquad(this.hp2R, this.hpR1c, wetR);
        if (drive > 0) {
          wetL = Math.tanh(wetL * driveGain) / driveGain;
          wetR = Math.tanh(wetR * driveGain) / driveGain;
        }
        const fbL = pingPong ? wetR : wetL;
        const fbR = pingPong ? wetL : wetR;
        const inL = hasInput ? input[0][i] : 0;
        const inR = hasInput && input[1] ? input[1][i] : inL;
        if (this.freeze) {
          L[writeIdx] = fbL * 0.99;
          R[writeIdx] = fbR * 0.99;
        } else {
          L[writeIdx] = inL + fbL * fbGain;
          R[writeIdx] = inR + fbR * fbGain;
        }
        const outWL = wetL + spread * 0.5 * (wetR - wetL);
        const outWR = wetR + spread * 0.5 * (wetL - wetR);
        outL[i] = inL * (1 - mix) + outWL * mix * this.outGain;
        outR[i] = inR * (1 - mix) + outWR * mix * this.outGain;
        this.writePos = (writeIdx + 1) % size;
      }
      return true;
    }
  };
  registerProcessor("kaskada", KaskadaProcessor);

  // src/audio-worklets/reverb-processor.js
  var REVERB_COMB_DELAYS = [1557, 1617, 1491, 1422];
  var ALLPASS_DELAYS = [556, 441];
  var ReverbProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      const maxComb = Math.max(...REVERB_COMB_DELAYS) + 1024;
      const size = 1 << Math.ceil(Math.log2(maxComb * 2));
      this.size = size;
      this.mask = size - 1;
      this.combBufs = Array.from({ length: 4 }, () => [new Float32Array(size), new Float32Array(size)]);
      this.combIdx = [0, 0, 0, 0];
      this.combDampL = [0, 0, 0, 0];
      this.combDampR = [0, 0, 0, 0];
      const apSize = 2048;
      this.apSize = apSize;
      this.apMask = apSize - 1;
      this.apBufs = Array.from({ length: 2 }, () => [new Float32Array(apSize), new Float32Array(apSize)]);
      this.apIdx = [0, 0];
    }
    static get parameterDescriptors() {
      return [
        { name: "decay", defaultValue: 1.8, minValue: 0.1, maxValue: 6, automationRate: "k-rate" },
        { name: "damping", defaultValue: 6e3, minValue: 500, maxValue: 12e3, automationRate: "k-rate" },
        { name: "diffusion", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
        { name: "tone", defaultValue: 6e3, minValue: 500, maxValue: 12e3, automationRate: "k-rate" }
      ];
    }
    process(inputs, outputs, parameters) {
      const output = outputs[0];
      if (!output || !output[0]) return true;
      const outL = output[0];
      const outR = output.length > 1 && output[1] ? output[1] : null;
      const input = inputs[0];
      const inL = input && input[0] && input[0].length ? input[0] : null;
      const inR = input && input.length > 1 && input[1] && input[1].length ? input[1] : null;
      if (!inL && !inR) {
        for (let i = 0; i < outL.length; i++) {
          outL[i] = 0;
          if (outR) outR[i] = 0;
        }
        return true;
      }
      const len = outL.length;
      const sr = globalThis.sampleRate || 44100;
      const decay = Math.max(0.1, Math.min(6, parameters.decay[0]));
      const dampingFreq = Math.max(
        500,
        Math.min(12e3, parameters.damping ? parameters.damping[0] : parameters.tone ? parameters.tone[0] : 6e3)
      );
      const diffusion = Math.max(0, Math.min(1, parameters.diffusion ? parameters.diffusion[0] : 0.5));
      const toneFreq = Math.max(500, Math.min(12e3, parameters.tone ? parameters.tone[0] : dampingFreq));
      const effDamp = Math.min(dampingFreq, toneFreq);
      const dampAlpha = 1 - Math.exp(-2 * Math.PI * effDamp / sr);
      const combFeedback = REVERB_COMB_DELAYS.map((d) => {
        const ms = d * sr / 48e3 / sr * 1e3;
        const g = Math.pow(10, -3 * ms / (decay * 1e3));
        return Math.min(0.98, g);
      });
      const apFeedback = 0.3 + diffusion * 0.4;
      for (let i = 0; i < len; i++) {
        const l = inL ? inL[i] : 0;
        const r = inR ? inR[i] : l;
        const inputMono = (l + r) * 0.5;
        let sumL = 0;
        let sumR = 0;
        for (let c = 0; c < 4; c++) {
          const delaySamples = REVERB_COMB_DELAYS[c] * sr / 48e3;
          const fb = combFeedback[c];
          const detuneL = 1 - 0.01 * (c % 2 === 0 ? 1 : -1) * 0.5;
          const detuneR = 1 + 0.01 * (c % 2 === 0 ? 1 : -1) * 0.5;
          const readL = this.readComb(c, 0, delaySamples * detuneL);
          const readR = this.readComb(c, 1, delaySamples * detuneR);
          this.combDampL[c] += dampAlpha * (readL - this.combDampL[c]);
          this.combDampR[c] += dampAlpha * (readR - this.combDampR[c]);
          if (Math.abs(this.combDampL[c]) < 1e-20) this.combDampL[c] = 0;
          if (Math.abs(this.combDampR[c]) < 1e-20) this.combDampR[c] = 0;
          const dampL = this.combDampL[c];
          const dampR = this.combDampR[c];
          const wL = inputMono + dampL * fb;
          const wR = inputMono + dampR * fb;
          this.writeComb(c, 0, wL);
          this.writeComb(c, 1, wR);
          sumL += dampL;
          sumR += dampR;
        }
        sumL *= 0.25;
        sumR *= 0.25;
        let apL = this.processAllpass(0, 0, sumL, ALLPASS_DELAYS[0], apFeedback);
        let apR = this.processAllpass(0, 1, sumR, ALLPASS_DELAYS[0], apFeedback);
        apL = this.processAllpass(1, 0, apL, ALLPASS_DELAYS[1], apFeedback);
        apR = this.processAllpass(1, 1, apR, ALLPASS_DELAYS[1], apFeedback);
        outL[i] = apL;
        if (outR) outR[i] = apR;
      }
      return true;
    }
    readComb(combIdx, ch, delaySamples) {
      const idx = this.combIdx[combIdx];
      const pos = idx - delaySamples;
      const i0 = Math.floor(pos) & this.mask;
      const i1 = i0 + 1 & this.mask;
      const frac = pos - Math.floor(pos);
      const buf = this.combBufs[combIdx][ch];
      return buf[i0] * (1 - frac) + buf[i1] * frac;
    }
    writeComb(combIdx, ch, value) {
      const buf = this.combBufs[combIdx][ch];
      const idx = this.combIdx[combIdx] & this.mask;
      buf[idx] = value;
      if (ch === 1) this.combIdx[combIdx] = this.combIdx[combIdx] + 1 & this.mask;
    }
    processAllpass(apIdx, ch, input, delaySamples, feedback) {
      const buf = this.apBufs[apIdx][ch];
      let idx = this.apIdx[apIdx];
      const readPos = idx - delaySamples;
      const i0 = Math.floor(readPos) & this.apMask;
      const i1 = i0 + 1 & this.apMask;
      const frac = readPos - Math.floor(readPos);
      const delayed = buf[i0] * (1 - frac) + buf[i1] * frac;
      const output = -feedback * input + delayed;
      const writeVal = input + feedback * delayed;
      buf[idx & this.apMask] = writeVal;
      if (ch === 1) this.apIdx[apIdx] = this.apIdx[apIdx] + 1 & this.apMask;
      if (Math.abs(output) < 1e-20) return 0;
      return output;
    }
  };
  registerProcessor("reverb-processor", ReverbProcessor);
})();
