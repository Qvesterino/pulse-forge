import { separateHPSS } from "../src/analysis/hpss";

const SR = 44100;
// pure 440 Hz sine → harmonic stem should carry it, percussive ~0
const sine = new Float32Array(SR * 4);
for (let i = 0; i < sine.length; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
const stems = separateHPSS(sine, SR)!;
const rms = (d: Float32Array) => { let s = 0; for (let i = 1000; i < d.length - 1000; i++) s += d[i] * d[i]; return Math.sqrt(s / (d.length - 2000)); };
console.log("440Hz: harm", rms(stems.harmonic).toFixed(4), "perc", rms(stems.percussive).toFixed(4));

// kick train (0.5 s period, sharp decay) → percussive should carry it
const kick = new Float32Array(SR * 4);
for (let k = 0; k < 8; k++) {
  const start = Math.round(k * 0.5 * SR);
  for (let i = 0; i < SR * 0.15 && start + i < kick.length; i++) {
    const t = i / SR;
    kick[start + i] = 0.8 * Math.exp(-t / 0.03) * Math.sin((2 * Math.PI * (110 - 300 * t * 5) * t));
  }
}
const kstems = separateHPSS(kick, SR)!;
console.log("kick: harm", rms(kstems.harmonic).toFixed(4), "perc", rms(kstems.percussive).toFixed(4));

// reconstruction: perc+harm sample-wise vs input
const recon = new Float32Array(sine.length);
for (let i = 0; i < recon.length; i++) recon[i] = stems.percussive[i] + stems.harmonic[i];
let maxDiff = 0;
for (let i = 1000; i < recon.length - 1000; i += 997) maxDiff = Math.max(maxDiff, Math.abs(recon[i] - sine[i]));
console.log("recon max sample diff (440Hz):", maxDiff.toFixed(5));
