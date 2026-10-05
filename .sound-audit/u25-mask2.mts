import { applyLowPass } from "../src/reference/analysis/bass";
import { trackPitch, type PitchFrame } from "../src/audio-workers/pitch-tracker";

const SR = 44100;
const pcm = new Float32Array(Math.ceil(SR * 2));
const f0 = 440 * Math.pow(2, (30 - 69) / 12);
const len = Math.round(0.8 * SR);
for (let i = 0; i < len; i++) pcm[i] += 0.4 * Math.sin((2 * Math.PI * f0 * i) / SR) + 0.16 * Math.sin((4 * Math.PI * f0 * i) / SR);
const iso = applyLowPass(pcm, SR, 300);
const small = new Float32Array(Math.floor(pcm.length / 8));
for (let i = 0; i < small.length; i++) small[i] = iso[i * 8];
const smallRate = SR / 8;
const frameSec = 0.01;
const frames = trackPitch(small, smallRate, { fminHz: 40, fmaxHz: 250, hopMs: 10 });
console.log("yin frames", frames.length, "first", frames[0]?.timeSec, "last", frames[frames.length-1]?.timeSec);
// exact mask replica
const frameCount = Math.max(1, Math.ceil(small.length / (smallRate * frameSec)));
const coeff = Math.exp((-2 * Math.PI * 120) / smallRate);
const energy = new Float64Array(frameCount);
let lp = 0;
for (let i = 0; i < small.length; i++) {
  lp = small[i] + coeff * (lp - small[i]);
  energy[Math.min(frameCount - 1, Math.floor(i / (smallRate * frameSec)))] += lp * lp;
}
for (let f = 0; f < frameCount; f++) energy[f] = Math.sqrt(energy[f] / (smallRate * frameSec));
const sorted = [...energy].sort((a, b) => a - b);
const med = sorted[Math.floor(frameCount / 2)] || 0;
const mask = new Uint8Array(frameCount);
let release = -1;
for (let f = 0; f < frameCount; f++) {
  const value = energy[f];
  const onset = value > med * 1.6 && (f === 0 || value > energy[f - 1] * 1.3) && release < f;
  if (onset) {
    const threshold = value * 0.3;
    let end = f + 1;
    while (end < frameCount && energy[end] > threshold && end - f < Math.round(0.25 / frameSec)) end++;
    release = end;
  }
  if (release > f) mask[f] = 1;
}
console.log("mask frames set:", [...mask].reduce((s, v) => s + v, 0), "of", frameCount);
// run loop replica
const runs: PitchFrame[][] = [];
let current: PitchFrame[] = [];
for (const frame of frames) {
  const slot = Math.round(frame.timeSec / frameSec);
  const maskedHere = mask[slot] === 1;
  if (frame.clarity < 0.45 || frame.midi <= 0 || maskedHere) { if (current.length) { runs.push(current); current = []; } continue; }
  if (current.length > 0) {
    const anchor = [...current.map((f) => f.midi)].sort((a, b) => a - b)[Math.floor(current.length / 2)];
    if (Math.abs(frame.midi - anchor) > 1) { if (current.length) { runs.push(current); current = []; } }
  }
  current.push(frame);
}
if (current.length) runs.push(current);
console.log("runs:", runs.map((r) => `${r[0].timeSec.toFixed(2)}x${r.length}`).join(", "));
