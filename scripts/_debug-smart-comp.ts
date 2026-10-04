import { measureTake, scoreTake } from "../src/audio-engine/take-scoring";

const SAMPLE_RATE = 48_000;

function transient(data: Float32Array, timeSec: number, sampleRate: number, amplitude = 0.8): void {
  const start = Math.round(timeSec * sampleRate);
  const decay = Math.round(0.05 * sampleRate);
  let seed = 12345 + start;
  for (let i = 0; i < decay && start + i < data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = (seed / 0xffffffff) * 2 - 1;
    data[start + i] += amplitude * Math.exp(-i / (decay / 4)) * noise;
  }
}

// Noisy take: fan bed at -45 dBFS
const noisy = new Float32Array(2 * SAMPLE_RATE);
for (let i = 0; i < 32; i++) transient(noisy, i * 0.125, SAMPLE_RATE);
for (let i = 0; i < noisy.length; i++) noisy[i] += 0.0056 * Math.sin(i * 0.01);
const mn = measureTake(noisy, SAMPLE_RATE, 120);
console.log("noisy:", JSON.stringify(mn));
console.log("noisy score:", scoreTake(mn).score);
console.log("noisy evidence:", scoreTake(mn).evidence);

// What RMS does the fan have in a 0.5s frame?
const frame = Math.round(0.5 * SAMPLE_RATE);
let sum = 0;
for (let i = 0; i < frame; i++) sum += noisy[i] * noisy[i];
console.log("fan frame RMS:", Math.sqrt(sum / frame), "=", (20 * Math.log10(Math.sqrt(sum / frame))).toFixed(1), "dBFS");
console.log("VOICED_RMS_MIN would be", 0.01, "=", (20 * Math.log10(0.01)).toFixed(1), "dBFS");