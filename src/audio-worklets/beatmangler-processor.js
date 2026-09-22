/**
 * Beat Mangler AudioWorkletProcessor.
 *
 * The effect keeps the original continuous bar mangler when TRIGGER is off.
 * Trigger mode turns it into a musical beat-repeat: on each interval boundary
 * it makes one deterministic chance decision, captures the most recent gate
 * window, then loops that window for the gate duration. All clocks are in
 * quarter-note beats, so live transport, seek, BPM changes and offline render
 * use the same phase model.
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */
const REPEAT_INTERVAL_BEATS = [
  4, 2, 1, 0.5, 0.25, 0.125, // 1/1 … 1/32 straight (stable UI ids 0..5)
  3, 4 / 3, 1.5, 2 / 3, 0.75, 1 / 3, 0.375, 1 / 6, 0.1875, 1 / 12,
];
const REPEAT_GATE_BEATS = [
  4, 2, 1, 0.5, 0.25, 0.125, // 1/1 … 1/32 straight (stable UI ids 0..5)
  3, 4 / 3, 1.5, 2 / 3, 0.75, 1 / 3, 0.375, 1 / 6, 0.1875, 1 / 12,
];

class BeatManglerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = globalThis.sampleRate || 44100;
    this.sr = sr;
    // 13 seconds covers a four-beat gate at the supported 20 BPM floor with
    // one second left so the ring writer cannot overwrite its captured loop.
    this.bufferLen = Math.ceil(sr * 13);
    this.bufL = new Float32Array(this.bufferLen);
    this.bufR = new Float32Array(this.bufferLen);
    this.writePos = 0;

    this.bpm = 120;
    this.barSamples = (60 / this.bpm) * 4 * sr;
    this.transportBeat = 0;
    this.volumeSteps = null;
    this.pitchSteps = null;
    this.stepsPerBar = 16;
    this.playMode = 0; // 0 normal, 1 half, 2 double, 3 reverse
    this.repeatFill = 0;
    this.readPos = null;
    this.seed = 0;
    this.lastEventIndex = null;
    this.lastIntervalIndex = -1;
    this.lastOffsetIndex = -1;
    this.repeatActive = false;
    this.repeatStart = 0;
    this.repeatLength = 0;
    this.repeatReadPos = 0;
    this.repeatElapsed = 0;
    this.repeatDuration = 0;

    this.port.onmessage = (event) => {
      const data = event.data ?? {};
      if (data.type === "steps") {
        const clean = (arr, fallback) =>
          Array.isArray(arr) && arr.length > 0
            ? arr.slice(0, 32).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : fallback))
            : null;
        this.volumeSteps = clean(data.volume, 1);
        this.pitchSteps = clean(data.pitch, 0);
        // The two lanes are independent document arrays and CAN arrive with
        // different lengths; indexing the shorter with stepsPerBar would read
        // undefined → NaN pitch → NaN readPos → permanent NaN audio (the NaN
        // survives every reset comparison). Pad the shorter lane by holding
        // its last step so both lanes always span stepsPerBar.
        const vLen = this.volumeSteps?.length ?? 0;
        const pLen = this.pitchSteps?.length ?? 0;
        this.stepsPerBar = Math.max(vLen, pLen) || 16;
        if (vLen > 0 && pLen > 0 && vLen !== pLen) {
          const short = vLen < pLen ? this.volumeSteps : this.pitchSteps;
          const padded = new Array(Math.max(vLen, pLen));
          for (let s = 0; s < padded.length; s++) padded[s] = short[Math.min(s, short.length - 1)];
          if (vLen < pLen) this.volumeSteps = padded;
          else this.pitchSteps = padded;
        }
      } else if (data.type === "bpm" && Number.isFinite(data.bpm) && data.bpm > 0) {
        this.bpm = Math.max(20, Math.min(300, data.bpm));
        this.barSamples = (60 / this.bpm) * 4 * sr;
        this.readPos = null;
      } else if (data.type === "mode") {
        if (Number.isFinite(data.playMode)) this.playMode = Math.max(0, Math.min(3, Math.round(data.playMode)));
        if (Number.isFinite(data.repeatFill)) this.repeatFill = Math.max(0, Math.min(8, Math.round(data.repeatFill)));
      } else if (data.type === "seed" && Number.isFinite(data.seed)) {
        this.seed = data.seed | 0;
      } else if (data.type === "align") {
        const beat = Number.isFinite(data.positionBeats) ? data.positionBeats : Number(data.phase) || 0;
        this.transportBeat = Math.max(0, beat);
        this.lastEventIndex = null;
        this.repeatActive = false;
        this.readPos = null;
      }
    };
  }

  static get parameterDescriptors() {
    return [
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "trigger", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "interval", defaultValue: 0, minValue: 0, maxValue: REPEAT_INTERVAL_BEATS.length - 1, automationRate: "k-rate" },
      { name: "offset", defaultValue: 0, minValue: 0, maxValue: 15, automationRate: "k-rate" },
      { name: "chance", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "gate", defaultValue: 2, minValue: 0, maxValue: REPEAT_GATE_BEATS.length - 1, automationRate: "k-rate" },
    ];
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

  readSegmentAt(start, length, offset, channel) {
    const wrapped = (((offset % length) + length) % length);
    const i0 = Math.floor(wrapped);
    const frac = wrapped - i0;
    const i1 = (i0 + 1) % length;
    const buf = channel === 1 ? this.bufR : this.bufL;
    const p0 = (start + i0) % this.bufferLen;
    const p1 = (start + i1) % this.bufferLen;
    return buf[p0] * (1 - frac) + buf[p1] * frac;
  }

  randomForEvent(eventIndex) {
    let x = (this.seed ^ Math.imul(eventIndex | 0, 0x9e3779b1)) >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  }

  startRepeat(gateSamples) {
    const length = Math.max(1, Math.min(this.bufferLen - 1, Math.round(gateSamples)));
    if (this.writePos < length) return false; // need a complete captured window
    this.repeatLength = length;
    this.repeatStart = this.writePos - length;
    this.repeatReadPos = this.playMode === 3 ? this.repeatStart + length - 1 : this.repeatStart;
    this.repeatElapsed = 0;
    this.repeatDuration = length;
    this.repeatActive = true;
    return true;
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
    const mix = Math.max(0, Math.min(1, parameters.mix[0]));
    const triggered = parameters.trigger[0] >= 0.5;
    const intervalIndex = Math.max(0, Math.min(REPEAT_INTERVAL_BEATS.length - 1, Math.round(parameters.interval[0])));
    const offsetIndex = Math.max(0, Math.min(15, Math.round(parameters.offset[0])));
    const chance = Math.max(0, Math.min(1, parameters.chance[0]));
    const gateIndex = Math.max(0, Math.min(REPEAT_GATE_BEATS.length - 1, Math.round(parameters.gate[0])));
    const intervalBeats = REPEAT_INTERVAL_BEATS[intervalIndex];
    const offsetBeats = (offsetIndex * 0.25) % intervalBeats;
    const gateSamples = (REPEAT_GATE_BEATS[gateIndex] * 60 * sr) / this.bpm;
    const modeMult = this.playMode === 1 ? 0.5 : this.playMode === 2 ? 2 : this.playMode === 3 ? -1 : 1;

    if (intervalIndex !== this.lastIntervalIndex || offsetIndex !== this.lastOffsetIndex) {
      this.lastIntervalIndex = intervalIndex;
      this.lastOffsetIndex = offsetIndex;
      this.lastEventIndex = Math.ceil((this.transportBeat - offsetBeats) / intervalBeats) - 1;
    }

    const hasVol = !!this.volumeSteps;
    const hasPitch = !!this.pitchSteps;
    const idle = !hasVol && !hasPitch && this.playMode === 0 && this.repeatFill === 0;
    const full = this.writePos >= this.barSamples;
    const windowStart = Math.floor((this.writePos - this.barSamples) / this.barSamples) * this.barSamples;

    for (let i = 0; i < len; i++) {
      const live = inL ? inL[i] : 0;
      const liveR = inR && inR.length > i ? inR[i] : live;

      // Record before capture: each event includes the sample immediately
      // before its boundary, and a gate can never read future input.
      this.bufL[this.writePos % this.bufferLen] = live;
      this.bufR[this.writePos % this.bufferLen] = liveR;
      this.writePos++;

      let out = live;
      let outRight = liveR;
      if (triggered) {
        const eventIndex = Math.floor((this.transportBeat - offsetBeats + 1e-9) / intervalBeats);
        if (eventIndex > this.lastEventIndex) {
          this.lastEventIndex = eventIndex;
          if (eventIndex >= 0 && this.randomForEvent(eventIndex) < chance) this.startRepeat(gateSamples);
        }

        if (this.repeatActive) {
          const span = this.repeatLength;
          let relative = this.repeatReadPos - this.repeatStart;
          if (this.repeatFill >= 2) {
            const fillLength = Math.max(1, span / this.repeatFill);
            const fillStart = span - fillLength;
            relative = fillStart + ((((relative - fillStart) % fillLength) + fillLength) % fillLength);
          } else {
            relative = ((((relative % span) + span) % span));
          }
          const phase = Math.max(0, Math.min(0.999999, relative / span));
          const stepIdx = Math.min(this.stepsPerBar - 1, Math.max(0, Math.floor(phase * this.stepsPerBar)));
          const vol = hasVol ? Math.max(0, Math.min(1, this.volumeSteps[stepIdx])) : 1;
          const pitch = hasPitch ? Math.max(-24, Math.min(24, this.pitchSteps[stepIdx])) : 0;
          const speed = modeMult * Math.pow(2, pitch / 12);
          const wetL = this.readSegmentAt(this.repeatStart, span, relative, 0) * vol;
          const wetR = this.readSegmentAt(this.repeatStart, span, relative, 1) * vol;
          out = live * (1 - mix) + wetL * mix;
          outRight = liveR * (1 - mix) + wetR * mix;
          this.repeatReadPos += speed;
          this.repeatElapsed++;
          if (this.repeatElapsed >= this.repeatDuration) this.repeatActive = false;
        }
      } else if (!idle && full) {
        if (this.readPos === null || this.readPos < windowStart - this.barSamples || this.readPos > this.writePos) {
          this.readPos = windowStart;
        }
        const phase = (this.readPos - windowStart) / this.barSamples;
        const stepIdx = Math.min(this.stepsPerBar - 1, Math.max(0, Math.floor(phase * this.stepsPerBar)));
        const vol = hasVol ? Math.max(0, Math.min(1, this.volumeSteps[stepIdx])) : 1;
        const pitch = hasPitch ? Math.max(-24, Math.min(24, this.pitchSteps[stepIdx])) : 0;
        const speed = modeMult * Math.pow(2, pitch / 12);
        const wetL = this.readAt(this.readPos, 0) * vol;
        const wetR = this.readAt(this.readPos, 1) * vol;
        out = live * (1 - mix) + wetL * mix;
        outRight = liveR * (1 - mix) + wetR * mix;
        this.readPos += speed;
        if (this.repeatFill >= 2 && this.readPos >= this.writePos) {
          this.readPos = this.writePos - this.barSamples / this.repeatFill;
        } else if (this.readPos >= this.writePos) {
          this.readPos = windowStart + ((this.readPos - this.writePos) % this.barSamples);
        } else if (this.readPos < windowStart) {
          this.readPos = this.writePos - 1;
        }
      }

      outL[i] = out;
      if (outR) outR[i] = outRight;
      this.transportBeat += this.bpm / (60 * sr);
    }

    if (idle && !triggered) this.readPos = null;
    return true;
  }
}

registerProcessor("beatmangler-processor", BeatManglerProcessor);
