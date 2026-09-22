/**
 * K-Weighted Loudness Meter AudioWorkletProcessor (ITU-R BS.1770-4).
 *
 * SINK node (no outputs): master bus feeds it stereo audio; the processor
 * runs the K-weighting biquads per sample and maintains BS.1770 loudness
 * blocks (400 ms, 100 ms hop), the dual gate (absolute −70 LUFS, relative
 * −10 LU) and short-term windows (3 s). Posts { type: "loudness",
 * m, s, i } ~10×/second.
 *
 * The two biquad stages arrive via processorOptions as
 * { s1: [b0,b1,b2,a1,a2], s2: [...] } — computed by the TS wrapper from the
 * shared kweighting.ts math for the actual context sample rate, so this raw
 * JS file contains no duplicated filter design.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
class KwMeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    // Restore-state validation: a malformed uploaded biquad state (wrong
    // length or non-finite) would feed NaN through both filters and pin the
    // meter at -180 forever.
    const stateOf = (v) =>
      Array.isArray(v) && v.length === 5 && v.every((x) => typeof x === "number" && Number.isFinite(x))
        ? v.slice()
        : [1, 0, 0, 0, 0];
    const s1 = stateOf(opts.s1);
    const s2 = stateOf(opts.s2);
    this.s1 = s1;
    this.s2 = s2;
    // Biquad state per channel: [L, R]
    this.x1 = [0, 0];
    this.x2 = [0, 0];
    this.y1 = [0, 0];
    this.y2 = [0, 0];
    this.u1 = [0, 0];
    this.u2 = [0, 0];
    this.w1 = [0, 0];
    this.w2 = [0, 0];

    const sr = globalThis.sampleRate || 48000;
    this.subblockSamples = Math.max(1, Math.round(sr * 0.1)); // 100 ms hop
    this.subCount = 0;
    this.subAccum = [0, 0];
    this.subPowers = []; // channel-summed mean square per 100 ms subblock
    this.integratedStart = 0; // RESET INTEGRATED moves this forward
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
    // Allocation-free two-pass gated loudness (BS.1770): the old version
    // built blocks[] + two filter() arrays + reduce closures every 100 ms on
    // the audio thread — steady garbage for the GC. The scan itself is cheap
    // arithmetic; the allocations were the problem. Numbers only here.
    const powers = this.subPowers;
    const start = this.integratedStart;
    const len = powers.length;
    let sumAbs = 0;
    let countAbs = 0;
    for (let k = start; k + 4 <= len; k++) {
      const ms = (powers[k] + powers[k + 1] + powers[k + 2] + powers[k + 3]) / 4;
      if (this.loudnessOf(ms) > -70) {
        sumAbs += ms;
        countAbs++;
      }
    }
    if (countAbs === 0) return -180;
    // Absolute gate −70 LUFS passed → relative gate −10 LU (power domain).
    const relativeGate = -0.691 + 10 * Math.log10(sumAbs / countAbs) - 10;
    const gate = Math.max(-70, relativeGate);
    let sumG = 0;
    let countG = 0;
    for (let k = start; k + 4 <= len; k++) {
      const ms = (powers[k] + powers[k + 1] + powers[k + 2] + powers[k + 3]) / 4;
      if (this.loudnessOf(ms) >= gate) {
        sumG += ms;
        countG++;
      }
    }
    if (countG === 0) return -180;
    return this.loudnessOf(sumG / countG);
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
      // K-weighting biquad chain per channel.
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
        const hp =
          s2[0] * shelf + s2[1] * this.u1[ch] + s2[2] * this.u2[ch] - s2[3] * this.w1[ch] - s2[4] * this.w2[ch];
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
        if (this.subPowers.length > 36000) {
          this.subPowers.splice(0, 18000); // ~1 h cap
          // integratedStart indexes into subPowers — the splice shifted every
          // surviving entry down by 18000. Without the rebase a RESET done
          // before the splice silently re-gated pre-reset blocks (or ran
          // negative → NaN → integrated read −180 forever in 1h+ sessions).
          this.integratedStart = Math.max(0, this.integratedStart - 18000);
        }
        this.subCount = 0;
        this.subAccum[0] = 0;
        this.subAccum[1] = 0;

        // Momentary: mean of the last 4 subblocks (400 ms).
        const n = this.subPowers.length;
        if (n >= 4) {
          const mPower =
            (this.subPowers[n - 1] + this.subPowers[n - 2] + this.subPowers[n - 3] + this.subPowers[n - 4]) / 4;
          this.loudness.m = this.loudnessOf(mPower);
        }
        // Short-term: mean of the last 30 subblocks (3 s).
        if (n >= 30) {
          let acc = 0;
          for (let k = n - 30; k < n; k++) acc += this.subPowers[k];
          this.loudness.s = this.loudnessOf(acc / 30);
        }
        this.loudness.i = this.integratedLoudness();
      }
    }

    // Post ~10×/s, throttled against the clock.
    const now = typeof globalThis.currentTime === "number" ? globalThis.currentTime : 0;
    if (now - this.lastPost >= 0.1) {
      this.lastPost = now;
      this.port.postMessage({ type: "loudness", m: this.loudness.m, s: this.loudness.s, i: this.loudness.i });
    }
    return true;
  }

  resetLoudness() {
    // RESET INTEGRATED: gating restarts from now — momentary/short-term keep
    // measuring continuously (they are windowed, not accumulated).
    this.integratedStart = this.subPowers.length;
    this.loudness = { m: this.loudness.m, s: this.loudness.s, i: -180 };
  }
}

registerProcessor("kwmeter-processor", KwMeterProcessor);
