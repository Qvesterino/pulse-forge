/** Seam-window comparison for the drop transition: no FX vs old vs new recipe. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeWav, momentaryMaxLufs, welchSpectrum, bandEnergies } from "./lib.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const samplesDir = path.join(here, "..", "public", "samples");
const SR = 44100;

const cache = new Map();
const load = (id) => {
  if (!cache.has(id)) cache.set(id, decodeWav(readFileSync(path.join(samplesDir, `${id}.wav`))).channels[0]);
  return cache.get(id);
};

const BPM = 142;
const sixteenth = 60 / BPM / 4;
const bars = 4;
// a bar is SIXTEEN sixteenths (bars*4 only covers 2 bars — the seam window
// then falls past the buffer and momentaryMaxLufs loops on an empty window)
const total = Math.ceil(bars * 16 * sixteenth * SR + 1.5 * SR);

const beat = (s) => [
  ["factory.kick.drill", s, 1],
  ["factory.kick.drill", s + 7, 1],
  ["factory.kick.drill", s + 10, 1],
  ["factory.kick.808drive", s, 1],
  ["factory.kick.808drive", s + 10, 0.9],
  ["factory.snare.drill", s + 4, 1],
  ["factory.snare.drill", s + 12, 1],
  ...Array.from({ length: 16 }, (_, i) => ["factory.hat.drill", s + i * 2, 0.8]),
];

function render(fx) {
  const mix = new Float64Array(total);
  const events = [...beat(0), ...beat(16), ...beat(32), ...beat(48), ...fx];
  for (const [id, step, gain] of events) {
    const ch = load(id);
    const at = Math.floor(step * sixteenth * SR);
    for (let i = 0; i < ch.length && at + i < total; i++) mix[at + i] += ch[i] * gain;
  }
  return Float32Array.from(mix);
}

const a = Math.floor(32 * sixteenth * SR);
const b = Math.floor(48 * sixteenth * SR);
function stats(name, m) {
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(m[i]));
  const win = m.subarray(a, b);
  const lufs = momentaryMaxLufs([win], SR);
  const bc = bandEnergies(welchSpectrum(win, SR));
  const pct = (x) => Math.round(Math.pow(10, x / 10) * 1000) / 10;
  console.log(
    name.padEnd(26),
    "seamPeak",
    (20 * Math.log10(peak)).toFixed(1) + "dB  seamLUFS",
    lufs.toFixed(1),
    " sub",
    pct(bc.sub),
    "low",
    pct(bc.low),
  );
}

stats("seam: no FX (ref)", render([]));
stats("seam: impact+downlifter", render([["factory.fx.impact", 32, 1], ["factory.fx.downlifter", 32, 0.8]]));
stats("seam: impact+SUBDROP", render([["factory.fx.impact", 32, 1], ["factory.fx.subdrop", 32, 0.9]]));
