import { StftEngine } from "../src/effects/spectral-core/dsp/stft";

/**
 * Isolates the STFT round-trip: bypass the frame processor and check whether a
 * pure analysis → resynthesis → overlap-add cycle reconstructs its input.
 * If this is not flat, the fault is in stft.ts, not in the spectral banks.
 */
const SR = 48000;
const N = 1024;
const engine = new StftEngine(SR, { fftSize: N });
console.log("hop", engine.hop, "bins", engine.binCount, "latency", engine.latencySamples());

engine.onFrame((re, im) => {
  void re;
  void im;
});

const total = SR / 2;
const input = new Float32Array(total);
for (let i = 0; i < total; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);

const out = new Float32Array(total);
const inBlk = new Float32Array(128);
const outBlk = new Float32Array(128);
const B = 128;

for (let off = 0; off < total; off += B) {
  const len = Math.min(B, total - off);
  inBlk.set(input.subarray(off, off + len));
  engine.processBlock(inBlk, len, outBlk);
  out.set(outBlk.subarray(0, len), off);
}

let peak = 0;
let peakAt = 0;
for (let i = 0; i < total; i++) {
  const v = Math.abs(out[i]);
  if (v > peak) {
    peak = v;
    peakAt = i;
  }
}
console.log("input peak", 0.5);
console.log("output peak", peak, "at sample", peakAt, `(t=${(peakAt / SR).toFixed(4)}s)`);
console.log("first 8 out:", Array.from(out.subarray(0, 8)).map((v) => v.toFixed(6)).join(" "));
console.log("out around peak:", Array.from(out.subarray(Math.max(0, peakAt - 3), peakAt + 4)).map((v) => v.toFixed(4)).join(" "));
let tail = 0;
for (let i = SR * 0.3; i < total; i++) tail = Math.max(tail, Math.abs(out[i]));
console.log("tail peak after 0.3s:", tail);
