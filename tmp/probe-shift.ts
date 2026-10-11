import { SpectralDelayBank } from "../src/effects/spectral-core/dsp/spectralDelay";
import { StftEngine } from "../src/effects/spectral-core/dsp/stft";

const SR = 48000;
const N = 1024;
const engine = new StftEngine(SR, { fftSize: N });
const bank = new SpectralDelayBank(engine.binCount, SR, 256);
console.log("ring frames:", bank.ringFrames, "bins:", engine.binCount, "hop:", engine.hop);

// Reproduce the exact failing config, but log the ring energy per frame.
const params = { timeSec: 0.2, feedback: 0.6, decay: 0.5, shiftSemitones: 12, diffuse: 0, freeze: 0, seed: 0 };
let frameNo = 0;
let maxOutRe = 0;

engine.onFrame((re, im, b) => {
  bank.process(re, im, b, params, SR, 256);
  frameNo++;
  for (let k = 0; k < b; k++) {
    const v = Math.abs(re[k]) + Math.abs(im[k]);
    if (v > maxOutRe) maxOutRe = v;
  }
  if (frameNo <= 8 || frameNo % 20 === 0) {
    console.log(
      `frame ${String(frameNo).padStart(4)} delayFrames=${bank.delayFramesActive} maxBinOut=${maxOutRe.toFixed(2)}`,
    );
  }
});

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
console.log("output peak", peak.toFixed(3), "at", at, "= frame", (at / 256).toFixed(1));
