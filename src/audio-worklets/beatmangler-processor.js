/**
 * Beat Mangler AudioWorkletProcessor — Gross-Beat style bar-synced mangler.
 *
 * A ring buffer records the live stream continuously. A tape-style read head
 * loops the LAST recorded bar under two step envelopes (16/32 steps):
 *  - volumeSteps[]  — gain per step (0..1)
 *  - pitchSteps[]   — read-speed multiplier per step (±24 semitones, tape-style)
 * plus play modes normal / HALF (0.5×) / DOUBLE (2×) / REVERSE and a
 * repeat-fill that loops the bar's final segment to build fill bridges.
 *
 * Steps + BPM arrive over the message port (`{ type: "steps" | "bpm" | "mode" }`)
 * — envelope data is document state, not an AudioParam. All reads derive from
 * the write clock (no RNG) → deterministic renders.
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */
class BeatManglerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = globalThis.sampleRate || 44100;
    this.sr = sr;
    this.bufferLen = sr * 12; // 2 bars @ 80 BPM + headroom
    this.bufL = new Float32Array(this.bufferLen);
    this.bufR = new Float32Array(this.bufferLen);
    this.writePos = 0;

    this.bpm = 120;
    this.barSamples = (60 / this.bpm) * 4 * sr;
    this.volumeSteps = null; // number[] | null (null = unity envelope)
    this.pitchSteps = null;
    this.stepsPerBar = 16;
    this.playMode = 0; // 0 normal, 1 half, 2 double, 3 reverse
    this.repeatFill = 0;
    this.mix = 1;
    this.readPos = null; // stateful tape head (absolute sample position)

    this.port.onmessage = (event) => {
      const data = event.data ?? {};
      if (data.type === "steps") {
        this.volumeSteps = Array.isArray(data.volume) && data.volume.length > 0 ? data.volume.slice() : null;
        this.pitchSteps = Array.isArray(data.pitch) && data.pitch.length > 0 ? data.pitch.slice() : null;
        const len = this.volumeSteps ? this.volumeSteps.length : this.pitchSteps ? this.pitchSteps.length : 16;
        this.stepsPerBar = len;
      } else if (data.type === "bpm" && Number.isFinite(data.bpm) && data.bpm > 0) {
        this.bpm = data.bpm;
        this.barSamples = (60 / this.bpm) * 4 * sr;
        this.readPos = null; // re-anchor on the next bar
      } else if (data.type === "mode") {
        if (Number.isFinite(data.playMode)) this.playMode = data.playMode;
        if (Number.isFinite(data.repeatFill)) this.repeatFill = Math.max(0, Math.min(8, Math.round(data.repeatFill)));
        if (Number.isFinite(data.mix)) this.mix = data.mix;
      }
    };
  }

  static get parameterDescriptors() {
    return [{ name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }];
  }

  readAt(absPos, channel) {
    let p = absPos % this.bufferLen;
    if (p < 0) p += this.bufferLen;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const i1 = (i0 + 1) % this.bufferLen;
    const buf = channel === 1 ? this.bufR : this.bufL;
    return buf[i0] * (1 - frac) + buf[i1] * frac;
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
    const first = this.writePos;

    // Record continuously — the mangler replays what it just heard.
    for (let i = 0; i < len; i++) {
      this.bufL[(first + i) % this.bufferLen] = inL ? inL[i] : 0;
      this.bufR[(first + i) % this.bufferLen] = inR && inR.length > i ? inR[i] : inL ? inL[i] : 0;
    }
    this.writePos = first + len;

    const hasVol = !!this.volumeSteps;
    const hasPitch = !!this.pitchSteps;
    const idle = !hasVol && !hasPitch && this.playMode === 0 && this.repeatFill === 0;
    const barStart = this.writePos - this.barSamples;
    const full = this.writePos >= this.barSamples;
    if (!full) {
      // First bar still filling — passthrough until there is a bar to loop.
      for (let i = 0; i < len; i++) {
        outL[i] = inL ? inL[i] : 0;
        if (outR) outR[i] = inR && inR.length > i ? inR[i] : inL ? inL[i] : 0;
      }
      return true;
    }
    if (idle) {
      this.readPos = null;
      for (let i = 0; i < len; i++) {
        outL[i] = inL ? inL[i] : 0;
        if (outR) outR[i] = inR && inR.length > i ? inR[i] : inL ? inL[i] : 0;
      }
      return true;
    }
    // (Re-)anchor the head at the bar start when engaging or after BPM change.
    if (this.readPos === null || this.readPos < barStart - this.barSamples || this.readPos > this.writePos) {
      this.readPos = barStart;
    }

    const modeMult = this.playMode === 1 ? 0.5 : this.playMode === 2 ? 2 : this.playMode === 3 ? -1 : 1;
    // The bar window anchors on the LAST COMPLETED bar boundary before the
    // write head — stable within a block, advancing one bar per boundary so
    // the loop always plays the freshest full bar (never a sliding freeze).
    const windowStart = Math.floor((this.writePos - this.barSamples) / this.barSamples) * this.barSamples;

    for (let i = 0; i < len; i++) {
      const live = inL ? inL[i] : 0;
      const liveR = inR && inR.length > i ? inR[i] : live;

      const phase = (this.readPos - windowStart) / this.barSamples; // 0..1 across the bar
      const stepIdx = Math.min(this.stepsPerBar - 1, Math.max(0, Math.floor(phase * this.stepsPerBar)));
      const vol = hasVol ? Math.max(0, Math.min(1, this.volumeSteps[stepIdx])) : 1;
      const pitch = hasPitch ? Math.max(-24, Math.min(24, this.pitchSteps[stepIdx])) : 0;
      const speed = modeMult * Math.pow(2, pitch / 12);

      const wetL = this.readAt(this.readPos, 0) * vol;
      const wetR = this.readAt(this.readPos, 1) * vol;
      outL[i] = live * (1 - this.mix) + wetL * this.mix;
      if (outR) outR[i] = liveR * (1 - this.mix) + wetR * this.mix;

      this.readPos += speed;
      // Wrap within [windowStart, writePos). Repeat-fill re-enters at the
      // bar's final 1/N segment (fill bridge) instead of the bar start.
      if (this.repeatFill >= 2 && this.readPos >= this.writePos) {
        this.readPos = this.writePos - this.barSamples / this.repeatFill;
      } else if (this.readPos >= this.writePos) {
        this.readPos = windowStart + ((this.readPos - this.writePos) % this.barSamples);
      } else if (this.readPos < windowStart) {
        this.readPos = this.writePos - 1;
      }
    }
    return true;
  }
}

registerProcessor("beatmangler-processor", BeatManglerProcessor);
