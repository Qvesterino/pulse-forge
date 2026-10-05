import { detectBassNotes, applyLowPass } from "../src/reference/analysis/bass";
import { trackPitch } from "../src/audio-workers/pitch-tracker";

const SR = 44100;
function bassPcm(notes: { startSec: number; durationSec: number; midi: number }[], seconds: number): Float32Array {
  const pcm = new Float32Array(Math.ceil(SR * seconds));
  for (const note of notes) {
    const start = Math.round(note.startSec * SR);
    const length = Math.round(note.durationSec * SR);
    const f0 = 440 * Math.pow(2, (note.midi - 69) / 12);
    for (let i = 0; i < length && start + i < pcm.length; i++) {
      pcm[start + i] += 0.4 * Math.sin((2 * Math.PI * f0 * i) / SR) + 0.16 * Math.sin((4 * Math.PI * f0 * i) / SR);
    }
  }
  return pcm;
}
const pcm = bassPcm([{ startSec: 0.0, durationSec: 0.8, midi: 30 }], 2);
const det = detectBassNotes(pcm, SR, { bpm: 140 });
console.log("notes", det?.notes.length, det?.notes.map((n) => `${n.startSec.toFixed(2)}+${n.durationSec.toFixed(2)}`).join(","));
// mask internals replicated
const iso = applyLowPass(pcm, SR, 300);
const small = new Float32Array(Math.floor(pcm.length / 8));
for (let i = 0; i < small.length; i++) small[i] = iso[i * 8];
const smallRate = SR / 8;
const frameSec = 0.01;
const frameCount = Math.max(1, Math.ceil(small.length / (smallRate * frameSec)));
const coeff = Math.exp((-2 * Math.PI * 120) / smallRate);
const energy = new Float64Array(frameCount);
let lp = 0;
for (let i = 0; i < small.length; i++) {
  lp = small[i] + coeff * (lp - small[i]);
  const frame = Math.min(frameCount - 1, Math.floor(i / (smallRate * frameSec)));
  energy[frame] += lp * lp;
}
let maxE = 0;
for (let f = 0; f < frameCount; f++) { energy[f] = Math.sqrt(energy[f] / (smallRate * frameSec)); if (energy[f] > maxE) maxE = energy[f]; }
const sorted = [...energy].sort((a, b) => a - b);
const med = sorted[Math.floor(frameCount / 2)] || 0;
console.log("maxE", maxE.toFixed(4), "med", med.toFixed(4), "threshold", (med * 1.6).toFixed(4));
const samples = [0, 10, 20, 30, 40, 50, 80, 120].map((f) => `f${f}:${energy[f]?.toFixed(4)}`).join(" ");
console.log(samples);

const frames = trackPitch(small, smallRate, { fminHz: 40, fmaxHz: 250, hopMs: 10 });
const voiced = frames.filter((f) => f.clarity >= 0.45 && f.midi > 0);
console.log("yin frames", frames.length, "voiced", voiced.length);
console.log(voiced.slice(0, 8).map((f) => `${f.timeSec.toFixed(2)} m${f.midi.toFixed(1)} c${f.clarity.toFixed(2)}`).join("  "));
console.log("midi range:", Math.min(...voiced.map((f) => f.midi)).toFixed(1), "-", Math.max(...voiced.map((f) => f.midi)).toFixed(1));
