/**
 * ŠÍRKA AudioWorkletProcessor — per-band stereo imager.
 *
 * Three-band split via two cascaded first-order complementary pairs
 * (low = LP1, rest = x − low; mid = LP2(rest), high = rest − mid) — each
 * split pair reconstructs the input exactly, so width 1 everywhere is a
 * mathematically neutral pass-through (pinned in tests). Per band the
 * mid/side balance is rescaled: L' = M + w·S, R' = M − w·S, with w = 0
 * collapsing the band to mono. `mix` crossfades the processed field.
 */
class SirkaProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "lowFreq", minValue: 60, maxValue: 500, defaultValue: 120 },
      { name: "highFreq", minValue: 2000, maxValue: 12000, defaultValue: 5000 },
      { name: "lowWidth", minValue: 0, maxValue: 2, defaultValue: 1 },
      { name: "midWidth", minValue: 0, maxValue: 2, defaultValue: 1 },
      { name: "highWidth", minValue: 0, maxValue: 2, defaultValue: 1 },
      { name: "mix", minValue: 0, maxValue: 1, defaultValue: 1 },
    ];
  }

  constructor() {
    super();
    this.lowL = 0;
    this.lowR = 0;
    this.midL = 0;
    this.midR = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) {
      for (const ch of output) ch.fill(0);
      return true;
    }
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const f1 = clamp(parameters.lowFreq[0], 60, 500);
    const f2 = clamp(parameters.highFreq[0], 2000, 12000);
    const wL = clamp(parameters.lowWidth[0], 0, 2);
    const wM = clamp(parameters.midWidth[0], 0, 2);
    const wH = clamp(parameters.highWidth[0], 0, 2);
    const mix = clamp(parameters.mix[0], 0, 1);
    const a1 = 1 - Math.exp((-2 * Math.PI * f1) / sampleRate);
    const a2 = 1 - Math.exp((-2 * Math.PI * f2) / sampleRate);
    const lIn = input[0];
    const rIn = input[Math.min(1, input.length - 1)];
    const lOut = output[0];
    const rOut = output[Math.min(1, output.length - 1)];
    let lowL = this.lowL;
    let lowR = this.lowR;
    let midL = this.midL;
    let midR = this.midR;

    for (let i = 0; i < lOut.length; i++) {
      const l = lIn[i];
      const r = rIn[i];
      // Split 1: low vs rest (complementary — perfect reconstruction).
      lowL += a1 * (l - lowL);
      lowR += a1 * (r - lowR);
      const restL = l - lowL;
      const restR = r - lowR;
      // Split 2: mid vs high (complementary on the rest).
      midL += a2 * (restL - midL);
      midR += a2 * (restR - midR);
      const highL = restL - midL;
      const highR = restR - midR;

      const band = (lBand, rBand, w) => {
        const m = (lBand + rBand) / 2;
        const s = (lBand - rBand) / 2;
        return [m + w * s, m - w * s];
      };
      const lo = band(lowL, lowR, wL);
      const mi = band(midL, midR, wM);
      const hi = band(highL, highR, wH);
      const nl = lo[0] + mi[0] + hi[0];
      const nr = lo[1] + mi[1] + hi[1];
      lOut[i] = l * (1 - mix) + nl * mix;
      rOut[i] = r * (1 - mix) + nr * mix;
    }
    this.lowL = lowL;
    this.lowR = lowR;
    this.midL = midL;
    this.midR = midR;
    return true;
  }
}

registerProcessor("sirka-processor", SirkaProcessor);
