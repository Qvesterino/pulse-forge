import { SpectralDelayBank } from "../src/effects/spectral-core/dsp/spectralDelay";
import { StftEngine } from "../src/effects/spectral-core/dsp/stft";
const SR = 48000;
for (const st of [0, 12]) {
  const engine = new StftEngine(SR, { fftSize: 1024 });
  const bank = new SpectralDelayBank(engine.binCount, SR, 256);
  engine.onFrame((re, im, b) =>
    bank.process(re, im, b, { timeSec: 0.2, feedback: 0.6, decay: 0.5, shiftSemitones: st, diffuse: 0, freeze: 0, seed: 0 }, SR, 256),
  );
  const total = SR / 2;
  const out = new Float32Array(total);
  const ib = new Float32Array(128);
  const ob = new Float32Array(128);
  for (let off = 0; off < total; off += 128) {
    const len = Math.min(128, total - off);
    for (let i = 0; i < len; i++) ib[i] = 0.5 * Math.sin((2 * Math.PI * 440 * (off + i)) / SR);
    engine.processBlock(ib, len, ob);
    out.set(ob.subarray(0, len), off);
  }
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(out[i]));
  console.log(`shift=${String(st).padStart(3)}  outPeak=${peak.toFixed(3)}  normPeak=${engine.normStats.normPeak.toFixed(3)}  normZero=${engine.normStats.normZero}`);
}
