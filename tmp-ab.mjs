/**
 * Before/after A/B for the three re-voiced curated seeds (scratch tooling).
 *
 * Same measurement contract as tmp-bands.mjs (absolute dBFS per band on the
 * file's max-energy 8192-sample Hann window, Parseval band mean-square) plus
 * whole-file peak/RMS/crest and the -40 dB "loud region" length, so a re-voice
 * can be judged against the committed baseline instead of against memory.
 */
import { readFileSync } from "node:fs";

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
    if (id === "fmt ")
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        bits: buf.readUInt16LE(body + 14),
      };
    else if (id === "data") data = buf.subarray(body, body + size);
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("missing fmt/data");
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = f * fmt.channels * bytes;
    let v = 0;
    if (fmt.format === 3) v = data.readFloatLE(off);
    else if (fmt.bits === 16) v = data.readInt16LE(off) / 32768;
    else if (fmt.bits === 24) v = ((data[off] | (data[off + 1] << 8) | (data[off + 2] << 16)) << 8) / 2147483648;
    out[f] = v;
  }
  return out;
}

// --- forward FFT (radix-2, in place) -------------------------------------
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

const win = new Float32Array(N);
let winSumSq = 0;
for (let i = 0; i < N; i++) {
  win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  winSumSq += win[i] * win[i];
}

/** Max-energy 8192-sample window, then Parseval band mean-square per band. */
function bands(x) {
  const energy = new Float64Array(Math.max(0, x.length - N + 1));
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i] * x[i];
    if (i >= N) acc -= x[i - N] * x[i - N];
    if (i >= N - 1) energy[i - N + 1] = acc;
  }
  let best = 0;
  for (let i = 1; i < energy.length; i++) if (energy[i] > energy[best]) best = i;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (x[best + i] ?? 0) * win[i];
  fft(re, im);
  const out = {};
  for (const [name, lo, hi] of BANDS) {
    let sum = 0;
    for (let k = Math.max(1, Math.ceil((lo * N) / SR)); k <= Math.floor((hi * N) / SR) && k < N / 2; k++) {
      sum += re[k] * re[k] + im[k] * im[k];
    }
    // Parseval: sum_n (x w)^2 = (1/N) sum_k |X[k]|^2, doubled for the
    // single-sided spectrum, divided by the window's mean-square gain.
    const ms = (2 * sum) / (N * winSumSq);
    out[name] = 10 * Math.log10(Math.max(ms, 1e-30));
  }
  out.startSample = best;
  return out;
}

function stats(x) {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    sum += x[i] * x[i];
  }
  const rms = Math.sqrt(sum / x.length);
  let loud = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > peak * 0.01) loud++;
  return {
    ms: (x.length / SR) * 1000,
    peakDb: 20 * Math.log10(peak),
    rmsDb: 20 * Math.log10(rms),
    crestDb: 20 * Math.log10(peak / rms),
    loudMs: (loud / SR) * 1000,
  };
}

/**
 * Short-window (23 ms) band table at the loudest point in the first 100 ms.
 * The 186 ms analysis window the shipped audit uses is right for sustained
 * content but dilutes a 3 ms mallet strike by ~18 dB, so this is the only way
 * to judge whether a strike actually has energy in its band.
 */
const N2 = 1024;
const win2 = new Float32Array(N2);
let win2SumSq = 0;
for (let i = 0; i < N2; i++) {
  win2[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N2);
  win2SumSq += win2[i] * win2[i];
}

function attackBands(x) {
  const limit = Math.max(0, Math.min(x.length - N2, Math.round(0.1 * SR)));
  let best = 0;
  let bestE = -1;
  for (let i = 0; i <= limit; i++) {
    let e = 0;
    for (let k = 0; k < N2; k++) e += x[i + k] * x[i + k];
    if (e > bestE) {
      bestE = e;
      best = i;
    }
  }
  const re = new Float64Array(N2);
  const im = new Float64Array(N2);
  for (let i = 0; i < N2; i++) re[i] = (x[best + i] ?? 0) * win2[i];
  fft(re, im);
  const out = { startMs: (best / SR) * 1000 };
  for (const [name, lo, hi] of BANDS) {
    let sum = 0;
    for (let k = Math.max(1, Math.ceil((lo * N2) / SR)); k <= Math.floor((hi * N2) / SR) && k < N2 / 2; k++) {
      sum += re[k] * re[k] + im[k] * im[k];
    }
    out[name] = 10 * Math.log10(Math.max((2 * sum) / (N2 * win2SumSq), 1e-30));
  }
  return out;
}

for (const id of ["factory.mallet.marimba", "factory.perc.conga", "factory.kick.drill"]) {
  const oldX = decodeWav(readFileSync(`tmp-old-${id.split(".")[2]}.wav`));
  const newX = decodeWav(readFileSync(`public/samples/${id}.wav`));
  const o = { ...stats(oldX), ...bands(oldX) };
  const n = { ...stats(newX), ...bands(newX) };
  const row = (label, r) =>
    `  ${label.padEnd(4)} dur ${r.ms.toFixed(0).padStart(4)}ms  peak ${r.peakDb.toFixed(1).padStart(6)}  rms ${r.rmsDb
      .toFixed(1)
      .padStart(6)}  crest ${r.crestDb.toFixed(1).padStart(5)}  loud ${r.loudMs.toFixed(0).padStart(4)}ms`;
  const bnd = (label, r) =>
    `  ${label.padEnd(4)} ${BANDS.map(([k]) => `${k} ${r[k].toFixed(1)}`).join("  ")}`;
  const rel = (label, r) => {
    const top = Math.max(...BANDS.map(([k]) => r[k]));
    return `  ${label.padEnd(4)} ${BANDS.map(([k]) => `${k} ${(r[k] - top).toFixed(1)}`).join("  ")}`;
  };
  console.log(`\n=== ${id} ===`);
  console.log(row("old", o));
  console.log(row("new", n));
  console.log(bnd("old", o));
  console.log(bnd("new", n));
  console.log(rel("old", o) + "   (relative to loudest band, compare with audit table)");
  console.log(rel("new", n) + "   (relative to loudest band, compare with audit table)");
  const ao = attackBands(oldX);
  const an = attackBands(newX);
  console.log(
    `  atk  old (23ms @ ${ao.startMs.toFixed(1)}ms) ${BANDS.map(([k]) => `${k} ${ao[k].toFixed(1)}`).join("  ")}`,
  );
  console.log(
    `  atk  new (23ms @ ${an.startMs.toFixed(1)}ms) ${BANDS.map(([k]) => `${k} ${an[k].toFixed(1)}`).join("  ")}`,
  );
  // Short-time envelope: 1 ms RMS every 1 ms (48-sample Hann) — shows whether a
  // strike transient exists at all, which the 186 ms band metric cannot.
  const env1 = (x) => {
    const hop = 44;
    const len = 88;
    const out = [];
    for (let t = 0; t + len <= Math.min(x.length, Math.round(0.3 * SR)); t += hop) {
      let s = 0;
      for (let i = 0; i < len; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len);
        s += x[t + i] * x[t + i] * w * w;
      }
      out.push(10 * Math.log10(Math.max((2 * s) / (len * 0.375), 1e-30)));
    }
    return out;
  };
  const e = { old: env1(oldX), new: env1(newX) };
  for (const k of ["old", "new"]) {
    const v = e[k];
    const head = v.slice(0, 12).map((d) => d.toFixed(1)).join(" ");
    console.log(
      `  env  ${k} 1ms-RMS first 12ms: [${head}]  peak ${Math.max(...v)
        .toFixed(1)
        .padStart(6)}  @50ms ${v[50].toFixed(1)}  @200ms ${v[200].toFixed(1)}`,
    );
  }
}
