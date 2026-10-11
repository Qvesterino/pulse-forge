import { SpectralDelayBank } from "../src/effects/spectral-core/dsp/spectralDelay";
import { ResonatorBank } from "../src/effects/spectral-core/dsp/resonator";
import { StftEngine } from "../src/effects/spectral-core/dsp/stft";

const SR = 48000;
const N = 1024;

function probe(label: string, makeBank: (b: number) => (re: Float64Array, im: Float64Array, binCount: number) => void) {
  const engine = new StftEngine(SR, { fftSize: N });
  let wire: ((re: Float64Array, im: Float64Array, binCount: number) => void) | null = null;
  engine.onFrame((re, im, b) => wire?.(re, im, b));
  wire = makeBank(engine.binCount);
  const total = SR / 2;
  const out = new Float32Array(total);
  const inBlk = new Float32Array(128);
  const outBlk = new Float32Array(128);
  for (let off = 0; off < total; off += 128) {
    const len = Math.min(128, total - off);
    for (let i = 0; i < len; i++) inBlk[i] = 0.5 * Math.sin((2 * Math.PI * 440 * (off + i)) / SR);
    engine.processBlock(inBlk, len, outBlk);
    out.set(outBlk.subarray(0, len), off);
  }
  let peak = 0;
  let at = 0;
  for (let i = 0; i < total; i++) {
    const v = Math.abs(out[i]);
    if (v > peak) {
      peak = v;
      at = i;
    }
  }
  console.log(`${label.padEnd(22)} peak=${peak.toFixed(4)} at=${at} (t=${(at / SR).toFixed(4)}s)`);
  return peak;
}

const base = { timeSec: 0.2, feedback: 0.6, decay: 0.5, shiftSemitones: 0, diffuse: 0, freeze: 0, seed: 0 };

probe("delay fb=0", (b) => {
  const d = new SpectralDelayBank(b, SR, 256);
  return (re, im, bc) => d.process(re, im, bc, { ...base, feedback: 0 }, SR, 256);
});
probe("delay fb=0.6", (b) => {
  const d = new SpectralDelayBank(b, SR, 256);
  return (re, im, bc) => d.process(re, im, bc, base, SR, 256);
});
probe("delay fb=0.9", (b) => {
  const d = new SpectralDelayBank(b, SR, 256);
  return (re, im, bc) => d.process(re, im, bc, { ...base, feedback: 0.9 }, SR, 256);
});
probe("delay fb=0.6 shift=12", (b) => {
  const d = new SpectralDelayBank(b, SR, 256);
  return (re, im, bc) => d.process(re, im, bc, { ...base, shiftSemitones: 12 }, SR, 256);
});
probe("delay fb=0.6 decay=1", (b) => {
  const d = new SpectralDelayBank(b, SR, 256);
  return (re, im, bc) => d.process(re, im, bc, { ...base, decay: 1 }, SR, 256);
});
probe("resonator r=0.8", (b) => {
  const r = new ResonatorBank(b, SR);
  return (re, im, bc) => r.process(re, im, bc, { resonance: 0.8, focusHz: 660, focusWidthOct: 1 }, 1);
});
probe("resonator r=1", (b) => {
  const r = new ResonatorBank(b, SR);
  return (re, im, bc) => r.process(re, im, bc, { resonance: 1, focusHz: 660, focusWidthOct: 1 }, 1);
});
probe("pass-through", (re, im) => {
  void re;
  void im;
});
