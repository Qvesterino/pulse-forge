import { SpectralProcessor, DEFAULT_SPECTRAL_PARAMS } from "../src/effects/spectral-core/dsp/SpectralProcessor";
const SR = 48000;
const twoTone = (i: number) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.25 * Math.sin((2 * Math.PI * 660 * i) / SR);
const p = new SpectralProcessor();
p.prepare(SR);
p.setParams({ ...DEFAULT_SPECTRAL_PARAMS, mode: 0, feedback: 0, time: 100, mix: 1, diffuse: 0 } as never);
const total = Math.ceil(0.5 * SR);
const oL = new Float32Array(total);
const iL = new Float32Array(128), iR = new Float32Array(128), bL = new Float32Array(128), bR = new Float32Array(128);
for (let off = 0; off < total; off += 128) {
  const len = Math.min(128, total - off);
  for (let i = 0; i < len; i++) { iL[i] = twoTone(off + i); iR[i] = iL[i]; }
  p.process(iL, iR, bL, bR, len);
  oL.set(bL.subarray(0, len), off);
}
const rms = (a: number, b: number) => { let s = 0; const n = Math.max(1, Math.min(b, oL.length) - a); for (let i = a; i < a + n; i++) s += oL[i]*oL[i]; return Math.sqrt(s/n); };
for (const ms of [0, 20, 40, 60, 80, 100, 110, 117, 130, 150]) {
  const a = Math.floor((ms/1000)*SR);
  console.log(`t=${String(ms).padStart(4)}ms  rms=${rms(a, a + 4800).toFixed(5)}`);
}
