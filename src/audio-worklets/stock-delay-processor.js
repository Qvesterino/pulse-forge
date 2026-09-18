/**
 * Stock Delay AudioWorkletProcessor — stereo tempo-aware delay with a
 * damped feedback loop.
 *
 * Two delay lines (L/R) with cubic-hermite fractional reads, a one-pole
 * lowpass inside the feedback loop (`tone` 500–8000 Hz, applied per-sample
 * so repeats darken progressively like tape), and an optional ping-pong
 * mode that crossfeeds the loop (L→R→L). `sync` selects a musical division
 * of the `bpm` param (same enum as Kaskáda: OFF/1/4/1/8/1/8T/1/16/1/16T);
 * with sync engaged the `time` knob is ignored until sync returns to OFF.
 *
 * Delay-time changes glide toward the target (20 ms smoothing) instead of
 * stepping — no zipper pitch jumps when automating TIME or switching sync
 * divisions mid-phrase.
 *
 * Deterministic: no PRNG; every state starts at zero.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
const STOCK_DELAY_RING = 192000; // 1 s @192 kHz — matches the 1000 ms TIME max

const STOCK_DELAY_DIVISIONS = [0, 1, 0.5, 1 / 3, 0.25, 1 / 6]; // beats per division index

class StockDelayProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufL = new Float32Array(STOCK_DELAY_RING);
    this.bufR = new Float32Array(STOCK_DELAY_RING);
    this.writeIdx = 0;
    this.curDelayL = 0;
    this.curDelayR = 0;
    this.lpL = 0;
    this.lpR = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "time", defaultValue: 375, minValue: 30, maxValue: 1000, automationRate: "k-rate" }, // ms
      { name: "sync", defaultValue: 0, minValue: 0, maxValue: 5, automationRate: "k-rate" },
      { name: "bpm", defaultValue: 120, minValue: 20, maxValue: 300, automationRate: "k-rate" },
      { name: "pingPong", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "feedback", defaultValue: 0.35, minValue: 0, maxValue: 0.9, automationRate: "k-rate" },
      { name: "tone", defaultValue: 4000, minValue: 500, maxValue: 8000, automationRate: "k-rate" }, // Hz
      { name: "mix", defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: "k-rate" },
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

    const syncIdx = Math.max(0, Math.min(5, Math.round(parameters.sync[0])));
    const bpm = Math.max(20, Math.min(300, parameters.bpm[0]));
    let targetMs = Math.max(30, Math.min(1000, parameters.time[0]));
    if (syncIdx !== 0) {
      targetMs = Math.max(30, Math.min(1000, STOCK_DELAY_DIVISIONS[syncIdx] * (60000 / bpm)));
    }
    const pingPong = parameters.pingPong[0] > 0.5;
    const feedback = Math.max(0, Math.min(0.9, parameters.feedback[0]));
    const toneHz = Math.max(500, Math.min(8000, parameters.tone[0]));
    const mix = Math.max(0, Math.min(1, parameters.mix[0]));

    const targetSamples = (targetMs / 1000) * sr;
    // Glide the delay time per sample (~20 ms toward target) — zipper-free
    // automation of TIME and click-free sync-division switches mid-phrase.

    // One-pole lowpass coefficient for the loop damping.
    const w = (2 * Math.PI * toneHz) / sr;
    const lpCoef = w / (1 + w);

    for (let i = 0; i < len; i++) {
      const step = 1 - Math.exp(-1 / (0.02 * sr));
      this.curDelayL += (targetSamples - this.curDelayL) * step;
      this.curDelayR += (targetSamples - this.curDelayR) * step;

      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      const tapL = this.readCubic(this.bufL, this.writeIdx - this.curDelayL);
      const tapR = this.readCubic(this.bufR, this.writeIdx - this.curDelayR);

      // Damped loop: the tap darkens every repeat (progressive tape feel).
      this.lpL += lpCoef * (tapL - this.lpL);
      this.lpR += lpCoef * (tapR - this.lpR);
      const fbL = pingPong ? this.lpR : this.lpL;
      const fbR = pingPong ? this.lpL : this.lpR;
      this.bufL[this.writeIdx] = l + fbL * feedback;
      this.bufR[this.writeIdx] = r + fbR * feedback;
      this.writeIdx++;
      if (this.writeIdx >= STOCK_DELAY_RING) this.writeIdx = 0;

      // Ping-pong reads the opposite tap so repeats bounce L/R.
      const wetL = pingPong ? tapR : tapL;
      const wetR = pingPong ? tapL : tapR;
      outL[i] = l * (1 - mix) + wetL * mix;
      if (outR) outR[i] = r * (1 - mix) + wetR * mix;
    }

    // Denormal guard
    if (Math.abs(this.lpL) < 1e-20) this.lpL = 0;
    if (Math.abs(this.lpR) < 1e-20) this.lpR = 0;
    if (Math.abs(this.bufL[this.writeIdx]) < 1e-20) this.bufL[this.writeIdx] = 0;
    if (Math.abs(this.bufR[this.writeIdx]) < 1e-20) this.bufR[this.writeIdx] = 0;

    return true;
  }

  readCubic(buf, position) {
    const idx = Math.floor(position);
    const frac = position - idx;
    const i0 = (((idx - 1) % STOCK_DELAY_RING) + STOCK_DELAY_RING) % STOCK_DELAY_RING;
    const i1 = (((idx + 0) % STOCK_DELAY_RING) + STOCK_DELAY_RING) % STOCK_DELAY_RING;
    const i2 = (((idx + 1) % STOCK_DELAY_RING) + STOCK_DELAY_RING) % STOCK_DELAY_RING;
    const i3 = (((idx + 2) % STOCK_DELAY_RING) + STOCK_DELAY_RING) % STOCK_DELAY_RING;
    const y0 = buf[i0];
    const y1 = buf[i1];
    const y2 = buf[i2];
    const y3 = buf[i3];
    const c0 = y1;
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * frac + c2) * frac + c1) * frac + c0;
  }
}

export function createStockDelayProcessor() {
  return new StockDelayProcessor();
}

registerProcessor("stock-delay-processor", StockDelayProcessor);
