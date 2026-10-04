/**
 * Strike presence in the SHIPPED seeds (file-level, no browser).
 *
 * The audit's original criterion: filter the file at the mallet's contact
 * frequency and compare the 1 ms RMS of the first millisecond against the
 * loudest millisecond at 8-32 ms. A voice whose strike is real leads its own
 * band envelope; a voice whose "strike" never made it into the file does not.
 * Usage: node tmp-strike.mjs factory.mallet.vibes factory.mallet.marimba ...
 */
import { readFileSync } from "node:fs";

const SR = 44100;

function decode(file) {
  const buf = readFileSync(file);
  let pos = 12;
  let bits = 0;
  let ch = 0;
  let dataStart = -1;
  let dataBytes = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      ch = buf.readUInt16LE(pos + 10);
      bits = buf.readUInt16LE(pos + 22);
    } else if (id === "data") {
      dataStart = pos + 8;
      dataBytes = size;
      break;
    }
    pos += 8 + size + (size % 2);
  }
  const bytes = bits / 8;
  const frames = Math.floor(dataBytes / (bytes * ch));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = dataStart + f * bytes * ch;
    out[f] = ((buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)) << 8) / 2147483648;
  }
  return out;
}

/** RBJ band-pass at f0 with Q, applied twice (24 dB/oct skirt). */
function bandpass(x, f0, q) {
  const w0 = (2 * Math.PI * f0) / SR;
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = alpha;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha;
  const out = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    out[i] = v;
  }
  return out;
}

/** 1 ms RMS every 1 ms. */
function env(x, ms) {
  const out = [];
  for (let t = 0; t + 44 <= Math.round(ms * 0.001 * SR); t += 44) {
    let s = 0;
    for (let i = 0; i < 44; i++) s += x[t + i] * x[t + i];
    out.push(10 * Math.log10(Math.max(s / 44, 1e-30)));
  }
  return out;
}

const HOOKS = {
  "factory.mallet.vibes": [2600, 0.9],
  "factory.mallet.marimba": [2400, 0.8],
  "factory.mallet.celesta": [3400, 1.3],
  "factory.mallet.kalimba": [2100, 1],
  "factory.mallet.musicbox": [5200, 2.6],
};

for (const id of process.argv.slice(2)) {
  const [f0, q] = HOOKS[id] ?? [2400, 0.8];
  const file = decode(`public/samples/${id}.wav`);
  const old = (() => {
    try {
      return decode(`tmp-old-${id.split(".")[2]}.wav`);
    } catch {
      return null;
    }
  })();
  const band = bandpass(file, f0, q);
  const e = env(band, 40);
  const first = e[0];
  const body = Math.max(...e.slice(8, 32));
  let peakAt = 0;
  for (let i = 1; i < e.length; i++) if (e[i] > e[peakAt]) peakAt = i;
  let peak = 0;
  let peakIdx = 0;
  for (let i = 0; i < file.length; i++)
    if (Math.abs(file[i]) > peak) {
      peak = Math.abs(file[i]);
      peakIdx = i;
    }
  console.log(`\n=== ${id} (contact band ${f0} Hz Q ${q}) ===`);
  console.log(
    `  file peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS @ ${((peakIdx / SR) * 1000).toFixed(2)} ms` +
      ` | in-band 1st ms ${first.toFixed(1)} dB, body 8-32 ms ${body.toFixed(1)} dB, lead ${(first - body).toFixed(1)} dB` +
      `, band env peak @ ${peakAt} ms`,
  );
  console.log(`  in-band 1 ms env first 24 ms: ${e.slice(0, 24).map((v) => v.toFixed(1)).join(" ")}`);
  if (old) {
    const ob = bandpass(old, f0, q);
    const oe = env(ob, 40);
    const obody = Math.max(...oe.slice(8, 32));
    let opeak = 0;
    let opeakIdx = 0;
    for (let i = 0; i < old.length; i++)
      if (Math.abs(old[i]) > opeak) {
        opeak = Math.abs(old[i]);
        opeakIdx = i;
      }
    console.log(
      `  OLD file peak ${(20 * Math.log10(opeak)).toFixed(1)} dBFS @ ${((opeakIdx / SR) * 1000).toFixed(2)} ms` +
        ` | in-band 1st ms ${oe[0].toFixed(1)} dB, body ${obody.toFixed(1)} dB, lead ${(oe[0] - obody).toFixed(1)} dB`,
    );
    console.log(`  OLD in-band env first 24 ms:    ${oe.slice(0, 24).map((v) => v.toFixed(1)).join(" ")}`);
  }
}
