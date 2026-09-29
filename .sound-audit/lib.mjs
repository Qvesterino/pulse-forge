/**
 * KYX sound-library acoustic audit (scratch tool, not shipped).
 * Decodes every public/samples/*.wav and measures the audit dimensions:
 * peak/RMS/crest, K-weighted momentary LUFS (BS.1770 port of
 * src/audio-engine/kweighting.ts), DC offset, leading/trailing silence,
 * attack/decay envelope, spectral band balance, low-end tuning glide,
 * stereo correlation, limiter-riding. Writes analysis.json.
 */




/* ---------------- WAV decode ---------------- */
function decodeWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not RIFF/WAVE");
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { pos: pos + 8, size };
    else if (id === "data") { data = { pos: pos + 8, size }; break; }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("missing fmt/data chunk");
  const audioFormat = buf.readUInt16LE(fmt.pos);
  const channels = buf.readUInt16LE(fmt.pos + 2);
  const sampleRate = buf.readUInt32LE(fmt.pos + 4);
  const bits = buf.readUInt16LE(fmt.pos + 14);
  const n = Math.floor(data.size / (bits / 8));
  const frames = Math.floor(n / channels);
  const out = [];
  const bytesPerSample = bits / 8;
  for (let ch = 0; ch < channels; ch++) out.push(new Float32Array(frames));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let f = 0; f < frames; f++) {
    for (let ch = 0; ch < channels; ch++) {
      const i = data.pos + (f * channels + ch) * bytesPerSample;
      let v = 0;
      if (audioFormat === 3 && bits === 32) v = view.getFloat32(i, true);
      else if (bits === 16) v = view.getInt16(i, true) / 32768;
      else if (bits === 24) v = ((buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16)) << 8) / 2147483648;
      else if (bits === 32 && audioFormat === 1) v = view.getInt32(i, true) / 2147483648;
      else if (bits === 8) v = (buf[i] - 128) / 128;
      else throw new Error(`unsupported format ${audioFormat}/${bits}bit`);
      out[ch][f] = v;
    }
  }
  return { channels: out, sampleRate, bits, format: audioFormat === 3 ? "float32" : `pcm${bits}` };
}

/* ---------------- K-weighting (port of src/audio-engine/kweighting.ts) ---------------- */
function kWeightingCoefficients(sampleRate) {
  const fs = Math.max(16000, sampleRate);
  const shelfF0 = 1681.974450955533, shelfGainDb = 3.9998438539736248, shelfQ = 0.7071752369554196;
  const ks = Math.tan((Math.PI * shelfF0) / fs);
  const vh = Math.pow(10, shelfGainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const shelfA0 = 1 + ks / shelfQ + ks * ks;
  const hpF0 = 38.13547087602444, hpQ = 0.5003270373238773;
  const kh = Math.tan((Math.PI * hpF0) / fs);
  const hpA0 = 1 + kh / hpQ + kh * kh;
  return [
    {
      b0: (vh + (vb * ks) / shelfQ + ks * ks) / shelfA0,
      b1: (2 * (ks * ks - vh)) / shelfA0,
      b2: (vh - (vb * ks) / shelfQ + ks * ks) / shelfA0,
      a1: (2 * (ks * ks - 1)) / shelfA0,
      a2: (1 - ks / shelfQ + ks * ks) / shelfA0,
    },
    { b0: 1, b1: -2, b2: 1, a1: (2 * (kh * kh - 1)) / hpA0, a2: (1 - kh / hpQ + kh * kh) / hpA0 },
  ];
}
class KWFilter {
  constructor(stages) { this.st = stages; this.x1 = this.x2 = this.y1 = this.y2 = this.u1 = this.u2 = this.w1 = this.w2 = 0; }
  process(input) {
    const s1 = this.st[0];
    const shelf = s1.b0 * input + s1.b1 * this.x1 + s1.b2 * this.x2 - s1.a1 * this.y1 - s1.a2 * this.y2;
    this.x2 = this.x1; this.x1 = input; this.y2 = this.y1; this.y1 = shelf;
    const s2 = this.st[1];
    const hp = s2.b0 * shelf + s2.b1 * this.u1 + s2.b2 * this.u2 - s2.a1 * this.w1 - s2.a2 * this.w2;
    this.u2 = this.u1; this.u1 = shelf; this.w2 = this.w1; this.w1 = hp;
    return hp;
  }
}
/** momentaryMax LUFS with the seed script's short-buffer tiling. */
function momentaryMaxLufs(channels, sampleRate) {
  const SR = sampleRate;
  const minSamples = Math.ceil(0.45 * SR);
  const len = channels[0].length;
  const reps = len >= minSamples ? 1 : Math.ceil(minSamples / len);
  const tiled = channels.map((c) => {
    if (reps === 1) return c;
    const out = new Float32Array(len * reps);
    for (let r = 0; r < reps; r++) out.set(c, r * len);
    return out;
  });
  const stages = kWeightingCoefficients(SR);
  const filtered = tiled.map((c) => {
    const f = new KWFilter(stages);
    const o = new Float64Array(c.length);
    for (let i = 0; i < c.length; i++) o[i] = f.process(c[i]);
    return o;
  });
  const sub = Math.round(0.1 * SR);
  const length = filtered[0].length;
  const powers = [];
  for (let start = 0; start + sub <= length; start += sub) {
    let sum = 0;
    for (const ch of filtered) {
      let acc = 0;
      for (let i = start; i < start + sub; i++) acc += ch[i] * ch[i];
      sum += acc / sub;
    }
    powers.push(sum);
  }
  let maxL = -180;
  for (let k = 0; k + 4 <= powers.length; k++) {
    const ms = (powers[k] + powers[k + 1] + powers[k + 2] + powers[k + 3]) / 4;
    const l = ms > 1e-12 ? -0.691 + 10 * Math.log10(ms) : -180;
    if (l > maxL) maxL = l;
  }
  return maxL;
}

/* ---------------- FFT ---------------- */
function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Welch power spectrum of one channel (Hann, N=8192 zero-padded from 4096 windows). */
function welchSpectrum(channel, sampleRate) {
  const N = 4096, pad = 8192;
  const hop = 2048;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  let winPow = 0; for (let i = 0; i < N; i++) winPow += win[i] * win[i];
  const nWindows = Math.max(1, Math.floor((channel.length - N) / hop) + 1);
  const acc = new Float64Array(pad / 2);
  for (let w = 0; w < nWindows; w++) {
    const start = Math.min(w * hop, Math.max(0, channel.length - N));
    const re = new Float64Array(pad), im = new Float64Array(pad);
    for (let i = 0; i < N; i++) re[i] = (channel[start + i] ?? 0) * win[i];
    fftRadix2(re, im);
    for (let k = 0; k < pad / 2; k++) acc[k] += (re[k] * re[k] + im[k] * im[k]) / winPow;
  }
  const scale = 2 / (sampleRate * nWindows);
  return { freqs: Array.from({ length: pad / 2 }, (_, k) => (k * sampleRate) / pad), power: acc.map((p) => p * scale) };
}

const BANDS = [
  ["sub", 20, 60], ["low", 60, 120], ["lowmid", 120, 350], ["mid", 350, 2000],
  ["himid", 2000, 6000], ["high", 6000, 12000], ["air", 12000, 22050],
];
function bandEnergies(spectrum) {
  const total = spectrum.power.reduce((a, b) => a + b, 0);
  const out = {};
  for (const [name, lo, hi] of BANDS) {
    let e = 0;
    for (let k = 0; k < spectrum.freqs.length; k++) {
      if (spectrum.freqs[k] >= lo && spectrum.freqs[k] < hi) e += spectrum.power[k];
    }
    out[name] = total > 0 ? 10 * Math.log10(Math.max(e, 1e-24) / total) : -120;
  }
  // spectral centroid
  let num = 0, den = 0;
  for (let k = 0; k < spectrum.freqs.length; k++) { num += spectrum.freqs[k] * spectrum.power[k]; den += spectrum.power[k]; }
  out.centroid = den > 0 ? num / den : 0;
  return out;
}

/** Dominant low frequency (parabolic peak interp) in a window — tuning check. */
function lowTuning(channel, sampleRate, startSec, lenSec) {
  const start = Math.floor(startSec * sampleRate);
  const N = Math.min(Math.floor(lenSec * sampleRate), channel.length - start);
  if (N < 512) return null;
  const pad = 32768;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float64Array(pad), im = new Float64Array(pad);
  for (let i = 0; i < N; i++) re[i] = channel[start + i] * win[i];
  fftRadix2(re, im);
  const binHz = sampleRate / pad;
  const loBin = Math.max(1, Math.floor(25 / binHz)), hiBin = Math.floor(130 / binHz);
  let best = loBin, bestMag = 0;
  for (let k = loBin; k <= hiBin; k++) {
    const m = re[k] * re[k] + im[k] * im[k];
    if (m > bestMag) { bestMag = m; best = k; }
  }
  const m1 = re[best - 1] ** 2 + im[best - 1] ** 2, m2 = bestMag, m3 = re[best + 1] ** 2 + im[best + 1] ** 2;
  const denom = m1 + 2 * m2 + m3;
  const delta = denom > 0 ? (0.5 * (m1 - m3)) / denom : 0;
  const hz = (best + delta) * binHz;
  const midi = 69 + 12 * Math.log2(hz / 440);
  const nearest = Math.round(midi);
  const cents = Math.round((midi - nearest) * 100);
  return { hz: Math.round(hz * 10) / 10, note: nearest, cents };
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function noteName(midi) { return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`; }


export { decodeWav, momentaryMaxLufs, welchSpectrum, bandEnergies, lowTuning, kWeightingCoefficients };
