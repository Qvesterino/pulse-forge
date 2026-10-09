/**
 * PRÚD AudioWorkletProcessor — two-band dynamic EQ.
 *
 * Each band is a peaking cut whose gain rides the band's own level: a
 * band-passed detector envelope (attack/release shaped) above the band
 * threshold closes the cut toward `amount` dB (≤ 0 — ducking only, never
 * boosting). The two band cuts run IN SERIES (band 2 filters band 1's
 * output; detectors watch the incoming signal of their own stage). Cut
 * biquad coefficients recompute only when the running cut gain drifts
 * (>0.05 dB) — cheap for two biquads per block.
 */
class PrudProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "freq1", minValue: 80, maxValue: 8000, defaultValue: 900 },
      { name: "thresh1", minValue: -60, maxValue: 0, defaultValue: -18 },
      { name: "amount1", minValue: -12, maxValue: 0, defaultValue: -6 },
      { name: "q1", minValue: 0.5, maxValue: 8, defaultValue: 2 },
      { name: "freq2", minValue: 80, maxValue: 12000, defaultValue: 3200 },
      { name: "thresh2", minValue: -60, maxValue: 0, defaultValue: -24 },
      { name: "amount2", minValue: -12, maxValue: 0, defaultValue: -6 },
      { name: "q2", minValue: 0.5, maxValue: 8, defaultValue: 2 },
      { name: "attack", minValue: 0.001, maxValue: 0.1, defaultValue: 0.02 },
      { name: "release", minValue: 0.01, maxValue: 1, defaultValue: 0.2 },
      { name: "output", minValue: -12, maxValue: 12, defaultValue: 0 },
    ];
  }

  constructor(options) {
    super();
    this.meteringEnabled = options?.processorOptions?.metering === true;
    this.meterFrames = 0;
    this.meterMaxGrDb = [0, 0];
    this.det = [
      { z1: 0, z2: 0, env: 0, grDb: 0 },
      { z1: 0, z2: 0, env: 0, grDb: 0 },
    ];
    this.cut = [
      [
        { x1: 0, x2: 0, y1: 0, y2: 0, b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, gainDb: 0 },
        { x1: 0, x2: 0, y1: 0, y2: 0, b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, gainDb: 0 },
      ],
      [
        { x1: 0, x2: 0, y1: 0, y2: 0, b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, gainDb: 0 },
        { x1: 0, x2: 0, y1: 0, y2: 0, b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, gainDb: 0 },
      ],
    ];
  }

  /** RBJ peaking coefficients at a given cut gain (dB). */
  static peakCoeffs(freq, q, gainDb, out) {
    const A = Math.pow(10, gainDb / 40);
    const w = (2 * Math.PI * freq) / sampleRate;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const den = 1 + alpha / A;
    out.b0 = (1 + alpha * A) / den;
    out.b1 = (-2 * cw) / den;
    out.b2 = (1 - alpha * A) / den;
    out.a1 = (-2 * cw) / den;
    out.a2 = (1 - alpha / A) / den;
    out.gainDb = gainDb;
  }

  /** RBJ band-pass (constant peak) coefficients for the detector. */
  static bandCoeffs(freq, q, out) {
    const w = (2 * Math.PI * freq) / sampleRate;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const den = 1 + alpha;
    out.b0 = alpha / den;
    out.b1 = 0;
    out.b2 = -alpha / den;
    out.a1 = (-2 * cw) / den;
    out.a2 = (1 - alpha) / den;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) {
      for (const ch of output) ch.fill(0);
      return true;
    }
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const sr = sampleRate;
    const outGain = Math.pow(10, clamp(parameters.output[0], -12, 12) / 20);
    const atkCoef = 1 - Math.exp(-1 / (sr * clamp(parameters.attack[0], 0.001, 0.1)));
    const relCoef = 1 - Math.exp(-1 / (sr * clamp(parameters.release[0], 0.01, 1)));
    const bands = [
      {
        freq: clamp(parameters.freq1[0], 80, 8000),
        thresh: clamp(parameters.thresh1[0], -60, 0),
        amount: clamp(parameters.amount1[0], -12, 0),
        q: clamp(parameters.q1[0], 0.5, 8),
      },
      {
        freq: clamp(parameters.freq2[0], 80, 12000),
        thresh: clamp(parameters.thresh2[0], -60, 0),
        amount: clamp(parameters.amount2[0], -12, 0),
        q: clamp(parameters.q2[0], 0.5, 8),
      },
    ];
    const detCoeffs = [{}, {}];
    for (let b = 0; b < 2; b++) PrudProcessor.bandCoeffs(bands[b].freq, bands[b].q, detCoeffs[b]);
    const quantumMaxGrDb = [0, 0];

    for (let ch = 0; ch < output.length; ch++) {
      const inData = input[Math.min(ch, input.length - 1)];
      const outData = output[ch];
      // Series chain: band 1 reads the input and writes the output channel;
      // band 2 reads what band 1 left there and writes back.
      for (let b = 0; b < 2; b++) {
        const src = b === 0 ? inData : outData;
        const det = this.det[b];
        const d = detCoeffs[b];
        const c = this.cut[ch][b];
        let z1 = det.z1;
        let z2 = det.z2;
        let env = det.env;
        let grDb = det.grDb;
        for (let i = 0; i < outData.length; i++) {
          const x = src[i];
          const bp = d.b0 * x + d.b2 * z2 - d.a1 * z1 - d.a2 * z2;
          z2 = z1;
          z1 = bp;
          const ax = Math.abs(bp);
          env += (ax - env) * (ax > env ? atkCoef : relCoef);
          const envDb = 20 * Math.log10(Math.max(env, 1e-6));
          const over = Math.max(0, envDb - bands[b].thresh);
          const target = Math.max(bands[b].amount, -over);
          grDb += (target - grDb) * 0.15;
          quantumMaxGrDb[b] = Math.max(quantumMaxGrDb[b], -grDb);
          if (Math.abs(grDb - c.gainDb) > 0.05) PrudProcessor.peakCoeffs(bands[b].freq, bands[b].q, grDb, c);
          const y = c.b0 * x + c.b1 * c.x1 + c.b2 * c.x2 - c.a1 * c.y1 - c.a2 * c.y2;
          c.x2 = c.x1;
          c.x1 = x;
          c.y2 = c.y1;
          c.y1 = y;
          outData[i] = y;
        }
        det.z1 = z1;
        det.z2 = z2;
        det.env = env;
        det.grDb = grDb;
      }
      for (let i = 0; i < outData.length; i++) outData[i] *= outGain;
    }
    if (this.meteringEnabled) {
      for (let b = 0; b < 2; b++) this.meterMaxGrDb[b] = Math.max(this.meterMaxGrDb[b], quantumMaxGrDb[b]);
      this.meterFrames += output[0]?.length ?? 0;
      if (this.meterFrames >= sr * 0.05) {
        this.port.postMessage({ type: "gainReductionBands", bandsDb: this.meterMaxGrDb });
        this.meterFrames = 0;
        this.meterMaxGrDb[0] = 0;
        this.meterMaxGrDb[1] = 0;
      }
    }
    return true;
  }
}

registerProcessor("prud-processor", PrudProcessor);
