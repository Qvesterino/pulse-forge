import { SpectralProcessor, DEFAULT_SPECTRAL_PARAMS } from "../src/effects/spectral-core/dsp/SpectralProcessor";
const SR = 48000;
const twoTone = (i: number) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.25 * Math.sin((2 * Math.PI * 660 * i) / SR);
function run(params: Record<string, number>, seconds: number) {
  const p = new SpectralProcessor();
  p.setParams({ ...DEFAULT_SPECTRAL_PARAMS, ...params } as never);
  p.prepare(SR);
  const total = Math.ceil(seconds * SR);
  const oL = new Float32Array(total), oR = new Float32Array(total);
  const iL = new Float32Array(128), iR = new Float32Array(128), bL = new Float32Array(128), bR = new Float32Array(128);
  for (let off = 0; off < total; off += 128) {
    const len = Math.min(128, total - off);
    for (let i = 0; i < len; i++) { iL[i] = twoTone(off + i); iR[i] = iL[i]; }
    p.process(iL, iR, bL, bR, len);
    oL.set(bL.subarray(0, len), off); oR.set(bR.subarray(0, len), off);
  }
  return { oL, p };
}
const q = (v: number) => Math.round(v * 1e6) / 1e6;
const peak = (a: Float32Array) => { let p = 0; for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i])); return p; };
const d = run({ mode: 0, time: 200, feedback: 0.6, decay: 0.5, diffuse: 0, mix: 1 }, 0.25);
console.log("DELAY_SAMPLES", JSON.stringify([0,1,2,10,100,1000,5000,9000,11000].map((i) => q(d.oL[i]))));
console.log("DELAY_PEAK", q(peak(d.oL)), "FRAMES", d.p.getMeters().frames, "LATENCY", d.p.latencySamples());
const r = run({ mode: 1, resonance: 0.8, focus: 660, focusWidth: 1, mix: 1 }, 0.25);
let s2 = 0; for (let i = 0; i < r.oL.length; i++) s2 += r.oL[i]*r.oL[i];
console.log("RESO_PEAK", q(peak(r.oL)), "RESO_RMS", q(Math.sqrt(s2 / r.oL.length)));
const f = run({ mode: 2, feedback: 0.5, time: 120, mix: 1 }, 0.4);
console.log("FREEZE_PEAK", q(peak(f.oL)));
const e = run({ mode: 0, feedback: 0, time: 100, mix: 1, diffuse: 0 }, 0.5);
const rms = (a: number, b: number) => { let s = 0; const n = Math.max(1, Math.min(b, e.oL.length) - a); for (let i = a; i < a + n; i++) s += e.oL[i]*e.oL[i]; return Math.sqrt(s/n); };
console.log("ECHO_early(0-60ms)", q(rms(0, Math.floor(0.06*SR))), "ECHO_late(140-180ms)", q(rms(Math.floor(0.14*SR), Math.floor(0.18*SR))));
