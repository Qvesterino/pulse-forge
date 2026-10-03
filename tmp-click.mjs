// Decisive test: is the mallet strike-noise path actually reaching the render?
// Filters each WAV with the SAME biquad the mallet() click uses (bandpass 2.4 kHz,
// Q 0.8), then prints the band's 1 ms RMS envelope from the first sample onward.
// A live strike decays in ~4 ms (a steep drop between 1 ms and 8 ms); a dead click
// follows the resonator body and barely moves.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

function decode(path) {
  const buf = readFileSync(path);
  let off = 12,
    fmt = null,
    data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === "fmt ") fmt = body;
    if (id === "data") data = body;
    off += 8 + size + (size % 2);
  }
  const ch = fmt.readUInt16LE(2),
    bits = fmt.readUInt16LE(14);
  const bytes = Math.max(1, bits / 8);
  const n = Math.floor(data.length / (ch * bytes));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) {
      const p = (i * ch + c) * bytes;
      s +=
        bits === 16
          ? data.readInt16LE(p) / 32768
          : bits === 24
            ? (data.readUInt8(p) | (data.readUInt8(p + 1) << 8) | (data.readInt8(p + 2) << 16)) / 8388608
            : data.readFloatLE(p);
    }
    out[i] = s / ch;
  }
  return { x: out, fs: fmt.readUInt32LE(4) };
}

function bandpass(fs, f0, q) {
  const w0 = (2 * Math.PI * f0) / fs,
    alpha = Math.sin(w0) / (2 * q),
    cw = Math.cos(w0);
  const a0 = 1 + alpha;
  return [alpha / a0, 0, -alpha / a0, (-2 * cw) / a0, (1 - alpha) / a0];
}

function filterBand(x, fs, f0, q) {
  const [b0, b1, b2, a1, a2] = bandpass(fs, f0, q);
  const y = new Float32Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xn = x[i];
    const yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = xn;
    y2 = y1;
    y1 = yn;
    y[i] = yn;
  }
  return y;
}

const db = (v) => (v <= 0 ? -Infinity : 20 * Math.log10(v));
const marks = [0, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64, 128, 256];

for (const path of process.argv.slice(2)) {
  const { x, fs } = decode(path);
  const y = filterBand(x, fs, 2400, 0.8);
  // 1 ms RMS windows, hop = the mark itself (short windows early, wider later)
  const row = marks.map((ms) => {
    const s = Math.floor((ms / 1000) * fs);
    const len = Math.max(2, Math.round(0.001 * fs));
    if (s + len > y.length) return null;
    let acc = 0;
    for (let i = s; i < s + len; i++) acc += y[i] * y[i];
    return db(Math.sqrt(acc / len));
  });
  const fmt = row.map((v) => (v === null ? "  n/a" : v.toFixed(1).padStart(6))).join(" ");
  console.log((path.split(/[\\/]/).pop() + "                    ").slice(0, 26) + fmt);
}
console.log(
  "mark(ms)" + marks.map((m) => (String(m) + "       ").slice(0, 7).padStart(7)).join(""),
);
