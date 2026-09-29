/** Beat-context audit: place factory samples into genre grooves, sum, measure. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeWav, momentaryMaxLufs, welchSpectrum, bandEnergies } from "./lib.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const samplesDir = path.join(here, "..", "public", "samples");
const SR = 44100;

const load = (id) => {
  const wav = decodeWav(readFileSync(path.join(samplesDir, `${id}.wav`)));
  return wav.channels; // [ch][] mono/dual-mono
};

const BPM = 140;
const SIXTEENTH = 60 / BPM / 4;

/** events: [id, sixteenthIndex, gain] */
function renderBeat(events, bars = 2) {
  const total = Math.ceil(bars * 4 * SIXTEENTH * SR + 1.5 * SR);
  const mix = new Float64Array(total);
  let maxSrcLen = 0;
  for (const [id, step, gain] of events) {
    const ch = load(id)[0];
    maxSrcLen = Math.max(maxSrcLen, ch.length);
    const at = Math.floor(step * SIXTEENTH * SR);
    for (let i = 0; i < ch.length && at + i < total; i++) mix[at + i] += ch[i] * gain;
  }
  return { mix: Float32Array.from(mix), len: Math.ceil(bars * 4 * SIXTEENTH * SR) + maxSrcLen };
}

function measure(name, events) {
  const { mix } = renderBeat(events);
  let peak = 0;
  for (const v of mix) peak = Math.max(peak, Math.abs(v));
  const lufs = momentaryMaxLufs([mix], SR);
  let sumSq = 0;
  for (const v of mix) sumSq += v * v;
  const rms = Math.sqrt(sumSq / mix.length);
  const spec = welchSpectrum(mix, SR);
  const b = bandEnergies(spec);
  const pct = (x) => Math.round(Math.pow(10, x / 10) * 1000) / 10;
  console.log(
    `${name.padEnd(18)} peak ${peak.toFixed(2).padStart(5)} (${(20 * Math.log10(peak)).toFixed(1)}dB)  RMS ${(20 * Math.log10(rms)).toFixed(1)}dB  crest ${(20 * Math.log10(peak / rms)).toFixed(1)}dB  momLUFS ${lufs.toFixed(1)}`,
  );
  console.log(
    `                   band share %: sub ${pct(b.sub)} low ${pct(b.low)} lowmid ${pct(b.lowmid)} mid ${pct(b.mid)} himid ${pct(b.himid)} high ${pct(b.high)} air ${pct(b.air)}`,
  );
}

const T = 16; // steps per bar
// Trap: kick 1 & 3a, 808 following, snare 5/13, hats 8ths w/ 16th ghost, clap w snare
measure("trap", [
  ["factory.kick.trap", 0, 1], ["factory.kick.trap", 10, 1],
  ["factory.kick.808pure", 0, 1], ["factory.kick.808pure", 10, 0.9],
  ["factory.snare.trap", 4, 1], ["factory.snare.trap", 12, 1],
  ["factory.clap.main", 4, 0.7], ["factory.clap.main", 12, 0.7],
  ...Array.from({ length: 32 }, (_, i) => ["factory.hat.closed", i * 2, i % 4 === 2 ? 1 : 0.75]),
  ["factory.hat.open", 14, 0.7],
]);
// Drill: sliding 808 + drill kick/snare + tight hats + cowbell
measure("drill", [
  ["factory.kick.drill", 0, 1], ["factory.kick.drill", 7, 1], ["factory.kick.drill", 10, 1],
  ["factory.kick.808drive", 0, 1], ["factory.kick.808drive", 10, 0.9],
  ["factory.snare.drill", 4, 1], ["factory.snare.drill", 12, 1],
  ...Array.from({ length: 32 }, (_, i) => ["factory.hat.drill", i * 2, 0.8]),
  ["factory.perc.cowbell.drill", 6, 0.8], ["factory.perc.cowbell.drill", 14, 0.7],
]);
// House: 4-on-floor deep kick, claps 2/4, open hat offbeat, shaker
measure("house", [
  ...Array.from({ length: 8 }, (_, i) => ["factory.kick.deep", i * 4, 1]),
  ...Array.from({ length: 8 }, (_, i) => ["factory.clap.main", i * 4 + 2, 0.9]),
  ...Array.from({ length: 8 }, (_, i) => ["factory.hat.open", i * 4 + 2, 0.6]),
  ...Array.from({ length: 32 }, (_, i) => ["factory.perc.shaker.pop", i, i % 2 ? 0.5 : 0.8]),
]);
// DnB: split kick/snare, dnb hats + ride
measure("dnb", [
  ["factory.kick.dnb", 0, 1], ["factory.kick.dnb", 10, 1],
  ["factory.snare.dnb", 4, 1], ["factory.snare.dnb", 12, 1],
  ...Array.from({ length: 32 }, (_, i) => ["factory.hat.dnb", i * 2, i % 4 === 0 ? 1 : 0.6]),
  ["factory.ride.ping", 8, 0.6], ["factory.ride.ping", 24, 0.6],
  ["factory.crash.main", 0, 0.7],
]);
