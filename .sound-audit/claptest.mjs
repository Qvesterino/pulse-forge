/** Pop groove clap backbeat: re-voiced clap.pop vs clap.main reference. */
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
const BPM = 110;
const sixteenth = 60 / BPM / 4;
const total = Math.ceil(4 * 16 * sixteenth * SR + 1.5 * SR);

function render(clapId) {
  const mix = new Float64Array(total);
  const events = [
    ...[0, 16, 32, 48].flatMap((s) => [
      ["factory.kick.pop", s, 1],
      ["factory.kick.pop", s + 10, 0.9],
      [clapId, s + 4, 1],
      [clapId, s + 12, 1],
      ...Array.from({ length: 8 }, (_, i) => ["factory.hat.closed", s + i * 2, i % 2 ? 0.5 : 0.75]),
      ...Array.from({ length: 16 }, (_, i) => ["factory.perc.shaker.pop", s + i, i % 4 === 0 ? 0.55 : 0.3]),
    ]),
    ["factory.tonal.pluck", 0, 0.7],
    ["factory.tonal.pluck", 32, 0.7],
  ];
  for (const [id, step, gain] of events) {
    const ch = load(id);
    const at = Math.floor(step * sixteenth * SR);
    for (let i = 0; i < ch.length && at + i < total; i++) mix[at + i] += ch[i] * gain;
  }
  return Float32Array.from(mix);
}

function stats(name, m) {
  let peak = 0;
  for (const v of m) peak = Math.max(peak, Math.abs(v));
  const lufs = momentaryMaxLufs([m], SR);
  const b = bandEnergies(welchSpectrum(m, SR));
  const pct = (x) => Math.round(Math.pow(10, x / 10) * 1000) / 10;
  console.log(
    name.padEnd(22),
    "peak",
    (20 * Math.log10(peak)).toFixed(1) + "dB  momLUFS",
    lufs.toFixed(1),
    "  mid",
    pct(b.mid),
    "himid",
    pct(b.himid),
    "high",
    pct(b.high),
    "sub",
    pct(b.sub),
  );
}

stats("backbeat: clap.main", render("factory.clap.main"));
stats("backbeat: clap.pop NEW", render("factory.clap.pop"));
