/** Pop groove crash accent: re-voiced crash.pop vs crash.main reference. */
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

function render(crashId) {
  const mix = new Float64Array(total);
  const events = [
    // pop groove: 4 bars, kick 1&3, clap 2&4, rim 8ths, shaker 16ths, crash on bar 1
    ...[0, 16, 32, 48].flatMap((s) => [
      ["factory.kick.pop", s, 1],
      ["factory.kick.pop", s + 10, 0.9],
      ["factory.clap.pop", s + 4, 1],
      ["factory.clap.pop", s + 12, 1],
      ...Array.from({ length: 8 }, (_, i) => ["factory.rim.pop", s + i * 2, i % 2 ? 0.4 : 0.7]),
      ...Array.from({ length: 16 }, (_, i) => ["factory.perc.shaker.pop", s + i, i % 4 === 0 ? 0.6 : 0.35]),
    ]),
    ["factory.tonal.pluck", 0, 0.8],
    ["factory.tonal.pluck", 32, 0.8],
    ...(crashId ? [[crashId, 0, 0.9]] : []),
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
    name.padEnd(24),
    "peak",
    (20 * Math.log10(peak)).toFixed(1) + "dB  momLUFS",
    lufs.toFixed(1),
    "  high",
    pct(b.high),
    "air",
    pct(b.air),
    "mid",
    pct(b.mid),
    "sub",
    pct(b.sub),
  );
}

stats("pop beat only", render(null));
stats("accent: crash.main", render("factory.crash.main"));
stats("accent: crash.pop NEW", render("factory.crash.pop"));
