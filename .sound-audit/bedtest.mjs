/** Lo-fi/phonk beat with the vinyl bed underneath (realistic lane gains). */
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

const BPM = 88;
const sixteenth = 60 / BPM / 4;
const bars = 4;
const total = Math.ceil(bars * 16 * sixteenth * SR + 1.5 * SR);

function render(events) {
  const mix = new Float64Array(total);
  for (const [id, sec, gain, loop] of events) {
    const ch = load(id);
    const at = Math.floor(sec * SR);
    if (loop) {
      // tile the texture across the whole render (a bed lane)
      for (let p = 0; p + at < total; p += ch.length) {
        for (let i = 0; i < ch.length && at + p + i < total; i++) mix[at + p + i] += ch[i] * gain;
      }
    } else {
      for (let i = 0; i < ch.length && at + i < total; i++) mix[at + i] += ch[i] * gain;
    }
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
    name.padEnd(28),
    "peak",
    (20 * Math.log10(peak)).toFixed(1) + "dB  momLUFS",
    lufs.toFixed(1),
    " sub",
    pct(b.sub),
    "mid",
    pct(b.mid),
    "himid",
    pct(b.himid),
    "high",
    pct(b.high),
  );
}

const beat = (s) => [
  ["factory.kick.knock", s, 1],
  ["factory.kick.knock", s + 10, 0.9],
  ["factory.snare.room", s + 4, 1],
  ["factory.snare.room", s + 12, 1],
  ["factory.snare.tight", s + 7, 0.3],
  ...Array.from({ length: 8 }, (_, i) => ["factory.hat.closed.soft", s + i * 2, i % 2 ? 0.5 : 0.8]),
];
const beatEvents = [...beat(0), ...beat(16), ...beat(32), ...beat(48)];

stats("lofi beat only @88", render(beatEvents));
stats("+ vinyl bed @0.5 gain", render([...beatEvents, ["factory.fx.vinyl", 0, 0.5, true]]));
stats("+ vinyl bed @1.0 gain", render([...beatEvents, ["factory.fx.vinyl", 0, 1.0, true]]));
