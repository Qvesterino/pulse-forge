import { SpectralProcessor, DEFAULT_SPECTRAL_PARAMS } from "../src/effects/spectral-core/dsp/SpectralProcessor";
const SR = 48000;
const twoTone = (i: number) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.25 * Math.sin((2 * Math.PI * 660 * i) / SR);
function run(params: Record<string, number>, seconds: number) {
  const p = new SpectralProcessor();
  p.prepare(SR);
  p.setParams({ ...DEFAULT_SPECTRAL_PARAMS, ...params } as never);
  const total = Math.ceil(seconds * SR);
  const oL = new Float32Array(total), oR = new Float32Array(total);
  const iL = new Float32Array(128), iR = new Float32Array(128), bL = new Float32Array(128), bR = new Float32Array(128);
  for (let off = 0; off < total; off += 128) {
    const len = Math.min(128, total - off);
    for (let i = 0; i < len; i++) { iL[i] = twoTone(off + i); iR[i] = iL[i]; }
    p.process(iL, iR, bL, bR, len);
    oL.set(bL.subarray(0, len), off); oR.set(bR.subarray(0, len), off);
  }
  return { oL, oR, p };
}
const q = (v: number) => Math.round(v * 1e6) / 1e6;
const d = run({ mode: 0, time: 200, feedback: 0.6, decay: 0.5, diffuse: 0, mix: 1 }, 0.25);
console.log("DELAY samples:", JSON.stringify([0,1,2,10,100,1000,5000,9000,11000].map((i) => q(d.oL[i]))));
let pk = 0; for (let i = 0; i < d.oL.length; i++) pk = Math.max(pk, Math.abs(d.oL[i]));
console.log("DELAY peak:", q(pk), "frames:", d.p.getMeters().frames, "latency:", d.p.latencySamples());
const r = run({ mode: 1, resonance: 0.8, focus: 660, focusWidth: 1, mix: 1 }, 0.25);
let pk2 = 0, sum = 0; for (let i = 0; i < r.oL.length; i++) { pk2 = Math.max(pk2, Math.abs(r.oL[i])); sum += r.oL[i]*r.oL[i]; }
console.log("RESO peak:", q(pk2), "rms:", q(Math.sqrt(sum / r.oL.length)));
const f = run({ mode: 2, feedback: 0.5, time: 120, mix: 1 }, 0.4);
let pk3 = 0; for (let i = 0; i < f.oL.length; i++) pk3 = Math.max(pk3, Math.abs(f.oL[i]));
console.log("FREEZE peak:", q(pk3));
