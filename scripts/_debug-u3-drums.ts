import { renderGoldenTrack, goldenTracks } from "../tests/unsuno/golden-synth";
import { ReferenceFft } from "../src/reference/dsp/fft";
import { hannWindow } from "../src/reference/dsp/window";

const SR = 44100;
const FRAME = 2048;
const HOP = 128;
const fft = new ReferenceFft(FRAME);
const win = hannWindow(FRAME);
const bins = FRAME / 2;
const binHz = SR / FRAME;
const frameRate = SR / HOP;

function bandEnergy(signal: Float32Array, loHz: number, hiHz: number): Float32Array {
  const lo = Math.max(1, Math.round(loHz / binHz));
  const hi = Math.min(bins - 1, Math.round(hiHz / binHz));
  const frameCount = Math.floor((signal.length - FRAME) / HOP) + 1;
  const mag = new Float64Array(bins);
  const buf = new Float64Array(FRAME);
  const out = new Float32Array(frameCount);
  for (let t = 0; t < frameCount; t++) {
    const start = t * HOP;
    for (let i = 0; i < FRAME; i++) buf[i] = signal[start + i] * win[i];
    fft.magnitudeSpectrum(buf, mag);
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += mag[i] * mag[i];
    out[t] = Math.sqrt(sum);
  }
  return out;
}

const track = goldenTracks().find((t) => t.id === "house-126-am")!;
const pcm = renderGoldenTrack(track);
const stepSec = (60 / track.bpm) * (4 / 16);
const analyzedSamples = pcm.length;
const bars = Math.max(1, Math.floor(analyzedSamples / SR / (stepSec * 16)));
console.log(`bars=${bars} pcmSec=${(pcm.length / SR).toFixed(2)} stepSec=${stepSec.toFixed(4)} totalSteps=${bars * 16}`);
const total = bars * 16;
const out = bandEnergy(pcm, 40, 120);
const maxE = Math.max(...out);
console.log(`maxEnergy=${maxE.toFixed(1)}`);
const perStep: number[] = [];
for (let s = 0; s < total; s++) {
  const c = Math.round(s * stepSec * frameRate);
  let attack = 0;
  for (let i = Math.max(0, c); i <= Math.min(out.length - 1, c + Math.round(0.04 * frameRate)); i++) attack = Math.max(attack, out[i]);
  let sSum = 0;
  let sn = 0;
  for (let i = Math.max(0, c + Math.round(0.12 * frameRate)); i <= Math.min(out.length - 1, c + Math.round(0.24 * frameRate)); i++) {
    sSum += out[i];
    sn++;
  }
  const sustain = sn > 0 ? sSum / sn : 0;
  const perc = attack / Math.max(sustain, 1e-6);
  perStep.push(perc);
}
console.log("per-step percussiveness (all bars):");
for (let s = 0; s < total; s++) {
  const pass = perStep[s] >= 2.2 ? "K" : ".";
  const bar = Math.floor(s / 16);
  if (s % 16 === 0) console.log(` bar ${bar}:`);
  process.stdout.write(`  s${String(s % 16).padStart(2)}${pass} ${perStep[s].toFixed(2)}\n`);
}
const detected = perStep.map((p, s) => (p >= 2.2 ? s % 16 : -1)).filter((s) => s >= 0);
console.log("folded detected steps:", [...new Set(detected)].sort((a, b) => a - b).join(","));