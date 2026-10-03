/**
 * Absolute-level cross-check for the sample audit (scratch tooling).
 *
 * The shipped audit (scripts/audit-samples.mts) reports band shares RELATIVE
 * to each file's loudest band, which cannot answer "is this band audible?".
 * This tool decodes the same WAVs and reports ABSOLUTE dBFS per band on the
 * file's max-energy 8192-sample Hann window, so a "sub -36" share can be read
 * as an actual level.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, "public", "samples");
const SR = 44100;
const N = 8192;

const BANDS = [
  ["sub", 20, 60],
  ["low", 60, 120],
  ["lowmid", 120, 350],
  ["mid", 350, 2000],
  ["himid", 2000, 6000],
  ["high", 6000, 12000],
  ["air", 12000, 20000],
];

function decodeWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not RIFF/WAVE");
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("missing fmt/data");
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const chans = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < fmt.channels; c++) {
      const off = (f * fmt.channels + c) * bytes;
      let v = 0;
      if (fmt.format === 3) v = data.readFloatLE(off);
      else if (fmt.bits === 16) v = data.readInt16LE(off) / 32768;
      else if (fmt.bits === 24) v = ((data[off] | (data[off + 1] << 8) | (data[off + 2] << 16)) << 8) / 2147483648;
      else if (fmt.bits === 32) v = data.readInt32LE(off) / 2147483648;
      else if (fmt.bits === 8) v = (data[off] - 128) / 128;
      chans[c][f] = v;
    }
  }
  return { channels: chans, sampleRate: fmt.sampleRate, channelsCount: fmt.channels };
}

/* ── iterative radix-2 FFT ── */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Absolute dBFS of each band on the file's loudest 8192-sample Hann window. */
function measure(file) {
  const { channels } = decodeWav(readFileSync(path.join(DIR, file)));
  const x = channels[0];
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let bestSum = -1;
  let best = 0;
  for (let start = 0; start + N <= x.length; start += N / 4) {
    let s = 0;
    for (let i = 0; i < N; i++) s += x[start + i] * x[start + i];
    if (s > bestSum) {
      bestSum = s;
      best = start;
    }
  }
  for (let i = 0; i < N; i++) {
    re[i] = x[best + i] * win[i];
    im[i] = 0;
  }
  fft(re, im);
  // mean square of the band = sum|X|^2 / N^2  (Parseval); dBFS vs a full-scale sine (0.5)
  const bins = (lo, hi) => {
    let acc = 0;
    for (let k = Math.ceil((lo * N) / SR); k <= Math.floor((hi * N) / SR) && k < N / 2; k++) acc += re[k] * re[k] + im[k] * im[k];
    return acc / (N * N);
  };
  const out = {};
  for (const [name, lo, hi] of BANDS) out[name] = 10 * Math.log10(Math.max(bins(lo, hi), 1e-30) / 0.5);
  return out;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".wav"));
const rows = [];
for (const file of files) {
  try {
    rows.push({ file, ...measure(file) });
  } catch (err) {
    console.log(`!! ${file}: ${err.message}`);
  }
}
const id = (f) => f.replace(/\.wav$/, "");
const show = (label, key, sort) => {
  console.log(`\n=== ${label} ===`);
  for (const r of [...rows].sort((a, b) => sort(a, b)) .slice(0, 12))
    console.log(
      `  ${id(r.file).padEnd(30)} ${key} ${r[key].toFixed(1).padStart(7)} dBFS   (mid ${r.mid.toFixed(1)}, himid ${r.himid.toFixed(1)}, high ${r.high.toFixed(1)})`,
    );
};
console.log(`files: ${rows.length}`);
show("LOUDEST sub band (20-60 Hz, absolute)", "sub", (a, b) => b.sub - a.sub);
show("QUIETEST sub band", "sub", (a, b) => a.sub - b.sub);
show("DARKEST high band (6-12 kHz, absolute)", "high", (a, b) => a.high - b.high);
for (const target of ["factory.perc.cowbell", "factory.perc.cowbell.drill", "factory.kick.drill", "factory.kick.808drive", "factory.mallet.marimba", "factory.tonal.violin", "factory.tonal.organ"]) {
  const r = rows.find((row) => id(row.file) === target);
  if (r)
    console.log(
      `  -> ${target.padEnd(30)} ` + BANDS.map(([n]) => `${n} ${r[n].toFixed(1)}`).join("  "),
    );
}
